/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * `.env` file loading for Disc projects.
 *
 * `disc init` writes a `.env` alongside `disc.toml`, and the generated README
 * describes it as "environment overrides" — but until this module existed
 * nothing ever read it, so every `DISC_*` key set there was silently inert.
 * The CLI now loads it once at startup (see `cli/main.ts`).
 *
 * Precedence, lowest to highest:
 *   1. `.env`         (committed project defaults)
 *   2. `.env.local`   (git-ignored per-developer overrides)
 *   3. the real process environment / CLI flags
 *
 * The process environment always wins: an exported `DISC_JWT_SECRET` or a
 * `--jwt-secret` flag is never clobbered by a file. That also makes loading
 * idempotent — re-running it can only ever fill in keys that are still unset.
 */

import { join } from "@std/path";

/**
 * Project roots whose env files have already been applied, so repeat calls
 * (the CLI resolves project context in many commands) stay no-ops.
 */
const loadedRoots = new Set<string>();

/**
 * Unescape a double-quoted `.env` value. Mirrors the small escape set every
 * dotenv implementation agrees on; single-quoted values stay literal.
 */
function unescapeDoubleQuoted(body: string): string {
  return body
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, "\"")
    .replace(/\\\\/g, "\\");
}

/**
 * Parse `.env` source text into key/value pairs.
 *
 * Supported shape:
 *   - `KEY=value`, optionally prefixed with `export `
 *   - blank lines and `#` comments are skipped
 *   - values wrapped in matching `"` or `'` have the quotes stripped;
 *     double-quoted values also get `\n`/`\r`/`\t`/`\"`/`\\` unescaped
 *   - an unquoted value is trimmed, and anything from the first whitespace-
 *     preceded `#` is dropped as a trailing comment
 *
 * Values containing `#`, quotes, or leading/trailing spaces must be quoted —
 * the same rule every dotenv parser imposes. Later keys win over earlier ones
 * within a single file.
 */
export function parseEnvFile(source: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const rawLine of source.split("\n")) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      continue;
    }

    const key = match[1];
    const rawValue = match[2].trim();

    if (rawValue.length >= 2 && rawValue.startsWith("\"") && rawValue.endsWith("\"")) {
      result[key] = unescapeDoubleQuoted(rawValue.slice(1, -1));
    } else if (rawValue.length >= 2 && rawValue.startsWith("'") && rawValue.endsWith("'")) {
      result[key] = rawValue.slice(1, -1);
    } else {
      /*** Strip a trailing `# comment`, but only when whitespace precedes the
           `#` — otherwise a secret like `abc#def` would lose its tail. ***/
      const commentAt = rawValue.search(/\s#/);
      result[key] = (commentAt === -1 ? rawValue : rawValue.slice(0, commentAt)).trim();
    }
  }

  return result;
}

/**
 * Apply a single env file to `Deno.env`, skipping keys that are already set.
 * Returns the names of the keys it actually applied; a missing or unreadable
 * file yields an empty list (env files are optional by definition).
 */
export function loadEnvFile(path: string): string[] {
  let source: string;

  try {
    source = Deno.readTextFileSync(path);
  } catch {
    return [];
  }

  const applied: string[] = [];

  for (const [key, value] of Object.entries(parseEnvFile(source))) {
    if (Deno.env.get(key) !== undefined) {
      continue;
    }

    Deno.env.set(key, value);
    applied.push(key);
  }

  return applied;
}

/**
 * Load `.env.local` then `.env` from `projectRoot` into the process
 * environment. `.env.local` is read first so its values take precedence —
 * under never-overwrite semantics, whoever sets a key first owns it.
 *
 * Idempotent per root. Returns every key applied across both files.
 */
export function loadProjectEnv(projectRoot: string): string[] {
  if (loadedRoots.has(projectRoot)) {
    return [];
  }

  loadedRoots.add(projectRoot);

  return [
    ...loadEnvFile(join(projectRoot, ".env.local")),
    ...loadEnvFile(join(projectRoot, ".env"))
  ];
}

/**
 * Forget which roots have been loaded. Test-only seam — production code loads
 * once per process and never needs to reset.
 */
export function resetLoadedEnvRoots(): void {
  loadedRoots.clear();
}
