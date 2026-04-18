<script lang="ts">
  import { onMount } from 'svelte';
  import { discAPI } from '$lib/api/client';

  // P1-23: query editor wired to real /query endpoint. Result rendering
  // adapts to whatever EdgeQL returns: an array of rows is rendered as a
  // table (columns derived from the first row's keys); anything else falls
  // back to a JSON pretty-print so scalar/single-object results are still
  // readable.
  interface TableResult {
    columns: string[];
    kind: 'table';
    rows: any[][];
  }
  interface JsonResult {
    kind: 'json';
    text: string;
  }
  type DisplayResult = (TableResult | JsonResult) & { executionTime: number };

  let queryText = 'select User { name, email };';
  let queryResult: DisplayResult | null = null;
  let isExecuting = false;
  let errorMessage = '';
  let savedQueries: Array<{name: string, query: string}> = [];
  let queryHistory: string[] = [];

  onMount(() => {
    const saved = localStorage.getItem('discSavedQueries');
    if (saved) {
      savedQueries = JSON.parse(saved);
    }

    const history = localStorage.getItem('discQueryHistory');
    if (history) {
      queryHistory = JSON.parse(history);
    }
  });

  function shapeResult(data: any, executionTime: number): DisplayResult {
    if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'object' && data[0] !== null) {
      const columns = Array.from(
        data.reduce((set: Set<string>, row: any) => {
          for (const k of Object.keys(row)) set.add(k);
          return set;
        }, new Set<string>())
      );
      const rows = data.map((row: any) =>
        columns.map((c) => {
          const v = row[c];
          if (v === null || v === undefined) return '';
          if (typeof v === 'object') return JSON.stringify(v);
          return v;
        })
      );
      return { kind: 'table', columns, rows, executionTime };
    }
    return { kind: 'json', text: JSON.stringify(data, null, 2), executionTime };
  }

  async function executeQuery() {
    if (!queryText.trim()) return;

    isExecuting = true;
    errorMessage = '';

    queryHistory = [queryText, ...queryHistory.filter(q => q !== queryText)].slice(0, 20);
    localStorage.setItem('discQueryHistory', JSON.stringify(queryHistory));

    const result = await discAPI.executeQuery(queryText);
    isExecuting = false;

    if (result.error) {
      errorMessage = result.error;
      queryResult = null;
      return;
    }
    queryResult = shapeResult(result.data, Math.round(result.durationMs));
  }

  function saveQuery() {
    const name = prompt('Enter a name for this query:');
    if (name) {
      savedQueries = [...savedQueries, { name, query: queryText }];
      localStorage.setItem('discSavedQueries', JSON.stringify(savedQueries));
    }
  }

  function loadQuery(query: string) {
    queryText = query;
  }

  function formatQuery() {
    // Simple formatting - in production would use proper parser
    queryText = queryText
      .replace(/\s+/g, ' ')
      .replace(/\{/g, ' {\n  ')
      .replace(/\}/g, '\n}')
      .replace(/,/g, ',\n  ');
  }

  function clearResults() {
    queryResult = null;
    errorMessage = '';
  }
</script>

