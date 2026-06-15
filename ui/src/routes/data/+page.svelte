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
  /*** Monotonic token so overlapping loadRows() calls commit in issue order —
       only the latest-issued load writes its result. See loadRows(). ***/
  let loadSeq = 0;
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

          if (r.op === "=" && isDateOnly(r.a)) {
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

  function buildSelect(type: SchemaTypeDescription): { cols: string[]; query: string; } {
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
      case "decimal":
      case "float32":
      case "float64":
      case "int16":
      case "int32":
      case "int64": {
        return ">=10, <5, 10..20";
      }

      case "datetime": {
        return ">=2026-01-01";
      }

      case "str": {
        return "contains…";
      }

      case "uuid": {
        return "UUID";
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

  /** Resolve a link’s `target` (e.g. "User" or "default::User") to a loaded type. */
  function findTargetType(target: string): SchemaTypeDescription | null {
    if (target.includes("::")) {
      const [mod, name] = target.split("::");
      return types.find((t) => t.module === mod && t.name === name) ?? null;
    }

    return types.find((t) => t.name === target) ?? null;
  }

  function getDataLink(value: any) {
    if (Array.isArray(value) && value.some(v => v.id))
      return value.find(v => v.id).id;
    else
      return "";
  }

  function isDataLink(value: any): boolean {
    /*** A link will most likely have an ID ***/
    if (Array.isArray(value) && value.some(v => v.id))
      return true;

    return false;
  }

  function isPropReadOnly(prop: string): boolean {
    if (!selectedType)
      return false;

    const property = selectedType.properties.filter((p) => p.name === prop)[0];

    if (property && property.readonly)
      return true;

    return false;
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

      case "uuid": {
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

    /*** Guard against out-of-order overlapping loads. Clicking "Clear Filters"
         while a filter input has focus fires the input's `onblur={loadRows}`
         (a filtered query) immediately before the click runs `clearFilters`
         (an unfiltered query). Both are in flight at once; without this token
         the slower-resolving one wins and can leave stale rows on screen (the
         filtered 1-row result clobbering the cleared 3-row result). Only the
         most recently issued load is allowed to commit its result. ***/
    const seq = ++loadSeq;

    loadError = null;
    loading = true;
    rows = [];

    const { cols, query } = buildSelect(selectedType);
    columns = cols;

    const result = await discAPI.executeQuery(query);

    /*** A newer load started while we were awaiting — drop this stale result. ***/
    if (seq !== loadSeq)
      return;

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

    return sortBy.dir === "asc" ? "↑" : "↓";
  }

  function startEdit(row: any) {
    if (!selectedType)
      return;

    editingId = row.id;
    editDraft = {};

    for (const p of writableProps(selectedType)) {
      const v = row[p.name];
      editDraft[p.name] = v == null ? "" : String(v);
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

  .controls {
    align-items: center;
    display: flex;
    gap: calc(var(--grid-unit) * 2);
    font-family: var(--font-mono);
    font-size: 0.75rem;
    text-transform: uppercase;

    input[type="number"] {
      border-color: var(--uchu-gray-2);
      padding: calc(var(--grid-unit) / 2 - 2px) 5px;
      width: 80px;
    }

    button {
      font-size: inherit;
      text-transform: inherit;
    }
  }

  .error-banner {
    background-color: oklch(var(--uchu-red-1-raw) / 20%);
    color: var(--uchu-red-5);
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
    gap: calc(var(--grid-unit) * 0.5);
    overflow-y: auto;
    padding-bottom: var(--grid-unit);

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

    &.live-pulse {
      // Pulse — green ring on invalidate, fades over 600ms.
      border-color: var(--color-grid-line, #00d2ff);
      box-shadow: 0 0 12px rgba(0, 210, 255, 0.4);
    }

    .type-header {
      align-items: center;
      display: flex;
      justify-content: space-between;
      line-height: 1;

      h1 {
        font-size: 1.5rem;

        span {
          color: var(--uchu-yin-3);
        }
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

  .insert-wrap {
    display: grid;
    gap: calc(var(--grid-unit) * 2);
    grid-template-columns: repeat(2, 1fr);
  }

  .empty {
    color: var(--color-text-dim);
    font-family: var(--font-mono);
    font-size: 0.875rem;
    padding: calc(var(--grid-unit) * 4);
    text-align: center;
  }

  .type-filters {
    background-color: oklch(var(--uchu-gray-1-raw) / 30%);
    border: 1px solid var(--uchu-gray-1);
    display: grid;
    gap: var(--grid-unit);
    grid-template-columns: repeat(3, 1fr);
    padding: calc(var(--grid-unit) * 2);

    .type-filter {
      display: flex;
      flex-direction: row;

      button {
        background-color: oklch(var(--uchu-gray-2-raw) / 50%);
        letter-spacing: normal;
        margin-right: calc(var(--grid-unit) / 1.5);
        padding: calc(var(--grid-unit) / 2 - 2px) calc(var(--grid-unit) * 3) calc(var(--grid-unit) / 2 - 2px) var(--grid-unit);
        position: relative;

        span {
          position: absolute;
          right: calc(var(--grid-unit) + 0.5px);
        }
      }

      input {
        border-color: var(--uchu-gray-2);
        flex: 1;
        padding: calc(var(--grid-unit) / 2 - 2px) var(--grid-unit);
        width: 100%;

        &::placeholder {
          color: var(--uchu-yin-3);
        }
      }
    }
  }

  .data-wrap {
    display: grid;
    gap: calc(var(--grid-unit) * 2);
    grid-template-columns: repeat(2, 1fr);

    .empty-row {
      color: var(--uchu-yin-3);
      font-family: var(--font-display);
      font-size: 0.875rem;
      letter-spacing: 0.1rem;
      text-transform: lowercase;
      user-select: none;
    }
  }

  .data {
    border: 1px solid;
    font-family: var(--font-mono);
    font-size: 0.875rem;
    transition: box-shadow 0.2s;

    &:not(:hover) {
      .data-actions {
        .button-danger {
          background-color: var(--uchu-red-9);
        }
      }
    }

    &:hover {
      .data-actions {
        .button-danger {
          background-color: var(--uchu-red-4);
        }
      }
    }

    &:not(.editing) {
      border-color: var(--uchu-gray-1);

      input {
        border-bottom-color: transparent;
      }
    }

    &.editing {
      border-color: var(--uchu-yin-3);
      box-shadow: 5px 5px var(--uchu-yin-3);

      .error-banner {
        border-bottom: 1px solid var(--uchu-gray-2);
      }

      input,
      select {
        border-bottom-color: var(--uchu-gray-1);
      }
    }

    .data-header {
      background-color: oklch(var(--uchu-gray-1-raw) / 50%);
      border-bottom: 1px solid var(--uchu-gray-1);
      flex-direction: row;
      font-weight: 500;
      margin-bottom: var(--grid-unit);
      padding: var(--grid-unit) calc(var(--grid-unit) * 2);
    }

    input,
    select {
      padding: 0;
      width: 100%;

      + button {
        margin-left: var(--grid-unit);
        white-space: nowrap;
      }
    }

    input {
      border: none;
      border-bottom: 1px solid;

      &[readonly] {
        cursor: default;
      }
    }

    select {
      border: 1px solid var(--uchu-gray-1);
      border-radius: 0;
    }

    .data-links {
      border-top: 1px solid var(--uchu-gray-1);
      margin-top: calc(var(--grid-unit) * 2);
      padding-bottom: calc(var(--grid-unit) * 1.25);
      padding-top: calc(var(--grid-unit) * 2);
    }

    .data-bit,
    .data-link {
      align-items: center;
      display: flex;
      flex-direction: row;
      padding-left: calc(var(--grid-unit) * 2);
      padding-right: calc(var(--grid-unit) * 2);

      .parameter {
        font-family: var(--font-mono);
        font-weight: 500;
        margin-right: 0.5ch;
        max-width: 18ch;
        overflow: hidden;
        position: relative;
        text-overflow: ellipsis;
        width: 100%;

        &::after {
          width: calc(100% - var(--ch)); height: 100%;
          bottom: 0; right: 0;

          color: var(--uchu-gray-1);
          content: "....................";
          position: absolute;
        }

        &.required {
          &::before {
            bottom: 0; right: 0;

            content: "*";
            position: absolute;
          }
        }
      }
    }

    .data-bit {
      .null {
        color: var(--uchu-gray-3);
      }
    }

    .data-actions {
      align-items: center;
      border-top: 1px solid var(--uchu-gray-1);
      display: flex;
      flex-direction: row;
      justify-content: space-between;
      margin-top: var(--grid-unit);
      padding: var(--grid-unit);

      .button-secondary {
        background-color: var(--uchu-orange-4);
      }

      .button-danger {
        transition: background-color 0.2s;
        color: var(--uchu-yang);
      }

      .links {
        font-size: 0.75rem;
      }

      .link {
        align-items: center;
        background-color: oklch(var(--uchu-gray-2-raw) / 25%);
        display: flex;
        padding-right: var(--grid-unit);

        span {
          background-color: oklch(var(--uchu-gray-2-raw) / 50%);
          color: var(--uchu-gray-9);
          margin-right: calc(var(--grid-unit) / 1.5);
          padding: calc(var(--grid-unit) / 4) var(--grid-unit);
          text-transform: uppercase;
        }
      }
    }
  }
</style>

<svelte:head>
  <title>Disc &bull; Data Explorer</title>
</svelte:head>

<div class="data-viewer">
  <div class="viewer-body">
    <aside class="type-list">
      <h5 style="--ch: 12ch;">Object Types</h5>

      {#each types as type}
        <button
          class="type-item"
          class:active={selectedType?.name === type.name}
          onclick={() => selectType(type)}>
          {type.name}
        </button>
      {/each}

      {#if types.length === 0 && !loadError}
        <div class="empty">No types in schema</div>
      {/if}
    </aside>

    <section class="rows-pane" class:live-pulse={livePulse}>
      <h5 style="--ch: 13ch;">Data Controls</h5>

      <div class="controls">
        <label for="row limit">
          Limit
          <input
            id="row limit"
            max="500"
            min="1"
            onchange={loadRows}
            type="number"
            bind:value={limit}/>
        </label>

        <button
          class="button"
          class:button-live-on={liveOn}
          disabled={!selectedType}
          onclick={toggleLive}
          title="When on, the table re-fetches automatically as the underlying rows change.">
          {liveOn ? "● Live" : "○ Live"}
        </button>

        <button
          class="button"
          disabled={loading || !selectedType}
          onclick={loadRows}>
          {loading ? "Loading…" : "Refresh View"}
        </button>

        <button
          class="button button-secondary"
          disabled={!selectedType || (Object.values(filters).every((v) => !v) && !sortBy)}
          onclick={clearFilters}
          title="Clear all column filters and sort">
          Clear Filters
        </button>

        <button
          class="button"
          disabled={!selectedType || inserting}
          onclick={startInsert}>
          + Add Object
        </button>
      </div>

      <h5 style="--ch: 13ch;">Object Detail</h5>

      {#if selectedType}
        <div class="type-header">
          <h1>{#if selectedType.module !== "default"}<span>{selectedType.module}::</span>{/if}{selectedType.name}</h1>

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

        {#if loadError}
          <div class="error-banner">{loadError}</div>
        {/if}

        {#if inserting}
          <div class="insert-wrap">
            <form class="data editing" onsubmit={submitInsert}>
              {#if insertError}
                <div class="error-banner">{insertError}</div>
              {/if}

              <header class="data-header">New {selectedType.name}</header>

              {#each writableProps(selectedType) as prop}
                <div class="data-bit">
                  <label
                    class="parameter"
                    class:required={prop.required}
                    for={`insert-${prop.name}`}
                    style={`--ch: ${prop.name.length}ch`}>{prop.name}</label>

                  <input
                    autocorrect="off"
                    id={`insert-${prop.name}`}
                    placeholder={prop.hasDefault ? "(default)" : ""}
                    required={prop.required && !prop.hasDefault}
                    spellcheck="false"
                    type="text"
                    bind:value={insertDraft[prop.name]}/>
                </div>
              {/each}

              {#if selectedType.links.length}
                <div class="data-links">
                  {#each selectedType.links as linkDef (linkDef.name)}
                    <div class="data-link">
                      <label
                        class="parameter"
                        class:required={linkDef.required}
                        for={`insert-${linkDef.name}`}
                        style={`--ch: ${linkDef.name.length}ch`}>{linkDef.name}</label>

                      <!--/
                      {linkDef.name}{linkDef.required ? " *" : ""}
                      <span class="type-tag">→ {linkDef.target}{linkDef.cardinality === "multi" ? "[]" : ""}</span>
                      /-->

                      {#if (insertLinkMode[linkDef.name] ?? "select") === "select"}
                        {#if linkDef.cardinality === "multi"}
                          <select id={`insert-${linkDef.name}`} multiple bind:value={insertLinkDraft[linkDef.name]}>
                            {#each (linkOptions[linkDef.target] ?? []) as opt (opt.id)}
                              <option value={opt.id}>{opt.label}</option>
                            {/each}
                          </select>
                        {:else}
                          <select id={`insert-${linkDef.name}`} bind:value={insertLinkDraft[linkDef.name]}>
                            <option value="">{linkDef.required ? "Select…" : "(none)"}</option>
                            {#each (linkOptions[linkDef.target] ?? []) as opt (opt.id)}
                              <option value={opt.id}>{opt.label}</option>
                            {/each}
                          </select>
                        {/if}
                      {:else}
                        <input
                          autocorrect="off"
                          id={`insert-${linkDef.name}`}
                          placeholder={linkDef.cardinality === "multi" ? "UUIDs (comma-separated)" : "UUID"}
                          spellcheck="false"
                          type="text"
                          bind:value={insertLinkDraft[linkDef.name]}/>
                      {/if}

                      <button
                        class="button button-small button-secondary link-mode-toggle"
                        onclick={() => toggleLinkMode(linkDef)}
                        type="button">
                        {(insertLinkMode[linkDef.name] ?? "select") === "select" ? "Enter UUID" : "Choose from list"}
                      </button>
                    </div>
                  {/each}
                </div>
              {/if}

              <footer class="data-actions">
                <div></div>

                <div class="actions">
                  <button
                    class="button"
                    disabled={insertSubmitting}
                    type="submit">
                    {insertSubmitting ? "Saving…" : "Save"}
                  </button>

                  <button
                    class="button button-secondary"
                    onclick={cancelInsert}
                    type="button">
                    Cancel
                  </button>
                </div>
              </footer>
            </form>
          </div>
        {/if}

        <aside class="type-filters">
          {#each columns as col}
            {@const prop = selectedType.properties.find((p) => p.name === col)}
            {@const isSortable = prop !== undefined}
            <div class="type-filter">
              {#if isSortable}
                <button
                  class:sortable={isSortable}
                  class:active-sort={sortBy?.col === col}
                  disabled={!isSortable}
                  onclick={() => isSortable && toggleSort(col)}
                  title={isSortable ? "Click to sort" : ""}
                  type="button">
                  {col}<span>{sortIndicator(col)}</span>
                </button>
              {/if}

              {#if prop && prop.type === "bool"}
                <select
                  bind:value={filters[col]}
                  onchange={loadRows}>
                  <option value="">—</option>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              {:else if prop}
                <input
                  name={`filter-${prop.name}`}
                  onblur={loadRows}
                  onkeydown={(e) => e.key === "Enter" && loadRows()}
                  placeholder={filterPlaceholder(prop.type)}
                  title={filterTitle(prop.type)}
                  type="text"
                  bind:value={filters[col]}/>
              {/if}
            </div>
          {/each}
        </aside>

        <div class="data-wrap">
          {#if rows.length === 0 && !loading && !loadError}
            <div class="empty-row">{Object.values(filters).some((v) => v) ? "No matches" : "No data"}</div>
          {/if}

          {#each rows as row}
            {#if editingId === row.id}
              <div class="data editing">
                {#if editError}
                  <div class="error-banner">{editError}</div>
                {/if}

                {#each columns as col}
                  {#if col === "id"}
                    <header class="data-header">
                      {formatCell(row[col])}
                    </header>
                  {:else if !isDataLink(row[col])}
                    <div class="data-bit">
                      <label class="parameter" for={`update-${col}`} style={`--ch: ${col.length}ch`}>{col}</label>

                      {#if writableProps(selectedType).find((p) => p.name === col)}
                        <input
                          autocorrect="off"
                          id={`update-${col}`}
                          readonly={isPropReadOnly(col)}
                          spellcheck="false"
                          type="text"
                          bind:value={editDraft[col]}/>
                      {:else}
                        {formatCell(row[col])}
                      {/if}
                    </div>
                  {/if}
                {/each}

                <footer class="data-actions">
                  <div class="links">
                    {#each columns as col}
                      {#if isDataLink(row[col])}
                        <div class="link">
                          <span>{col}</span>
                          {getDataLink(row[col])}
                        </div>
                      {/if}
                    {/each}
                  </div>

                  <div class="actions">
                    <button
                      class="button button-small"
                      disabled={editSubmitting}
                      onclick={submitEdit}>
                      {editSubmitting ? "…" : "Save"}
                    </button>

                    <button
                      class="button button-small button-secondary"
                      onclick={cancelEdit}>
                      Cancel
                    </button>
                  </div>
                </footer>
              </div>
            {:else}
              <div class="data">
                {#each columns as col}
                  {#if col === "id"}
                    <header class="data-header">
                      {formatCell(row[col])}
                    </header>
                  {:else if !isDataLink(row[col])}
                    <div class="data-bit">
                      <span class="parameter" style={`--ch: ${col.length}ch`}>{col}</span>

                      {#if formatCell(row[col]).length}
                        <input
                          autocomplete="off"
                          name={`${col}`}
                          readonly
                          type="text"
                          value={formatCell(row[col])}/>
                      {:else}
                        <span class="null">null</span>
                      {/if}
                    </div>
                  {/if}
                {/each}

                <footer class="data-actions">
                  <div class="links">
                    {#each columns as col}
                      {#if isDataLink(row[col])}
                        <div class="link">
                          <span>{col}</span>
                          {getDataLink(row[col])}
                        </div>
                      {/if}
                    {/each}
                  </div>

                  <div class="actions">
                    <button
                      class="button button-small"
                      disabled={editingId !== null}
                      onclick={() => startEdit(row)}>
                      Edit
                    </button>

                    <button
                      class="button button-small button-danger"
                      disabled={editingId !== null}
                      onclick={() => deleteRow(row)}>
                      Delete
                    </button>
                  </div>
                </footer>
              </div>
            {/if}
          {/each}
        </div>
      {:else}
        <div class="empty">Select a type to view its data.</div>
      {/if}
    </section>
  </div>
</div>
