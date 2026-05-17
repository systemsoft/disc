/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Tests for Stage 39: Annotations DDL & Abstract Annotations
 *
 * Covers:
 *   - Introspection: annotations on types, properties, links
 *   - Codegen: @description in JSDoc for types and properties
 *   - Abstract annotations: parsing, validator, SchemaManager
 */

import { assertEquals } from "@std/assert";
import { TypeScriptGenerator } from "../codegen/typescript-generator.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { SDLParser } from "../schema/parser.ts";
import { SchemaValidator } from "../schema/validator.ts";
import { getBuiltinFunctions } from "./builtin-functions.ts";
import type { LinkDef, PropertyDef, Schema, TypeDef } from "./context.ts";
import { describeSchema, describeType } from "./introspection.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSchema(types: TypeDef[]): Schema {
  const typeMap = new Map<string, TypeDef>();
  for (const t of types) {
    typeMap.set(t.name, t);
  }
  return { types: typeMap, functions: getBuiltinFunctions() };
}

function makeType(
  name: string,
  opts?: {
    annotations?: Record<string, string>;
    properties?: Map<string, PropertyDef>;
    links?: Map<string, LinkDef>;
  }
): TypeDef {
  return {
    name,
    kind: "object",
    tableName: name.toLowerCase(),
    properties: opts?.properties ?? new Map([
      ["id", {
        name: "id",
        type: "uuid",
        required: true,
        multi: false,
        columnName: "id",
        edgeqlType: "uuid"
      }]
    ]),
    links: opts?.links ?? new Map(),
    annotations: opts?.annotations
  };
}

// =========================================================================
// Introspection tests
// =========================================================================

Deno.test("Stage 39 - describeType includes annotations on type", () => {
  const schema = makeSchema([
    makeType("User", {
      annotations: { description: "A user account", title: "User" }
    })
  ]);

  const desc = describeType(schema, "User");
  assertEquals(desc.annotations["description"], "A user account");
  assertEquals(desc.annotations["title"], "User");
});

Deno.test("Stage 39 - describeType includes annotations on properties", () => {
  const properties = new Map<string, PropertyDef>([
    ["id", {
      name: "id",
      type: "uuid",
      required: true,
      multi: false,
      columnName: "id",
      edgeqlType: "uuid"
    }],
    ["email", {
      name: "email",
      type: "text",
      required: true,
      multi: false,
      columnName: "email",
      edgeqlType: "str",
      annotations: { description: "Primary email address" }
    }]
  ]);

  const schema = makeSchema([makeType("User", { properties })]);
  const desc = describeType(schema, "User");
  const emailProp = desc.properties.find(p => p.name === "email");
  assertEquals(emailProp !== undefined, true);
  assertEquals(emailProp!.annotations["description"], "Primary email address");
});

Deno.test("Stage 39 - describeType includes annotations on links", () => {
  const links = new Map<string, LinkDef>([
    ["posts", {
      name: "posts",
      target: "Post",
      required: false,
      multi: true,
      annotations: { description: "Blog posts authored by user" }
    }]
  ]);

  const schema = makeSchema([
    makeType("User", { links }),
    makeType("Post")
  ]);

  const desc = describeType(schema, "User");
  const postsLink = desc.links.find(l => l.name === "posts");
  assertEquals(postsLink !== undefined, true);
  assertEquals(
    postsLink!.annotations["description"],
    "Blog posts authored by user"
  );
});

Deno.test("Stage 39 - describeSchema includes annotations for all types", () => {
  const schema = makeSchema([
    makeType("User", {
      annotations: { description: "A user account" }
    }),
    makeType("Post", {
      annotations: { description: "A blog post" }
    })
  ]);

  const desc = describeSchema(schema);
  const userType = desc.types.find(t => t.name === "User");
  const postType = desc.types.find(t => t.name === "Post");
  assertEquals(userType!.annotations["description"], "A user account");
  assertEquals(postType!.annotations["description"], "A blog post");
});

