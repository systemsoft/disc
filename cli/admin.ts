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
import { SDLParser } from "../schema/parser.ts";

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
        opts.role ? `Custom role created via 'disc admin create-superuser --role ${roleName}'` : "Top-level admin role with all permissions",
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

  /**
   * `disc admin list-policies [type]` — pure SDL introspection.
   * Lists access policies on a single type, or every type when no
   * type is given. (gh/geldata#6432 — operators wanted REPL-level
   * tooling like Postgres `\dp`. Disc surfaces it as a CLI command
   * because the SDL file is the source of truth, not the live DB.)
   *
   * Output shape:
   *   <TypeName>:
   *     <policy-name> [allow|deny] for <action> ...
   *       when (<condition expression>)
   *       errmessage: "..."
   *
   * Reads `--schema <file>` (default `./dbschema/default.disc`).
   */
  async listPolicies(
    opts: { schema?: string; type?: string },
  ): Promise<void> {
    const schemaFile = opts.schema ?? "./dbschema/default.disc";
    const sdl = await Deno.readTextFile(schemaFile);

    const policiesByType = collectPoliciesFromSdl(sdl);

    const targetTypes = opts.type ? [opts.type].filter((t) => policiesByType.has(t)) : Array.from(policiesByType.keys()).sort();

    if (opts.type && !policiesByType.has(opts.type)) {
      console.log(`(no policies on type ${opts.type})`);
      return;
    }
    if (targetTypes.length === 0) {
      console.log("(no policies defined in schema)");
      return;
    }

    for (const typeName of targetTypes) {
      const policies = policiesByType.get(typeName)!;
      console.log(`${typeName}:`);
      for (const p of policies) {
        const verdict = p.action;
        const events = p.events.join(", ");
        console.log(`  ${p.name} [${verdict}] for ${events}`);
        if (p.condition) {
          console.log(`    when (${p.condition})`);
        }
        if (p.errmessage) {
          console.log(`    errmessage: ${JSON.stringify(p.errmessage)}`);
        }
      }
    }
  }
}

interface ListedPolicy {
  name: string;
  action: "allow" | "deny";
  events: string[];
  condition?: string;
  errmessage?: string;
}

/**
 * Read access policies straight from SDL source. Pure function,
 * exported for testing — keeps `disc admin list-policies` independent
 * of the live database. (gh/geldata#6432)
 */
export function collectPoliciesFromSdl(
  sdl: string,
): Map<string, ListedPolicy[]> {
  const out = new Map<string, ListedPolicy[]>();
  const ast = new SDLParser(sdl).parse();

  for (const decl of ast.declarations) {
    if (decl.kind === "ModuleDeclaration") {
      collectFromTypeDecls(decl.declarations, out);
    } else {
      collectFromTypeDecls([decl], out);
    }
  }
  return out;
}

function collectFromTypeDecls(
  decls: ReadonlyArray<{ kind: string }>,
  out: Map<string, ListedPolicy[]>,
): void {
  for (const d of decls) {
    if (d.kind !== "TypeDeclaration") continue;
    const td = d as unknown as {
      name: { value: string };
      members?: Array<{ kind: string; [key: string]: unknown }>;
    };
    const policies: ListedPolicy[] = [];
    for (const m of td.members ?? []) {
      if (m.kind !== "AccessPolicy") continue;
      // AccessPolicy carries `actions: AccessAction[]` where each
      // action has `allow: boolean` + `operations: AccessOperation[]`.
      // Flatten to one ListedPolicy per AccessAction so the listing
      // surfaces both the verdict and the events.
      const actions = (m.actions as Array<{ allow: boolean; operations: string[] }>) ?? [];
      for (const action of actions) {
        policies.push({
          name: (m.name as { value: string }).value,
          action: action.allow ? "allow" : "deny",
          events: action.operations.slice(),
          condition: m.condition ? stringifyExpr(m.condition as Record<string, unknown>) : undefined,
          errmessage: m.errmessage as string | undefined,
        });
      }
    }
    if (policies.length > 0) {
      out.set(td.name.value, policies);
    }
  }
}

function stringifyExpr(expr: Record<string, unknown>): string {
  // Best-effort textualization of the AST node — enough for human
  // inspection at the CLI. Not a full SDL re-serialization.
  if (expr.kind === "Literal") return String(expr.value);
  if (expr.kind === "PathExpression") {
    return ((expr.path as string[]) ?? []).join(".");
  }
  if (expr.kind === "FunctionCall") {
    const nameParts = ((expr.name as { parts?: string[] } | undefined)?.parts) ?? [];
    return `${nameParts.join("::")}(...)`;
  }
  if (expr.kind === "BinaryOp") {
    const op = expr.op as string;
    const left = stringifyExpr(expr.left as Record<string, unknown>);
    const right = stringifyExpr(expr.right as Record<string, unknown>);
    return `${left} ${op} ${right}`;
  }
  return `<${String(expr.kind)}>`;
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
