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
├── database-interface.ts    # Database abstraction
├── integration.ts           # Server integration and route handlers
├── middleware.ts            # HTTP middleware for Express-style apps
├── mod.ts                   # Module exports
├── provider.ts              # Core authentication provider
├── README.md                # This file
├── test-database.ts         # In-memory test database
└── types.ts                 # TypeScript interfaces and types
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
  token_expiry: 3600 // 1 hour
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
  if (context)
    return new Response(`Hello ${context.email}`);

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
  allow_registration?: boolean;          // Optional: Allow new registrations (default: true)
  bcrypt_rounds?: number;                // Optional: bcrypt rounds (default: 12)
  jwt_audience?: string;                 // Optional: JWT audience
  jwt_issuer?: string;                   // Optional: JWT issuer
  jwt_secret: string;                    // Required: JWT signing secret
  password_min_length?: number;          // Optional: Min password length (default: 8)
  password_require_numbers?: boolean;    // Optional: Require numbers
  password_require_special?: boolean;    // Optional: Require special characters
  password_require_uppercase?: boolean;  // Optional: Require uppercase letters
  refresh_token_expiry?: number;         // Optional: Refresh token expiry (default: 604800)
  require_email_verification?: boolean;  // Optional: Require email verification (default: false)
  session_timeout?: number;              // Optional: Session timeout (default: 3600)
  token_expiry?: number;                 // Optional: Token expiry in seconds (default: 3600)
}
```

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
  USER_NOT_FOUND = "USER_NOT_FOUND"
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
