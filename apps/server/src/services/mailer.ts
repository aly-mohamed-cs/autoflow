// Email from the Orchestrator (sign-in codes) through the company mail server (SMTP).
import nodemailer from 'nodemailer';
import { z } from 'zod';
import type { Settings } from './core.js';

export interface SmtpSettings {
  host: string;
  port: number;
  security: 'starttls' | 'tls' | 'none';
  from: string;
  username: string;
  /** Sealed with the vault key. */
  password: string;
  allowInvalidCert: boolean;
}
export const DEFAULT_SMTP: SmtpSettings = { host: '', port: 25, security: 'starttls', from: '', username: '', password: '', allowInvalidCert: false };

export const SmtpBody = z.object({
  host: z.string().trim().max(200),
  port: z.number().int().min(1).max(65535),
  security: z.enum(['starttls', 'tls', 'none']),
  from: z.string().trim().max(200),
  username: z.string().trim().max(200).default(''),
  /** Leave out to keep the saved password; '' removes it. */
  password: z.string().max(500).optional(),
  allowInvalidCert: z.boolean().default(false),
});

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export class Mailer {
  constructor(
    private readonly settings: Settings,
    private readonly unseal: (sealed: string) => string,
  ) {}

  config(): SmtpSettings {
    return this.settings.get<SmtpSettings>('smtp', DEFAULT_SMTP);
  }

  configured(): boolean {
    const c = this.config();
    return !!(c.host && c.from);
  }

  async send(message: MailMessage): Promise<void> {
    const c = this.config();
    if (!c.host || !c.from) throw new Error('No mail server is set up (Settings → Email).');
    const transport = nodemailer.createTransport({
      host: c.host,
      port: c.port,
      secure: c.security === 'tls',
      requireTLS: c.security === 'starttls',
      ignoreTLS: c.security === 'none',
      auth: c.username ? { user: c.username, pass: c.password ? this.unseal(c.password) : '' } : undefined,
      tls: { rejectUnauthorized: !c.allowInvalidCert },
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
    });
    try {
      await transport.sendMail({ from: c.from, to: message.to, subject: message.subject, text: message.text });
    } finally {
      transport.close();
    }
  }
}
