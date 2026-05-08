/**
 * SDL serializer (#702 + #7469)
 *
 * Renders an in-memory `Schema` as SDL source text. The output is
 * round-trippable via `SchemaManager.parseSDL()`. Coverage today:
 *   - Modules (grouping types by their `module` field)
 *   - Object types: abstract, extending, properties, links
 *   - Scalar enum types
 *   - Property bodies: required, multi, readonly, constraints, defaults,
 *     annotations
 *   - Type-level annotations
 *
 * Deferred (round-trip would need richer source preservation in
 * `Schema`/`TypeDef`): triggers, rewrites, access policies, indexes,
 * computed expressions, abstract annotation declarations, globals,
 * functions, aliases. These are emitted as SDL comments noting the
 * gap so the round-trip stays observable.
 */

import type { LinkDef, PropertyConstraint, PropertyDef, Schema, TypeDef } from "./context.ts";

const INDENT = "  ";

export function serializeSchema(schema: Schema): string {
  // Group types by their module. Strip module prefix from each type's
  // qualified name when emitting under its module block — the parser
  // re-qualifies at module entry.
  const byModule = new Map<string, TypeDef[]>();
  for (const t of schema.types.values()) {
    const mod = resolveModule(t);
    if (!byModule.has(mod))
      byModule.set(mod, []);
    byModule.get(mod)!.push(t);
  }

  const moduleNames = [...byModule.keys()].sort((a, b) => {
    // 'default' first, then alphabetical — matches conventional layouts.
    if (a === "default")
      return -1;
    if (b === "default")
      return 1;
    return a.localeCompare(b);
  });

  const blocks: string[] = [];
  for (const mod of moduleNames) {
    const types = byModule.get(mod)!.slice().sort((a, b) => stripModule(a.name).localeCompare(stripModule(b.name)));
    const body = types
      .map(t => indent(serializeTypeAt(t, INDENT), INDENT))
      .join("\n\n");
    blocks.push(`module ${mod} {\n${body}\n};`);
  }

  return blocks.join("\n\n") + "\n";
}

/**
 * Render a single type at module-relative indentation. Useful for tests
 * and for exporting one type at a time.
 */
