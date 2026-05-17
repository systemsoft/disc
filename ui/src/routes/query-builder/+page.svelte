/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

<script lang="ts">
  import { onMount } from 'svelte';
  import { discAPI, type SchemaTypeDescription, type SchemaPropertyDescription, type SchemaLinkDescription } from '$lib/api/client';
  import {
    synthesize,
    type FilterCast,
    type FilterOp,
    type FilterSpec,
    type QuerySpec,
  } from '$lib/query-builder-synth';

  // Disc-original feature #3b — visual query builder.
  //
  // Form-based, not canvas drag-and-drop: the user picks a root type,
  // checks fields and links to include in the result shape, adds filter
  // rows, sets order/limit/offset. The synthesized EdgeQL renders live;
  // hitting Run sends it through the same /query endpoint as the text
  // editor. Result rendering reuses the same shapeResult pattern from
  // /ui/query so columns/JSON fall out naturally.

  type DisplayResult =
    | { kind: 'table'; columns: string[]; rows: any[][]; executionTime: number }
    | { kind: 'json'; text: string; executionTime: number };

  let types: SchemaTypeDescription[] = [];
  let typeIndex: Record<string, SchemaTypeDescription> = {};
  let loadingSchema = true;

  let selectedType = '';

  // Picked field state — keyed by field name.
  let pickedFields: Record<string, boolean> = {};
  // Picked link state — name -> { picked: bool, fields: Record<name, bool> }
  let pickedLinks: Record<string, { picked: boolean; fields: Record<string, boolean> }> = {};

  let filterRows: Array<{ field: string; op: FilterOp; value: string; cast: FilterCast }> = [];
  let orderField = '';
  let orderDir: 'asc' | 'desc' = 'asc';
  let limit = '';
  let offset = '';

  let synthesized: { query: string; variables: Record<string, unknown> } = { query: '', variables: {} };
  let synthError = '';

  let queryResult: DisplayResult | null = null;
  let runError = '';
  let isRunning = false;

  const FILTER_OPS: FilterOp[] = ['=', '!=', '<', '<=', '>', '>='];

  // Map an SDL scalar type name to a FilterCast. Anything unrecognized
  // falls back to `str` so the UI stays usable on custom scalars (the
  // server will reject if the cast is wrong, surfaced via runError).
  function castForType(type: string): FilterCast {
    const t = type.toLowerCase();
    if (t === 'str' || t === 'string') return 'str';
    if (t === 'uuid') return 'uuid';
    if (t === 'datetime') return 'datetime';
    if (t === 'bool') return 'bool';
    if (t === 'int16') return 'int16';
    if (t === 'int32') return 'int32';
    if (t === 'int64') return 'int64';
    if (t === 'float32') return 'float32';
    if (t === 'float64') return 'float64';
    return 'str';
  }

  onMount(async () => {
    const schema = await discAPI.getSchema();
    types = schema.types.filter((t) => !t.abstract);
    typeIndex = Object.fromEntries(types.map((t) => [t.name, t]));
    if (types.length > 0) selectedType = types[0].name;
    loadingSchema = false;
  });

  $: currentType = typeIndex[selectedType];
  $: properties = currentType?.properties ?? [];
  $: links = currentType?.links ?? [];

  // Reset picked fields when the user switches the root type.
  let lastSelectedType = '';
  $: if (selectedType !== lastSelectedType) {
    lastSelectedType = selectedType;
    pickedFields = {};
    pickedLinks = {};
    filterRows = [];
    orderField = '';
    queryResult = null;
    runError = '';
  }

  // Re-synthesize whenever the spec changes.
  $: {
    try {
      const fields = Object.entries(pickedFields).filter(([, v]) => v).map(([k]) => k);
      const linkEntries: Record<string, { fields: string[] }> = {};
      for (const [linkName, st] of Object.entries(pickedLinks)) {
        if (!st.picked) continue;
        const inner = Object.entries(st.fields).filter(([, v]) => v).map(([k]) => k);
        // Skip empty-shape links — `posts: {}` is invalid EdgeQL.
        if (inner.length === 0) continue;
        linkEntries[linkName] = { fields: inner };
      }

      const filters: FilterSpec[] = filterRows
        .filter((r) => r.field && r.value !== '')
        .map((r) => ({ field: r.field, op: r.op, value: r.value, cast: r.cast }));

      const spec: QuerySpec = {
        type: selectedType || 'X',
        shape: { fields, links: linkEntries },
        filters,
      };
      if (orderField) spec.order = { field: orderField, direction: orderDir };
      if (limit !== '') spec.limit = Number.parseInt(limit, 10);
      if (offset !== '') spec.offset = Number.parseInt(offset, 10);

      if (!selectedType) {
        synthesized = { query: '', variables: {} };
        synthError = '';
      } else {
        synthesized = synthesize(spec);
        synthError = '';
      }
    } catch (err) {
      synthesized = { query: '', variables: {} };
      synthError = err instanceof Error ? err.message : 'synthesis error';
    }
  }

  function toggleLink(linkName: string) {
    const existing = pickedLinks[linkName];
    if (existing) {
      pickedLinks = { ...pickedLinks, [linkName]: { ...existing, picked: !existing.picked } };
    } else {
      pickedLinks = { ...pickedLinks, [linkName]: { picked: true, fields: {} } };
    }
  }

  function toggleLinkField(linkName: string, fieldName: string) {
    const existing = pickedLinks[linkName] ?? { picked: true, fields: {} };
    const newFields = { ...existing.fields, [fieldName]: !existing.fields[fieldName] };
    pickedLinks = { ...pickedLinks, [linkName]: { ...existing, picked: true, fields: newFields } };
  }

  function addFilterRow() {
    const firstScalar = properties[0];
    filterRows = [
      ...filterRows,
      {
        field: firstScalar?.name ?? '',
        op: '=',
        value: '',
        cast: firstScalar ? castForType(firstScalar.type) : 'str',
      },
    ];
  }

  function removeFilterRow(idx: number) {
    filterRows = filterRows.filter((_, i) => i !== idx);
  }

  function onFilterFieldChange(idx: number, fieldName: string) {
    const prop = properties.find((p) => p.name === fieldName);
    filterRows = filterRows.map((r, i) =>
      i === idx ? { ...r, field: fieldName, cast: prop ? castForType(prop.type) : 'str' } : r
    );
  }

  function handleFilterFieldChange(idx: number, ev: Event) {
    const target = ev.currentTarget as HTMLSelectElement;
    onFilterFieldChange(idx, target.value);
  }

  function shapeResult(data: any, executionTime: number): DisplayResult {
    if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'object' && data[0] !== null) {
      const columns = Array.from(
        data.reduce((set: Set<string>, row: any) => {
          for (const k of Object.keys(row)) set.add(k);
          return set;
        }, new Set<string>()),
      );
      const rows = data.map((row: any) =>
        columns.map((c) => {
          const v = row[c];
          if (v === null || v === undefined) return '';
          if (typeof v === 'object') return JSON.stringify(v);
          return v;
        }),
      );
      return { kind: 'table', columns, rows, executionTime };
    }
    return { kind: 'json', text: JSON.stringify(data, null, 2), executionTime };
  }

  async function runQuery() {
    if (!synthesized.query || synthError) return;
    isRunning = true;
    runError = '';
    const result = await discAPI.executeQuery(synthesized.query, synthesized.variables);
    isRunning = false;
    if (result.error) {
      runError = result.error;
      queryResult = null;
      return;
    }
    queryResult = shapeResult(result.data, Math.round(result.durationMs));
  }

  function copyEdgeQL() {
    if (synthesized.query) navigator.clipboard?.writeText(synthesized.query);
  }
