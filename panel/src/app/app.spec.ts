import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import { App } from './app';
import { routes } from './app.routes';
import { detailOf, lookOf } from './events';

describe('App', () => {
  beforeEach(async () => {
    sessionStorage.clear();
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter(routes), provideHttpClient()],
    }).compileComponents();
  });

  it('shows no navigation until signed in', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).querySelector('.topbar')).toBeNull();
  });
});

describe('event looks', () => {
  it('tells hard bounces, blocks and soft bounces apart', () => {
    expect(lookOf({ type: 'bounced', bounceType: 'hard' })).toEqual({ label: 'Rebote duro', tone: 'bad' });
    expect(lookOf({ type: 'bounced', bounceType: 'block' })).toEqual({ label: 'Bloqueado', tone: 'block' });
    expect(lookOf({ type: 'bounced', bounceType: 'soft' })).toEqual({ label: 'Rebote suave', tone: 'warn' });
    expect(lookOf({ type: 'delivered' }).tone).toBe('ok');
  });

  it('summarizes bounce details', () => {
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
    expect(detail).toBe('user_unknown · 550 5.1.1');
  });
});
