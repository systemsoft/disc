<script lang="ts">
  import { onMount } from 'svelte';
  import {
    discAPI,
    type SchemaTypeDescription,
    type SchemaPropertyDescription,
  } from '$lib/api/client';

  // Read-write data viewer. The Disc HTTP server only exposes /query, so
  // mutations are issued as EdgeQL insert/update/delete strings rather than
  // dedicated REST endpoints. The cast-aware EdgeQL protocol generator
  // handles `<uuid>'...'` literals correctly so identity-keyed updates
  // round-trip through `select default::Type filter .id = <uuid>'X'`.
  let types: SchemaTypeDescription[] = [];
  let selectedType: SchemaTypeDescription | null = null;
  let rows: any[] = [];
  let columns: string[] = [];
  let limit = 50;
  let loading = false;
  let loadError: string | null = null;

  // Insert state
  let inserting = false;
  let insertDraft: Record<string, string> = {};
  let insertError: string | null = null;
  let insertSubmitting = false;

  // Edit state — tracks the row currently being edited and a draft of changes.
  let editingId: string | null = null;
  let editDraft: Record<string, string> = {};
  let editError: string | null = null;
  let editSubmitting = false;

  onMount(async () => {
    try {
      const description = await discAPI.getSchema();
      types = description.types
        .filter((t) => !t.abstract)
        .sort((a, b) => a.name.localeCompare(b.name));
      if (types.length > 0) {
        await selectType(types[0]);
      }
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
    }
  });

  async function selectType(type: SchemaTypeDescription) {
    selectedType = type;
    cancelInsert();
    cancelEdit();
    await loadRows();
  }

  /** Properties that should appear as columns and be writable (excludes computed). */
  function writableProps(type: SchemaTypeDescription): SchemaPropertyDescription[] {
    return type.properties.filter((p) => !p.computed && p.name !== 'id');
  }

  function buildSelect(type: SchemaTypeDescription): { query: string; cols: string[] } {
    // Schema introspection includes `id` in properties[], so don't prepend
    // it again — duplicate fields make the compiler emit invalid SQL.
    const propNames = type.properties.map((p) => p.name);
    const linkNames = type.links
      .filter((l) => l.cardinality === 'single')
      .map((l) => l.name);
    const orderedProps = propNames.includes('id')
      ? ['id', ...propNames.filter((n) => n !== 'id')]
      : ['id', ...propNames];
    const fields = [...orderedProps, ...linkNames.map((n) => `${n}: { id }`)];
    const query = `select ${type.module}::${type.name} { ${fields.join(', ')} } limit ${limit};`;
    return { query, cols: [...orderedProps, ...linkNames] };
  }

  async function loadRows() {
    if (!selectedType) return;
    loading = true;
    loadError = null;
    rows = [];

    const { query, cols } = buildSelect(selectedType);
    columns = cols;

    const result = await discAPI.executeQuery(query);
    loading = false;

    if (result.error) {
      loadError = result.error;
      return;
    }
    rows = Array.isArray(result.data) ? result.data : [];
  }

  function formatCell(value: any): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }

  /** Render a value for an EdgeQL `set { x := <value> }` clause based on prop type. */
  function literalFor(prop: SchemaPropertyDescription, raw: string): string {
    const v = raw.trim();
    if (v === '' && !prop.required) return '{}'; // EdgeQL empty set
    if (v === '' && prop.required) {
      throw new Error(`'${prop.name}' is required`);
    }
    switch (prop.type) {
      case 'int16':
      case 'int32':
      case 'int64':
      case 'float32':
      case 'float64':
      case 'decimal':
        if (Number.isNaN(Number(v))) {
          throw new Error(`'${prop.name}' must be numeric`);
        }
        return v;
      case 'bool':
        if (v === 'true' || v === 'false') return v;
        throw new Error(`'${prop.name}' must be true or false`);
      case 'datetime':
        return `<datetime>'${v.replace(/'/g, "\\'")}'`;
      case 'uuid':
        return `<uuid>'${v.replace(/'/g, "\\'")}'`;
      default:
        return `'${v.replace(/'/g, "\\'")}'`;
    }
  }

  // -------------------- Insert --------------------
  function startInsert() {
    if (!selectedType) return;
    insertDraft = {};
    for (const p of writableProps(selectedType)) {
      insertDraft[p.name] = '';
    }
    insertError = null;
    inserting = true;
  }

  function cancelInsert() {
    inserting = false;
    insertDraft = {};
    insertError = null;
  }

  async function submitInsert() {
    if (!selectedType) return;
    insertError = null;
    insertSubmitting = true;
    try {
      const assignments: string[] = [];
      for (const p of writableProps(selectedType)) {
        const raw = insertDraft[p.name] ?? '';
        if (raw === '' && !p.required) continue; // let server defaults apply
        assignments.push(`${p.name} := ${literalFor(p, raw)}`);
      }
      const query =
        `insert ${selectedType.module}::${selectedType.name} { ${assignments.join(', ')} };`;
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

  // -------------------- Edit --------------------
  function startEdit(row: any) {
    if (!selectedType) return;
    editingId = row.id;
    editDraft = {};
    for (const p of writableProps(selectedType)) {
      const v = row[p.name];
      editDraft[p.name] = v == null ? '' : String(v);
    }
    editError = null;
  }

  function cancelEdit() {
    editingId = null;
    editDraft = {};
    editError = null;
  }

  async function submitEdit() {
    if (!selectedType || !editingId) return;
    editError = null;
    editSubmitting = true;
    try {
      const assignments: string[] = [];
      for (const p of writableProps(selectedType)) {
        assignments.push(`${p.name} := ${literalFor(p, editDraft[p.name] ?? '')}`);
      }
      const query =
        `update ${selectedType.module}::${selectedType.name} ` +
        `filter .id = <uuid>'${editingId}' set { ${assignments.join(', ')} };`;
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

  // -------------------- Delete --------------------
  async function deleteRow(row: any) {
    if (!selectedType) return;
    const id = row.id;
    if (!confirm(`Delete ${selectedType.name} ${id}?`)) return;
    const query =
      `delete ${selectedType.module}::${selectedType.name} filter .id = <uuid>'${id}';`;
    const result = await discAPI.executeQuery(query);
    if (result.error) {
      loadError = result.error;
      return;
    }
    await loadRows();
  }
</script>

<div class="data-viewer">
  <header class="viewer-header">
    <h1>Data Viewer</h1>
    <div class="controls">
      <label>
        Limit
        <input type="number" min="1" max="500" bind:value={limit} on:change={loadRows} />
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
    </div>
  </header>

  {#if loadError}
    <div class="error-banner">{loadError}</div>
  {/if}

  <div class="viewer-body">
    <aside class="type-list">
      <h3>Object Types</h3>
      {#each types as type}
        <button
          class="type-item"
          class:active={selectedType?.name === type.name}
          on:click={() => selectType(type)}
        >
          {type.module}::{type.name}
        </button>
      {/each}
      {#if types.length === 0 && !loadError}
        <div class="empty">No types in schema</div>
      {/if}
    </aside>

    <section class="rows-pane">
      {#if selectedType}
        <h3>{selectedType.module}::{selectedType.name}</h3>

        {#if inserting}
          <form class="insert-form" on:submit|preventDefault={submitInsert}>
            <h4>New row</h4>
            {#each writableProps(selectedType) as prop}
              <label>
                {prop.name}{prop.required ? ' *' : ''}
                <span class="type-tag">{prop.type}</span>
                <input
                  type="text"
                  bind:value={insertDraft[prop.name]}
                  required={prop.required && !prop.hasDefault}
                  placeholder={prop.hasDefault ? '(default)' : ''}
                />
              </label>
            {/each}
            {#if insertError}
              <div class="error-banner">{insertError}</div>
            {/if}
            <div class="form-actions">
              <button type="submit" class="button" disabled={insertSubmitting}>
                {insertSubmitting ? 'Saving…' : 'Save'}
              </button>
              <button type="button" class="button button-secondary" on:click={cancelInsert}>
                Cancel
              </button>
            </div>
          </form>
        {/if}

        {#if rows.length > 0}
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  {#each columns as col}
                    <th>{col}</th>
                  {/each}
                  <th class="actions-col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {#each rows as row}
                  {#if editingId === row.id}
                    <tr class="editing">
                      {#each columns as col}
                        <td>
                          {#if col === 'id'}
                            <code>{row.id}</code>
                          {:else if writableProps(selectedType).find((p) => p.name === col)}
                            <input type="text" bind:value={editDraft[col]} />
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
        {:else if !loading && !loadError}
          <div class="empty">No rows.</div>
        {/if}
      {:else}
        <div class="empty">Select a type to view its data.</div>
      {/if}
    </section>
  </div>
</div>

<style lang="scss">
  .data-viewer {
    max-width: 1400px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: calc(var(--grid-unit) * 2);
  }

  .viewer-header {
    display: flex;
    justify-content: space-between;
    align-items: center;

    .controls {
      display: flex;
      align-items: center;
      gap: calc(var(--grid-unit) * 2);
      font-family: var(--font-mono);
      font-size: 0.875rem;

      input[type='number'] {
        width: 80px;
        margin-left: var(--grid-unit);
      }
    }
  }

  .error-banner {
    padding: calc(var(--grid-unit) * 1.5) calc(var(--grid-unit) * 2);
    background: rgb(var(--color-danger-rgb) / 0.1);
    border: 1px solid var(--color-danger);
    border-radius: var(--border-radius);
    color: var(--color-danger);
    font-family: var(--font-mono);
    font-size: 0.875rem;
  }

  .viewer-body {
    display: flex;
    gap: calc(var(--grid-unit) * 3);
    min-height: 60vh;
  }

  .type-list {
    width: 260px;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--border-radius);
    padding: calc(var(--grid-unit) * 2);
    display: flex;
    flex-direction: column;
    gap: calc(var(--grid-unit) * 0.5);

    h3 {
      font-size: 0.875rem;
      margin-bottom: var(--grid-unit);
    }

    .type-item {
      padding: var(--grid-unit);
      background: var(--color-background);
      border: 1px solid var(--color-border);
      border-radius: var(--border-radius);
      color: var(--color-text);
      font-family: var(--font-mono);
      font-size: 0.75rem;
      text-align: left;
      cursor: pointer;
      transition: all var(--transition-fast);

      &:hover {
        border-color: var(--color-primary);
        background: var(--color-surface-hover);
      }
      &.active {
        border-color: var(--color-primary);
        background: rgb(var(--color-primary-rgb) / 0.1);
      }
    }

    .empty {
      padding: calc(var(--grid-unit) * 2);
      color: var(--color-text-dim);
      font-size: 0.75rem;
      text-align: center;
    }
  }

  .rows-pane {
    flex: 1;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--border-radius);
    padding: calc(var(--grid-unit) * 2);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    gap: calc(var(--grid-unit) * 2);

    h3 {
      font-size: 1rem;
    }

    h4 {
      font-size: 0.875rem;
      margin-bottom: var(--grid-unit);
    }
  }

  .insert-form {
    background: var(--color-background-dark);
    border: 1px solid var(--color-primary);
    border-radius: var(--border-radius);
    padding: calc(var(--grid-unit) * 2);
    display: flex;
    flex-direction: column;
    gap: var(--grid-unit);

    label {
      display: flex;
      flex-direction: column;
      gap: calc(var(--grid-unit) * 0.5);
      font-family: var(--font-mono);
      font-size: 0.75rem;
      color: var(--color-text);

      input {
        font-family: var(--font-mono);
        font-size: 0.875rem;
        padding: var(--grid-unit);
        background: var(--color-background);
        border: 1px solid var(--color-border);
        border-radius: var(--border-radius);
        color: var(--color-text);
      }
    }

    .type-tag {
      display: inline-block;
      margin-left: var(--grid-unit);
      color: var(--color-text-dim);
      font-size: 0.7rem;
    }

    .form-actions {
      display: flex;
      gap: var(--grid-unit);
      margin-top: var(--grid-unit);
    }
  }

  .table-wrap {
    overflow: auto;
    border: 1px solid var(--color-border);
    border-radius: var(--border-radius);
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-family: var(--font-mono);
    font-size: 0.875rem;

    th, td {
      padding: calc(var(--grid-unit) * 1.5);
      text-align: left;
      border-bottom: 1px solid var(--color-border);
      white-space: nowrap;
    }
    th {
      background: var(--color-background-dark);
      color: var(--color-primary);
      position: sticky;
      top: 0;
    }
    tbody tr:last-child td { border-bottom: none; }
    tr:hover td { background: var(--color-surface-hover); }

    .editing td {
      background: rgb(var(--color-primary-rgb) / 0.05);
    }

    code {
      color: var(--color-info);
      font-size: 0.75rem;
    }

    input[type='text'] {
      font-family: var(--font-mono);
      font-size: 0.875rem;
      padding: calc(var(--grid-unit) * 0.5);
      background: var(--color-background);
      border: 1px solid var(--color-border);
      border-radius: var(--border-radius);
      color: var(--color-text);
      width: 100%;
      min-width: 120px;
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
    background: var(--color-background) !important;
    color: var(--color-text) !important;
  }

  :global(.button-danger) {
    background: rgb(var(--color-danger-rgb) / 0.1) !important;
    color: var(--color-danger) !important;
    border-color: var(--color-danger) !important;
  }

  .empty {
    padding: calc(var(--grid-unit) * 4);
    text-align: center;
    color: var(--color-text-dim);
    font-family: var(--font-mono);
    font-size: 0.875rem;
  }
</style>
