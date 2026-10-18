import type { AddressInfo } from 'node:net';
import { SMTPServer } from 'smtp-server';
import { quotedHeaders, readHeaders } from '../capture/capture.js';
import type { Project } from '../domain.js';
import type { SmtpReply } from '../scenarios/catalog.js';
import type { ResolvedScenario } from '../scenarios/resolve.js';
import { QuotaExceededError, type SimulationService } from '../simulation/simulation.service.js';

export interface SmtpSimOptions {
  port: number;
  host?: string;
  /** Longest a `timeout` scenario keeps the client waiting before answering 451 4.4.1. Default 120 s. */
  maxHangMs?: number;
  /** Largest message accepted, in bytes. Default 25 MB. */
  maxSize?: number;
  /** PEM key and certificate to offer STARTTLS. Without them the server is plain text (local use only). */
  tls?: { key: string; cert: string };
}

interface SessionState {
  project: Project;
  from: string;
  accepted: Array<{ address: string; outcome: ResolvedScenario }>;
}

const MESSAGE_ID_HEADER = 'x-relayo-message-id';
const METADATA_HEADER = 'x-relayo-metadata';
const SCENARIO_HEADER = 'x-sim-scenario';

/** The SMTP front door of the simulator: answers every command the way the chosen scenario says. */
export class SmtpSimServer {
  private readonly server: SMTPServer;
  private readonly sessions = new Map<string, SessionState>();
  private readonly hanging = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private readonly sim: SimulationService,
    private readonly options: SmtpSimOptions,
  ) {
    this.server = new SMTPServer({
      name: 'sim.relayo.dev',
      banner: 'Relayo Sim',
      logger: false,
      authOptional: false,
      authMethods: ['PLAIN', 'LOGIN'],
      allowInsecureAuth: !options.tls,
      ...(options.tls ? { key: options.tls.key, cert: options.tls.cert } : { disabledCommands: ['STARTTLS'] }),
      size: options.maxSize ?? 25 * 1024 * 1024,

      onAuth: (auth, session, callback) => {
        void this.sim.authenticate(auth.password ?? '').then(
          (project) => {
            if (!project) return callback(smtpError(535, '5.7.8', 'Invalid API key'));
            this.sessions.set(session.id, { project, from: '', accepted: [] });
            callback(null, { user: project.id });
          },
          (error: Error) => callback(error),
        );
      },

      onMailFrom: (address, session, callback) => {
        const state = this.sessions.get(session.id);
        if (!state) return callback(smtpError(530, '5.7.0', 'Authentication required'));
        // Each transaction is one message against the project's plan.
        void this.sim.reserve(state.project).then(
          () => {
            state.from = address.address;
            state.accepted = [];
            callback();
          },
          (error: Error) =>
            callback(
              error instanceof QuotaExceededError
                ? error.kind === 'rate'
                  ? smtpError(421, '4.7.0', error.message)
                  : smtpError(452, '4.3.1', error.message)
                : error,
            ),
        );
      },

      onRcptTo: (address, session, callback) => {
        const state = this.sessions.get(session.id);
        if (!state) return callback(smtpError(530, '5.7.0', 'Authentication required'));
        void this.sim.smtpRecipient(state.project, state.from, address.address).then(
          async ({ outcome, reply }) => {
            if (reply && reply !== 'hang') {
              await this.sim.smtpRefused(state.project, state.from, address.address, outcome);
              return callback(toError(reply));
            }
            state.accepted.push({ address: address.address, outcome });
            callback();
          },
          (error: Error) => callback(error),
        );
      },

      onData: (stream, session, callback) => {
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => {
          const state = this.sessions.get(session.id);
          if (!state) return callback(smtpError(530, '5.7.0', 'Authentication required'));
          if ((stream as { sizeExceeded?: boolean }).sizeExceeded) {
            return callback(smtpError(552, '5.3.4', 'Message size exceeds fixed maximum message size'));
          }
          const raw = Buffer.concat(chunks);
          const headers = readHeaders(raw.toString('utf8'));
          void this.handleData(state, headers, raw).then(
            (reply) => this.answer(reply, callback),
            (error: Error) => callback(error),
          );
        });
      },

      onClose: (session) => {
        this.sessions.delete(session.id);
      },
    });
  }

  private async handleData(state: SessionState, headers: Map<string, string>, raw: Buffer) {
    const metadata = decodeMetadata(headers.get(METADATA_HEADER));
    const relayoMessageId = headers.get(MESSAGE_ID_HEADER);
    const scenarioHeader = headers.get(SCENARIO_HEADER);
    const quoted = quotedHeaders(headers);
    const { reply } = await this.sim.smtpData(
      state.project,
      {
        from: headerAddress(headers.get('from')) ?? state.from,
        envelopeFrom: state.from,
        headers: quoted,
        to: state.accepted.map((a) => a.address),
        subject: headers.get('subject') ?? '',
        ...(relayoMessageId && { relayoMessageId }),
        ...(metadata && { metadata }),
        ...(scenarioHeader && { scenarioHeader }),
        raw,
      },
      state.accepted,
    );
    state.accepted = [];
    return reply;
  }

  private answer(reply: SmtpReply | 'hang' | undefined, callback: (error?: Error | null) => void): void {
    if (reply === undefined) return callback();
    if (reply !== 'hang') return callback(toError(reply));
    // Keep the client waiting, as an unresponsive server would, but not forever.
    const timer = setTimeout(() => {
      this.hanging.delete(timer);
      callback(smtpError(451, '4.4.1', 'Connection timed out'));
    }, this.options.maxHangMs ?? 120_000);
    this.hanging.add(timer);
  }

  /** Swaps the STARTTLS certificate without restarting (e.g. after a renewal). */
  updateTls(tls: { key: string; cert: string }): void {
    this.server.updateSecureContext({ key: tls.key, cert: tls.cert });
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(this.options.port, this.options.host ?? '0.0.0.0', resolve));
    return (this.server.server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    for (const timer of this.hanging) clearTimeout(timer);
    this.hanging.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

function smtpError(code: number, enhancedCode: string, text: string): Error {
  return Object.assign(new Error(`${enhancedCode} ${text}`), { responseCode: code });
}

function toError(reply: SmtpReply): Error {
  return smtpError(reply.code, reply.enhancedCode, reply.text);
}

/** `Name <a@b.c>` → `a@b.c`. */
function headerAddress(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const address = (/<([^>]+)>/.exec(value)?.[1] ?? value).trim();
  return address.includes('@') ? address : undefined;
}

function decodeMetadata(value: string | undefined): Record<string, string> | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : undefined;
  } catch {
    return undefined;
  }
}
