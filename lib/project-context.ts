/**
 * Project context resolution for Disc CLI commands.
 *
 * Provides "which project am I in, how do I connect?" by locating disc.toml
 * and deriving all connection parameters from it.
 */

import { dirname, join } from "@std/path";

export interface ProjectContext {
  backendDsn?: string;
  dataDir: string;
  instanceName: string;
  managed: boolean;
  projectName: string;
  projectRoot: string;
  serverHost: string;
  serverPort: number;
  socketDir: string;
}

/**
 * A parsed representation of the raw key/value pairs extracted from disc.toml.
 * All values are strings at this stage; type coercion happens during context
 * construction.
 */
interface TomlFields {
  backendDsn?: string;
  host?: string;
  instanceName?: string;
  managed?: string;
  name?: string;
  port?: string;
}

/**
 * Parse a disc.toml file into raw string fields.
 *
 * Handles a simple subset of TOML:
 *   - Top-level key = "value" or key = number or key = bool
 *   - Section headers: [database], [server]
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

    // Section header: [database] or [server]
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
    // basic-string escapes we care about: \" (literal quote) and \\
    // (literal backslash). (P2-27)
    let value: string;
    if (rawValue.startsWith('"') && rawValue.endsWith('"')) {
      value = rawValue
        .slice(1, -1)
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
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
      }
    }
  }

  return fields;
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
  const managed = fields.managed !== undefined
    ? fields.managed.toLowerCase() === "true"
    : true;
  const serverPort = fields.port !== undefined
    ? parseInt(fields.port, 10)
    : 5656;
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
