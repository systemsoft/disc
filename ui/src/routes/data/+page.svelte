<script lang="ts">
  /*** IMPORT ------------------------------------------- ***/

  import { onDestroy, onMount } from "svelte";

  /*** UTILITY ------------------------------------------ ***/

  import {
    discAPI,
    type SchemaTypeDescription,
    type SchemaPropertyDescription,
    type SchemaLinkDescription,
  } from "$lib/api/client";

  type RangeOp = "=" | ">=" | "<=" | ">" | "<" | "..";

  let columns: string[] = [];
  let editDraft: Record<string, string> = {};
  let editError: string | null = null;
  let editingId: string | null = null;
  let editSubmitting = false;
  let filters: Record<string, string> = {};
  let insertDraft: Record<string, string> = {};
  let insertError: string | null = null;
  let inserting = false;
  let insertLinkDraft: Record<string, any> = {};
  let insertLinkMode: Record<string, 'select' | 'id'> = {};
  let insertSubmitting = false;
  let limit = 50;
  /*** Link picker state for insert. Each link gets either a `<select>` populated from
       `select Target { id, label } limit 100` or, when toggled, a free-text UUID input — covering
       targets that exceed the 100-row cap or rows that don’t yet exist locally. ***/
  let linkOptions: Record<string, Array<{ id: string; label: string }>> = {};
  /*** Live-watch state. When `liveOn` is true we open an EventSource to /admin/data-watch and
       refetch on every invalidate. The brief border-pulse shows when an invalidate just landed so
       users can tell the table updated even when row counts didn’t change. ***/
  let liveOn = false;
  let livePulse = false;
  let livePulseTimer: ReturnType<typeof setTimeout> | null = null;
  let liveSource: EventSource | null = null;
  let loading = false;
  let loadError: string | null = null;
  let rows: any[] = [];
  let selectedType: SchemaTypeDescription | null = null;
  /*** Sort + filter state. Sort cycles through asc → desc → off per column; filters compose with
       `and` and use type-aware EdgeQL (`ilike` for strings, `=` for numerics/bools/uuids, cast
       literals for uuid/datetime). ***/
  let sortBy: { col: string; dir: "asc" | "desc" } | null = null;
  /*** Read-write data viewer. The Disc HTTP server only exposes /query, so mutations are issued as
       EdgeQL insert/update/delete strings rather than dedicated REST endpoints. The cast-aware
       EdgeQL protocol generator handles `<uuid>"..."` literals correctly so identity-keyed updates
       round-trip through `select default::Type filter .id = <uuid>"X"`. ***/
  let types: SchemaTypeDescription[] = [];

  /*** RUNTIME ------------------------------------------ ***/

  onDestroy(() => {
    teardownLive();
  });

  onMount(async () => {
    try {
      const description = await discAPI.getSchema();

      types = description.types
        .filter((t) => t.kind === "object" && !t.abstract)
        .sort((a, b) => a.name.localeCompare(b.name));

      if (types.length > 0)
        await selectType(types[0]);
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
    }
  });

  /*** HELPER ------------------------------------------- ***/

  /** Build per-column EdgeQL filter clauses based on the prop type. */
  function buildFilterClause(type: SchemaTypeDescription): string {
    const parts: string[] = [];

    for (const p of type.properties) {
      const raw = (filters[p.name] ?? "").trim();

      if (!raw)
        continue;

      switch (p.type) {
        case "bool": {
          if (raw === "true" || raw === "false")
            parts.push(`.${p.name} = ${raw}`);

          break;
        }

        case "datetime": {
          /*** Datetime range: `>=2026-01-01`, `<2026-06-01T00:00:00`, or `2026-01-01..2026-12-31`.
               Bare-date special case: a typed value of just `YYYY-MM-DD` (no time component) means
               "match anything on that day", not exact equality at midnight UTC. Otherwise
               exact-match would never match a stored timestamptz like `2026-05-04T00:35:49`, which
               is hostile UX. ***/
          const r = parseRange(raw);
          const isDateOnly = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v.trim());

          if (r.op === "='"&& isDateOnly(r.a)) {
            const day = r.a.trim();
            /*** Compute next day with date-only math; the cast happens at emission time so we don’t
                 need a timezone-aware library. ***/
            const next = new Date(day + "T00:00:00Z");
            next.setUTCDate(next.getUTCDate() + 1);

            const tomorrow = next.toISOString().slice(0, 10);
            parts.push(`(.${p.name} >= <datetime>"${day}" and .${p.name} < <datetime>"${tomorrow}")`);

            break;
          }

          const clause = rangeClause(p.name, raw, (v) => `<datetime>"${escSql(v)}"`, (v) => v.length > 0);

          if (clause)
            parts.push(clause);

          break;
        }

        case "decimal":
        case "float32":
        case "float64":
        case "int16":
        case "int32":
        case "int64": {
          /*** Numeric range: `>=10`, `<5`, `10..20`, or exact `42`. ***/
          const clause = rangeClause(p.name, raw, (v) => v, (v) => !Number.isNaN(Number(v)));

          if (clause)
            parts.push(clause);

          break;
        }

        case "str": {
          parts.push(`.${p.name} ilike "%${escSql(raw)}%"`);
          break;
        }

        case "uuid": {
          /*** Range doesn’t make sense for uuid; only exact match is supported. EdgeQL doesn’t
               currently support `<str>.id like ...` for prefix search, so partial uuids are
               rejected at filter time. ***/
          if (/^[0-9a-fA-F-]{36}$/.test(raw))
            parts.push(`.${p.name} = <uuid>"${escSql(raw)}"`);

          break;
        }

        default: {
          parts.push(`.${p.name} = "${escSql(raw)}"`);
        }
      }
    }

    return parts.length > 0 ? ` filter ${parts.join(" and ")}` : "";
  }

  function buildOrderClause(): string {
    if (!sortBy)
      return "";

    return ` order by .${sortBy.col} ${sortBy.dir}`;
  }

  function buildSelect(type: SchemaTypeDescription): { query: string; cols: string[] } {
    /*** Schema introspection includes `id` in properties[], so don’t prepend it again — duplicate
         fields make the compiler emit invalid SQL. ***/
    const propNames = type.properties.map((p) => p.name);

    const linkNames = type.links
      .filter((l) => l.cardinality === "single")
      .map((l) => l.name);

    const orderedProps = propNames.includes("id") ?
      ["id", ...propNames.filter((n) => n !== "id")] :
      ["id", ...propNames];

    const fields = [...orderedProps, ...linkNames.map((n) => `${n}: { id }`)];

    const query =
      `select ${type.module}::${type.name} { ${fields.join(", ")} }` +
      buildFilterClause(type) +
      buildOrderClause() +
      ` limit ${limit};`;

    return { cols: [...orderedProps, ...linkNames], query };
  }

  function cancelEdit() {
    editingId = null;
    editDraft = {};
    editError = null;
  }

  function cancelInsert() {
    inserting = false;
    insertDraft = {};
    insertLinkDraft = {};
    insertLinkMode = {};
    insertError = null;
  }

  function clearFilters() {
    if (Object.values(filters).every((v) => !v))
      return;

    filters = {};
    loadRows();
  }

  async function deleteRow(row: any) {
    if (!selectedType)
      return;

    const id = row?.id;

    if (!confirm(`Delete ${selectedType.name} ${id}?`))
      return;

    const query = `delete ${selectedType.module}::${selectedType.name} filter .id = <uuid>"${id}";`;
    const result = await discAPI.executeQuery(query);

    if (result.error) {
      loadError = result.error;
      return;
    }

    await loadRows();
  }

  function escSql(v: string): string {
    return v.replace(/'/g, "\\'");
  }

  function filterPlaceholder(type: string): string {
    switch (type) {
      case "int16":
      case "int32":
      case "int64":
      case "float32":
      case "float64":
      case "decimal": {
        return ">=10, <5, 10..20";
      }

      case "datetime": {
        return ">=2026-01-01";
      }

      case "str": {
        return "contains…";
      }

      case "uuid": {
        return "full uuid";
      }

      default: {
        return type;
      }
    }
  }

  function filterTitle(type: string): string {
    switch (type) {
      case "datetime":
      case "decimal":
      case "float32":
      case "float64":
      case "int16":
      case "int32":
      case "int64": {
        return "Range syntax: >=v, <=v, >v, <v, a..b — bare value = exact match";
      }

      case "str": {
        return "Case-insensitive substring match (ilike)";
      }

      case "uuid": {
        return "Exact match only — full 36-character UUID";
      }

      default: {
        return "Exact match";
      }
    }
  }

  /** Resolve a link's `target` (e.g. "User" or "default::User") to a loaded type. */
  function findTargetType(target: string): SchemaTypeDescription | null {
    if (target.includes("::")) {
      const [mod, name] = target.split("::");
      return types.find((t) => t.module === mod && t.name === name) ?? null;
    }

    return types.find((t) => t.name === target) ?? null;
  }

  function formatCell(value: any): string {
    if (value === null || value === undefined)
      return "";

    if (typeof value === "object")
      return JSON.stringify(value);

    return String(value);
  }

  /** Build an EdgeQL link assignment for the insert, or null to omit it. */
  function linkAssignment(link: SchemaLinkDescription): string | null {
    const target = findTargetType(link.target);

    if (!target)
      throw new Error(`unknown link target: ${link.target}`);

    const qualified = `${target.module}::${target.name}`;
    const mode = insertLinkMode[link.name] ?? "select";
    const value = insertLinkDraft[link.name];
    const uuidRe = /^[0-9a-fA-F-]{36}$/;

    if (link.cardinality === "single") {
      const id = typeof value === "string" ? value.trim() : "";

      if (id === "") {
        if (link.required)
          throw new Error(`"${link.name}" is required`);

        return null;
      }

      if (!uuidRe.test(id))
        throw new Error(`"${link.name}" must be a UUID`);

      /*** Cast the UUID directly into the link’s FK column. A
           `(select Target filter .id = <uuid>'X' limit 1)` subquery would compile to a
           JSONB-returning SELECT that Postgres can’t assign to a uuid column ("expression is of
           type jsonb"), so skip the round-trip and assign the typed literal straight to
           the FK. ***/
      return `${link.name} := <uuid>"${id}"`;
    }

    /*** Multi-link assignments via inline EdgeQL aren’t currently round-trippable through the
         compiler — they need junction-table inserts that the compiler doesn’t emit from a single
         insert statement yet. Refuse early with a clear message instead of producing SQL that PG
         will reject. ***/
    let ids: string[] = [];

    if (mode === "select" && Array.isArray(value))
      ids = value.filter(Boolean);

    if (mode === "id" && typeof value === "string")
      ids = value.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);

    if (ids.length === 0) {
      if (link.required)
        throw new Error(`"${link.name}" is required`);

      return null;
    }

    throw new Error(`"${link.name}" is a multi-link — populating multi links on insert is not yet supported by Disc. Create the row first (leaving the link empty), then add associations from the related rows.`);
  }

  /** Render a value for an EdgeQL `set { x := <value> }` clause based on prop type. */
  function literalFor(prop: SchemaPropertyDescription, raw: string): string {
    const v = raw.trim();

    if (v === "" && !prop.required)
      return "{}"; /*** EdgeQL empty set ***/

    if (v === "" && prop.required)
      throw new Error(`"${prop.name}" is required`);

    switch (prop.type) {
      case "decimal":
      case "float32":
      case "float64":
      case "int16":
      case "int32":
      case "int64": {
        if (Number.isNaN(Number(v)))
          throw new Error(`"${prop.name}" must be numeric`);

        return v;
      }

      case "bool": {
        if (v === "true" || v === "false")
          return v;

        throw new Error(`"${prop.name}" must be true or false`);
      }

      case "datetime": {
        return `<datetime>"${v.replace(/'/g, "\\'")}"`;
      }

      case 'uuid': {
        return `<uuid>"${v.replace(/'/g, "\\'")}"`;
      }

      default: {
        return `"${v.replace(/'/g, "\\'")}"`;
      }
    }
  }

  async function loadLinkOptions(link: SchemaLinkDescription) {
    if (linkOptions[link.target])
      return; /*** share cache across links to same target ***/

    const target = findTargetType(link.target);

    if (!target) {
      linkOptions = { ...linkOptions, [link.target]: [] };
      return;
    }

    const label = pickLabelProp(target);
    const fields = label ? `id, ${label}` : "id";
    const query = `select ${target.module}::${target.name} { ${fields} } limit 100;`;
    const result = await discAPI.executeQuery(query);
    const rows = !result.error && Array.isArray(result.data) ? result.data : [];

    linkOptions = {
      ...linkOptions,
      [link.target]: rows.map((r: any) => ({
        id: r.id,
        label:
          label && r[label] !== null ?
            `${r[label]} — ${String(r.id).slice(0, 8)}` :
            String(r.id),
      }))
    };

    /*** If the target is empty, auto-switch to ID input so the user can still paste a UUID (e.g.
          seeded data from outside the UI). ***/
    if (linkOptions[link.target].length === 0 && insertLinkMode[link.name] === "select")
      insertLinkMode = { ...insertLinkMode, [link.name]: "id" };
  }

  async function loadRows() {
    if (!selectedType)
      return;

    loadError = null;
    loading = true;
    rows = [];

    const { cols, query } = buildSelect(selectedType);
    columns = cols;

    const result = await discAPI.executeQuery(query);
    loading = false;

    if (result.error) {
      loadError = result.error;
      return;
    }

    rows = Array.isArray(result.data) ? result.data : [];
  }

  /** Parse range syntax: `>=v`, `<=v`, `>v`, `<v`, `a..b`, or bare `v`. */
  function parseRange(raw: string): { a: string; b?: string; op: RangeOp; } {
    const range = raw.match(/^\s*(.+?)\s*\.\.\s*(.+?)\s*$/);

    if (range)
      return { a: range[1], b: range[2], op: ".." };

    const m = raw.match(/^\s*(>=|<=|>|<)\s*(.+)$/);

    if (m)
      return { a: m[2].trim(), op: m[1] as RangeOp };

    return { a: raw.trim(), op: "=" };
  }

  /** Pick a human-readable label property for dropdown options. */
  function pickLabelProp(type: SchemaTypeDescription): string | null {
    const candidates = ["name", "title", "slug", "label", "email", "username", "handle"];

    for (const c of candidates) {
      const p = type.properties.find((p) => p.name === c && p.type === "str" && !p.secret,);

      if (p)
        return p.name;
    }

    return null;
  }

  /** EdgeQL clause for a single numeric/datetime column with optional range syntax. */
  function rangeClause(
    propName: string,
    raw: string,
    cast: (v: string) => string,
    validate: (v: string) => boolean
  ): string | null {
    const r = parseRange(raw);

    if (!validate(r.a))
      return null;

    if (r.op === "..") {
      if (!r.b || !validate(r.b))
        return null;

      return `(.${propName} >= ${cast(r.a)} and .${propName} <= ${cast(r.b)})`;
    }

    return `.${propName} ${r.op} ${cast(r.a)}`;
  }

  async function selectType(type: SchemaTypeDescription) {
    selectedType = type;
    cancelInsert();
    cancelEdit();
    /*** Filters and sort are per-type; reset when switching. ***/
    sortBy = null;
    filters = {};

    /*** Re-bind live-watch to the newly-selected type’s table. ***/
    if (liveOn)
      startLive(type);

    await loadRows();
  }

  function sortIndicator(col: string): string {
    if (!sortBy || sortBy.col !== col)
      return "";

    return sortBy.dir === "asc" ? " ↑" : " ↓";
  }

  function startEdit(row: any) {
    if (!selectedType)
      return;

    editingId = row.id;
    editDraft = {};

    for (const p of writableProps(selectedType)) {
      const v = row[p.name];
      editDraft[p.name] = v == null ? '' : String(v);
    }

    editError = null;
  }

  function startInsert() {
    if (!selectedType)
      return;

    /*** Build-then-assign avoids a Svelte 5 codegen leak that emits the each-block parameter name
         (`linkDef`) into invalidation IIFEs at every writer of `insertLinkDraft` — including this
         function — when the template binds `bind:value={insertLinkDraft[linkDef.name]}`. ***/
    const nextDraft: Record<string, string> = {};

    for (const p of writableProps(selectedType)) {
      nextDraft[p.name] = "";
    }

    insertDraft = nextDraft;

    const nextLinkDraft: Record<string, any> = {};
    const nextLinkMode: Record<string, "select" | "id"> = {};

    for (const l of selectedType.links) {
      nextLinkDraft[l.name] = l.cardinality === "multi" ? [] : "";
      nextLinkMode[l.name] = "select";
    }

    insertLinkDraft = nextLinkDraft;
    insertLinkMode = nextLinkMode;
    insertError = null;
    inserting = true;

    /*** Fetch options in parallel; UI renders as they arrive. ***/
    for (const l of selectedType.links) {
      void loadLinkOptions(l);
    }
  }

  function startLive(type: SchemaTypeDescription) {
    teardownLive();

    if (!liveOn)
      return;

    const tableName = typeNameToTableName(type.name);
    liveSource = new EventSource(`/admin/data-watch?tables=${tableName}`);

    liveSource.addEventListener("invalidate", () => {
      /*** Pulse the border green for one frame, then refetch. ***/
      livePulse = true;

      if (livePulseTimer)
        clearTimeout(livePulseTimer);

      livePulseTimer = setTimeout(() => {
        livePulse = false;
      }, 600);

      void loadRows();
    });

    liveSource.addEventListener("error", () => {
      /*** Don’t tear down — EventSource auto-reconnects. The pulse will resume when the connection
           comes back. ***/
    });
  }

  async function submitEdit() {
    if (!selectedType || !editingId)
      return;

    editError = null;
    editSubmitting = true;

    try {
      const assignments: string[] = [];

      for (const p of writableProps(selectedType)) {
        assignments.push(`${p.name} := ${literalFor(p, editDraft[p.name] ?? '')}`);
      }

      const query =
        `update ${selectedType.module}::${selectedType.name} ` +
        `filter .id = <uuid>"${editingId}" set { ${assignments.join(", ")} };`;

      const result = await discAPI.executeQuery(query);

      if (result.error) {
        editError = result.error;
        return;
      }

      cancelEdit();
      await loadRows();
    } catch (err) {
      editError = err instanceof Error ? err.message : String(err);
    } finally {
      editSubmitting = false;
    }
  }

  async function submitInsert() {
    if (!selectedType)
      return;

    insertError = null;
    insertSubmitting = true;

    try {
      const assignments: string[] = [];

      for (const p of writableProps(selectedType)) {
        const raw = insertDraft[p.name] ?? "";

        /*** Skip empty inputs when the server can supply a value — either the field is optional,
             or it has a schema-level default. ***/
        if (raw === "" && (!p.required || p.hasDefault))
          continue;

        assignments.push(`${p.name} := ${literalFor(p, raw)}`);
      }

      for (const l of selectedType.links) {
        const assign = linkAssignment(l);

        if (assign)
          assignments.push(assign);
      }

      const query = `insert ${selectedType.module}::${selectedType.name} { ${assignments.join(", ")} };`;
      const result = await discAPI.executeQuery(query);

      if (result.error) {
        insertError = result.error;
        return;
      }
      cancelInsert();
      await loadRows();
    } catch (err) {
      insertError = err instanceof Error ? err.message : String(err);
    } finally {
      insertSubmitting = false;
    }
  }

  function teardownLive() {
    if (liveSource) {
      liveSource.close();
      liveSource = null;
    }

    if (livePulseTimer) {
      clearTimeout(livePulseTimer);
      livePulseTimer = null;
    }

    livePulse = false;
  }

  function toggleLinkMode(link: SchemaLinkDescription) {
    const cur = insertLinkMode[link.name] ?? "select";
    const next = cur === "select" ? "id" : "select";
    insertLinkMode = { ...insertLinkMode, [link.name]: next };

    /*** Reset the draft on mode change — the value shape differs between select-mode (string or
         string[]) and id-mode (string). ***/
    insertLinkDraft = {
      ...insertLinkDraft,
      [link.name]: next === "select" && link.cardinality === "multi" ? [] : ""
    };
  }

  function toggleLive() {
    liveOn = !liveOn;

    if (liveOn && selectedType)
      startLive(selectedType);
    else
      teardownLive();
  }

  function toggleSort(col: string) {
    if (!selectedType)
      return;

    /*** Sortable only if it’s a property column (skip the link `: { id }` slots). ***/
    const isLink = !selectedType.properties.some((p) => p.name === col);

    if (isLink)
      return;

    if (!sortBy || sortBy.col !== col)
      sortBy = { col, dir: "asc" };
    else if (sortBy.dir === "asc")
      sortBy = { col, dir: "desc" };
    else
      sortBy = null;

    loadRows();
  }

  /** Convert a PascalCase type name to snake_case (matches lib/identifiers.ts). */
  function typeNameToTableName(name: string): string {
    return name
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
      .replace(/([a-z\d])([A-Z])/g, '$1_$2')
      .toLowerCase();
  }

  /** Properties that should appear as columns and be writable (excludes computed). */
  function writableProps(type: SchemaTypeDescription): SchemaPropertyDescription[] {
    return type.properties.filter((p) => !p.computed && p.name !== "id");
  }
