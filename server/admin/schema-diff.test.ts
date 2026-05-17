/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Tests for live-schema-diff helpers (Bundle K — Disc-original feature #3a).
 *
 * These cover the pure side of the schema-watch endpoint: turning two
 * SDL sources into a structured diff that the admin UI can render. The
 * watch loop itself (Deno.watchFs + SSE) is exercised in
 * `schema-watch.test.ts`.
 */

import { assertEquals } from "@std/assert";
import { computeSchemaDiff } from "./schema-diff.ts";

Deno.test("computeSchemaDiff — empty diff when sources match exactly", () => {
  const sdl = `module default {
    type User {
      required name: str;
      required email: str;
    };
  };`;

  const diff = computeSchemaDiff(sdl, sdl);
  assertEquals(diff.changed, false);
  assertEquals(diff.errors, []);
  assertEquals(diff.added, []);
  assertEquals(diff.removed, []);
  assertEquals(diff.modified, []);
});

Deno.test("computeSchemaDiff — flags an added type", () => {
  const applied = `module default {
    type User {
      required name: str;
    };
  };`;
  const onDisk = `module default {
    type User {
      required name: str;
    };
    type Post {
      required title: str;
    };
  };`;

  const diff = computeSchemaDiff(applied, onDisk);
  assertEquals(diff.changed, true);
  assertEquals(diff.errors, []);
  assertEquals(diff.added.map(t => t.name), ["Post"]);
  assertEquals(diff.removed, []);
  assertEquals(diff.modified, []);
});

Deno.test("computeSchemaDiff — flags a removed type", () => {
  const applied = `module default {
    type User {
      required name: str;
    };
    type Post {
      required title: str;
    };
  };`;
  const onDisk = `module default {
    type User {
      required name: str;
    };
  };`;

  const diff = computeSchemaDiff(applied, onDisk);
  assertEquals(diff.changed, true);
  assertEquals(diff.removed.map(t => t.name), ["Post"]);
  assertEquals(diff.added, []);
  assertEquals(diff.modified, []);
});

Deno.test("computeSchemaDiff — flags a modified type with property add/remove/change", () => {
  const applied = `module default {
    type User {
      required name: str;
      email: str;
      legacy: str;
    };
  };`;
  const onDisk = `module default {
    type User {
      required name: str;
      required email: str;
      bio: str;
    };
  };`;

  const diff = computeSchemaDiff(applied, onDisk);
  assertEquals(diff.changed, true);
  assertEquals(diff.added, []);
  assertEquals(diff.removed, []);
  assertEquals(diff.modified.length, 1);

  const userMod = diff.modified[0];
  assertEquals(userMod.name, "User");
  assertEquals(userMod.addedProperties.map(p => p.name), ["bio"]);
  assertEquals(userMod.removedProperties.map(p => p.name), ["legacy"]);
  assertEquals(userMod.changedProperties.map(p => p.name), ["email"]);
  // The `email` change — optional → required — should be carried.
  const emailChange = userMod.changedProperties[0];
  assertEquals(emailChange.before.required, false);
  assertEquals(emailChange.after.required, true);
});

Deno.test("computeSchemaDiff — surfaces SDL parse errors instead of throwing", () => {
  const applied = `module default {
    type User {
      required name: str;
    };
  };`;
  // Invalid: missing closing brace
  const onDisk = `module default {
    type User {
      required name: str;
  };`;

  const diff = computeSchemaDiff(applied, onDisk);
  // We can't compute a diff against a broken on-disk schema, so `changed`
  // is reported as `false` and errors carry the parser's complaint.
  assertEquals(diff.changed, false);
  assertEquals(diff.errors.length > 0, true);
  // The error message originates from the on-disk source.
  assertEquals(diff.errors[0].source, "onDisk");
});

Deno.test("computeSchemaDiff — explicit `link` keyword change shows in modified.changedLinks", () => {
  const applied = `module default {
    type User {
      required name: str;
    };
    type Post {
      required title: str;
      link author -> User;
    };
  };`;
  const onDisk = `module default {
    type User {
      required name: str;
    };
    type Post {
      required title: str;
      required link author -> User;
    };
  };`;

  const diff = computeSchemaDiff(applied, onDisk);
  assertEquals(diff.changed, true);
  const postMod = diff.modified.find(m => m.name === "Post");
  assertEquals(postMod !== undefined, true);
  assertEquals(postMod!.changedLinks.map(l => l.name), ["author"]);
});
