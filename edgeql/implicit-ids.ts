/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Gel's implicit object ids (edb/edgeql/compiler/viewgen.py
 * `_get_shape_configuration_inner`): when a binary client asks for them
 * (INJECT_OUTPUT_OBJECT_IDS — the Python client always does), every object
 * shape of the result carries its `id`, which the clients hide. The binary
 * protocol describes it (protocol/binary-server.ts `withImplicitFields`);
 * this selects it, so the rows have it.
 */

import type * as AST from "./ast.ts";

/**
 * `query` with `id` selected first in each output shape that doesn't select
 * it (a select's, a `(…) { … }`'s, a link's sub-shape). An insert or update
 * and what it writes are left as they are: Gel injects no ids there, and its
 * result is its objects' ids already.
 */
export function withImplicitIds<T extends AST.Query>(query: T): T {
  const copy = structuredClone(query);
  visit(copy);
  return copy;
}

function visit(node: unknown): void {
  if (!node || typeof node !== "object") {
    return;
  }
  if (Array.isArray(node)) {
    node.forEach(visit);
    return;
  }
  const kind = (node as { kind?: string; }).kind;
  if (kind === "InsertQuery" || kind === "UpdateQuery") {
    return;
  }
  if (kind === "Shape") {
    selectId(node as AST.Shape);
  }
  for (const value of Object.values(node)) {
    visit(value);
  }
}

/*** Put `id` first in `shape`, unless it selects it (or a splat, which does). ***/
function selectId(shape: AST.Shape): void {
  const selects = shape.elements.some(el =>
    el.splat || (!el.linkProperty && (el.name?.name ?? (el.expr.kind === "Identifier" ? el.expr.name : undefined)) === "id")
  );
  if (!selects) {
    shape.elements.unshift({ expr: { kind: "Identifier", name: "id" }, kind: "ShapeElement" });
  }
}
