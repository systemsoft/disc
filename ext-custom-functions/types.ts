/**
 * Custom functions extension types for Disc database
 */

export type FunctionVolatility = "immutable" | "stable" | "volatile";

export type FunctionImplementation =
  | { kind: "sql_name"; sqlName: string }
  | { kind: "sql_expression"; expression: string }
  | { kind: "plpgsql"; body: string };

export interface CustomFunctionArg {
  name: string;
  type: string; // EdgeQL type name (str, int64, float64, etc.)
  required?: boolean;
}

export interface CustomFunctionDef {
  name: string;
  args: CustomFunctionArg[];
  returnType: string; // EdgeQL type name
  implementation: FunctionImplementation;
  volatility?: FunctionVolatility;
  description?: string;
}

export interface CustomFunctionsConfig {
  functions: CustomFunctionDef[];
}
