/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Schema diff engine for generating migration operations
 */

import { EdgeQLCompiler } from "../compiler/compiler.ts";
import { edgeqlTypeToPgType } from "../compiler/compiler-base.ts";
import { MigrationError } from "../lib/errors.ts";
import { sqlStringLiteral } from "../lib/sql-escape.ts";
import {
  enumTypeName,
  fitIdentifier,
  linkColumnName,
  nameHash,
  propNameToColumnName,
  sequenceName,
  typeNameToTableName
} from "../lib/identifiers.ts";
import * as AST from "../schema/ast.ts";
import { enumPgTypeNames, Module, qualifyScalarReferences } from "../schema/converter.ts";
import { sdlExpressionToEdgeQL } from "../schema/expression-printer.ts";
import { modulesToSchema } from "./runtime-schema.ts";
import { scalarConstraintEdgeQL, scalarConstraintMessage } from "./scalar-constraints.ts";
import * as Types from "./types.ts";

/**
 * Per-`allTypes` memoization for the initial-migration path. (gh/geldata#5322)
 *
 * `createTypeOperation(typeDef, allTypes)` used to scan `allTypes` for each
 * call to find direct subtypes (O(N) per type → O(N²) for the whole pass)
 * and recursively walked the parent chain in `extractPropertiesWithInheritance`
 * / `extractLinksWithInheritance` (O(depth) per type → O(N²) on a deep
 * inheritance chain). This cache flips both to amortized O(1):
 *
 *   - `subtypes`: reverse parent→child map, built once per `allTypes` Map.
 *   - `props` / `links`: memoized inheritance-resolved member lists, so each
 *     parent's contribution is computed once and reused by every descendant.
 */
interface DiffCache {
  subtypes: Map<string, string[]>;
  props: Map<AST.TypeDeclaration, Types.PropertyDefinition[]>;
  links: Map<AST.TypeDeclaration, Types.LinkDefinition[]>;
}

/*** The concrete object type whose table (or junction tables) a CHECK is on. ***/
interface CheckOwner {
  shortName: string;
  table: string;
  typeName: string;
}

/*** A CHECK before its expression compiles (see `SchemaDiffer.declaredChecks`). ***/
interface PendingCheck {
  check: Omit<Types.CheckDefinition, "expression">;
  compile: (compiler: EdgeQLCompiler) => string;
  /** Said after why the expression can't be a CHECK. */
  hint: string;
  /** Where the constraint is declared, for that error. */
  where: string;
}

/*** A stored column that may hold a user scalar's values (see `SchemaDiffer.scalarColumns`). ***/
interface ScalarColumn {
  array: boolean;
  column: string;
  /** The multi link whose junction table holds the column, for a link property. */
  junction?: string;
  property: string;
  table: string;
  type: string;
}

const EXPRESSION_HINT = "A constraint expression becomes a PostgreSQL CHECK, so it may only read the object's own properties and single links.";

/*** `edgeql` in the parentheses of `on (…)`, once. ***/
function parenthesized(edgeql: string): string {
  return edgeql.startsWith("(") && edgeql.endsWith(")") ? edgeql : `(${edgeql})`;
}

export class SchemaDiffer {
  private caches = new WeakMap<
    Map<string, AST.TypeDeclaration>,
    DiffCache
  >();
  /*** The modules each type declaration `extractTypes` read is in, and its own module's name: where its expressions compile. ***/
  private typeSchemas = new WeakMap<AST.TypeDeclaration, { module: string; schema: Module[]; }>();
  /*** The EdgeQL compiler over each such schema, built when first needed (see `compilerFor`). ***/
  private compilers = new WeakMap<Module[], EdgeQLCompiler | Error>();

  private getCache(
    allTypes: Map<string, AST.TypeDeclaration>
  ): DiffCache {
    let cache = this.caches.get(allTypes);
    if (cache) {
      return cache;
    }
    const subtypes = new Map<string, string[]>();
    for (const [childName, child] of allTypes) {
      if (!child.extending) {
        continue;
      }
      for (const ext of child.extending) {
        const parentName = ext.name.parts.join("::");
        let bucket = subtypes.get(parentName);
        if (!bucket) {
          bucket = [];
          subtypes.set(parentName, bucket);
        }
        bucket.push(childName);
      }
    }
    cache = {
      subtypes,
      props: new Map(),
      links: new Map()
    };
    this.caches.set(allTypes, cache);
    return cache;
  }

  diff(oldSchema: Module[], newSchema: Module[]): Types.MigrationOperation[] {
    // `status: Status` inside `agents` names `agents::Status` (likewise any
    // scalar the module declares); qualify it on both sides so column
    // emission can't resolve it to `default::Status`.
    const next = qualifyScalarReferences(newSchema);
    this.checkDefaults(next);
    return this.diffModules(qualifyScalarReferences(oldSchema), next);
  }

  /**
   * Throws a MigrationError for the first property default of `schema` that
   * can't be its column's DEFAULT (see `EdgeQLCompiler.defaultValueSql`),
   * naming where it is declared. The schema migrated from is not checked: a
   * default of it that doesn't compile keeps the DDL an older Disc gave it.
   */
  private checkDefaults(schema: Module[]): void {
    for (const typeDef of this.extractTypes(schema).values()) {
      const properties = typeDef.members.flatMap(member =>
        member.kind === "PropertyDeclaration" ? [member] : member.kind === "LinkDeclaration" ? member.properties ?? [] : []
      );

      for (const property of properties) {
        if (!property.default || !this.isExpressionDefault(property.default))
          continue;

        const compiler = this.compilerFor(schema);

        if (compiler instanceof Error)
          throw compiler;

        const edgeql = sdlExpressionToEdgeQL(property.default);

        try {
          compiler.defaultValueSql(edgeql, this.typeSchemas.get(typeDef)?.module);
        } catch (error) {
          throw new MigrationError(
            `Type '${typeDef.name.value}', property '${property.name.value}': 'default := ${edgeql}' can't be the column's default — ${
              error instanceof Error ? error.message : String(error)
            }. Disc stores a default as the column's DEFAULT, which PostgreSQL evaluates before the object exists: ` +
              `a default that reads the object's properties or runs a query is not supported yet.`
          );
        }
      }
    }
  }

  /**
   * True when `expr`, a property's default, compiles to its column's DEFAULT
   * (`EdgeQLCompiler.defaultValueSql`): anything but a literal or an enum
   * value (`Status.Active`), which the DDL generator formats as it always has.
   */
  private isExpressionDefault(expr: AST.Expression): boolean {
    if (expr.kind === "Literal")
      return false;

    return !(expr.kind === "PathExpression" && expr.source === undefined && expr.path[0] !== ".");
  }

  /*** The EdgeQL compiler over `schema`, or the error building it threw. ***/
  private compilerFor(schema: Module[]): EdgeQLCompiler | Error {
    let compiler = this.compilers.get(schema);

    if (!compiler) {
      try {
        compiler = new EdgeQLCompiler(modulesToSchema(schema), { enableAccessControl: false });
      } catch (error) {
        compiler = error instanceof Error ? error : new Error(String(error));
      }
      this.compilers.set(schema, compiler);
    }

    return compiler;
  }

  /**
   * The SQL of `property`'s default as its column's DEFAULT, compiled where
   * `owner`, the type declaring it, is — or undefined for a literal or an
   * enum value (see `isExpressionDefault`) or a default that doesn't compile
   * (`checkDefaults` reports that for the schema being migrated to).
   */
  private compiledDefault(property: AST.PropertyDeclaration, owner: AST.TypeDeclaration): string | undefined {
    const where = this.typeSchemas.get(owner);

    if (!property.default || !where || !this.isExpressionDefault(property.default))
      return undefined;

    const compiler = this.compilerFor(where.schema);

    try {
      return compiler instanceof Error ? undefined : compiler.defaultValueSql(sdlExpressionToEdgeQL(property.default), where.module);
    } catch {
      return undefined;
    }
  }

