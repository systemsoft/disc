/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Go emitter on the codegen IR.
 *
 * Third consumer of the language-neutral IR (`codegen/ir.ts`), after the
 * TypeScript and Rust emitters, proving once more that adding a language is
 * "write one emitter," never "touch a frontend." This file reads only IR nodes
 * (plus the shared EdgeQL cast helper from `types.ts`) and produces a
 * self-contained Go library package — structs, enums, insert/update shapes,
 * per-object query builders, and a stdlib-only HTTP runtime — that compiles
 * offline against the Go standard library with zero external dependencies.
 *
 * It never re-derives schema semantics: insert/update field inclusion and
 * optionality come from the IR's denormalized shapes, mirroring emit-rust.ts.
 *
 * The output is a `package discclient` LIBRARY (no `package main`, no `func
 * main`): `go build ./...` / `go vet ./...` type-check it without invoking the
 * external linker, which is the only build mode available in some toolchains.
 */

/*** UTILITY ------------------------------------------ ***/

import * as Types from "./types.ts";
import type {
  CodegenIR,
  EnumType,
  Field,
  ObjectType,
  QualifiedName,
  ScalarKind,
  ShapeField,
  TypeRef
} from "./ir.ts";

/*** EXPORT ------------------------------------------- ***/

/** Emit the Go client package source set from the IR. */
export function emitGo(ir: CodegenIR, config: Types.CodegenConfig): Types.GeneratedFile[] {
  return new GoEmitter(ir, config).generate();
}

/*** HELPER ------------------------------------------- ***/

/** The flat package name every generated Go file shares. */
const PACKAGE = "discclient";

/**
 * Canonical scalar -> native Go type (JSON-friendly, stdlib-only). A switch
 * (rather than a record) keeps the snake_case scalar kinds off object keys,
 * which the project's camelCase lint forbids.
 */
function scalarGo(kind: ScalarKind): string {
  switch (kind) {
    case "bool":
      return "bool";
    case "int16":
      return "int16";
    case "int32":
      return "int32";
    case "int64":
      return "int64";
    case "float32":
      return "float32";
    case "float64":
      return "float64";
    case "json":
      return "json.RawMessage";
    // Exact JSON numbers on the wire; json.Number keeps every digit both ways.
    case "bigint":
    case "decimal":
      return "json.Number";
    // uuid/datetime/durations/bytes/memory: lossless as JSON strings.
    default:
      return "string";
  }
}

/** Candidate standard-library imports, matched against a file body by selector. */
const STD_IMPORTS: ReadonlyArray<{ path: string; selector: string; }> = [
  { path: "bytes", selector: "bytes." },
  { path: "encoding/json", selector: "json." },
  { path: "fmt", selector: "fmt." },
  { path: "math", selector: "math." },
  { path: "net/http", selector: "http." },
  { path: "sort", selector: "sort." },
  { path: "strings", selector: "strings." }
];

function isMulti(cardinality: string): boolean {
  return cardinality === "Many" || cardinality === "AtLeastOne";
}

/** A struct field's Go identifier, type and JSON tag. */
interface GoField {
  ident: string;
  tag: string;
  type: string;
}

/**
 * The float field types whose JSON the generated methods convert (see
 * FLOAT_JSON_GO): a float, a pointer to one, a slice of them, a slice of such
 * slices (a multi property of float arrays), a pointer to a slice — groups:
 * pointer, slices, bits.
 */
const FLOAT_FIELD = /^(\*?)((?:\[\]){0,2})float(32|64)$/;

/**
 * PascalCase a schema identifier into an exported Go identifier, preserving any
 * internal casing already present (so `ApiKey` stays `ApiKey`, `created_at`
 * becomes `CreatedAt`). Guards the empty/leading-digit cases into a valid,
 * still-exported identifier.
 */
function pascalize(name: string): string {
  const parts = name.split(/[^A-Za-z0-9]+/).filter(p => p.length > 0);
  let ident = parts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join("");
  if (ident.length === 0 || /^[0-9]/.test(ident))
    ident = `X${ident}`;
  return ident;
}

/**
 * Map an enum member to an exported PascalCase Go identifier, lowercasing the
 * remainder of each word so both `active` and `ACTIVE` yield `Active`.
 */
function enumMemberIdent(member: string): string {
  const parts = member.split(/[^A-Za-z0-9]+/).filter(p => p.length > 0);
  let ident = parts
    .map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join("");
  if (ident.length === 0 || /^[0-9]/.test(ident))
    ident = `X${ident}`;
  return ident;
}

