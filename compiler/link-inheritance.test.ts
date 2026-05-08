/**
 * Tests for link inheritance support (Stage 35, Phase 3)
 *
 * Validates that links can extend abstract links, inheriting their properties
 * and constraints. Tests cover parsing, schema-manager merging, validation,
 * and differ detection.
 */

import { assertEquals, assertExists } from "@std/assert";
import { SchemaDiffer } from "../migration/differ.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import type { LinkDeclaration, TypeDeclaration } from "../schema/ast.ts";
import { SDLConverter } from "../schema/converter.ts";
import { SDLParser } from "../schema/parser.ts";
import { SchemaValidator } from "../schema/validator.ts";

// ---------------------------------------------------------------------------
// Helper: parse SDL and return the document AST
// ---------------------------------------------------------------------------

function parseSDL(sdl: string) {
  const parser = new SDLParser(sdl);
  return parser.parse();
}

// ===========================================================================
// 1. Parser: link with `extending` parses correctly
// ===========================================================================

Deno.test("link inheritance - parser: link with extending parses correctly", () => {
  const sdl = `
    abstract link friendship {
      property strength: float64;
    }

    type User {
      multi link friends extending friendship -> User;
    }
  `;

  const doc = parseSDL(sdl);

  // Find the abstract link declaration at the top level
  const abstractLink = doc.declarations.find(
    d => d.kind === "LinkDeclaration"
  ) as LinkDeclaration | undefined;
  assertExists(abstractLink, "Abstract link 'friendship' should be parsed");
  assertEquals(abstractLink.name.value, "friendship");
  assertEquals(abstractLink.abstract, true);
  assertExists(abstractLink.properties, "Abstract link should have properties");
  assertEquals(abstractLink.properties!.length, 1);
  assertEquals(abstractLink.properties![0].name.value, "strength");

  // Find the User type
  const userType = doc.declarations.find(
    d => d.kind === "TypeDeclaration" && d.name.value === "User"
  ) as TypeDeclaration | undefined;
  assertExists(userType, "User type should be parsed");

  // Find the friends link within User
  const friendsLink = userType.members.find(
    m => m.kind === "LinkDeclaration" && m.name.value === "friends"
  ) as LinkDeclaration | undefined;
  assertExists(friendsLink, "friends link should exist on User");
  assertExists(friendsLink.extending, "friends link should have extending");
  assertEquals(friendsLink.extending!.length, 1);
  assertEquals(
    friendsLink.extending![0].name.parts.join("::"),
    "friendship"
  );
  assertEquals(friendsLink.target.name.parts.join("::"), "User");
});

// ===========================================================================
// 2. Parser: link with multiple extending targets
// ===========================================================================

Deno.test("link inheritance - parser: link with multiple extending targets", () => {
  const sdl = `
    abstract link timestamped_link {
      property created_at: datetime;
    }

    abstract link weighted_link {
      property weight: float64;
    }

    type Node {
      multi link edges extending timestamped_link, weighted_link -> Node;
    }
  `;

  const doc = parseSDL(sdl);

  const nodeType = doc.declarations.find(
    d => d.kind === "TypeDeclaration" && d.name.value === "Node"
  ) as TypeDeclaration | undefined;
  assertExists(nodeType, "Node type should be parsed");

  const edgesLink = nodeType.members.find(
    m => m.kind === "LinkDeclaration" && m.name.value === "edges"
  ) as LinkDeclaration | undefined;
  assertExists(edgesLink, "edges link should exist on Node");
  assertExists(edgesLink.extending, "edges link should have extending");
  assertEquals(edgesLink.extending!.length, 2);
  assertEquals(
    edgesLink.extending![0].name.parts.join("::"),
    "timestamped_link"
  );
  assertEquals(
    edgesLink.extending![1].name.parts.join("::"),
    "weighted_link"
  );
});

// ===========================================================================
// 3. Schema-manager: properties from abstract link merged into concrete link
// ===========================================================================

Deno.test("link inheritance - schema-manager: abstract link properties merged into concrete link", () => {
  const sdl = `
    abstract link friendship {
      property strength: float64;
      property since: datetime;
    }

    type User {
      multi link friends extending friendship -> User;
    }
  `;

  const manager = new SchemaManager({});
  const parseResult = manager.parseSDL(sdl);
  assertEquals(parseResult.ok, true, "parseSDL should succeed");
  if (!parseResult.ok)
    throw parseResult.error;

  // Access the raw modules to check link declarations
  const modules = parseResult.value;

  // Find the User type
  const userType = modules[0].items.find(
    item => item.kind === "TypeDeclaration" && item.name.value === "User"
  ) as TypeDeclaration | undefined;
  assertExists(userType, "User type should exist in modules");

  // Build the schema to trigger link inheritance resolution
  manager.modulesToSchema(modules);

  // After modulesToSchema, the link declaration should have inherited properties
  const friendsLink = userType.members.find(
    m => m.kind === "LinkDeclaration" && m.name.value === "friends"
  ) as LinkDeclaration | undefined;
  assertExists(friendsLink, "friends link should exist");
  assertExists(
    friendsLink.properties,
    "friends link should have inherited properties"
  );

  const propNames = friendsLink.properties!.map(p => p.name.value);
  assertEquals(
    propNames.includes("strength"),
    true,
    "friends link should inherit 'strength' property"
  );
  assertEquals(
    propNames.includes("since"),
    true,
    "friends link should inherit 'since' property"
  );
});