  private diffModules(oldSchema: Module[], newSchema: Module[]): Types.MigrationOperation[] {
    const operations: Types.MigrationOperation[] = [];
    /*** Convert schemas to maps for easier comparison ***/
    const oldTypes = this.extractTypes(oldSchema);
    const newTypes = this.extractTypes(newSchema);

    /*** Find types that were added ***/
    for (const [typeName, typeDef] of newTypes) {
      if (!oldTypes.has(typeName)) {
        /*** Pass `newTypes` so inherited properties/links from `extending` parents are folded into
             the CREATE op. Without this, a new concrete type that extends an abstract type ships to
             DDL missing every inherited column. ***/
        operations.push(this.createTypeOperation(typeDef, newTypes));

        /*** `index on (…)` and type-level `constraint exclusive on (…)` are standalone CREATE INDEX
             statements, not part of CREATE TABLE. Emitted right after the type so the table exists. ***/
        for (const index of this.extractIndexes(typeDef, newTypes, true)) {
          operations.push({ kind: "CreateIndex", index } as Types.CreateIndexOperation);
        }
      }
    }

    /*** Find types that were removed ***/
    for (const [typeName, oldTypeDef] of oldTypes) {
      if (!newTypes.has(typeName)) {
        /*** Surface multi-link names (own + inherited) so the DDL generator can drop the per-link
             junction tables. Without this, `DROP TABLE ... CASCADE` on the main type table leaves
             orphan `<table>_<link>` junctions behind that then collide on a future re-create. ***/
        const multiLinks = this
          .extractLinksWithInheritance(oldTypeDef, oldTypes)
          .filter(l => l.multi)
          .map(l => l.name);

        operations.push(Types.dropTypeOperation(typeName, { multiLinks }));
      }
    }

    /*** Find types that were modified ***/
    for (const [typeName, newTypeDef] of newTypes) {
      const oldTypeDef = oldTypes.get(typeName);

      if (oldTypeDef) {
        const typeOps = this.diffType(
          oldTypeDef,
          newTypeDef,
          oldTypes,
          newTypes
        );

        // Diff indexes on the surviving type. Index changes are emitted
        // as top-level CreateIndex/DropIndex ops (not TypeOperations) so
        // they map straight onto PG's standalone CREATE INDEX/DROP INDEX
        // statements. A changed definition surfaces as drop + create.
        const indexOps = this.diffIndexes(oldTypeDef, newTypeDef, oldTypes, newTypes);
        const tableName = typeNameToTableName(typeName);
        const moved = this.movedExclusiveIndexes(tableName, typeOps, indexOps, this.extractIndexes(oldTypeDef, oldTypes, false));
        const alterOps = this.withoutExclusiveChanges(tableName, typeOps, moved);

        if (alterOps.length > 0) {
          operations.push({
            kind: "AlterType",
            typeName: typeName,
            operations: alterOps
          } as Types.AlterTypeOperation);
        }

        operations.push(...indexOps.filter(op => !moved.has(this.indexOpName(op))));
      }
    }

    /*** CHECKs of type-level `constraint expression on (…)`: dropped before and added after
         every other change (see `reorderForCascade`), so the columns they read exist. ***/
    operations.push(...this.diffChecks(oldSchema, newSchema, oldTypes, newTypes));

    // Diff scalar/enum declarations (gh/geldata#8517, #2564). Disc tracks
    // scalars alongside object types so enum-value changes produce real
    // migration plans instead of silent no-ops.
    const oldScalars = this.extractScalars(oldSchema);
    const newScalars = this.extractScalars(newSchema);
    // An enum's PG type is module-qualified only while another enum shares
    // its name, so the same enum can have a different type on each side.
    const oldEnumTypes = enumPgTypeNames(oldSchema);
    const newEnumTypes = enumPgTypeNames(newSchema);
    const pgTypeName = (types: Map<string, string>, key: string): { pgTypeName?: string; } => {
      const name = types.get(key);
      return name ? { pgTypeName: name } : {};
    };

    // Added scalars
    for (const [scalarName, scalarDef] of newScalars) {
      if (!oldScalars.has(scalarName)) {
        const op: Types.CreateScalarOperation = {
          kind: "CreateScalar",
          scalarName: scalarDef.decl.name.value,
          module: scalarDef.module,
          ...pgTypeName(newEnumTypes, scalarName),
          baseType: this.isSequenceScalar(scalarName, newScalars) ? "sequence" : this.scalarBaseType(scalarDef.decl),
          enumValues: this.scalarEnumValues(scalarDef.decl)
        };
        operations.push(op);
      }
    }

    // Removed scalars
    for (const [scalarName, scalarDef] of oldScalars) {
      if (!newScalars.has(scalarName)) {
        const op: Types.DropScalarOperation = {
          kind: "DropScalar",
          scalarName: scalarDef.decl.name.value,
          module: scalarDef.module,
          ...pgTypeName(oldEnumTypes, scalarName),
          baseType: this.isSequenceScalar(scalarName, oldScalars) ? "sequence" : this.scalarBaseType(scalarDef.decl)
        };
        operations.push(op);
      }
    }

    // Renamed enum types: another enum with the same name was added/removed.
    for (const [scalarName, toTypeName] of newEnumTypes) {
      const fromTypeName = oldEnumTypes.get(scalarName);
      if (fromTypeName && fromTypeName !== toTypeName) {
        const scalarDef = newScalars.get(scalarName)!;
        const op: Types.RenameScalarOperation = {
          kind: "RenameScalar",
          scalarName: scalarDef.decl.name.value,
          module: scalarDef.module,
          fromTypeName,
          toTypeName
        };
        operations.push(op);
      }
    }

    // Modified scalars — only enum value changes are diff-able today.
    // Non-enum scalar changes (constraints, base) are out of scope and
    // surface as a no-op with a comment in DDL emission.
    for (const [scalarName, newScalarDef] of newScalars) {
      const oldScalarDef = oldScalars.get(scalarName);
      if (!oldScalarDef) {
        continue;
      }

      const oldValues = this.scalarEnumValues(oldScalarDef.decl) ?? [];
      const newValues = this.scalarEnumValues(newScalarDef.decl) ?? [];

      // Only compare enum value lists when both sides are enum-like.
      const oldIsEnum = this.isEnumScalar(oldScalarDef.decl);
      const newIsEnum = this.isEnumScalar(newScalarDef.decl);
      if (!oldIsEnum || !newIsEnum) {
        continue;
      }

      operations.push(
        ...this
          .diffEnumValues(
            newScalarDef.decl.name.value,
            newScalarDef.module,
            oldValues,
            newValues
          )
          .map(op => ({ ...op, ...pgTypeName(newEnumTypes, scalarName) }))
      );
    }

    // Diff aliases
    const oldAliases = this.extractAliases(oldSchema);
    const newAliases = this.extractAliases(newSchema);

    // Added aliases
    for (const [aliasName, aliasDef] of newAliases) {
      if (!oldAliases.has(aliasName)) {
        operations.push(
          Types.createAliasOperation(
            aliasName,
            this.extractExpressionString(aliasDef.using)
          )
        );
      }
    }

    // Removed aliases
    for (const [aliasName] of oldAliases) {
      if (!newAliases.has(aliasName)) {
        operations.push(Types.dropAliasOperation(aliasName));
      }
    }

    // Modified aliases — drop old + add new (aliases can't be altered in place)
    for (const [aliasName, newAliasDef] of newAliases) {
      const oldAliasDef = oldAliases.get(aliasName);
      if (oldAliasDef) {
        const oldExpr = this.extractExpressionString(oldAliasDef.using);
        const newExpr = this.extractExpressionString(newAliasDef.using);

        if (oldExpr !== newExpr) {
          operations.push(Types.dropAliasOperation(aliasName));
          operations.push(Types.createAliasOperation(aliasName, newExpr));
        }
      }
    }

    // Diff globals
    const oldGlobals = this.extractGlobals(oldSchema);
    const newGlobals = this.extractGlobals(newSchema);

    // Added globals
    for (const [globalName, globalDef] of newGlobals) {
      if (!oldGlobals.has(globalName)) {
        const moduleName = globalDef.module;
        const edgeqlType = this.typeToString(globalDef.decl.type);
        const pgType = this.edgeqlTypeToPgType(edgeqlType);
        operations.push(
          Types.createGlobalOperation(
            globalDef.decl.name.value,
            moduleName,
            edgeqlType,
            pgType,
            {
              required: globalDef.decl.required,
              multi: globalDef.decl.multi,
              default: globalDef.decl.default ?
                this.extractExpressionString(globalDef.decl.default) :
                undefined,
              readonly: globalDef.decl.readonly
            }
          )
        );
      }
    }

    // Removed globals
    for (const [globalName, globalDef] of oldGlobals) {
      if (!newGlobals.has(globalName)) {
        operations.push(
          Types.dropGlobalOperation(
            globalDef.decl.name.value,
            globalDef.module
          )
        );
      }
    }

    // Modified globals — drop old + add new (globals can't be altered in place)
    for (const [globalName, newGlobalDef] of newGlobals) {
      const oldGlobalDef = oldGlobals.get(globalName);
      if (oldGlobalDef) {
        const oldType = this.typeToString(oldGlobalDef.decl.type);
        const newType = this.typeToString(newGlobalDef.decl.type);
        const oldRequired = oldGlobalDef.decl.required ?? false;
        const newRequired = newGlobalDef.decl.required ?? false;
        const oldMulti = oldGlobalDef.decl.multi ?? false;
        const newMulti = newGlobalDef.decl.multi ?? false;
        const oldDefault = oldGlobalDef.decl.default ?
          this.extractExpressionString(oldGlobalDef.decl.default) :
          undefined;
        const newDefault = newGlobalDef.decl.default ?
          this.extractExpressionString(newGlobalDef.decl.default) :
          undefined;
        const oldReadonly = oldGlobalDef.decl.readonly ?? false;
        const newReadonly = newGlobalDef.decl.readonly ?? false;

        if (
          oldType !== newType ||
          oldRequired !== newRequired ||
          oldMulti !== newMulti ||
          oldDefault !== newDefault ||
          oldReadonly !== newReadonly
        ) {
          operations.push(
            Types.dropGlobalOperation(
              oldGlobalDef.decl.name.value,
              oldGlobalDef.module
            )
          );
          const pgType = this.edgeqlTypeToPgType(newType);
          operations.push(
            Types.createGlobalOperation(
              newGlobalDef.decl.name.value,
              newGlobalDef.module,
              newType,
              pgType,
              {
                required: newGlobalDef.decl.required,
                multi: newGlobalDef.decl.multi,
                default: newDefault,
                readonly: newGlobalDef.decl.readonly
              }
            )
          );
        }
      }
    }

    return this.reorderForCascade(operations);
  }

  /**
   * Cascade-aware reordering pass. (gh/geldata#8517)
   *
   * Once a property's PG type can be `disc_enum_<name>` (via the
   * scalar registry on DDLGenerator), operation order matters in PG:
   *
   *   - `CREATE TYPE` for an enum must run **before** any
   *     `ADD COLUMN ... <enum_type>` referencing it.
   *   - `DROP TYPE` (and the destructive `RecreateScalar` path) must
   *     run **after** any `DROP COLUMN`/`ALTER COLUMN TYPE` that
   *     removes the dependency, otherwise PG refuses the drop.
   *
   * Three buckets, stable within each: enum-creates first,
   * everything else in the middle (preserves the existing diff order),
   * enum-drops/recreates last. `AddEnumValue` sits in the create
   * bucket — it grows the enum's value set non-destructively, so
   * doing it before columns reference the new value is always safe.
   *
   * A `RenameScalar` to a module-qualified type frees the bare name for
   * a new same-named enum, so it runs before the creates; one back to
   * the bare name takes it over from a dropped enum, so it runs after
   * the drops.
   */
  private reorderForCascade(
    operations: Types.MigrationOperation[]
  ): Types.MigrationOperation[] {
    const checkDrops: Types.MigrationOperation[] = [];
    const renames: Types.MigrationOperation[] = [];
    const creates: Types.MigrationOperation[] = [];
    const middle: Types.MigrationOperation[] = [];
    const drops: Types.MigrationOperation[] = [];
    const renamesBack: Types.MigrationOperation[] = [];
    const checkAdds: Types.MigrationOperation[] = [];
    for (const op of operations) {
      switch (op.kind) {
        case "DropCheck":
          checkDrops.push(op);
          break;
        case "AddCheck":
          checkAdds.push(op);
          break;
        case "RenameScalar": {
          const rename = op as Types.RenameScalarOperation;
          const toBareName = rename.toTypeName === enumTypeName(rename.module, rename.scalarName, false);
          (toBareName ? renamesBack : renames).push(op);
          break;
        }
        case "CreateScalar":
        case "AddEnumValue":
          creates.push(op);
          break;
        case "DropScalar":
        case "RecreateScalar":
          drops.push(op);
          break;
        default:
          middle.push(op);
      }
    }
    return [...checkDrops, ...renames, ...creates, ...middle, ...drops, ...renamesBack, ...checkAdds];
  }

  /**
   * Every enum-typed scalar declared in `schema`, mapped to its PG enum
   * type. Used to prime `DDLGenerator.setEnumScalars(...)` so column
   * emission resolves user scalar names to their PG `disc_enum_<name>`
   * type instead of the TEXT fallback. Non-enum scalars are excluded
   * because they map to the underlying PG type at column emission and
   * have no PG type of their own. (gh/geldata#8517)
   *
   * Keys both qualified (`module::Name`) and unqualified (`Name`)
   * forms because property type strings can appear either way
   * depending on how the SDL referenced the scalar — properties in
   * the same module typically use the bare name; cross-module
   * references use the qualified form. When enums share a name, the
   * bare form is the default module's (`diff` qualifies a bare
   * reference to another module's own enum).
   */
  enumScalarNames(schema: Module[]): Map<string, string> {
    const names = new Map<string, string>();
    for (const [qualifiedName, pgTypeName] of enumPgTypeNames(schema)) {
      const bareName = qualifiedName.slice(qualifiedName.lastIndexOf("::") + 2);
      names.set(qualifiedName, pgTypeName);
      if (qualifiedName.startsWith("default::") || !names.has(bareName)) {
        names.set(bareName, pgTypeName);
      }
    }
    return names;
  }

  /**
   * Every non-enum scalar declared in `schema` (`scalar type Count extending
   * int64`), mapped to the type it extends. Used to prime
   * `DDLGenerator.setScalarBaseTypes(...)` so a property of such a scalar
   * gets the column type of the type it extends. Keyed like
   * `enumScalarNames`: qualified, and bare (the default module's when
   * scalars share a name). A bare base naming a scalar of the same module
   * (`scalar type Money extending Cents` in `ledger`) is qualified, as
   * `diff` qualifies property types, so it can't resolve to `default::Cents`.
   */
  scalarBaseTypes(schema: Module[]): Map<string, string> {
    const bases = new Map<string, string>();
    const scalars = this.extractScalars(schema);
    for (const [qualifiedName, { decl, module }] of scalars) {
      const base = decl.extending?.[0];
      if (!base || this.isEnumScalar(decl)) {
        continue;
      }
      const bareName = qualifiedName.slice(qualifiedName.lastIndexOf("::") + 2);
      const baseName = this.typeToString(base);
      const baseType = module !== "default" && scalars.has(`${module}::${baseName}`) ? `${module}::${baseName}` : baseName;
      bases.set(qualifiedName, baseType);
      if (qualifiedName.startsWith("default::") || !bases.has(bareName)) {
        bases.set(bareName, baseType);
      }
    }
    return bases;
  }

  /**
   * Every sequence scalar declared in `schema` (`scalar type TicketNo
   * extending sequence`, or extending another sequence scalar), mapped to
   * its PostgreSQL sequence. Used to prime
   * `DDLGenerator.setSequenceScalars(...)` so a property of such a scalar
   * defaults to the sequence's next value. Keyed like `enumScalarNames`.
   */
  sequenceScalarNames(schema: Module[]): Map<string, string> {
    const sequences = new Map<string, string>();
    const scalars = this.extractScalars(schema);
    for (const [qualifiedName, { decl, module }] of scalars) {
      if (!this.isSequenceScalar(qualifiedName, scalars)) {
        continue;
      }
      const bareName = decl.name.value;
      sequences.set(qualifiedName, sequenceName(module, bareName));
      if (module === "default" || !sequences.has(bareName)) {
        sequences.set(bareName, sequenceName(module, bareName));
      }
    }
    return sequences;
  }

  private extractTypes(modules: Module[]): Map<string, AST.TypeDeclaration> {
    const types = new Map<string, AST.TypeDeclaration>();

    for (const module of modules) {
      for (const item of module.items) {
        if (item.kind === "TypeDeclaration") {
          types.set(item.name.value, item);
          this.typeSchemas.set(item, { module: module.name, schema: modules });
        }
      }
    }

    return types;
  }

  private extractAliases(
    modules: Module[]
  ): Map<string, AST.AliasDeclaration> {
    const aliases = new Map<string, AST.AliasDeclaration>();

    for (const module of modules) {
      for (const item of module.items) {
        if (item.kind === "AliasDeclaration") {
          aliases.set(item.name.value, item);
        }
      }
    }

    return aliases;
  }

