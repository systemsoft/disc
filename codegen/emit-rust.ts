/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Rust emitter on the codegen IR.
 *
 * Second consumer of the language-neutral IR (`codegen/ir.ts`), proving the
 * contract generalizes beyond TypeScript: adding a language is "write one
 * emitter," never "touch a frontend." This file reads only IR nodes (plus the
 * shared EdgeQL cast helper from `types.ts`) and produces a self-contained Rust
 * crate — structs, enums, insert/update shapes, per-object query builders, and a
 * std-only blocking HTTP runtime — that compiles offline against serde +
 * serde_json with no further dependencies.
 *
 * It never re-derives schema semantics: insert/update field inclusion and
 * optionality come from the IR's denormalized shapes, mirroring emit-typescript.ts.
 */

/*** UTILITY ------------------------------------------ ***/

import * as Types from "./types.ts";
import type {
  CodegenIR,
  EnumType,
  Field,
  Module,
  ObjectType,
  QualifiedName,
  ScalarKind,
  ShapeField,
  TypeRef
} from "./ir.ts";

/*** EXPORT ------------------------------------------- ***/

/** Emit the Rust client crate source set from the IR. */
export function emitRust(ir: CodegenIR, config: Types.CodegenConfig): Types.GeneratedFile[] {
  return new RustEmitter(ir, config).generate();
}

/*** HELPER ------------------------------------------- ***/

/**
 * Canonical scalar -> native Rust type (JSON-friendly, serde-only deps). A
 * switch (rather than a record) keeps the snake_case scalar kinds off object
 * keys, which the project's camelCase lint forbids.
 */
function scalarRust(kind: ScalarKind): string {
  switch (kind) {
    case "bool":
      return "bool";
    case "int16":
      return "i16";
    case "int32":
      return "i32";
    case "int64":
      return "i64";
    case "float32":
      return "f32";
    case "float64":
      return "f64";
    case "json":
      return "serde_json::Value";
    // decimal/bigint/uuid/datetime/durations/bytes/memory: lossless as JSON strings.
    default:
      return "String";
  }
}

/** Rust keywords that ARE valid as raw identifiers (`r#name`). */
const RAW_KEYWORDS: ReadonlySet<string> = new Set([
  "as",
  "break",
  "const",
  "continue",
  "dyn",
  "else",
  "enum",
  "extern",
  "false",
  "fn",
  "for",
  "if",
  "impl",
  "in",
  "let",
  "loop",
  "match",
  "mod",
  "move",
  "mut",
  "pub",
  "ref",
  "return",
  "static",
  "struct",
  "trait",
  "true",
  "type",
  "unsafe",
  "use",
  "where",
  "while",
  "async",
  "await",
  "abstract",
  "become",
  "box",
  "do",
  "final",
  "macro",
  "override",
  "priv",
  "typeof",
  "unsized",
  "virtual",
  "yield",
  "try",
  "union"
]);

/** Keywords that cannot be raw identifiers — suffix with `_` + serde rename. */
const NON_RAW_KEYWORDS: ReadonlySet<string> = new Set([
  "crate",
  "self",
  "Self",
  "super"
]);

function isMulti(cardinality: string): boolean {
  return cardinality === "Many" || cardinality === "AtLeastOne";
}

/** Render a QualifiedName as an absolute crate path (`crate::Name` / `crate::mod::Name`). */
function cratePathOf(qn: QualifiedName): string {
  return qn.module === "default" ? `crate::${qn.name}` : `crate::${qn.module}::${qn.name}`;
}

/** A field/variant identifier plus optional serde rename when it diverges from the source name. */
interface RustIdent {
  ident: string;
  rename?: string;
}

/** Map a schema field name to a valid Rust field identifier (verbatim unless a keyword). */
function rustFieldIdent(name: string): RustIdent {
  if (NON_RAW_KEYWORDS.has(name))
    return { ident: `${name}_`, rename: name };
  if (RAW_KEYWORDS.has(name))
    return { ident: `r#${name}` };
  return { ident: name };
}

