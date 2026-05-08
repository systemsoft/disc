/**
 * Deno-permission-aware access policies (Disc-original feature #5).
 *
 * Adds a `runtime::has_permission(<spec>)` builtin to the access-policy
 * grammar. The function evaluates against the running Deno process's
 * permission set so an operator who deploys Disc without the relevant
 * `--allow-*` flag gets a defense-in-depth refusal — even on queries
 * the application-level user is otherwise authorized for.
 *
 * Permission spec grammar (the string passed to `has_permission`):
 *
 *   read              → { name: "read" }
 *   read:/path        → { name: "read", path }
 *   write             → { name: "write" }
 *   write:/path       → { name: "write", path }
 *   net               → { name: "net" }
 *   net:host[:port]   → { name: "net", host }
 *   env               → { name: "env" }
 *   env:VAR           → { name: "env", variable }
 *   run               → { name: "run" }
 *   run:cmd           → { name: "run", command }
 *   sys               → { name: "sys" }
 *   sys:KIND          → { name: "sys", kind }
 *   ffi               → { name: "ffi" }
 *   ffi:/path         → { name: "ffi", path }
 *
 * The parser is strict — anything outside this grammar throws so a
 * typo in SDL fails at policy-load time rather than silently treating
 * the unknown spec as "permission missing" (which would always deny).
 */

export type PermissionSpec =
  | { name: "read"; path?: string; }
  | { name: "write"; path?: string; }
  | { name: "net"; host?: string; }
  | { name: "env"; variable?: string; }
  | { name: "run"; command?: string; }
  | { name: "sys"; kind?: string; }
  | { name: "ffi"; path?: string; };

/** Permission state — Deno returns "granted" / "denied" / "prompt". */
export type PermissionState = "granted" | "denied" | "prompt";

/** Test seam — mockable in unit tests. Default uses Deno.permissions. */
export type PermissionChecker = (spec: PermissionSpec) => PermissionState;

const VALID_NAMES = new Set([
  "read",
  "write",
  "net",
  "env",
  "run",
  "sys",
  "ffi"
]);

/**
 * Parse a permission-spec string into a structured `PermissionSpec`.
 * Throws `Error` (with the bad input quoted) on unknown names or
 * malformed scope.
 */
export function parsePermissionSpec(input: string): PermissionSpec {
  if (typeof input !== "string" || input.length === 0) {
    throw new Error(`Permission spec must be a non-empty string, got ${JSON.stringify(input)}`);
  }
  const colonIdx = input.indexOf(":");
  const name = colonIdx === -1 ? input : input.slice(0, colonIdx);
  const scope = colonIdx === -1 ? undefined : input.slice(colonIdx + 1);
  if (!VALID_NAMES.has(name)) {
    throw new Error(`Unknown permission name ${JSON.stringify(name)} — expected one of: ${[...VALID_NAMES].join(", ")}`);
  }
  if (scope !== undefined && scope.length === 0) {
    throw new Error(`Permission spec ${JSON.stringify(input)} has an empty scope after ':'`);
  }
  switch (name) {
    case "read":
    case "write":
    case "ffi":
      return scope ? { name, path: scope } : { name };
    case "net":
      return scope ? { name, host: scope } : { name };
    case "env":
      return scope ? { name, variable: scope } : { name };
    case "run":
      return scope ? { name, command: scope } : { name };
    case "sys":
      return scope ? { name, kind: scope } : { name };
    default: {
      // Unreachable — VALID_NAMES guards this.
      throw new Error(`Unhandled permission name: ${name}`);
    }
  }
}

/**
 * Default checker — calls `Deno.permissions.querySync` synchronously.
 * Synchronous because access policies run in the request-evaluation
 * hot path; making them async would require threading a Promise
 * through every node of the expression tree.
 */
export const defaultPermissionChecker: PermissionChecker = spec => {
  // Cast safety: PermissionSpec mirrors Deno.PermissionDescriptor shape
  // for each name; the field-name conventions match (path/host/variable
  // /command/kind). Any drift in Deno's API would surface as a runtime
  // type error, not a silent miss.
  const status = Deno.permissions.querySync(spec as Deno.PermissionDescriptor);
  return status.state;
};

/**
 * High-level helper: parse + check. Returns `true` only if the spec
 * resolves to the "granted" state.
 */
export function hasPermission(
  spec: string,
  checker: PermissionChecker = defaultPermissionChecker
): boolean {
  return checker(parsePermissionSpec(spec)) === "granted";
}
