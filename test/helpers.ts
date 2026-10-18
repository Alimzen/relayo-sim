import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RelayoEvent } from '@alimzen/core';
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
export function memorySimulation(timeScale = 0) {
  const store = new MemoryStore();
  const scheduler = new MemoryScheduler();
  const dispatcher = new MemoryDispatcher({ attempts: 3, delayMs: () => 10 });
  const sim = new SimulationService(store, scheduler, dispatcher, { timeScale });
  return { sim, store, scheduler, dispatcher };
}