/**
 * Flat-package Go type name for a qualified IR name. Default-module types use
 * the bare PascalName (`Merchant`); non-default-module types are prefixed by
 * the PascalCased module (`api::ApiKey` -> `ApiApiKey`) so a single Go package
 * holds every module without cross-package imports or name collisions.
 */
function goTypeName(qn: QualifiedName): string {
  return qn.module === "default" ?
    pascalize(qn.name) :
    `${pascalize(qn.module)}${pascalize(qn.name)}`;
}

class GoEmitter {
  private config: Types.CodegenConfig;
  /** Whether a struct has float fields, so models.go needs FLOAT_JSON_GO. */
  private floatJSON = false;
  private ir: CodegenIR;
  /** Qualified keys ("module::name") of every object + enum the package defines. */
  private known: Set<string>;

  constructor(ir: CodegenIR, config: Types.CodegenConfig) {
    this.ir = ir;
    this.config = config;
    this.known = new Set<string>();
    for (const mod of ir.modules) {
      for (const o of mod.objects)
        this.known.add(`${o.name.module}::${o.name.name}`);
      for (const e of mod.enums)
        this.known.add(`${e.name.module}::${e.name.name}`);
    }
  }

  generate(): Types.GeneratedFile[] {
    const base = this.config.outputDir;
    const files: Types.GeneratedFile[] = [
      { content: this.goMod(), path: `${base}/go.mod`, type: "types" },
      { content: this.modelsFile(), path: `${base}/models.go`, type: "types" }
    ];

    /*** The runtime is the Go client; --no-client drops it (and, since the query
         builders depend on it, them too — see withBuilders). ***/
    if (this.config.includeClient)
      files.push({ content: RUNTIME_GO, path: `${base}/client.go`, type: "client" });

    // Builders depend on the runtime client, so they require both flags.
    if (this.config.includeClient && this.config.includeQueryBuilders)
      files.push({ content: this.queriesFile(), path: `${base}/queries.go`, type: "queries" });

    return files;
  }

  // -- Type resolution ------------------------------------------------------

  private isKnownObject(ref: TypeRef): boolean {
    return ref.kind === "object" && this.known.has(`${ref.name.module}::${ref.name.name}`);
  }

  /** Base Go type for a TypeRef without cardinality wrapping. */
  private goInner(ref: TypeRef): string {
    switch (ref.kind) {
      case "scalar":
        return scalarGo(ref.scalar);
      case "enum":
        return this.known.has(`${ref.name.module}::${ref.name.name}`) ?
          goTypeName(ref.name) :
          "json.RawMessage";
      case "object":
        return this.isKnownObject(ref) ? goTypeName(ref.name) : "json.RawMessage";
      case "array":
        return `[]${this.goInner(ref.element)}`;
      case "tuple":
      case "named_tuple":
      case "range":
      case "multirange":
        // Tuples/ranges map to raw JSON for v1 (mirrors the Rust emitter's choice).
        return "json.RawMessage";
      case "shape":
        return "json.RawMessage";
    }
  }

  /**
   * Base-struct field type with cardinality applied. A single OBJECT link
   * arrives as a one-element array of rows (`null` when an optional one is
   * empty), so it is `[]T` (nil for null; a slice also keeps recursive object
   * graphs finite); scalars stay by value. Multi -> slice; an AtMostOne scalar -> pointer.
   */
  private goFieldType(ref: TypeRef, cardinality: string): string {
    const inner = this.goInner(ref);
    const obj = this.isKnownObject(ref);
    switch (cardinality) {
      case "Empty":
        throw new Error("Go emitter: field cardinality 'Empty' has no representation");
      case "One":
        return obj ? `[]${inner}` : inner;
      case "AtMostOne":
        return obj ? `[]${inner}` : `*${inner}`;
      case "Many":
      case "AtLeastOne":
        return `[]${inner}`;
      default:
        return inner;
    }
  }

  /** Shape-field type: links are uuid foreign keys (never objects). Optional singulars become pointers. */
  private goShapeFieldType(sf: ShapeField): string {
    const inner = this.goInner(sf.type);
    if (isMulti(sf.cardinality))
      return `[]${inner}`;
    return sf.optional ? `*${inner}` : inner;
  }

