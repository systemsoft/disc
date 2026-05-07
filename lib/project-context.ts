/**
 * Project context resolution for Disc CLI commands.
 *
 * Provides "which project am I in, how do I connect?" by locating disc.toml
 * and deriving all connection parameters from it.
 */

import { dirname, join } from "@std/path";

/**
 * Subset of `ServerConfig` keys (in `server/types.ts`) that can be set from
 * `disc.toml`'s `[server]` section. Applied as overrides on top of the
 * env-derived ServerConfig in `commands.ts:serve()` (CLI flags still win).
 *
 * Keep this list a curated subset rather than the entire ServerConfig
 * surface — TOML is for project-level defaults, not every tunable. Items
 * like `jwtSecret`, TLS paths, and bcrypt rounds remain env/CLI-only on
 * purpose (secrets shouldn't live in a tracked file). (gh/geldata#1325)
 */
export interface ServerOverrides {
  corsAllowCredentials?: boolean;
  corsOrigins?: string[];
  enableCors?: boolean;
  enableDataWatch?: boolean;
  enableMetrics?: boolean;
  enableRest?: boolean;
  enableWebsockets?: boolean;
  maxRequestBodyBytes?: number;
  rateLimitRpm?: number;
  readOnly?: boolean;
  requestTimeout?: number;
  requireAuth?: boolean;
  trustProxy?: boolean;
}

export interface ProjectContext {
  backendDsn?: string;
  dataDir: string;
  instanceName: string;
  managed: boolean;
  projectName: string;
  projectRoot: string;
  serverHost: string;
  serverOverrides?: ServerOverrides;
  serverPort: number;
  socketDir: string;
}

/**
 * A parsed representation of the raw key/value pairs extracted from disc.toml.
 * Scalar values are strings at this stage; type coercion happens during context
 * construction. Array values arrive pre-parsed so callers don't re-implement
 * TOML's bracket grammar.
 */
interface TomlFields {
  backendDsn?: string;
  corsAllowCredentials?: string;
  corsOrigins?: string[];
  enableCors?: string;
  enableDataWatch?: string;
  enableMetrics?: string;
  enableRest?: string;
  enableWebsockets?: string;
  host?: string;
  instanceName?: string;
  managed?: string;
  maxRequestBodyBytes?: string;
  name?: string;
  port?: string;
  rateLimitRpm?: string;
  readOnly?: string;
  requestTimeout?: string;
  requireAuth?: string;
  trustProxy?: string;
}

/**
 * Unescape a TOML basic-string body (already with surrounding quotes
 * stripped). Handles the two escapes Disc supports: `\"` (literal quote)
 * and `\\` (literal backslash). (P2-27)
 */
function unescapeBasicString(body: string): string {
  return body.replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
}

/**
 * Parse a TOML inline array of basic strings: `["a", "b"]`. Returns null
 * if the syntax doesn't match — callers fall back to ignoring the key.
 * Whitespace inside the brackets is tolerated; trailing commas are too.
 */
function parseStringArray(raw: string): string[] | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return null;
  }

  const inner = trimmed.slice(1, -1).trim();
  if (inner === "") {
    return [];
  }

  const out: string[] = [];
  // Split on commas that are NOT inside a quoted string. The simple parser
  // walks character-by-character tracking quote state.
  let buf = "";
  let inQuote = false;
  let escape = false;

  for (const ch of inner) {
    if (escape) {
      buf += ch;
      escape = false;
      continue;
    }
    if (ch === "\\" && inQuote) {
      buf += ch;
      escape = true;
      continue;
    }
    if (ch === "\"") {
      buf += ch;
      inQuote = !inQuote;
      continue;
    }
    if (ch === "," && !inQuote) {
      const item = buf.trim();
      if (item !== "") {
        if (!item.startsWith("\"") || !item.endsWith("\"")) {
          return null;
        }
        out.push(unescapeBasicString(item.slice(1, -1)));
      }
      buf = "";
      continue;
    }
    buf += ch;
  }

  const last = buf.trim();
  if (last !== "") {
    if (!last.startsWith("\"") || !last.endsWith("\"")) {
      return null;
    }
    out.push(unescapeBasicString(last.slice(1, -1)));
  }

  return out;
}

/**
 * Parse a disc.toml file into raw string fields.
 *
 * Handles a simple subset of TOML:
 *   - Top-level key = "value" or key = number or key = bool
 *   - Section headers: [database], [server]
 *   - Inline arrays of strings: key = ["a", "b"] (server.cors_origins only)
 *   - Comments (#) are ignored
 *   - Quoted strings have their quotes stripped
 */
