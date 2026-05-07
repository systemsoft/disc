// deno-lint-ignore-file no-console
/**
 * `disc admin` — out-of-band user/role management.
 *
 * Closes the loop on the RBAC system shipped in commit df92455 by
 * exposing role/user management through the CLI rather than only the
 * `AuthProvider` API. Useful for bootstrapping the first superuser on
 * a fresh deployment, rotating an admin's password without going
 * through the password-reset flow, or promoting a user to a new role.
 *
 * Issues addressed:
 *   - #1129 explicit superuser creation
 *   - #5383 / #6454 / #1119 admin password operations via CLI
 *   - #4209 fail cleanly on empty password (no ISE)
 */

import { AuthProvider } from "../auth/provider.ts";
import { PgDatabaseAdapter } from "../auth/pg-database-adapter.ts";
import { AuthError } from "../auth/types.ts";
import { DatabaseConnection } from "../lib/database.ts";

interface BaseOptions {
  "database-url"?: string;
  "jwt-secret"?: string;
}

interface CreateSuperuserOptions extends BaseOptions {
  email: string;
  password: string;
  name?: string;
  role?: string;
}

interface SetPasswordOptions extends BaseOptions {
  user: string;
  password: string;
}

interface AssignRoleOptions extends BaseOptions {
  user: string;
  role: string;
  description?: string;
}

const DEFAULT_SUPERUSER_ROLE = "superuser";

class AdminCommand {
  /**
   * `disc admin create-superuser <email> --password <pw>`
   *
   * Creates a user (via `register()` so all the regular validations
   * apply), ensures the superuser role exists, then assigns it.
   */
  async createSuperuser(opts: CreateSuperuserOptions): Promise<void> {
    if (rejectEmptyPassword(opts.password)) return;

    const ctx = await openAuth(opts);
    if (!ctx) return;
    try {
      const roleName = opts.role ?? DEFAULT_SUPERUSER_ROLE;
      const result = await ctx.provider.register({
        email: opts.email,
        password: opts.password,
        username: opts.name ?? opts.email.split("@")[0],
      });
      const userId = result.user.id;

      // createRole is idempotent — duplicate name updates the description.
      await ctx.provider.createRole(
        roleName,
        opts.role
          ? `Custom role created via 'disc admin create-superuser --role ${roleName}'`
          : "Top-level admin role with all permissions",
      );
      await ctx.provider.assignRole(userId, roleName);

      console.log(`✅ Created superuser ${opts.email} with role '${roleName}'`);
    } catch (err) {
      reportError(err);
    } finally {
      await ctx.close();
    }
  }

  /**
   * `disc admin set-password <user> --password <pw>`
   *
   * Resets the password without requiring the old one. Existing
   * sessions are revoked so the new password is the only credential.
   */
  async setPassword(opts: SetPasswordOptions): Promise<void> {
    if (rejectEmptyPassword(opts.password)) return;

    const ctx = await openAuth(opts);
    if (!ctx) return;
    try {
      await ctx.provider.adminSetPassword(opts.user, opts.password);
      console.log(`✅ Password rotated for ${opts.user}`);
    } catch (err) {
      reportError(err);
    } finally {
      await ctx.close();
    }
  }

  /**
   * `disc admin assign-role <user> <role>`
   *
   * Assigns a named role to an existing user. Auto-creates the role
   * if it doesn't exist (the role registry is permission-free, so
   * creating one without permissions encoded is fine — permissions
   * are encoded in SDL access policies, not on the role row).
   */
  async assignRole(opts: AssignRoleOptions): Promise<void> {
    const ctx = await openAuth(opts);
    if (!ctx) return;
    try {
      const userId = await ctx.provider.resolveUserId(opts.user);
      if (!userId) {
        console.error(`❌ User not found: ${opts.user}`);
        return;
      }
      await ctx.provider.createRole(opts.role, opts.description);
      await ctx.provider.assignRole(userId, opts.role);
      console.log(`✅ Assigned role '${opts.role}' to ${opts.user}`);
    } catch (err) {
      reportError(err);
    } finally {
      await ctx.close();
    }
  }

  /**
   * `disc admin list-roles` — name + description for every role.
   */
  async listRoles(opts: BaseOptions): Promise<void> {
    const ctx = await openAuth(opts);
    if (!ctx) return;
    try {
      const roles = await ctx.provider.listRoles();
      if (roles.length === 0) {
        console.log("(no roles defined)");
        return;
      }
      for (const r of roles) {
        const desc = r.description ? ` — ${r.description}` : "";
        console.log(`${r.name}${desc}`);
      }
    } catch (err) {
      reportError(err);
    } finally {
      await ctx.close();
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface AuthCtx {
  provider: AuthProvider;
  close(): Promise<void>;
}

async function openAuth(opts: BaseOptions): Promise<AuthCtx | null> {
  const dsn = opts["database-url"] ?? Deno.env.get("DATABASE_URL");
  if (!dsn) {
    console.error("❌ --database-url is required (or set DATABASE_URL env var)");
    return null;
  }
  const jwtSecret = opts["jwt-secret"] ??
    Deno.env.get("DISC_JWT_SECRET") ??
    Deno.env.get("JWT_SECRET");
  if (!jwtSecret || jwtSecret.length < 32) {
    console.error(
      "❌ --jwt-secret is required (or set DISC_JWT_SECRET / JWT_SECRET); must be ≥32 bytes",
    );
    return null;
  }

  const db = new DatabaseConnection(dsn);
  await db.connect();
  const adapter = new PgDatabaseAdapter(db);
  const provider = new AuthProvider({ jwtSecret }, adapter);
  await provider.initialize();

  return {
    provider,
    close: async () => {
      await db.close();
    },
  };
}

function rejectEmptyPassword(pw: string): boolean {
  // CLI-level guard so an empty `--password ''` doesn't reach the
  // provider as a 0-length string and trip an opaque error in
  // bcrypt or downstream layers. (gh/geldata#4209)
  if (!pw || pw.length === 0) {
    console.error("❌ --password must not be empty");
    return true;
  }
  return false;
}

function reportError(err: unknown): void {
  if (err instanceof AuthError) {
    console.error(`❌ ${err.message}`);
    return;
  }
  if (err instanceof Error) {
    console.error(`❌ ${err.message}`);
    return;
  }
  console.error(`❌ ${String(err)}`);
}

export const adminCommand = new AdminCommand();
