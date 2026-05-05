# Authentication Module

The auth module provides comprehensive authentication and authorization capabilities for Disc, including user management, session handling, JWT token management, and HTTP middleware.

## Features

### Core Authentication

- User registration and login
- Password hashing with bcrypt
- JWT token generation and verification
- Session management
- Email verification flow
- Password reset functionality

### Security

- Configurable password complexity requirements
- Session timeout and revocation
- Token expiration and refresh
- CORS support with configurable origins
- Security headers middleware

### Integration

- HTTP middleware for route protection
- Database abstraction for flexible storage
- Type-safe interfaces throughout
- Comprehensive error handling

## Architecture

```
auth/
├── basic.test.ts              # Basic auth unit tests
├── database-interface.ts      # Database abstraction
├── integration.ts             # Server integration and route handlers
├── middleware.test.ts          # Middleware unit tests
├── middleware.ts              # HTTP middleware for Express-style apps
├── mod.ts                     # Module exports
├── pg-database-adapter.test.ts # PG adapter unit tests (13 tests)
├── pg-database-adapter.ts     # PostgreSQL adapter (? → $1,$2 placeholder bridging)
├── pg-integration.test.ts     # PG integration tests (7 tests, requires DISC_PG_AUTO=1)
├── provider.test.ts           # Provider unit tests
├── provider.ts                # Core authentication provider
├── README.md                  # This file
├── test-database.ts           # In-memory test database
└── types.ts                   # TypeScript interfaces and types
```

## Usage

### Basic Setup

```typescript
import { AuthMiddleware, AuthProvider, initializeAuth } from "./auth/mod.ts";
import { DatabaseConnection } from "../lib/database.ts";

// Initialize auth system
const db = new DatabaseConnection("postgresql://...");

const config = {
  allow_registration: true,
  bcrypt_rounds: 12,
  jwt_secret: "your-secret-key",
  password_min_length: 8,
  token_expiry: 3600, // 1 hour
};

const auth = await initializeAuth(config, db);
```

### Route Protection

```typescript
// Protect routes requiring authentication
const protectedRoute = auth.middleware.requireAuth(async (req, context) => {
  // context.user_id available here
  return new Response(`Hello user ${context.user_id}`);
});

// Optional authentication
const publicRoute = auth.middleware.optionalAuth(async (req, context) => {
  if (context) {
    return new Response(`Hello ${context.email}`);
  }

  return new Response("Hello anonymous user");
});
```

### Authentication Routes

```typescript
// Built-in auth routes
const routes = {
  "/auth/login": auth.routes.login(),
  "/auth/logout": auth.routes.logout(),
  "/auth/password": auth.routes.updatePassword(),
  "/auth/profile": auth.routes.profile(),
  "/auth/refresh": auth.routes.refresh(),
  "/auth/register": auth.routes.register(),
  "/auth/reset": auth.routes.resetPasswordRequest(),
  "/auth/reset/confirm": auth.routes.resetPassword(),
  "/auth/verify": auth.routes.verifyEmail(),
};
```

## Configuration

### AuthConfig Interface

```typescript
interface AuthConfig {
  allow_registration?: boolean; // Optional: Allow new registrations (default: true)
  bcrypt_rounds?: number; // Optional: bcrypt rounds (default: 12)
  jwt_algorithm?: "HS256" | "RS256"; // Optional: signing algorithm (default: "HS256")
  jwt_audience?: string; // Optional: JWT audience
  jwt_issuer?: string; // Optional: JWT issuer
  jwt_secret?: string; // Required under HS256: JWT signing secret (≥ 32 bytes)
  jwt_private_key?: string; // Required under RS256: PEM-encoded PKCS#8 RSA private key
  jwt_public_key?: string; // Required under RS256: PEM-encoded SPKI RSA public key
  password_min_length?: number; // Optional: Min password length (default: 8)
  password_require_numbers?: boolean; // Optional: Require numbers
  password_require_special?: boolean; // Optional: Require special characters
  password_require_uppercase?: boolean; // Optional: Require uppercase letters
  refresh_token_expiry?: number; // Optional: Refresh token expiry (default: 604800)
  require_email_verification?: boolean; // Optional: Require email verification (default: false)
  session_timeout?: number; // Optional: Session timeout (default: 3600)
  token_expiry?: number; // Optional: Token expiry in seconds (default: 3600)
}
```

