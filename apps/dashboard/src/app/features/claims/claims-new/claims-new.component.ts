import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterModule } from '@angular/router';
import { HttpEventType } from '@angular/common/http';
import { ClaimsService } from '../claims.service';

type Step = 'upload' | 'submitting' | 'done' | 'error';
type ContentType = 'pdf' | 'jpeg' | 'png';

@Component({
  selector: 'app-claims-new',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule],
  templateUrl: './claims-new.component.html',
})
export class ClaimsNewComponent {
  private claimsService = inject(ClaimsService);
  private router        = inject(Router);

  step         = signal<Step>('upload');
  uploadPct    = signal(0);
  errorMsg     = signal<string | null>(null);
  selectedFile = signal<File | null>(null);
  contentType  = signal<ContentType>('pdf');

  readonly mimeMap: Record<ContentType, string> = {
    pdf:  'application/pdf',
    jpeg: 'image/jpeg',
    png:  'image/png',
  };

  onFileChange(event: Event) {
    const input = event.target as HTMLInputElement;
    const file  = input.files?.[0];
    if (!file) return;

    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    if (!['pdf', 'jpeg', 'jpg', 'png'].includes(ext)) {
      this.errorMsg.set('Solo se aceptan archivos PDF, JPEG o PNG.');
      return;
    }

    const ct: ContentType = ext === 'jpg' ? 'jpeg' : ext as ContentType;
    this.contentType.set(ct);
    this.selectedFile.set(file);
    this.errorMsg.set(null);
  }

  submit() {
    const file = this.selectedFile();
    if (!file) { this.errorMsg.set('Selecciona un archivo.'); return; }

    this.step.set('submitting');
    this.errorMsg.set(null);
    const ct = this.contentType();

    // 1. Create claim record — API returns presigned URL
    this.claimsService.create({ contentType: ct, fileSizeBytes: file.size }).subscribe({
      next: ({ uploadUrl }) => {
        // 2. Upload document to S3 — S3 trigger starts processing automatically
        this.claimsService.uploadToS3(uploadUrl, file, this.mimeMap[ct]).subscribe({
          next: (ev) => {
            if (ev.type === HttpEventType.UploadProgress && ev.total) {
              this.uploadPct.set(Math.round(100 * ev.loaded / ev.total));
            }
            if (ev.type === HttpEventType.Response) {
              this.step.set('done');
              setTimeout(() => this.router.navigate(['/dashboard/claims']), 1500);
            }
          },
          error: () => { this.step.set('error'); this.errorMsg.set('Error al subir el archivo a S3.'); },
        });
      },
      error: (e) => { this.step.set('error'); this.errorMsg.set(e?.error?.error ?? 'Error al crear la reclamación.'); },
    });
  }

  retry() { this.step.set('upload'); this.uploadPct.set(0); }
}
