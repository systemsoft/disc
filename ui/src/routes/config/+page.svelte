<script lang="ts">
  /*** IMPORT ------------------------------------------- ***/

  import { onMount } from "svelte";

  /*** UTILITY ------------------------------------------ ***/

  import { discAPI, type ConfigKeyDef } from "$lib/api/client";

  // #5988 + #6444: the server returns each key's live PostgreSQL value in
  // `currentValue` (a SHOW/SELECT roundtrip through pg_settings), already
  // run through maskIfSecret() — so secret keys arrive as null and their
  // value never crosses the wire. We render the live value when present,
  // the mask for secrets, and a placeholder when no value is available
  // (no pool configured, or PostgreSQL exposes no setting for the key).
  const UNAVAILABLE_VALUE = "(unavailable)";
  const SECRET_HIDDEN = "(hidden by server)";
  const MASK = "••••••••";
  let configKeys: ConfigKeyDef[] = [];
  let loadError: string | null = null;
  let loading = true;
  let revealed = new Set<string>();

  // Inline edit state. Editing writes `ALTER SYSTEM SET` server-side and
  // reloads PostgreSQL config; the returned `currentValue` is patched into
  // the row. `editingKey` is the key.name currently open for editing.
  let editingKey: string | null = null;
  let editValue = "";
  let saving = false;
  let editError: string | null = null;
  let rowNotice = new Map<string, string>();

  /*** RUNTIME ------------------------------------------ ***/

  onMount(reload);

  /*** HELPER ------------------------------------------- ***/

  function displayValue(key: ConfigKeyDef): string {
    if (key.secret && !revealed.has(key.name))
      return MASK;

    // Live value from PostgreSQL. Secret keys are nulled server-side, so a
    // revealed secret falls through to SECRET_HIDDEN rather than real data.
    if (key.currentValue !== null && key.currentValue !== undefined)
      return key.currentValue;

    if (key.secret)
      return SECRET_HIDDEN;

    if (key.defaultValue !== undefined)
      return String(key.defaultValue);

    return UNAVAILABLE_VALUE;
  }

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

  function toggleReveal(name: string) {
    if (revealed.has(name))
      revealed.delete(name);
    else
      revealed.add(name);

    revealed = revealed; /*** trigger reactivity ***/
  }

  function startEdit(key: ConfigKeyDef) {
    editingKey = key.name;
    editError = null;
    editValue = key.currentValue ??
      (key.defaultValue !== undefined ? String(key.defaultValue) : "");
  }

  function cancelEdit() {
    editingKey = null;
    editError = null;
  }

  async function saveEdit(key: ConfigKeyDef) {
    saving = true;
    editError = null;

    const result = await discAPI.setConfig(key.name, editValue.trim());

    saving = false;

    if (result.error) {
      editError = result.error;
      return;
    }

    // Patch the live value into the row without a full reload.
    key.currentValue = result.currentValue ?? null;
    configKeys = configKeys; /*** trigger reactivity ***/

    rowNotice.set(
      key.name,
      result.pendingRestart ?
        "Saved — restart required before this takes effect" :
        "Saved"
    );
    rowNotice = rowNotice;
    editingKey = null;
  }
