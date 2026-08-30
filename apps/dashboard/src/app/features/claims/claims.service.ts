import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../environments/environment';
import type { Claim, CreateClaimPayload, UpdateClaimPayload } from './claims.models';

export interface CreateClaimResponse {
  claim:       Claim;
  uploadUrl:   string;
  documentKey: string;
  expiresIn:   number;
}

@Injectable({ providedIn: 'root' })
export class ClaimsService {
  private http = inject(HttpClient);
  private base = `${environment.apiUrl}/claims`;

  list()                         { return this.http.get<Claim[]>(this.base); }
  get(id: string)                { return this.http.get<Claim>(`${this.base}/${id}`); }
  listByClient(clientId: string) { return this.http.get<Claim[]>(`${this.base}/client/${clientId}`); }

  create(gdprConsent = false) {
    return this.http.post<Claim>(this.base, { gdprConsent });
  }

  gdprExport(clientId: string) {
    return this.http.get<{ exportedAt: string; clientId: string; totalClaims: number; gdprNotice: string; claims: Claim[] }>(
      `${this.base}/gdpr/export/${clientId}`
    );
  }

  addDocument(id: string, contentType: string, fileSizeBytes: number) {
    return this.http.post<{ documentKey: string; uploadUrl: string; expiresIn: number; mimeType: string }>(
      `${this.base}/${id}/documents`, { contentType, fileSizeBytes }
    );
  }

  submit(id: string) {
    return this.http.post<{ id: string; status: string; message: string }>(`${this.base}/${id}/submit`, {});
  }

  process(id: string) {
    return this.http.post<{ id: string; status: string; message: string }>(`${this.base}/${id}/process`, {});
  }

  decide(id: string, decision: 'approved' | 'rejected' | 'needs_info', note?: string) {
    return this.http.post<import('./claims.models').Claim>(`${this.base}/${id}/decision`, { decision, note });
  }

  update(id: string, body: UpdateClaimPayload) {
    return this.http.patch<Claim>(`${this.base}/${id}`, body);
  }

  delete(id: string) { return this.http.delete<void>(`${this.base}/${id}`); }

  uploadToS3(uploadUrl: string, file: File, mimeType: string) {
    return this.http.put(uploadUrl, file, {
      headers: { 'Content-Type': mimeType },
      reportProgress: true,
      observe: 'events',
    });
  }
}
