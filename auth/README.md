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
