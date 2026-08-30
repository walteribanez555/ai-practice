#!/usr/bin/env python3
"""
Fraud scoring retraining pipeline.

Reads the auto-insurance dataset from S3, applies security preprocessing,
trains XGBoost, evaluates, and deploys to SageMaker Serverless if AUC improves.

Environment variables
---------------------
ML_BUCKET                     S3 bucket for model artifacts and dataset
S3_DATASET_KEY                Object key for the raw CSV  (default: fraud-scoring/dataset/insurance_claims.csv)
SAGEMAKER_EXECUTION_ROLE_ARN  IAM role SageMaker can assume during inference
ENDPOINT_NAME                 Serverless endpoint name    (default: fraud-scoring-serverless)
LAMBDA_FUNCTION_NAME          Lambda to update after deploy (default: assistance-prod-aggregate-risk)
MIN_AUC                       Minimum AUC to trigger deploy (default: 0.70)
FORCE_DEPLOY                  Deploy even if AUC did not improve (default: false)
DP_EPSILON                    Laplace noise budget         (default: 1.0)
AWS_DEFAULT_REGION            AWS region                   (default: us-east-1)
"""

import json
import logging
import os
import sys
import tarfile
import tempfile
import time
from datetime import datetime
from pathlib import Path

# ── SageMaker Processing Job: install packages not in the sklearn base container ──
# The sklearn container already has: pandas, numpy, scikit-learn, boto3.
# xgboost is NOT pre-installed — we install it here when running as a Processing Job.
if os.getenv('IS_SAGEMAKER_JOB'):
    import subprocess
    subprocess.check_call([sys.executable, '-m', 'pip', 'install',
                           'xgboost==2.1.3', '-q'])

import boto3
import numpy as np
import pandas as pd
from sklearn.metrics import roc_auc_score, average_precision_score
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import LabelEncoder
from xgboost import XGBClassifier

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s  %(levelname)-8s  %(message)s',
    datefmt='%H:%M:%S',
)
log = logging.getLogger(__name__)

# ── Configuration ─────────────────────────────────────────────────────────────
REGION        = os.getenv('AWS_DEFAULT_REGION', 'us-east-1')
BUCKET        = os.getenv('ML_BUCKET', '')
DATASET_KEY   = os.getenv('S3_DATASET_KEY', 'fraud-scoring/dataset/insurance_claims.csv')
SM_ROLE_ARN   = os.getenv('SAGEMAKER_EXECUTION_ROLE_ARN', '')
ENDPOINT_NAME = os.getenv('ENDPOINT_NAME', 'fraud-scoring-serverless')
LAMBDA_FN     = os.getenv('LAMBDA_FUNCTION_NAME', 'assistance-prod-aggregate-risk')
MIN_AUC       = float(os.getenv('MIN_AUC', '0.70'))
FORCE_DEPLOY  = os.getenv('FORCE_DEPLOY', 'false').lower() == 'true'
EPSILON       = float(os.getenv('DP_EPSILON', '1.0'))

# ── Column definitions (must match notebook) ─────────────────────────────────
DROP_PII    = ['policy_number', 'incident_location', 'policy_bind_date']
DROP_QUASI  = ['insured_zip', 'insured_city']
FINANCIAL   = ['total_claim_amount', 'injury_claim', 'property_claim',
               'vehicle_claim', 'capital_gains', 'capital_loss']
CATEGORICAL = ['insured_sex', 'insured_education_level', 'insured_occupation',
               'insured_hobbies', 'insured_relationship', 'incident_type',
               'collision_type', 'incident_severity', 'authorities_contacted',
               'incident_state', 'property_damage', 'police_report_available',
               'auto_make', 'auto_model']
FEATURE_COLS = [
    'total_claim_amount', 'injury_claim', 'property_claim', 'vehicle_claim',
    'number_of_vehicles_involved', 'bodily_injuries', 'witnesses',
    'property_damage', 'police_report_available', 'incident_severity',
    'incident_type', 'collision_type', 'authorities_contacted',
    'incident_month', 'age_bucket', 'months_as_customer',
    'insured_sex', 'insured_education_level', 'insured_occupation',
    'insured_hobbies', 'insured_relationship', 'incident_state',
    'auto_make', 'auto_model', 'auto_year',
    'capital_gains', 'capital_loss',
    'policy_deductable', 'policy_annual_premium', 'umbrella_limit',
]


# ── Dataset ───────────────────────────────────────────────────────────────────

