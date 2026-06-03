<script lang="ts">
  /*** IMPORT ------------------------------------------- ***/

  import { onMount } from "svelte";

  /*** UTILITY ------------------------------------------ ***/

  import {
    discAPI,
    type SchemaLinkDescription,
    type SchemaPropertyDescription,
    type SchemaTypeDescription
  } from "$lib/api/client";

  import {
    synthesize,
    type FilterCast,
    type FilterOp,
    type FilterSpec,
    type QuerySpec
  } from "$lib/query-builder-synth";

  /*** Form-based, not canvas drag-and-drop: the user picks a root type, checks fields and links to
       include in the result shape, adds filter rows, sets order/limit/offset. The synthesized
       EdgeQL renders live; hitting Run sends it through the same /query endpoint as the text
       editor. Result rendering reuses the same shapeResult pattern from /ui/query so columns/JSON
       fall out naturally. ***/

  type DisplayResult =
    | { executionTime: number; kind: "json"; text: string;  }
    | { columns: string[]; executionTime: number; kind: "table"; rows: any[][]; };

  const FILTER_OPS: FilterOp[] = ["=", "!=", "<", "<=", ">", ">="];
  let filterRows: Array<{ cast: FilterCast; field: string; op: FilterOp; value: string; }> = [];
  let isRunning = false;
  let lastSelectedType = "";
  let limit = "";
  let loadingSchema = true;
  let offset = "";
  let orderDir: "asc" | "desc" = "asc";
  let orderField = "";
  let pickedFields: Record<string, boolean> = {};
  let pickedLinks: Record<string, { fields: Record<string, boolean>; picked: boolean; }> = {};
  let queryResult: DisplayResult | null = null;
  let runError = "";
  let selectedType = "";
  let synthError = "";
  let synthesized: { query: string; variables: Record<string, unknown> } = { query: "", variables: {} };
  let typeIndex: Record<string, SchemaTypeDescription> = {};
  let types: SchemaTypeDescription[] = [];

  /*** RUNTIME ------------------------------------------ ***/

  $: currentType = typeIndex[selectedType];
  $: links = currentType?.links ?? [];
  $: properties = currentType?.properties ?? [];

  $: if (selectedType !== lastSelectedType) {
    /*** Reset picked fields when the user switches the root type. ***/
    lastSelectedType = selectedType;
    pickedFields = {};
    pickedLinks = {};
    filterRows = [];
    orderField = "";
    queryResult = null;
    runError = "";
  }

  $: {
    /*** Re-synthesize whenever the spec changes. ***/
    try {
      const fields = Object.entries(pickedFields).filter(([, v]) => v).map(([k]) => k);
      const linkEntries: Record<string, { fields: string[] }> = {};

      for (const [linkName, st] of Object.entries(pickedLinks)) {
        if (!st.picked)
          continue;

        const inner = Object.entries(st.fields).filter(([, v]) => v).map(([k]) => k);

        /*** Skip empty-shape links — `posts: {}` is invalid EdgeQL. ***/
        if (inner.length === 0)
          continue;

        linkEntries[linkName] = { fields: inner };
      }

      const filters: FilterSpec[] = filterRows
        .filter((r) => r.field && r.value !== "")
        .map((r) => ({ cast: r.cast, field: r.field, op: r.op, value: r.value }));

      const spec: QuerySpec = {
        filters,
        shape: { fields, links: linkEntries },
        type: selectedType || "X"
      };

      if (orderField)
        spec.order = { direction: orderDir, field: orderField };

      if (limit !== "")
        spec.limit = Number.parseInt(limit, 10);

      if (offset !== "")
        spec.offset = Number.parseInt(offset, 10);

      if (!selectedType) {
        synthesized = { query: "", variables: {} };
        synthError = "";
      } else {
        synthesized = synthesize(spec);
        synthError = "";
      }
    } catch (err) {
      synthesized = { query: "", variables: {} };
      synthError = err instanceof Error ? err.message : "synthesis error";
    }
  }

  onMount(async () => {
    const schema = await discAPI.getSchema();
    types = schema.types.filter((t) => !t.abstract);
    typeIndex = Object.fromEntries(types.map((t) => [t.name, t]));

    if (types.length > 0)
      selectedType = types[0].name;

    loadingSchema = false;
  });

  /*** HELPER ------------------------------------------- ***/

  function addFilterRow() {
    const firstScalar = properties[0];

    filterRows = [
      ...filterRows,
      {
        cast: firstScalar ? castForType(firstScalar.type) : "str",
        field: firstScalar?.name ?? "",
        op: "=",
        value: ""
      }
    ];
  }

  /*** Map an SDL scalar type name to a FilterCast. Anything unrecognized falls back to `str` so the
       UI stays usable on custom scalars (the server will reject if the cast is wrong, surfaced
       via runError). ***/
  function castForType(type: string): FilterCast {
    const t = type.toLowerCase();

    if (t === "str" || t === "string")
      return "str";

    if (t === "uuid")
      return "uuid";

    if (t === "datetime")
      return "datetime";

    if (t === "bool")
      return "bool";

    if (t === "int16")
      return "int16";

    if (t === "int32")
      return "int32";

    if (t === "int64")
      return "int64";

    if (t === "float32")
      return "float32";

    if (t === "float64")
      return "float64";

    return "str";
  }

  function clearResults() {
    pickedFields = {};
    pickedLinks = {};
    filterRows = [];
    orderField = "";
    queryResult = null;
    runError = "";
  }

  function copyEdgeQL() {
    if (synthesized.query)
      navigator.clipboard?.writeText(synthesized.query);
  }

  function formatCell(value: any): string {
    if (value === null || value === undefined)
      return "";

    if (typeof value === "object")
      return JSON.stringify(value);

    return String(value);
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

  function handleFilterFieldChange(idx: number, ev: Event) {
    const target = ev.currentTarget as HTMLSelectElement;
    onFilterFieldChange(idx, target.value);
  }

  function onFilterFieldChange(idx: number, fieldName: string) {
    const prop = properties.find((p) => p.name === fieldName);
    filterRows = filterRows.map((r, i) => i === idx ? { ...r, cast: prop ? castForType(prop.type) : "str", field: fieldName } : r);
  }

  function removeFilterRow(idx: number) {
    filterRows = filterRows.filter((_, i) => i !== idx);
  }

  async function runQuery() {
    if (!synthesized.query || synthError)
      return;

    isRunning = true;
    runError = "";

    const result = await discAPI.executeQuery(synthesized.query, synthesized.variables);
    isRunning = false;

    if (result.error) {
      runError = result.error;
      queryResult = null;

      return;
    }

    queryResult = shapeResult(result.data, Math.round(result.durationMs));
  }

  function shapeResult(data: any, executionTime: number): DisplayResult {
    if (Array.isArray(data) && data.length > 0 && typeof data[0] === "object" && data[0] !== null) {
      const columns = Array.from(
        data.reduce((set: Set<string>, row: any) => {
          for (const k of Object.keys(row)) {
            set.add(k);
          }

          return set;
        }, new Set<string>()),
      );

      const rows = data.map((row: any) =>
        columns.map((c) => {
          const v = row[c];

          if (v === null || v === undefined)
            return "";

          if (typeof v === "object")
            return JSON.stringify(v);

          return v;
        }),
      );

      return {
        columns,
        executionTime,
        kind: "table",
        rows
      };
    }

    return {
      executionTime, kind: "json",
      text: JSON.stringify(data, null, 2)
    };
  }

  function toggleLink(linkName: string) {
    const existing = pickedLinks[linkName];

    if (existing)
      pickedLinks = { ...pickedLinks, [linkName]: { ...existing, picked: !existing.picked } };
    else
      pickedLinks = { ...pickedLinks, [linkName]: { fields: {}, picked: true } };
  }

  function toggleLinkField(linkName: string, fieldName: string) {
    const existing = pickedLinks[linkName] ?? { fields: {}, picked: true };
    const newFields = { ...existing.fields, [fieldName]: !existing.fields[fieldName] };

    pickedLinks = { ...pickedLinks, [linkName]: { ...existing, fields: newFields, picked: true } };
  }
</script>

<style lang="scss">
  @use "../../styles/mixins" as *;

  /* @include neon-text(); */
  /* @include glow(var(--color-primary-rgb), 0.4); */

  .checks {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: calc(var(--grid-unit) * 1);
  }

  .link-block {
    margin-bottom: calc(var(--grid-unit) * 1.5);

    .link-fields {
      display: grid;
      gap: calc(var(--grid-unit) * 0.5);
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      padding-left: calc(var(--grid-unit) * 2);

      &:not(:empty) {
        margin-top: var(--grid-unit);
      }
    }
  }

  .filter-row {
    align-items: baseline;
    background-color: oklch(var(--uchu-gray-1-raw) / 30%);
    border: 1px solid var(--uchu-gray-1);
    display: flex;
    flex-direction: column;
    gap: calc(var(--grid-unit) * 1);
    margin-top: var(--grid-unit);
    padding: calc(var(--grid-unit) * 2);

    span {
      display: flex;
      gap: var(--grid-unit);
      width: 100%;

      &:first-of-type {
        select:nth-child(1) {
          flex: 1;
        }

        select:nth-child(2) {
          text-align: center;
        }
      }

      &:last-of-type {
        flex-direction: column;
      }
    }

    .cast-hint {
      color: var(--uchu-yin-3);
      font-family: var(--font-mono);
      font-size: 0.75rem;
      letter-spacing: 0.025rem;
      padding-left: 1ch;
      position: relative;
      top: -1ch;
    }
  }

  .edgeql {
    background-color: oklch(var(--uchu-gray-1-raw) / 50%);
    font-family: var(--font-mono);
    margin-bottom: var(--grid-unit);
    padding: calc(var(--grid-unit) * 2);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .synth-error, .run-error {
    background-color: oklch(var(--uchu-red-1-raw) / 20%);
    color: var(--uchu-red-5);
    font-family: var(--font-mono);
    font-size: 0.875rem;
    margin-top: calc(var(--grid-unit) * 1);
    padding: calc(var(--grid-unit) * 2);
    white-space: pre-wrap;
  }

  .variables {
    margin-top: calc(var(--grid-unit) * 1);

    summary {
      color: var(--uchu-yin-3);
      cursor: pointer;
      font-size: 0.875rem;
    }

    pre {
      margin-top: calc(var(--grid-unit) * 0.5);
      padding: calc(var(--grid-unit) * 1.5);
    }
  }

  .results-json {
    background-color: oklch(var(--uchu-gray-1-raw) / 20%);
    max-height: 400px;
    overflow: auto;
    padding: calc(var(--grid-unit) * 2);
  }

  .loading, .empty {
    color: var(--uchu-yin-3);
    padding: calc(var(--grid-unit) * 4);
    text-align: center;
  }

  .dash-wrapper {
    display: flex;
    gap: calc(var(--grid-unit) * 3);

    .empty,
    .loading {
      font-family: var(--font-mono);
      font-size: 0.75rem;
      padding: 0;
    }

    .controls {
      align-items: center;
      display: flex;
      gap: var(--grid-unit);
      font-family: var(--font-mono);
      font-size: 0.75rem;
      text-transform: uppercase;

      button {
        font-size: inherit;
        text-transform: inherit;
      }
    }

    input[type="number"],
    input[type="text"],
    select {
      border-color: var(--uchu-gray-1);
    }

    input[type="checkbox"] {
      border-color: var(--uchu-gray-3);
    }
  }

  .dash-sidebar {
    width: 300px; height: 80vh;

    border-bottom: 1px solid var(--uchu-gray-1);
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    padding-bottom: calc(var(--grid-unit) * 3);

    h5:not(:first-of-type) {
      margin-top: calc(var(--grid-unit) * 3);
    }

    button {
      font-family: var(--font-mono);
      font-size: 0.75rem;
      text-transform: uppercase;
    }

    .check {
      align-items: center;
      cursor: pointer;
      display: flex;
      font-family: var(--font-mono);
      font-size: 0.875rem;
      gap: calc(var(--grid-unit) * 2);

      .field-name {
        font-weight: 500;
      }

      .field-type {
        color: var(--uchu-yin-3);
        font-size: 0.75rem;
        letter-spacing: 0.025rem;
        margin-left: auto;
      }
    }

    .fields {
      display: flex;
      flex-direction: column;
      line-height: 1.33;
    }
  }

  .dash-detail {
    flex: 1;

    h5:not(:first-of-type) {
      margin-top: calc(var(--grid-unit) * 3);
    }
  }

  .data-wrap {
    display: grid;
    gap: calc(var(--grid-unit) * 2);
    grid-template-columns: repeat(2, 1fr);
    margin-top: var(--grid-unit);
  }

  .data {
    border: 1px solid var(--uchu-gray-1);
    font-family: var(--font-mono);
    font-size: 0.875rem;
    transition: box-shadow 0.2s;

    .data-header {
      background-color: oklch(var(--uchu-gray-1-raw) / 50%);
      border-bottom: 1px solid var(--uchu-gray-1);
      flex-direction: row;
      font-weight: 500;
      padding: var(--grid-unit) calc(var(--grid-unit) * 2);
    }

    input {
      border: none;
      border-bottom: 1px solid transparent;
      padding: 0;
      width: 100%;

      &[readonly] {
        cursor: default;
      }
    }

    .data-bit {
      align-items: center;
      display: flex;
      flex-direction: row;
      padding-left: calc(var(--grid-unit) * 2);
      padding-right: calc(var(--grid-unit) * 2);

      &:first-of-type {
        padding-top: var(--grid-unit);
      }

      &:last-of-type {
        padding-bottom: var(--grid-unit);
      }

      .null {
        color: var(--uchu-gray-3);
      }

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
      }
    }
  }
</style>

<svelte:head>
  <title>Disc Viewer &bull; Query Builder</title>
</svelte:head>

<div class="dash-wrapper">
  <aside class="dash-sidebar">
    <h5 style="--ch: 9ch;">Root type</h5>

    {#if loadingSchema}
      <p class="loading">Loading schema…</p>
    {:else if types.length === 0}
      <p class="empty">No types found in the current schema.</p>
    {:else}
      <select bind:value={selectedType}>
        {#each types as t}
          <option value={t.name}>{t.name}</option>
        {/each}
      </select>
    {/if}

    <h5 style="--ch: 6ch;">Fields</h5>

    {#if loadingSchema}
      <p class="loading">Loading fields…</p>
    {:else if properties.length === 0}
      <p class="empty">This type has no scalar properties.</p>
    {:else}
      <div class="checks">
        {#each properties as prop (prop.name)}
          <label class="check">
            <input type="checkbox" bind:checked={pickedFields[prop.name]}/>
            <span class="field-name">{prop.name}</span>
            <span class="field-type">{prop.type}</span>
          </label>
        {/each}
      </div>
    {/if}

    {#if links.length > 0}
      <h5 style="--ch: 5ch;">Links</h5>

      {#each links as link (link.name)}
        <div class="link-block">
          <label class="check">
            <input
              checked={pickedLinks[link.name]?.picked ?? false}
              onchange={() => toggleLink(link.name)}
              type="checkbox"/>

            <div class="fields">
              <span class="field-name">{link.name}</span>
              <span class="field-type">{link.cardinality === "multi" ? "multi" : ""} {link.target}</span>
            </div>
          </label>
          {#if pickedLinks[link.name]?.picked}
            <div class="link-fields">
              {#each (typeIndex[link.target]?.properties ?? []) as subProp (subProp.name)}
                <label class="check">
                  <input
                    checked={pickedLinks[link.name]?.fields[subProp.name] ?? false}
                    onchange={() => toggleLinkField(link.name, subProp.name)}
                    type="checkbox"/>

                  <div class="fields">
                    <span class="field-name">{subProp.name}</span>
                    <span class="field-type">{subProp.type}</span>
                  </div>
                </label>
              {/each}
            </div>
          {/if}
        </div>
      {/each}
    {/if}

    <h5 style="--ch: 7ch;">Filters</h5>

    <button
      class="button small"
      disabled={properties.length === 0}
      onclick={addFilterRow}
      type="button">
      + Add filter
    </button>

    {#each filterRows as row, idx}
      <div class="filter-row">
        <span>
          <select
            onchange={(e) => handleFilterFieldChange(idx, e)}
            value={row.field}>
            {#each properties as prop}
              <option value={prop.name}>{prop.name}</option>
            {/each}
          </select>

          <select bind:value={row.op} class="blank">
            {#each FILTER_OPS as op}
              <option value={op}>{op}</option>
            {/each}
          </select>
        </span>

        <span>
          <input type="text" placeholder="value" bind:value={row.value}/>
          <span class="cast-hint">&lt;{row.cast}&gt;</span>
        </span>

        <button
          class="button danger small"
          onclick={() => removeFilterRow(idx)}
          type="button">
          Remove filter
        </button>
      </div>
    {/each}

    <h5 style="--ch: 5ch;">Order</h5>

    <select bind:value={orderField}>
      <option value="">—</option>
      {#each properties as prop}
        <option value={prop.name}>{prop.name}</option>
      {/each}
    </select>

    <h5 style="--ch: 9ch;">Direction</h5>

    <select bind:value={orderDir} disabled={!orderField}>
      <option value="asc">asc</option>
      <option value="desc">desc</option>
    </select>

    <h5 style="--ch: 5ch;">Limit</h5>
    <input type="number" min="0" placeholder="—" bind:value={limit}/>

    <h5 style="--ch: 6ch;">Offset</h5>
    <input type="number" min="0" placeholder="—" bind:value={offset}/>
  </aside>

  <section class="dash-detail">
    <h5 style="--ch: 19ch;">Synthesized EdgeQL</h5>

    {#if synthError}
      <pre class="synth-error">{synthError}</pre>
    {:else}
      <pre class="edgeql">{synthesized.query || "(pick at least a root type)"}</pre>

      {#if Object.keys(synthesized.variables).length > 0}
        <details class="variables">
          <summary>Variables</summary>
          <pre>{JSON.stringify(synthesized.variables, null, 2)}</pre>
        </details>
      {/if}
    {/if}

    <div class="controls">
      <button class="button small" onclick={copyEdgeQL} disabled={!synthesized.query}>Copy</button>
      <button class="button primary" onclick={runQuery} disabled={isRunning || !synthesized.query || !!synthError}>
        {isRunning ? "Running…" : "Run"}
      </button>
    </div>

    {#if runError}
      <h5 style="--ch: 14ch;">Builder Result</h5>

      <div class="run-error">
        <strong>Error:</strong> {runError}
      </div>
    {:else if queryResult}
      <h5 style="--ch: 14ch;">Builder Result</h5>

      <div class="controls">
        <button class="button" onclick={clearResults}>Clear</button>
        <span class="execution-time">Executed in {queryResult.executionTime}ms</span>
      </div>

      <div class="data-wrap">
        {#if queryResult.kind === "table"}
          {#each queryResult.rows as row}
            <div class="data">
              {#each queryResult.columns as col, i}
                {#if col === "id"}
                  <header class="data-header">
                    {formatCell(row[i])}
                  </header>
                {:else if !isDataLink(row[i])}
                  <div class="data-bit">
                    <span class="parameter" style={`--ch: ${col.length}ch`}>{col}</span>

                    {#if formatCell(row[i]).length}
                      <input
                        autocomplete="off"
                        name={`${col}`}
                        readonly
                        type="text"
                        value={formatCell(row[i])}/>
                    {:else}
                      <span class="null">null</span>
                    {/if}
                  </div>
                {/if}
              {/each}
            </div>
          {/each}
        {:else}
          <pre class="results-json">{queryResult.text}</pre>
        {/if}
      </div>
    {/if}
  </section>
</div>
