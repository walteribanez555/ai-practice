import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../environments/environment';
import type { LoginRequest, LoginResponse } from '../models/auth.model';

/**
 * Pure HTTP service — no state.
 * All state lives in AuthStore (NgRx Signal Store).
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);

  login(credentials: LoginRequest) {
    return this.http.post<LoginResponse>(
      `${environment.apiUrl}/auth/login`,
      credentials,
    );
  }
}
