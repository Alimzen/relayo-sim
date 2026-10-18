import { Logger } from '@nestjs/common';
import { createRelayo, type Relayo } from '@alimzen/core';
import { smtp } from '@alimzen/smtp';

export interface MailToSend {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** The simulator's own email (password resets), not the simulated kind. */
export interface Mailer {
  send(mail: MailToSend): Promise<void>;
  close?(): void;
}

/** Sends through any SMTP server, with Relayo itself. */
export class SmtpMailer implements Mailer {
  private readonly relayo: Relayo;
  private readonly from: { address: string; name?: string };

  constructor(url: string, from: string) {
    this.relayo = createRelayo({ email: smtp(url) });
    this.from = parseAddress(from);
  }

  async send(mail: MailToSend): Promise<void> {
    await this.relayo.email.send({ from: this.from, to: { address: mail.to }, subject: mail.subject, text: mail.text, html: mail.html });
  }
}

/** Without MAIL_URL (local development): the email goes to the log, so the link can still be followed. */
export class LogMailer implements Mailer {
  private readonly logger = new Logger('Mail');

  async send(mail: MailToSend): Promise<void> {
    this.logger.warn(`MAIL_URL is not set; email to ${mail.to} not sent. "${mail.subject}"\n${mail.text}`);
  }
}

/** `Relayo Sim <no-reply@example.com>` → `{ name, address }`. */
export function parseAddress(value: string): { address: string; name?: string } {
  const match = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(value);
  if (!match) return { address: value.trim() };
  const name = match[1]!.trim();
  return name ? { name, address: match[2]!.trim() } : { address: match[2]!.trim() };
}