Deno.test("Stage 39 - empty annotations when none set", () => {
  const schema = makeSchema([makeType("User")]);
  const desc = describeType(schema, "User");
  assertEquals(Object.keys(desc.annotations).length, 0);

  const idProp = desc.properties.find(p => p.name === "id");
  assertEquals(idProp !== undefined, true);
  assertEquals(Object.keys(idProp!.annotations).length, 0);
});

Deno.test("Stage 39 - multiple annotations on same element", () => {
  const schema = makeSchema([
    makeType("User", {
      annotations: {
        description: "A user",
        title: "User Entity",
        deprecated: "Use Person instead"
      }
    })
  ]);

  const desc = describeType(schema, "User");
  assertEquals(desc.annotations["description"], "A user");
  assertEquals(desc.annotations["title"], "User Entity");
  assertEquals(desc.annotations["deprecated"], "Use Person instead");
});

// =========================================================================
// Codegen tests
// =========================================================================

Deno.test("Stage 39 - codegen: type-level @description in interface JSDoc", () => {
  const schema = makeSchema([
    makeType("User", {
      annotations: { description: "A user account" }
    })
  ]);

  const generator = new TypeScriptGenerator(schema, {
    schemaSource: "",
    target: "client" as const,
    includeMutations: false,
    outputDir: "./generated",
    formatOutput: true,
    includeQueryBuilders: false,
    includeClient: false
  });

  const result = generator.generate();
  const typesFile = result.files.find(f => f.type === "types");
  assertEquals(typesFile !== undefined, true);

  // The JSDoc should include the description
  assertEquals(typesFile!.content.includes("A user account"), true);
  assertEquals(
    typesFile!.content.includes("User type from EdgeQL schema"),
    true
  );
});

Deno.test("Stage 39 - codegen: property-level @description in JSDoc tag", () => {
  const properties = new Map<string, PropertyDef>([
    ["id", {
      name: "id",
      type: "uuid",
      required: true,
      multi: false,
      columnName: "id",
      edgeqlType: "uuid"
    }],
    ["email", {
      name: "email",
      type: "text",
      required: true,
      multi: false,
      columnName: "email",
      edgeqlType: "str",
      annotations: { description: "Primary email address" }
    }]
  ]);

  const schema = makeSchema([makeType("User", { properties })]);

  const generator = new TypeScriptGenerator(schema, {
    schemaSource: "",
    target: "client" as const,
    includeMutations: false,
    outputDir: "./generated",
    formatOutput: true,
    includeQueryBuilders: false,
    includeClient: false
  });

  const result = generator.generate();
  const typesFile = result.files.find(f => f.type === "types");
  assertEquals(typesFile !== undefined, true);
  assertEquals(
    typesFile!.content.includes("@description Primary email address"),
    true
  );
});

Deno.test("Stage 39 - codegen: no @description when no annotations", () => {
  const schema = makeSchema([makeType("User")]);

  const generator = new TypeScriptGenerator(schema, {
    schemaSource: "",
    target: "client" as const,
    includeMutations: false,
    outputDir: "./generated",
    formatOutput: true,
    includeQueryBuilders: false,
    includeClient: false
  });

  const result = generator.generate();
  const typesFile = result.files.find(f => f.type === "types");
  assertEquals(typesFile !== undefined, true);
  assertEquals(typesFile!.content.includes("@description"), false);
});

// =========================================================================
// Abstract annotation tests
// =========================================================================

Deno.test("Stage 39 - SDL parsing: abstract annotation parses correctly", () => {
  const sdl = `
    module default {
      abstract annotation deprecated;
    }
  `;

  const parser = new SDLParser(sdl);
  const doc = parser.parse();

  // The module should contain one declaration
  assertEquals(doc.declarations.length, 1);
  const mod = doc.declarations[0];
  assertEquals(mod.kind, "ModuleDeclaration");

  if (mod.kind === "ModuleDeclaration") {
    const annDecl = mod.declarations.find(
      d => d.kind === "AnnotationDeclaration"
    );
    assertEquals(annDecl !== undefined, true);
    if (annDecl && annDecl.kind === "AnnotationDeclaration") {
      assertEquals(annDecl.name.value, "deprecated");
      assertEquals(annDecl.abstract, true);
    }
  }
});