  /** Whether a base-struct field should carry `,omitempty` (everything but a required scalar). */
  private fieldOmitEmpty(field: Field): boolean {
    return !(field.cardinality === "One" && !this.isKnownObject(field.type));
  }

  // -- go.mod ---------------------------------------------------------------

  private goMod(): string {
    return [
      `module ${PACKAGE}`,
      "",
      "go 1.21",
      ""
    ]
      .join("\n");
  }

  // -- models.go ------------------------------------------------------------

  private modelsFile(): string {
    let body = "";
    // A type may be keyed under both its bare and qualified name; emit each Go
    // type name only once across the whole flat package.
    const seen = new Set<string>();

    for (const mod of this.ir.modules) {
      for (const e of mod.enums) {
        const name = goTypeName(e.name);
        if (seen.has(name))
          continue;
        seen.add(name);
        body += this.emitEnum(e, name);
        body += "\n";
      }
      for (const obj of mod.objects) {
        const name = goTypeName(obj.name);
        if (seen.has(name))
          continue;
        seen.add(name);
        body += this.emitStruct(obj, name);
        body += "\n";
        body += this.emitShapeStruct(`${name}Insert`, obj.shapes.insert.fields);
        body += "\n";
        body += this.emitShapeStruct(`${name}Update`, obj.shapes.update.fields);
        body += "\n";
        body += this.emitMutationResult(obj, name);
        body += "\n";
      }
    }

    if (this.floatJSON)
      body += FLOAT_JSON_GO;

    return this.fileHeader(body) + body;
  }

  private emitEnum(e: EnumType, name: string): string {
    let out = "";
    out += `type ${name} string\n\n`;
    out += "const (\n";
    for (const member of e.members) {
      out += `\t${name}${enumMemberIdent(member)} ${name} = ${JSON.stringify(member)}\n`;
    }
    out += ")\n";
    return out;
  }

  private emitStruct(obj: ObjectType, name: string): string {
    return this.emitFields(
      name,
      obj.fields.map(field => ({
        ident: pascalize(field.name),
        tag: this.fieldOmitEmpty(field) ? `${field.name},omitempty` : field.name,
        type: this.goFieldType(field.type, field.cardinality)
      }))
    );
  }

  /**
   * What `Insert` and `Update` return: the stored row, not a shape -- `ID`,
   * every stored property and each single link as its target's id (nil when
   * an optional one is unset); no multi links or computed fields. The server
   * answers a mutation with the set of rows it wrote; `Update` of a missing id
   * is nil.
   */
  private emitMutationResult(obj: ObjectType, name: string): string {
    return this.emitFields(
      `${name}MutationResult`,
      obj
        .fields
        .filter(field => !field.isComputed && !(field.isLink && isMulti(field.cardinality)))
        .map(field => {
          if (!field.isLink)
            return {
              ident: pascalize(field.name),
              tag: this.fieldOmitEmpty(field) ? `${field.name},omitempty` : field.name,
              type: this.goFieldType(field.type, field.cardinality)
            };
          const required = field.cardinality === "One";
          return { ident: pascalize(field.name), tag: required ? field.name : `${field.name},omitempty`, type: required ? "string" : "*string" };
        })
    );
  }

  private emitShapeStruct(name: string, fields: ShapeField[]): string {
    return this.emitFields(
      name,
      fields.map(sf => ({
        ident: pascalize(sf.name),
        tag: sf.optional ? `${sf.name},omitempty` : sf.name,
        type: this.goShapeFieldType(sf)
      }))
    );
  }

  /** A struct of `fields`, with the JSON methods of its float fields (see {@link emitFloatJSON}). */
  private emitFields(name: string, fields: GoField[]): string {
    let out = "";
    out += `type ${name} struct {\n`;
    for (const field of fields)
      out += `\t${field.ident} ${field.type} \`json:${JSON.stringify(field.tag)}\`\n`;
    out += "}\n";
    return out + this.emitFloatJSON(name, fields);
  }

