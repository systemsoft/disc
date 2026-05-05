# `smtp/` — minimal SMTP client for Disc

A small, in-house SMTP submission client. Used by the auth webhook
subscriber to deliver verification emails, password reset links, and
magic links.

## Why in-house

There is no maintained jsr-native SMTP client, and Disc's import policy
is jsr-only (no `npm:` specifiers, no `https://deno.land/x/...`). The
SMTP submission protocol surface we need is small enough to implement
directly on top of `Deno.connect` / `Deno.startTls`.

## Quickstart

```ts
import { createMailer } from "./mod.ts";

const mailer = createMailer({
  host: "smtp.example.com",
  port: 587,
  auth: { user: "no-reply@example.com", pass: "..." },
  from: "Disc <no-reply@example.com>",
});

await mailer.send({
  to: "user@example.com",
  subject: "Welcome to Disc",
  text: "Plain text body",
  html: "<p>HTML body</p>", // optional; triggers multipart/alternative
});
```

## What it does

- TCP (port 25/587) and direct TLS (port 465 via `secure: true`)
- EHLO with extension parsing
- STARTTLS upgrade when the server advertises it and `secure: false`
- AUTH PLAIN (preferred) and AUTH LOGIN (fallback)
- MAIL FROM / RCPT TO / DATA / QUIT with RFC 5321 dot-stuffing
- RFC 5322 headers (From, To, Subject, Date, Message-ID, MIME-Version)
- multipart/alternative when `html` is supplied
- RFC 2047 encoded-word for non-ASCII Subject lines

## What it doesn't do

- DKIM/SPF/DMARC signing — separate module, future work
- Connection pooling — one connection per send, like nodemailer's
  default transport. Auth-driven sends are infrequent.
- Attachments
- XOAUTH2 (RFC 6749 §6) — there's a TODO in `client.ts`
- Pipelining, SMTPUTF8, DSN

## TLS cert validation (#8533)

`SmtpConfig.tlsRejectUnauthorized` exists in the type but has a runtime
caveat. **Deno does not expose a per-connection cert validation toggle**
on `connectTls` / `startTls`. The only way to disable validation is at
the runtime CLI level:

```sh
deno run --unsafely-ignore-certificate-errors=smtp.dev.local your-app.ts
```

Setting `tlsRejectUnauthorized: false` in config will log a warning at
mailer construction reminding you of this — it does not actually flip
any flag inside the mailer. We chose to be honest about the constraint
rather than pretend we can toggle something we can't.

For production use, point `host` at a server with a valid cert.

## `NoopMailer` (gh/geldata#8224)

`createMailer(undefined)` returns a `NoopMailer` that logs at INFO and
returns a synthetic `MailerResult`. Why: the original Gel bug was that
auth flows like `requestMagicLink` raised when SMTP wasn't configured.
Some deployments only deliver mail via webhook subscribers — they
shouldn't have to fake an SMTP config to keep the auth surface working.

## Architecture

```
mailer.ts           consumer-facing Mailer interface
  ├── SmtpMailer    builds RFC 5322 headers, calls SmtpClient
  └── NoopMailer    logs + synthetic result
client.ts           raw protocol over Deno.Conn
types.ts            SmtpConfig, Email, MailerResult, SmtpConn
```

`SmtpClient` accepts an injectable `connectImpl` so tests can stub the
socket without binding real ports — same pattern as `auth/webhooks.ts`
`WebhookSender`'s `fetchImpl`.
