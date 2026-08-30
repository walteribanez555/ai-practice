import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { AuthStore } from '../../features/auth/store/auth.store';

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const token = inject(AuthStore).token();

  // Skip S3 presigned URLs — they carry auth in query params; adding Bearer causes 400
  const isS3 = req.url.includes('.s3.') || req.url.includes('.amazonaws.com');

  if (token && !isS3) {
    req = req.clone({ setHeaders: { Authorization: `Bearer ${token}` } });
  }

  return next(req);
};