### Password reset + email verification (gh/geldata#6502)

When `require_email_verification: true` is set, password resets are
**refused for unverified accounts**. The endpoint returns the same
empty-string sentinel as for an unknown email — callers can't
distinguish verified-vs-unverified accounts from the response — and
audits the block as `unverified_account_blocked`.

Why: an unverified account by definition belongs to whoever owns the
email used at registration. If a user typo'd their address (e.g.
`alice@gmial.com`) and someone owns the typo, that someone could
otherwise complete the reset and seize the account. Reset is only
useful once email control has been demonstrated via verification.

When `require_email_verification: false`, the reset flow is open to
all accounts (no behavior change from prior versions).

### Disabling new sign-ups (gh/geldata#7482)

Set `allow_registration: false` to refuse all new account creation
while leaving every other auth path intact. Existing users keep
logging in, refreshing tokens, resetting passwords, and changing
their own passwords; only `POST /auth/register` (and direct
`provider.register()` calls) reject with `REGISTRATION_DISABLED` /
HTTP 403.

Typical use cases:

- **Closed beta / invite-only**: ship the server with `false`, create
  initial accounts via direct DB seeding or a one-shot admin tool.
- **Maintenance freeze**: flip to `false` during incident response or
  data migrations to prevent new accounts entering an inconsistent
  state.

Note: this gate only covers the password-registration path. OAuth
sign-in via `ext-oauth` does not currently create user records (the
callback is a stub awaiting integration); when that wiring lands it
will need its own per-provider opt-out at the OAuth-config layer.

### JWT signing algorithms (P3-04)

The provider supports two algorithms:

- **HS256** (default) — symmetric HMAC over a shared secret. Simplest
  to operate; every component that mints OR verifies tokens must hold
  the secret. Set `jwt_secret` to a string of at least 32 bytes.

- **RS256** — RSA signature with separate keys. Mint with the private
  key, verify with the public key. Use this when downstream services
  need to verify Disc-issued tokens without the ability to forge new
  ones. Set `jwt_algorithm: "RS256"` and provide both PEM-encoded
  keys:

  ```
  -----BEGIN PRIVATE KEY-----   ← PKCS#8 (jwt_private_key)
  ...
  -----END PRIVATE KEY-----

  -----BEGIN PUBLIC KEY-----    ← SPKI (jwt_public_key)
  ...
  -----END PUBLIC KEY-----
  ```

  Generate a fresh pair (RFC 7518 §3.3 mandates ≥ 2048-bit modulus):

  ```bash
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 \
    -out jwt-private.pem
  openssl pkey -in jwt-private.pem -pubout -out jwt-public.pem
  ```

#### Key rotation

Tokens carry their session ID; sessions carry a server-side `revoked`
flag that `verifyToken()` checks on every request. To rotate either
algorithm's keys:

1. Stand up a parallel server with the new key/secret.
2. Migrate traffic. New tokens are signed with the new key.
3. Revoke outstanding sessions: `UPDATE sessions SET revoked = TRUE`.
   Existing tokens fail at the session-check step regardless of
   their signature, so old keys can be retired immediately.

For RS256 specifically, you can also distribute a new public key to
verifiers ahead of switching the signing private key — verifiers
holding both old and new public keys keeps a smooth window. Disc
itself only holds one public key at a time today.

### WebAuthn / passkeys (gh/geldata#6725)

Hardware-backed passwordless login using the W3C WebAuthn standard.
Compatible with Apple/Google passkeys, YubiKeys, Windows Hello, etc.

