import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-drawer',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './drawer.component.html',
})
export class DrawerComponent implements OnChanges {
  @Input()  open  = false;
  @Input()  title = '';
  @Input()  width = '520px';
  @Output() closed = new EventEmitter<void>();

  visible = false;  // controls DOM presence
  animate = false;  // controls translate class

  ngOnChanges(changes: SimpleChanges) {
    if (changes['open']) {
      if (this.open) {
        this.visible = true;
        requestAnimationFrame(() => { this.animate = true; });
      } else {
        this.animate = false;
        setTimeout(() => { this.visible = false; }, 300);
      }
    }
  }

  close() { this.closed.emit(); }
}