</script>

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
      /* color: var(--color-text-dim); */
      font-family: var(--font-mono);
      font-size: 0.875rem;
      margin: calc(var(--grid-unit) * 0.5) 0 0;
    }
  }

  .error-banner {
    padding: calc(var(--grid-unit) * 1.5) calc(var(--grid-unit) * 2);
    /* background: rgb(var(--color-danger-rgb) / 0.1); */
    /* border: 1px solid var(--color-danger); */
    /* border-radius: var(--border-radius); */
    /* color: var(--color-danger); */
    font-family: var(--font-mono);
    font-size: 0.875rem;
  }

  .empty {
    /* background: var(--color-surface); */
    /* border: 1px solid var(--color-border); */
    /* border-radius: var(--border-radius); */
    padding: calc(var(--grid-unit) * 4);
    text-align: center;

    h3 {
      font-size: 1rem;
      margin-bottom: calc(var(--grid-unit) * 2);
    }

    p {
      /* color: var(--color-text-dim); */
      font-family: var(--font-mono);
      font-size: 0.875rem;
    }
  }

  .table-wrap {
    overflow: auto;
    /* background: var(--color-surface); */
    /* border: 1px solid var(--color-border); */
    /* border-radius: var(--border-radius); */
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-family: var(--font-mono);
    font-size: 0.875rem;

    th, td {
      padding: calc(var(--grid-unit) * 1.5);
      text-align: left;
      /* border-bottom: 1px solid var(--color-border); */
      vertical-align: top;
    }

    th {
      /* background: var(--color-background-dark); */
      /* color: var(--color-primary); */
      position: sticky;
      top: 0;
      white-space: nowrap;
    }

    tbody tr:last-child td { border-bottom: none; }
    /* tr:hover td { background: var(--color-surface-hover); } */

    /* tr.secret td:first-child {
      border-left: 2px solid var(--color-warning);
    } */

    code {
      /* color: var(--color-info); */
      font-size: 0.875rem;
    }

    .badge {
      display: inline-block;
      margin-left: calc(var(--grid-unit) * 0.75);
      padding: 1px calc(var(--grid-unit) * 0.75);
      font-size: 0.7rem;
      /* color: var(--color-warning); */
      /* border: 1px solid rgb(var(--color-warning-rgb, 250 200 50) / 0.5); */
      /* border-radius: 999px; */
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .type {
      /* color: var(--color-text-dim); */
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
      /* background: transparent; */
      /* border: 1px solid var(--color-border); */
      /* border-radius: var(--border-radius); */
      /* color: var(--color-text-dim); */
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
      /* color: var(--color-text-dim); */
      white-space: normal;
      max-width: 480px;
    }

    .editor {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--grid-unit);
    }

    .edit-input {
      font-family: var(--font-mono);
      font-size: 0.875rem;
      padding: 2px calc(var(--grid-unit) * 1);
      min-width: 160px;
    }

    .edit-error {
      flex-basis: 100%;
      color: var(--color-danger);
      white-space: normal;
      font-size: 0.8rem;
    }

    .row-notice {
      color: var(--color-text-dim);
      font-size: 0.75rem;
      font-style: italic;
    }
  }
</style>

<svelte:head>
  <title>Disc Viewer &bull; Configuration</title>
</svelte:head>

<div class="config">
  <header class="page-header">
    <div>
      <h1>Configuration</h1>
      <p class="subtitle">
        CONFIGURE-able settings registry. Editing writes
        <code>ALTER SYSTEM SET</code> and reloads PostgreSQL; some settings
        need a restart to take effect. Secret values are masked.
      </p>
    </div>
    <button class="button" on:click={reload} disabled={loading}>
      {loading ? "Loading…" : "Refresh"}
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
                {#if editingKey === k.name}
                  <div class="editor">
                    <!-- svelte-ignore a11y-autofocus -->
                    <input
                      class="edit-input"
                      type="text"
                      autofocus
                      bind:value={editValue}
                      disabled={saving}
                      on:keydown={e => {
                        if (e.key === "Enter") saveEdit(k);
                        else if (e.key === "Escape") cancelEdit();
                      }}
                    />
                    <button
                      class="reveal-btn"
                      type="button"
                      on:click={() => saveEdit(k)}
                      disabled={saving}
                    >
                      {saving ? "saving…" : "save"}
                    </button>
                    <button
                      class="reveal-btn"
                      type="button"
                      on:click={cancelEdit}
                      disabled={saving}
                    >
                      cancel
                    </button>
                    {#if editError}
                      <span class="edit-error">{editError}</span>
                    {/if}
                  </div>
                {:else}
                  <span class="value-text" class:masked={k.secret && !revealed.has(k.name)}>
                    {displayValue(k)}
                  </span>
                  {#if k.secret}
                    <button
                      class="reveal-btn"
                      type="button"
                      on:click={() => toggleReveal(k.name)}
                      title={revealed.has(k.name) ? "Hide value" : "Reveal value"}
                    >
                      {revealed.has(k.name) ? "hide" : "reveal"}
                    </button>
                  {:else}
                    <button
                      class="reveal-btn"
                      type="button"
                      on:click={() => startEdit(k)}
                      title="Edit value (ALTER SYSTEM SET)"
                    >
                      edit
                    </button>
                  {/if}
                  {#if rowNotice.has(k.name)}
                    <span class="row-notice">{rowNotice.get(k.name)}</span>
                  {/if}
                {/if}
              </td>
              <td class="description">{k.description ?? ""}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>
