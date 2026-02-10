import { DDLGenerator } from "./migration/ddl.ts";
import * as Types from "./migration/types.ts";

const generator = new DDLGenerator();
const operation: Types.CreateTypeOperation = {
  kind: "CreateType",
  type_name: "TestEscaping",
  properties: [
    { name: "order", type: "str", required: true, multi: false, constraints: [], annotations: {} },
    { name: "select", type: "str", required: true, multi: false, constraints: [], annotations: {} },
  ],
  links: [],
};

const statements = generator.generateDDL([operation]);
console.log("Generated DDL:");
statements.forEach(stmt => console.log(stmt));