  /**
   * `UnmarshalJSON` and `MarshalJSON` for a struct with float fields. JSON has
   * no number for a NaN or ±Infinity float; Disc (like PostgreSQL and Gel)
   * writes and reads them as the strings "NaN", "Infinity" and "-Infinity",
   * which encoding/json can't put in a float64 (nor write one as). The fields
   * keep their float types: each method shadows them with a same-named field
   * of FLOAT_JSON_GO's `discFloat64`/`discFloat32` (a field of the outer
   * struct wins over the embedded alias's), converted from or to the field.
   */
  private emitFloatJSON(name: string, fields: GoField[]): string {
    const floats = fields.flatMap(field => {
      const match = FLOAT_FIELD.exec(field.type);
      return match ? [{ ...field, bits: match[3], pointer: match[1] === "*", slices: match[2] }] : [];
    });
    if (floats.length === 0)
      return "";
    this.floatJSON = true;

    // FLOAT_JSON_GO's converter of a slice field's floats.
    const converter = (field: typeof floats[number]): string =>
      `convert${field.pointer ? "Optional" : ""}${field.slices === "[][]" ? "FloatSlices" : "Floats"}`;

    const shadows = (decode: boolean): string =>
      floats
        .map(field => {
          const disc = `discFloat${field.bits}`;
          const type = field.slices ? `${field.pointer ? "*" : ""}${field.slices}${disc}` : field.pointer || decode ? `*${disc}` : disc;
          return `\t\t${field.ident} ${type} \`json:${JSON.stringify(field.tag)}\`\n`;
        })
        .join("");

    let out = "\n";
    out += "// UnmarshalJSON reads the float fields, whose NaN and ±Infinity arrive as the strings \"NaN\", \"Infinity\" and \"-Infinity\".\n";
    out += `func (v *${name}) UnmarshalJSON(data []byte) error {\n`;
    out += `\ttype alias ${name}\n`;
    out += "\taux := struct {\n\t\t*alias\n";
    out += shadows(true);
    const direct = floats.filter(field => !field.pointer && !field.slices);
    out += `\t}{${["alias: (*alias)(v)", ...direct.map(field => `${field.ident}: (*discFloat${field.bits})(&v.${field.ident})`)].join(", ")}}\n`;
    out += "\tif err := json.Unmarshal(data, &aux); err != nil {\n\t\treturn err\n\t}\n";
    for (const field of floats) {
      const float = `float${field.bits}`;
      if (field.slices)
        out += `\tv.${field.ident} = ${converter(field)}[${float}](aux.${field.ident})\n`;
      else if (field.pointer)
        out += `\tv.${field.ident} = (*${float})(aux.${field.ident})\n`;
    }
    out += "\treturn nil\n";
    out += "}\n\n";

    out += "// MarshalJSON writes the float fields' NaN and ±Infinity as the strings \"NaN\", \"Infinity\" and \"-Infinity\", which encoding/json refuses.\n";
    out += `func (v ${name}) MarshalJSON() ([]byte, error) {\n`;
    out += `\ttype alias ${name}\n`;
    out += "\treturn json.Marshal(struct {\n\t\talias\n";
    out += shadows(false);
    const values = floats.map(field => {
      const disc = `discFloat${field.bits}`;
      const value = field.slices ?
        `${converter(field)}[${disc}](v.${field.ident})` :
        field.pointer ?
        `(*${disc})(v.${field.ident})` :
        `${disc}(v.${field.ident})`;
      return `${field.ident}: ${value}`;
    });
    out += `\t}{${["alias: alias(v)", ...values].join(", ")}})\n`;
    out += "}\n";
    return out;
  }

  // -- queries.go -----------------------------------------------------------

  /** EdgeQL type name for query strings (qualified only in multi-module schemas). */
  private edgeqlTypeName(obj: ObjectType): string {
    const module = obj.name.module;
    return this.ir.multiModule && module && module !== "default" ?
      `${module}::${obj.name.name}` :
      obj.name.name;
  }

  private queriesFile(): string {
    let body = "";
    const seen = new Set<string>();

    for (const mod of this.ir.modules) {
      for (const obj of mod.objects) {
        const name = goTypeName(obj.name);
        if (seen.has(name))
          continue;
        seen.add(name);
        body += this.emitBuilder(obj, name);
        body += "\n";
      }
    }

    // Delete answers how many objects it deleted (the server answers with the deleted rows; they are counted).
    if (this.config.includeMutations) {
      body += "// DeleteResult is what Delete returns: how many objects it deleted (0 or 1 by id).\n";
      body += "type DeleteResult struct {\n\tDeleted int64 `json:\"deleted\"`\n}\n";
    }

    return this.fileHeader(body) + body;
  }