  private extractGlobals(
    modules: Module[]
  ): Map<string, { decl: AST.GlobalDeclaration; module: string; }> {
    const globals = new Map<
      string,
      { decl: AST.GlobalDeclaration; module: string; }
    >();

    for (const module of modules) {
      for (const item of module.items) {
        if (item.kind === "GlobalDeclaration") {
          const qualifiedName = `${module.name}::${item.name.value}`;
          globals.set(qualifiedName, { decl: item, module: module.name });
        }
      }
    }

    return globals;
  }

  /**
   * Map an EdgeQL type name to a PostgreSQL type name.
   * Simplified mapping for migration operations.
   */
  private edgeqlTypeToPgType(edgeqlType: string): string {
    const typeMap: Record<string, string> = {
      str: "text",
      int16: "smallint",
      int32: "integer",
      int64: "bigint",
      float32: "real",
      float64: "double precision",
      bool: "boolean",
      uuid: "uuid",
      datetime: "timestamptz",
      duration: "interval",
      bytes: "bytea",
      json: "jsonb",
      decimal: "numeric",
      bigint: "numeric"
    };
    return typeMap[edgeqlType] || "text";
  }

  createTypeOperation(
    typeDef: AST.TypeDeclaration,
    allTypes?: Map<string, AST.TypeDeclaration>
  ): Types.CreateTypeOperation {
    const properties = this.extractPropertiesWithInheritance(typeDef, allTypes);
    const inheritedLinks = this.extractLinksWithInheritance(typeDef, allTypes);
    const links = allTypes ? this.withAbstractTargets(this.withOrphanTables(typeDef, inheritedLinks, allTypes), allTypes) : inheritedLinks;
    const triggers = this.extractTriggers(typeDef);

    const op: Types.CreateTypeOperation = {
      kind: "CreateType",
      typeName: typeDef.name.value,
      properties,
      links
    };

    // Populate hierarchy fields for DDL discriminator column generation
    if (typeDef.abstract) {
      op.abstract = true;
    }

    if (typeDef.extending && typeDef.extending.length > 0) {
      op.parentTypes = typeDef.extending.map(ext => ext.name.parts.join("::"));
    }

    // Compute direct subtypes via the cached reverse parent→child map.
    // (gh/geldata#5322 — was O(N) per call, now O(1).)
    if (allTypes) {
      const subtypes = this.getCache(allTypes).subtypes.get(typeDef.name.value);
      if (subtypes && subtypes.length > 0) {
        op.subtypes = [...subtypes];
      }
    }

    if (triggers.length > 0) {
      op.triggers = triggers;
    }

    return op;
  }

  /**
   * Extract properties including inherited ones from parent types
   */
  private extractPropertiesWithInheritance(
    typeDef: AST.TypeDeclaration,
    allTypes?: Map<string, AST.TypeDeclaration>
  ): Types.PropertyDefinition[] {
    if (allTypes) {
      const cache = this.getCache(allTypes);
      const cached = cache.props.get(typeDef);
      if (cached) {
        return [...cached];
      }
      const resolved = this.computePropertiesWithInheritance(typeDef, allTypes);
      cache.props.set(typeDef, resolved);
      return [...resolved];
    }
    return this.computePropertiesWithInheritance(typeDef, allTypes);
  }

  /**
   * Look up a parent type referenced by `extending <name>` against the cache.
   * Tries the literal name first, then strips a `default::` prefix so a
   * cross-module reference like `extending default::BaseRecord` resolves
   * against the bare-keyed entry that `extractTypes` writes for every type.
   */
  private resolveExtendsTarget(
    name: string,
    allTypes: Map<string, AST.TypeDeclaration>
  ): AST.TypeDeclaration | undefined {
    const direct = allTypes.get(name);
    if (direct) {
      return direct;
    }
    if (name.startsWith("default::")) {
      return allTypes.get(name.slice("default::".length));
    }
    return undefined;
  }

  private computePropertiesWithInheritance(
    typeDef: AST.TypeDeclaration,
    allTypes?: Map<string, AST.TypeDeclaration>
  ): Types.PropertyDefinition[] {
    const properties = this.extractProperties(typeDef);
    const seenNames = new Set(properties.map(p => p.name));

    if (allTypes && typeDef.extending) {
      for (const baseRef of typeDef.extending) {
        const baseName = baseRef.name.parts.join("::");
        const baseType = this.resolveExtendsTarget(baseName, allTypes);
        if (baseType) {
          const inheritedProps = this.extractPropertiesWithInheritance(
            baseType,
            allTypes
          );
          for (const prop of inheritedProps) {
            if (!seenNames.has(prop.name)) {
              properties.push(prop);
              seenNames.add(prop.name);
            }
          }
        }
      }
    }

    return properties;
  }

  /**
   * Extract links including inherited ones from parent types
   */
  private extractLinksWithInheritance(
    typeDef: AST.TypeDeclaration,
    allTypes?: Map<string, AST.TypeDeclaration>
  ): Types.LinkDefinition[] {
    if (allTypes) {
      const cache = this.getCache(allTypes);
      const cached = cache.links.get(typeDef);
      if (cached) {
        return [...cached];
      }
      const resolved = this.computeLinksWithInheritance(typeDef, allTypes);
      cache.links.set(typeDef, resolved);
      return [...resolved];
    }
    return this.computeLinksWithInheritance(typeDef, allTypes);
  }

  private computeLinksWithInheritance(
    typeDef: AST.TypeDeclaration,
    allTypes?: Map<string, AST.TypeDeclaration>
  ): Types.LinkDefinition[] {
    const links = this.extractLinks(typeDef);
    const seenNames = new Set(links.map(l => l.name));

    if (allTypes && typeDef.extending) {
      for (const baseRef of typeDef.extending) {
        const baseName = baseRef.name.parts.join("::");
        const baseType = this.resolveExtendsTarget(baseName, allTypes);
        if (baseType) {
          const inheritedLinks = this.extractLinksWithInheritance(
            baseType,
            allTypes
          );
          for (const link of inheritedLinks) {
            if (!seenNames.has(link.name)) {
              links.push(link);
              seenNames.add(link.name);
            }
          }
        }
      }
    }

    return links;
  }

  /**
   * `typeDef`'s links with `orphanTables` set on each `delete target if
   * orphan` link that other concrete types hold too (see
   * `LinkDefinition.orphanTables`).
   */
  private withOrphanTables(
    typeDef: AST.TypeDeclaration,
    links: Types.LinkDefinition[],
    allTypes: Map<string, AST.TypeDeclaration>
  ): Types.LinkDefinition[] {
    const ownTable = typeNameToTableName(typeDef.name.value);

    return links.map(link => {
      if (link.onSourceDelete !== "DELETE TARGET IF ORPHAN") {
        return link;
      }

      const tables = this.linkHolderTables(typeDef, link.name, allTypes);
      const ownOnly = tables.length === 0 || (tables.length === 1 && tables[0] === ownTable);

      return ownOnly ? link : { ...link, orphanTables: tables };
    });
  }

  /*** `links` with `targetAbstract` set on each link whose target is an abstract type (see `LinkDefinition.targetAbstract`). ***/
  private withAbstractTargets(links: Types.LinkDefinition[], allTypes: Map<string, AST.TypeDeclaration>): Types.LinkDefinition[] {
    return links.map(link => this.resolveExtendsTarget(link.target, allTypes)?.abstract ? { ...link, targetAbstract: true } : link);
  }

  /**
   * Tables of the concrete types holding `typeDef`'s link `linkName` (Gel:
   * the same link): every concrete type among the types declaring it in
   * `typeDef`'s ancestry (itself included) and their descendants. Sorted.
   */
  private linkHolderTables(
    typeDef: AST.TypeDeclaration,
    linkName: string,
    allTypes: Map<string, AST.TypeDeclaration>
  ): string[] {
    const declarers: AST.TypeDeclaration[] = [];
    const ancestors = new Set<AST.TypeDeclaration>();
    const visitAncestors = (type: AST.TypeDeclaration): void => {
      if (ancestors.has(type)) {
        return;
      }
      ancestors.add(type);
      if (type.members.some(member => member.kind === "LinkDeclaration" && member.name.value === linkName)) {
        declarers.push(type);
      }
      for (const ext of type.extending ?? []) {
        const parent = this.resolveExtendsTarget(ext.name.parts.join("::"), allTypes);
        if (parent) {
          visitAncestors(parent);
        }
      }
    };

    const subtypes = this.getCache(allTypes).subtypes;
    const descendants = new Set<string>();
    const tables = new Set<string>();
    const visitDescendants = (name: string): void => {
      if (descendants.has(name)) {
        return;
      }
      descendants.add(name);
      if (!allTypes.get(name)?.abstract) {
        tables.add(typeNameToTableName(name));
      }
      for (const child of [...subtypes.get(name) ?? [], ...subtypes.get(`default::${name}`) ?? []]) {
        visitDescendants(child);
      }
    };

    visitAncestors(typeDef);
    for (const declarer of declarers) {
      visitDescendants(declarer.name.value);
    }

    return [...tables].sort();
  }

  private extractProperties(
    typeDef: AST.TypeDeclaration
  ): Types.PropertyDefinition[] {
    const properties: Types.PropertyDefinition[] = [];

    for (const member of typeDef.members) {
      if (member.kind === "PropertyDeclaration") {
        properties.push(this.propertyDefinition(member, typeDef));
      }
    }

    return properties;
  }

  private propertyDefinition(member: AST.PropertyDeclaration, owner: AST.TypeDeclaration): Types.PropertyDefinition {
    const rewrites = this.extractRewrites(member);
    const defaultSql = this.compiledDefault(member, owner);
    const propDef: Types.PropertyDefinition = {
      name: member.name.value,
      type: this.typeToString(member.type),
      required: member.required || false,
      multi: member.multi || false,
      default: member.default ?
        this.extractDefaultValue(member.default) :
        undefined,
      computed: member.computed ?
        this.extractExpressionString(member.computed) :
        undefined,
      constraints: this.extractConstraints(member.constraints || []),
      annotations: this.extractAnnotations(member.annotations || [])
    };
    if (rewrites.length > 0) {
      propDef.rewrites = rewrites;
    }
    if (defaultSql !== undefined) {
      propDef.defaultSql = defaultSql;
    }
    return propDef;
  }

  private extractLinks(typeDef: AST.TypeDeclaration): Types.LinkDefinition[] {
    const links: Types.LinkDefinition[] = [];

    for (const member of typeDef.members) {
      if (member.kind === "LinkDeclaration") {
        const linkDef: Types.LinkDefinition = {
          name: member.name.value,
          target: this.typeToString(member.target),
          required: member.required || false,
          multi: member.multi || false,
          cardinality: member.multi ? "many" : "one",
          onTargetDelete: this.mapOnTargetDelete(member.onTargetDelete),
          onSourceDelete: this.mapOnSourceDelete(member.onSourceDelete),
          annotations: this.extractAnnotations(member.annotations || [])
        };

        // Extract extending references
        if (member.extending && member.extending.length > 0) {
          linkDef.extending = member.extending.map(ext => ext.name.parts.join("::"));
        }

        if (member.properties && member.properties.length > 0) {
          linkDef.properties = member.properties.map(p => this.propertyDefinition(p, typeDef));
        }

        if (this.isExclusiveLink(member)) {
          linkDef.exclusive = true;
        }

        links.push(linkDef);
      }
    }

    return links;
  }

  /*** `constraint exclusive;` in a link's body (a type-level `constraint exclusive on (…)` is an index, see extractIndexes). ***/
  private isExclusiveLink(link: AST.LinkDeclaration): boolean {
    return (link.constraints ?? []).some(c => c.name?.value === "exclusive" && !c.on);
  }

  private mapOnTargetDelete(
    value?:
      | "restrict"
      | "cascade"
      | "allow"
      | "deferred restrict"
      | "set empty"
      | "delete source"
  ): Types.LinkDefinition["onTargetDelete"] {
    if (!value) {
      return undefined;
    }
    switch (value) {
      case "restrict":
        return "RESTRICT";
      case "deferred restrict":
        return "DEFERRED RESTRICT";
      case "cascade":
        return "CASCADE";
      case "delete source":
        // When the target row is deleted, delete the source row too —
        // semantically equivalent to ON DELETE CASCADE on the FK from source→target.
        return "CASCADE";
      case "allow":
        return "SET NULL";
      case "set empty":
        return "SET NULL";
      default:
        return undefined;
    }
  }

