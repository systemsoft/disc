# Authentication

Disc includes a built-in authentication system with user registration, JWT-based sessions, password management, and email verification. Auth is disabled by default and must be explicitly enabled.

---

## Enabling Auth

### CLI Flags

Start the server with authentication enabled:

```bash
disc serve --jwt-secret "your-secret-key-at-least-32-chars" --enable-auth
```

### Environment Variables

Alternatively, configure auth via environment variables:

```bash
export DISC_ENABLE_AUTH=1
export DISC_JWT_SECRET="your-secret-key-at-least-32-chars"
disc serve
```

Both the JWT secret and the enable flag are required. Without `--enable-auth` (or `DISC_ENABLE_AUTH=1`), the `/auth/*` routes are not registered even if a JWT secret is provided.

---

## API Endpoints

All auth endpoints are served under the `/auth/` path prefix. Requests and responses use JSON.

### POST /auth/register

Create a new user account. Returns the user object, a JWT access token, and a refresh token.

**Request:**

```bash
curl -X POST http://localhost:8080/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "ada@example.com",
    "metadata": { "plan": "pro" },
    "password": "C0rrectHorseB@tteryStapl3",
    "username": "ada"
  }'
```

**Required fields:** `email`, `password`

**Optional fields:** `username`, `metadata` (arbitrary JSON object)

**Response (201 Created):**

```json
{
  "refreshToken": "7f3c9a2b...",
  "session": {
    "createdAt": "2026-03-20T12:00:00.000Z",
    "expiresAt": "2026-03-20T13:00:00.000Z",
    "id": "a5b2c3d4-...",
    "refreshToken": "7f3c9a2b...",
    "token": "eyJhbGciOiJIUzI1NiIs...",
    "userId": "d290f1ee-..."
  },
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "active": true,
    "createdAt": "2026-03-20T12:00:00.000Z",
    "id": "d290f1ee-6c54-4b01-90e6-d701748f0851",
    "email": "ada@example.com",
    "emailVerified": true,
    "metadata": { "plan": "pro" },
    "updatedAt": "2026-03-20T12:00:00.000Z",
    "username": "ada"
  }
}
```

Registration can be disabled with the `allowRegistration: false` config option. When disabled, POST /auth/register returns `403 REGISTRATION_DISABLED`.

---

### POST /auth/login

Authenticate with email (or username) and password.

**Request (by email):**

```bash
curl -X POST http://localhost:8080/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "ada@example.com",
    "password": "C0rrectHorseB@tteryStapl3"
  }'
```

**Request (by username):**

```json
{
  "password": "C0rrectHorseB@tteryStapl3",
  "username": "ada"
}
```

**Response (200 OK):** Same shape as the registration response.