def load_dataset(s3, bucket: str, key: str) -> pd.DataFrame:
    log.info('Downloading dataset s3://%s/%s', bucket, key)
    with tempfile.NamedTemporaryFile(suffix='.csv') as tmp:
        s3.download_file(bucket, key, tmp.name)
        df = pd.read_csv(tmp.name)
    log.info('Loaded %d rows × %d cols', *df.shape)
    return df


# ── Security preprocessing ────────────────────────────────────────────────────

def preprocess(raw: pd.DataFrame) -> pd.DataFrame:
    df = raw.copy()

    # Step 1 — suppress direct identifiers
    to_drop = [c for c in DROP_PII + [c for c in df.columns if c.startswith('_c')] if c in df.columns]
    df.drop(columns=to_drop, inplace=True)
    log.info('Step 1: dropped %d PII columns', len(to_drop))

    # Step 2 — suppress quasi-identifiers
    to_drop = [c for c in DROP_QUASI if c in df.columns]
    df.drop(columns=to_drop, inplace=True)
    log.info('Step 2: dropped %d quasi-identifier columns', len(to_drop))

    # Step 3 — generalize date and age
    df['incident_month'] = pd.to_datetime(df['incident_date']).dt.month
    df.drop(columns=['incident_date'], inplace=True)
    df['age_bucket'] = (df['age'] // 10) * 10
    df.drop(columns=['age'], inplace=True)
    log.info('Step 3: incident_date → month bucket, age → decade bucket')

    # Step 4 — Laplace differential privacy on financial columns
    for col in [c for c in FINANCIAL if c in df.columns]:
        sensitivity = df[col].max() - df[col].min()
        if sensitivity > 0:
            noise = np.random.laplace(0, sensitivity / EPSILON, len(df))
            df[col] = (df[col] + noise).clip(lower=0)
    log.info('Step 4: Laplace noise applied (ε=%.1f) to %d financial columns', EPSILON, len(FINANCIAL))

    # Step 5 — k-anonymity verification (k=5)
    quasi = [c for c in ['age_bucket', 'insured_sex', 'incident_state', 'incident_month'] if c in df.columns]
    if quasi:
        group_sizes = df.groupby(quasi).size()
        violations = (group_sizes < 5).sum()
        if violations > 0:
            log.warning('Step 5: %d groups violate k=5 — suppressing', violations)
            valid = group_sizes[group_sizes >= 5].index
            df = df.set_index(quasi).loc[valid].reset_index()
        log.info('Step 5: k-anonymity OK — min group size=%d', group_sizes.min())

    return df


# ── Feature engineering ───────────────────────────────────────────────────────

def engineer_features(df: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    df['fraud_reported'] = df['fraud_reported'].map({'Y': 1, 'N': 0})

    label_encoders: dict[str, dict] = {}
    le = LabelEncoder()
    for col in [c for c in CATEGORICAL if c in df.columns]:
        df[col] = df[col].fillna('UNKNOWN')
        df[col] = le.fit_transform(df[col].astype(str))
        label_encoders[col] = dict(zip(le.classes_, le.transform(le.classes_).tolist()))

    num_cols = df.select_dtypes(include=[np.number]).columns
    df[num_cols] = df[num_cols].fillna(df[num_cols].median())

    return df, label_encoders


# ── Training ──────────────────────────────────────────────────────────────────

def train_model(X_train, y_train, X_val, y_val) -> XGBClassifier:
    scale_pos = (y_train == 0).sum() / max((y_train == 1).sum(), 1)
    log.info('Training XGBoost — scale_pos_weight=%.2f', scale_pos)

    model = XGBClassifier(
        n_estimators=500,
        max_depth=6,
        learning_rate=0.05,
        subsample=0.8,
        colsample_bytree=0.8,
        min_child_weight=5,
        reg_alpha=0.1,
        reg_lambda=1.0,
        scale_pos_weight=scale_pos,
        eval_metric='auc',
        early_stopping_rounds=30,
        random_state=42,
        n_jobs=-1,
    )
    model.fit(X_train, y_train, eval_set=[(X_val, y_val)], verbose=100)
    log.info('Best iteration: %d  |  Val AUC: %.4f', model.best_iteration, model.best_score)
    return model


# ── Evaluation ────────────────────────────────────────────────────────────────

def evaluate(model: XGBClassifier, X_test, y_test) -> dict:
    proba = model.predict_proba(X_test)[:, 1]
    auc   = roc_auc_score(y_test, proba)
    ap    = average_precision_score(y_test, proba)
    log.info('Test AUC-ROC: %.4f  |  Average Precision: %.4f', auc, ap)
    return {'auc': auc, 'average_precision': ap, 'n_test': len(y_test)}


# ── Previous model AUC (stored as metadata in S3) ────────────────────────────

def get_previous_auc(s3, bucket: str) -> float | None:
    key = 'fraud-scoring/model/metadata.json'
    try:
        obj = s3.get_object(Bucket=bucket, Key=key)
        meta = json.loads(obj['Body'].read())
        return float(meta.get('auc_test', 0))
    except s3.exceptions.NoSuchKey:
        return None
    except Exception as e:
        log.warning('Could not read previous metadata: %s', e)
        return None


# ── Package and upload ────────────────────────────────────────────────────────

def package_and_upload(model: XGBClassifier, s3, bucket: str,
                        label_encoders: dict, features: list,
                        metrics: dict) -> str:
    ts = datetime.utcnow().strftime('%Y%m%d-%H%M%S')
    prefix = f'fraud-scoring/model/{ts}'

    with tempfile.TemporaryDirectory() as tmp:
        model_path = Path(tmp) / 'xgboost-model'
        model.save_model(str(model_path))

        tar_path = Path(tmp) / 'model.tar.gz'
        with tarfile.open(tar_path, 'w:gz') as tar:
            tar.add(str(model_path), arcname='xgboost-model')

        s3_model_uri = f's3://{bucket}/{prefix}/model.tar.gz'
        s3.upload_file(str(tar_path), bucket, f'{prefix}/model.tar.gz')
        log.info('Model uploaded: %s', s3_model_uri)

    metadata = {
        'trained_at':    datetime.utcnow().isoformat(),
        'feature_columns': features,
        'label_encoders':  label_encoders,
        'auc_test':        metrics['auc'],
        'average_precision_test': metrics['average_precision'],
        'n_test':          metrics['n_test'],
        's3_model_uri':    s3_model_uri,
    }
    defaults: dict[str, float] = {}
    s3.put_object(
        Bucket=bucket,
        Key='fraud-scoring/model/metadata.json',
        Body=json.dumps({**metadata, 'feature_defaults': defaults}, indent=2).encode(),
    )
    log.info('Metadata saved to s3://%s/fraud-scoring/model/metadata.json', bucket)
    return s3_model_uri


# ── SageMaker deploy ──────────────────────────────────────────────────────────

def deploy_endpoint(sm, s3_model_uri: str) -> None:
    from sagemaker.image_uris import retrieve as get_uri

    ts          = datetime.utcnow().strftime('%Y%m%d-%H%M')
    model_name  = f'fraud-scoring-xgboost-{ts}'
    config_name = f'{ENDPOINT_NAME}-config-{ts}'

    image = get_uri(framework='xgboost', region=REGION, version='1.7-1', image_scope='inference')

    sm.create_model(
        ModelName=model_name,
        PrimaryContainer={'Image': image, 'ModelDataUrl': s3_model_uri},
        ExecutionRoleArn=SM_ROLE_ARN,
    )
    log.info('SageMaker model created: %s', model_name)

    sm.create_endpoint_config(
        EndpointConfigName=config_name,
        ProductionVariants=[{
            'VariantName':    'AllTraffic',
            'ModelName':      model_name,
            'ServerlessConfig': {'MemorySizeInMB': 1024, 'MaxConcurrency': 5},
        }],
    )

    try:
        sm.create_endpoint(EndpointName=ENDPOINT_NAME, EndpointConfigName=config_name)
        log.info('Endpoint created: %s', ENDPOINT_NAME)
    except sm.exceptions.ClientError as e:
        if 'Cannot create already existing endpoint' in str(e):
            sm.update_endpoint(EndpointName=ENDPOINT_NAME, EndpointConfigName=config_name)
            log.info('Endpoint updated: %s', ENDPOINT_NAME)
        else:
            raise

    log.info('Waiting for endpoint to be InService...')
    while True:
        status = sm.describe_endpoint(EndpointName=ENDPOINT_NAME)['EndpointStatus']
        if status == 'InService':
            log.info('Endpoint ready: %s', ENDPOINT_NAME)
            break
        if status in ('Failed', 'RollingBack'):
            raise RuntimeError(f'Endpoint failed: {status}')
        time.sleep(20)


# ── Lambda env var update ─────────────────────────────────────────────────────

def update_lambda_env(lam) -> None:
    cfg = lam.get_function_configuration(FunctionName=LAMBDA_FN)
    env = cfg.get('Environment', {}).get('Variables', {})
    env['FRAUD_SCORING_ENDPOINT_NAME'] = ENDPOINT_NAME
    lam.update_function_configuration(FunctionName=LAMBDA_FN, Environment={'Variables': env})
    log.info('Lambda %s → FRAUD_SCORING_ENDPOINT_NAME=%s', LAMBDA_FN, ENDPOINT_NAME)


# ── GitHub Actions step summary ───────────────────────────────────────────────

def write_summary(metrics: dict, deployed: bool, reason: str = '') -> None:
    summary_path = os.getenv('GITHUB_STEP_SUMMARY', '')
    if not summary_path:
        return
    lines = [
        '## Fraud Scoring — Retraining Summary',
        '',
        f'| Metric | Value |',
        f'|--------|-------|',
        f'| AUC-ROC (test) | **{metrics["auc"]:.4f}** |',
        f'| Average Precision | {metrics["average_precision"]:.4f} |',
        f'| Test set size | {metrics["n_test"]:,} |',
        f'| Endpoint deployed | {"✅ Yes" if deployed else "⏭ Skipped"} |',
    ]
    if reason:
        lines += ['', f'> {reason}']
    with open(summary_path, 'w') as f:
        f.write('\n'.join(lines) + '\n')


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    np.random.seed(42)

    if not BUCKET:
        log.error('ML_BUCKET env var is required')
        sys.exit(1)
    if not SM_ROLE_ARN:
        log.error('SAGEMAKER_EXECUTION_ROLE_ARN env var is required')
        sys.exit(1)

    s3  = boto3.client('s3',         region_name=REGION)
    sm  = boto3.client('sagemaker',  region_name=REGION)
    lam = boto3.client('lambda',     region_name=REGION)

    # 1. Load
    raw = load_dataset(s3, BUCKET, DATASET_KEY)

    # 2. Preprocess (security steps 1-5)
    df = preprocess(raw)

    # 3. Feature engineering
    df, label_encoders = engineer_features(df)

    features = [c for c in FEATURE_COLS if c in df.columns]
    X = df[features]
    y = df['fraud_reported']

    # 4. Split
    X_tmp, X_test, y_tmp, y_test = train_test_split(X, y, test_size=0.15, stratify=y, random_state=42)
    X_train, X_val, y_train, y_val = train_test_split(X_tmp, y_tmp, test_size=0.18, stratify=y_tmp, random_state=42)
    log.info('Split: train=%d  val=%d  test=%d', len(X_train), len(X_val), len(X_test))

    # 5. Train
    model = train_model(X_train, y_train, X_val, y_val)

    # 6. Evaluate
    metrics = evaluate(model, X_test, y_test)

    # 7. Compare with previous model
    prev_auc = get_previous_auc(s3, BUCKET)
    log.info('Previous AUC: %s  |  New AUC: %.4f  |  Threshold: %.2f',
             f'{prev_auc:.4f}' if prev_auc else 'N/A', metrics['auc'], MIN_AUC)

    should_deploy = (
        FORCE_DEPLOY
        or metrics['auc'] >= MIN_AUC
        and (prev_auc is None or metrics['auc'] > prev_auc)
    )

    # 8. Package and upload model
    s3_model_uri = package_and_upload(model, s3, BUCKET, label_encoders, features, metrics)

    # 9. Deploy (or skip)
    if should_deploy:
        deploy_endpoint(sm, s3_model_uri)
        update_lambda_env(lam)
        deploy_reason = ''
    else:
        reason = (
            f'AUC {metrics["auc"]:.4f} < threshold {MIN_AUC}'
            if metrics['auc'] < MIN_AUC
            else f'AUC {metrics["auc"]:.4f} did not improve over previous {prev_auc:.4f}'
        )
        log.info('Deploy skipped — %s', reason)
        deploy_reason = reason

    write_summary(metrics, deployed=should_deploy, reason=deploy_reason)

    if metrics['auc'] < MIN_AUC and not FORCE_DEPLOY:
        log.error('AUC %.4f below minimum %.2f — marking run as failed', metrics['auc'], MIN_AUC)
        sys.exit(1)

    log.info('Done.')


if __name__ == '__main__':
    main()