  private mapOnSourceDelete(
    value?: "allow" | "delete target" | "delete target if orphan"
  ): Types.LinkDefinition["onSourceDelete"] {
    if (!value) {
      return undefined;
    }
    switch (value) {
      case "allow":
        return "ALLOW";
      case "delete target":
        return "DELETE TARGET";
      case "delete target if orphan":
        return "DELETE TARGET IF ORPHAN";
      default:
        return undefined;
    }
  }

  private diffType(
    oldType: AST.TypeDeclaration,
    newType: AST.TypeDeclaration,
    oldAllTypes?: Map<string, AST.TypeDeclaration>,
    newAllTypes?: Map<string, AST.TypeDeclaration>
  ): Types.TypeOperation[] {
    const operations: Types.TypeOperation[] = [];
    const typeName = oldType.name.value;

    // Diff properties using resolved (inheritance-walked) sets so that
    // dropping `extending A` surfaces as DropProperty ops for the
    // properties B inherited from A. (gh/geldata#4215 — the gap was
    // own-only diff, which silently missed inherited-property losses.)
    const oldProps = oldAllTypes ?
      this.extractPropertiesWithInheritance(oldType, oldAllTypes) :
      this.extractProperties(oldType);
    const newProps = newAllTypes ?
      this.extractPropertiesWithInheritance(newType, newAllTypes) :
      this.extractProperties(newType);

    operations.push(...this.diffProperties(oldProps, newProps));

    // Rewrites of the properties both sides have, inherited ones included:
    // CREATE TYPE creates those on this type's table too. An added property
    // brings its rewrites (AddProperty); a dropped one drops them (see diffProperties).
    const oldPropsMap = new Map(oldProps.map(p => [p.name, p]));
    const newPropsMap = new Map(newProps.map(p => [p.name, p]));

    for (const [propName, newProp] of newPropsMap) {
      const oldProp = oldPropsMap.get(propName);
      if (oldProp) {
        operations.push(
          ...this.diffRewrites(
            typeName,
            propName,
            oldProp.rewrites || [],
            newProp.rewrites || []
          )
        );
      }
    }

    // Diff links using resolved (inheritance-walked) sets — same
    // reasoning as properties above. (gh/geldata#4215)
    const oldLinks = oldAllTypes ?
      this.extractLinksWithInheritance(oldType, oldAllTypes) :
      this.extractLinks(oldType);
    const newLinks = newAllTypes ?
      this.withAbstractTargets(this.withOrphanTables(newType, this.extractLinksWithInheritance(newType, newAllTypes), newAllTypes), newAllTypes) :
      this.extractLinks(newType);

    operations.push(...this.diffLinks(oldLinks, newLinks));

    // Diff triggers
    const oldTriggers = this.extractTriggers(oldType);
    const newTriggers = this.extractTriggers(newType);

    operations.push(
      ...this.diffTriggers(typeName, oldTriggers, newTriggers)
    );

    return operations;
  }

  private diffProperties(
    oldProps: Types.PropertyDefinition[],
    newProps: Types.PropertyDefinition[]
  ): Types.TypeOperation[] {
    const operations: Types.TypeOperation[] = [];

    const oldPropsMap = new Map(oldProps.map(p => [p.name, p]));
    const newPropsMap = new Map(newProps.map(p => [p.name, p]));

    // Added properties
    for (const [propName, propDef] of newPropsMap) {
      if (!oldPropsMap.has(propName)) {
        operations.push(Types.addPropertyOperation(propDef));
      }
    }

    // Removed properties, after their rewrites: dropping the column leaves their triggers
    for (const [propName, propDef] of oldPropsMap) {
      if (!newPropsMap.has(propName)) {
        for (const rewrite of propDef.rewrites ?? []) {
          operations.push({ events: [...rewrite.events], kind: "DropRewrite", propertyName: propName } as Types.DropRewriteOperation);
        }
        operations.push(Types.dropPropertyOperation(propName));
      }
    }

    // Modified properties
    for (const [propName, newProp] of newPropsMap) {
      const oldProp = oldPropsMap.get(propName);
      if (oldProp) {
        const changes = this.diffProperty(oldProp, newProp);
        if (changes.length > 0) {
          const alter: Types.AlterPropertyOperation = {
            kind: "AlterProperty",
            propertyName: propName,
            changes
          };
          // The DDL reads a changed default's SQL from the definitions.
          if (oldProp.multi || newProp.multi || oldProp.type !== newProp.type || changes.some(change => change.kind === "ChangeDefault")) {
            alter.oldProperty = oldProp;
            alter.newProperty = newProp;
          }
          operations.push(alter);
        }
      }
    }

    return operations;
  }

  private diffProperty(
    oldProp: Types.PropertyDefinition,
    newProp: Types.PropertyDefinition
  ): Types.PropertyChange[] {
    const changes: Types.PropertyChange[] = [];

    if (oldProp.type !== newProp.type) {
      changes.push({
        kind: "ChangeType",
        oldValue: oldProp.type,
        newValue: newProp.type
      });
    }

    if (oldProp.required !== newProp.required) {
      changes.push({
        kind: "ChangeRequired",
        oldValue: oldProp.required,
        newValue: newProp.required
      });
    }

    if (oldProp.multi !== newProp.multi) {
      changes.push({
        kind: "ChangeMulti",
        oldValue: oldProp.multi,
        newValue: newProp.multi
      });
    }

    if (oldProp.default !== newProp.default) {
      changes.push({
        kind: "ChangeDefault",
        oldValue: oldProp.default,
        newValue: newProp.default
      });
    }

    // Compare constraints
    const oldConstraints = new Set(oldProp.constraints);
    const newConstraints = new Set(newProp.constraints);

    for (const constraint of newConstraints) {
      if (!oldConstraints.has(constraint)) {
        changes.push({
          kind: "AddConstraint",
          newValue: constraint
        });
      }
    }

    for (const constraint of oldConstraints) {
      if (!newConstraints.has(constraint)) {
        changes.push({
          kind: "DropConstraint",
          oldValue: constraint
        });
      }
    }

    // Compare computed expression
    if (oldProp.computed !== newProp.computed) {
      changes.push({
        kind: "ChangeComputed",
        oldValue: oldProp.computed,
        newValue: newProp.computed
      });
    }

    // Compare annotations (added/removed/changed)
    const oldAnns = oldProp.annotations ?? {};
    const newAnns = newProp.annotations ?? {};
    const annNames = new Set([
      ...Object.keys(oldAnns),
      ...Object.keys(newAnns)
    ]);
    for (const name of annNames) {
      const oldVal = oldAnns[name];
      const newVal = newAnns[name];
      if (oldVal === undefined && newVal !== undefined) {
        changes.push({
          kind: "AddAnnotation",
          annotationName: name,
          newValue: newVal
        });
      } else if (oldVal !== undefined && newVal === undefined) {
        changes.push({
          kind: "DropAnnotation",
          annotationName: name,
          oldValue: oldVal
        });
      } else if (oldVal !== newVal) {
        changes.push({
          kind: "ChangeAnnotation",
          annotationName: name,
          oldValue: oldVal,
          newValue: newVal
        });
      }
    }

    return changes;
  }

  private diffLinks(
    oldLinks: Types.LinkDefinition[],
    newLinks: Types.LinkDefinition[]
  ): Types.TypeOperation[] {
    const operations: Types.TypeOperation[] = [];

    const oldLinksMap = new Map(oldLinks.map(l => [l.name, l]));
    const newLinksMap = new Map(newLinks.map(l => [l.name, l]));

    // Added links
    for (const [linkName, linkDef] of newLinksMap) {
      if (!oldLinksMap.has(linkName)) {
        operations.push({
          kind: "AddLink",
          link: linkDef
        } as Types.AddLinkOperation);
      }
    }

    // Removed links
    for (const [linkName] of oldLinksMap) {
      if (!newLinksMap.has(linkName)) {
        operations.push({
          kind: "DropLink",
          linkName: linkName
        } as Types.DropLinkOperation);
      }
    }

    // Modified links
    for (const [linkName, newLink] of newLinksMap) {
      const oldLink = oldLinksMap.get(linkName);
      if (oldLink) {
        const changes = this.diffLink(oldLink, newLink);
        // Link properties are junction-table columns, so they diff like a
        // type's properties — only while the link stays junction-backed.
        const propertyOperations = oldLink.multi && newLink.multi ?
          this.diffProperties(oldLink.properties ?? [], newLink.properties ?? []) :
          [];
        if (changes.length > 0 || propertyOperations.length > 0) {
          const alter: Types.AlterLinkOperation = {
            kind: "AlterLink",
            linkName: linkName,
            changes,
            link: newLink
          };
          if (propertyOperations.length > 0) {
            alter.propertyOperations = propertyOperations;
          }
          operations.push(alter);
        }
      }
    }

    return operations;
  }

  /**
   * Extract index definitions from a type's own members: SDL `index on (…)`
   * (`AST.Index`, a non-unique btree index) and type-level
   * `constraint exclusive on (…)` (`AST.Constraint`, a unique index). Each
   * becomes a {@link Types.IndexDefinition} whose `columns` are the columns
   * the `on` expression references, in declaration order.
   *
   * Property-level `constraint exclusive` is not handled here; it lives in
   * property diffing and CREATE TABLE emission.
   *
   * `strict` is for the schema being migrated **to**: declarations that cannot
   * become a correct index throw. The stored baseline is read leniently, so a
   * schema that was accepted before these checks existed can still be
   * migrated away from.
   */
  private extractIndexes(
    typeDef: AST.TypeDeclaration,
    allTypes: Map<string, AST.TypeDeclaration>,
    strict: boolean
  ): Types.IndexDefinition[] {
    const tableName = typeNameToTableName(typeDef.name.value);
    const indexes: Types.IndexDefinition[] = [];

    for (const member of typeDef.members) {
      const unique = member.kind === "Constraint";

      if (member.kind !== "Index" && !(member.kind === "Constraint" && member.name?.value === "exclusive" && member.on)) {
        continue;
      }

      const declaration = `${unique ? "constraint exclusive" : "index"} on ${this.describeIndexTarget(member.on!)}`;

      if (strict) {
        this.rejectIndexOnParentType(typeDef, allTypes, declaration);
      }

      const resolved = this.resolveIndexColumns(member.on!, typeDef, allTypes, strict ? declaration : null);
      const columns = resolved.map(r => r.column);
      const expressions = resolved.some(r => r.expression !== undefined) ? resolved.map(r => r.expression ?? null) : undefined;

      if (resolved.length === 1) {
        /*** A single link already gets `idx_<table>_<link>_id` with its FK; the same index again
             would collide on that name. ***/
        if (!unique && (resolved[0].kind === "link" || resolved[0].kind === "exclusive-link")) {
          continue;
        }

        /*** The property- or link-level constraint already owns this column's unique index. ***/
        if (unique && (resolved[0].kind === "exclusive-property" || resolved[0].kind === "exclusive-link")) {
          continue;
        }
      }

      indexes.push({
        name: unique ?
          fitIdentifier(`uk_${tableName}_${columns.join("_")}`) :
          member.name?.value ?? this.defaultIndexName(tableName, columns),
        table: tableName,
        columns,
        ...(expressions ? { expressions } : {}),
        unique,
        typeName: typeDef.name.value,
        declaration
      });
    }

    return indexes;
  }

  /** The `on` target as written in SDL: `(.email)` or `((.program, .name))`. */
  private describeIndexTarget(expr: AST.Expression): string {
    const describe = (e: AST.Expression): string =>
      e.kind === "TupleExpression" ?
        `(${e.elements.map(describe).join(", ")})` :
        e.kind === "PathExpression" && e.source === undefined ?
        `.${e.path.join(".").replace(/^\.+/, "")}` :
        sdlExpressionToEdgeQL(e);

    return `(${describe(expr)})`;
  }

  /**
   * Every declared index of a schema — what the database should contain.
   * Used by the index backfill (`reconcileDeclaredIndexes`), because the
   * differ itself only ever sees changes between two schema snapshots.
   */
  declaredIndexes(schema: Module[]): Types.IndexDefinition[] {
    const types = this.extractTypes(schema);

    const indexes = [...types.values()].flatMap(typeDef => [
      ...this.extractIndexes(typeDef, types, true),
      ...this.exclusiveLinkIndexes(typeDef, types)
    ]);

    // A link can be exclusive both in its block and via `constraint exclusive
    // on (.link)`; both declare the same index.
    return [...new Map(indexes.map(index => [index.name, index])).values()];
  }

