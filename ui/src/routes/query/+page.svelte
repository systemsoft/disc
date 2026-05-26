<script lang="ts">
  /*** IMPORT ------------------------------------------- ***/

  import { onMount } from "svelte";

  /*** UTILITY ------------------------------------------ ***/

  import { discAPI } from "$lib/api/client";

  interface JsonResult {
    kind: "json";
    text: string;
  }

  interface TableResult {
    columns: string[];
    kind: "table";
    rows: any[][];
  }

  type DisplayResult = (TableResult | JsonResult) & { executionTime: number };

  let errorMessage = "";
  let isExecuting = false;
  let queryHistory: string[] = [];
  let queryResult: DisplayResult | null = null;
  let queryText = "select User { email, name };";
  let savedQueries: Array<{name: string, query: string}> = [];

  /*** RUNTIME ------------------------------------------ ***/

  onMount(() => {
    const saved = localStorage.getItem("discSavedQueries");

    if (saved)
      savedQueries = JSON.parse(saved);

    const history = localStorage.getItem("discQueryHistory");

    if (history)
      queryHistory = JSON.parse(history);
  });

  /*** HELPER ------------------------------------------- ***/

  function clearResults() {
    queryResult = null;
    errorMessage = "";
  }

  async function executeQuery() {
    if (!queryText.trim())
      return;

    isExecuting = true;
    errorMessage = "";

    queryHistory = [queryText, ...queryHistory.filter(q => q !== queryText)].slice(0, 20);
    localStorage.setItem("discQueryHistory", JSON.stringify(queryHistory));

    const result = await discAPI.executeQuery(queryText);
    isExecuting = false;

    if (result.error) {
      errorMessage = result.error;
      queryResult = null;

      return;
    }

    queryResult = shapeResult(result.data, Math.round(result.durationMs));
  }

  function formatQuery() {
    // Simple formatting - in production would use proper parser
    queryText = queryText
      .replace(/\s+/g, " ")
      .replace(/\{/g, " {\n  ")
      .replace(/\}/g, "\n}")
      .replace(/,/g, ",\n  ");
  }

  function loadQuery(query: string) {
    queryText = query;
  }

  function saveQuery() {
    const name = prompt("Enter a name for this query:");

    if (name) {
      savedQueries = [...savedQueries, { name, query: queryText }];
      localStorage.setItem("discSavedQueries", JSON.stringify(savedQueries));
    }
  }

  function shapeResult(data: any, executionTime: number): DisplayResult {
    if (Array.isArray(data) && data.length > 0 && typeof data[0] === "object" && data[0] !== null) {
      const columns = Array.from(
        data.reduce((set: Set<string>, row: any) => {
          for (const k of Object.keys(row)) {
            set.add(k);
          }

          return set;
        },
        new Set<string>()
      ));

      const rows = data.map((row: any) =>
        columns.map((c) => {
          const v = row[c];
          if (v === null || v === undefined) return "";
          if (typeof v === "object") return JSON.stringify(v);
          return v;
        })
      );
      return { kind: "table", columns, rows, executionTime };
    }
    return { kind: "json", text: JSON.stringify(data, null, 2), executionTime };
  }
</script>

