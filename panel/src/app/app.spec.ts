import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { App } from './app';
import { routes } from './app.routes';
import { panelInterceptor } from './core/api';
import { detailOf, lookOf } from './core/events';
import { percent } from './core/format';
import { safeNext } from './pages/auth/login';
import { withHead } from './ui/email-preview';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideRouter(routes),
        provideHttpClient(withInterceptors([panelInterceptor])),
        provideHttpClientTesting(),
      ],
    }).compileComponents();
  });

  it('sends visitors without a session to the sign-in page, with the CSRF header', async () => {
    const fixture = TestBed.createComponent(App);
    const router = TestBed.inject(Router);
    const http = TestBed.inject(HttpTestingController);
    const navigation = router.navigateByUrl('/messages');
    await new Promise((resolve) => setTimeout(resolve)); // the guard runs asynchronously

    const me = http.expectOne('/v1/auth/me');
    expect(me.request.headers.get('X-Relayo-Client')).toBe('panel');
    expect(me.request.withCredentials).toBe(true);
    me.flush({ message: 'Not signed in' }, { status: 401, statusText: 'Unauthorized' });
    await navigation;
    await fixture.whenStable();

    expect(router.url).toBe('/login?next=%2Fmessages');
  });
});

describe('safeNext', () => {
  it('only follows same-site paths', () => {
    expect(safeNext('/messages/abc')).toBe('/messages/abc');
    expect(safeNext('//evil.example')).toBe('/overview');
    expect(safeNext('https://evil.example')).toBe('/overview');
    expect(safeNext(undefined)).toBe('/overview');
  });
});

describe('event looks', () => {
  it('tells hard bounces, blocks and soft bounces apart', () => {
    expect(lookOf({ type: 'bounced', bounceType: 'hard' })).toEqual({ label: 'Rebote duro', tone: 'critical' });
    expect(lookOf({ type: 'bounced', bounceType: 'block' })).toEqual({ label: 'Bloqueado', tone: 'block' });
    expect(lookOf({ type: 'bounced', bounceType: 'soft' })).toEqual({ label: 'Rebote suave', tone: 'serious' });
    expect(lookOf({ type: 'delivered' }).tone).toBe('good');
  });

  it('summarizes bounce details in Spanish', () => {
    const detail = detailOf({
      id: 'e',
      type: 'bounced',
      recipient: 'a@b.c',
      timestamp: '',
      messageId: 'm',
      providerMessageId: 'p',
      reason: 'user_unknown',
      smtpCode: 550,
      enhancedCode: '5.1.1',
    });
    expect(detail).toBe('El usuario no existe · 550 5.1.1');
  });

  it('formats rates', () => {
    expect(percent(0, 0)).toBe('—');
    expect(percent(3, 3)).toBe('100 %');
    expect(percent(1, 3)).toBe('33.3 %');
  });
});

describe('email preview', () => {
  it('puts the CSP before anything the email loads', () => {
    const csp = 'Content-Security-Policy';
    const full = withHead('<html><head><link rel="stylesheet" href="https://x"></head><body>Hola</body></html>');
    expect(full.indexOf(csp)).toBeLessThan(full.indexOf('<link'));
    const fragment = withHead('<p>Hola</p>');
    expect(fragment.startsWith('<!doctype html><html><head>')).toBe(true);
    expect(fragment.indexOf(csp)).toBeLessThan(fragment.indexOf('<p>Hola</p>'));
    const noHead = withHead('<html><body>x</body></html>');
    expect(noHead.indexOf(csp)).toBeLessThan(noHead.indexOf('<body>'));
  });
});
