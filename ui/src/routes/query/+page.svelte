<script lang="ts">
  /*** IMPORT ------------------------------------------- ***/

  import { onMount } from "svelte";

  /*** UTILITY ------------------------------------------ ***/

  import { discAPI } from "$lib/api/client";
  import { formatQuery as formatQueryLibrary } from "$lib/format-query";

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

  function formatCell(value: any): string {
    if (value === null || value === undefined)
      return "";

    if (typeof value === "object")
      return JSON.stringify(value);

    return String(value);
  }

  function formatQuery() {
    queryText = formatQueryLibrary(queryText);
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

          if (v === null || v === undefined)
            return "";

          if (typeof v === "object")
            return JSON.stringify(v);

          return v;
        })
      );

      return {
        columns,
        executionTime,
        kind: "table",
        rows
      };
    }

    return {
      executionTime,
      kind: "json",
      text: JSON.stringify(data, null, 2)
    };
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

  .viewer-body {
    display: flex;
    gap: calc(var(--grid-unit) * 3);
    min-height: 60vh;
  }

  .error-banner {
    background-color: oklch(var(--uchu-red-1-raw) / 20%);
    color: var(--uchu-red-5);
    font-family: var(--font-mono);
    font-size: 0.875rem;
    margin-top: var(--grid-unit);
    padding: calc(var(--grid-unit) * 1.5) calc(var(--grid-unit) * 2);
  }

  .controls {
    align-items: center;
    display: flex;
    gap: calc(var(--grid-unit) * 2);
    font-family: var(--font-mono);
    font-size: 0.75rem;
    text-transform: uppercase;

    button {
      font-size: inherit;
      text-transform: inherit;
    }
  }

  .query-list {
    width: 300px; height: 80vh;

    border-bottom: 1px solid var(--uchu-gray-1);
    display: flex;
    flex-direction: column;
    gap: calc(var(--grid-unit) * 0.5);
    overflow-y: auto;
    padding-bottom: var(--grid-unit);

    .query-item {
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
    }

    .empty {
      color: var(--color-text-dim);
      font-family: var(--font-mono);
      font-size: 0.75rem;
      letter-spacing: 0.05rem;
      padding: calc(var(--grid-unit) * 2);
      text-align: center;
    }
  }

  h5 {
    &:not(:first-of-type) {
      margin-top: calc(var(--grid-unit) * 2.5);
    }
  }

  .editor-main {
    display: flex;
    flex: 1;
    flex-direction: column;
    overflow-y: auto;

    h5 {
      &:not(:first-of-type) {
        margin-top: calc(var(--grid-unit) * 2.5);
      }
    }
  }

  .code-editor {
    display: flex;
    min-height: 300px;
    overflow: hidden;
    position: relative;

    .line-numbers {
      background-color: var(--uchu-gray-1);
      color: var(--uchu-yin-3);
      display: flex;
      flex-direction: column;
      font-family: var(--font-mono);
      font-size: 0.875rem;
      line-height: 1.5rem;
      padding: calc(var(--grid-unit) * 2);
      user-select: none;


      span {
        min-width: 3ch;
        text-align: right;
      }
    }

    .query-input {
      border: 1px solid var(--uchu-gray-1);
      color: var(--uchu-yin-7);
      flex: 1;
      font-family: var(--font-mono);
      font-size: 0.875rem;
      line-height: 1.5rem;
      padding: calc(var(--grid-unit) * 2);
      resize: none;

      &:focus {
        outline: none;
      }
    }
  }

  .results-json {
    margin: 0; padding: calc(var(--grid-unit) * 2);

    font-family: var(--font-mono);
    font-size: 0.875rem;
    max-height: 400px;
    overflow: auto;
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
    padding-bottom: var(--grid-unit);
    transition: box-shadow 0.2s;

    .data-header {
      background-color: oklch(var(--uchu-gray-1-raw) / 50%);
      border-bottom: 1px solid var(--uchu-gray-1);
      flex-direction: row;
      font-weight: 500;
      margin-bottom: var(--grid-unit);
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
  <title>Disc Viewer &bull; Query Editor</title>
</svelte:head>

<div class="data-viewer">
  <div class="viewer-body">
    <aside class="query-list">
      <h5 style="--ch: 13ch;">Saved Queries</h5>

      {#each savedQueries as saved}
        <button
          class="query-item"
          onclick={() => loadQuery(saved.query)}>
          {saved.name}
        </button>
      {/each}

      {#if savedQueries.length === 0}
        <div class="empty">No saved queries</div>
      {/if}

      <h5 style="--ch: 7ch;">History</h5>

      {#each queryHistory.slice(0, 5) as query}
        <button
          class="query-item"
          onclick={() => loadQuery(query)}>
          {#if query.length > 30}
            {query.slice(0, 30)}&hellip;
          {:else}
            {query}
          {/if}
        </button>
      {/each}

      {#if queryHistory.length === 0}
        <div class="empty">No history</div>
      {/if}
    </aside>

    <section class="editor-main">
      <h5 style="--ch: 14ch;">Query Controls</h5>

      <div class="controls">
        <button class="button" onclick={formatQuery}>Format</button>
        <button class="button" onclick={saveQuery}>Save</button>
        <button
          class="button primary"
          disabled={isExecuting}
          onclick={executeQuery}>
          {isExecuting ? "Executing…" : "Execute"}
        </button>
      </div>

      <h5 style="--ch: 12ch;">Query Editor</h5>

      <div class="code-editor">
        <div class="line-numbers">
          {#each queryText.split("\n") as _, i}
            <span>{i + 1}</span>
          {/each}
        </div>

        <textarea
          class="query-input"
          id="query-editor"
          placeholder="Enter your EdgeQL query…"
          spellcheck="false"
          bind:value={queryText}></textarea>
      </div>

      {#if errorMessage}
        <div class="error-banner">{errorMessage}</div>
      {/if}

      {#if queryResult}
        <h5 style="--ch: 12ch;">Query Result</h5>

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
</div>
