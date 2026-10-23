import { readFile } from 'node:fs/promises';
import {
  Inject,
  Injectable,
  Logger,
  Module,
  type DynamicModule,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { AccountsService } from './accounts/accounts.service.js';
import { AuthController, ProjectsController } from './api/account.controllers.js';
import { AdminGuard, PlatformAdminGuard, ProjectGuard, SessionGuard } from './api/auth.js';
import {
  AdminController,
  ManagedReviewController,
  ConnectionsController,
  HealthController,
  InboundController,
  MessagesController,
  ProjectController,
  ScenariosController,
  SmsController,
  WebhookDeliveriesController,
} from './api/controllers.js';
import { LiveService } from './live/live.service.js';
import { SecretBox } from './live/secrets.js';
import { ManagedSending } from './live/managed.js';
import { SesIdentities } from './live/relay-identities.js';
import { SIM_CONFIG, type SimConfig } from './config.js';
import type { WebhookAttempt } from './domain.js';
import { INFRASTRUCTURE, infrastructure, type Infrastructure } from './infrastructure.js';
import { EVENT_SCHEDULER, type EventScheduler } from './scheduler/scheduler.js';
import { SmtpReportSender } from './reports/sender.js';
import { SimulationService } from './simulation/simulation.service.js';
import { SmtpSimServer } from './smtp/smtp-sim.server.js';
import { LogMailer, SmtpMailer } from './accounts/mailer.js';
import { SIM_STORE, type SimStore } from './store/store.js';
import { WEBHOOK_DISPATCHER, type WebhookDispatcher } from './webhooks/webhooks.js';


/** Starts the SMTP server with the app and stops everything on shutdown. */
@Injectable()
class Lifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('RelayoSim');
  private smtp: SmtpSimServer | undefined;
  private tlsReload: ReturnType<typeof setInterval> | undefined;
  private purgeTimer: ReturnType<typeof setInterval> | undefined;
  /** Port the SMTP server listens on, once started (useful with port 0 in tests). */
  smtpPort: number | undefined;

  constructor(
    @Inject(SIM_CONFIG) private readonly config: SimConfig,
    @Inject(SimulationService) private readonly sim: SimulationService,
    @Inject(INFRASTRUCTURE) private readonly infra: Infrastructure,
    @Inject(LiveService) private readonly live: LiveService,
    @Inject(SIM_STORE) private readonly store: SimStore,
    @Inject(AccountsService) private readonly accounts: AccountsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.infra.onWebhookExhausted = (attempt) => void this.alertWebhookFailing(attempt);
    this.startRetention();
    await this.resealSecrets();
    await this.startSmtp();
  }

  /** Emails a project's owner when an event used up its webhook tries: at most once a day per project. */
  private async alertWebhookFailing(attempt: WebhookAttempt): Promise<void> {
    try {
      if ((await this.store.nextAttempt(`webhook-alert|${attempt.projectId}`, 86_400_000)) > 1) return;
      const project = await this.store.getProject(attempt.projectId);
      const owner = project?.ownerId ? await this.store.getUser(project.ownerId) : undefined;
      if (project && owner) await this.accounts.notifyWebhookFailing(owner, project, attempt);
    } catch (error) {
      this.logger.warn(`Could not send the webhook failure alert: ${(error as Error).message}`);
    }
  }

  /** After a SECRETS_KEY change: moves every stored secret to the new key, so the old one can be dropped. */
  private async resealSecrets(): Promise<void> {
    if (!this.config.previousSecretsKeys?.length) return;
    const { resealed, unreadable } = await this.live.resealSecrets();
    this.logger.log(`SECRETS_KEY rotation: ${resealed} secrets sealed with the new key`);
    if (unreadable) this.logger.warn(`SECRETS_KEY rotation: ${unreadable} secrets open with no key; their connections need their credentials again`);
    else this.logger.log('SECRETS_KEY rotation: every secret uses the new key, SECRETS_KEY_PREVIOUS can be removed');
  }

  /** Deletes messages older than RETENTION_DAYS (and expired sessions and tokens): at start, then every hour. */
  private startRetention(): void {
    const days = this.config.retentionDays ?? 7;
    const purge = () => {
      const before = new Date(Date.now() - days * 86_400_000);
      void this.store.purge(days > 0 ? before : new Date(0)).then(
        ({ messages }) => messages && this.logger.log(`Retention: deleted ${messages} messages older than ${days} days`),
        (error: Error) => this.logger.warn(`Retention purge failed: ${error.message}`),
      );
    };
    purge();
    this.purgeTimer = setInterval(purge, 60 * 60_000);
    this.purgeTimer.unref();
  }

  private async startSmtp(): Promise<void> {
    if (this.config.smtpPort === undefined) return;
    const tls = this.config.tls;
    const loadTls = async () =>
      tls && 'keyFile' in tls ? { key: await readFile(tls.keyFile, 'utf8'), cert: await readFile(tls.certFile, 'utf8') } : tls;
    const initial = await loadTls().catch((error: Error) => {
      // On a first deploy the proxy may still be getting the certificate: fail, and let the restart policy retry.
      throw new Error(`Cannot read the SMTP TLS certificate (TLS_KEY_FILE / TLS_CERT_FILE): ${error.message}`);
    });
    this.smtp = new SmtpSimServer(this.sim, {
      port: this.config.smtpPort,
      host: this.config.host,
      maxHangMs: this.config.maxHangMs,
      live: this.live,
      ...(initial && { tls: initial }),
    });
    if (tls && 'keyFile' in tls) {
      // Certificates from files renew (Let's Encrypt, every ~60 days): pick up the new ones twice a day.
      this.tlsReload = setInterval(() => {
        void loadTls().then(
          (fresh) => fresh && this.smtp?.updateTls(fresh),
          (error: Error) => this.logger.warn(`Could not reload the TLS certificate: ${error.message}`),
        );
      }, 12 * 3_600_000);
      this.tlsReload.unref();
    }
    this.smtpPort = await this.smtp.listen();
    this.logger.log(`SMTP listening on ${this.config.host}:${this.smtpPort}`);
  }

  async onApplicationShutdown(): Promise<void> {
    clearInterval(this.tlsReload);
    clearInterval(this.purgeTimer);
    await this.smtp?.close();
    await this.infra.close();
  }
}

