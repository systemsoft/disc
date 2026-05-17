/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Live schema diff helper (Bundle K — Disc-original feature #3a).
 *
 * Turns two SDL strings (the applied schema and the schema currently
 * on disk) into a structured per-type diff. The admin UI renders the
 * result as a side-by-side view: added types in green, removed types
 * in red, modified types with per-property breakdowns.
 *
 * This module is pure — no I/O, no database. The watch loop in
 * `schema-watch.ts` reads the files and calls in here.
 */

import type * as AST from "../../schema/ast.ts";
import { SDLConverter, type Module } from "../../schema/converter.ts";
import { SDLParser } from "../../schema/parser.ts";

export interface DiffPropertySnapshot {
  name: string;
  type: string;
  required: boolean;
  default?: string;
}

export interface DiffLinkSnapshot {
  name: string;
  target: string;
  required: boolean;
  multi: boolean;
}

export interface DiffTypeSnapshot {
  module: string;
  name: string;
  abstract: boolean;
  properties: DiffPropertySnapshot[];
  links: DiffLinkSnapshot[];
}

export interface DiffPropertyChange {
  name: string;
  before: DiffPropertySnapshot;
  after: DiffPropertySnapshot;
}

export interface DiffLinkChange {
  name: string;
  before: DiffLinkSnapshot;
  after: DiffLinkSnapshot;
}

export interface DiffModifiedType {
  module: string;
  name: string;
  addedProperties: DiffPropertySnapshot[];
  removedProperties: DiffPropertySnapshot[];
  changedProperties: DiffPropertyChange[];
  addedLinks: DiffLinkSnapshot[];
  removedLinks: DiffLinkSnapshot[];
  changedLinks: DiffLinkChange[];
}

export interface DiffParseError {
  source: "applied" | "onDisk";
  message: string;
  line?: number;
  column?: number;
}

export interface SchemaDiffSummary {
  /**
   * `true` when the applied SDL and the on-disk SDL produce different
   * type sets / type contents. `false` when they match, OR when the
   * on-disk SDL failed to parse cleanly (in which case `errors` carries
   * the reason and the UI shows a "fix the schema" banner instead of a
   * misleading empty diff).
   */
  changed: boolean;
  added: DiffTypeSnapshot[];
  removed: DiffTypeSnapshot[];
  modified: DiffModifiedType[];
  errors: DiffParseError[];
}

interface ParseOutcome {
  modules: Module[] | null;
  errors: DiffParseError[];
}

function parseSdl(source: string, label: "applied" | "onDisk"): ParseOutcome {
  // `parseWithRecovery` lets us collect every syntax error in one pass
  // — much friendlier than fix-save-fix-save when the editor has a
  // mid-edit broken state. (Same approach as `cli/watch.ts` and
  // `migration/schema-manager.ts`.)
  try {
    const parser = new SDLParser(source);
    const { document, errors } = parser.parseWithRecovery();
    if (errors.length > 0) {
      return {
        modules: null,
        errors: errors.map(e => ({
          source: label,
          message: e.message,
          line: e.context?.location?.line,
          column: e.context?.location?.column
        }))
      };
    }
    const converter = new SDLConverter();
    return { modules: converter.convertToModules(document), errors: [] };
  } catch (err) {
    return {
      modules: null,
      errors: [{
        source: label,
        message: err instanceof Error ? err.message : String(err)
      }]
    };
  }
}

function snapshotProperty(prop: AST.PropertyDeclaration): DiffPropertySnapshot {
  const snap: DiffPropertySnapshot = {
    name: prop.name.value,
    type: typeRefToString(prop.type),
    required: prop.required ?? false
  };
  // Default expressions can be arbitrary EdgeQL; for the diff we only
  // care whether one side has a default the other doesn't, plus the
  // textual form so the UI can render it. Stringify lazily — bare
  // presence is enough to flag a "changed" property.
  if (prop.default !== undefined) {
    snap.default = "<default>";
  }
  return snap;
}

function snapshotLink(link: AST.LinkDeclaration): DiffLinkSnapshot {
  return {
    name: link.name.value,
    target: link.target ? typeRefToString(link.target) : "unknown",
    required: link.required ?? false,
    multi: link.multi ?? false
  };
}

function typeRefToString(ref: AST.TypeRef | undefined): string {
  if (!ref) {
    return "unknown";
  }
  const parts = ref.name?.parts ?? [];
  let base = parts.join("::");
  if (ref.params && ref.params.length > 0) {
    const inner = ref.params.map(p => typeRefToString(p)).join(", ");
    base = `${base}<${inner}>`;
  }
  if (ref.array) {
    base = `array<${base}>`;
  }
  return base || "unknown";
}

function snapshotType(
  decl: AST.TypeDeclaration,
  moduleName: string
): DiffTypeSnapshot {
  const properties: DiffPropertySnapshot[] = [];
  const links: DiffLinkSnapshot[] = [];

  for (const member of decl.members ?? []) {
    if (member.kind === "PropertyDeclaration") {
      properties.push(snapshotProperty(member as AST.PropertyDeclaration));
    } else if (member.kind === "LinkDeclaration") {
      links.push(snapshotLink(member as AST.LinkDeclaration));
    }
  }

  properties.sort((a, b) => a.name.localeCompare(b.name));
  links.sort((a, b) => a.name.localeCompare(b.name));

  return {
    module: moduleName,
    name: decl.name.value,
    abstract: decl.abstract ?? false,
    properties,
    links
  };
}

function indexTypes(modules: Module[]): Map<string, DiffTypeSnapshot> {
  const out = new Map<string, DiffTypeSnapshot>();
  for (const mod of modules) {
    for (const item of mod.items) {
      if (item.kind === "TypeDeclaration") {
        const decl = item as AST.TypeDeclaration;
        const key = `${mod.name}::${decl.name.value}`;
        out.set(key, snapshotType(decl, mod.name));
      }
    }
  }
  return out;
}

function diffPropertyList(
  before: DiffPropertySnapshot[],
  after: DiffPropertySnapshot[]
): {
  added: DiffPropertySnapshot[];
  removed: DiffPropertySnapshot[];
  changed: DiffPropertyChange[];
} {
  const beforeMap = new Map(before.map(p => [p.name, p]));
  const afterMap = new Map(after.map(p => [p.name, p]));
  const added: DiffPropertySnapshot[] = [];
  const removed: DiffPropertySnapshot[] = [];
  const changed: DiffPropertyChange[] = [];

  for (const [name, afterProp] of afterMap) {
    const beforeProp = beforeMap.get(name);
    if (!beforeProp) {
      added.push(afterProp);
    } else if (
      beforeProp.type !== afterProp.type ||
      beforeProp.required !== afterProp.required ||
      beforeProp.default !== afterProp.default
    ) {
      changed.push({ name, before: beforeProp, after: afterProp });
    }
  }
  for (const [name, beforeProp] of beforeMap) {
    if (!afterMap.has(name)) {
      removed.push(beforeProp);
    }
  }

  added.sort((a, b) => a.name.localeCompare(b.name));
  removed.sort((a, b) => a.name.localeCompare(b.name));
  changed.sort((a, b) => a.name.localeCompare(b.name));
  return { added, removed, changed };
}

function diffLinkList(
  before: DiffLinkSnapshot[],
  after: DiffLinkSnapshot[]
): {
  added: DiffLinkSnapshot[];
  removed: DiffLinkSnapshot[];
  changed: DiffLinkChange[];
} {
  const beforeMap = new Map(before.map(l => [l.name, l]));
  const afterMap = new Map(after.map(l => [l.name, l]));
  const added: DiffLinkSnapshot[] = [];
  const removed: DiffLinkSnapshot[] = [];
  const changed: DiffLinkChange[] = [];

  for (const [name, afterLink] of afterMap) {
    const beforeLink = beforeMap.get(name);
    if (!beforeLink) {
      added.push(afterLink);
    } else if (
      beforeLink.target !== afterLink.target ||
      beforeLink.required !== afterLink.required ||
      beforeLink.multi !== afterLink.multi
    ) {
      changed.push({ name, before: beforeLink, after: afterLink });
    }
  }
  for (const [name, beforeLink] of beforeMap) {
    if (!afterMap.has(name)) {
      removed.push(beforeLink);
    }
  }

  added.sort((a, b) => a.name.localeCompare(b.name));
  removed.sort((a, b) => a.name.localeCompare(b.name));
  changed.sort((a, b) => a.name.localeCompare(b.name));
  return { added, removed, changed };
}

/**
 * Compare two SDL sources and return a structured diff. The "applied"
 * source is what the running server has loaded; the "on-disk" source
 * is whatever the editor most recently saved. Either side can fail
 * to parse — the function returns gracefully with `errors` populated.
 */
export function computeSchemaDiff(
  appliedSdl: string,
  onDiskSdl: string
): SchemaDiffSummary {
  const applied = parseSdl(appliedSdl, "applied");
  const onDisk = parseSdl(onDiskSdl, "onDisk");

  const errors = [...applied.errors, ...onDisk.errors];
  if (!applied.modules || !onDisk.modules) {
    return {
      changed: false,
      added: [],
      removed: [],
      modified: [],
      errors
    };
  }

  const appliedTypes = indexTypes(applied.modules);
  const onDiskTypes = indexTypes(onDisk.modules);

  const added: DiffTypeSnapshot[] = [];
  const removed: DiffTypeSnapshot[] = [];
  const modified: DiffModifiedType[] = [];

  for (const [key, snap] of onDiskTypes) {
    if (!appliedTypes.has(key)) {
      added.push(snap);
    }
  }
  for (const [key, snap] of appliedTypes) {
    if (!onDiskTypes.has(key)) {
      removed.push(snap);
    }
  }
  for (const [key, afterSnap] of onDiskTypes) {
    const beforeSnap = appliedTypes.get(key);
    if (!beforeSnap) {
      continue;
    }

    const propDiff = diffPropertyList(
      beforeSnap.properties,
      afterSnap.properties
    );
    const linkDiff = diffLinkList(beforeSnap.links, afterSnap.links);
    const noChange = propDiff.added.length === 0 &&
      propDiff.removed.length === 0 &&
      propDiff.changed.length === 0 &&
      linkDiff.added.length === 0 &&
      linkDiff.removed.length === 0 &&
      linkDiff.changed.length === 0 &&
      beforeSnap.abstract === afterSnap.abstract;
    if (noChange) {
      continue;
    }

    modified.push({
      module: afterSnap.module,
      name: afterSnap.name,
      addedProperties: propDiff.added,
      removedProperties: propDiff.removed,
      changedProperties: propDiff.changed,
      addedLinks: linkDiff.added,
      removedLinks: linkDiff.removed,
      changedLinks: linkDiff.changed
    });
  }

  added.sort((a, b) => a.name.localeCompare(b.name));
  removed.sort((a, b) => a.name.localeCompare(b.name));
  modified.sort((a, b) => a.name.localeCompare(b.name));

  return {
    changed: added.length > 0 || removed.length > 0 || modified.length > 0,
    added,
    removed,
    modified,
    errors
  };
}
