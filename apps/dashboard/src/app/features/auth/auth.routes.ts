import { Routes } from '@angular/router';

export const AUTH_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./login/login.component').then(m => m.LoginComponent),
    title: 'Sign In',
  },
];