export { Lifecycle };

@Module({})
export class AppModule {
  static forRoot(config: SimConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        HealthController,
        ScenariosController,
        AuthController,
        ProjectsController,
        MessagesController,
        SmsController,
        ConnectionsController,
        InboundController,
        ProjectController,
        AdminController,
        ManagedReviewController,
        WebhookDeliveriesController,
      ],
      providers: [
        { provide: SIM_CONFIG, useValue: config },
        { provide: INFRASTRUCTURE, useFactory: () => infrastructure(config) },
        { provide: SIM_STORE, useFactory: (i: Infrastructure) => i.store, inject: [INFRASTRUCTURE] },
        { provide: EVENT_SCHEDULER, useFactory: (i: Infrastructure) => i.scheduler, inject: [INFRASTRUCTURE] },
        { provide: WEBHOOK_DISPATCHER, useFactory: (i: Infrastructure) => i.dispatcher, inject: [INFRASTRUCTURE] },
        {
          provide: SimulationService,
          useFactory: (store: SimStore, scheduler: EventScheduler, dispatcher: WebhookDispatcher) =>
            new SimulationService(store, scheduler, dispatcher, {
              timeScale: config.timeScale,
              reports: new SmtpReportSender(),
              ...(config.limits && { limits: config.limits }),
            }),
          inject: [SIM_STORE, EVENT_SCHEDULER, WEBHOOK_DISPATCHER],
        },
        {
          provide: AccountsService,
          useFactory: (store: SimStore, sim: SimulationService) =>
            new AccountsService(store, sim, {
              signup: config.signup,
              publicUrl: config.publicUrl ?? `http://localhost:${config.httpPort}`,
              mailer: config.mail ? new SmtpMailer(config.mail.url, config.mail.from) : new LogMailer(),
              // Without a real mailer the verification link could not reach anyone.
              requireVerification: !!config.mail,
              ...(config.adminEmails && { adminEmails: config.adminEmails }),
            }),
          inject: [SIM_STORE, SimulationService],
        },
        {
          provide: LiveService,
          useFactory: (store: SimStore, dispatcher: WebhookDispatcher) => {
            const box = config.secretsKey ? new SecretBox(config.secretsKey, config.previousSecretsKeys) : undefined;
            const identities = config.managed?.sesRegion ? new SesIdentities(config.managed.sesRegion) : undefined;
            const managed = config.managed && box ? new ManagedSending(store, box, config.managed, undefined, identities) : undefined;
            return new LiveService(store, dispatcher, box, managed, config.publicUrl);
          },
          inject: [SIM_STORE, WEBHOOK_DISPATCHER],
        },
        ProjectGuard,
        SessionGuard,
        AdminGuard,
        PlatformAdminGuard,
        Lifecycle,
      ],
    };
  }
}