  private emitBuilder(obj: ObjectType, name: string): string {
    const builder = `${name}QueryBuilder`;
    const etype = this.edgeqlTypeName(obj);

    let out = "";
    out += `type ${builder} struct {\n`;
    out += "\tclient *DiscClient\n";
    out += "}\n\n";

    out += `func New${builder}(client *DiscClient) *${builder} {\n`;
    out += `\treturn &${builder}{client: client}\n`;
    out += "}\n\n";

    out += this.emitSelectFns(builder, name, etype);
    // --no-mutations drops the write methods (and their helpers); reads stay.
    if (this.config.includeMutations) {
      out += this.emitTypeCastFn(builder, obj);
      out += this.emitMultiLinkFn(builder, obj);
      // Multi scalar properties: the whole set is bound as one array
      // parameter and assigned with `array_unpack(<array<T>>$p)`.
      const multiProperties = obj
        .fields
        .filter(field => !field.isLink && !field.isComputed && isMulti(field.cardinality))
        .map(field => field.name);
      if (multiProperties.length > 0)
        out += this.emitMultiPropertyFn(builder, multiProperties);
      out += this.emitInsertFn(builder, name, etype, multiProperties.length > 0);
      out += this.emitUpdateFn(builder, name, etype, multiProperties.length > 0);
      out += this.emitDeleteFn(builder, etype);
    }
    out += this.emitCountFn(builder, etype);

    return out;
  }

  private emitSelectFns(builder: string, name: string, etype: string): string {
    let out = "";

    out += `func (b *${builder}) Select(shape string) ([]${name}, error) {\n`;
    out += `\tquery := ${JSON.stringify(`select ${etype} { * }`)}\n`;
    out += "\tif shape != \"\" {\n";
    out += `\t\tquery = fmt.Sprintf("select ${etype} %s", shape)\n`;
    out += "\t}\n";
    out += `\treturn queryMany[${name}](b.client, query, nil)\n`;
    out += "}\n\n";

    out += `func (b *${builder}) SelectByID(id string, shape string) (*${name}, error) {\n`;
    out += `\tquery := ${JSON.stringify(`select ${etype} { * } filter .id = <uuid>$id`)}\n`;
    out += "\tif shape != \"\" {\n";
    out += `\t\tquery = fmt.Sprintf("select ${etype} %s filter .id = <uuid>$id", shape)\n`;
    out += "\t}\n";
    out += `\treturn queryMaybe[${name}](b.client, query, map[string]any{"id": id})\n`;
    out += "}\n\n";

    out += `func (b *${builder}) Filter(condition string, variables map[string]any) ([]${name}, error) {\n`;
    out += `\tquery := ${JSON.stringify(`select ${etype} { * }`)}\n`;
    out += "\tif condition != \"\" {\n";
    out += `\t\tquery = fmt.Sprintf("select ${etype} { * } filter %s", condition)\n`;
    out += "\t}\n";
    out += `\treturn queryMany[${name}](b.client, query, variables)\n`;
    out += "}\n\n";

    return out;
  }

  private emitTypeCastFn(builder: string, obj: ObjectType): string {
    const arms: string[] = [];
    for (const field of obj.fields) {
      if (field.isComputed || field.name === "id")
        continue;
      if (field.isLink) {
        if (!isMulti(field.cardinality))
          arms.push(`\tcase ${JSON.stringify(field.name)}:\n\t\treturn "<uuid>"`);
        continue;
      }
      const elementCast = Types.mapEdgeQLTypeToEdgeQLCast(field.baseType ?? field.sourceType);
      const cast = isMulti(field.cardinality) ? `<array${elementCast}>` : elementCast;
      arms.push(`\tcase ${JSON.stringify(field.name)}:\n\t\treturn ${JSON.stringify(cast)}`);
    }
    let out = "";
    out += `func (b *${builder}) typeCast(field string) string {\n`;
    out += "\tswitch field {\n";
    out += arms.length > 0 ? arms.join("\n") + "\n" : "";
    out += "\t}\n";
    out += "\treturn \"<str>\"\n";
    out += "}\n\n";
    return out;
  }

  private emitMultiLinkFn(builder: string, obj: ObjectType): string {
    const arms: string[] = [];
    for (const field of obj.fields) {
      if (!field.isLink || field.isComputed)
        continue;
      if (!isMulti(field.cardinality))
        continue;
      const target = field.type.kind === "object" ? field.type.name.name : "unknown";
      arms.push(`\tcase ${JSON.stringify(field.name)}:\n\t\treturn ${JSON.stringify(target)}, true`);
    }
    let out = "";
    out += `func (b *${builder}) multiLinkTarget(field string) (string, bool) {\n`;
    out += "\tswitch field {\n";
    out += arms.length > 0 ? arms.join("\n") + "\n" : "";
    out += "\t}\n";
    out += "\treturn \"\", false\n";
    out += "}\n\n";
    return out;
  }