// ===========================================================================
// 4. Schema-manager: concrete link properties override inherited ones
// ===========================================================================

Deno.test("link inheritance - schema-manager: concrete link properties override inherited", () => {
  const sdl = `
    abstract link friendship {
      property strength: float64;
      property note: str;
    }

    type User {
      multi link friends extending friendship -> User {
        property strength: int64;
      }
    }
  `;

  const manager = new SchemaManager({});
  const parseResult = manager.parseSDL(sdl);
  assertEquals(parseResult.ok, true, "parseSDL should succeed");
  if (!parseResult.ok)
    throw parseResult.error;

  const modules = parseResult.value;
  manager.modulesToSchema(modules);

  const userType = modules[0].items.find(
    item => item.kind === "TypeDeclaration" && item.name.value === "User"
  ) as TypeDeclaration | undefined;
  assertExists(userType, "User type should exist");

  const friendsLink = userType.members.find(
    m => m.kind === "LinkDeclaration" && m.name.value === "friends"
  ) as LinkDeclaration | undefined;
  assertExists(friendsLink, "friends link should exist");
  assertExists(friendsLink.properties, "friends link should have properties");

  // The concrete 'strength' (int64) should win over inherited (float64)
  const strengthProp = friendsLink.properties!.find(
    p => p.name.value === "strength"
  );
  assertExists(strengthProp, "strength property should exist");
  assertEquals(
    strengthProp.type.name.parts.join("::"),
    "int64",
    "Concrete 'strength' (int64) should override inherited (float64)"
  );

  // 'note' should be inherited from abstract link
  const noteProp = friendsLink.properties!.find(
    p => p.name.value === "note"
  );
  assertExists(
    noteProp,
    "note property should be inherited from abstract link"
  );
  assertEquals(
    noteProp.type.name.parts.join("::"),
    "str",
    "Inherited 'note' should have type str"
  );
});

// ===========================================================================
// 5. Validator: extending non-existent abstract link is rejected
// ===========================================================================

Deno.test("link inheritance - validator: extending non-existent abstract link rejected", () => {
  const sdl = `
    type User {
      multi link friends extending nonexistent_link -> User;
    }
  `;

  const doc = parseSDL(sdl);
  const validator = new SchemaValidator();
  const result = validator.validate(doc);

  assertEquals(
    result.ok,
    false,
    "Validation should fail for non-existent abstract link"
  );
  assertExists(result.errors, "There should be validation errors");

  const hasLinkError = result.errors!.some(
    e => e.message.includes("nonexistent_link")
  );
  assertEquals(
    hasLinkError,
    true,
    "Error should mention the non-existent abstract link name"
  );
});

// ===========================================================================
// 6. Differ: extending change detected
// ===========================================================================

Deno.test("link inheritance - differ: extending change detected", () => {
  const differ = new SchemaDiffer();

  const oldSDL = `
    abstract link friendship {
      property strength: float64;
    }

    type User {
      multi link friends -> User;
    }
  `;
  const newSDL = `
    abstract link friendship {
      property strength: float64;
    }

    type User {
      multi link friends extending friendship -> User;
    }
  `;

  const oldParser = new SDLParser(oldSDL);
  const oldDoc = oldParser.parse();
  const newParser = new SDLParser(newSDL);
  const newDoc = newParser.parse();

  const converter = new SDLConverter();
  const oldModules = converter.convertToModules(oldDoc);
  const newModules = converter.convertToModules(newDoc);

  const operations = differ.diff(oldModules, newModules);

  // There should be an AlterType with AlterLink containing ChangeExtending
  const alterType = operations.find(
    op => op.kind === "AlterType"
  );
  assertExists(alterType, "There should be an AlterType operation");

  const alterTypeOp = alterType as {
    kind: string;
    typeName: string;
    operations: {
      kind: string;
      linkName?: string;
      changes?: { kind: string; }[];
    }[];
  };
  assertEquals(alterTypeOp.typeName, "User");

  const alterLink = alterTypeOp.operations.find(
    op => op.kind === "AlterLink"
  );
  assertExists(alterLink, "There should be an AlterLink operation");

  const extendingChange = alterLink!.changes!.find(
    c => c.kind === "ChangeExtending"
  );
  assertExists(
    extendingChange,
    "AlterLink should contain a ChangeExtending change"
  );
});

