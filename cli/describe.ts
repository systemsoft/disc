/**
 * Type description renderers for the REPL `\d` meta-command (gh/geldata#1218).
 *
 * `\d` (no args) lists every type known to the loaded schema, grouped by
 * module. `\d <Type>` produces a psql-style verbose dump that surfaces
 * everything the schema knows about a type: parents, abstract flag,
 * properties (with cardinality + readonly + computed + constraints +
 * default + annotations), links (with cardinality + target + required
 * + annotations), indexes, access policies, the discriminator column for
 * abstract roots, and known subtypes.
 *
 * The output is plain text — no colour codes, no console.table — so the
 * REPL can stream it through any stdout pipe and tests can pattern-match
 * exact substrings.
 */

import type {
  AccessAction,
  AccessPolicy,
} from "../access/types.ts";
import type {
  IndexDef,
  LinkDef,
  PropertyConstraint,
  PropertyDef,
  Schema,
  TypeDef,
} from "../compiler/context.ts";

/**
 * Render the global type list shown by `\d` without arguments.
 *
 * Types are grouped by module (default first, then alphabetical) and
 * within each module sorted by bare name. Each row reports the type's
 * kind so abstract object types and scalar enums are distinguishable
 * at a glance.
 */
export function describeAllTypes(schema: Schema): string {
  if (schema.types.size === 0) {
    return "No types defined in schema.";
  }

  const byModule = new Map<string, TypeDef[]>();
  for (const t of schema.types.values()) {
    const mod = resolveModule(t);
    if (!byModule.has(mod)) byModule.set(mod, []);
    byModule.get(mod)!.push(t);
  }

  const moduleNames = [...byModule.keys()].sort((a, b) => {
    if (a === "default") return -1;
    if (b === "default") return 1;
    return a.localeCompare(b);
  });

  const lines: string[] = [];
  lines.push(`Types in schema (${schema.types.size}):`);
  lines.push("");

  for (const mod of moduleNames) {
    const types = byModule.get(mod)!.slice().sort((a, b) =>
      stripModule(a.name).localeCompare(stripModule(b.name))
    );
    lines.push(`module ${mod}`);
    for (const t of types) {
      lines.push(`  ${stripModule(t.name).padEnd(28)} ${kindLabel(t)}`);
    }
    lines.push("");
  }

  // Trim trailing blank line
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

/**
 * Render a verbose description of a single type.
 *
 * Returns a multi-line string. Returns null when `name` does not resolve
 * to any known type (caller renders a helpful error).
 */
export function describeType(schema: Schema, name: string): string | null {
  const typeDef = lookupType(schema, name);
  if (!typeDef) return null;

  const lines: string[] = [];
  const header = formatHeader(typeDef);
  lines.push(header);
  lines.push("=".repeat(header.length));

  if (typeDef.module) {
    lines.push(`Module: ${typeDef.module}`);
  }

  if (typeDef.parentTypes && typeDef.parentTypes.length > 0) {
    const parents = typeDef.parentTypes
      .filter((p) => p !== "std::BaseObject" && p !== "BaseObject")
      .map(stripModule);
    if (parents.length > 0) {
      lines.push(`Extends: ${parents.join(", ")}`);
    }
  }

  if (typeDef.subtypes && typeDef.subtypes.length > 0) {
    lines.push(`Subtypes: ${typeDef.subtypes.map(stripModule).join(", ")}`);
  }

  if (typeDef.discriminatorColumn) {
    lines.push(`Discriminator: ${typeDef.discriminatorColumn}`);
  }

  if (typeDef.tableName) {
    lines.push(`Table: ${typeDef.tableName}`);
  }

  if (typeDef.annotations && Object.keys(typeDef.annotations).length > 0) {
    lines.push("Annotations:");
    for (const [k, v] of orderedEntries(typeDef.annotations)) {
      lines.push(`  ${k} := ${formatAnnotationValue(v)}`);
    }
  }

  // Enum values for scalar enum types
  if (typeDef.kind === "enum") {
    const values = (typeDef.enumValues ?? []).join(", ");
    lines.push(`Values: ${values}`);
    return lines.join("\n");
  }

  // Properties
  const props = [...typeDef.properties.values()]
    .filter((p) => p.name !== "id")
    .sort((a, b) => a.name.localeCompare(b.name));
  if (props.length > 0) {
    lines.push("");
    lines.push("Properties:");
    for (const p of props) {
      formatProperty(p).forEach((line) => lines.push("  " + line));
    }
  }

  // Links
  const links = [...typeDef.links.values()]
    .sort((a, b) => a.name.localeCompare(b.name));
  if (links.length > 0) {
    lines.push("");
    lines.push("Links:");
    for (const l of links) {
      formatLink(l).forEach((line) => lines.push("  " + line));
    }
  }

  // Indexes
  if (typeDef.indexes && typeDef.indexes.length > 0) {
    lines.push("");
    lines.push("Indexes:");
    for (const idx of typeDef.indexes) {
      lines.push("  " + formatIndex(idx));
    }
  }

  // Access policies
  if (typeDef.accessPolicies && typeDef.accessPolicies.length > 0) {
    lines.push("");
    lines.push("Access policies:");
    for (const policy of typeDef.accessPolicies) {
      formatAccessPolicy(policy).forEach((line) => lines.push("  " + line));
    }
  }

  // Triggers (name + timing summary; full body intentionally omitted)
  if (typeDef.triggers && typeDef.triggers.length > 0) {
    lines.push("");
    lines.push("Triggers:");
    for (const t of typeDef.triggers) {
      const events = t.events.join(", ");
      lines.push(`  ${t.name} ${t.timing} ${events} (${t.scope})`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lookupType(schema: Schema, name: string): TypeDef | undefined {
  // 1. Exact match (already qualified or already stored bare).
  const exact = schema.types.get(name);
  if (exact) return exact;

  if (!name.includes("::")) {
    // 2. Try default module.
    const inDefault = schema.types.get(`default::${name}`);
    if (inDefault) return inDefault;

    // 3. Last resort: walk the schema for a bare-name match across modules.
    for (const t of schema.types.values()) {
      if (stripModule(t.name) === name) return t;
    }
  }

  return undefined;
}

function formatHeader(typeDef: TypeDef): string {
  const parts: string[] = [];
  if (typeDef.abstract) parts.push("abstract");
  if (typeDef.kind === "enum") parts.push("enum");
  else if (typeDef.kind === "scalar") parts.push("scalar");
  else parts.push("type");
  parts.push(stripModule(typeDef.name));
  return `Type: ${parts.join(" ")}`;
}

function formatProperty(prop: PropertyDef): string[] {
  const flags: string[] = [];
  if (prop.required) flags.push("required");
  if (prop.multi) flags.push("multi");
  if (prop.readonly) flags.push("readonly");
  if (prop.computed) flags.push("computed");
  if (prop.hasDefault) flags.push("default");

  const flagStr = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
  const typeStr = prop.edgeqlType ?? prop.type;
  const head = `${prop.name}: ${typeStr}${flagStr}`;
  const out: string[] = [head];

  if (prop.constraints && prop.constraints.length > 0) {
    for (const c of prop.constraints) {
      out.push("  - " + formatConstraint(c));
    }
  }

  if (prop.annotations && Object.keys(prop.annotations).length > 0) {
    for (const [k, v] of orderedEntries(prop.annotations)) {
      out.push(`  - annotation ${k} := ${formatAnnotationValue(v)}`);
    }
  }

  if (prop.rewrites && prop.rewrites.length > 0) {
    for (const rw of prop.rewrites) {
      const events = rw.events.join(", ");
      out.push(`  - rewrite ${events}`);
    }
  }

  return out;
}

function formatLink(link: LinkDef): string[] {
  const flags: string[] = [];
  if (link.required) flags.push("required");
  flags.push(link.multi ? "multi" : "single");
  const flagStr = ` [${flags.join(", ")}]`;
  const head = `${link.name} -> ${stripModule(link.target)}${flagStr}`;
  const out: string[] = [head];

  if (link.backlink) {
    out.push(`  - backlink: ${link.backlink}`);
  }
  if (link.junctionTable) {
    out.push(`  - junction: ${link.junctionTable}`);
  }
  if (link.annotations && Object.keys(link.annotations).length > 0) {
    for (const [k, v] of orderedEntries(link.annotations)) {
      out.push(`  - annotation ${k} := ${formatAnnotationValue(v)}`);
    }
  }
  return out;
}

function formatConstraint(c: PropertyConstraint): string {
  if (c.args && c.args.length > 0) {
    return `constraint ${c.name}(${c.args.join(", ")})`;
  }
  return `constraint ${c.name}`;
}

function formatIndex(idx: IndexDef): string {
  if (idx.name) {
    return `${idx.name} on ${idx.expression}`;
  }
  return `on ${idx.expression}`;
}

function formatAccessPolicy(policy: AccessPolicy): string[] {
  const out: string[] = [];
  out.push(`policy ${policy.name}`);
  for (const action of policy.actions) {
    out.push("  - " + formatAccessAction(action));
  }
  if (policy.using) {
    out.push("  - using: <expression>");
  }
  if (policy.withCheck) {
    out.push("  - with check: <expression>");
  }
  return out;
}

function formatAccessAction(action: AccessAction): string {
  const verb = action.allow ? "allow" : "deny";
  return `${verb} ${action.operations.join(", ")}`;
}

function kindLabel(t: TypeDef): string {
  if (t.kind === "enum") return "(enum)";
  if (t.kind === "scalar") return "(scalar)";
  if (t.abstract) return "(abstract)";
  return "(object)";
}

function resolveModule(typeDef: TypeDef): string {
  if (typeDef.module) return typeDef.module;
  if (typeDef.name.includes("::")) {
    return typeDef.name.split("::")[0];
  }
  return "default";
}

function stripModule(name: string): string {
  const idx = name.indexOf("::");
  return idx === -1 ? name : name.slice(idx + 2);
}

function formatAnnotationValue(value: string): string {
  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"'))
  ) {
    return value;
  }
  const escaped = value.replace(/'/g, "''");
  return `'${escaped}'`;
}

function orderedEntries(o: Record<string, string>): Array<[string, string]> {
  return Object.keys(o).sort().map((k) => [k, o[k]] as [string, string]);
}