**Scope this iteration:** ES256 only (covers all browser-native
passkeys + most YubiKey configurations). Attestation formats `"none"`
and `"packed"` accepted; the others (Apple, Android-key, TPM,
fido-u2f) are out of scope until someone needs to enforce specific
authenticator brands. RS256 / EdDSA likewise deferred — they're rare
in the browser-passkey ecosystem.

**Configuration:**

```ts
const provider = new AuthProvider({
  jwtSecret: "...",
  webauthn: {
    rpId: "example.com",        // apex domain credentials are scoped to
    rpName: "Example App",       // shown in browser prompts
    origin: "https://example.com" // expected clientData.origin
  },
}, db);
```

Without the `webauthn` block, all WebAuthn provider methods throw
`AuthError(INVALID_OPERATION)` — so apps that don't want passkeys
just leave it off.

**Registration ceremony:**

```ts
// 1. Authenticated user starts registration. Server mints a challenge.
const opts = await provider.beginWebAuthnRegistration(userId);
// Send `opts.publicKey` to the browser; the SDK calls
// navigator.credentials.create({ publicKey: opts.publicKey }).

// 2. Browser returns a PublicKeyCredential. Caller assembles:
await provider.finishWebAuthnRegistration({
  challengeId: opts.challengeId,
  credentialId: cred.id,                                    // base64url
  attestationObject: base64url(cred.response.attestationObject),
  clientDataJSON: base64url(cred.response.clientDataJSON),
  name: "My iPhone",                                         // optional
});
```

**Login ceremony:**

```ts
// 1. Server mints a challenge, optionally scoped by email.
const opts = await provider.beginWebAuthnLogin("u@example.com");
// 2. Browser signs with the authenticator. Caller assembles:
const result = await provider.finishWebAuthnLogin({
  challengeId: opts.challengeId,
  credentialId: cred.id,
  authenticatorData: base64url(cred.response.authenticatorData),
  clientDataJSON: base64url(cred.response.clientDataJSON),
  signature: base64url(cred.response.signature),
});
if ("mfaRequired" in result) {
  // User has TOTP enrolled — passkey + TOTP combine.
  await provider.loginWithTOTP(result.challengeToken, code);
}
```

**HTTP routes** (login routes public + rate-limited; rest auth-gated):

| Method | Path                                  | Body                     |
|--------|---------------------------------------|--------------------------|
| POST   | `/auth/webauthn/register/begin`       | (none)                   |
| POST   | `/auth/webauthn/register/finish`      | `WebAuthnRegistrationFinish` |
| POST   | `/auth/webauthn/login/begin`          | `{ "email"?: "..." }`    |
| POST   | `/auth/webauthn/login/finish`         | `WebAuthnLoginFinish`    |
| GET    | `/auth/webauthn/credentials`          | (none)                   |
| POST   | `/auth/webauthn/credentials/delete`   | `{ "credentialId": "..." }` |

**Security notes:**
- Challenges are stored server-side (keyed by `challengeId`), 5-min
  TTL, single-use. Burned on every error path that read them — no
  replay even mid-failure.
