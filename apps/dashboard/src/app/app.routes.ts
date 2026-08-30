import { Routes } from '@angular/router';
import { AppLayoutComponent } from './shared/layout/app-layout/app-layout.component';
import { authGuard } from './core/guards/auth.guard';

export const routes: Routes = [
  // Public — auth feature (lazy)
  {
    path: 'login',
    loadChildren: () =>
      import('./features/auth/auth.routes').then(m => m.AUTH_ROUTES),
  },

  // Protected — app shell with sidebar/header
  {
    path: '',
    component: AppLayoutComponent,
    canActivate: [authGuard],
    children: [
      { path: '', redirectTo: 'dashboard/claims', pathMatch: 'full' },
      { path: 'dashboard', redirectTo: 'dashboard/claims', pathMatch: 'full' },
      {
        path: 'dashboard/claims',
        loadChildren: () =>
          import('./features/claims/claims.routes').then(m => m.CLAIMS_ROUTES),
      },
    ],
  },

  { path: '**', redirectTo: '/login' },
];
