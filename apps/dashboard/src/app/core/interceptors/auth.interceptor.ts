import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { AuthStore } from '../../features/auth/store/auth.store';

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const token = inject(AuthStore).token();

  if (token) {
    req = req.clone({ setHeaders: { Authorization: `Bearer ${token}` } });
  }

  return next(req);
};
