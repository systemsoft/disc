/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { discAPI } from '$lib/api/client';

  // P1-23: REPL is just a thin shell over /query — there is no separate
  // /repl endpoint server-side. History persists per-browser; up/down
  // arrows scroll through it like a real shell.
  interface HistoryEntry {
    command: string;
    result?: string;
    error?: string;
    durationMs: number;
  }

  let command = '';
  let history: HistoryEntry[] = [];
  let cursorIdx = -1;
  let executing = false;
  let scrollEl: HTMLDivElement | null = null;

  onMount(() => {
    const stored = localStorage.getItem('discReplHistory');
    if (stored) {
      try {
        history = JSON.parse(stored);
      } catch {
        history = [];
      }
    }
  });

  function persist() {
    // Cap stored history at 200 entries to avoid unbounded localStorage growth.
    const trimmed = history.slice(-200);
    localStorage.setItem('discReplHistory', JSON.stringify(trimmed));
  }

  async function executeCommand() {
    const cmd = command.trim();
    if (!cmd || executing) return;

    executing = true;
    const result = await discAPI.executeQuery(cmd);
    executing = false;

    const entry: HistoryEntry = {
      command: cmd,
      durationMs: Math.round(result.durationMs),
    };
    if (result.error) {
      entry.error = result.error;
    } else {
      entry.result = JSON.stringify(result.data, null, 2);
    }
    history = [...history, entry];
    persist();
    command = '';
    cursorIdx = -1;
    await tick();
    if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
  }

  function commandHistory(): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const h of history) {
      if (!seen.has(h.command)) {
        seen.add(h.command);
        out.push(h.command);
      }
    }
    return out;
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      executeCommand();
      return;
    }
    if (event.key === 'ArrowUp') {
      const past = commandHistory();
      if (past.length === 0) return;
      event.preventDefault();
      cursorIdx = cursorIdx === -1 ? past.length - 1 : Math.max(0, cursorIdx - 1);
      command = past[cursorIdx];
      return;
    }
    if (event.key === 'ArrowDown') {
      const past = commandHistory();
      if (past.length === 0 || cursorIdx === -1) return;
      event.preventDefault();
      if (cursorIdx >= past.length - 1) {
        cursorIdx = -1;
        command = '';
      } else {
        cursorIdx += 1;
        command = past[cursorIdx];
      }
    }
  }

  function clearHistory() {
    history = [];
    persist();
  }
</script>

<div class="repl">
  <header>
    <h1>Interactive REPL</h1>
    <button class="button" on:click={clearHistory} disabled={history.length === 0}>
      Clear
    </button>
  </header>

  <div class="repl-container">
    <div class="repl-history" bind:this={scrollEl}>
      {#each history as item}
        <div class="history-item">
          <div class="command">disc&gt; {item.command}</div>
          {#if item.error}
            <div class="error">! {item.error}</div>
          {:else}
            <pre class="result">{item.result}</pre>
          {/if}
          <div class="duration">{item.durationMs}ms</div>
        </div>
      {/each}
      {#if history.length === 0}
        <div class="empty">No history. Enter an EdgeQL statement below.</div>
      {/if}
    </div>

    <div class="repl-input">
      <span class="prompt">disc&gt;</span>
      <input
        bind:value={command}
        on:keydown={handleKeyDown}
        placeholder="select User {'{ name, email }'};"
        class="command-input"
        disabled={executing}
      />
      {#if executing}
        <span class="spinner">...</span>
      {/if}
    </div>
  </div>
</div>

<style lang="scss">
  .repl {
    max-width: 1400px;
    margin: 0 auto;

    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: calc(var(--grid-unit) * 2);
    }
  }

  .repl-container {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--border-radius);
    height: calc(100vh - 250px);
    display: flex;
    flex-direction: column;
  }

  .repl-history {
    flex: 1;
    overflow-y: auto;
    padding: calc(var(--grid-unit) * 2);
    font-family: var(--font-mono);
    font-size: 0.875rem;

    .history-item {
      margin-bottom: calc(var(--grid-unit) * 2);

      .command {
        color: var(--color-info);
        margin-bottom: var(--grid-unit);
      }

      .result {
        margin: 0;
        padding-left: calc(var(--grid-unit) * 2);
        color: var(--color-success);
        white-space: pre-wrap;
        word-break: break-word;
      }

      .error {
        padding-left: calc(var(--grid-unit) * 2);
        color: var(--color-danger);
      }

      .duration {
        padding-left: calc(var(--grid-unit) * 2);
        color: var(--color-text-dim);
        font-size: 0.7rem;
        margin-top: calc(var(--grid-unit) * 0.5);
      }
    }

    .empty {
      color: var(--color-text-dim);
      text-align: center;
      padding: calc(var(--grid-unit) * 4);
    }
  }

  .repl-input {
    display: flex;
    align-items: center;
    gap: var(--grid-unit);
    padding: calc(var(--grid-unit) * 2);
    border-top: 1px solid var(--color-border);
    background: var(--color-background-dark);

    .prompt {
      color: var(--color-primary);
      font-family: var(--font-mono);
      font-weight: bold;
    }

    .command-input {
      flex: 1;
      background: transparent;
      border: none;
      color: var(--color-text);
      font-family: var(--font-mono);
      font-size: 0.875rem;

      &:focus { outline: none; }
      &:disabled { opacity: 0.5; }
    }

    .spinner {
      color: var(--color-text-dim);
      font-family: var(--font-mono);
    }
  }
</style>
