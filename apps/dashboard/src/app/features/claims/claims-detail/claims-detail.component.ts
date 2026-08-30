import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpEventType } from '@angular/common/http';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { DrawerComponent } from '../../../shared/components/drawer/drawer.component';
import { DocumentDetailComponent } from '../document-detail/document-detail.component';
import type { DocumentAnalysis } from '../claims.models';
import { ClaimsService } from '../claims.service';
import { AuthStore } from '../../auth/store/auth.store';
import type { Claim, UpdateClaimPayload } from '../claims.models';

@Component({
  selector: 'app-claims-detail',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule, DrawerComponent, DocumentDetailComponent],
  templateUrl: './claims-detail.component.html',
})
export class ClaimsDetailComponent implements OnInit {
  private claimsService = inject(ClaimsService);
  private route         = inject(ActivatedRoute);
  private router        = inject(Router);
  readonly store        = inject(AuthStore);

  claim        = signal<Claim | null>(null);
  loading      = signal(true);
  error        = signal<string | null>(null);

  processing   = signal(false);
  processMsg   = signal<string | null>(null);

  addingDoc    = signal(false);
  addDocMsg    = signal<string | null>(null);
  submitting   = signal(false);
  submitMsg    = signal<string | null>(null);

  updating     = signal(false);
  updateMsg    = signal<string | null>(null);
  showUpdateForm = signal(false);

  deleting     = signal(false);

  // Update form model
  updateForm: UpdateClaimPayload = {};

  ngOnInit() {
    const id = this.route.snapshot.paramMap.get('id')!;
    this.claimsService.get(id).subscribe({
      next:  (c) => { this.claim.set(c); this.prefillForm(c); this.loading.set(false); },
      error: ()  => { this.error.set('No se pudo cargar la reclamación.'); this.loading.set(false); },
    });
  }

  private prefillForm(c: Claim) {
    this.updateForm = {
      claimType:          c.claimType ?? undefined,
      estimatedAmount:    c.estimatedAmount ?? undefined,
      incidentDate:       c.incidentDate ?? undefined,
      descriptionSummary: c.descriptionSummary ?? undefined,
      involvedParties:    c.involvedParties ?? undefined,
    };
  }

  process() {
    const id = this.claim()!.id;
    this.processing.set(true);
    this.processMsg.set(null);
    this.claimsService.process(id).subscribe({
      next: (res) => {
        this.processMsg.set(`✓ ${res.message}`);
        this.processing.set(false);
        // Refresh claim
        this.claimsService.get(id).subscribe(c => this.claim.set(c));
      },
      error: (e) => {
        this.processMsg.set(e?.error?.error ?? 'Error al procesar.');
        this.processing.set(false);
      },
    });
  }

  submitUpdate() {
    const id = this.claim()!.id;
    this.updating.set(true);
    this.updateMsg.set(null);
    this.claimsService.update(id, this.updateForm).subscribe({
      next: (c) => {
        this.claim.set(c);
        this.updateMsg.set('✓ Actualizado correctamente.');
        this.updating.set(false);
        this.showUpdateForm.set(false);
      },
      error: (e) => {
        this.updateMsg.set(e?.error?.error ?? 'Error al actualizar.');
        this.updating.set(false);
      },
    });
  }

  deleteClaim() {
    if (!confirm('¿Eliminar esta reclamación? Esta acción no se puede deshacer.')) return;
    this.deleting.set(true);
    this.claimsService.delete(this.claim()!.id).subscribe({
      next:  () => this.router.navigate(['/dashboard/claims']),
      error: () => { this.error.set('Error al eliminar.'); this.deleting.set(false); },
    });
  }

  statusLabel(s: string) {
    const map: Record<string, string> = { pending: 'Pendiente', processing: 'Procesando', processed: 'Procesado', error: 'Error' };
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

  get canProcess() {
    const s = this.claim()?.status;
    return this.store.isAdjuster() && (s === 'pending' || s === 'error');
  }

  get isDraft() { return this.claim()?.status === 'draft'; }

  // Drawer
  drawerOpen    = signal(false);
  selectedDoc   = signal<DocumentAnalysis | null>(null);

  openDocDrawer(doc: DocumentAnalysis) {
    this.selectedDoc.set(doc);
    this.drawerOpen.set(true);
  }

  closeDrawer() { this.drawerOpen.set(false); }

  onAddDocFile(event: Event) {
    const input = event.target as HTMLInputElement;
    const file  = input.files?.[0];
    if (!file) return;

    const ext = (file.name.split('.').pop() ?? '').toLowerCase();
    const ct  = ext === 'jpg' ? 'jpeg' : ext;
    if (!['pdf', 'jpeg', 'png'].includes(ct)) {
      this.addDocMsg.set('Solo se aceptan PDF, JPEG o PNG.'); return;
    }

    this.addingDoc.set(true);
    this.addDocMsg.set(null);
    const id = this.claim()!.id;

    this.claimsService.addDocument(id, ct, file.size).subscribe({
      next: ({ uploadUrl, mimeType }) => {
        this.claimsService.uploadToS3(uploadUrl, file, mimeType).subscribe({
          next: (ev) => {
            if ((ev as any).type === 4) { // Response
              this.claimsService.get(id).subscribe(c => this.claim.set(c));
              this.addDocMsg.set('✓ Documento agregado.');
              this.addingDoc.set(false);
            }
          },
          error: () => { this.addDocMsg.set('Error al subir el documento.'); this.addingDoc.set(false); },
        });
      },
      error: (e: any) => { this.addDocMsg.set(e?.error?.error ?? 'Error al agregar documento.'); this.addingDoc.set(false); },
    });
  }

  submitDraft() {
    this.submitting.set(true);
    this.submitMsg.set(null);
    this.claimsService.submit(this.claim()!.id).subscribe({
      next: () => {
        this.submitting.set(false);
        this.claimsService.get(this.claim()!.id).subscribe(c => this.claim.set(c));
      },
      error: (e: any) => { this.submitMsg.set(e?.error?.error ?? 'Error al enviar.'); this.submitting.set(false); },
    });
  }

  get involvedPartiesStr() {
    return (this.updateForm.involvedParties ?? []).join(', ');
  }
  set involvedPartiesStr(val: string) {
    this.updateForm.involvedParties = val ? val.split(',').map(s => s.trim()).filter(Boolean) : [];
  }
}
