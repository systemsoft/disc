/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

<script lang="ts">
  import { onMount } from 'svelte';
  import { discAPI, type MigrationHistoryEntry } from '$lib/api/client';

  let migrations: MigrationHistoryEntry[] = [];
  let loading = true;
  let loadError: string | null = null;

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

  onMount(reload);

  function formatDate(value: string): string {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    return d.toLocaleString();
  }

  function formatDuration(ms: number): string {
    if (ms == null) return '';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  }
</script>

<div class="migrations">
  <header class="page-header">
    <h1>Migration History</h1>
    <button class="button" on:click={reload} disabled={loading}>
      {loading ? 'Loading…' : 'Refresh'}
    </button>
  </header>

  {#if loadError}
    <div class="error-banner">{loadError}</div>
  {/if}

  {#if !loading && migrations.length === 0 && !loadError}
    <div class="empty">
      <h3>No migrations applied yet</h3>
      <p>
        When the schema is applied (via <code>disc serve</code> auto-migrate
        on a fresh database, or <code>disc migrate</code> manually) the
        history will appear here.
      </p>
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

<style lang="scss">
  .migrations {
    max-width: 1400px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: calc(var(--grid-unit) * 2);
  }

  .page-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
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

  .empty {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--border-radius);
    padding: calc(var(--grid-unit) * 4);
    text-align: center;

    h3 {
      font-size: 1rem;
      margin-bottom: calc(var(--grid-unit) * 2);
    }

    p {
      color: var(--color-text-dim);
      font-family: var(--font-mono);
      font-size: 0.875rem;
      line-height: 1.5;
    }

    code {
      color: var(--color-info);
    }
  }

  .table-wrap {
    overflow: auto;
    background: var(--color-surface);
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

    code {
      color: var(--color-info);
      font-size: 0.75rem;
    }
  }
</style>
