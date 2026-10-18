import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ToastsHost } from './ui/ui';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, ToastsHost],
  template: `<router-outlet /><app-toasts />`,
})
export class App {}