  private emitMultiPropertyFn(builder: string, names: string[]): string {
    let out = "";
    out += `func (b *${builder}) isMultiProperty(field string) bool {\n`;
    out += "\tswitch field {\n";
    out += `\tcase ${names.map(n => JSON.stringify(n)).join(", ")}:\n\t\treturn true\n`;
    out += "\t}\n";
    out += "\treturn false\n";
    out += "}\n\n";
    return out;
  }

  private emitInsertFn(builder: string, name: string, etype: string, hasMultiProperties: boolean): string {
    let out = "";
    out += `func (b *${builder}) Insert(data ${name}Insert) (${name}MutationResult, error) {\n`;
    out += `\tvar zero ${name}MutationResult\n`;
    out += "\traw, err := json.Marshal(data)\n";
    out += "\tif err != nil {\n\t\treturn zero, err\n\t}\n";
    out += "\tvar obj map[string]json.RawMessage\n";
    out += "\tif err := json.Unmarshal(raw, &obj); err != nil {\n\t\treturn zero, err\n\t}\n";
    out += "\tassignments := make([]string, 0, len(obj))\n";
    out += "\tvariables := make(map[string]any, len(obj))\n";
    // Iterate keys in sorted order: the server binds params positionally, and
    // Go's json.Marshal emits the variables map with sorted keys — so the
    // assignment order must match (map-iteration order is non-deterministic).
    out += "\tkeys := make([]string, 0, len(obj))\n";
    out += "\tfor key := range obj {\n\t\tkeys = append(keys, key)\n\t}\n";
    out += "\tsort.Strings(keys)\n";
    out += "\tfor _, key := range keys {\n";
    out += "\t\tval := obj[key]\n";
    out += "\t\tvariables[key] = val\n";
    out += "\t\tif target, ok := b.multiLinkTarget(key); ok {\n";
    out += "\t\t\tassignments = append(assignments, fmt.Sprintf(\"%s := (select %s filter .id in array_unpack(<array<uuid>>$%s))\", key, target, key))\n";
    if (hasMultiProperties) {
      out += "\t\t} else if b.isMultiProperty(key) {\n";
      out += "\t\t\tassignments = append(assignments, fmt.Sprintf(\"%s := array_unpack(%s$%s)\", key, b.typeCast(key), key))\n";
    }
    out += "\t\t} else {\n";
    out += "\t\t\tassignments = append(assignments, fmt.Sprintf(\"%s := %s$%s\", key, b.typeCast(key), key))\n";
    out += "\t\t}\n";
    out += "\t}\n";
    out += `\tquery := fmt.Sprintf("insert ${etype} { %s }", strings.Join(assignments, ", "))\n`;
    out += `\treturn queryOne[${name}MutationResult](b.client, query, variables)\n`;
    out += "}\n\n";
    return out;
  }

  private emitUpdateFn(builder: string, name: string, etype: string, hasMultiProperties: boolean): string {
    let out = "";
    out += `func (b *${builder}) Update(id string, data ${name}Update) (*${name}MutationResult, error) {\n`;
    out += "\traw, err := json.Marshal(data)\n";
    out += "\tif err != nil {\n\t\treturn nil, err\n\t}\n";
    out += "\tvar obj map[string]json.RawMessage\n";
    out += "\tif err := json.Unmarshal(raw, &obj); err != nil {\n\t\treturn nil, err\n\t}\n";
    out += "\tassignments := make([]string, 0, len(obj))\n";
    out += "\tvariables := map[string]any{\"id\": id}\n";
    // Iterate keys in sorted order: the server binds params positionally, and
    // Go's json.Marshal emits the variables map with sorted keys — so the
    // assignment order must match (map-iteration order is non-deterministic).
    out += "\tkeys := make([]string, 0, len(obj))\n";
    out += "\tfor key := range obj {\n\t\tkeys = append(keys, key)\n\t}\n";
    out += "\tsort.Strings(keys)\n";
    out += "\tfor _, key := range keys {\n";
    out += "\t\tval := obj[key]\n";
    out += "\t\tvariables[key] = val\n";
    out += "\t\tif target, ok := b.multiLinkTarget(key); ok {\n";
    out += "\t\t\tassignments = append(assignments, fmt.Sprintf(\"%s := (select %s filter .id in array_unpack(<array<uuid>>$%s))\", key, target, key))\n";
    if (hasMultiProperties) {
      out += "\t\t} else if b.isMultiProperty(key) {\n";
      out += "\t\t\tassignments = append(assignments, fmt.Sprintf(\"%s := array_unpack(%s$%s)\", key, b.typeCast(key), key))\n";
    }
    out += "\t\t} else {\n";
    out += "\t\t\tassignments = append(assignments, fmt.Sprintf(\"%s := %s$%s\", key, b.typeCast(key), key))\n";
    out += "\t\t}\n";
    out += "\t}\n";
    out += `\tquery := fmt.Sprintf("update ${etype} filter .id = <uuid>$id set { %s }", strings.Join(assignments, ", "))\n`;
    out += `\treturn queryMaybe[${name}MutationResult](b.client, query, variables)\n`;
    out += "}\n\n";
    return out;
  }