/** Map an enum member string to a valid PascalCase Rust variant identifier. */
function rustVariantIdent(member: string): string {
  const parts = member.split(/[^A-Za-z0-9]+/).filter(p => p.length > 0);
  let ident = parts
    .map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join("");
  if (ident.length === 0 || /^[0-9]/.test(ident))
    ident = `_${ident}`;
  return ident;
}

class RustEmitter {
  private config: Types.CodegenConfig;
  private ir: CodegenIR;
  /** Qualified keys ("module::name") of every object + enum the crate defines. */
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
    return [
      { content: this.cargoToml(), path: `${base}/Cargo.toml`, type: "types" },
      { content: this.libRs(), path: `${base}/src/lib.rs`, type: "types" },
      { content: RUNTIME_RS, path: `${base}/src/disc_runtime.rs`, type: "client" }
    ];
  }

  // -- Type resolution ------------------------------------------------------

  private isKnownObject(ref: TypeRef): boolean {
    return ref.kind === "object" && this.known.has(`${ref.name.module}::${ref.name.name}`);
  }

  /** Base Rust type for a TypeRef without cardinality wrapping (no boxing). */
  private rustInner(ref: TypeRef): string {
    switch (ref.kind) {
      case "scalar":
        return scalarRust(ref.scalar);
      case "enum":
        return this.known.has(`${ref.name.module}::${ref.name.name}`) ?
          cratePathOf(ref.name) :
          "serde_json::Value";
      case "object":
        return this.isKnownObject(ref) ? cratePathOf(ref.name) : "serde_json::Value";
      case "array":
        return `Vec<${this.rustInner(ref.element)}>`;
      case "tuple": {
        const els = ref.elements.map(e => this.rustInner(e));
        // A 1-tuple needs the trailing comma: `(A,)`.
        return els.length === 1 ? `(${els[0]},)` : `(${els.join(", ")})`;
      }
      case "named_tuple":
        // Named tuples map to dynamic JSON for v1 (avoids hoisting struct names).
        return "serde_json::Value";
      case "range":
      case "multirange":
        // Ranges map to dynamic JSON for v1.
        return "serde_json::Value";
      case "shape":
        return "serde_json::Value";
    }
  }

  /**
   * Field type with cardinality applied. Single object refs are boxed so cyclic
   * object graphs (e.g. A.b: B / B.a: A) remain finite-sized and compile.
   */
  private rustFieldType(ref: TypeRef, cardinality: string): string {
    const inner = this.rustInner(ref);
    const obj = this.isKnownObject(ref);
    switch (cardinality) {
      case "Empty":
        throw new Error("Rust emitter: field cardinality 'Empty' has no representation");
      case "One":
        return obj ? `Box<${inner}>` : inner;
      case "AtMostOne":
        return obj ? `Option<Box<${inner}>>` : `Option<${inner}>`;
      case "Many":
      case "AtLeastOne":
        return `Vec<${inner}>`;
      default:
        return inner;
    }
  }

  /** Shape field type: links are uuid foreign keys (never objects), so no boxing. */
  private rustShapeFieldType(sf: ShapeField): string {
    const inner = this.rustInner(sf.type);
    const base = isMulti(sf.cardinality) ? `Vec<${inner}>` : inner;
    return sf.optional ? `Option<${base}>` : base;
  }

  // -- Cargo.toml -----------------------------------------------------------

  private cargoToml(): string {
    return [
      "[package]",
      "name = \"disc_client\"",
      "version = \"0.1.0\"",
      "edition = \"2021\"",
      "",
      "[dependencies]",
      "serde = { version = \"1\", features = [\"derive\"] }",
      "serde_json = \"1\"",
      ""
    ]
      .join("\n");
  }

  // -- lib.rs ---------------------------------------------------------------

  private libRs(): string {
    let out = "";
    out += "//! Generated Disc client (Rust) — codegen IR Rust emitter.\n";
    out += "//! DO NOT EDIT THIS FILE MANUALLY.\n";
    out += "#![allow(dead_code)]\n";
    out += "#![allow(non_snake_case)]\n";
    out += "#![allow(non_camel_case_types)]\n";
    out += "#![allow(unused_imports)]\n";
    out += "\n";
    out += "pub mod disc_runtime;\n\n";

    for (const mod of this.ir.modules) {
      if (mod.name === "default") {
        out += this.emitModuleBody(mod);
      } else {
        out += `pub mod ${mod.name} {\n`;
        out += this.indent(this.emitModuleBody(mod), "    ");
        out += "}\n\n";
      }
    }

    return out;
  }

  /** Emit one module's enums, structs, shapes and builders (crate-root or inside a `mod`). */
  private emitModuleBody(mod: Module): string {
    let out = "";
    out += "use crate::disc_runtime::{DiscClient, DiscError};\n\n";

    // A schema may key a type under both its bare and qualified name, so the
    // same definition can appear twice in a module; emit each name only once.
    const seen = new Set<string>();

    for (const e of mod.enums) {
      if (seen.has(e.name.name))
        continue;
      seen.add(e.name.name);
      out += this.emitEnum(e);
      out += "\n";
    }

    for (const obj of mod.objects) {
      if (seen.has(obj.name.name))
        continue;
      seen.add(obj.name.name);
      out += this.emitStruct(obj);
      out += "\n";
      out += this.emitInsert(obj);
      out += "\n";
      out += this.emitUpdate(obj);
      out += "\n";
      out += this.emitBuilder(obj);
      out += "\n";
    }

    return out;
  }

  // -- Enums ----------------------------------------------------------------

  private emitEnum(e: EnumType): string {
    let out = "";
    out += "#[derive(Debug, Clone, Default, serde::Deserialize, serde::Serialize)]\n";
    out += `pub enum ${e.name.name} {\n`;
    e.members.forEach((member, i) => {
      if (i === 0)
        out += "    #[default]\n";
      out += `    #[serde(rename = ${JSON.stringify(member)})]\n`;
      out += `    ${rustVariantIdent(member)},\n`;
    });
    out += "}\n";
    return out;
  }

  // -- Structs --------------------------------------------------------------

  private emitStruct(obj: ObjectType): string {
    let out = "";
    out += "#[derive(Debug, Clone, Default, serde::Deserialize)]\n";
    out += "#[allow(non_snake_case)]\n";
    out += `pub struct ${obj.name.name} {\n`;
    for (const field of obj.fields) {
      out += this.emitStructField(field);
    }
    out += "}\n";
    return out;
  }

  private emitStructField(field: Field): string {
    const id = rustFieldIdent(field.name);
    const ty = this.rustFieldType(field.type, field.cardinality);
    let out = "";
    // Tolerate fields absent from partial results (e.g. `select { * }` omits links).
    if (id.rename)
      out += `    #[serde(default, rename = ${JSON.stringify(id.rename)})]\n`;
    else
      out += "    #[serde(default)]\n";
    out += `    pub ${id.ident}: ${ty},\n`;
    return out;
  }

  // -- Insert / Update ------------------------------------------------------

  private emitInsert(obj: ObjectType): string {
    return this.emitShapeStruct(`${obj.name.name}Insert`, obj.shapes.insert.fields);
  }

  private emitUpdate(obj: ObjectType): string {
    return this.emitShapeStruct(`${obj.name.name}Update`, obj.shapes.update.fields);
  }

  private emitShapeStruct(name: string, fields: ShapeField[]): string {
    let out = "";
    out += "#[derive(Debug, Clone, Default, serde::Serialize)]\n";
    out += "#[allow(non_snake_case)]\n";
    out += `pub struct ${name} {\n`;
    for (const sf of fields) {
      const id = rustFieldIdent(sf.name);
      const ty = this.rustShapeFieldType(sf);
      const attrs: string[] = [];
      if (sf.optional)
        attrs.push("skip_serializing_if = \"Option::is_none\"");
      if (id.rename)
        attrs.push(`rename = ${JSON.stringify(id.rename)}`);
      if (attrs.length > 0)
        out += `    #[serde(${attrs.join(", ")})]\n`;
      out += `    pub ${id.ident}: ${ty},\n`;
    }
    out += "}\n";
    return out;
  }

  // -- Query builders -------------------------------------------------------

  private edgeqlTypeName(obj: ObjectType): string {
    const module = obj.name.module;
    return this.ir.multiModule && module && module !== "default" ?
      `${module}::${obj.name.name}` :
      obj.name.name;
  }

  private emitBuilder(obj: ObjectType): string {
    const name = obj.name.name;
    const builder = `${name}QueryBuilder`;
    const etype = this.edgeqlTypeName(obj);

    let out = "";
    out += `pub struct ${builder}<'a> {\n`;
    out += "    client: &'a DiscClient,\n";
    out += "}\n\n";

    out += `impl<'a> ${builder}<'a> {\n`;
    out += "    pub fn new(client: &'a DiscClient) -> Self {\n";
    out += "        Self { client }\n";
    out += "    }\n\n";

    out += this.emitTypeCastFn(obj);
    out += "\n";
    out += this.emitMultiLinkFn(obj);
    out += "\n";

    out += this.emitSelectFns(name, etype);
    out += this.emitInsertFn(name, etype);
    out += this.emitUpdateFn(name, etype);
    out += this.emitDeleteFn(name, etype);
    out += this.emitCountFn(etype);

    out += "}\n";
    return out;
  }

  private emitTypeCastFn(obj: ObjectType): string {
    const arms: string[] = [];
    for (const field of obj.fields) {
      if (field.isComputed || field.name === "id")
        continue;
      if (field.isLink) {
        if (!isMulti(field.cardinality))
          arms.push(`            ${JSON.stringify(field.name)} => "<uuid>",`);
        continue;
      }
      const cast = Types.mapEdgeQLTypeToEdgeQLCast(field.sourceType);
      arms.push(`            ${JSON.stringify(field.name)} => ${JSON.stringify(cast)},`);
    }
    let out = "";
    out += "    fn type_cast(field: &str) -> &'static str {\n";
    out += "        match field {\n";
    out += arms.length > 0 ? arms.join("\n") + "\n" : "";
    out += "            _ => \"<str>\",\n";
    out += "        }\n";
    out += "    }\n";
    return out;
  }

  private emitMultiLinkFn(obj: ObjectType): string {
    const arms: string[] = [];
    for (const field of obj.fields) {
      if (!field.isLink || field.isComputed)
        continue;
      if (!isMulti(field.cardinality))
        continue;
      const target = field.type.kind === "object" ? field.type.name.name : "unknown";
      arms.push(`            ${JSON.stringify(field.name)} => Some(${JSON.stringify(target)}),`);
    }
    let out = "";
    out += "    fn multi_link_target(field: &str) -> Option<&'static str> {\n";
    out += "        match field {\n";
    out += arms.length > 0 ? arms.join("\n") + "\n" : "";
    out += "            _ => None,\n";
    out += "        }\n";
    out += "    }\n";
    return out;
  }

  private emitSelectFns(name: string, etype: string): string {
    let out = "";

    out += `    pub fn select(&self, shape: Option<&str>) -> Result<Vec<${name}>, DiscError> {\n`;
    out += "        let query = match shape {\n";
    out += `            Some(s) => format!("select ${etype} {}", s),\n`;
    out += `            None => ${JSON.stringify(`select ${etype} { * }`)}.to_string(),\n`;
    out += "        };\n";
    out += "        self.client.query_many(&query, serde_json::Value::Null)\n";
    out += "    }\n\n";

    out += `    pub fn select_by_id(&self, id: &str, shape: Option<&str>) -> Result<Option<${name}>, DiscError> {\n`;
    out += "        let query = match shape {\n";
    out += `            Some(s) => format!("select ${etype} {} filter .id = <uuid>$id", s),\n`;
    out += `            None => ${JSON.stringify(`select ${etype} { * } filter .id = <uuid>$id`)}.to_string(),\n`;
    out += "        };\n";
    out += "        let vars = serde_json::json!({ \"id\": id });\n";
    out += `        let mut results: Vec<${name}> = self.client.query_many(&query, vars)?;\n`;
    out += "        Ok(if results.is_empty() { None } else { Some(results.remove(0)) })\n";
    out += "    }\n\n";

    out += `    pub fn filter(&self, condition: Option<&str>, variables: serde_json::Value) -> Result<Vec<${name}>, DiscError> {\n`;
    out += "        let query = match condition {\n";
    out += `            Some(c) => format!("select ${etype} {{ * }} filter {}", c),\n`;
    out += `            None => ${JSON.stringify(`select ${etype} { * }`)}.to_string(),\n`;
    out += "        };\n";
    out += "        self.client.query_many(&query, variables)\n";
    out += "    }\n\n";

    return out;
  }

  private emitInsertFn(name: string, etype: string): string {
    let out = "";
    out += `    pub fn insert(&self, data: ${name}Insert) -> Result<${name}, DiscError> {\n`;
    out += "        let value = serde_json::to_value(&data)?;\n";
    out += "        let empty = serde_json::Map::new();\n";
    out += "        let obj = value.as_object().unwrap_or(&empty);\n";
    out += "        let mut assignments: Vec<String> = Vec::new();\n";
    out += "        let mut variables = serde_json::Map::new();\n";
    out += "        for (key, val) in obj {\n";
    out += "            variables.insert(key.clone(), val.clone());\n";
    out += "            if let Some(target) = Self::multi_link_target(key) {\n";
    out += "                assignments.push(format!(\"{} := (select {} filter .id in array_unpack(<array<uuid>>${}))\", key, target, key));\n";
    out += "            } else {\n";
    out += "                assignments.push(format!(\"{} := {}${}\", key, Self::type_cast(key), key));\n";
    out += "            }\n";
    out += "        }\n";
    out += `        let query = format!("insert ${etype} {{ {} }}", assignments.join(", "));\n`;
    out += "        self.client.query_one(&query, serde_json::Value::Object(variables))\n";
    out += "    }\n\n";
    return out;
  }

  private emitUpdateFn(name: string, etype: string): string {
    let out = "";
    out += `    pub fn update(&self, id: &str, data: ${name}Update) -> Result<${name}, DiscError> {\n`;
    out += "        let value = serde_json::to_value(&data)?;\n";
    out += "        let empty = serde_json::Map::new();\n";
    out += "        let obj = value.as_object().unwrap_or(&empty);\n";
    out += "        let mut assignments: Vec<String> = Vec::new();\n";
    out += "        let mut variables = serde_json::Map::new();\n";
    out += "        variables.insert(\"id\".to_string(), serde_json::Value::String(id.to_string()));\n";
    out += "        for (key, val) in obj {\n";
    out += "            variables.insert(key.clone(), val.clone());\n";
    out += "            if let Some(target) = Self::multi_link_target(key) {\n";
    out += "                assignments.push(format!(\"{} := (select {} filter .id in array_unpack(<array<uuid>>${}))\", key, target, key));\n";
    out += "            } else {\n";
    out += "                assignments.push(format!(\"{} := {}${}\", key, Self::type_cast(key), key));\n";
    out += "            }\n";
    out += "        }\n";
    out += `        let query = format!("update ${etype} filter .id = <uuid>$id set {{ {} }}", assignments.join(", "));\n`;
    out += "        self.client.query_one(&query, serde_json::Value::Object(variables))\n";
    out += "    }\n\n";
    return out;
  }

  private emitDeleteFn(name: string, etype: string): string {
    let out = "";
    out += `    pub fn delete(&self, id: &str) -> Result<${name}, DiscError> {\n`;
    out += `        let query = ${JSON.stringify(`delete ${etype} filter .id = <uuid>$id`)}.to_string();\n`;
    out += "        let vars = serde_json::json!({ \"id\": id });\n";
    out += "        self.client.query_one(&query, vars)\n";
    out += "    }\n\n";
    return out;
  }

  private emitCountFn(etype: string): string {
    let out = "";
    out += "    pub fn count(&self, condition: Option<&str>, variables: serde_json::Value) -> Result<i64, DiscError> {\n";
    out += "        let query = match condition {\n";
    out += `            Some(c) => format!("select count(${etype} filter {})", c),\n`;
    out += `            None => ${JSON.stringify(`select count(${etype})`)}.to_string(),\n`;
    out += "        };\n";
    out += "        self.client.query_scalar(&query, variables)\n";
    out += "    }\n";
    return out;
  }

  // -- util -----------------------------------------------------------------

  /** Indent every non-empty line of `text` by `pad` (for nesting a module body). */
  private indent(text: string, pad: string): string {
    return text
      .split("\n")
      .map(line => (line.length > 0 ? pad + line : line))
      .join("\n");
  }
}

