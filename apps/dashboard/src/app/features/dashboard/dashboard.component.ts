import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AuthStore } from '../auth/store/auth.store';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="p-6">
      <div class="mb-6">
        <h1 class="text-2xl font-semibold text-gray-800 dark:text-white">Dashboard</h1>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Logged in as <strong>{{ store.displayName() }}</strong>
          <span class="ml-2 inline-flex items-center rounded px-2 py-0.5 text-xs font-medium"
            [class]="store.isAdjuster()
              ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300'
              : 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'">
            {{ store.role() }}
          </span>
        </p>
      </div>

      <div class="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-10 text-center">
        <p class="text-gray-500 dark:text-gray-400 font-medium">Claims module coming soon</p>
      </div>
    </div>
  `,
})
export class DashboardComponent {
  readonly store = inject(AuthStore);
}
