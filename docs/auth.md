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
  jwtSecret: string;                  // No default -- must be provided

  // Token settings
  jwtAudience?: string;               // Default: "disc-api"
  jwtIssuer?: string;                 // Default: "disc"
  refreshTokenExpiry?: number;        // Default: 604800 (7 days, in seconds)
  tokenExpiry?: number;               // Default: 3600 (1 hour, in seconds)

  // Session settings
  sessionTimeout?: number;            // Default: 3600 (1 hour, in seconds)

  // Registration settings
  allowRegistration?: boolean;        // Default: true
  requireEmailVerification?: boolean; // Default: false

  // Password policy
  bcryptRounds?: number;              // Default: 12
  passwordMinLength?: number;         // Default: 8
  passwordRequireNumbers?: boolean;   // Default: false
  passwordRequireSpecial?: boolean;   // Default: false
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
    tokenExpiry: 1800         // 30 minutes
  },
  enableAuth: true,
  jwtSecret: "your-secret-key"
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
