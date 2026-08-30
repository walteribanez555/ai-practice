import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../environments/environment';
import type { Claim, CreateClaimPayload, UpdateClaimPayload, PresignResponse } from './claims.models';

@Injectable({ providedIn: 'root' })
export class ClaimsService {
  private http = inject(HttpClient);
  private base = `${environment.apiUrl}/claims`;

  list()                         { return this.http.get<Claim[]>(this.base); }
  get(id: string)                { return this.http.get<Claim>(`${this.base}/${id}`); }
  listByClient(clientId: string) { return this.http.get<Claim[]>(`${this.base}/client/${clientId}`); }
  create(body: CreateClaimPayload) { return this.http.post<Claim>(this.base, body); }
  process(id: string)            { return this.http.post<{ id: string; status: string; message: string }>(`${this.base}/${id}/process`, {}); }
  update(id: string, body: UpdateClaimPayload) { return this.http.patch<Claim>(`${this.base}/${id}`, body); }
  delete(id: string)             { return this.http.delete<void>(`${this.base}/${id}`); }

  presign(contentType: 'pdf' | 'jpeg' | 'png') {
    return this.http.post<PresignResponse>(`${environment.apiUrl}/upload/presign`, { contentType });
  }

  uploadToS3(uploadUrl: string, file: File, mimeType: string) {
    return this.http.put(uploadUrl, file, {
      headers: { 'Content-Type': mimeType },
      reportProgress: true,
      observe: 'events',
    });
  }
}
