import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import type { DocumentAnalysis } from '../claims.models';

@Component({
  selector: 'app-document-detail',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './document-detail.component.html',
})
export class DocumentDetailComponent {
  @Input() doc!: DocumentAnalysis;

  get isImage() { return ['jpeg', 'png', 'jpg'].includes(this.doc.contentType); }

  get riskLevel(): 'high' | 'medium' | 'low' {
    if (this.doc.integrityScore >= 60) return 'high';
    if (this.doc.integrityScore >= 30) return 'medium';
    return 'low';
  }

  get riskLabel() { return { high: 'Alto', medium: 'Medio', low: 'Bajo' }[this.riskLevel]; }

  get riskClass() {
    return {
      high:   'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
      medium: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
      low:    'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
    }[this.riskLevel];
  }

  get borderClass() {
    if (this.doc.possibleAlteration) return 'border-red-400 dark:border-red-600';
    if (this.doc.lowQualityDocument || this.doc.inconsistentParties) return 'border-yellow-400 dark:border-yellow-600';
    return 'border-green-400 dark:border-green-600';
  }

  get flags() {
    const f: { label: string; color: string; icon: string }[] = [];
    if (this.doc.possibleAlteration)
      f.push({ label: 'Posible alteración', color: 'text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800', icon: 'alert' });
    if (this.doc.inconsistentParties)
      f.push({ label: 'Partes inconsistentes', color: 'text-orange-600 dark:text-orange-400 bg-orange-50 dark:bg-orange-900/20 border-orange-200 dark:border-orange-800', icon: 'info' });
    if (this.doc.lowQualityDocument)
      f.push({ label: 'Baja calidad', color: 'text-yellow-600 dark:text-yellow-400 bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800', icon: 'eye' });
    return f;
  }
}
