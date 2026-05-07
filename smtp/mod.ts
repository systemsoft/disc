/**
 * Public exports for Disc's SMTP module.
 *
 * Most consumers want `createMailer(config)` and the `Mailer`
 * interface. The lower-level `SmtpClient` is exported for tests and
 * for advanced cases where header construction needs to bypass the
 * mailer.
 */

export { defaultConnectImpl, type SendEnvelope, type SendOutcome, SmtpClient, type SmtpClientConfig } from "./client.ts";
export { createMailer, type Mailer, NoopMailer, SmtpMailer } from "./mailer.ts";
export type { Email, MailerResult, SmtpClientOptions, SmtpConfig, SmtpConn, SmtpConnectImpl } from "./types.ts";