The login endpoint checks that the user account is active and, if email verification is required, that the email has been verified. Failed checks return the appropriate error code (see [Error Codes](#error-codes)).

---

### POST /auth/refresh

Exchange a refresh token for a new access token and refresh token pair. The old session is revoked and a new session is created.

**Request:**

```bash
curl -X POST http://localhost:8080/auth/refresh \
  -H "Content-Type: application/json" \
  -d '{
    "refreshToken": "7f3c9a2b..."
  }'
```

**Response (200 OK):** Same shape as the registration response, with new `token` and `refreshToken` values.

This implements token rotation -- every refresh invalidates the previous refresh token. If a refresh token is reused after rotation, the request fails with `401 INVALID_REFRESH_TOKEN`.

---

### POST /auth/logout

Revoke the current session. Requires authentication.

```bash
curl -X POST http://localhost:8080/auth/logout \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIs..."
```

**Response (200 OK):**

```json
{ "success": true }
```

---

### GET /auth/profile

Retrieve the authenticated user’s profile. Requires authentication.

```bash
curl http://localhost:8080/auth/profile \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIs..."
```

**Response (200 OK):**

```json
{
  "active": true,
  "createdAt": "2026-03-20T12:00:00.000Z",
  "email": "ada@example.com",
  "emailVerified": true,
  "id": "d290f1ee-...",
  "metadata": { "plan": "pro" },
  "updatedAt": "2026-03-20T12:00:00.000Z",
  "username": "ada"
}
```

The password hash is never included in profile responses.

---

### PUT /auth/password

Update the authenticated user’s password. Requires authentication. All existing sessions are revoked after a successful password change.

**Request:**

```bash
curl -X PUT http://localhost:8080/auth/password \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIs..." \
  -H "Content-Type: application/json" \
  -d '{
    "old_password": "batteryStaple",
    "new_password": "C0rrectHorseB@tteryStapl3"
  }'
```

**Response (200 OK):**

```json
{ "success": true }
```

The new password must satisfy the configured password policy. If it does not, the response is `400 PASSWORD_TOO_WEAK` with a message describing the requirements.

---

### POST /auth/reset

Request a password reset. This generates a reset token that expires after 1 hour.

**Request:**

```bash
curl -X POST http://localhost:8080/auth/reset \
  -H "Content-Type: application/json" \
  -d '{ "email": "ada@example.com" }'
```

**Response (200 OK):**

```json
{
  "message": "Password reset email sent",
  "success": true
}
```

In a production deployment, you would integrate an email service to deliver the reset token to the user. The server generates the token but does not send email by default.

---

### POST /auth/reset/confirm

Complete a password reset using the token from the reset request.

**Request:**

```bash
curl -X POST http://localhost:8080/auth/reset/confirm \
  -H "Content-Type: application/json" \
  -d '{
    "new_password": "brandNewPassword!",
    "reset_token": "a1b2c3d4..."
  }'
```

**Response (200 OK):**

```json
{ "success": true }
```

All existing sessions are revoked after the password is reset.

---

### GET /auth/verify

Verify a user’s email address using the verification token issued during registration.

```bash
curl "http://localhost:8080/auth/verify?token=abc123..."
```

**Response (200 OK):**

```json
{ "success": true }
```

Email verification is only active when `requireEmailVerification` is set to `true` in the auth config. When enabled, users cannot log in until their email is verified.

---

## Token Format

Disc uses HS256-signed JWTs. The access token payload contains:

```json
{
  "aud": "disc-api",
  "email": "ada@example.com",
  "exp": 1711003600,
  "iat": 1711000000,
  "iss": "disc",
  "jti": "unique-token-id",
  "sub": "d290f1ee-6c54-4b01-90e6-d701748f0851",
  "username": "ada"
}
```

| Field      | Description                         |
| ---------- | ----------------------------------- |
| `aud`      | Audience (default: `"disc-api"`)    |
| `email`    | User email address                  |
| `exp`      | Expiration timestamp (Unix seconds) |
| `iat`      | Issued-at timestamp (Unix seconds)  |
| `iss`      | Issuer (default: `"disc"`)          |
| `jti`      | Unique JWT ID for tracking          |
| `sub`      | User ID (UUID)                      |
| `username` | Username (if set)                   |

Tokens are extracted from requests in this order of precedence:

1. `Authorization: Bearer <token>` header
2. `auth_token` cookie
3. `?token=<token>` query parameter

---

## Auth Context in Queries

When auth is enabled, the JWT claims from an authenticated request flow into the query context. This is how [access policies](access-policies.md) know who is making a request.

The server builds an `AuthContext` from the verified JWT:

```typescript
interface AuthContext {
  jwtClaims?: {
    aud?: string;
    email: string;
    iss?: string;
    sub: string;
    username?: string;
  };
  permissions: string[];
  roles: string[]; // extensible roles
  userId?: string; // from JWT sub claim
}
```

This context is passed to the query handler on every request. When access policies are enabled, the `AuthContext` is bridged to an `AccessContext` that the policy evaluator uses for row-level filtering. See [Access Policies](access-policies.md) for details.

---

## Configuration Options

All configuration options with their defaults:

```typescript
interface AuthConfig {
  // Required
  jwtSecret: string; // No default -- must be provided

  // Token settings
  jwtAudience?: string; // Default: "disc-api"
  jwtIssuer?: string; // Default: "disc"
  refreshTokenExpiry?: number; // Default: 604800 (7 days, in seconds)
  tokenExpiry?: number; // Default: 3600 (1 hour, in seconds)

  // Session settings
  sessionTimeout?: number; // Default: 3600 (1 hour, in seconds)

  // Registration settings
  allowRegistration?: boolean; // Default: true
  requireEmailVerification?: boolean; // Default: false

  // Password policy
  bcryptRounds?: number; // Default: 12
  passwordMinLength?: number; // Default: 8
  passwordRequireNumbers?: boolean; // Default: false
  passwordRequireSpecial?: boolean; // Default: false
  passwordRequireUppercase?: boolean; // Default: false
}
```

When using the server config in `disc.toml` or via `ServerConfig`, auth-specific options are nested under `authConfig`:

```typescript
const serverConfig: ServerConfig = {
  // ... other server options
  authConfig: {
    allowRegistration: false, // Disable open registration
    bcryptRounds: 14,
    passwordMinLength: 12,
    passwordRequireNumbers: true,
    passwordRequireUppercase: true,
    tokenExpiry: 1800, // 30 minutes
  },
  enableAuth: true,
  jwtSecret: "your-secret-key",
};
```

---

## Error Codes

Auth errors are returned as JSON with an HTTP status code, error message, and machine-readable error code:

```json
{
  "code": "INVALID_CREDENTIALS",
  "error": "INVALID_CREDENTIALS: Invalid credentials"
}
```

| Code                    | HTTP Status | Description                                      |
| ----------------------- | ----------- | ------------------------------------------------ |
| `EMAIL_NOT_VERIFIED`    | 403         | Email verification is required but not completed |
| `INVALID_CREDENTIALS`   | 401         | Wrong email/username or password                 |
| `INVALID_REFRESH_TOKEN` | 401         | Refresh token is invalid or already used         |
| `INVALID_TOKEN`         | 401         | JWT is malformed or signature is invalid         |
| `PASSWORD_TOO_WEAK`     | 400         | Password does not meet policy requirements       |
| `REGISTRATION_DISABLED` | 403         | Open registration is turned off                  |
| `SESSION_EXPIRED`       | 401         | Session has been revoked or timed out            |
| `TOKEN_EXPIRED`         | 401         | JWT has expired                                  |
| `USER_ALREADY_EXISTS`   | 409         | Email or username already taken                  |
| `USER_INACTIVE`         | 403         | User account has been deactivated                |
| `USER_NOT_FOUND`        | 404         | No user with that email or username              |

---

## Database Schema

The auth module creates and manages two tables automatically when initialized:

### `users` table

| Column                | Type                 | Description                       |
| --------------------- | -------------------- | --------------------------------- |
| `active`              | BOOLEAN              | Whether account is active         |
| `created_at`          | TIMESTAMP            | Account creation time             |
| `email`               | TEXT UNIQUE NOT NULL | Login identifier                  |
| `email_verified`      | BOOLEAN              | Whether email has been verified   |
| `id`                  | TEXT PRIMARY KEY     | UUID                              |
| `metadata`            | TEXT                 | JSON string of arbitrary metadata |
| `password_hash`       | TEXT NOT NULL        | bcrypt hash                       |
| `reset_token`         | TEXT                 | Token for password reset          |
| `reset_token_expires` | TIMESTAMP            | Reset token expiration            |
| `updated_at`          | TIMESTAMP            | Last modification time            |
| `username`            | TEXT UNIQUE          | Optional login identifier         |
| `verification_token`  | TEXT                 | Token for email verification      |

### `sessions` table

| Column          | Type                  | Description                          |
| --------------- | --------------------- | ------------------------------------ |
| `created_at`    | TIMESTAMP             | Session start time                   |
| `expires_at`    | TIMESTAMP             | Session expiration                   |
| `id`            | TEXT PRIMARY KEY      | Session UUID                         |
| `ip_address`    | TEXT                  | Client IP                            |
| `last_activity` | TIMESTAMP             | Last request timestamp               |
| `refresh_token` | TEXT UNIQUE           | Refresh token                        |
| `revoked`       | BOOLEAN               | Whether session has been invalidated |
| `token`         | TEXT UNIQUE           | JWT access token                     |
| `user_agent`    | TEXT                  | Client user-agent string             |
| `user_id`       | TEXT (FK -> users.id) | Owning user                          |

---

## Beyond Email + Password

The endpoints in [API Endpoints](#api-endpoints) are the email-and-password core. Disc also ships a full authentication suite — TOTP-based MFA, magic links, recovery codes, WebAuthn passkeys, anonymous sessions, OAuth providers, branding, and webhooks. This section covers each.

### TOTP MFA

Two-factor authentication via RFC 6238. Compatible with Google Authenticator, 1Password, Authy, and any standard authenticator app.

Enrollment is a two-step ceremony:

```typescript
// Step 1: authenticated user requests a fresh secret + QR-friendly URI.
const { secret, otpauthUri } = await provider.enrollTOTP(userId);
// Render `otpauthUri` as a QR code.

// Step 2: user scans, types the 6-digit code their app shows.
await provider.confirmTOTP(userId, "123456");
// Future logins now require the second factor.
```

Login with MFA returns an `MfaChallenge` instead of a session if the user has confirmed TOTP:

```typescript
const result = await provider.login({ email, password });
if ("mfaRequired" in result) {
  const auth = await provider.loginWithTOTP(result.challengeToken, code);
}
```

HTTP routes:

| Method | Path                     | Auth-gated                                   |
| ------ | ------------------------ | -------------------------------------------- |
| POST   | `/auth/mfa/totp/enroll`  | Yes                                          |
| POST   | `/auth/mfa/totp/confirm` | Yes                                          |
| POST   | `/auth/mfa/totp/disable` | Yes                                          |
| POST   | `/auth/mfa/totp/login`   | No (uses challenge token from `/auth/login`) |

Defaults: SHA-1, 30-second step, 6-digit codes, ±1 step verification window. Pending enrollments (no `confirmed_at`) do not gate login — protects users from locking themselves out before scanning the QR. Re-enrolling rotates the secret; the previous QR becomes invalid. (`auth/totp.ts`, gh/geldata#8186)

### Magic-Link Login

Passwordless login via email. The user types their email; the server mints a single-use, hashed token; the link target redeems it.

```typescript
// Step 1: user types email.
const token = await provider.requestMagicLink("u@example.com");
// Send `https://app.example.com/magic?token=${token}` via email.

// Step 2: user clicks the link, app calls:
const result = await provider.consumeMagicLink(token);
if ("mfaRequired" in result) {
  // User has TOTP — redeem the challenge.
} else {
  // Full session.
}
```

HTTP routes (both public, both rate-limited):

| Method | Path                       | Body                 |
| ------ | -------------------------- | -------------------- |
| POST   | `/auth/magic-link/request` | `{ "email": "..." }` |
| POST   | `/auth/magic-link/consume` | `{ "token": "..." }` |

**Anti-enumeration:** `requestMagicLink` always returns a plaintext token, even when no user matches the email — the token isn't persisted, so it can't be redeemed. Same response shape, same timing, no account-state leak.

**Single-use + TTL:** tokens are hashed in storage, expire in 15 minutes, and `consumed_at` is set on the first redeem (even when the redeem returns an MFA challenge instead of a session, so the link can't be replayed mid-MFA).

#### Custom URL template

The default link target is `${emailBaseUrl}/auth/magic?token=<token>`. Override with `magicLinkUrlTemplate`:

```typescript
const config: AuthConfig = {
  jwtSecret: "...",
  emailBaseUrl: "https://app.example.com",
  magicLinkUrlTemplate: "https://app.example.com/login/{token}",
};
```

The template must contain exactly one `{token}` placeholder. The plaintext token is URL-encoded into that slot. Validation rules:

- Must use `https://` (or `http://` for `localhost`/`127.0.0.1` in development).
- CRLF and control characters are rejected.
- Missing or duplicate `{token}` placeholders refuse at construction time.

(`auth/branding.ts` `validateMagicLinkUrlTemplate`, gh/geldata#8028)

### Recovery Codes

One-time-use backup codes for users who lose their authenticator device. Format: `XXXXX-XXXXX` (10 chars from a 30-char Crockford-ish alphabet that drops 0/O/1/I/L). 8 codes per batch by default.

```typescript
// Generate (or regenerate). Show plaintext to the user ONCE — stored
// hashed, never recoverable. Calling this again invalidates every previous code.
const codes = await provider.generateRecoveryCodes(userId);

// Burn one outside the login flow:
const ok = await provider.consumeRecoveryCode(userId, "X7K3M-Q2NPR");

// In the MFA-challenge login flow:
const auth = await provider.loginWithRecoveryCode(challengeToken, code);
```

HTTP routes:

| Method | Path                                | Auth-gated                |
| ------ | ----------------------------------- | ------------------------- |
| POST   | `/auth/mfa/recovery-codes/generate` | Yes                       |
| POST   | `/auth/mfa/recovery-codes/login`    | No (uses challenge token) |

Codes are SHA-256 hashed and keyed by `user_id` at lookup, so a leaked code can't be replayed against another user. Input is normalized (dashes/spaces stripped, uppercased), so users can type `xxxxx xxxxx`, `XXXXXXXXXX`, or `XXXXX-XXXXX`. Burning a code via `loginWithRecoveryCode` also burns the MFA challenge — single-use both ways. (`auth/provider.ts`, gh/geldata#8186)

### WebAuthn / Passkeys

Hardware-backed passwordless login using the W3C WebAuthn standard. Compatible with Apple/Google passkeys, YubiKeys, Windows Hello, etc. ES256-only; attestation formats `none` and `packed` accepted.

Configure the relying party at construction:

```typescript
const provider = new AuthProvider({
  jwtSecret: "...",
  webauthn: {
    rpId: "example.com", // apex domain credentials are scoped to
    rpName: "Example App", // shown in browser prompts
    origin: "https://example.com", // expected clientData.origin
  },
}, db);
```

Without the `webauthn` block, all WebAuthn methods throw `AuthError(INVALID_OPERATION)` — apps that don't want passkeys leave it off.

Registration ceremony:

```typescript
const opts = await provider.beginWebAuthnRegistration(userId);
// Send `opts.publicKey` to the browser; SDK calls
// navigator.credentials.create({ publicKey: opts.publicKey }).

await provider.finishWebAuthnRegistration({
  challengeId: opts.challengeId,
  credentialId: cred.id,
  attestationObject: base64url(cred.response.attestationObject),
  clientDataJSON: base64url(cred.response.clientDataJSON),
  name: "My iPhone",
});
```

Login ceremony:

```typescript
const opts = await provider.beginWebAuthnLogin("u@example.com");
const result = await provider.finishWebAuthnLogin({
  challengeId: opts.challengeId,
  credentialId: cred.id,
  authenticatorData: base64url(cred.response.authenticatorData),
  clientDataJSON: base64url(cred.response.clientDataJSON),
  signature: base64url(cred.response.signature),
});
```

HTTP routes:

| Method | Path                                | Auth-gated        |
| ------ | ----------------------------------- | ----------------- |
| POST   | `/auth/webauthn/register/begin`     | Yes               |
| POST   | `/auth/webauthn/register/finish`    | Yes               |
| POST   | `/auth/webauthn/login/begin`        | No (rate-limited) |
| POST   | `/auth/webauthn/login/finish`       | No (rate-limited) |
| GET    | `/auth/webauthn/credentials`        | Yes               |
| POST   | `/auth/webauthn/credentials/delete` | Yes               |

Counter monotonicity is enforced on every login — a counter that _decreased_ triggers `INVALID_TOKEN` and a `webauthn_counter_regression` audit event (WebAuthn's clone-detection signal). `clientData.origin` and `authenticatorData.rpIdHash` are checked against the configured `webauthn.{origin, rpId}` on every ceremony. (`auth/webauthn.ts`, gh/geldata#6725)

### Anonymous / Guest Identity

`loginAnonymous()` issues a session without an email/password — useful for shopping carts, drafts, settings stored before signup. The user gets the same row + token plumbing as a full identity, with `is_anonymous = true` and a synthetic `anonymous-<uuid>@disc.invalid` email (RFC 6761 reserved TLD).

```typescript
// Issue a guest session.
const guest = await provider.loginAnonymous();
// Use it like any session.

// Later, the user signs up — preserve their cart by upgrading.
const upgraded = await provider.upgradeAnonymous(
  guest.user.id,
  { email: "ada@example.com", password: "..." },
);
// Same `id` — every FK pointing to the user row stays valid.
```

The upgrade flips `is_anonymous` to `false` and replaces the synthetic email/password hash with real ones. Foreign keys (carts, drafts) survive the upgrade.

HTTP routes:

| Method | Path              | Auth-gated                    |
| ------ | ----------------- | ----------------------------- |
| POST   | `/auth/anonymous` | No                            |
| POST   | `/auth/upgrade`   | Yes (must be a guest session) |

Disc shipped this ahead of upstream Gel ([gh/geldata#8750](https://github.com/geldata/gel/issues/8750), still open).

### OAuth Providers

The `ext-oauth` extension provides OAuth 2.0 + OIDC support for major providers (Google, GitHub, Apple, Microsoft, LinkedIn, Facebook, Twitter/X, Keycloak, Discord, Slack) plus a generic OIDC factory.

```typescript
import { createOAuthExtension, googleProvider } from "disc/ext-oauth/mod.ts";

const oauth = createOAuthExtension({
  providers: [
    googleProvider({
      clientId: Deno.env.get("GOOGLE_CLIENT_ID")!,
      clientSecret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
      redirectUri: "https://app.example.com/auth/oauth/callback",
    }),
  ],
  allowedRedirectUris: [
    "https://app.example.com/*",
    "https://*.app.example.com/*",
  ],
});
```

`OAuthUserInfo` extracts standard claims (`emailVerified`, `givenName`, `familyName`, `locale`) across all providers. The `email_verified` claim is parsed permissively — boolean and `"true"`/`"false"` string forms (Apple/SAML bridges) are both accepted; non-conforming inputs leave the field `undefined` (distinct from `false`). (`ext-oauth/providers.ts`, gh/geldata#7344)

PKCE parameters are handled per RFC 7636 — the trailing-`=` padding from S256 challenges is stripped before exchange (`ext-oauth/pkce.ts`, gh/geldata#7596). The `code_challenge` / `code_verifier` parameter names match the RFC names.

`redirectUri` is validated against the `allowedRedirectUris` allowlist on every authorize and callback. Wildcards support single-label subdomain matching: `https://*.example.com` matches `https://app.example.com` but not `https://app.sub.example.com`.

For a generic OIDC issuer, use `createOidcProvider`:

```typescript
import { createOidcProvider } from "disc/ext-oauth/discovery.ts";

const zitadel = await createOidcProvider({
  issuer: "https://example.zitadel.cloud",
  clientId: "...",
  clientSecret: "...",
  redirectUri: "https://app.example.com/auth/oauth/callback",
});
```

The async factory fetches `.well-known/openid-configuration` once at boot and constructs the provider from the discovered endpoints. Defaults scopes to `["openid", "email", "profile"]`; throws if the issuer omits `userinfo_endpoint` (Disc requires it for identity resolution). For deployments that already cache discovery results, `genericOidcProvider({...})` takes pre-resolved endpoints.

### Branding

Override the "from" identity used in built-in email templates and admin-UI copy without forking the templates:

```typescript
const config: AuthConfig = {
  jwtSecret: "...",
  branding: {
    appName: "Acme Cloud", // 1–80 chars, no CR/LF
    logoUrl: "https://acme.example.com/logo.png", // https only, ≤ 2048 chars
    darkLogoUrl: "https://acme.example.com/logo-dark.png",
    brandColor: "#0066ff", // hex or oklch()
  },
};
```

Validation rules (fail-loud at construction):

- `appName`: 1–80 chars, CR/LF/NUL/control chars rejected (header-splice prevention in email subjects).
- `logoUrl` / `darkLogoUrl`: `https://` only (or `http://` for localhost/loopback in dev). `data:`/`javascript:`/`file:` rejected outright. ≤ 2048 chars.
- `brandColor`: 3- or 6-digit hex (`#0af`, `#00aaff`) or CSS-L4 `oklch()` (`oklch(70% 0.15 200)`). HTML5 4-/8-digit alpha hex, named colors, comma-separated legacy `oklch()`, `rgb()` are refused.

Templates auto-interpolate `appName` into subject lines and body intros, render the optional logo, and tint CTAs with `brandColor`. Backward-compat fallback when no branding is set. (`auth/branding.ts`, gh/geldata#7938 + #6731 + #6732)

### Webhooks

Fire-and-forget HTTP callbacks for auth lifecycle events:

```typescript
const config: AuthConfig = {
  jwtSecret: "...",
  webhooks: [
    {
      url: "https://example.com/hooks/auth",
      events: ["UserCreated", "PasswordResetRequested", "MagicLinkRequested"],
      secret: "shared-hmac-secret", // HMAC-SHA256 of the body
    },
  ],
};
```

Events fire after the relevant DB write, via `queueMicrotask` + `fetch` — no retry, no back-pressure. When Disc grows a job queue, webhook delivery will be the natural first user (open question in the ledger).

Event types: `UserCreated`, `EmailVerified`, `PasswordChanged`, `PasswordResetRequested`, `MagicLinkRequested`, `SessionCreated`, `SessionRefreshedFromNewIp`. The signing secret is per-subscription, so multiple receivers can each verify independently. (`auth/webhooks.ts`, gh/geldata#7484)

> Webhooks differ from Gel's implementation — Gel uses `std::net::http::schedule_request` (a job queue with retry). Disc fires-and-forgets until a job queue lands.

### HTTP Auth Gate

`requireAuth: true` on the server config rejects all data-plane requests (`/query`, `/schema*`, `/migrations`, `/stats`, `/metrics`, `/ext/*`) without a valid `Authorization: Bearer <JWT>` header. Auth-flow routes (`/auth/*`) and health probes (`/health*`) remain public.

```typescript
const server = new DiscServer({
  jwtSecret: "...",
  enableAuth: true,
  requireAuth: true, // NEW: reject anonymous data-plane requests
});
```

Defaults to `false` for backward compatibility — existing deployments keep their permissive behavior unless they opt in. When enabled without an `authMiddleware`, requests are rejected with 503 to fail loud rather than silently bypass.

Responses:

- Missing token → `401` + `WWW-Authenticate: Bearer realm="disc"` (RFC 6750 §3).
- Invalid token → `401` with the standard error envelope.
- Misconfig (`requireAuth=true` but no middleware) → `503`.

Or set via `disc.toml`:

```toml
[server]
require_auth = true
```

(`server/types.ts` `requireAuth`, gh/geldata#6345)

### Roles & RBAC

Disc has a small role registry plus user→role assignments. Roles are named strings (`"admin"`, `"viewer"`, …) with optional descriptions. Permissions are encoded in [access policies](access-policies.md) via `has_role("admin")` and `current_role`, not stored per-role — your SDL is the authoritative permission spec.

Programmatic API:

```typescript
await provider.createRole("admin", "Full access");
await provider.createRole("viewer", "Read-only");

await provider.assignRole(userId, "admin");
await provider.revokeRole(userId, "admin");

const roles = await provider.getUserRoles(userId);
const isAdmin = await provider.userHasRole(userId, "admin");
const all = await provider.listRoles();
await provider.deleteRole("viewer"); // cascades to user_roles
```

CLI:

```bash
disc admin create-superuser ada@example.com --password '...'
disc admin set-password ada@example.com --password '...'
disc admin assign-role ada@example.com admin
disc admin list-roles
```

Roles are snapshot into the JWT at issue time as `TokenPayload.roles`; access policies see them on `AuthContext.roles`. Snapshot semantics — roles assigned after the token issued won't take effect until re-login. For near-real-time revocation, combine with `revokeAllSessions(userId)`. (`auth/provider.ts`, gh/geldata#8177)

### Captcha

Pluggable captcha gate (hCaptcha / Cloudflare Turnstile) for sensitive public auth endpoints:

```typescript
const config: AuthConfig = {
  jwtSecret: "...",
  captcha: {
    provider: "turnstile",
    secret: Deno.env.get("TURNSTILE_SECRET")!,
    requireOn: ["register", "magic-link"],
  },
};
```

When set, the corresponding `AuthRoutes` handlers require a `captchaToken` field on the request body and verify it against the provider before any DB work runs. When omitted, captcha is disabled entirely. (`auth/captcha.ts`, gh/geldata#7341 — Disc ships opt-in despite Gel `not_planned`)

### Resend Verification

Re-issue an email-verification token without registering a new account:

```typescript
const token = await provider.resendVerification("ada@example.com");
// token === null when the email is unknown or already verified — silent
// to avoid account-state enumeration. Email it out as you would the
// original verification token.
```

Each call overwrites the stored token hash, so the previous link returns `INVALID_TOKEN`. (gh/geldata#6503)

---

## Admin Password Management

Disc uses **bcrypt** for password hashing. There is no `DISC_SERVER_PASSWORD_HASH` environment variable — admin user creation and password rotation go through the `disc admin` CLI, which writes through `AuthProvider` so all the standard validations apply.

| Task                          | Command                                                 |
| ----------------------------- | ------------------------------------------------------- |
| Bootstrap the first superuser | `disc admin create-superuser <email> --password '<pw>'` |
| Rotate a user's password      | `disc admin set-password <email\|id> --password '<pw>'` |
| Promote an existing user      | `disc admin assign-role <email\|id> <role>`             |
| List defined roles            | `disc admin list-roles`                                 |

`set-password` does not require the old password (it's an admin override) and revokes all existing sessions for the affected user. CLI guards: empty `--password ''` is rejected before reaching the provider (gh/geldata#4209).

The password algorithm is `bcrypt` with `bcryptRounds` (default 12, configurable via `AuthConfig.bcryptRounds`). To verify a hash externally:

```bash
node -e "console.log(require('bcrypt').compareSync('plaintext', '$2b$12$...'))"
```

### Why no `DISC_PASSWORD_HASH` env var?

Disc deliberately doesn't accept a pre-hashed admin password via env (Gel offers `GEL_SERVER_PASSWORD_HASH`). The reasoning:

1. The admin user is a _role_, not a server-side trusted process. Storing it as a row in `users` keeps it consistent with every other identity — same revocation, same role assignment, same audit trail.
2. Bcrypt rounds are configurable per deployment. Pre-baking a hash into env locks the rounds at hash-creation time.
3. Bootstrapping is a one-time `disc admin create-superuser` invocation; subsequent password changes go through the same admin tool.

The CLI requires `DATABASE_URL` and `DISC_JWT_SECRET` (or `--database-url` / `--jwt-secret` flags) so the admin path runs the provider's validations rather than writing raw rows.

---

## Security Best Practices

**Use a strong JWT secret.** The secret must be at least 32 characters of high entropy. Generate one with:

```bash
openssl rand -base64 48
```

**Always use HTTPS in production.** JWTs are bearer tokens -- anyone who intercepts one can impersonate the user. Disc supports TLS directly:

```bash
disc serve --tls-cert cert.pem --tls-key key.pem
```

See [Production Deployment](production-deployment.md) for full TLS configuration.

**Rotate refresh tokens.** Disc implements automatic rotation -- each call to `/auth/refresh` invalidates the old refresh token and issues a new one. If a stolen refresh token is reused, the request fails immediately.

**Set appropriate token expiry.** Short-lived access tokens (15-60 minutes) limit the window of exposure. Refresh tokens can be longer-lived (hours to days) since they are single-use.

**Enable password requirements.** For production systems, enable uppercase, number, and special character requirements:

```typescript
{
  passwordMinLength: 12,
  passwordRequireNumbers: true,
  passwordRequireSpecial: true,
  passwordRequireUppercase: true
}
```

**Disable open registration when appropriate.** If your application manages user creation through an admin flow, set `allowRegistration: false` to prevent unauthorized account creation.

**Do not expose reset tokens in responses.** In production, the reset token should be delivered via email, not returned in the HTTP response. The current implementation returns success without exposing the token.

---

## Related

- [Access Policies](access-policies.md) -- row-level security powered by auth context
- [Server Configuration](server.md) -- full server config reference
- [Production Deployment](production-deployment.md) -- TLS, rate limiting, and hardening