  private emitDeleteFn(builder: string, etype: string): string {
    let out = "";
    out += `func (b *${builder}) Delete(id string) (DeleteResult, error) {\n`;
    out += `\trows, err := queryMany[json.RawMessage](b.client, ${JSON.stringify(`delete ${etype} filter .id = <uuid>$id`)}, map[string]any{"id": id})\n`;
    out += "\treturn DeleteResult{Deleted: int64(len(rows))}, err\n";
    out += "}\n\n";
    return out;
  }

  private emitCountFn(builder: string, etype: string): string {
    let out = "";
    out += `func (b *${builder}) Count(condition string, variables map[string]any) (int64, error) {\n`;
    out += `\tquery := ${JSON.stringify(`select count(${etype})`)}\n`;
    out += "\tif condition != \"\" {\n";
    out += `\t\tquery = fmt.Sprintf("select count(${etype} filter %s)", condition)\n`;
    out += "\t}\n";
    out += "\treturn queryScalar(b.client, query, variables)\n";
    out += "}\n\n";
    return out;
  }

  // -- util -----------------------------------------------------------------

  /** Package clause + the minimal stdlib import block actually referenced by `body`. */
  private fileHeader(body: string): string {
    const used = STD_IMPORTS.filter(i => body.includes(i.selector));
    let head = "// Code generated by the Disc Go codegen (codegen IR). DO NOT EDIT.\n\n";
    head += `package ${PACKAGE}\n\n`;
    if (used.length === 1) {
      head += `import ${JSON.stringify(used[0].path)}\n\n`;
    } else if (used.length > 1) {
      head += "import (\n";
      for (const i of used)
        head += `\t${JSON.stringify(i.path)}\n`;
      head += ")\n\n";
    }
    return head;
  }
}

/*** RUNTIME ------------------------------------------ ***/

/**
 * The float JSON the generated `UnmarshalJSON`/`MarshalJSON` methods use (see
 * `emitFloatJSON`), appended to models.go when a struct has float fields.
 */
