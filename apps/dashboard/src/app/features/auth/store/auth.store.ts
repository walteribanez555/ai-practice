import { computed, inject } from '@angular/core';
import { Router } from '@angular/router';
import { patchState, signalStore, withComputed, withHooks, withMethods, withState } from '@ngrx/signals';
import { AuthService } from '../../../core/services/auth.service';
import type { AuthUser, LoginRequest, UserRole } from '../../../core/models/auth.model';

// ── State shape ───────────────────────────────────────────────────────────────

interface AuthState {
  user:    AuthUser | null;
  token:   string | null;
  loading: boolean;
  error:   string | null;
}

const initialState: AuthState = {
  user:    null,
  token:   null,
  loading: false,
  error:   null,
};

// ── Storage keys ──────────────────────────────────────────────────────────────

const TOKEN_KEY = 'auth_token';
const USER_KEY  = 'auth_user';

// ── Store ─────────────────────────────────────────────────────────────────────

export const AuthStore = signalStore(
  { providedIn: 'root' },

  withState<AuthState>(initialState),

  withComputed(({ user, token }) => ({
    isLoggedIn:  computed(() => !!token()),
    role:        computed((): UserRole | null => user()?.role ?? null),
    isAdjuster:  computed(() => user()?.role === 'adjuster'),
    isClient:    computed(() => user()?.role === 'client'),
    displayName: computed(() => user()?.email ?? ''),
    userId:      computed(() => user()?.userId ?? null),
  })),

  withMethods((store, authService = inject(AuthService), router = inject(Router)) => ({

    login(credentials: LoginRequest): void {
      patchState(store, { loading: true, error: null });

      authService.login(credentials).subscribe({
        next: (res) => {
          const user: AuthUser = {
            userId: res.userId,
            email:  credentials.email,
            role:   res.role,
          };

          localStorage.setItem(TOKEN_KEY, res.token);
          localStorage.setItem(USER_KEY, JSON.stringify(user));

          patchState(store, { token: res.token, user, loading: false });

          router.navigate(['/dashboard']);
        },
        error: (err) => {
          patchState(store, {
            loading: false,
            error: err?.error?.error ?? 'Invalid credentials. Please try again.',
          });
        },
      });
    },

    logout(): void {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      patchState(store, initialState);
      router.navigate(['/login']);
    },

    clearError(): void {
      patchState(store, { error: null });
    },
  })),

  // Rehydrate state from localStorage on app start
  withHooks({
    onInit(store) {
      const token = localStorage.getItem(TOKEN_KEY);
      const raw   = localStorage.getItem(USER_KEY);

      if (token && raw) {
        try {
          const user = JSON.parse(raw) as AuthUser;
          patchState(store, { token, user });
        } catch {
          localStorage.removeItem(TOKEN_KEY);
          localStorage.removeItem(USER_KEY);
        }
      }
    },
  }),
);
