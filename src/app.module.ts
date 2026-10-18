import {
  Inject,
  Injectable,
  Logger,
  Module,
  type DynamicModule,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { AdminGuard, ApiKeyGuard } from './api/auth.js';
import { AdminController, HealthController, MessagesController, ProjectController, ScenariosController } from './api/controllers.js';
import { SIM_CONFIG, type SimConfig } from './config.js';
import { infrastructure, type Infrastructure } from './infrastructure.js';
import { EVENT_SCHEDULER, type EventScheduler } from './scheduler/scheduler.js';
import { SimulationService } from './simulation/simulation.service.js';
import { SmtpSimServer } from './smtp/smtp-sim.server.js';
import { SIM_STORE, type SimStore } from './store/store.js';
import { WEBHOOK_DISPATCHER, type WebhookDispatcher } from './webhooks/webhooks.js';

const INFRASTRUCTURE = Symbol.for('relayo-sim:infrastructure');

/** Starts the SMTP server with the app and stops everything on shutdown. */
@Injectable()
class Lifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('RelayoSim');
  private smtp: SmtpSimServer | undefined;
  /** Port the SMTP server listens on, once started (useful with port 0 in tests). */
  smtpPort: number | undefined;

  constructor(
    @Inject(SIM_CONFIG) private readonly config: SimConfig,
    @Inject(SimulationService) private readonly sim: SimulationService,
    @Inject(INFRASTRUCTURE) private readonly infra: Infrastructure,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.smtpPort === undefined) return;
    this.smtp = new SmtpSimServer(this.sim, {
      port: this.config.smtpPort,
      host: this.config.host,
      maxHangMs: this.config.maxHangMs,
      ...(this.config.tls && { tls: this.config.tls }),
    });
    this.smtpPort = await this.smtp.listen();
    this.logger.log(`SMTP listening on ${this.config.host}:${this.smtpPort}`);
  }

  async onApplicationShutdown(): Promise<void> {
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
      controllers: [HealthController, ScenariosController, MessagesController, ProjectController, AdminController],
      providers: [
        { provide: SIM_CONFIG, useValue: config },
        { provide: INFRASTRUCTURE, useFactory: () => infrastructure(config) },
        { provide: SIM_STORE, useFactory: (i: Infrastructure) => i.store, inject: [INFRASTRUCTURE] },
        { provide: EVENT_SCHEDULER, useFactory: (i: Infrastructure) => i.scheduler, inject: [INFRASTRUCTURE] },
        { provide: WEBHOOK_DISPATCHER, useFactory: (i: Infrastructure) => i.dispatcher, inject: [INFRASTRUCTURE] },
        {
          provide: SimulationService,
          useFactory: (store: SimStore, scheduler: EventScheduler, dispatcher: WebhookDispatcher) =>
            new SimulationService(store, scheduler, dispatcher, { timeScale: config.timeScale }),
          inject: [SIM_STORE, EVENT_SCHEDULER, WEBHOOK_DISPATCHER],
        },
        ApiKeyGuard,
        AdminGuard,
        Lifecycle,
      ],
    };
  }
}
