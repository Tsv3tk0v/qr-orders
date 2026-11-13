import nodemailer, { type Transporter } from 'nodemailer';

/** Имейли (дневен отчет, грешки в импорта). Без SMTP_URL имейлите само се записват в лога. */
export interface Mailer { send(to: string[], subject: string, text: string): Promise<void> }

export function createMailer(smtpUrl: string | undefined, from: string, log: (m: string) => void): Mailer {
  const transport: Transporter | null = smtpUrl ? nodemailer.createTransport(smtpUrl) : null;
  return {
    async send(to, subject, text) {
      if (!to.length) return;
      if (!transport) { log(`[имейл, без SMTP] до ${to.join(', ')}: ${subject}`); return; }
      await transport.sendMail({ from, to, subject, text });
    },
  };
}