  /**
   * Every CHECK a schema's constraints compile to — what the database should
   * contain (see `Types.CheckDefinition`):
   *
   * - a type-level `constraint expression on (…)`, on the table of the type
   *   and of each concrete subtype (Gel's constraints hold for subtypes);
   * - a property's `constraint expression on (__subject__ …)`, likewise, with
   *   `__subject__` read as the property;
   * - each constraint of a scalar type and of the scalars it extends, on every
   *   column holding a value of it: properties (a multi property's or an
   *   array's every element), in subtypes' tables too, and link properties in
   *   junction tables.
   *
   * Abstract types get none: their tables only mirror their subtypes' rows
   * (see `MirrorAbstractTypeOperation`), which pass their own table's CHECKs
   * first. Enum scalars have none.
   *
   * Expressions compile like a query's (see `EdgeQLCompiler.checkConstraintSql`
   * and `subjectCheckSql`), literals included; one that can't be a CHECK — it
   * reads more than one row's values, or isn't immutable — throws when
   * `strict` (the schema being migrated to), naming where it is declared. The
   * stored baseline is read leniently: such a constraint never had a CHECK, so
   * it is left out.
   */
  declaredChecks(input: Module[], strict: boolean): Types.CheckDefinition[] {
    const schema = qualifyScalarReferences(input);
    const types = this.extractTypes(schema);
    const scalars = this.extractScalars(schema);
    const moduleOf = new Map<AST.TypeDeclaration, string>();

    for (const module of schema) {
      for (const item of module.items) {
        if (item.kind === "TypeDeclaration")
          moduleOf.set(item, module.name);
      }
    }

    const pending = [...types.values()]
      .filter(typeDef => !typeDef.abstract)
      .flatMap(typeDef => {
        const shortName = typeDef.name.value.slice(typeDef.name.value.lastIndexOf(":") + 1);
        const owner = { shortName, table: typeNameToTableName(typeDef.name.value), typeName: `${moduleOf.get(typeDef) ?? "default"}::${shortName}` };

        return [
          ...this.expressionConstraints(typeDef, types, new Set()).map(constraint => this.typeCheck(owner, constraint)),
          ...this.propertyDeclarations(typeDef, types, new Map()).flatMap(property => this.propertyChecks(owner, property)),
          ...this.scalarColumns(typeDef, types, owner.table).flatMap(column => this.scalarChecks(owner, column, scalars))
        ];
      });

    if (pending.length === 0)
      return [];

    let compiler: EdgeQLCompiler;

    try {
      compiler = new EdgeQLCompiler(modulesToSchema(schema), { enableAccessControl: false });
    } catch (error) {
      if (strict)
        throw error;

      return [];
    }

    const checks = new Map<string, Types.CheckDefinition>();

    for (const { check, compile, hint, where } of pending) {
      try {
        checks.set(`${check.table}.${check.name}`, { ...check, expression: compile(compiler) });
      } catch (error) {
        if (strict) {
          throw new MigrationError(
            `${where}: '${check.declaration}' can't be enforced — ${error instanceof Error ? error.message : String(error)}. ${hint}`
          );
        }
      }
    }

    return [...checks.values()];
  }

  /*** The CHECK of a type-level `constraint expression on (…)` on the table of `owner`. ***/
  private typeCheck(owner: CheckOwner, constraint: AST.Constraint): PendingCheck {
    const edgeql = sdlExpressionToEdgeQL(constraint.on!);

    return {
      check: {
        declaration: `constraint expression on ${parenthesized(edgeql)}`,
        detail: `violated constraint 'std::expression' on object type '${owner.typeName}'`,
        message: constraint.errmessage?.replaceAll("{__subject__}", owner.shortName) ?? `invalid ${owner.shortName}`,
        name: fitIdentifier(`ck_${owner.table}_${nameHash(edgeql)}`),
        ownerTable: owner.table,
        subject: `type '${owner.typeName}'`,
        table: owner.table,
        typeName: owner.typeName
      },
      compile: compiler => compiler.checkConstraintSql(edgeql, owner.table),
      hint: EXPRESSION_HINT,
      where: `Type '${owner.typeName}'`
    };
  }

  /**
   * The CHECKs of a property's `constraint expression on (__subject__ …)`,
   * with `__subject__` read as the property. Each replaces the CHECK Disc
   * emitted for it before it compiled these (`replaces`), whose SQL was the
   * expression's text with `__subject__` swapped for the column.
   */
  private propertyChecks(owner: CheckOwner, property: AST.PropertyDeclaration): PendingCheck[] {
    const name = property.name.value;
    const column = propNameToColumnName(name);

    return (property.constraints ?? [])
      .filter(constraint => constraint.name?.value === "expression" && constraint.on !== undefined)
      .map(constraint => {
        const written = sdlExpressionToEdgeQL(constraint.on!);
        const edgeql = sdlExpressionToEdgeQL(AST.replaceSubject(constraint.on!, { kind: "PathExpression", path: [".", name] }));

        return {
          check: {
            declaration: `constraint expression on ${parenthesized(written)}`,
            detail: `violated constraint 'std::expression' on property '${name}' of object type '${owner.typeName}'`,
            message: constraint.errmessage?.replaceAll("{__subject__}", name) ?? `invalid ${name}`,
            name: fitIdentifier(`ck_${owner.table}_${nameHash(`property ${name}: ${written}`)}`),
            ownerTable: owner.table,
            replaces: `chk_${owner.table}_${column}_${this.extractConstraints([constraint])[0].replace(/[^a-zA-Z0-9_]/g, "_")}`,
            subject: `property '${owner.typeName}.${name}'`,
            table: owner.table,
            typeName: owner.typeName
          },
          compile: (compiler: EdgeQLCompiler) => compiler.checkConstraintSql(edgeql, owner.table),
          hint: EXPRESSION_HINT,
          where: `Type '${owner.typeName}', property '${name}'`
        };
      });
  }

  /**
   * The CHECKs the constraints of a column's scalar type (and of the scalars
   * it extends, each reported as its declaring scalar's, as in Gel) put on
   * that column: one boolean over the value, or over every element of an
   * array column. Gel's default messages and details; `errmessage` fills in
   * `{__subject__}` (the scalar's name) and the constraint's parameter.
   */
  private scalarChecks(owner: CheckOwner, column: ScalarColumn, scalars: Map<string, { decl: AST.ScalarTypeDeclaration; module: string; }>): PendingCheck[] {
    const chain = this.scalarChain(column.type, scalars);

    if (chain.length === 0)
      return [];

    const base = chain[chain.length - 1].decl.extending![0].name.parts.join("::");
    const pgType = edgeqlTypeToPgType(base);
    const target = column.junction ?
      `link property '${owner.typeName}.${column.junction}@${column.property}'` :
      `property '${owner.typeName}.${column.property}'`;

    return chain.flatMap(({ decl, key, module }) =>
      (decl.constraints ?? []).map(constraint => {
        const kind = constraint.name?.value ?? "unnamed";
        const args = constraint.args ?? [];
        const declaration = kind === "expression" ?
          `constraint expression on ${parenthesized(sdlExpressionToEdgeQL(constraint.on!))}` :
          `constraint ${kind}(${args.map(sdlExpressionToEdgeQL).join(", ")})`;
        const message = scalarConstraintMessage(constraint, decl.name.value);

        return {
          check: {
            declaration,
            detail: `violated constraint 'std::${kind}' on scalar type '${key}'`,
            message,
            name: fitIdentifier(`ck_${column.table}_${nameHash(`scalar ${key} ${column.column}: ${declaration}`)}`),
            ownerTable: owner.table,
            subject: `${target} (scalar type '${key}')`,
            table: column.table,
            typeName: owner.typeName
          },
          compile: (compiler: EdgeQLCompiler) =>
            column.array && kind === "expression" ?
              this.arrayExpressionCheck(compiler, scalarConstraintEdgeQL(constraint, base), module, column.column) :
              column.array ?
              this.arrayScalarCheck(compiler, kind, args, module, column.column, pgType) :
              compiler.subjectCheckSql(scalarConstraintEdgeQL(constraint, base), module, column.column),
          hint: "A scalar type's constraints become a PostgreSQL CHECK on each column holding a value of that type.",
          where: `Scalar type '${key}' (on ${target})`
        };
      })
    );
  }

  /**
   * A scalar's `constraint expression on (…)` over every element of an array
   * column: `disc_each_holds` (lib/stdlib-sql.ts) evaluates the expression,
   * compiled with its subject as the parameter `$1`, for each element, bound
   * as that parameter. A CHECK can't hold the subquery that would unnest the
   * array. An empty array passes, as does an element the expression is empty for.
   */
  private arrayExpressionCheck(compiler: EdgeQLCompiler, edgeql: string, module: string, column: string): string {
    const col = `"${column.replace(/"/g, "\"\"")}"`;
    return `disc_each_holds(${col}, ${sqlStringLiteral(compiler.subjectCheckSql(edgeql, module, null))})`;
  }

  /**
   * A scalar constraint over every element of an array column (a multi
   * property, or an `array<…>` of the scalar), as property-level constraints
   * on multi properties are (see `DDLGenerator.multiConstraintToCheckExpression`):
   * bounds against `ALL(col)`, `one_of` as containment, the rest through the
   * IMMUTABLE `disc_array_*` helpers. An empty array passes. The arguments
   * compile like any literal (see `subjectCheckSql`).
   */
  private arrayScalarCheck(
    compiler: EdgeQLCompiler,
    kind: string,
    args: AST.Expression[],
    module: string,
    column: string,
    pgType: string
  ): string {
    const col = `"${column.replace(/"/g, "\"\"")}"`;
    const values = args.map(arg => compiler.subjectCheckSql(sdlExpressionToEdgeQL(arg), module, column));

    switch (kind) {
      case "min_value":
        return `${values[0]} <= ALL(${col})`;
      case "max_value":
        return `${values[0]} >= ALL(${col})`;
      case "min_ex_value":
        return `${values[0]} < ALL(${col})`;
      case "max_ex_value":
        return `${values[0]} > ALL(${col})`;
      case "min_len_value":
        return `disc_array_min_len(${col}) >= ${values[0]}`;
      case "max_len_value":
        return `disc_array_max_len(${col}) <= ${values[0]}`;
      case "regexp":
        return `disc_array_all_match(${col}, ${values[0]})`;
      case "one_of":
        return `${col} <@ ARRAY[${values.join(", ")}]::${pgType}[]`;
      default:
        throw new Error(`a scalar 'constraint ${kind}' can't be checked on each element of an array or multi property yet`);
    }
  }

  /**
   * `type` (a property's type as the differ records it) and the scalars it
   * extends, nearest first: user-declared non-enum scalars only. Empty for a
   * built-in type, an enum, or a sequence.
   */
  private scalarChain(
    type: string,
    scalars: Map<string, { decl: AST.ScalarTypeDeclaration; module: string; }>
  ): { decl: AST.ScalarTypeDeclaration; key: string; module: string; }[] {
    const chain: { decl: AST.ScalarTypeDeclaration; key: string; module: string; }[] = [];
    let key: string | undefined = type.includes("::") ? type : `default::${type}`;

    while (key !== undefined && scalars.has(key) && !chain.some(entry => entry.key === key)) {
      const { decl, module }: { decl: AST.ScalarTypeDeclaration; module: string; } = scalars.get(key)!;

      if (this.isEnumScalar(decl) || this.isSequenceScalar(key, scalars))
        return [];

      chain.push({ decl, key, module });
      const base: string | undefined = decl.extending?.[0]?.name.parts.join("::");
      key = base === undefined ? undefined : base.includes("::") ? base : [`${module}::${base}`, `default::${base}`].find(candidate => scalars.has(candidate));
    }

    const root = chain[chain.length - 1]?.decl.extending?.[0];
    return root && !scalars.has(root.name.parts.join("::")) ? chain : [];
  }

  /**
   * The stored columns of a concrete type that hold scalar values: its
   * properties, own and inherited, and the link properties of its multi links
   * (columns of the link's junction table). `array` for an array column: a
   * multi property, or a property of `array<T>` (`type` is then `T`).
   */
  private scalarColumns(typeDef: AST.TypeDeclaration, types: Map<string, AST.TypeDeclaration>, table: string): ScalarColumn[] {
    const column = (property: Types.PropertyDefinition, columnTable: string, junction?: string): ScalarColumn => {
      const element = /^array<(.+)>$/.exec(property.type)?.[1];
      return {
        array: property.multi || element !== undefined,
        column: propNameToColumnName(property.name),
        junction,
        property: property.name,
        table: columnTable,
        type: element ?? property.type
      };
    };

    return [
      ...this
        .extractPropertiesWithInheritance(typeDef, types)
        .filter(property => !property.computed)
        .map(property => column(property, table)),
      ...this
        .extractLinksWithInheritance(typeDef, types)
        .filter(link => link.multi)
        .flatMap(link => (link.properties ?? []).map(property => column(property, `${table}_${link.name}`, link.name)))
    ];
  }

