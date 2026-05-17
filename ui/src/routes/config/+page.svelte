/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

<script lang="ts">
  import { onMount } from 'svelte';
  import { discAPI, type ConfigKeyDef } from '$lib/api/client';

  let configKeys: ConfigKeyDef[] = [];
  let loading = true;
  let loadError: string | null = null;
  let revealed = new Set<string>();

  // #5988 + #6444: the registry catalogue is shipped today; current
  // values come from a future endpoint that does a SHOW/SELECT roundtrip
  // and applies maskIfSecret() per row. Until then we render `(default)`
  // for non-secret keys and the mask itself for secrets so the masking
  // contract is visible end-to-end.
  const PLACEHOLDER_VALUE = '(default)';
  const MASK = '••••••••';

  async function reload() {
    loading = true;
    loadError = null;
    try {
      configKeys = await discAPI.getConfig();
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  function displayValue(key: ConfigKeyDef): string {
    if (key.secret && !revealed.has(key.name)) return MASK;
    if (key.defaultValue !== undefined) return String(key.defaultValue);
    return PLACEHOLDER_VALUE;
  }

  function toggleReveal(name: string) {
    if (revealed.has(name)) revealed.delete(name);
    else revealed.add(name);
    revealed = revealed; // trigger reactivity
  }

  onMount(reload);
</script>

<div class="config">
  <header class="page-header">
    <div>
      <h1>Configuration</h1>
      <p class="subtitle">
        CONFIGURE-able settings registry. Secret values are masked by default.
      </p>
    </div>
    <button class="button" on:click={reload} disabled={loading}>
      {loading ? 'Loading…' : 'Refresh'}
    </button>
  </header>

  {#if loadError}
    <div class="error-banner">{loadError}</div>
  {/if}

  {#if !loading && configKeys.length === 0 && !loadError}
    <div class="empty">
      <h3>No configuration keys</h3>
      <p>The server returned an empty config registry.</p>
    </div>
  {/if}

  {#if configKeys.length > 0}
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Scope</th>
            <th>Value</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          {#each configKeys as k (k.name)}
            <tr class:secret={k.secret}>
              <td>
                <code>{k.name}</code>
                {#if k.secret}
                  <span class="badge" title="Marked secret — value is masked">🔒 secret</span>
                {/if}
              </td>
              <td><span class="type">{k.edgeqlType}</span></td>
              <td>{k.defaultScope}</td>
              <td class="value">
                <span class="value-text" class:masked={k.secret && !revealed.has(k.name)}>
                  {displayValue(k)}
                </span>
                {#if k.secret}
                  <button
                    class="reveal-btn"
                    type="button"
                    on:click={() => toggleReveal(k.name)}
                    title={revealed.has(k.name) ? 'Hide value' : 'Reveal value'}
                  >
                    {revealed.has(k.name) ? 'hide' : 'reveal'}
                  </button>
                {/if}
              </td>
              <td class="description">{k.description ?? ''}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

<style lang="scss">
  .config {
    max-width: 1400px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: calc(var(--grid-unit) * 2);
  }

  .page-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: calc(var(--grid-unit) * 2);

    h1 { margin: 0; }

    .subtitle {
      color: var(--color-text-dim);
      font-family: var(--font-mono);
      font-size: 0.875rem;
      margin: calc(var(--grid-unit) * 0.5) 0 0;
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
      vertical-align: top;
    }

    th {
      background: var(--color-background-dark);
      color: var(--color-primary);
      position: sticky;
      top: 0;
      white-space: nowrap;
    }

    tbody tr:last-child td { border-bottom: none; }
    tr:hover td { background: var(--color-surface-hover); }

    tr.secret td:first-child {
      border-left: 2px solid var(--color-warning);
    }

    code {
      color: var(--color-info);
      font-size: 0.875rem;
    }

    .badge {
      display: inline-block;
      margin-left: calc(var(--grid-unit) * 0.75);
      padding: 1px calc(var(--grid-unit) * 0.75);
      font-size: 0.7rem;
      color: var(--color-warning);
      border: 1px solid rgb(var(--color-warning-rgb, 250 200 50) / 0.5);
      border-radius: 999px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .type {
      color: var(--color-text-dim);
      font-size: 0.8rem;
    }

    .value {
      white-space: nowrap;
      display: flex;
      align-items: center;
      gap: var(--grid-unit);
    }

    .value-text {
      &.masked {
        color: var(--color-warning);
        letter-spacing: 0.1em;
      }
    }

    .reveal-btn {
      background: transparent;
      border: 1px solid var(--color-border);
      border-radius: var(--border-radius);
      color: var(--color-text-dim);
      padding: 2px calc(var(--grid-unit) * 1);
      font-family: var(--font-mono);
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      cursor: pointer;

      &:hover {
        color: var(--color-primary);
        border-color: var(--color-primary);
      }
    }

    .description {
      color: var(--color-text-dim);
      white-space: normal;
      max-width: 480px;
    }
  }
</style>