/*** RUNTIME ------------------------------------------ ***/

/**
 * Static, schema-independent runtime: a minimal blocking Disc client over
 * std::net::TcpStream with a hand-rolled HTTP/1.1 POST and serde_json. No
 * reqwest/tokio/ureq — builds fully offline against serde + serde_json only.
 */
const RUNTIME_RS = `//! Minimal synchronous Disc HTTP client (std-only networking + serde_json).
//! Generated by the Disc Rust codegen (codegen IR) — DO NOT EDIT.

use std::io::{Read, Write};
use std::net::TcpStream;

use serde::de::DeserializeOwned;

/// Errors surfaced by the Disc client.
#[derive(Debug)]
pub enum DiscError {
    Io(std::io::Error),
    Json(serde_json::Error),
    Server(String),
}

impl std::fmt::Display for DiscError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DiscError::Io(e) => write!(f, "io error: {}", e),
            DiscError::Json(e) => write!(f, "json error: {}", e),
            DiscError::Server(e) => write!(f, "server error: {}", e),
        }
    }
}

impl std::error::Error for DiscError {}

impl From<std::io::Error> for DiscError {
    fn from(e: std::io::Error) -> Self {
        DiscError::Io(e)
    }
}

impl From<serde_json::Error> for DiscError {
    fn from(e: serde_json::Error) -> Self {
        DiscError::Json(e)
    }
}

/// A blocking Disc client that POSTs EdgeQL to the server's \`/query\` endpoint.
pub struct DiscClient {
    host: String,
    port: u16,
    path: String,
}

impl DiscClient {
    pub fn new(host: impl Into<String>, port: u16) -> Self {
        Self { host: host.into(), port, path: "/query".to_string() }
    }

    pub fn with_path(host: impl Into<String>, port: u16, path: impl Into<String>) -> Self {
        Self { host: host.into(), port, path: path.into() }
    }

    /// POST { "query": ..., "variables": ... } and return the parsed JSON response.
    fn execute(&self, query: &str, variables: serde_json::Value) -> Result<serde_json::Value, DiscError> {
        let body = serde_json::json!({ "query": query, "variables": variables });
        let body_str = serde_json::to_string(&body)?;
        let request = format!(
            "POST {} HTTP/1.1\\r\\nHost: {}\\r\\nContent-Type: application/json\\r\\nContent-Length: {}\\r\\nConnection: close\\r\\n\\r\\n{}",
            self.path,
            self.host,
            body_str.len(),
            body_str
        );

        let mut stream = TcpStream::connect((self.host.as_str(), self.port))?;
        stream.write_all(request.as_bytes())?;

        let mut raw = Vec::new();
        stream.read_to_end(&mut raw)?;

        let text = String::from_utf8_lossy(&raw);
        let body = match text.split_once("\\r\\n\\r\\n") {
            Some((_, b)) => b,
            None => text.as_ref(),
        };

        let json: serde_json::Value = serde_json::from_str(body.trim())?;
        Ok(json)
    }

    /// Run a query and return its \`data\` payload, surfacing any \`errors\` array.
    fn data(&self, query: &str, variables: serde_json::Value) -> Result<serde_json::Value, DiscError> {
        let resp = self.execute(query, variables)?;
        if let Some(errors) = resp.get("errors") {
            if !errors.is_null() {
                return Err(DiscError::Server(errors.to_string()));
            }
        }
        Ok(resp.get("data").cloned().unwrap_or(serde_json::Value::Null))
    }

    pub fn query_many<T: DeserializeOwned>(&self, query: &str, variables: serde_json::Value) -> Result<Vec<T>, DiscError> {
        let data = self.data(query, variables)?;
        Ok(serde_json::from_value(data)?)
    }

    pub fn query_one<T: DeserializeOwned>(&self, query: &str, variables: serde_json::Value) -> Result<T, DiscError> {
        let data = self.data(query, variables)?;
        Ok(serde_json::from_value(data)?)
    }

    pub fn query_scalar(&self, query: &str, variables: serde_json::Value) -> Result<i64, DiscError> {
        let data = self.data(query, variables)?;
        Ok(serde_json::from_value(data)?)
    }
}
`;