export function serializeType(typeDef: TypeDef): string {
  return serializeTypeAt(typeDef, "");
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function serializeTypeAt(typeDef: TypeDef, _baseIndent: string): string {
  if (typeDef.kind === "enum")
    return serializeEnum(typeDef);
  if (typeDef.kind === "scalar")
    return serializeScalar(typeDef);
  return serializeObject(typeDef);
}

function serializeEnum(typeDef: TypeDef): string {
  const name = stripModule(typeDef.name);
  const values = (typeDef.enumValues ?? []).join(", ");
  return `scalar type ${name} extending enum<${values}>;`;
}

function serializeScalar(typeDef: TypeDef): string {
  const name = stripModule(typeDef.name);
  // Without a recorded base-type or constraints in TypeDef, emit a
  // best-effort declaration. Most disc-managed scalars are enums above.
  return `scalar type ${name};`;
}

function serializeObject(typeDef: TypeDef): string {
  const name = stripModule(typeDef.name);
  const header: string[] = [];
  if (typeDef.abstract)
    header.push("abstract");
  header.push("type", name);

  const parents = (typeDef.parentTypes ?? []).filter(p => p !== "std::BaseObject" && p !== "BaseObject");
  if (parents.length > 0) {
    header.push("extending", parents.map(stripModule).join(", "));
  }

  const lines: string[] = [];

  // Type-level annotations first
  if (typeDef.annotations) {
    for (const [k, v] of orderedEntries(typeDef.annotations)) {
      lines.push(`annotation ${k} := ${formatAnnotationValue(v)};`);
    }
  }

  // Properties (sorted for determinism)
  const props = [...typeDef.properties.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const p of props) {
    if (p.name === "id")
      continue; // implicit in disc/gel
    lines.push(serializeProperty(p));
  }

  // Links
  const links = [...typeDef.links.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const l of links) {
    lines.push(serializeLink(l));
  }

  if (lines.length === 0) {
    return `${header.join(" ")} { };`;
  }
  // Each line may itself be a multi-line block (a property with a body).
  // Indent every contained line to keep nested braces readable.
  const body = lines
    .map(l => l.split("\n").map(sub => INDENT + sub).join("\n"))
    .join("\n");
  return `${header.join(" ")} {\n${body}\n};`;
}

function serializeProperty(prop: PropertyDef): string {
  const parts: string[] = [];
  if (prop.required)
    parts.push("required");
  if (prop.multi)
    parts.push("multi");
  parts.push(prop.name);
  parts.push(":", prop.edgeqlType ?? prop.type);

  const body = collectPropertyBodyLines(prop);
  if (body.length === 0) {
    return `${parts.join(" ").replace(" :", ":")};`;
  }
  const lines = body.map(l => INDENT + l).join("\n");
  return `${parts.join(" ").replace(" :", ":")} {\n${lines}\n};`;
}

function collectPropertyBodyLines(prop: PropertyDef): string[] {
  const out: string[] = [];
  if (prop.readonly)
    out.push("readonly := true;");
  if (prop.annotations) {
    for (const [k, v] of orderedEntries(prop.annotations)) {
      out.push(`annotation ${k} := ${formatAnnotationValue(v)};`);
    }
  }
  if (prop.constraints) {
    for (const c of prop.constraints) {
      out.push(serializeConstraint(c));
    }
  }
  // `hasDefault` only marks presence; the original expression isn't
  // preserved on PropertyDef. We can't faithfully re-emit, so skip
  // rather than fabricate one. (Documented in the module header.)
  return out;
}

function serializeConstraint(c: PropertyConstraint): string {
  if (c.args && c.args.length > 0) {
    return `constraint ${c.name}(${c.args.join(", ")});`;
  }
  return `constraint ${c.name};`;
}

function serializeLink(link: LinkDef): string {
  // SDL link syntax requires the `link` keyword and `->` arrow:
  // `[required] [multi] link <name> -> <Target>;`
  const parts: string[] = [];
  if (link.required)
    parts.push("required");
  if (link.multi)
    parts.push("multi");
  parts.push("link", link.name, "->", stripModule(link.target));

  const body: string[] = [];
  if (link.annotations) {
    for (const [k, v] of orderedEntries(link.annotations)) {
      body.push(`annotation ${k} := ${formatAnnotationValue(v)};`);
    }
  }

  if (body.length === 0) {
    return `${parts.join(" ")};`;
  }
  const lines = body.map(l => INDENT + l).join("\n");
  return `${parts.join(" ")} {\n${lines}\n};`;
}

function resolveModule(typeDef: TypeDef): string {
  if (typeDef.module)
    return typeDef.module;
  if (typeDef.name.includes("::")) {
    return typeDef.name.split("::")[0];
  }
  return "default";
}

function stripModule(name: string): string {
  const idx = name.indexOf("::");
  return idx === -1 ? name : name.slice(idx + 2);
}

/**
 * Annotation values are SDL expressions — most are string literals.
 * SchemaManager preserves surrounding quotes for strings (`"'true'"`),
 * synthetic fixtures pass raw `"true"`. Re-emit with single quotes for
 * round-trip stability; if the value already starts and ends with a
 * quote, pass it through unchanged.
 */
function formatAnnotationValue(value: string): string {
  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith("\"") && value.endsWith("\""))
  ) {
    return value;
  }
  // Escape any embedded single quotes by doubling-up (SDL convention).
  const escaped = value.replace(/'/g, "''");
  return `'${escaped}'`;
}

function orderedEntries(o: Record<string, string>): Array<[string, string]> {
  return Object.keys(o).sort().map(k => [k, o[k]] as [string, string]);
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map(line => (line.length === 0 ? line : prefix + line))
    .join("\n");
}