const FLOAT_JSON_GO = `// discFloat64 and discFloat32 are floats as Disc's JSON carries them: numbers, with NaN
// and ±Infinity as the strings "NaN", "Infinity" and "-Infinity" (PostgreSQL's and Gel's
// JSON form), which encoding/json can't read into a float nor write.
type discFloat64 float64

type discFloat32 float32

func (f discFloat64) MarshalJSON() ([]byte, error) {
	return marshalFloat(float64(f), 64)
}

func (f *discFloat64) UnmarshalJSON(data []byte) error {
	x, err := unmarshalFloat(data)
	*f = discFloat64(x)
	return err
}

func (f discFloat32) MarshalJSON() ([]byte, error) {
	return marshalFloat(float64(f), 32)
}

func (f *discFloat32) UnmarshalJSON(data []byte) error {
	x, err := unmarshalFloat(data)
	*f = discFloat32(x)
	return err
}

func marshalFloat(x float64, bits int) ([]byte, error) {
	switch {
	case math.IsNaN(x):
		return []byte(\`"NaN"\`), nil
	case math.IsInf(x, 1):
		return []byte(\`"Infinity"\`), nil
	case math.IsInf(x, -1):
		return []byte(\`"-Infinity"\`), nil
	case bits == 32:
		return json.Marshal(float32(x))
	}
	return json.Marshal(x)
}

func unmarshalFloat(data []byte) (float64, error) {
	switch string(data) {
	case \`"NaN"\`:
		return math.NaN(), nil
	case \`"Infinity"\`:
		return math.Inf(1), nil
	case \`"-Infinity"\`:
		return math.Inf(-1), nil
	case "null":
		return 0, nil
	}
	var x float64
	err := json.Unmarshal(data, &x)
	return x, err
}

// convertFloats copies floats to another float type; nil stays nil.
func convertFloats[To, From ~float32 | ~float64](floats []From) []To {
	if floats == nil {
		return nil
	}
	out := make([]To, len(floats))
	for i, x := range floats {
		out[i] = To(x)
	}
	return out
}

// convertOptionalFloats is convertFloats through a pointer; nil stays nil.
func convertOptionalFloats[To, From ~float32 | ~float64](floats *[]From) *[]To {
	if floats == nil {
		return nil
	}
	out := convertFloats[To](*floats)
	return &out
}

// convertFloatSlices is convertFloats for each slice of a slice; nil stays nil.
func convertFloatSlices[To, From ~float32 | ~float64](slices [][]From) [][]To {
	if slices == nil {
		return nil
	}
	out := make([][]To, len(slices))
	for i, floats := range slices {
		out[i] = convertFloats[To](floats)
	}
	return out
}

// convertOptionalFloatSlices is convertFloatSlices through a pointer; nil stays nil.
func convertOptionalFloatSlices[To, From ~float32 | ~float64](slices *[][]From) *[][]To {
	if slices == nil {
		return nil
	}
	out := convertFloatSlices[To](*slices)
	return &out
}
`;

/**
 * Static, schema-independent runtime: a minimal Disc client over net/http that
 * POSTs `{ "query": ..., "variables": ... }` to the server's `/query` endpoint
 * and decodes the `{ data, errors }` envelope. Generic helpers (Go 1.21) decode
 * `data` into the caller's type. Stdlib-only — builds fully offline.
 */
const RUNTIME_GO = `// Code generated by the Disc Go codegen (codegen IR). DO NOT EDIT.

package ${PACKAGE}

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
)

// DiscClient is a minimal HTTP client that POSTs EdgeQL to the server's /query endpoint.
type DiscClient struct {
	BaseURL    string
	Path       string
	HTTPClient *http.Client
}

// NewDiscClient builds a client for the given server base URL (e.g. "http://localhost:5432").
func NewDiscClient(baseURL string) *DiscClient {
	return &DiscClient{BaseURL: baseURL, Path: "/query", HTTPClient: http.DefaultClient}
}

// execute POSTs { query, variables } and returns the response's \`data\` payload,
// surfacing any \`errors\` array as a Go error.
func (c *DiscClient) execute(query string, variables map[string]any) (json.RawMessage, error) {
	payload := map[string]any{"query": query, "variables": variables}
	buf, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequest(http.MethodPost, c.BaseURL+c.Path, bytes.NewReader(buf))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var envelope struct {
		Data   json.RawMessage \`json:"data"\`
		Errors json.RawMessage \`json:"errors"\`
	}
	if err := json.NewDecoder(resp.Body).Decode(&envelope); err != nil {
		return nil, err
	}

	if len(envelope.Errors) > 0 && string(envelope.Errors) != "null" {
		return nil, fmt.Errorf("disc server error: %s", string(envelope.Errors))
	}
	return envelope.Data, nil
}

func queryMany[T any](c *DiscClient, query string, variables map[string]any) ([]T, error) {
	data, err := c.execute(query, variables)
	if err != nil {
		return nil, err
	}
	var out []T
	if len(data) == 0 || string(data) == "null" {
		return out, nil
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// queryOne is the one element of a query's result set (an error when it is empty).
func queryOne[T any](c *DiscClient, query string, variables map[string]any) (T, error) {
	var out T
	items, err := queryMany[T](c, query, variables)
	if err != nil {
		return out, err
	}
	if len(items) == 0 {
		return out, fmt.Errorf("disc: the query returned no result")
	}
	return items[0], nil
}

func queryMaybe[T any](c *DiscClient, query string, variables map[string]any) (*T, error) {
	items, err := queryMany[T](c, query, variables)
	if err != nil {
		return nil, err
	}
	if len(items) == 0 {
		return nil, nil
	}
	return &items[0], nil
}

// queryScalar is the one int64 a query such as select count(...) answers.
func queryScalar(c *DiscClient, query string, variables map[string]any) (int64, error) {
	return queryOne[int64](c, query, variables)
}
`;
