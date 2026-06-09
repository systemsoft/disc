<script lang="ts">
  /*** IMPORT ------------------------------------------- ***/

  import { onMount } from "svelte";

  /*** UTILITY ------------------------------------------ ***/

  import { discAPI, type ConfigKeyDef } from "$lib/api/client";

  const MASK = "••••••••";
  const SECRET_HIDDEN = "(hidden by server)";
  const UNAVAILABLE_VALUE = "(unavailable)";
  let configKeys: ConfigKeyDef[] = [];
  let editError: string | null = null;
  /*** Inline edit state. Editing writes `ALTER SYSTEM SET` server-side and reloads PostgreSQL
       config; the returned `currentValue` is patched into the row. `editingKey` is the key.name
       currently open for editing. ***/
  let editingKey: string | null = null;
  let editValue = "";
  let loadError: string | null = null;
  let loading = true;
  let revealed = new Set<string>();
  let rowNotice = new Map<string, string>();
  let saving = false;

  /*** RUNTIME ------------------------------------------ ***/

  onMount(reload);

  /*** HELPER ------------------------------------------- ***/

  function cancelEdit() {
    editingKey = null;
    editError = null;
  }

  function displayValue(key: ConfigKeyDef): string {
    if (key.secret && !revealed.has(key.name))
      return MASK;

    /*** Live value from PostgreSQL. Secret keys are nulled server-side, so a revealed secret falls
         through to SECRET_HIDDEN rather than real data. ***/
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

  async function saveEdit(key: ConfigKeyDef) {
    saving = true;
    editError = null;

    const result = await discAPI.setConfig(key.name, editValue.trim());
    saving = false;

    if (result.error) {
      editError = result.error;
      return;
    }

    /*** Patch the live value into the row without a full reload. ***/
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

  function startEdit(key: ConfigKeyDef) {
    editingKey = key.name;
    editError = null;
    editValue = key.currentValue ?? (key.defaultValue !== undefined ? String(key.defaultValue) : "");
  }

  function toggleReveal(name: string) {
    if (revealed.has(name))
      revealed.delete(name);
    else
      revealed.add(name);

    revealed = revealed; /*** trigger reactivity ***/
  }
</script>

<style lang="scss">
  .config {
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

    .subtitle {
      color: var(--uchu-yin-3);
      font-family: var(--font-mono);
      font-size: 0.875rem;
      line-height: 1.33;
      margin-top: var(--grid-unit);
      max-width: 100ch;
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
        background-color: oklch(var(--uchu-yellow-1-raw) / 30%);
      }

      &:not(.editing):hover {
        background-color: var(--uchu-gray-1);
      }

      td {
        padding: calc(var(--grid-unit) / 2) var(--grid-unit);
      }
    }

    tr.secret td:first-child {
      border-left: 2px solid var(--uchu-red-4);
    }

    .badge {
      display: inline-block;
      margin-left: calc(var(--grid-unit) * 0.75);
      padding: 1px calc(var(--grid-unit) * 0.75);
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .value {
      align-items: center;
      display: flex;
      gap: var(--grid-unit);
      white-space: nowrap;
      width: 200px;
    }

    .value-text {
      &.masked {
        color: var(--color-warning);
        letter-spacing: 0.1em;
      }
    }

    .reveal-btn {
      font-size: 0.7rem;
      padding: calc(var(--grid-unit) / 4) var(--grid-unit);
      text-transform: uppercase;
    }

    .description {
      max-width: 480px;
      white-space: normal;
    }

    .editor {
      align-items: baseline;
      display: flex;
      flex-direction: column;
      flex-wrap: wrap;
      gap: var(--grid-unit);

      .edit-input {
        font-family: var(--font-mono);
        font-size: inherit;
        min-width: 160px;
        padding: 2px calc(var(--grid-unit) * 1);
        width: 100%;
      }
    }

    .edit-error {
      color: var(--uchu-red-5);
      flex-basis: 100%;
      font-size: 0.8rem;
      white-space: normal;
    }

    .row-notice {
      color: var(--uchu-yin-3);
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
      <p class="subtitle">CONFIGURE-able settings registry. Editing writes <code>ALTER SYSTEM SET</code> and reloads PostgreSQL; some settings need a restart to take effect. Secret values are masked.</p>
    </div>

    <button
      class="button"
      disabled={loading}
      onclick={reload}>
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
            <tr class:secret={k.secret} class:editing={editingKey === k.name}>
              <td>
                <code>{k.name}</code>

                {#if k.secret}
                  <span class="badge" title="Marked secret — value is masked">[secret]</span>
                {/if}
              </td>

              <td><span class="type">{k.edgeqlType}</span></td>

              <td>{k.defaultScope}</td>

              <td class="value">
                {#if editingKey === k.name}
                  <div class="editor">
                    <!-- svelte-ignore a11y-autofocus -->
                    <input
                      autofocus
                      class="edit-input"
                      disabled={saving}
                      onkeydown={e => {
                        if (e.key === "Enter")
                          saveEdit(k);
                        else if (e.key === "Escape")
                          cancelEdit();
                      }}
                      type="text"
                      bind:value={editValue}
                    />

                    <div class="editor-actions">
                      <button
                        class="reveal-btn"
                        disabled={saving}
                        onclick={() => saveEdit(k)}
                        type="button">
                        {saving ? "saving…" : "save"}
                      </button>

                      <button
                        class="reveal-btn"
                        disabled={saving}
                        onclick={cancelEdit}
                        type="button">
                        cancel
                      </button>
                    </div>

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
                      onclick={() => toggleReveal(k.name)}
                      title={revealed.has(k.name) ? "Hide value" : "Reveal value"}
                      type="button">
                      {revealed.has(k.name) ? "hide" : "reveal"}
                    </button>
                  {:else}
                    <button
                      class="reveal-btn"
                      onclick={() => startEdit(k)}
                      title="Edit value (ALTER SYSTEM SET)"
                      type="button">
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