- Counter monotonicity is enforced on every login. A counter that
  *decreased* triggers `INVALID_TOKEN` and a `webauthn_counter_regression`
  audit event — that's how WebAuthn detects cloned credentials. Counter
  of 0 (some authenticators don't implement counters) is allowed but
  never bumps stored state.
- `clientData.origin` and `authenticatorData.rpIdHash` are checked
  against the configured `webauthn.{origin, rpId}` — credentials minted
  for one domain can't authenticate against another.
- credentialId from the client must match the one inside
  `attestationObject.authData` — defends against the client lying about
  which key was used.

### Recovery codes (gh/geldata#8186)

One-time-use codes the user saves at MFA setup, used to bypass TOTP
when they lose their authenticator device. Format: `XXXXX-XXXXX`
(10 chars from a 30-char Crockford-ish alphabet that drops visually
ambiguous letters like 0/O, 1/I/L). 8 codes per batch by default.

```ts
// Generate (or regenerate). Show the plaintext to the user ONCE —
// stored hashed, never recoverable. Calling this again invalidates
// every previous code.
const codes = await provider.generateRecoveryCodes(userId);
// codes = ["X7K3M-Q2NPR", "F8GHC-VWXYJ", ...]

// Burn one outside the login flow (e.g. step-up auth):
const ok = await provider.consumeRecoveryCode(userId, "X7K3M-Q2NPR");

// How many are left?
const left = await provider.recoveryCodesRemaining(userId);

// In the login flow, when MFA is required:
const challenge = await provider.login({ email, password });
if ("mfaRequired" in challenge) {
  // User can use a TOTP code OR a recovery code.
  const auth = await provider.loginWithRecoveryCode(
    challenge.challengeToken,
    "X7K3M-Q2NPR",
  );
}
```

**HTTP routes:**

| Method | Path                                | Body                                         |
|--------|-------------------------------------|----------------------------------------------|
| POST   | `/auth/mfa/recovery-codes/generate` | `{ "count"?: 8 }` (auth-gated)              |
| POST   | `/auth/mfa/recovery-codes/login`    | `{ "challengeToken": "...", "code": "..." }` |

**Design notes:**
- Codes are stored SHA-256 hashed (the same scheme reset/verify tokens
  use — full-length high-entropy inputs don't need bcrypt's slow hash).
- Input normalization strips dashes/spaces and uppercases, so users can
  type `xxxxx xxxxx`, `XXXXXXXXXX`, or `XXXXX-XXXXX` — all match.
- A code's hash is also keyed by `user_id` at lookup time, so a code
  leaked from one user can't be replayed against another.
- Burning a code via `loginWithRecoveryCode` also burns the MFA
  challenge — single-use both ways.
- `generateRecoveryCodes` always wipes the previous batch first; this
  matches the standard "regenerate codes" UX.

### Magic-link login (gh/geldata#8186)

Passwordless login via email. The user types their email; the server
mints a single-use token, hashes it, and returns the plaintext for
the caller to email out (or relay via the `MagicLinkRequested`
webhook). When the user clicks the link, the redeem step mints a
session — or returns an `MfaChallenge` if the user has TOTP enrolled.

```ts
// Step 1: user types email.
const token = await provider.requestMagicLink("u@example.com");
// Send the link `https://app.example.com/magic?token=${token}` via email.

// Step 2: user clicks the link, the app calls:
const result = await provider.consumeMagicLink(token);
if ("mfaRequired" in result) {
  // User has TOTP — redeem the challenge with `loginWithTOTP`.
} else {
  // Full session.
}
```

**HTTP routes** (both public, both rate-limited the same as login):

| Method | Path                        | Body                  |
|--------|-----------------------------|-----------------------|
| POST   | `/auth/magic-link/request`  | `{ "email": "..." }`  |
| POST   | `/auth/magic-link/consume`  | `{ "token": "..." }`  |

**Anti-enumeration:** `requestMagicLink` always returns a plaintext
token, even when no user matches the email — the token just isn't
persisted, so it can't be redeemed. Same response shape, same timing.
Same rationale as P1-35's generic-error login handling.

**Single-use + TTL:** tokens are stored hashed (parallel to reset /
verify / MFA-challenge tokens), expire in 15 minutes, and `consumed_at`
is set on the first redeem — even when the redeem returns an MFA
challenge instead of a session, so the link itself can't be replayed
mid-MFA.

**Webhooks:** the `MagicLinkRequested` event carries the plaintext
token and is the production-recommended delivery path. Consume it from
your email service rather than the HTTP response body.

### TOTP MFA (gh/geldata#8186)

Two-factor authentication via RFC 6238 TOTP. Compatible with Google
Authenticator, 1Password, Authy, etc. Defaults to SHA-1 / 30-second
step / 6-digit codes — what every authenticator app expects.

**Enrollment** is a two-step ceremony to make sure the user actually
captured the secret before we start gating their logins on it:

```ts
// Step 1: caller is logged in. Mint a fresh secret + QR-friendly URI.
const { secret, otpauthUri } = await provider.enrollTOTP(userId);
// Render `otpauthUri` as a QR code so the user scans it into their app.

// Step 2: user types the 6-digit code their app shows.
await provider.confirmTOTP(userId, "123456");
// Now mfa_totp.confirmed_at is set. Future logins gate on the code.
```

**Login flow** with MFA:

```ts
const result = await provider.login({ email, password });
if ("mfaRequired" in result) {
  // Password was right, but TOTP is required. `result.challengeToken`
  // is single-use, expires in 5 min. Prompt for the 6-digit code.
  const auth = await provider.loginWithTOTP(result.challengeToken, code);
} else {
  // No MFA enrolled — `result` is a normal AuthResponse.
}
```

**HTTP routes** (auth-gated except `/auth/mfa/totp/login`):

| Method | Path                       | Body                                |
|--------|----------------------------|-------------------------------------|
| POST   | `/auth/mfa/totp/enroll`    | (none)                              |
| POST   | `/auth/mfa/totp/confirm`   | `{ "code": "123456" }`              |
| POST   | `/auth/mfa/totp/disable`   | (none)                              |
| POST   | `/auth/mfa/totp/login`     | `{ "challengeToken": "...", "code": "123456" }` |

**Design notes:**
- Pending enrollments (no `confirmed_at`) do NOT gate login — protects
  users from locking themselves out if they close the QR before scanning.
- Re-enrolling rotates the secret; the previous QR becomes invalid.
- Challenge tokens are stored hashed (parallel to reset/verify tokens).
- The verify window is ±1 step (clock-drift tolerance per RFC 6238 §6).
- Constant-time string compare in `auth/totp.ts:verifyTOTP` to close
  timing side-channels per code slot.
- A consumed challenge cannot be replayed even before its expiry.

### Roles & RBAC (gh/geldata#8177)

Disc has a small role registry plus user→role assignments. Roles are
named strings (`"admin"`, `"viewer"`, …) with optional descriptions;
permissions are encoded in access policies via `has_role("admin")`
and `current_role`, not stored per-role. This keeps the runtime model
single-source — your SDL is the authoritative permission spec.

**Programmatic API:**

```ts
await provider.createRole("admin", "Full access");
await provider.createRole("viewer", "Read-only");

await provider.assignRole(userId, "admin");
await provider.revokeRole(userId, "admin");

const roles = await provider.getUserRoles(userId);   // string[]
const isAdmin = await provider.userHasRole(userId, "admin");
const all = await provider.listRoles();
await provider.deleteRole("viewer");                  // cascades to user_roles
```

`assignRole` is idempotent (granting a role twice is a no-op) and
throws `AuthError(USER_NOT_FOUND)` / `AuthError(INVALID_OPERATION)`
when the user or role doesn't exist. `revokeRole` is a no-op when the
user didn't hold the role — the post-condition is "user does not have
role X" regardless of starting state.

**JWT plumbing:**

`generateJWT` reads the user's roles at login time and includes them
as the `roles` claim. `verifyToken` returns them on `TokenPayload.roles`,
the auth middleware surfaces them on `AuthContext.roles`, and the
server's query handler populates `Types.AuthContext.roles` from there.
The access bridge maps `auth.roles[0]` → `userRole`, which the access
evaluator and SQL injector both use for `has_role()` / `current_role`.

**Snapshot semantics**: a token carries the roles that were active when
it was *issued*. Roles assigned (or revoked) afterwards do not take
effect on existing tokens — the user re-logs to pick up the change.
This is intentional: it keeps tokens self-contained (no DB lookup per
request to refresh role state) and matches how the compilation-cache
key (P1-13) was designed (role-driven, not user-driven). For
near-real-time revocation, combine with `revokeAllSessions(userId)`.

## API Endpoints

### POST /auth/register

Register a new user account.

**Request:**

```json
{
  "email": "user@example.com",
  "metadata": {},
  "password": "securepassword",
  "username": "optional_username"
}
```

**Response:**

```json
{
  "refresh_token": "refresh_token",
  "session": { "id": "...", "token": "...", ... },
  "token": "jwt_token",
  "user": { "email": "...", "id": "...",  ... }
}
```

### POST /auth/login

Authenticate user with email/username and password.

**Request:**

```json
{
  "email": "user@example.com",
  "password": "securepassword"
}
```

**Response:** Same as register

### POST /auth/logout

Logout and invalidate session (requires authentication).

### POST /auth/refresh

Refresh expired token using refresh token.

**Request:**

```json
{
  "refresh_token": "refresh_token_here"
}
```

### GET /auth/profile

Get current user profile (requires authentication).

### PUT /auth/password

Update user password (requires authentication).

**Request:**

```json
{
  "new_password": "new_secure_password",
  "old_password": "current_password"
}
```

### POST /auth/reset

Request password reset (sends reset token).

**Request:**

```json
{
  "email": "user@example.com"
}
```

### POST /auth/reset/confirm

Complete password reset with token.

**Request:**

```json
{
  "new_password": "new_secure_password",
  "reset_token": "token_from_email"
}
```

### GET /auth/verify?token=...

Verify email address with verification token.

## Error Handling

The auth module uses structured error codes:

```typescript
enum AuthErrorCode {
  EMAIL_NOT_VERIFIED = "EMAIL_NOT_VERIFIED",
  INVALID_CREDENTIALS = "INVALID_CREDENTIALS",
  INVALID_REFRESH_TOKEN = "INVALID_REFRESH_TOKEN",
  INVALID_TOKEN = "INVALID_TOKEN",
  PASSWORD_TOO_WEAK = "PASSWORD_TOO_WEAK",
  REGISTRATION_DISABLED = "REGISTRATION_DISABLED",
  SESSION_EXPIRED = "SESSION_EXPIRED",
  TOKEN_EXPIRED = "TOKEN_EXPIRED",
  USER_ALREADY_EXISTS = "USER_ALREADY_EXISTS",
  USER_INACTIVE = "USER_INACTIVE",
  USER_NOT_FOUND = "USER_NOT_FOUND",
}
```

Errors are returned as JSON:

```json
{
  "code": "ERROR_CODE_CONSTANT",
  "error": "Human readable message"
}
```

## Security Considerations

1. **JWT Secret**: Use a strong, random secret key (32+ characters)
2. **Password Storage**: Passwords are hashed with bcrypt
3. **Session Management**: Sessions can be revoked and have timeouts
4. **Token Refresh**: Refresh tokens enable secure token rotation
5. **Email Verification**: Optional email verification flow
6. **CORS**: Configurable CORS policies for web applications
7. **Security Headers**: Automatic security headers on responses

## Database Schema

The auth module creates two tables:

### users

- `active` (BOOLEAN)
- `created_at`, `updated_at` (TIMESTAMP)
- `email` (TEXT UNIQUE NOT NULL)
- `email_verified` (BOOLEAN)
- `id` (TEXT PRIMARY KEY)
- `metadata` (TEXT/JSON)
- `password_hash` (TEXT NOT NULL)
- `reset_token_expires` (TIMESTAMP)
- `username` (TEXT UNIQUE)
- `verification_token`, `reset_token` (TEXT)

### sessions

- `created_at`, `expires_at` (TIMESTAMP)
- `id` (TEXT PRIMARY KEY)
- `ip_address`, `user_agent` (TEXT)
- `last_activity` (TIMESTAMP)
- `refresh_token` (TEXT UNIQUE)
- `revoked` (BOOLEAN)
- `token` (TEXT UNIQUE)
- `user_id` (TEXT, FOREIGN KEY)

## Integration with Disc Server

The auth module integrates seamlessly with the Disc server:

1. **HTTP Routes**: Pre-built route handlers for all auth operations
2. **Middleware**: Pluggable authentication middleware for any endpoint
3. **Database**: Uses the same database connection as the rest of Disc
4. **Type Safety**: Full TypeScript integration with Disc's type system

This provides a complete, production-ready authentication system for the Disc database server.
