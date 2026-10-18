/**
 * Smoke test against a running simulator: creates a project, sends a few scenarios over SMTP with Relayo
 * and prints the stored timelines. Start the simulator with TIME_SCALE=0 first, then:
 *
 *   SIM_URL=http://127.0.0.1:3000 SIM_SMTP_PORT=2525 pnpm smoke
 */
import { createRelayo, isRelayoError } from '@alimzen/core';
import { smtp } from '@alimzen/smtp';

const simUrl = process.env.SIM_URL ?? 'http://127.0.0.1:3000';
const smtpPort = Number(process.env.SIM_SMTP_PORT ?? 2525);
const adminToken = process.env.ADMIN_TOKEN;
if (!adminToken) throw new Error('ADMIN_TOKEN is required (it is in .env)');

const created = await fetch(`${simUrl}/v1/projects`, {
  method: 'POST',
  headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
  body: JSON.stringify({ name: `Smoke ${new Date().toISOString()}` }),
});
if (!created.ok) throw new Error(`Could not create a project: ${created.status} ${await created.text()}`);
const project = (await created.json()) as { id: string; apiKey: string };
console.log(`Project ${project.id}`);
console.log(`API key (para entrar al panel): ${project.apiKey}`);

const driver = smtp({ host: '127.0.0.1', port: smtpPort, secure: false, ignoreTLS: true, auth: { user: 'smoke', pass: project.apiKey } });
const relayo = createRelayo({ email: driver });

for (const scenario of ['ana', 'hard-bounce', 'greylist', 'dmarc', 'complaint']) {
  const to = `${scenario}@sim.relayo.dev`;
  try {
    const result = await relayo.email.send({
      from: { address: 'smoke@empresa.com' },
      to: { address: to },
      subject: `Smoke ${scenario}`,
      text: 'Hola',
      metadata: { scenario },
    });
    console.log(`${to.padEnd(30)} sent      ${result.messageId}`);
  } catch (error) {
    const detail = isRelayoError(error) ? `${error.code} (retryable: ${error.retryable}) ${error.message}` : String(error);
    console.log(`${to.padEnd(30)} refused   ${detail}`);
  }
}
driver.close();

await new Promise((r) => setTimeout(r, 500));
const list = (await (await fetch(`${simUrl}/v1/messages?limit=20`, { headers: { authorization: `Bearer ${project.apiKey}` } })).json()) as {
  data: Array<{ id: string; subject: string; recipients: Array<{ address: string }> }>;
};
console.log('\nStored timelines:');
for (const message of list.data.reverse()) {
  const full = (await (await fetch(`${simUrl}/v1/messages/${message.id}`, { headers: { authorization: `Bearer ${project.apiKey}` } })).json()) as {
    events: Array<{ type: string; bounceType?: string; reason?: string }>;
  };
  const timeline = full.events.map((e) => (e.bounceType ? `${e.type}(${e.bounceType}/${e.reason})` : e.type)).join(' → ');
  console.log(`${message.recipients[0]?.address.padEnd(30)} ${timeline || '(no events)'}`);
}
