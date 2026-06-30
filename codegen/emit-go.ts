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
    // decimal/bigint/uuid/datetime/durations/bytes/memory: lossless as JSON strings.
    default:
      return "string";
  }
}

/** Candidate standard-library imports, matched against a file body by selector. */
const STD_IMPORTS: ReadonlyArray<{ path: string; selector: string; }> = [
  { path: "bytes", selector: "bytes." },
  { path: "encoding/json", selector: "json." },
  { path: "fmt", selector: "fmt." },
  { path: "net/http", selector: "http." },
  { path: "strings", selector: "strings." }
];

function isMulti(cardinality: string): boolean {
  return cardinality === "Many" || cardinality === "AtLeastOne";
}

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
   * Base-struct field type with cardinality applied. Single OBJECT links become
   * `*T` (pointer — needed for nullability and recursive object graphs); scalars
   * stay by value. Multi -> slice; AtMostOne -> pointer.
   */
  private goFieldType(ref: TypeRef, cardinality: string): string {
    const inner = this.goInner(ref);
    const obj = this.isKnownObject(ref);
    switch (cardinality) {
      case "Empty":
        throw new Error("Go emitter: field cardinality 'Empty' has no representation");
      case "One":
        return obj ? `*${inner}` : inner;
      case "AtMostOne":
        return `*${inner}`;
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
    ].join("\n");
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
      }
    }

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
    let out = "";
    out += `type ${name} struct {\n`;
    for (const field of obj.fields) {
      const ident = pascalize(field.name);
      const ty = this.goFieldType(field.type, field.cardinality);
      const tag = this.fieldOmitEmpty(field) ?
        `${field.name},omitempty` :
        field.name;
      out += `\t${ident} ${ty} \`json:${JSON.stringify(tag)}\`\n`;
    }
    out += "}\n";
    return out;
  }

  private emitShapeStruct(name: string, fields: ShapeField[]): string {
    let out = "";
    out += `type ${name} struct {\n`;
    for (const sf of fields) {
      const ident = pascalize(sf.name);
      const ty = this.goShapeFieldType(sf);
      const tag = sf.optional ? `${sf.name},omitempty` : sf.name;
      out += `\t${ident} ${ty} \`json:${JSON.stringify(tag)}\`\n`;
    }
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
      out += this.emitInsertFn(builder, name, etype);
      out += this.emitUpdateFn(builder, name, etype);
      out += this.emitDeleteFn(builder, name, etype);
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
      const cast = Types.mapEdgeQLTypeToEdgeQLCast(field.sourceType);
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

  private emitInsertFn(builder: string, name: string, etype: string): string {
    let out = "";
    out += `func (b *${builder}) Insert(data ${name}Insert) (${name}, error) {\n`;
    out += `\tvar zero ${name}\n`;
    out += "\traw, err := json.Marshal(data)\n";
    out += "\tif err != nil {\n\t\treturn zero, err\n\t}\n";
    out += "\tvar obj map[string]json.RawMessage\n";
    out += "\tif err := json.Unmarshal(raw, &obj); err != nil {\n\t\treturn zero, err\n\t}\n";
    out += "\tassignments := make([]string, 0, len(obj))\n";
    out += "\tvariables := make(map[string]any, len(obj))\n";
    out += "\tfor key, val := range obj {\n";
    out += "\t\tvariables[key] = val\n";
    out += "\t\tif target, ok := b.multiLinkTarget(key); ok {\n";
    out += "\t\t\tassignments = append(assignments, fmt.Sprintf(\"%s := (select %s filter .id in array_unpack(<array<uuid>>$%s))\", key, target, key))\n";
    out += "\t\t} else {\n";
    out += "\t\t\tassignments = append(assignments, fmt.Sprintf(\"%s := %s$%s\", key, b.typeCast(key), key))\n";
    out += "\t\t}\n";
    out += "\t}\n";
    out += `\tquery := fmt.Sprintf("insert ${etype} { %s }", strings.Join(assignments, ", "))\n`;
    out += `\treturn queryOne[${name}](b.client, query, variables)\n`;
    out += "}\n\n";
    return out;
  }

  private emitUpdateFn(builder: string, name: string, etype: string): string {
    let out = "";
    out += `func (b *${builder}) Update(id string, data ${name}Update) (${name}, error) {\n`;
    out += `\tvar zero ${name}\n`;
    out += "\traw, err := json.Marshal(data)\n";
    out += "\tif err != nil {\n\t\treturn zero, err\n\t}\n";
    out += "\tvar obj map[string]json.RawMessage\n";
    out += "\tif err := json.Unmarshal(raw, &obj); err != nil {\n\t\treturn zero, err\n\t}\n";
    out += "\tassignments := make([]string, 0, len(obj))\n";
    out += "\tvariables := map[string]any{\"id\": id}\n";
    out += "\tfor key, val := range obj {\n";
    out += "\t\tvariables[key] = val\n";
    out += "\t\tif target, ok := b.multiLinkTarget(key); ok {\n";
    out += "\t\t\tassignments = append(assignments, fmt.Sprintf(\"%s := (select %s filter .id in array_unpack(<array<uuid>>$%s))\", key, target, key))\n";
    out += "\t\t} else {\n";
    out += "\t\t\tassignments = append(assignments, fmt.Sprintf(\"%s := %s$%s\", key, b.typeCast(key), key))\n";
    out += "\t\t}\n";
    out += "\t}\n";
    out += `\tquery := fmt.Sprintf("update ${etype} filter .id = <uuid>$id set { %s }", strings.Join(assignments, ", "))\n`;
    out += `\treturn queryOne[${name}](b.client, query, variables)\n`;
    out += "}\n\n";
    return out;
  }

  private emitDeleteFn(builder: string, name: string, etype: string): string {
    let out = "";
    out += `func (b *${builder}) Delete(id string) (${name}, error) {\n`;
    out += `\treturn queryOne[${name}](b.client, ${JSON.stringify(`delete ${etype} filter .id = <uuid>$id`)}, map[string]any{"id": id})\n`;
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

func queryOne[T any](c *DiscClient, query string, variables map[string]any) (T, error) {
	var out T
	data, err := c.execute(query, variables)
	if err != nil {
		return out, err
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return out, err
	}
	return out, nil
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

func queryScalar(c *DiscClient, query string, variables map[string]any) (int64, error) {
	data, err := c.execute(query, variables)
	if err != nil {
		return 0, err
	}
	var n int64
	if err := json.Unmarshal(data, &n); err != nil {
		return 0, err
	}
	return n, nil
}
`;