function parseToml(source: string): TomlFields {
  const fields: TomlFields = {};
  let section = "";

  for (const rawLine of source.split("\n")) {
    const line = rawLine.trim();

    // Skip blank lines and comments
    if (!line || line.startsWith("#")) {
      continue;
    }

    // Section header: [database] or [server]. Note: must check this BEFORE
    // the kv match, since both `[server]` and `key = [...]` start with `[`.
    const sectionMatch = line.match(/^\[([a-z_]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      continue;
    }

    // Key-value pair: key = value
    const kvMatch = line.match(/^([a-z_]+)\s*=\s*(.+)$/);
    if (!kvMatch) {
      continue;
    }

    const key = kvMatch[1];
    const rawValue = kvMatch[2].trim();

    // Strip surrounding double quotes if present and unescape the TOML
    // basic-string escapes we care about. Arrays are kept as raw text and
    // dispatched to `parseStringArray` only by the keys that expect them.
    let value: string;
    if (rawValue.startsWith("\"") && rawValue.endsWith("\"")) {
      value = unescapeBasicString(rawValue.slice(1, -1));
    } else {
      value = rawValue;
    }

    if (section === "") {
      if (key === "name") {
        fields.name = value;
      }
    } else if (section === "database") {
      if (key === "managed") {
        fields.managed = value;
      } else if (key === "instance_name") {
        fields.instanceName = value;
      } else if (key === "backend_dsn") {
        fields.backendDsn = value;
      }
    } else if (section === "server") {
      if (key === "port") {
        fields.port = value;
      } else if (key === "host") {
        fields.host = value;
      } else if (key === "require_auth") {
        fields.requireAuth = value;
      } else if (key === "read_only") {
        fields.readOnly = value;
      } else if (key === "enable_cors") {
        fields.enableCors = value;
      } else if (key === "enable_websockets") {
        fields.enableWebsockets = value;
      } else if (key === "enable_metrics") {
        fields.enableMetrics = value;
      } else if (key === "enable_rest") {
        fields.enableRest = value;
      } else if (key === "enable_data_watch") {
        fields.enableDataWatch = value;
      } else if (key === "trust_proxy") {
        fields.trustProxy = value;
      } else if (key === "cors_allow_credentials") {
        fields.corsAllowCredentials = value;
      } else if (key === "cors_origins") {
        const arr = parseStringArray(rawValue);
        if (arr !== null) {
          fields.corsOrigins = arr;
        }
      } else if (key === "max_request_body_bytes") {
        fields.maxRequestBodyBytes = value;
      } else if (key === "request_timeout") {
        fields.requestTimeout = value;
      } else if (key === "rate_limit_rpm") {
        fields.rateLimitRpm = value;
      }
    }
  }

  return fields;
}

/**
 * Coerce a TOML value-string to a boolean, or return undefined when the
 * value isn't a recognized boolean literal. TOML's spec is strict — only
 * lowercase `true`/`false` — but we accept case-insensitive forms for
 * forgiveness on the project-config surface.
 */
function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return undefined;
}

/**
 * Coerce a TOML value-string to a positive integer, or return undefined
 * when it doesn't parse cleanly. Negative or non-finite values are
 * dropped — those would only ever indicate a mistyped config.
 */
function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }
  return parsed;
}

/**
 * Build the curated `ServerOverrides` slice from raw TomlFields. Only
 * keys present in disc.toml appear in the result — absent keys leave
 * the server's env-derived defaults untouched.
 */