  /*** The stored single properties of a type and of the types it extends (a type's own declaration of a name wins). ***/
  private propertyDeclarations(
    typeDef: AST.TypeDeclaration,
    types: Map<string, AST.TypeDeclaration>,
    found: Map<string, AST.PropertyDeclaration>
  ): AST.PropertyDeclaration[] {
    for (const member of typeDef.members) {
      if (member.kind === "PropertyDeclaration" && !member.computed && !member.multi && !found.has(member.name.value))
        found.set(member.name.value, member);
    }

    for (const ext of typeDef.extending ?? []) {
      const parent = this.resolveExtendsTarget(ext.name.parts.join("::"), types);

      if (parent && parent !== typeDef)
        this.propertyDeclarations(parent, types, found);
    }

    return [...found.values()];
  }

  /*** The `constraint expression on (…)` members of a type and of the types it extends, at any depth. ***/
  private expressionConstraints(
    typeDef: AST.TypeDeclaration,
    types: Map<string, AST.TypeDeclaration>,
    seen: Set<AST.TypeDeclaration>
  ): AST.Constraint[] {
    if (seen.has(typeDef))
      return [];

    seen.add(typeDef);

    const own = typeDef.members.filter((member): member is AST.Constraint =>
      member.kind === "Constraint" && member.name?.value === "expression" && member.on !== undefined
    );
    const inherited = (typeDef.extending ?? []).flatMap(ext => {
      const parent = this.resolveExtendsTarget(ext.name.parts.join("::"), types);
      return parent ? this.expressionConstraints(parent, types, seen) : [];
    });

    return [...own, ...inherited];
  }

  /**
   * AddCheck/DropCheck for the constraint CHECKs that differ
   * between two schemas (see `declaredChecks`). A changed CHECK (another
   * errmessage, or the same expression compiling differently) is dropped
   * and added again. A dropped type's CHECKs go with its table.
   */
  private diffChecks(
    oldSchema: Module[],
    newSchema: Module[],
    oldTypes: Map<string, AST.TypeDeclaration>,
    newTypes: Map<string, AST.TypeDeclaration>
  ): Types.MigrationOperation[] {
    const key = (check: Types.CheckDefinition): string => `${check.table}.${check.name}`;
    const same = (a: Types.CheckDefinition, b: Types.CheckDefinition): boolean =>
      a.expression === b.expression && a.message === b.message && a.detail === b.detail;
    const oldChecks = new Map(this.declaredChecks(oldSchema, false).map(check => [key(check), check]));
    const newChecks = new Map(this.declaredChecks(newSchema, true).map(check => [key(check), check]));
    const survivingTables = new Set([...oldTypes.keys()].filter(name => newTypes.has(name)).map(typeNameToTableName));
    const operations: Types.MigrationOperation[] = [];

    for (const [name, check] of oldChecks) {
      const kept = newChecks.get(name);

      if ((!kept || !same(check, kept)) && survivingTables.has(check.ownerTable))
        operations.push({ check, kind: "DropCheck" } as Types.DropCheckOperation);
    }

    for (const [name, check] of newChecks) {
      const old = oldChecks.get(name);

      if (!old || !same(old, check))
        operations.push({ check, kind: "AddCheck" } as Types.AddCheckOperation);
    }

    return operations;
  }

  /**
   * Unique indexes backing link-level `constraint exclusive`, named as the DDL
   * generator names them: `uk_<table>_<link>_id` on a single link's FK column,
   * `uk_<junction>_target_id` on a multi link's junction. Declared here so
   * databases migrated before Disc honoured the constraint get them backfilled.
   */
  private exclusiveLinkIndexes(
    typeDef: AST.TypeDeclaration,
    types: Map<string, AST.TypeDeclaration>
  ): Types.IndexDefinition[] {
    if (typeDef.abstract) {
      return [];
    }

    const tableName = typeNameToTableName(typeDef.name.value);

    return this
      .extractLinksWithInheritance(typeDef, types)
      .filter(link => link.exclusive)
      .map(link => {
        const table = link.multi ? `${tableName}_${link.name}` : tableName;
        const column = link.multi ? "target_id" : linkColumnName(link.name);

        return {
          columns: [column],
          declaration: `link ${link.name} { constraint exclusive; }`,
          name: `uk_${table}_${column}`,
          table,
          typeName: typeDef.name.value,
          unique: true
        };
      });
  }

  /**
   * Every stored link property of a schema's multi links, with the junction
   * table whose column holds it — what the database should contain. Used by
   * the link-property backfill (`reconcileDeclaredLinkProperties`): schema
   * snapshots written before Disc stored link properties already declare
   * them, so diffing two snapshots alone would never add their columns.
   */
  declaredLinkProperties(schema: Module[]): Types.DeclaredLinkProperty[] {
    const types = this.extractTypes(qualifyScalarReferences(schema));

    return [...types.values()].flatMap(typeDef =>
      this
        .extractLinksWithInheritance(typeDef, types)
        .filter(link => link.multi)
        .flatMap(link =>
          (link.properties ?? []).map(property => ({
            typeName: typeDef.name.value,
            linkName: link.name,
            junctionTable: `${typeNameToTableName(typeDef.name.value)}_${link.name}`,
            property
          }))
        )
    );
  }

  /**
   * Every link of a schema with the table that stores it — what the
   * database's foreign keys and delete-target triggers should match. Used by
   * the delete-rule repair (`reconcileLinkDeleteRules`): a delete-rule change
   * migrated before Disc applied it was recorded in the snapshot only, so
   * diffing two snapshots never touches the foreign key again.
   */
  declaredLinks(schema: Module[]): Types.DeclaredLink[] {
    const types = this.extractTypes(schema);

    return [...types.values()].flatMap(typeDef =>
      this.withAbstractTargets(this.withOrphanTables(typeDef, this.extractLinksWithInheritance(typeDef, types), types), types).map(link => ({
        link,
        tableName: typeNameToTableName(typeDef.name.value),
        typeName: typeDef.name.value
      }))
    );
  }

  /**
   * For every concrete type of a schema, the tables of the abstract types it
   * extends at any depth, nearest first — the tables that keep a copy of its
   * rows (see `MirrorAbstractTypeOperation`). Empty for a type extending no
   * abstract type. Used by the mirror backfill (`reconcileAbstractMirrors`).
   */
  declaredAbstractMirrors(schema: Module[]): Types.DeclaredAbstractMirror[] {
    const types = this.extractTypes(schema);
    const abstractAncestors = (typeDef: AST.TypeDeclaration, seen: Set<AST.TypeDeclaration>): string[] =>
      (typeDef.extending ?? []).flatMap(ext => {
        const parent = this.resolveExtendsTarget(ext.name.parts.join("::"), types);
        if (!parent || seen.has(parent)) {
          return [];
        }
        seen.add(parent);
        return [...(parent.abstract ? [typeNameToTableName(parent.name.value)] : []), ...abstractAncestors(parent, seen)];
      });

    return [...types.values()]
      .filter(typeDef => !typeDef.abstract)
      .map(typeDef => ({
        abstractTables: abstractAncestors(typeDef, new Set()),
        tableName: typeNameToTableName(typeDef.name.value)
      }));
  }

  /**
   * Every type of a schema with the rewrites CREATE TYPE creates on its
   * table: those of its properties, own and inherited. Used by the rewrite
   * repair (`reconcileRewrites`): before Disc migrated rewrites, adding or
   * dropping a property with one recorded the schema without creating or
   * dropping its trigger, so diffing two snapshots never touches it again.
   */
  declaredRewrites(schema: Module[]): Types.DeclaredRewrites[] {
    const types = this.extractTypes(schema);

    return [...types.values()].map(typeDef => ({
      rewrites: this
        .extractPropertiesWithInheritance(typeDef, types)
        .flatMap(property => (property.rewrites ?? []).map(rewrite => ({ propertyName: property.name, rewrite }))),
      tableName: typeNameToTableName(typeDef.name.value),
      typeName: typeDef.name.value
    }));
  }

  /**
   * Every stored column of a schema — properties, and link properties on
   * junction tables — with the column type `columnType` gives its property.
   * Used by the TEXT-column backfill (`reconcileTextColumns`): Disc created
   * columns of types it didn't map yet as TEXT, and the stored schema
   * snapshot already declares the type, so diffing two snapshots never
   * converts them.
   */
  declaredColumns(schema: Module[], columnType: (property: Types.PropertyDefinition) => string): Types.DeclaredColumn[] {
    const types = this.extractTypes(qualifyScalarReferences(schema));
    const columns = (tableName: string, properties: Types.PropertyDefinition[]): Types.DeclaredColumn[] =>
      properties
        .filter(property => !property.computed)
        .map(property => ({
          columnName: propNameToColumnName(property.name),
          ...(property.default !== undefined ? { default: property.default } : {}),
          ...(property.multi ? { multi: true } : {}),
          pgType: columnType(property),
          propertyType: property.type,
          tableName
        }));

    return [...types.values()].flatMap(typeDef => {
      const tableName = typeNameToTableName(typeDef.name.value);

      return [
        ...columns(tableName, this.extractPropertiesWithInheritance(typeDef, types)),
        ...this
          .extractLinksWithInheritance(typeDef, types)
          .filter(link => link.multi)
          .flatMap(link => columns(`${tableName}_${link.name}`, link.properties ?? []))
      ];
    });
  }

  /**
   * Indexes are read from a type's own members and created on its own table
   * only. On a type with subtypes that would silently leave every subtype
   * table unindexed (and an `exclusive` unenforced there), so refuse it.
   */
  private rejectIndexOnParentType(
    typeDef: AST.TypeDeclaration,
    allTypes: Map<string, AST.TypeDeclaration>,
    declaration: string
  ): void {
    const name = typeDef.name.value;
    const subtypes = this.getCache(allTypes).subtypes;
    const children = subtypes.get(name) ?? subtypes.get(`default::${name}`) ?? [];

    if (children.length > 0) {
      throw new MigrationError(
        `Type '${name}' has subtypes (${
          children.join(", ")
        }): a type-level '${declaration}' is not applied to subtype tables and is not supported there yet. ` +
          `Declare it on each concrete subtype instead.`
      );
    }
  }

  /**
   * Find a property or link by name on a type or, failing that, on the types
   * it extends (nearest first).
   */
  private findMember(
    typeDef: AST.TypeDeclaration,
    allTypes: Map<string, AST.TypeDeclaration>,
    name: string
  ): AST.PropertyDeclaration | AST.LinkDeclaration | undefined {
    for (const member of typeDef.members) {
      if ((member.kind === "PropertyDeclaration" || member.kind === "LinkDeclaration") && member.name.value === name) {
        return member;
      }
    }

    for (const baseRef of typeDef.extending ?? []) {
      const base = this.resolveExtendsTarget(baseRef.name.parts.join("::"), allTypes);
      const found = base && this.findMember(base, allTypes, name);

      if (found) {
        return found;
      }
    }

    return undefined;
  }

