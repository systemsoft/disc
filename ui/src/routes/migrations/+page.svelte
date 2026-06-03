<script lang="ts">
  /*** IMPORT ------------------------------------------- ***/

  import { onMount } from "svelte";

  /*** UTILITY ------------------------------------------ ***/

  import { discAPI, type MigrationHistoryEntry } from "$lib/api/client";

  let loadError: string | null = null;
  let loading = true;
  let migrations: MigrationHistoryEntry[] = [];

  /*** RUNTIME ------------------------------------------ ***/

  onMount(reload);

  /*** HELPER ------------------------------------------- ***/

  function formatDate(value: string): string {
    if (!value)
      return "";

    const d = new Date(value);

    if (Number.isNaN(d.getTime()))
      return value;

    return d.toLocaleString();
  }

  function formatDuration(ms: number): string {
    if (ms === null)
      return "";

    if (ms < 1000)
      return `${ms}ms`;

    return `${(ms / 1000).toFixed(2)}s`;
  }

  async function reload() {
    loading = true;
    loadError = null;

    try {
      migrations = await discAPI.getMigrations();
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }
</script>

<style lang="scss">
  .migrations {
    display: flex;
    flex-direction: column;
    gap: calc(var(--grid-unit) * 2);
  }

  .page-header {
    align-items: center;
    display: flex;
    justify-content: space-between;

    h1 {
      line-height: 1;
    }

    button {
      font-size: 0.75rem;
      text-transform: uppercase;
    }
  }

  .error-banner {
    font-family: var(--font-mono);
    font-size: 0.875rem;
    padding: calc(var(--grid-unit) * 1.5) calc(var(--grid-unit) * 2);
  }

  .empty {
    padding: calc(var(--grid-unit) * 4);
    text-align: center;

    h3 {
      font-size: 1rem;
      margin-bottom: calc(var(--grid-unit) * 2);
    }

    p {
      font-family: var(--font-mono);
      font-size: 0.875rem;
    }
  }

  code {
    color: var(--uchu-yin-7);
    position: relative;
    z-index: 1;

    &::after {
      width: calc(100% + var(--grid-unit)); height: 100%;
      bottom: 0; left: calc(var(--grid-unit) / 2 * -1);

      background-color: var(--uchu-yellow-1);
      content: "";
      position: absolute;
      z-index: -1;
    }
  }

  .table-wrap {
    border-top: 1px solid var(--uchu-gray-1);
    margin-top: var(--grid-unit);
    overflow: auto;
    padding-top: calc(var(--grid-unit) * 3);
  }

  table {
    border-collapse: collapse;
    font-family: var(--font-mono);
    font-size: 0.875rem;
    width: 100%;

    thead {
      letter-spacing: 0.05rem;
      text-transform: uppercase;

      th {
        padding-left: var(--grid-unit);
        padding-right: var(--grid-unit);
      }
    }

    th, td {
      text-align: left;
      vertical-align: top;
    }

    th {
      position: sticky;
      top: 0;
      white-space: nowrap;
    }

    tbody tr {
      &:nth-child(odd) {
        background-color: oklch(var(--uchu-yin-1-raw) / 30%);
      }

      &.editing {
        /* background-color: var(--uchu-yellow-1); */
        background-color: oklch(var(--uchu-yellow-1-raw) / 30%);
      }

      &:not(.editing):hover {
        background-color: var(--uchu-gray-1);
      }

      td {
        padding: calc(var(--grid-unit) / 2) var(--grid-unit);
      }
    }
  }
</style>

<svelte:head>
  <title>Disc Viewer &bull; Migration History</title>
</svelte:head>

<div class="migrations">
  <header class="page-header">
    <h1>Migration History</h1>
    <button class="button" on:click={reload} disabled={loading}>
      {loading ? "Loading…" : "Refresh"}
    </button>
  </header>

  {#if loadError}
    <div class="error-banner">{loadError}</div>
  {/if}

  {#if !loading && migrations.length === 0 && !loadError}
    <div class="empty">
      <h3>No migrations applied yet</h3>
      <p>When the schema is applied (via <code>disc serve</code> auto-migrate on a fresh database, or <code>disc migrate</code> manually) the history will appear here.</p>
    </div>
  {/if}

  {#if migrations.length > 0}
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Applied</th>
            <th>Name</th>
            <th>ID</th>
            <th>Description</th>
            <th>Duration</th>
            <th>Schema Hash</th>
          </tr>
        </thead>

        <tbody>
          {#each migrations as m}
            <tr>
              <td>{formatDate(m.appliedAt)}</td>
              <td>{m.name}</td>
              <td><code>{m.id}</code></td>
              <td>{m.description}</td>
              <td>{formatDuration(m.durationMs)}</td>
              <td><code>{m.schemaHash}</code></td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>
