import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthStore } from '../../features/auth/store/auth.store';

export const authGuard: CanActivateFn = () => {
  const store  = inject(AuthStore);
  const router = inject(Router);

  return store.isLoggedIn() ? true : router.createUrlTree(['/login']);
};

export const adjusterGuard: CanActivateFn = () => {
  const store  = inject(AuthStore);
  const router = inject(Router);

  return store.isAdjuster() ? true : router.createUrlTree(['/dashboard']);
};
