import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SMTPServer } from 'smtp-server';
import type { RelayoEvent } from '@alimzen/relayo';
import type { ReportSender } from '../src/reports/sender.js';
import { MemoryScheduler } from '../src/scheduler/scheduler.js';
import { SimulationService } from '../src/simulation/simulation.service.js';
import { MemoryStore } from '../src/store/memory-store.js';
import { MemoryDispatcher, SIGNATURE_HEADER, verifyWebhookSignature } from '../src/webhooks/webhooks.js';

/** Local HTTP endpoint that collects the webhooks the simulator sends, checking their signatures. */
export async function webhookReceiver() {
  const events: RelayoEvent[] = [];
  const invalid: string[] = [];
  let secret = '';
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const signature = req.headers[SIGNATURE_HEADER] as string | undefined;
      if (verifyWebhookSignature(body, signature, secret)) events.push(JSON.parse(body) as RelayoEvent);
      else invalid.push(body);
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/hooks`,
    events,
    invalid,
    setSecret(value: string) {
      secret = value;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A simulator wired with in-memory pieces and instant timelines. */
export function memorySimulation(timeScale = 0, reports?: ReportSender) {
  const store = new MemoryStore();
  const scheduler = new MemoryScheduler();
  const dispatcher = new MemoryDispatcher({ attempts: 3, delayMs: () => 10 });
  const sim = new SimulationService(store, scheduler, dispatcher, { timeScale, ...(reports && { reports }) });
  return { sim, store, scheduler, dispatcher };
}

/** The customer's provider: records what it receives, with headers unfolded and quoted-printable joined. */
export async function smtpProvider() {
  const received: Array<{ to: string[]; raw: string }> = [];
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS', 'AUTH'],
    logger: false,
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8').replace(/\r\n[ \t]+/g, ' ').replace(/=\r\n/g, '').replace(/=3D/g, '=');
        received.push({ to: session.envelope.rcptTo.map((r) => r.address), raw });
        callback();
      });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { received, port: (server.server.address() as AddressInfo).port, close: () => new Promise<void>((r) => server.close(() => r())) };
}
