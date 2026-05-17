/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Public exports for Disc's SMTP module.
 *
 * Most consumers want `createMailer(config)` and the `Mailer`
 * interface. The lower-level `SmtpClient` is exported for tests and
 * for advanced cases where header construction needs to bypass the
 * mailer.
 */

export {
  defaultConnectImpl,
  SmtpClient,
  type SendEnvelope,
  type SendOutcome,
  type SmtpClientConfig
} from "./client.ts";
export { createMailer, NoopMailer, SmtpMailer, type Mailer } from "./mailer.ts";
export type {
  Email,
  MailerResult,
  SmtpClientOptions,
  SmtpConfig,
  SmtpConn,
  SmtpConnectImpl
} from "./types.ts";
