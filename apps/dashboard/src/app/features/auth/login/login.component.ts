import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthStore } from '../store/auth.store';
import { AuthPageLayoutComponent } from '../../../shared/layout/auth-page-layout/auth-page-layout.component';
import { LabelComponent } from '../../../shared/components/form/label/label.component';
import { InputFieldComponent } from '../../../shared/components/form/input/input-field.component';
import { ButtonComponent } from '../../../shared/components/ui/button/button.component';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    AuthPageLayoutComponent,
    LabelComponent,
    InputFieldComponent,
    ButtonComponent,
  ],
  templateUrl: './login.component.html',
})
export class LoginComponent {
  readonly store = inject(AuthStore);

  email        = signal('');
  password     = signal('');
  showPassword = signal(false);

  togglePassword(): void {
    this.showPassword.update(v => !v);
  }

  onSubmit(): void {
    this.store.clearError();

    const email    = this.email().trim();
    const password = this.password();

    if (!email || !password) return;

    this.store.login({ email, password });
  }
}
