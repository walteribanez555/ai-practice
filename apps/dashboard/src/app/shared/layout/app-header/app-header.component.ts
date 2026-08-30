import { Component } from '@angular/core';
import { SidebarService } from '../../services/sidebar.service';
import { ThemeToggleButtonComponent } from '../../components/common/theme-toggle/theme-toggle-button.component';
import { UserDropdownComponent } from '../../components/header/user-dropdown/user-dropdown.component';

@Component({
  selector: 'app-header',
  imports: [ThemeToggleButtonComponent, UserDropdownComponent],
  templateUrl: './app-header.component.html',
})
export class AppHeaderComponent {
  constructor(public sidebarService: SidebarService) {}

  handleToggle() {
    if (window.innerWidth >= 1280) {
      this.sidebarService.toggleExpanded();
    } else {
      this.sidebarService.toggleMobileOpen();
    }
  }
}
