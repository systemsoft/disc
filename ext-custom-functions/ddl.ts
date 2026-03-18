/**
 * DDL generation for custom functions
 */

import type { CustomFunctionDef, FunctionVolatility } from "./types.ts";
import { ExtensionConfigError } from "../extensions/errors.ts";

const EDGEQL_TO_PG_TYPE: Record<string, string> = {
  bool: "boolean",
  bytes: "bytea",
  datetime: "timestamptz",
  float32: "real",
  float64: "double precision",
  int16: "smallint",
  int32: "integer",
  int64: "bigint",
  json: "jsonb",
  str: "text",
  uuid: "uuid",
};

export function mapEdgeqlTypeToPg(edgeqlType: string): string {
  const mapped = EDGEQL_TO_PG_TYPE[edgeqlType];
  if (!mapped) {
    throw new ExtensionConfigError(
      "custom-functions",
      `Unknown EdgeQL type: ${edgeqlType}`,
    );
  }
  return mapped;
}

export function generateCreateFunction(def: CustomFunctionDef): string {
  if (def.implementation.kind !== "plpgsql") {
    return ""; // Only PL/pgSQL functions need DDL
  }

  const args = def.args
    .map((a) => `${a.name} ${mapEdgeqlTypeToPg(a.type)}`)
    .join(", ");
  const returnType = mapEdgeqlTypeToPg(def.returnType);
  const volatility = mapVolatility(def.volatility ?? "volatile");

  return `CREATE OR REPLACE FUNCTION ${def.name}(${args})
RETURNS ${returnType}
LANGUAGE plpgsql
${volatility}
AS $func$
${def.implementation.body}
$func$;`;
}

export function generateDropFunction(def: CustomFunctionDef): string {
  const args = def.args
    .map((a) => mapEdgeqlTypeToPg(a.type))
    .join(", ");
  return `DROP FUNCTION IF EXISTS ${def.name}(${args});`;
}

function mapVolatility(v: FunctionVolatility): string {
  switch (v) {
    case "immutable":
      return "IMMUTABLE";
    case "stable":
      return "STABLE";
    case "volatile":
      return "VOLATILE";
  }
}