<div class="query-editor">
  <div class="editor-toolbar">
    <h1>Query Editor</h1>
    <div class="toolbar-actions">
      <button class="button" on:click={formatQuery}>
        Format
      </button>
      <button class="button" on:click={saveQuery}>
        Save
      </button>
      <button class="button primary" on:click={executeQuery} disabled={isExecuting}>
        {isExecuting ? 'Executing...' : 'Execute'}
      </button>
    </div>
  </div>

  <div class="editor-container">
    <div class="editor-sidebar">
      <div class="sidebar-section">
        <h3>Saved Queries</h3>
        <div class="query-list">
          {#each savedQueries as saved}
            <button
              class="query-item"
              on:click={() => loadQuery(saved.query)}
            >
              {saved.name}
            </button>
          {/each}
          {#if savedQueries.length === 0}
            <div class="empty-text">No saved queries</div>
          {/if}
        </div>
      </div>

      <div class="sidebar-section">
        <h3>History</h3>
        <div class="query-list">
          {#each queryHistory.slice(0, 5) as query}
            <button
              class="query-item history-item"
              on:click={() => loadQuery(query)}
            >
              <code>{query.slice(0, 50)}...</code>
            </button>
          {/each}
          {#if queryHistory.length === 0}
            <div class="empty-text">No history</div>
          {/if}
        </div>
      </div>
    </div>

    <div class="editor-main">
      <div class="code-editor">
        <div class="line-numbers">
          {#each queryText.split('\n') as _, i}
            <span>{i + 1}</span>
          {/each}
        </div>
        <textarea
          bind:value={queryText}
          placeholder="Enter your EdgeQL query..."
          class="query-input"
          spellcheck="false"
        />
      </div>

      {#if errorMessage}
        <div class="error-message">
          <span class="error-icon">⚠</span>
          {errorMessage}
        </div>
      {/if}

      {#if queryResult}
        <div class="query-results">
          <div class="results-header">
            <h3>Results</h3>
            <span class="execution-time">
              Executed in {queryResult.executionTime}ms
            </span>
            <button class="button" on:click={clearResults}>Clear</button>
          </div>

          {#if queryResult.kind === 'table'}
            <div class="results-table">
              <table>
                <thead>
                  <tr>
                    {#each queryResult.columns as column}
                      <th>{column}</th>
                    {/each}
                  </tr>
                </thead>
                <tbody>
                  {#each queryResult.rows as row}
                    <tr>
                      {#each row as cell}
                        <td>{cell}</td>
                      {/each}
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {:else}
            <pre class="results-json">{queryResult.text}</pre>
          {/if}
        </div>
      {/if}
    </div>
  </div>
</div>

<style lang="scss">
  @import '../../styles/variables.scss';

  .query-editor {
    display: flex;
    flex-direction: column;
    height: calc(100vh - 120px);
    max-width: 1400px;
    margin: 0 auto;
  }

  .editor-toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: $grid-unit * 3;

    h1 {
      font-size: 1.5rem;
    }

    .toolbar-actions {
      display: flex;
      gap: $grid-unit;
    }
  }

  .editor-container {
    display: flex;
    gap: $grid-unit * 3;
    flex: 1;
    overflow: hidden;
  }

  .editor-sidebar {
    width: 250px;
    display: flex;
    flex-direction: column;
    gap: $grid-unit * 3;

    .sidebar-section {
      background: $color-surface;
      border: 1px solid $color-border;
      border-radius: $border-radius;
      padding: $grid-unit * 2;

      h3 {
        font-size: 0.875rem;
        margin-bottom: $grid-unit * 2;
      }
    }

    .query-list {
      display: flex;
      flex-direction: column;
      gap: $grid-unit * 0.5;
    }

    .query-item {
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

      &.history-item {
        code {
          color: $color-info;
          font-size: 0.7rem;
        }
      }
    }

    .empty-text {
      padding: $grid-unit * 2;
      text-align: center;
      color: $color-text-dim;
      font-size: 0.75rem;
    }
  }

  .editor-main {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: $grid-unit * 3;
    overflow-y: auto;
  }

  .code-editor {
    display: flex;
    background: $color-surface;
    border: 1px solid $color-border;
    border-radius: $border-radius;
    overflow: hidden;
    min-height: 300px;
    position: relative;

    .line-numbers {
      padding: $grid-unit * 2;
      background: $color-background-dark;
      border-right: 1px solid $color-border;
      display: flex;
      flex-direction: column;
      font-family: $font-mono;
      font-size: 0.875rem;
      color: $color-text-dim;
      line-height: 1.5em;
      user-select: none;

      span {
        text-align: right;
        padding-right: $grid-unit;
        min-width: 30px;
      }
    }

    .query-input {
      flex: 1;
      padding: $grid-unit * 2;
      background: transparent;
      border: none;
      color: $color-info;
      font-family: $font-mono;
      font-size: 0.875rem;
      line-height: 1.5em;
      resize: none;

      &:focus {
        outline: none;
      }

      &::selection {
        background: rgba($color-primary, 0.3);
      }
    }
  }

  .error-message {
    display: flex;
    align-items: center;
    gap: $grid-unit;
    padding: $grid-unit * 2;
    background: rgba($color-danger, 0.1);
    border: 1px solid $color-danger;
    border-radius: $border-radius;
    color: $color-danger;
    font-family: $font-mono;
    font-size: 0.875rem;

    .error-icon {
      font-size: 1.25rem;
    }
  }

  .query-results {
    background: $color-surface;
    border: 1px solid $color-border;
    border-radius: $border-radius;
    overflow: hidden;

    .results-header {
      display: flex;
      align-items: center;
      gap: $grid-unit * 2;
      padding: $grid-unit * 2;
      border-bottom: 1px solid $color-border;

      h3 {
        font-size: 1rem;
        flex: 1;
      }

      .execution-time {
        font-family: $font-mono;
        font-size: 0.75rem;
        color: $color-success;
      }
    }

    .results-json {
      margin: 0;
      padding: $grid-unit * 2;
      background: $color-background-dark;
      color: $color-info;
      font-family: $font-mono;
      font-size: 0.875rem;
      max-height: 400px;
      overflow: auto;
    }

    .results-table {
      overflow-x: auto;

      table {
        width: 100%;
        border-collapse: collapse;
        font-family: $font-mono;
        font-size: 0.875rem;

        th, td {
          padding: $grid-unit * 1.5;
          text-align: left;
          border-bottom: 1px solid $color-border;
        }

        th {
          background: $color-background-dark;
          color: $color-primary;
          font-weight: 500;
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }

        tr:hover td {
          background: $color-surface-hover;
        }

        tbody tr:last-child td {
          border-bottom: none;
        }
      }
    }
  }
</style>
