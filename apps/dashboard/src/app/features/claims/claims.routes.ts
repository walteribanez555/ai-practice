import { Routes } from '@angular/router';

export const CLAIMS_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () => import('./claims-list/claims-list.component').then(m => m.ClaimsListComponent),
    title: 'Reclamaciones',
  },
  {
    path: 'new',
    loadComponent: () => import('./claims-new/claims-new.component').then(m => m.ClaimsNewComponent),
    title: 'Nueva Reclamación',
  },
  {
    path: ':id',
    loadComponent: () => import('./claims-detail/claims-detail.component').then(m => m.ClaimsDetailComponent),
    title: 'Detalle de Reclamación',
  },
];
