import { Component, inject, computed } from '@angular/core';
import { DropdownComponent } from '../../ui/dropdown/dropdown.component';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { DropdownItemTwoComponent } from '../../ui/dropdown/dropdown-item/dropdown-item.component-two';
import { AuthStore } from '../../../../features/auth/store/auth.store';

@Component({
  selector: 'app-user-dropdown',
  templateUrl: './user-dropdown.component.html',
  imports: [CommonModule, RouterModule, DropdownComponent, DropdownItemTwoComponent],
})
export class UserDropdownComponent {
  readonly store = inject(AuthStore);

  readonly initials = computed(() => {
    const email = this.store.user()?.email ?? '';
    return email.charAt(0).toUpperCase() || '?';
  });

  readonly roleLabel = computed(() => {
    const r = this.store.role();
    return r === 'adjuster' ? 'Adjuster' : r === 'client' ? 'Client' : '';
  });

  isOpen = false;

  toggleDropdown() { this.isOpen = !this.isOpen; }
  closeDropdown()  { this.isOpen = false; }

  signOut() {
    this.closeDropdown();
    this.store.logout();
  }
}