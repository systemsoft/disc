<script lang="ts">
  import { onMount } from 'svelte';
  import { discAPI, type SchemaTypeDescription } from '$lib/api/client';

  // P1-23: data viewer wired to live schema + /query. The server doesn't
  // expose a REST `/data/:type` route, so the viewer composes a small
  // EdgeQL `select` covering scalar + single-link properties, and renders
  // whatever the server returns. Insert/update/delete remain TODO until
  // the protocol exposes mutation endpoints; for now the page is read-only.
  let types: SchemaTypeDescription[] = [];
  let selectedType: SchemaTypeDescription | null = null;
  let rows: any[] = [];
  let columns: string[] = [];
  let limit = 50;
  let loading = false;
  let loadError: string | null = null;

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
    await loadRows();
  }

  function buildSelect(type: SchemaTypeDescription): { query: string; cols: string[] } {
    const propNames = type.properties.map((p) => p.name);
    const linkNames = type.links
      .filter((l) => l.cardinality === 'single')
      .map((l) => l.name);
    const fields = ['id', ...propNames, ...linkNames.map((n) => `${n}: { id }`)];
    const query = `select ${type.module}::${type.name} { ${fields.join(', ')} } limit ${limit};`;
    return { query, cols: ['id', ...propNames, ...linkNames] };
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
        {#if rows.length > 0}
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  {#each columns as col}
                    <th>{col}</th>
                  {/each}
                </tr>
              </thead>
              <tbody>
                {#each rows as row}
                  <tr>
                    {#each columns as col}
                      <td>{formatCell(row[col])}</td>
                    {/each}
                  </tr>
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
  @import '../../styles/variables.scss';

  .data-viewer {
    max-width: 1400px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: $grid-unit * 2;
  }

  .viewer-header {
    display: flex;
    justify-content: space-between;
    align-items: center;

    .controls {
      display: flex;
      align-items: center;
      gap: $grid-unit * 2;
      font-family: $font-mono;
      font-size: 0.875rem;

      input[type='number'] {
        width: 80px;
        margin-left: $grid-unit;
      }
    }
  }

  .error-banner {
    padding: $grid-unit * 1.5 $grid-unit * 2;
    background: rgba($color-danger, 0.1);
    border: 1px solid $color-danger;
    border-radius: $border-radius;
    color: $color-danger;
    font-family: $font-mono;
    font-size: 0.875rem;
  }

  .viewer-body {
    display: flex;
    gap: $grid-unit * 3;
    min-height: 60vh;
  }

  .type-list {
    width: 260px;
    background: $color-surface;
    border: 1px solid $color-border;
    border-radius: $border-radius;
    padding: $grid-unit * 2;
    display: flex;
    flex-direction: column;
    gap: $grid-unit * 0.5;

    h3 {
      font-size: 0.875rem;
      margin-bottom: $grid-unit;
    }

    .type-item {
      padding: $grid-unit;
      background: $color-background;
      border: 1px solid $color-border;
      border-radius: $border-radius;
      color: $color-text;
      font-family: $font-mono;
      font-size: 0.75rem;
      text-align: left;
      cursor: pointer;
      transition: all $transition-fast;

      &:hover {
        border-color: $color-primary;
        background: $color-surface-hover;
      }
      &.active {
        border-color: $color-primary;
        background: rgba($color-primary, 0.1);
      }
    }

    .empty {
      padding: $grid-unit * 2;
      color: $color-text-dim;
      font-size: 0.75rem;
      text-align: center;
    }
  }

  .rows-pane {
    flex: 1;
    background: $color-surface;
    border: 1px solid $color-border;
    border-radius: $border-radius;
    padding: $grid-unit * 2;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    gap: $grid-unit * 2;

    h3 {
      font-size: 1rem;
    }
  }

  .table-wrap {
    overflow: auto;
    border: 1px solid $color-border;
    border-radius: $border-radius;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-family: $font-mono;
    font-size: 0.875rem;

    th, td {
      padding: $grid-unit * 1.5;
      text-align: left;
      border-bottom: 1px solid $color-border;
      white-space: nowrap;
    }
    th {
      background: $color-background-dark;
      color: $color-primary;
      position: sticky;
      top: 0;
    }
    tbody tr:last-child td { border-bottom: none; }
    tr:hover td { background: $color-surface-hover; }
  }

  .empty {
    padding: $grid-unit * 4;
    text-align: center;
    color: $color-text-dim;
    font-family: $font-mono;
    font-size: 0.875rem;
  }
</style>