  /**
   * Resolve an index `on` expression to its column list. A single path
   * (`.email`) yields one column; a tuple (`(.a, .b)`) yields one per
   * element, preserving order (PG composite-index column order is
   * significant). Each path is looked up on the type: a property maps to its
   * snake_case column, a single link to its FK column (`linkColumnName`).
   *
   * Multi links (junction table) and computed members (no storage) have no
   * column. With `declaration` set (used in the message) they are an
   * error; with `null` they fall back to the bare name, as they always did.
   *
   * Any other element (`str_lower(.email)`) is an expression, compiled over
   * the type's row (see `indexExpression`): its `expression` is the SQL, and
   * its `column` names it (`str_lower_email`) in the index's name.
   */
  private resolveIndexColumns(
    expr: AST.Expression,
    typeDef: AST.TypeDeclaration,
    allTypes: Map<string, AST.TypeDeclaration>,
    declaration: string | null
  ): { column: string; expression?: string; kind: "exclusive-link" | "exclusive-property" | "link" | "other"; }[] {
    if (expr.kind === "TupleExpression") {
      return expr.elements.flatMap(el => this.resolveIndexColumns(el, typeDef, allTypes, declaration));
    }

    if (expr.kind === "PathExpression" && expr.source === undefined) {
      // `.email` parses as path `[".", "email"]`; strip the EdgeQL leading
      // dot and convert the bare member name to its column.
      const leaf = expr.path.join(".").replace(/^\.+/, "");
      const member = this.findMember(typeDef, allTypes, leaf);
      const unusable = member?.kind === "LinkDeclaration" && member.multi ?
        `multi link '${leaf}' — a multi link is stored in a junction table, not in a column` :
        member?.computed ?
        `computed '${leaf}' — a computed member has no column` :
        null;

      if (unusable && declaration) {
        throw new MigrationError(`Type '${typeDef.name.value}': '${declaration}' cannot use ${unusable}.`);
      }

      if (member?.kind === "LinkDeclaration" && !unusable) {
        return [{ column: linkColumnName(leaf), kind: this.isExclusiveLink(member) ? "exclusive-link" : "link" }];
      }

      const exclusive = member?.kind === "PropertyDeclaration" && this.extractConstraints(member.constraints || []).includes("exclusive");

      return [{ column: propNameToColumnName(leaf), kind: exclusive ? "exclusive-property" : "other" }];
    }

    const edgeql = sdlExpressionToEdgeQL(expr);
    const expression = this.indexExpression(edgeql, typeDef, declaration);
    const column = edgeql.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");

    return [{ column, ...(expression === undefined ? {} : { expression }), kind: "other" }];
  }

  /**
   * `edgeql`, an element of an index of `typeDef`, as the SQL of an
   * expression index on its table (`EdgeQLCompiler.indexExpressionSql`).
   * One that can't be — it isn't immutable, or reads more than the row — is
   * a MigrationError naming `declaration`, or undefined when `declaration`
   * is null (the stored baseline is read leniently).
   */
  private indexExpression(edgeql: string, typeDef: AST.TypeDeclaration, declaration: string | null): string | undefined {
    const where = this.typeSchemas.get(typeDef);
    const compiler = where ? this.compilerFor(where.schema) : new Error(`the schema of type '${typeDef.name.value}' is unknown`);

    try {
      if (compiler instanceof Error)
        throw compiler;

      return compiler.indexExpressionSql(edgeql, typeNameToTableName(typeDef.name.value));
    } catch (error) {
      if (declaration === null)
        return undefined;

      throw new MigrationError(
        `Type '${typeDef.name.value}': '${declaration}' can't be an index — ${error instanceof Error ? error.message : String(error)}.`
      );
    }
  }

  /**
   * Deterministic snake_case name for an unnamed SDL index, mirroring the
   * inline FK-index convention (`idx_<table>_<col>` in `ddl.ts`). Composite
   * indexes join their columns with `_` so two different column sets on the
   * same table get distinct names. Names over PostgreSQL's 63-byte limit are
   * shortened by `fitIdentifier`; names that fit are never changed.
   */
  private defaultIndexName(table: string, columns: string[]): string {
    return fitIdentifier(`idx_${table}_${columns.join("_")}`);
  }

  /**
   * Stable comparison key for an index. Two indexes are "the same" when
   * their name, column list (ordered — composite order matters in PG),
   * expressions and uniqueness all match. Any difference makes them
   * distinct, so a changed definition diffs as a drop of the old key plus a
   * create of the new one.
   */
  private indexKey(index: Types.IndexDefinition): string {
    const expressions = index.expressions ? `::${index.expressions.map(expression => expression ?? "").join(",")}` : "";
    return `${index.name}::${index.unique ? "u" : "n"}::${index.columns.join(",")}${expressions}`;
  }

  /**
   * Diff old vs new index sets on a surviving type. Added indexes emit
   * `CreateIndex`; removed emit `DropIndex`. A redefined index (same name,
   * different columns/uniqueness) appears under both buckets and so emits
   * a drop followed by a create.
   */
  private diffIndexes(
    oldType: AST.TypeDeclaration,
    newType: AST.TypeDeclaration,
    oldTypes: Map<string, AST.TypeDeclaration>,
    newTypes: Map<string, AST.TypeDeclaration>
  ): Types.MigrationOperation[] {
    const operations: Types.MigrationOperation[] = [];

    const oldIndexes = this.extractIndexes(oldType, oldTypes, false);
    const newIndexes = this.extractIndexes(newType, newTypes, true);

    const oldByKey = new Map(oldIndexes.map(i => [this.indexKey(i), i]));
    const newByKey = new Map(newIndexes.map(i => [this.indexKey(i), i]));

    // Removed (or redefined) indexes — drop first so a re-create of the
    // same index name doesn't collide with the stale definition.
    for (const [key, index] of oldByKey) {
      if (!newByKey.has(key)) {
        operations.push({
          kind: "DropIndex",
          indexName: index.name
        } as Types.DropIndexOperation);
      }
    }

    // Added (or redefined) indexes.
    for (const [key, index] of newByKey) {
      if (!oldByKey.has(key)) {
        operations.push({
          kind: "CreateIndex",
          index
        } as Types.CreateIndexOperation);
      }
    }

    return operations;
  }

  /**
   * Names of the `uk_<table>_<column>` indexes whose exclusive constraint only moved between
   * the type-level form (`constraint exclusive on (.x)`) and the member-level form
   * (`x: … { constraint exclusive; }`). Both forms declare that same index, so the move is no
   * change. Diffed as-is it was a drop of one form's index plus a create of the other's under
   * the same name, and when the create ran first PostgreSQL refused it ("already exists").
   *
   * A type-level index counts only when its name is exactly the member form's name (it can
   * differ when `fitIdentifier` shortened a long one); otherwise the drop + create stands.
   */
  private movedExclusiveIndexes(
    tableName: string,
    typeOps: Types.TypeOperation[],
    indexOps: Types.MigrationOperation[],
    oldIndexes: Types.IndexDefinition[]
  ): Set<string> {
    const isTypeLevelExclusive = (index: Types.IndexDefinition): boolean =>
      index.unique && index.columns.length === 1 && index.name === `uk_${tableName}_${index.columns[0]}`;

    const droppedNames = new Set(
      indexOps.filter(op => op.kind === "DropIndex").map(op => (op as Types.DropIndexOperation).indexName)
    );
    const dropped = new Set(oldIndexes.filter(i => isTypeLevelExclusive(i) && droppedNames.has(i.name)).map(i => i.name));
    const created = new Set(
      indexOps
        .filter(op => op.kind === "CreateIndex" && isTypeLevelExclusive((op as Types.CreateIndexOperation).index))
        .map(op => (op as Types.CreateIndexOperation).index.name)
    );

    const moved = new Set<string>();

    for (const op of typeOps) {
      for (const change of this.memberExclusiveChanges(op)) {
        const name = `uk_${tableName}_${change.column}`;

        /*** Member form added while the type-level index goes, or the reverse. ***/
        if ((change.added ? dropped : created).has(name)) {
          moved.add(name);
        }
      }
    }

    return moved;
  }

  /** `typeOps` without the member-level exclusive changes whose index is in `moved`; ops left with no change are dropped. */
  private withoutExclusiveChanges(
    tableName: string,
    typeOps: Types.TypeOperation[],
    moved: Set<string>
  ): Types.TypeOperation[] {
    if (moved.size === 0) {
      return typeOps;
    }

    return typeOps.flatMap(op => {
      const movedChanges = this
        .memberExclusiveChanges(op)
        .filter(change => moved.has(`uk_${tableName}_${change.column}`))
        .map(change => change.change);

      if (movedChanges.length === 0) {
        return [op];
      }

      if (op.kind === "AlterLink") {
        const alter = op as Types.AlterLinkOperation;
        const changes = alter.changes.filter(c => !movedChanges.includes(c));
        return changes.length > 0 || (alter.propertyOperations?.length ?? 0) > 0 ? [{ ...alter, changes }] : [];
      }

      const alter = op as Types.AlterPropertyOperation;
      const changes = alter.changes.filter(c => !movedChanges.includes(c));
      return changes.length > 0 ? [{ ...alter, changes }] : [];
    });
  }

  /**
   * The member-level exclusive changes in `op` that map to a `uk_<table>_<column>` index on
   * the type's own table: a single link's `constraint exclusive` (its `<link>_id` column) or a
   * single property's. Multi links and multi properties keep their own index handling.
   */
  private memberExclusiveChanges(
    op: Types.TypeOperation
  ): { added: boolean; change: Types.LinkChange | Types.PropertyChange; column: string; }[] {
    if (op.kind === "AlterLink") {
      const alter = op as Types.AlterLinkOperation;

      if (alter.link?.multi) {
        return [];
      }

      return alter
        .changes
        .filter(c => c.kind === "ChangeExclusive")
        .map(c => ({ added: c.newValue === true, change: c, column: linkColumnName(alter.linkName) }));
    }

    if (op.kind === "AlterProperty") {
      const alter = op as Types.AlterPropertyOperation;

      if (alter.oldProperty?.multi || alter.newProperty?.multi) {
        return [];
      }

      return alter
        .changes
        .filter(c => (c.kind === "AddConstraint" && c.newValue === "exclusive") || (c.kind === "DropConstraint" && c.oldValue === "exclusive"))
        .map(c => ({ added: c.kind === "AddConstraint", change: c, column: propNameToColumnName(alter.propertyName) }));
    }

    return [];
  }

  /** The index a CreateIndex / DropIndex op acts on. */
  private indexOpName(op: Types.MigrationOperation): string {
    return op.kind === "CreateIndex" ?
      (op as Types.CreateIndexOperation).index.name :
      (op as Types.DropIndexOperation).indexName;
  }

  private extractTriggers(
    typeDef: AST.TypeDeclaration
  ): Types.TriggerDefinition[] {
    const triggers: Types.TriggerDefinition[] = [];

    for (const member of typeDef.members) {
      if (member.kind === "TriggerDeclaration") {
        triggers.push({
          name: member.name.value,
          timing: member.timing,
          events: [...member.events],
          scope: member.scope,
          body: this.extractExpressionString(member.body)
        });
      }
    }

    return triggers;
  }

  private diffTriggers(
    typeName: string,
    oldTriggers: Types.TriggerDefinition[],
    newTriggers: Types.TriggerDefinition[]
  ): Types.TypeOperation[] {
    const operations: Types.TypeOperation[] = [];

    const oldTriggersMap = new Map(oldTriggers.map(t => [t.name, t]));
    const newTriggersMap = new Map(newTriggers.map(t => [t.name, t]));

    // Added triggers
    for (const [triggerName, triggerDef] of newTriggersMap) {
      if (!oldTriggersMap.has(triggerName)) {
        operations.push(Types.addTriggerOperation(typeName, triggerDef));
      }
    }

    // Removed triggers
    for (const [triggerName] of oldTriggersMap) {
      if (!newTriggersMap.has(triggerName)) {
        operations.push(Types.dropTriggerOperation(typeName, triggerName));
      }
    }

    // Modified triggers — drop old + add new (triggers can't be altered in place)
    for (const [triggerName, newTrigger] of newTriggersMap) {
      const oldTrigger = oldTriggersMap.get(triggerName);
      if (oldTrigger) {
        const timingChanged = oldTrigger.timing !== newTrigger.timing;
        const eventsChanged = JSON.stringify([...oldTrigger.events].sort()) !==
          JSON.stringify([...newTrigger.events].sort());
        const scopeChanged = oldTrigger.scope !== newTrigger.scope;
        const bodyChanged = oldTrigger.body !== newTrigger.body;

        if (timingChanged || eventsChanged || scopeChanged || bodyChanged) {
          operations.push(Types.dropTriggerOperation(typeName, triggerName));
          operations.push(Types.addTriggerOperation(typeName, newTrigger));
        }
      }
    }

    return operations;
  }

  private extractRewrites(
    propDecl: AST.PropertyDeclaration
  ): Types.RewriteDefinition[] {
    const rewrites: Types.RewriteDefinition[] = [];

    if (propDecl.rewrites) {
      for (const rewrite of propDecl.rewrites) {
        rewrites.push({
          events: [...rewrite.events],
          body: rewrite.using
        });
      }
    }

    return rewrites;
  }

