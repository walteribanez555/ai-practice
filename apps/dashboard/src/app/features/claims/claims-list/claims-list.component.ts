import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { ClaimsService } from '../claims.service';
import { AuthStore } from '../../auth/store/auth.store';
import type { Claim } from '../claims.models';

@Component({
  selector: 'app-claims-list',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './claims-list.component.html',
})
export class ClaimsListComponent implements OnInit {
  private claimsService = inject(ClaimsService);
  readonly store = inject(AuthStore);

  claims  = signal<Claim[]>([]);
  loading = signal(true);
  error   = signal<string | null>(null);

  ngOnInit() {
    const source$ = this.store.isAdjuster()
      ? this.claimsService.list()
      : this.claimsService.listByClient(this.store.user()!.userId);

    source$.subscribe({
      next:  (data) => { this.claims.set(data); this.loading.set(false); },
      error: ()     => { this.error.set('No se pudieron cargar las reclamaciones.'); this.loading.set(false); },
    });
  }

  statusLabel(s: string) {
    const map: Record<string, string> = {
      pending:    'Pendiente',
      processing: 'Procesando',
      processed:  'Procesado',
      error:      'Error',
    };
    return map[s] ?? s;
  }

  statusClass(s: string) {
    const map: Record<string, string> = {
      pending:    'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400',
      processing: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400',
      processed:  'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
      error:      'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
    };
    return map[s] ?? 'bg-gray-100 text-gray-800';
  }

  priorityClass(p: string | null | undefined) {
    const map: Record<string, string> = {
      high:   'text-red-600 font-semibold',
      medium: 'text-yellow-600 font-semibold',
      low:    'text-green-600',
    };
    return p ? (map[p] ?? '') : '';
  }
}