// ===========================================================================
// 7. Differ: link with extending extracted correctly
// ===========================================================================

Deno.test("link inheritance - differ: link with extending extracted correctly", () => {
  const sdl = `
    abstract link friendship {
      property strength: float64;
    }

    type User {
      multi link friends extending friendship -> User;
    }
  `;

  const doc = parseSDL(sdl);
  const converter = new SDLConverter();
  const modules = converter.convertToModules(doc);

  const differ = new SchemaDiffer();
  const operations = differ.diff([], modules);

  // Find the CreateType operation for User
  const createUser = operations.find(
    op =>
      op.kind === "CreateType" &&
      (op as unknown as { typeName: string; }).typeName === "User"
  );
  assertExists(createUser, "CreateType for User should exist");

  const userOp = createUser as unknown as {
    links: { name: string; extending?: string[]; }[];
  };
  const friendsLink = userOp.links.find(l => l.name === "friends");
  assertExists(friendsLink, "friends link should be in CreateType operation");
  assertExists(
    friendsLink.extending,
    "friends link should have extending field"
  );
  assertEquals(
    friendsLink.extending,
    ["friendship"],
    "extending should contain 'friendship'"
  );
});

// ===========================================================================
// 8. End-to-end: abstract link with property, concrete link inherits in schema
// ===========================================================================

Deno.test("link inheritance - end-to-end: abstract link property inherited in schema", () => {
  const sdl = `
    abstract link rated {
      property rating: int64;
    }

    type Movie {
      required property title: str;
    }

    type User {
      multi link watched extending rated -> Movie;
    }
  `;

  const manager = new SchemaManager({});
  const parseResult = manager.parseSDL(sdl);
  assertEquals(parseResult.ok, true, "parseSDL should succeed");
  if (!parseResult.ok)
    throw parseResult.error;

  const modules = parseResult.value;
  const schema = manager.modulesToSchema(modules);

  // Verify the User type exists
  const userType = schema.types.get("User");
  assertExists(userType, "User type should exist in schema");

  // Verify the watched link exists
  const watchedLink = userType.links.get("watched");
  assertExists(watchedLink, "watched link should exist on User");
  assertEquals(watchedLink.target, "Movie");
  assertEquals(watchedLink.multi, true);

  // Verify the Movie type exists
  const movieType = schema.types.get("Movie");
  assertExists(movieType, "Movie type should exist in schema");
  assertEquals(
    movieType.properties.has("title"),
    true,
    "Movie should have title property"
  );
});

// ===========================================================================
// 9. Combined: extending + own properties merge correctly
// ===========================================================================

Deno.test("link inheritance - combined: extending + own properties merge correctly", () => {
  const sdl = `
    abstract link audited {
      property created_by: str;
      property created_at: datetime;
    }

    abstract link weighted {
      property weight: float64;
    }

    type Document {
      required property title: str;
    }

    type User {
      multi link documents extending audited, weighted -> Document {
        property note: str;
      }
    }
  `;

  const manager = new SchemaManager({});
  const parseResult = manager.parseSDL(sdl);
  assertEquals(parseResult.ok, true, "parseSDL should succeed");
  if (!parseResult.ok)
    throw parseResult.error;

  const modules = parseResult.value;
  manager.modulesToSchema(modules);

  // Find the User type in the modules
  const userType = modules[0].items.find(
    item => item.kind === "TypeDeclaration" && item.name.value === "User"
  ) as TypeDeclaration | undefined;
  assertExists(userType, "User type should exist");

  const docsLink = userType.members.find(
    m => m.kind === "LinkDeclaration" && m.name.value === "documents"
  ) as LinkDeclaration | undefined;
  assertExists(docsLink, "documents link should exist");
  assertExists(docsLink.properties, "documents link should have properties");

  const propNames = docsLink.properties!.map(p => p.name.value);

  // Own property
  assertEquals(
    propNames.includes("note"),
    true,
    "documents link should have own 'note' property"
  );

  // Inherited from 'audited'
  assertEquals(
    propNames.includes("created_by"),
    true,
    "documents link should inherit 'created_by' from audited"
  );
  assertEquals(
    propNames.includes("created_at"),
    true,
    "documents link should inherit 'created_at' from audited"
  );

  // Inherited from 'weighted'
  assertEquals(
    propNames.includes("weight"),
    true,
    "documents link should inherit 'weight' from weighted"
  );

  // Total: note + created_by + created_at + weight = 4
  assertEquals(
    docsLink.properties!.length,
    4,
    "documents link should have exactly 4 properties (1 own + 3 inherited)"
  );
});
