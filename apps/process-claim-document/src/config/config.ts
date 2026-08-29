export enum Environment {
  DEVELOPMENT = 'development',
  STAGING = 'staging',
  PRODUCTION = 'production',
}

export interface AppConfig {
  environment: Environment;
  debug: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  requestTimeout: number;
  enableXRayTracing: boolean;
  cors: {
    enabled: boolean;
    origins: string[];
    methods: string[];
    headers: string[];
  };
  lambda: {
    memorySize: number;
    timeout: number;
  };
}

class Config {
  private static instance: Config;
  private config: AppConfig;

  private constructor() {
    this.config = this.loadConfig();
  }

  static getInstance(): Config {
    if (!Config.instance) {
      Config.instance = new Config();
    }
    return Config.instance;
  }

  private loadConfig(): AppConfig {
    const env = (process.env.NODE_ENV || 'development') as Environment;
    const debug = process.env.DEBUG === 'true';

    const baseConfig: AppConfig = {
      environment: env,
      debug,
      logLevel: debug ? 'debug' : 'info',
      requestTimeout: 30000,
      enableXRayTracing: false,
      cors: {
        enabled: true,
        origins: ['*'],
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        headers: ['Content-Type', 'Authorization', 'Accept', 'schema', 'X-Requested-With'],
      },
      lambda: {
        memorySize: 128,
        timeout: 30,
      },
    };

    return { ...baseConfig, ...this.getEnvironmentConfig(env) };
  }

  private getEnvironmentConfig(env: Environment): Partial<AppConfig> {
    switch (env) {
      case Environment.PRODUCTION:
        return {
          debug: false,
          logLevel: 'warn',
          enableXRayTracing: true,
          cors: {
            enabled: true,
            origins: process.env.CORS_ORIGINS?.split(',') || ['https://yourdomain.com'],
            methods: ['GET', 'POST', 'PUT', 'DELETE'],
            headers: ['Content-Type', 'Authorization', 'Accept', 'schema', 'X-Requested-With'],
          },
        };

      case Environment.STAGING:
        return {
          debug: true,
          logLevel: 'info',
          enableXRayTracing: true,
        };

      default:
        return {
          debug: true,
          logLevel: 'debug',
          enableXRayTracing: false,
        };
    }
  }

  get(): AppConfig {
    return this.config;
  }

  getValue<K extends keyof AppConfig>(key: K): AppConfig[K] {
    return this.config[key];
  }

  isDevelopment(): boolean { return this.config.environment === Environment.DEVELOPMENT; }
  isProduction(): boolean  { return this.config.environment === Environment.PRODUCTION; }
  isStaging(): boolean     { return this.config.environment === Environment.STAGING; }
}

export const config = Config.getInstance();
export default config;
