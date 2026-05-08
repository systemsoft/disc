/**
 * Runtime validation glue for `query<T>()`'s `validate` option. (P1-28)
 *
 * Accepts either a plain `(value) => T` function or any Standard Schema
 * (https://standardschema.dev) — Zod 3.24+, Valibot, ArkType, Effect Schema,
 * etc. all conform. Throws `DiscValidationError` on rejection so callers
 * see structured issues instead of opaque library-specific errors.
 */

import { DiscValidationError } from "./errors.ts";
import type { QueryValidator, StandardSchemaIssue, StandardSchemaV1 } from "./types.ts";

/**
 * Run the validator against `value` and return the validated `T`.
 * Throws `DiscValidationError` if validation fails.
 */
export async function applyValidator<T>(
  validator: QueryValidator<T>,
  value: unknown
): Promise<T> {
  if (isStandardSchema(validator)) {
    let result;
    try {
      result = await validator["~standard"].validate(value);
    } catch (error) {
      throw new DiscValidationError(
        [{ message: error instanceof Error ? error.message : String(error) }],
        error instanceof Error ? error : undefined
      );
    }
    if ("issues" in result && result.issues) {
      throw new DiscValidationError(result.issues);
    }
    return (result as { value: T; }).value;
  }

  // Plain function validator: must throw or return T.
  try {
    return validator(value);
  } catch (error) {
    const issues: StandardSchemaIssue[] = [{
      message: error instanceof Error ? error.message : String(error)
    }];
    throw new DiscValidationError(
      issues,
      error instanceof Error ? error : undefined
    );
  }
}

function isStandardSchema<T>(
  v: QueryValidator<T>
): v is StandardSchemaV1<T> {
  return (
    typeof v === "object" &&
    v !== null &&
    "~standard" in v &&
    typeof (v as StandardSchemaV1<T>)["~standard"]?.validate === "function"
  );
}