  private diffRewrites(
    typeName: string,
    propertyName: string,
    oldRewrites: Types.RewriteDefinition[],
    newRewrites: Types.RewriteDefinition[]
  ): Types.TypeOperation[] {
    const operations: Types.TypeOperation[] = [];

    // Key rewrites by their sorted event set for comparison
    const eventKey = (events: ("insert" | "update")[]): string => [...events].sort().join(",");

    const oldRewritesMap = new Map(
      oldRewrites.map(r => [eventKey(r.events), r])
    );
    const newRewritesMap = new Map(
      newRewrites.map(r => [eventKey(r.events), r])
    );

    // Removed rewrites
    for (const [key, rewriteDef] of oldRewritesMap) {
      if (!newRewritesMap.has(key)) {
        operations.push(
          Types.createDropRewriteOperation(
            typeName,
            propertyName,
            rewriteDef.events
          )
        );
      }
    }

    // Modified rewrites — drop old + add new (rewrites can't be altered in place)
    for (const [key, newRewrite] of newRewritesMap) {
      const oldRewrite = oldRewritesMap.get(key);
      if (oldRewrite) {
        if (oldRewrite.body !== newRewrite.body) {
          operations.push(
            Types.createDropRewriteOperation(
              typeName,
              propertyName,
              oldRewrite.events
            )
          );
          operations.push(
            Types.createAddRewriteOperation(
              typeName,
              propertyName,
              newRewrite
            )
          );
        }
      }
    }

    // Added rewrites, after the drops: a rewrite over other events can have the name of a dropped one
    for (const [key, rewriteDef] of newRewritesMap) {
      if (!oldRewritesMap.has(key)) {
        operations.push(
          Types.createAddRewriteOperation(typeName, propertyName, rewriteDef)
        );
      }
    }

    return operations;
  }

  private diffLink(
    oldLink: Types.LinkDefinition,
    newLink: Types.LinkDefinition
  ): Types.LinkChange[] {
    const changes: Types.LinkChange[] = [];

    if (oldLink.target !== newLink.target) {
      changes.push({
        kind: "ChangeTarget",
        oldValue: oldLink.target,
        newValue: newLink.target
      });
    }

    if (oldLink.required !== newLink.required) {
      changes.push({
        kind: "ChangeRequired",
        oldValue: oldLink.required,
        newValue: newLink.required
      });
    }

    if (oldLink.multi !== newLink.multi) {
      changes.push({
        kind: "ChangeMulti",
        oldValue: oldLink.multi,
        newValue: newLink.multi
      });
    }

    if (oldLink.cardinality !== newLink.cardinality) {
      changes.push({
        kind: "ChangeCardinality",
        oldValue: oldLink.cardinality,
        newValue: newLink.cardinality
      });
    }

    if (oldLink.onTargetDelete !== newLink.onTargetDelete) {
      changes.push({
        kind: "ChangeOnDelete",
        oldValue: oldLink.onTargetDelete,
        newValue: newLink.onTargetDelete
      });
    }

    if (oldLink.onSourceDelete !== newLink.onSourceDelete) {
      changes.push({
        kind: "ChangeOnSourceDelete",
        oldValue: oldLink.onSourceDelete,
        newValue: newLink.onSourceDelete
      });
    }

    if ((oldLink.exclusive ?? false) !== (newLink.exclusive ?? false)) {
      changes.push({
        kind: "ChangeExclusive",
        oldValue: oldLink.exclusive ?? false,
        newValue: newLink.exclusive ?? false
      });
    }

    // Compare extending arrays
    const oldExtending = JSON.stringify(
      (oldLink.extending ?? []).sort()
    );
    const newExtending = JSON.stringify(
      (newLink.extending ?? []).sort()
    );
    if (oldExtending !== newExtending) {
      changes.push({
        kind: "ChangeExtending",
        oldValue: oldLink.extending,
        newValue: newLink.extending
      });
    }

    return changes;
  }

  private typeToString(type: AST.TypeRef): string {
    let result = type.name.parts.join("::");
    if (type.params && type.params.length > 0) {
      result += `<${type.params.map(p => this.typeToString(p)).join(", ")}>`;
    }
    return result;
  }

  private extractDefaultValue(expr: AST.Expression): any {
    if (expr.kind === "Literal") {
      return expr.value;
    }
    return this.extractExpressionString(expr);
  }

  /**
   * Extract a string representation of an AST expression.
   * Used for computed property expressions.
   */
  private extractExpressionString(expr: AST.Expression): string {
    switch (expr.kind) {
      case "Literal":
        if (typeof expr.value === "string") {
          return `'${expr.value}'`;
        }
        return String(expr.value);
      case "FunctionCall":
        return `${expr.name.parts.join("::")}(${expr.args.map(a => this.extractExpressionString(a)).join(", ")})`;
      case "PathExpression":
        // EdgeQL beyond the SDL expression grammar is kept as its source text.
        return expr.source ?? expr.path.join(".");
      case "BinaryOp":
        return `${this.extractExpressionString(expr.left)} ${expr.op} ${this.extractExpressionString(expr.right)}`;
      case "UnaryOp":
        return `${expr.op} ${this.extractExpressionString(expr.operand)}`;
      case "TypeCast":
        return `<${expr.type.name.parts.join("::")}>${this.extractExpressionString(expr.expr)}`;
      case "Parameter":
        return `$${expr.name}`;
      case "ConditionalExpression":
        return `${this.extractExpressionString(expr.consequent)} if ${this.extractExpressionString(expr.test)} else ${
          this.extractExpressionString(expr.alternate)
        }`;
      case "TupleExpression":
        return `(${expr.elements.map(e => this.extractExpressionString(e)).join(", ")})`;
      default:
        return String((expr as { kind: string; }).kind);
    }
  }

  private extractConstraints(constraints: AST.Constraint[]): string[] {
    return constraints.map(constraint => {
      const name = constraint.name?.value || "unnamed";

      // Handle "expression on (...)" constraints
      if (name === "expression" && constraint.on) {
        const exprStr = this.extractExpressionString(constraint.on);
        return `expression_on(${exprStr})`;
      }

      if (constraint.args && constraint.args.length > 0) {
        const args = constraint
          .args
          .map(arg => {
            if (arg.kind === "Literal") {
              return String(arg.value);
            }

            // An expression (`-1`, `2 ^ 3`) as EdgeQL, from its SDL form, as
            // the schema an older Disc stored has it.
            return sdlExpressionToEdgeQL(arg);
          })
          .join(",");

        return `${name}(${args})`;
      }

      return name;
    });
  }

  private extractAnnotations(
    annotations: AST.Annotation[]
  ): Record<string, any> {
    const result: Record<string, any> = {};
    for (const annotation of annotations) {
      const name = annotation.name.parts.join("::");
      result[name] = annotation.value ?
        this.extractDefaultValue(annotation.value) :
        true;
    }
    return result;
  }

  // ──────────────────────────────────────────────────────────────────────
  // Scalar / enum extraction (gh/geldata#8517, #2564)
  // ──────────────────────────────────────────────────────────────────────

  private extractScalars(
    modules: Module[]
  ): Map<string, { decl: AST.ScalarTypeDeclaration; module: string; }> {
    const scalars = new Map<
      string,
      { decl: AST.ScalarTypeDeclaration; module: string; }
    >();

    for (const module of modules) {
      for (const item of module.items) {
        if (item.kind === "ScalarTypeDeclaration") {
          const qualifiedName = `${module.name}::${item.name.value}`;
          scalars.set(qualifiedName, { decl: item, module: module.name });
        }
      }
    }

    return scalars;
  }

  /**
   * Check whether a scalar extends `enum<...>`. The SDL parser stores
   * `extending enum<a, b>` as a TypeRef whose name parts begin with `enum`
   * and whose `params` carry each enum literal as a TypeRef.
   */
  private isEnumScalar(decl: AST.ScalarTypeDeclaration): boolean {
    return (decl.extending ?? []).some(
      ext => ext.name.parts[0] === "enum"
    );
  }

  /**
   * Extract enum values from a scalar declaration. Returns `undefined`
   * for non-enum scalars.
   */
  private scalarEnumValues(
    decl: AST.ScalarTypeDeclaration
  ): string[] | undefined {
    if (!this.isEnumScalar(decl)) {
      return undefined;
    }
    const enumExt = (decl.extending ?? []).find(
      ext => ext.name.parts[0] === "enum"
    );
    if (!enumExt || !enumExt.params) {
      return [];
    }
    return enumExt.params.map(p => p.name.parts.join("::"));
  }

  /**
   * Whether the scalar `qualifiedName` extends `sequence`, directly or
   * through other scalars (`scalar type Sub extending Base`, `Base` a
   * sequence scalar). As in Gel, each such scalar is a sequence with a
   * counter of its own (edb/pgsql/delta.py creates a sequence for every
   * subtype of `std::sequence`). A bare base names a scalar of the same
   * module before one of `default`.
   */
  private isSequenceScalar(
    qualifiedName: string,
    scalars: Map<string, { decl: AST.ScalarTypeDeclaration; module: string; }>,
    seen = new Set<string>()
  ): boolean {
    const scalar = scalars.get(qualifiedName);
    const base = scalar?.decl.extending?.[0]?.name.parts.join("::");
    if (!scalar || !base || seen.has(qualifiedName)) {
      return false;
    }
    if (base === "sequence") {
      return true;
    }
    const next = base.includes("::") ? base : [`${scalar.module}::${base}`, `default::${base}`].find(key => scalars.has(key));
    return next !== undefined && this.isSequenceScalar(next, scalars, seen.add(qualifiedName));
  }

  /**
   * Render the base type of a scalar (used for `CreateScalarOperation`).
   * Non-enum scalars get the joined `extending` chain; enum scalars get
   * the literal `"enum"` string (values live separately).
   */
  private scalarBaseType(decl: AST.ScalarTypeDeclaration): string {
    if (this.isEnumScalar(decl)) {
      return "enum";
    }
    if (!decl.extending || decl.extending.length === 0) {
      return "anyscalar";
    }
    return decl
      .extending
      .map(ext => ext.name.parts.join("::"))
      .join(", ");
  }

  /**
   * Diff old vs new enum value lists. PostgreSQL's enum semantics
   * dictate the operation choice:
   *
   *  - **Pure additions** at the tail → emit `AddEnumValueOperation`
   *    (one per added value). Cheap, non-destructive.
   *  - **Pure additions in the middle** → emit `AddEnumValueOperation`
   *    with `before` set to the next existing value. Still cheap.
   *  - **Removals** or **reorders** → emit a single
   *    `RecreateScalarOperation` flagged unsafe. Recreating an enum
   *    means dropping/re-adding any column referencing it; the
   *    unsafe-gate refuses these without `--unsafe`.
   */
  private diffEnumValues(
    scalarName: string,
    moduleName: string,
    oldValues: string[],
    newValues: string[]
  ): Types.MigrationOperation[] {
    if (oldValues.length === 0 && newValues.length === 0) {
      return [];
    }

    const oldSet = new Set(oldValues);
    const newSet = new Set(newValues);

    const removed = oldValues.filter(v => !newSet.has(v));
    const added = newValues.filter(v => !oldSet.has(v));

    // If anything was removed, this is a recreate (PG has no DROP VALUE).
    if (removed.length > 0) {
      return [
        {
          kind: "RecreateScalar",
          scalarName,
          module: moduleName,
          enumValues: newValues,
          oldEnumValues: oldValues,
          reason: "removed-values"
        } as Types.RecreateScalarOperation
      ];
    }

    // No removals — check whether the *retained* values kept their order.
    const retainedOld = oldValues.filter(v => newSet.has(v));
    const retainedNew = newValues.filter(v => oldSet.has(v));
    const reordered = retainedOld.length > 0 &&
      retainedOld.some((v, i) => v !== retainedNew[i]);

    if (reordered) {
      return [
        {
          kind: "RecreateScalar",
          scalarName,
          module: moduleName,
          enumValues: newValues,
          oldEnumValues: oldValues,
          reason: "reordered-values"
        } as Types.RecreateScalarOperation
      ];
    }

    // Pure additions — emit one ADD VALUE per new entry, anchored by
    // its successor in the new list when that successor still exists.
    const ops: Types.AddEnumValueOperation[] = [];
    for (const value of added) {
      const newIdx = newValues.indexOf(value);
      // Find the closest *successor* that already existed in the old
      // list; anchor with `before` so PG inserts in the right slot.
      let anchorBefore: string | undefined;
      for (let i = newIdx + 1; i < newValues.length; i++) {
        if (oldSet.has(newValues[i])) {
          anchorBefore = newValues[i];
          break;
        }
      }
      ops.push({
        kind: "AddEnumValue",
        scalarName,
        module: moduleName,
        value,
        ...(anchorBefore ? { before: anchorBefore } : {})
      });
    }
    return ops;
  }
}
