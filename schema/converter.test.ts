/**
 * Tests for SDL to Schema AST Converter
 */

import { assertEquals, assertExists } from "@std/assert";
import * as SDLAST from "./ast.ts";
import { SDLConverter } from "./converter.ts";
import { SDLParser } from "./parser.ts";

Deno.test("SDL Converter - Convert Simple Type", () => {
  const source = `
    type User {
      required name: str;
      email: str;
    }
  `;

  const parser = new SDLParser(source);
  const ast = parser.parse();

  const converter = new SDLConverter();
  const modules = converter.convertToModules(ast);

  assertEquals(modules.length, 1);
  assertEquals(modules[0].name, "default");
  assertEquals(modules[0].items.length, 1);

  const type = modules[0].items[0] as SDLAST.TypeDeclaration;
  assertEquals(type.kind, "TypeDeclaration");
  assertEquals(type.name.value, "User");
  assertEquals(type.members.length, 2);
});

Deno.test("SDL Converter - Convert Module with Types", () => {
  const source = `
    module default {
      type User {
        required name: str;
        required email: str;
      };
      
      type Post {
        required title: str;
        required author: User;
      };
    }
  `;

  const parser = new SDLParser(source);
  const ast = parser.parse();

  const converter = new SDLConverter();
  const modules = converter.convertToModules(ast);

  assertEquals(modules.length, 1);
  assertEquals(modules[0].name, "default");
  assertEquals(modules[0].items.length, 2);

  const user = modules[0].items[0] as SDLAST.TypeDeclaration;
  assertEquals(user.name.value, "User");

  const post = modules[0].items[1] as SDLAST.TypeDeclaration;
  assertEquals(post.name.value, "Post");
});

Deno.test("SDL Converter - Convert Type with Constraints", () => {
  const source = `
    type User {
      required email: str {
        constraint exclusive;
      };
    }
  `;

  const parser = new SDLParser(source);
  const ast = parser.parse();

  const converter = new SDLConverter();
  const modules = converter.convertToModules(ast);

  const type = modules[0].items[0] as SDLAST.TypeDeclaration;
  const emailProp = type.members[0] as SDLAST.PropertyDeclaration;

  assertExists(emailProp.constraints);
  assertEquals(emailProp.constraints.length, 1);
  assertEquals(emailProp.constraints[0].name?.value, "exclusive");
});

Deno.test("SDL Converter - Convert Type with Links", () => {
  const source = `
    type Post {
      required title: str;
      required link author -> User;
      multi link tags -> Tag;
    }
  `;

  const parser = new SDLParser(source);
  const ast = parser.parse();

  const converter = new SDLConverter();
  const modules = converter.convertToModules(ast);

  const type = modules[0].items[0] as SDLAST.TypeDeclaration;
  assertEquals(type.members.length, 3);

  const authorLink = type.members[1] as SDLAST.LinkDeclaration;
  assertEquals(authorLink.kind, "LinkDeclaration");
  assertEquals(authorLink.name.value, "author");
  assertEquals(authorLink.target.name.parts[0], "User");
  assertEquals(authorLink.required, true);

  const tagsLink = type.members[2] as SDLAST.LinkDeclaration;
  assertEquals(tagsLink.multi, true);
});

Deno.test("SDL Converter - Convert Type with Default Values", () => {
  const source = `
    type User {
      createdAt: datetime {
        default := datetime_current();
      };
    }
  `;

  const parser = new SDLParser(source);
  const ast = parser.parse();

  const converter = new SDLConverter();
  const modules = converter.convertToModules(ast);

  const type = modules[0].items[0] as SDLAST.TypeDeclaration;
  const createdAt = type.members[0] as SDLAST.PropertyDeclaration;

  assertExists(createdAt.default);
  assertEquals(createdAt.default.kind, "FunctionCall");
});

Deno.test("SDL Converter - Convert Type Extension", () => {
  const source = `
    abstract type Timestamped {
      required createdAt: datetime;
    }
    
    type User extending Timestamped {
      required name: str;
    }
  `;

  const parser = new SDLParser(source);
  const ast = parser.parse();

  const converter = new SDLConverter();
  const modules = converter.convertToModules(ast);

  assertEquals(modules[0].items.length, 2);

  const timestamped = modules[0].items[0] as SDLAST.TypeDeclaration;
  assertEquals(timestamped.abstract, true);

  const user = modules[0].items[1] as SDLAST.TypeDeclaration;
  assertExists(user.extending);
  assertEquals(user.extending[0].name.parts[0], "Timestamped");
});

Deno.test("SDL Converter - Convert Scalar Type", () => {
  const source = `
    scalar type Email extending str {
      constraint regexp(r'^[^@]+@[^@]+\\.[^@]+$');
    }
  `;

  const parser = new SDLParser(source);
  const ast = parser.parse();

  const converter = new SDLConverter();
  const modules = converter.convertToModules(ast);

  assertEquals(modules[0].items.length, 1);

  const scalar = modules[0].items[0] as SDLAST.ScalarTypeDeclaration;
  assertEquals(scalar.kind, "ScalarTypeDeclaration");
  assertEquals(scalar.name.value, "Email");
  assertExists(scalar.constraints);
});

Deno.test("SDL Converter - Convert Multiple Modules", () => {
  const source = `
    module users {
      type User {
        required name: str;
      };
    }
    
    module posts {
      type Post {
        required title: str;
      };
    }
  `;

  const parser = new SDLParser(source);
  const ast = parser.parse();

  const converter = new SDLConverter();
  const modules = converter.convertToModules(ast);

  assertEquals(modules.length, 2);
  assertEquals(modules[0].name, "users");
  assertEquals(modules[1].name, "posts");
});

Deno.test("SDL Converter - Convert Computed Properties", () => {
  const source = `
    type User {
      required first_name: str;
      required last_name: str;
      full_name := .first_name ++ ' ' ++ .last_name;
    }
  `;

  const parser = new SDLParser(source);
  const ast = parser.parse();

  const converter = new SDLConverter();
  const modules = converter.convertToModules(ast);

  const type = modules[0].items[0] as SDLAST.TypeDeclaration;
  assertEquals(type.members.length, 3);

  const fullName = type.members[2] as SDLAST.PropertyDeclaration;
  assertExists(fullName.computed);
  assertEquals(fullName.computed.kind, "BinaryOp");
});

Deno.test("SDL Converter - Convert Access Policies", () => {
  const source = `
    type Document {
      required title: str;
      access policy owner_only {
        allow select, update, delete;
        using (global current_user ?= .owner);
      };
    }
  `;

  const parser = new SDLParser(source);
  const ast = parser.parse();

  const converter = new SDLConverter();
  const modules = converter.convertToModules(ast);

  const type = modules[0].items[0] as SDLAST.TypeDeclaration;
  const policy = type.members.find((m) => m.kind === "AccessPolicy") as SDLAST.AccessPolicy;

  assertExists(policy);
  assertEquals(policy.name.value, "owner_only");
});