</script>

<style lang="scss">
  @use "@inc/uchu/scss" as *;
  @use "../../styles/mixins" as *;

  .data-viewer {
    display: flex;
    flex-direction: column;
    gap: calc(var(--grid-unit) * 2);
  }

  .viewer-header {
    align-items: center;
    background-color: var(--uchu-gray-1);
    display: flex;
    justify-content: space-between;
    margin-bottom: calc(calc(var(--grid-unit) * 2) * -1);
    padding: calc(var(--grid-unit) * 1) calc(var(--grid-unit) * 3);
    position: relative;
    top: calc(calc(var(--grid-unit) * 2) * -1);
    /* width: 100%; */

    .controls {
      align-items: center;
      display: flex;
      gap: calc(var(--grid-unit) * 2);
      font-family: var(--font-mono);
      font-size: 0.875rem;

      input[type="number"] {
        margin-left: var(--grid-unit);
        width: 80px;
      }
    }
  }

  .error-banner {
    background-color: oklch(var(--uchu-red-1-raw) / 20%);
    color: var(--uchu-red-5);
    /* background: rgb(var(--color-danger-rgb) / 0.1); */
    /* border: 1px solid var(--color-danger); */
    /* color: var(--color-danger); */
    font-family: var(--font-mono);
    font-size: 0.875rem;
    padding: calc(var(--grid-unit) * 1.5) calc(var(--grid-unit) * 2);
  }

  .viewer-body {
    display: flex;
    gap: calc(var(--grid-unit) * 3);
    min-height: 60vh;
  }

  .type-list {
    width: 300px; height: 80vh;

    border-bottom: 1px solid var(--uchu-gray-1);
    display: flex;
    flex-direction: column;
    overflow-y: auto;

    /* background: var(--color-surface); */
    /* border: 1px solid var(--color-border); */
    /* border-radius: var(--border-radius); */
    /* display: flex; */
    /* flex-direction: column; */
    gap: calc(var(--grid-unit) * 0.5);
    /* padding: calc(var(--grid-unit) * 2); */
    /* width: 300px; */

    h3 {
      font-size: 0.875rem;
      margin-bottom: var(--grid-unit);
    }

    .type-item {
      align-items: center;
      background-color: oklch(var(--uchu-gray-1-raw) / 30%);
      border: 1px solid var(--uchu-gray-1);
      border-image-slice: 1;
      cursor: pointer;
      display: flex;
      font-family: var(--font-mono);
      font-size: 0.875rem;
      gap: var(--grid-unit);
      justify-content: start;
      padding: var(--grid-unit) var(--grid-unit) var(--grid-unit) calc(var(--grid-unit) * 2);
      position: relative;
      text-align: left;
      transition: all var(--transition-fast);
      width: 100%;

      &:not(:last-of-type) {
        margin-bottom: calc(var(--grid-unit) * 0.5);
      }

      &:hover {
        background-color: var(--uchu-gray-1);
        border-image-source: linear-gradient(
          to right,
          var(--uchu-gray-2),
          var(--uchu-gray-2) 1%,
          var(--uchu-gray-1) 1%,
          var(--uchu-gray-1) 99%,
          var(--uchu-gray-2) 99%,
          var(--uchu-gray-2)
        );
      }

      &.active {
        background-color: var(--uchu-gray-1);
        border-image-source: linear-gradient(
          to right,
          var(--uchu-gray-2),
          var(--uchu-gray-2) 2%,
          var(--uchu-gray-1) 2%,
          var(--uchu-gray-1) 98%,
          var(--uchu-gray-2) 98%,
          var(--uchu-gray-2)
        );
      }
    }

    .empty {
      color: var(--color-text-dim);
      font-size: 0.75rem;
      padding: calc(var(--grid-unit) * 2);
      text-align: center;
    }
  }

  .rows-pane {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: calc(var(--grid-unit) * 2);
    overflow: hidden;

    h5 {
      margin: 0;
    }


    h3 {
      font-size: 1rem;
    }

    h4 {
      font-size: 0.875rem;
      margin-bottom: var(--grid-unit);
    }

    &.live-pulse {
      // TRON-aesthetic pulse — green ring on invalidate, fades over 600ms.
      border-color: var(--color-grid-line, #00d2ff);
      box-shadow: 0 0 12px rgba(0, 210, 255, 0.4);
    }

    .type-header {
      align-items: center;
      display: flex;
      justify-content: space-between;
      line-height: 1;
      margin-bottom: calc(var(--grid-unit) * 2.25);

      h1 {
        font-size: 1.5rem;
      }

      .type-meta {
        display: flex;
        flex-wrap: wrap;
        gap: var(--grid-unit);
      }

      .meta-tag {
        font-family: var(--font-mono);
        font-size: 0.75rem;
        text-transform: uppercase;

        &.abstract {
          color: var(--uchu-purple-4);
        }

        span {
          opacity: 0.3;
          pointer-events: none;

          &:first-of-type {
            padding-right: 0.5ch;
          }

          &:last-of-type {
            padding-left: 0.5ch;
          }
        }
      }
    }
  }

  :global(.button-live-on) {
    /* background: var(--color-grid-line, #00d2ff); */
    /* color: var(--color-bg, #000); */
  }

  .insert-form {
    /* background: var(--color-background-dark); */
    /* border: 1px solid var(--color-primary); */
    /* border-radius: var(--border-radius); */
    display: flex;
    flex-direction: column;
    gap: var(--grid-unit);
    padding: calc(var(--grid-unit) * 2);

    label {
      /* color: var(--color-text); */
      display: flex;
      flex-direction: column;
      font-family: var(--font-mono);
      font-size: 0.75rem;
      gap: calc(var(--grid-unit) * 0.5);

      input {
        /* background: var(--color-background); */
        /* border: 1px solid var(--color-border); */
        /* border-radius: var(--border-radius); */
        /* color: var(--color-text); */
        font-family: var(--font-mono);
        font-size: 0.875rem;
        padding: var(--grid-unit);
      }
    }

    .type-tag {
      /* color: var(--color-text-dim); */
      display: inline-block;
      font-size: 0.7rem;
      margin-left: var(--grid-unit);
    }

    .form-actions {
      display: flex;
      gap: var(--grid-unit);
      margin-top: var(--grid-unit);
    }

    .link-row {
      select {
        font-family: var(--font-mono);
        font-size: 0.875rem;
        padding: var(--grid-unit);
      }

      .link-mode-toggle {
        align-self: flex-start;
        margin-top: calc(var(--grid-unit) * 0.5);
      }
    }
  }

  .table-wrap {
    /* border: 1px solid var(--color-border); */
    /* border-radius: var(--border-radius); */
    overflow: auto;
  }

  table {
    border-collapse: collapse;
    font-family: var(--font-mono);
    font-size: 0.875rem;
    width: 100%;

    th, td {
      /* border-bottom: 1px solid var(--color-border); */
      padding: calc(var(--grid-unit) * 1.5);
      text-align: left;
      white-space: nowrap;
    }

    th {
      /* background: var(--color-background-dark); */
      /* color: var(--color-primary); */
      position: sticky;
      top: 0;
      user-select: none;

      &.sortable {
        cursor: pointer;

        &:hover {
          background: var(--color-surface-hover);
        }
      }

      &.active-sort {
        color: var(--color-secondary);
      }
    }

    .filter-row th {
      /* background: var(--color-surface); */
      padding: calc(var(--grid-unit) * 0.75);
      top: calc(2rem + var(--grid-unit));

      input,
      select {
        /* background: var(--color-background); */
        /* border: 1px solid var(--color-border); */
        /* border-radius: var(--border-radius); */
        /* color: var(--color-text); */
        font-family: var(--font-mono);
        font-size: 0.75rem;
        min-width: 100px;
        padding: calc(var(--grid-unit) * 0.5);
        width: 100%;

        &::placeholder {
          /* color: var(--color-text-dim); */
          font-style: italic;
        }

        &:focus {
          /* border-color: var(--color-primary); */
          outline: none;
        }
      }
    }

    .empty-row {
      padding: calc(var(--grid-unit) * 4);
      text-align: center;
      color: var(--color-text-dim);
      font-style: italic;
    }

    tbody tr:last-child td {
      border-bottom: none;
    }

    tr:hover td {
      /* background: var(--color-surface-hover); */
    }

    .editing td {
      /* background: rgb(var(--color-primary-rgb) / 0.05); */
    }

    code {
      /* color: var(--color-info); */
      font-size: 0.75rem;
    }

    input[type="text"] {
      /* background: var(--color-background); */
      /* border: 1px solid var(--color-border); */
      /* border-radius: var(--border-radius); */
      /* color: var(--color-text); */
      font-family: var(--font-mono);
      font-size: 0.875rem;
      min-width: 120px;
      padding: calc(var(--grid-unit) * 0.5);
      width: 100%;
    }
  }

  .actions-col {
    display: flex;
    gap: calc(var(--grid-unit) * 0.5);
    white-space: nowrap;
  }

  :global(.button-small) {
    font-size: 0.75rem !important;
    padding: calc(var(--grid-unit) * 0.5) var(--grid-unit) !important;
  }

  :global(.button-secondary) {
    /* background: var(--color-background) !important; */
    /* color: var(--color-text) !important; */
  }

  :global(.button-danger) {
    /* background: rgb(var(--color-danger-rgb) / 0.1) !important; */
    /* border-color: var(--color-danger) !important; */
    /* color: var(--color-danger) !important; */
  }

  .empty {
    color: var(--color-text-dim);
    font-family: var(--font-mono);
    font-size: 0.875rem;
    padding: calc(var(--grid-unit) * 4);
    text-align: center;
  }
</style>

<svelte:head>
  <title>Disc Viewer &bull; Data</title>
</svelte:head>

<div class="data-viewer">
  <header class="viewer-header">
    <!-- <h1>Data Viewer</h1> -->

    <div class="controls">
      <label>
        Limit
        <input type="number" min="1" max="500" bind:value={limit} on:change={loadRows}/>
      </label>
      <button class="button" on:click={loadRows} disabled={loading || !selectedType}>
        {loading ? 'Loading...' : 'Refresh'}
      </button>
      <button
        class="button"
        on:click={startInsert}
        disabled={!selectedType || inserting}
      >
        + New
      </button>
      <button
        class="button button-secondary"
        on:click={clearFilters}
        disabled={!selectedType ||
          (Object.values(filters).every((v) => !v) && !sortBy)}
        title="Clear all column filters and sort"
      >
        Clear
      </button>
      <button
        class="button"
        class:button-live-on={liveOn}
        on:click={toggleLive}
        disabled={!selectedType}
        title="When on, the table re-fetches automatically as the underlying rows change."
      >
        {liveOn ? '● Live' : '○ Live'}
      </button>
    </div>
  </header>

  {#if loadError}
    <div class="error-banner">{loadError}</div>
  {/if}

  <div class="viewer-body">
    <aside class="type-list">
      <h5 style="--ch: 12ch;">Object Types</h5>

      {#each types as type}
        <button
          class="type-item"
          class:active={selectedType?.name === type.name}
          on:click={() => selectType(type)}>
          <!-- {type.module}:: -->
          {type.name}
        </button>
      {/each}

      {#if types.length === 0 && !loadError}
        <div class="empty">No types in schema</div>
      {/if}
    </aside>

    <section class="rows-pane" class:live-pulse={livePulse}>
      <h5 style="--ch: 13ch;">Object Detail</h5>

      {#if selectedType}
        <!-- <h1>{selectedType.module}::{selectedType.name}</h1> -->

        <div class="type-header">
          <h1>{selectedType.name}</h1>

          <div class="type-meta">
            {#if selectedType.module}
              <span class="meta-tag"><span>[</span>module: {selectedType.module}<span>]</span></span>
            {/if}

            {#if selectedType.abstract}
              <span class="meta-tag abstract"><span>[</span>abstract<span>]</span></span>
            {/if}

            {#if selectedType.parentTypes.length > 0}
              <span class="meta-tag"><span>[</span>extends {selectedType.parentTypes.join(", ")}<span>]</span></span>
            {/if}
          </div>
        </div>

        {#if inserting}
          <form class="insert-form" on:submit|preventDefault={submitInsert}>
            <h4>New row</h4>
            {#each writableProps(selectedType) as prop}
              <label>
                {prop.name}{prop.required ? " *" : ""}
                <span class="type-tag">{prop.type}</span>
                <input
                  bind:value={insertDraft[prop.name]}
                  placeholder={prop.hasDefault ? "(default)" : ""}
                  required={prop.required && !prop.hasDefault}
                  type="text"/>
              </label>
            {/each}

            {#each selectedType.links as linkDef (linkDef.name)}
              <label class="link-row">
                {linkDef.name}{linkDef.required ? " *" : ""}
                <span class="type-tag">
                  → {linkDef.target}{linkDef.cardinality === 'multi' ? '[]' : ''}
                </span>
                {#if (insertLinkMode[linkDef.name] ?? 'select') === 'select'}
                  {#if linkDef.cardinality === 'multi'}
                    <select multiple bind:value={insertLinkDraft[linkDef.name]}>
                      {#each (linkOptions[linkDef.target] ?? []) as opt (opt.id)}
                        <option value={opt.id}>{opt.label}</option>
                      {/each}
                    </select>
                  {:else}
                    <select bind:value={insertLinkDraft[linkDef.name]}>
                      <option value="">{linkDef.required ? 'Select…' : '(none)'}</option>
                      {#each (linkOptions[linkDef.target] ?? []) as opt (opt.id)}
                        <option value={opt.id}>{opt.label}</option>
                      {/each}
                    </select>
                  {/if}
                {:else}
                  <input
                    bind:value={insertLinkDraft[linkDef.name]}
                    placeholder={linkDef.cardinality === 'multi' ? 'UUIDs (comma-separated)' : 'UUID'}
                    type="text"/>
                {/if}
                <button
                  class="button button-small button-secondary link-mode-toggle"
                  on:click={() => toggleLinkMode(linkDef)}
                  type="button">
                  {(insertLinkMode[linkDef.name] ?? 'select') === 'select' ? 'Enter ID' : 'Choose from list'}
                </button>
              </label>
            {/each}

            {#if insertError}
              <div class="error-banner">{insertError}</div>
            {/if}

            <div class="form-actions">
              <button type="submit" class="button" disabled={insertSubmitting}>{insertSubmitting ? "Saving…" : "Save"}</button>
              <button type="button" class="button button-secondary" on:click={cancelInsert}>Cancel</button>
            </div>
          </form>
        {/if}

        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                {#each columns as col}
                  {@const propType =
                    selectedType.properties.find((p) => p.name === col)}
                  {@const isSortable = propType !== undefined}
                  <th
                    class:sortable={isSortable}
                    class:active-sort={sortBy?.col === col}
                    on:click={() => isSortable && toggleSort(col)}
                    title={isSortable ? 'Click to sort' : ''}
                  >
                    {col}{sortIndicator(col)}
                  </th>
                {/each}
                <th class="actions-col">Actions</th>
              </tr>
              <tr class="filter-row">
                {#each columns as col}
                  {@const prop =
                    selectedType.properties.find((p) => p.name === col)}
                  <th>
                    {#if prop && prop.type === 'bool'}
                      <select
                        bind:value={filters[col]}
                        on:change={loadRows}
                      >
                        <option value="">—</option>
                        <option value="true">true</option>
                        <option value="false">false</option>
                      </select>
                    {:else if prop}
                      <input
                        type="text"
                        placeholder={filterPlaceholder(prop.type)}
                        title={filterTitle(prop.type)}
                        bind:value={filters[col]}
                        on:keydown={(e) => e.key === 'Enter' && loadRows()}
                        on:blur={loadRows}
                     />
                    {/if}
                  </th>
                {/each}
                <th class="actions-col"></th>
              </tr>
            </thead>
            <tbody>
              {#if rows.length === 0 && !loading && !loadError}
                <tr>
                  <td colspan={columns.length + 1} class="empty-row">
                    {Object.values(filters).some((v) => v)
                      ? 'No rows match the current filters.'
                      : 'No rows.'}
                  </td>
                </tr>
              {/if}
                {#each rows as row}
                  {#if editingId === row.id}
                    <tr class="editing">
                      {#each columns as col}
                        <td>
                          {#if col === 'id'}
                            <code>{row.id}</code>
                          {:else if writableProps(selectedType).find((p) => p.name === col)}
                            <input type="text" bind:value={editDraft[col]}/>
                          {:else}
                            {formatCell(row[col])}
                          {/if}
                        </td>
                      {/each}
                      <td class="actions-col">
                        <button
                          class="button button-small"
                          on:click={submitEdit}
                          disabled={editSubmitting}
                        >
                          {editSubmitting ? '…' : 'Save'}
                        </button>
                        <button
                          class="button button-small button-secondary"
                          on:click={cancelEdit}
                        >
                          Cancel
                        </button>
                      </td>
                    </tr>
                    {#if editError}
                      <tr>
                        <td colspan={columns.length + 1}>
                          <div class="error-banner">{editError}</div>
                        </td>
                      </tr>
                    {/if}
                  {:else}
                    <tr>
                      {#each columns as col}
                        <td>{formatCell(row[col])}</td>
                      {/each}
                      <td class="actions-col">
                        <button
                          class="button button-small"
                          on:click={() => startEdit(row)}
                          disabled={editingId !== null}
                        >
                          Edit
                        </button>
                        <button
                          class="button button-small button-danger"
                          on:click={() => deleteRow(row)}
                          disabled={editingId !== null}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  {/if}
              {/each}
            </tbody>
          </table>
        </div>
      {:else}
        <div class="empty">Select a type to view its data.</div>
      {/if}
    </section>
  </div>
</div>
