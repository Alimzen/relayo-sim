import { Component, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { SimApi } from './api.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  protected readonly api = inject(SimApi);
  private readonly router = inject(Router);

  protected async signOut(): Promise<void> {
    this.api.signOut();
    await this.router.navigateByUrl('/login');
  }
}
