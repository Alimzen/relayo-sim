import nodemailer, { type Transporter } from 'nodemailer';

export const REPORT_SENDER = Symbol.for('relayo-sim:reports');

/** Delivers bounce and complaint reports by SMTP. */
export interface ReportSender {
  send(smtpUrl: string, to: string, raw: string): Promise<void>;
  close(): void;
}

/** Nodemailer-based sender, one pooled transport per SMTP URL. */
export class SmtpReportSender implements ReportSender {
  private readonly transports = new Map<string, Transporter>();

  async send(smtpUrl: string, to: string, raw: string): Promise<void> {
    let transport = this.transports.get(smtpUrl);
    if (!transport) {
      transport = nodemailer.createTransport(smtpUrl);
      this.transports.set(smtpUrl, transport);
    }
    // Null reverse path (MAIL FROM:<>), as for any DSN: a report must never bounce back (RFC 3464).
    await transport.sendMail({ envelope: { from: '', to: [to] }, raw });
  }

  close(): void {
    for (const transport of this.transports.values()) transport.close();
    this.transports.clear();
  }
}

/** Shows the SMTP URL without its password. */
export function maskSmtpUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '****';
    return parsed.toString();
  } catch {
    return 'smtp://****';
  }
}