function buildServerOverrides(fields: TomlFields): ServerOverrides | undefined {
  const overrides: ServerOverrides = {};

  const requireAuth = parseBool(fields.requireAuth);
  if (requireAuth !== undefined) overrides.requireAuth = requireAuth;

  const readOnly = parseBool(fields.readOnly);
  if (readOnly !== undefined) overrides.readOnly = readOnly;

  const enableCors = parseBool(fields.enableCors);
  if (enableCors !== undefined) overrides.enableCors = enableCors;

  const enableWebsockets = parseBool(fields.enableWebsockets);
  if (enableWebsockets !== undefined) {
    overrides.enableWebsockets = enableWebsockets;
  }

  const enableMetrics = parseBool(fields.enableMetrics);
  if (enableMetrics !== undefined) overrides.enableMetrics = enableMetrics;

  const enableRest = parseBool(fields.enableRest);
  if (enableRest !== undefined) overrides.enableRest = enableRest;

  const enableDataWatch = parseBool(fields.enableDataWatch);
  if (enableDataWatch !== undefined) {
    overrides.enableDataWatch = enableDataWatch;
  }

  const trustProxy = parseBool(fields.trustProxy);
  if (trustProxy !== undefined) overrides.trustProxy = trustProxy;

  const corsAllowCredentials = parseBool(fields.corsAllowCredentials);
  if (corsAllowCredentials !== undefined) {
    overrides.corsAllowCredentials = corsAllowCredentials;
  }

  if (fields.corsOrigins !== undefined) {
    overrides.corsOrigins = fields.corsOrigins;
  }

  const maxRequestBodyBytes = parsePositiveInt(fields.maxRequestBodyBytes);
  if (maxRequestBodyBytes !== undefined) {
    overrides.maxRequestBodyBytes = maxRequestBodyBytes;
  }

  const requestTimeout = parsePositiveInt(fields.requestTimeout);
  if (requestTimeout !== undefined) overrides.requestTimeout = requestTimeout;

  const rateLimitRpm = parsePositiveInt(fields.rateLimitRpm);
  if (rateLimitRpm !== undefined) overrides.rateLimitRpm = rateLimitRpm;

  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

/**
 * Derive the ~/.disc base directory.
 *
 * Prefers $DISC_HOME, then falls back to $HOME/.disc.
 */
function discHome(): string {
  const discHome = Deno.env.get("DISC_HOME");
  if (discHome) {
    return discHome;
  }

  const home = Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || "/tmp";
  return join(home, ".disc");
}

/**
 * Walk up the directory tree starting from `startDir` looking for a
 * disc.toml file. Returns the directory that contains disc.toml, or null
 * if none was found before reaching the filesystem root.
 */
function findProjectRoot(startDir: string): string | null {
  let current = startDir;

  while (true) {
    const candidate = join(current, "disc.toml");

    try {
      const stat = Deno.statSync(candidate);
      if (stat.isFile) {
        return current;
      }
    } catch {
      // File does not exist — keep walking up
    }

    const parent = dirname(current);
    if (parent === current) {
      // Reached the filesystem root
      return null;
    }

    current = parent;
  }
}

/**
 * Locate disc.toml by walking up from `cwd` (defaults to Deno.cwd()), parse
 * it, and return a fully resolved ProjectContext.
 *
 * Returns null when no disc.toml can be found.
 */
export function resolveProjectContext(cwd?: string): ProjectContext | null {
  const startDir = cwd ?? Deno.cwd();
  const projectRoot = findProjectRoot(startDir);

  if (projectRoot === null) {
    return null;
  }

  const tomlPath = join(projectRoot, "disc.toml");
  let source: string;

  try {
    source = Deno.readTextFileSync(tomlPath);
  } catch {
    return null;
  }

  const fields = parseToml(source);

  const projectName = fields.name ?? "";
  // P1-15: reject an empty `name` in disc.toml — downstream path construction
  // (`~/.disc/instances/<name>/`) silently produced malformed paths when the
  // key was missing or blank.
  if (!projectName) {
    throw new Error(
      `disc.toml at ${tomlPath} is missing the required 'name' field`,
    );
  }
  const instanceName = fields.instanceName ?? projectName;
  const managed = fields.managed !== undefined ? fields.managed.toLowerCase() === "true" : true;
  const serverPort = fields.port !== undefined ? parseInt(fields.port, 10) : 5656;
  const serverHost = fields.host ?? "localhost";

  const instancesBase = join(discHome(), "instances", instanceName);
  const socketDir = join(instancesBase, "socket");
  const dataDir = join(instancesBase, "data");

  const context: ProjectContext = {
    dataDir,
    instanceName,
    managed,
    projectName,
    projectRoot,
    serverHost,
    serverPort,
    socketDir,
  };

  if (fields.backendDsn) {
    context.backendDsn = fields.backendDsn;
  }

  const serverOverrides = buildServerOverrides(fields);
  if (serverOverrides) {
    context.serverOverrides = serverOverrides;
  }

  return context;
}

/**
 * Build a PostgreSQL connection string from a ProjectContext.
 *
 * If `ctx.backendDsn` is set it is returned directly (external PostgreSQL).
 * Otherwise a Unix socket DSN is constructed from the managed instance paths.
 */
export function resolveDsn(ctx: ProjectContext): string {
  if (ctx.backendDsn) {
    return ctx.backendDsn;
  }

  return `postgresql://disc@/${ctx.instanceName}?host=${ctx.socketDir}`;
}

/**
 * Check whether the managed PostgreSQL process is currently running.
 *
 * Reads `postmaster.pid` from the data directory, extracts the PID on the
 * first line, and sends signal 0 to verify the process is alive.
 *
 * Stale PID files (process no longer alive) are removed automatically.
 * Returns false when the PID file is absent or the process is not running.
 */
export async function isPgRunning(ctx: ProjectContext): Promise<boolean> {
  const pidFile = join(ctx.dataDir, "postmaster.pid");

  let contents: string;
  try {
    contents = await Deno.readTextFile(pidFile);
  } catch {
    // File does not exist — PostgreSQL is not running
    return false;
  }

  const firstLine = contents.split("\n")[0].trim();
  const pid = parseInt(firstLine, 10);

  if (isNaN(pid) || pid <= 0) {
    return false;
  }

  try {
    // Signal 0 checks existence without sending a real signal
    Deno.kill(pid, "SIGCONT");
    // On some platforms kill(pid, 0) is the idiom; Deno.kill accepts signal
    // names. We use SIGCONT because Deno does not expose signal 0. A running
    // process will not be affected by SIGCONT when already running.
    return true;
  } catch {
    // Process does not exist — remove stale PID file
    try {
      await Deno.remove(pidFile);
    } catch {
      // Best-effort cleanup; ignore removal errors
    }
    return false;
  }
}