</script>

<div class="query-builder">
  <header class="page-header">
    <h1>Visual Query Builder</h1>
    <p class="subtitle">Pick fields, add filters, learn EdgeQL by reading the synthesized query.</p>
  </header>

  {#if loadingSchema}
    <p class="loading">Loading schema…</p>
  {:else if types.length === 0}
    <p class="empty">No types found in the current schema.</p>
  {:else}
    <div class="builder-grid">
      <section class="card builder-form">
        <div class="row">
          <label>Root type
            <select bind:value={selectedType}>
              {#each types as t}
                <option value={t.name}>{t.name}</option>
              {/each}
            </select>
          </label>
        </div>

        <fieldset>
          <legend>Fields</legend>
          {#if properties.length === 0}
            <p class="muted">This type has no scalar properties.</p>
          {:else}
            <div class="checks">
              {#each properties as prop (prop.name)}
                <label class="check">
                  <input type="checkbox" bind:checked={pickedFields[prop.name]} />
                  <span class="field-name">{prop.name}</span>
                  <span class="field-type">{prop.type}</span>
                </label>
              {/each}
            </div>
          {/if}
        </fieldset>

        {#if links.length > 0}
          <fieldset>
            <legend>Links</legend>
            {#each links as link (link.name)}
              <div class="link-block">
                <label class="check">
                  <input
                    type="checkbox"
                    checked={pickedLinks[link.name]?.picked ?? false}
                    on:change={() => toggleLink(link.name)}
                  />
                  <span class="field-name">{link.name}</span>
                  <span class="field-type">{link.cardinality === 'multi' ? 'multi' : ''} {link.target}</span>
                </label>
                {#if pickedLinks[link.name]?.picked}
                  <div class="link-fields">
                    {#each (typeIndex[link.target]?.properties ?? []) as subProp (subProp.name)}
                      <label class="check">
                        <input
                          type="checkbox"
                          checked={pickedLinks[link.name]?.fields[subProp.name] ?? false}
                          on:change={() => toggleLinkField(link.name, subProp.name)}
                        />
                        <span class="field-name">{subProp.name}</span>
                        <span class="field-type">{subProp.type}</span>
                      </label>
                    {/each}
                  </div>
                {/if}
              </div>
            {/each}
          </fieldset>
        {/if}

        <fieldset>
          <legend>Filters</legend>
          {#each filterRows as row, idx}
            <div class="filter-row">
              <select
                value={row.field}
                on:change={(e) => handleFilterFieldChange(idx, e)}
              >
                {#each properties as prop}
                  <option value={prop.name}>{prop.name}</option>
                {/each}
              </select>
              <select bind:value={row.op}>
                {#each FILTER_OPS as op}
                  <option value={op}>{op}</option>
                {/each}
              </select>
              <input type="text" placeholder="value" bind:value={row.value} />
              <span class="cast-hint">&lt;{row.cast}&gt;</span>
              <button type="button" class="button danger small" on:click={() => removeFilterRow(idx)}>×</button>
            </div>
          {/each}
          <button type="button" class="button small" on:click={addFilterRow} disabled={properties.length === 0}>
            + Add filter
          </button>
        </fieldset>

        <fieldset class="row-fieldset">
          <legend>Order / Limit / Offset</legend>
          <div class="row">
            <label>Order by
              <select bind:value={orderField}>
                <option value="">—</option>
                {#each properties as prop}
                  <option value={prop.name}>{prop.name}</option>
                {/each}
              </select>
            </label>
            <label>Direction
              <select bind:value={orderDir} disabled={!orderField}>
                <option value="asc">asc</option>
                <option value="desc">desc</option>
              </select>
            </label>
            <label>Limit
              <input type="number" min="0" placeholder="—" bind:value={limit} />
            </label>
            <label>Offset
              <input type="number" min="0" placeholder="—" bind:value={offset} />
            </label>
          </div>
        </fieldset>
      </section>

      <section class="card edgeql-pane">
        <div class="pane-header">
          <h2>Synthesized EdgeQL</h2>
          <div class="pane-actions">
            <button class="button small" on:click={copyEdgeQL} disabled={!synthesized.query}>Copy</button>
            <button class="button primary" on:click={runQuery} disabled={isRunning || !synthesized.query || !!synthError}>
              {isRunning ? 'Running…' : 'Run'}
            </button>
          </div>
        </div>
        {#if synthError}
          <pre class="synth-error">{synthError}</pre>
        {:else}
          <pre class="edgeql">{synthesized.query || '(pick at least a root type)'}</pre>
          {#if Object.keys(synthesized.variables).length > 0}
            <details class="variables">
              <summary>Variables</summary>
              <pre>{JSON.stringify(synthesized.variables, null, 2)}</pre>
            </details>
          {/if}
        {/if}

        {#if runError}
          <div class="run-error">
            <strong>Error:</strong> {runError}
          </div>
        {/if}

        {#if queryResult}
          <div class="result-pane">
            <p class="muted">{queryResult.executionTime}ms</p>
            {#if queryResult.kind === 'table'}
              <div class="table-wrap">
                <table>
                  <thead>
                    <tr>{#each queryResult.columns as col}<th>{col}</th>{/each}</tr>
                  </thead>
                  <tbody>
                    {#each queryResult.rows as row}
                      <tr>{#each row as cell}<td>{cell}</td>{/each}</tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            {:else}
              <pre class="json-result">{queryResult.text}</pre>
            {/if}
          </div>
        {/if}
      </section>
    </div>
  {/if}
</div>

<style lang="scss">
  @use "../../styles/mixins" as *;

  .query-builder {
    padding: calc(var(--grid-unit) * 3);
    height: 100%;
    overflow: auto;
  }

  .page-header h1 {
    margin: 0 0 calc(var(--grid-unit) * 0.5);
    @include neon-text();
  }
  .subtitle {
    margin: 0 0 calc(var(--grid-unit) * 3);
    color: var(--color-text-dim);
  }

  .builder-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: calc(var(--grid-unit) * 3);
  }

  .card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    padding: calc(var(--grid-unit) * 2);
  }

  .row {
    display: flex;
    gap: calc(var(--grid-unit) * 2);
    align-items: flex-end;
    flex-wrap: wrap;
    label {
      display: flex;
      flex-direction: column;
      gap: calc(var(--grid-unit) * 0.5);
      font-size: 0.85rem;
      color: var(--color-text-dim);
    }
  }

  fieldset {
    border: 1px solid var(--color-border);
    border-radius: 3px;
    padding: calc(var(--grid-unit) * 1.5);
    margin: calc(var(--grid-unit) * 2) 0 0;
    legend {
      padding: 0 calc(var(--grid-unit) * 1);
      font-size: 0.85rem;
      color: var(--color-text-dim);
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }
  }

  .checks {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: calc(var(--grid-unit) * 1);
  }

  .check {
    display: flex;
    align-items: center;
    gap: calc(var(--grid-unit) * 1);
    cursor: pointer;
    .field-name {
      font-family: var(--font-mono);
    }
    .field-type {
      color: var(--color-text-dim);
      font-size: 0.8rem;
      margin-left: auto;
    }
  }

  .link-block {
    border-left: 2px solid rgb(var(--color-primary-rgb) / 0.3);
    padding-left: calc(var(--grid-unit) * 2);
    margin-bottom: calc(var(--grid-unit) * 1.5);
    .link-fields {
      margin-top: calc(var(--grid-unit) * 1);
      padding-left: calc(var(--grid-unit) * 2);
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: calc(var(--grid-unit) * 0.5);
    }
  }

  .filter-row {
    display: flex;
    gap: calc(var(--grid-unit) * 1);
    align-items: center;
    margin-bottom: calc(var(--grid-unit) * 1);
    select, input[type="text"] {
      padding: calc(var(--grid-unit) * 0.5) calc(var(--grid-unit) * 1);
    }
    .cast-hint {
      font-family: var(--font-mono);
      color: var(--color-text-dim);
      font-size: 0.85rem;
    }
  }

  .pane-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: calc(var(--grid-unit) * 2);
    h2 {
      margin: 0;
      font-size: 1rem;
      color: var(--color-text-dim);
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }
    .pane-actions {
      display: flex;
      gap: calc(var(--grid-unit) * 1);
    }
  }

  .edgeql {
    font-family: var(--font-mono);
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 3px;
    padding: calc(var(--grid-unit) * 2);
    white-space: pre-wrap;
    word-break: break-word;
    color: rgb(var(--color-primary-rgb));
    @include glow(var(--color-primary-rgb), 0.4);
  }

  .synth-error, .run-error {
    background: rgb(var(--color-danger-rgb) / 0.1);
    border: 1px solid rgb(var(--color-danger-rgb) / 0.4);
    color: rgb(var(--color-danger-rgb));
    padding: calc(var(--grid-unit) * 1.5);
    border-radius: 3px;
    margin-top: calc(var(--grid-unit) * 1);
    font-family: var(--font-mono);
    white-space: pre-wrap;
  }

  .variables {
    margin-top: calc(var(--grid-unit) * 1);
    summary {
      cursor: pointer;
      color: var(--color-text-dim);
      font-size: 0.85rem;
    }
    pre {
      font-family: var(--font-mono);
      background: var(--color-bg);
      padding: calc(var(--grid-unit) * 1.5);
      border-radius: 3px;
      margin-top: calc(var(--grid-unit) * 0.5);
    }
  }

  .result-pane {
    margin-top: calc(var(--grid-unit) * 2);
    border-top: 1px solid var(--color-border);
    padding-top: calc(var(--grid-unit) * 2);
  }

  .table-wrap {
    overflow: auto;
    max-height: 400px;
    table {
      width: 100%;
      border-collapse: collapse;
      font-family: var(--font-mono);
      font-size: 0.85rem;
    }
    th, td {
      padding: calc(var(--grid-unit) * 0.5) calc(var(--grid-unit) * 1);
      border-bottom: 1px solid var(--color-border);
      text-align: left;
    }
    th {
      color: var(--color-text-dim);
      letter-spacing: 0.05em;
      text-transform: uppercase;
      font-size: 0.75rem;
      position: sticky;
      top: 0;
      background: var(--color-surface);
    }
  }

  .json-result {
    font-family: var(--font-mono);
    background: var(--color-bg);
    padding: calc(var(--grid-unit) * 2);
    border-radius: 3px;
    max-height: 400px;
    overflow: auto;
  }

  .muted { color: var(--color-text-dim); font-size: 0.85rem; }
  .loading, .empty { color: var(--color-text-dim); padding: calc(var(--grid-unit) * 4); text-align: center; }

  @media (max-width: 1100px) {
    .builder-grid { grid-template-columns: 1fr; }
  }
</style>
