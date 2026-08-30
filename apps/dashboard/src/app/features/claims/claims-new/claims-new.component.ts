import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterModule } from '@angular/router';
import { HttpEventType } from '@angular/common/http';
import { ClaimsService } from '../claims.service';
import type { Claim } from '../claims.models';

type ContentType = 'pdf' | 'jpeg' | 'png';
type UploadStatus = 'pending' | 'uploading' | 'done' | 'error';

interface DocSlot {
  file:        File;
  contentType: ContentType;
  status:      UploadStatus;
  progress:    number;
  error:       string | null;
}

type Step = 'add-docs' | 'submitting' | 'done' | 'error';

const MIME: Record<ContentType, string> = {
  pdf:  'application/pdf',
  jpeg: 'image/jpeg',
  png:  'image/png',
};

@Component({
  selector: 'app-claims-new',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './claims-new.component.html',
})
export class ClaimsNewComponent {
  private claimsService = inject(ClaimsService);
  private router        = inject(Router);

  step        = signal<Step>('add-docs');
  docs        = signal<DocSlot[]>([]);
  claim       = signal<Claim | null>(null);
  errorMsg    = signal<string | null>(null);
  gdprConsent = signal(false);

  onFilesChange(event: Event) {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';

    const slots: DocSlot[] = files.map(file => {
      const ext = (file.name.split('.').pop() ?? '').toLowerCase();
      const ct: ContentType = ext === 'jpg' ? 'jpeg' : (ext as ContentType);
      return { file, contentType: ct, status: 'pending' as UploadStatus, progress: 0, error: null };
    }).filter(s => ['pdf', 'jpeg', 'png'].includes(s.contentType));

    this.docs.update(d => [...d, ...slots]);
  }

  removeDoc(idx: number) {
    this.docs.update(d => d.filter((_, i) => i !== idx));
  }

  async submit() {
    const slots = this.docs();
    if (!slots.length) { this.errorMsg.set('Agrega al menos un documento.'); return; }

    this.errorMsg.set(null);
    this.step.set('submitting');

    if (!this.gdprConsent()) {
      this.errorMsg.set('Debes aceptar el aviso de tratamiento de datos para continuar.');
      this.step.set('add-docs');
      return;
    }

    // 1. Create claim draft
    let claim: Claim;
    try {
      claim = await this.claimsService.create(this.gdprConsent()).toPromise() as Claim;
      this.claim.set(claim);
    } catch (e: any) {
      this.step.set('error');
      this.errorMsg.set(e?.error?.error ?? 'Error al crear la reclamación.');
      return;
    }

    // 2. Add each document + upload in parallel
    const uploads = slots.map((slot, idx) =>
      this.claimsService.addDocument(claim.id, slot.contentType, slot.file.size).toPromise()
        .then(({ uploadUrl, mimeType }: any) =>
          new Promise<void>((resolve, reject) => {
            this.claimsService.uploadToS3(uploadUrl, slot.file, mimeType).subscribe({
              next: (ev) => {
                if (ev.type === HttpEventType.UploadProgress && ev.total) {
                  const pct = Math.round(100 * ev.loaded / ev.total);
                  this.docs.update(d => d.map((s, i) => i === idx ? { ...s, status: 'uploading', progress: pct } : s));
                }
                if (ev.type === HttpEventType.Response) {
                  this.docs.update(d => d.map((s, i) => i === idx ? { ...s, status: 'done', progress: 100 } : s));
                  resolve();
                }
              },
              error: () => {
                this.docs.update(d => d.map((s, i) => i === idx ? { ...s, status: 'error', error: 'Error al subir' } : s));
                reject(new Error('Upload failed'));
              },
            });
          })
        )
    );

    try {
      await Promise.all(uploads);
    } catch {
      this.step.set('error');
      this.errorMsg.set('Uno o más documentos no se pudieron subir. Revisa los errores e intenta de nuevo.');
      return;
    }

    // 3. Submit claim → starts Step Function
    try {
      await this.claimsService.submit(claim.id).toPromise();
      this.step.set('done');
      setTimeout(() => this.router.navigate(['/dashboard/claims']), 1500);
    } catch (e: any) {
      this.step.set('error');
      this.errorMsg.set(e?.error?.error ?? 'Error al enviar la reclamación.');
    }
  }

  retry() {
    this.step.set('add-docs');
    this.docs.update(d => d.map(s => ({ ...s, status: 'pending', progress: 0, error: null })));
    this.claim.set(null);
  }

  totalProgress() {
    const d = this.docs();
    if (!d.length) return 0;
    return Math.round(d.reduce((sum, s) => sum + s.progress, 0) / d.length);
  }
}