<style lang="scss">
  .query-editor {
    display: flex;
    flex-direction: column;
    height: calc(100vh - 120px);
    margin: 0 auto;
    max-width: 1400px;
  }

  .editor-toolbar {
    align-items: center;
    display: flex;
    justify-content: space-between;
    margin-bottom: calc(var(--grid-unit) * 3);

    h1 {
      font-size: 1.5rem;
    }

    .toolbar-actions {
      display: flex;
      gap: var(--grid-unit);
    }
  }

  .editor-container {
    display: flex;
    gap: calc(var(--grid-unit) * 3);
    flex: 1;
    overflow: hidden;
  }

  .editor-sidebar {
    display: flex;
    flex-direction: column;
    gap: calc(var(--grid-unit) * 3);
    width: 250px;

    .sidebar-section {
      /* background: var(--color-surface); */
      /* border: 1px solid var(--color-border); */
      /* border-radius: var(--border-radius); */
      padding: calc(var(--grid-unit) * 2);

      h3 {
        font-size: 0.875rem;
        margin-bottom: calc(var(--grid-unit) * 2);
      }
    }

    .query-list {
      display: flex;
      flex-direction: column;
      gap: calc(var(--grid-unit) * 0.5);
    }

    .query-item {
      /* background: var(--color-background); */
      /* border: 1px solid var(--color-border); */
      /* border-radius: var(--border-radius); */
      /* color: var(--color-text); */
      cursor: pointer;
      font-family: var(--font-mono);
      font-size: 0.75rem;
      padding: var(--grid-unit);
      text-align: left;
      transition: all var(--transition-fast);

      &:hover {
        /* border-color: var(--color-primary); */
        /* background: var(--color-surface-hover); */
      }

      &.history-item {
        code {
          /* color: var(--color-info); */
          font-size: 0.7rem;
        }
      }
    }

    .empty-text {
      /* color: var(--color-text-dim); */
      font-size: 0.75rem;
      padding: calc(var(--grid-unit) * 2);
      text-align: center;
    }
  }

  .editor-main {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: calc(var(--grid-unit) * 3);
    overflow-y: auto;
  }

  .code-editor {
    /* background: var(--color-surface); */
    /* border: 1px solid var(--color-border); */
    /* border-radius: var(--border-radius); */
    display: flex;
    min-height: 300px;
    overflow: hidden;
    position: relative;

    .line-numbers {
      /* background: var(--color-background-dark); */
      /* border-right: 1px solid var(--color-border); */
      display: flex;
      flex-direction: column;
      font-family: var(--font-mono);
      font-size: 0.875rem;
      line-height: 1.5rem;
      padding: calc(var(--grid-unit) * 2);
      user-select: none;
      /* color: var(--color-text-dim); */


      span {
        min-width: 30px;
        padding-right: var(--grid-unit);
        text-align: right;
      }
    }

    .query-input {
      /* background: transparent; */
      /* border: none; */
      /* color: var(--color-info); */
      flex: 1;
      font-family: var(--font-mono);
      font-size: 0.875rem;
      line-height: 1.5rem;
      padding: calc(var(--grid-unit) * 2);
      resize: none;

      &:focus {
        outline: none;
      }

      &::selection {
        background: rgb(var(--color-primary-rgb) / 0.3);
      }
    }
  }

  .error-message {
    align-items: center;
    color: var(--color-danger);
    display: flex;
    font-family: var(--font-mono);
    font-size: 0.875rem;
    gap: var(--grid-unit);
    padding: calc(var(--grid-unit) * 2);
    /* background: rgb(var(--color-danger-rgb) / 0.1); */
    /* border: 1px solid var(--color-danger); */
    /* border-radius: var(--border-radius); */

    .error-icon {
      font-size: 1.25rem;
    }
  }

  .query-results {
    /* background: var(--color-surface); */
    /* border: 1px solid var(--color-border); */
    /* border-radius: var(--border-radius); */
    overflow: hidden;

    .results-header {
      align-items: center;
      /* border-bottom: 1px solid var(--color-border); */
      display: flex;
      gap: calc(var(--grid-unit) * 2);
      padding: calc(var(--grid-unit) * 2);

      h3 {
        font-size: 1rem;
        flex: 1;
      }

      .execution-time {
        color: var(--color-success);
        font-family: var(--font-mono);
        font-size: 0.75rem;
      }
    }

    .results-json {
      margin: 0; padding: calc(var(--grid-unit) * 2);

      /* background: var(--color-background-dark); */
      /* color: var(--color-info); */
      font-family: var(--font-mono);
      font-size: 0.875rem;
      max-height: 400px;
      overflow: auto;
    }

    .results-table {
      overflow-x: auto;

      table {
        border-collapse: collapse;
        font-family: var(--font-mono);
        font-size: 0.875rem;
        width: 100%;

        th, td {
          /* border-bottom: 1px solid var(--color-border); */
          padding: calc(var(--grid-unit) * 1.5);
          text-align: left;
        }

        th {
          /* background: var(--color-background-dark); */
          /* color: var(--color-primary); */
          font-weight: 500;
          letter-spacing: 0.05rem;
          text-transform: uppercase;
        }

        tr:hover td {
          background: var(--color-surface-hover);
        }

        tbody tr:last-child td {
          border-bottom: none;
        }
      }
    }
  }
</style>

<svelte:head>
  <title>Disc Viewer &bull; Query Editor</title>
</svelte:head>

<div class="query-editor">
  <div class="editor-container">
    <div class="editor-sidebar">
      <div class="sidebar-section">
        <h3>Saved Queries</h3>

        <div class="query-list">
          {#each savedQueries as saved}
            <button
              class="query-item"
              onclick={() => loadQuery(saved.query)}>
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
              onclick={() => loadQuery(query)}>
              <code>{query.slice(0, 50)}&hellip;</code>
            </button>
          {/each}

          {#if queryHistory.length === 0}
            <div class="empty-text">No history</div>
          {/if}
        </div>
      </div>
    </div>

    <div class="editor-main">
      <div class="toolbar-actions">
        <button class="button" onclick={formatQuery}>Format</button>
        <button class="button" onclick={saveQuery}>Save</button>
        <button class="button primary" onclick={executeQuery} disabled={isExecuting}>
          {isExecuting ? "Executing..." : "Execute"}
        </button>
      </div>

      <div class="code-editor">
        <div class="line-numbers">
          {#each queryText.split("\n") as _, i}
            <span>{i + 1}</span>
          {/each}
        </div>

        <textarea
          class="query-input"
          placeholder="Enter your EdgeQL query…"
          spellcheck="false"
          bind:value={queryText}/>
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
            <button class="button" onclick={clearResults}>Clear</button>
          </div>

          {#if queryResult.kind === "table"}
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