Deno.test("Stage 39 - validator: undeclared annotation usage produces error", () => {
  const sdl = `
    module default {
      type User {
        required name: str;
        annotation custom_note := 'some note';
      };
    }
  `;

  const parser = new SDLParser(sdl);
  const doc = parser.parse();
  const validator = new SchemaValidator();
  const result = validator.validate(doc);

  assertEquals(result.ok, false);
  assertEquals(result.errors !== undefined, true);
  const hasAnnotationError = result.errors!.some(
    e => e.message.includes("custom_note") && e.message.includes("not defined")
  );
  assertEquals(hasAnnotationError, true);
});

Deno.test("Stage 39 - validator: built-in annotation description passes", () => {
  const sdl = `
    module default {
      type User {
        required name: str;
        annotation description := 'A user account';
      };
    }
  `;

  const parser = new SDLParser(sdl);
  const doc = parser.parse();
  const validator = new SchemaValidator();
  const result = validator.validate(doc);

  assertEquals(result.ok, true);
});

Deno.test("Stage 39 - validator: declared abstract annotation passes", () => {
  const sdl = `
    module default {
      abstract annotation custom_note;

      type User {
        required name: str;
        annotation custom_note := 'some note';
      };
    }
  `;

  const parser = new SDLParser(sdl);
  const doc = parser.parse();
  const validator = new SchemaValidator();
  const result = validator.validate(doc);

  assertEquals(result.ok, true);
});

// =========================================================================
// SchemaManager tests
// =========================================================================

Deno.test("Stage 39 - SchemaManager: annotations extracted from SDL type/property/link", () => {
  const sdl = `
    module default {
      type User {
        annotation description := 'A user account';
        required name: str {
          annotation description := 'Full name';
        };
        multi link posts -> Post {
          annotation description := 'User blog posts';
        };
      };

      type Post {
        required title: str;
      };
    }
  `;

  const manager = new SchemaManager({ dryRun: true });
  const parseResult = manager.parseSDL(sdl);
  assertEquals(parseResult.ok, true);

  if (!parseResult.ok) {
    throw parseResult.error;
  }
  const schema = manager.modulesToSchema(parseResult.value);

  // Check type-level annotation
  const userType = schema.types.get("User");
  assertEquals(userType !== undefined, true);
  assertEquals(userType!.annotations?.["description"], "'A user account'");

  // Check property-level annotation
  const nameProp = userType!.properties.get("name");
  assertEquals(nameProp !== undefined, true);
  assertEquals(nameProp!.annotations?.["description"], "'Full name'");

  // Check link-level annotation
  const postsLink = userType!.links.get("posts");
  assertEquals(postsLink !== undefined, true);
  assertEquals(postsLink!.annotations?.["description"], "'User blog posts'");
});

Deno.test("Stage 39 - SchemaManager: abstract annotation declarations collected into schema", () => {
  const sdl = `
    module default {
      abstract annotation custom_note;
      abstract annotation severity;

      type User {
        required name: str;
      };
    }
  `;

  const manager = new SchemaManager({ dryRun: true });
  const parseResult = manager.parseSDL(sdl);
  assertEquals(parseResult.ok, true);

  if (!parseResult.ok) {
    throw parseResult.error;
  }
  const schema = manager.modulesToSchema(parseResult.value);
  assertEquals(schema.abstractAnnotations !== undefined, true);
  assertEquals(schema.abstractAnnotations!.has("custom_note"), true);
  assertEquals(schema.abstractAnnotations!.has("severity"), true);
  assertEquals(
    schema.abstractAnnotations!.get("custom_note")!.name,
    "custom_note"
  );
  assertEquals(schema.abstractAnnotations!.get("severity")!.name, "severity");
});
