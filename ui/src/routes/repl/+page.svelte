<script lang="ts">
  /*** IMPORT ------------------------------------------- ***/

  import { onMount, tick } from "svelte";

  /*** UTILITY ------------------------------------------ ***/

  import { discAPI } from "$lib/api/client";

  /*** This is just a thin shell over /query — there is no separate /repl endpoint server-side.
       History persists per-browser; up/down arrows scroll through it like a real shell. ***/
  interface HistoryEntry {
    command: string;
    durationMs: number;
    error?: string;
    result?: string;
  }

  let command = "";
  let cursorIdx = -1;
  let executing = false;
  let history: HistoryEntry[] = [];
  let scrollEl: HTMLDivElement | null = null;

  /*** RUNTIME ------------------------------------------ ***/

  onMount(() => {
    const stored = localStorage.getItem("discReplHistory");

    if (stored) {
      try {
        history = JSON.parse(stored);
      } catch {
        history = [];
      }
    }
  });

  /*** HELPER ------------------------------------------- ***/

  function clearHistory() {
    history = [];
    persist();
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

  async function executeCommand() {
    const cmd = command.trim();

    if (!cmd || executing)
      return;

    executing = true;
    const result = await discAPI.executeQuery(cmd);
    executing = false;

    const entry: HistoryEntry = {
      command: cmd,
      durationMs: Math.round(result.durationMs),
    };

    if (result.error)
      entry.error = result.error;
    else
      entry.result = JSON.stringify(result.data, null, 2);

    history = [...history, entry];
    persist();
    command = "";
    cursorIdx = -1;
    await tick();

    if (scrollEl)
      scrollEl.scrollTop = scrollEl.scrollHeight;
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      executeCommand();

      return;
    }

    if (event.key === "ArrowUp") {
      const past = commandHistory();

      if (past.length === 0)
        return;

      event.preventDefault();
      cursorIdx = cursorIdx === -1 ? past.length - 1 : Math.max(0, cursorIdx - 1);
      command = past[cursorIdx];

      return;
    }

    if (event.key === "ArrowDown") {
      const past = commandHistory();

      if (past.length === 0 || cursorIdx === -1)
        return;

      event.preventDefault();

      if (cursorIdx >= past.length - 1) {
        cursorIdx = -1;
        command = "";
      } else {
        cursorIdx += 1;
        command = past[cursorIdx];
      }
    }
  }

  function persist() {
    /*** Cap stored history at 200 entries to avoid unbounded localStorage growth. ***/
    const trimmed = history.slice(-200);
    localStorage.setItem("discReplHistory", JSON.stringify(trimmed));
  }
</script>

<style lang="scss">
  .repl {
    display: flex;
    flex-direction: column;
    gap: calc(var(--grid-unit) * 2);
  }

  header {
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

  .repl-container {
    background-color: oklch(var(--uchu-gray-1-raw) / 50%);
    display: flex;
    flex-direction: column;
    height: calc(100vh - 250px);
  }

  .repl-history {
    flex: 1;
    font-family: var(--font-mono);
    font-size: 0.875rem;
    overflow-y: auto;
    padding: calc(var(--grid-unit) * 2);

    .history-item {
      margin-bottom: calc(var(--grid-unit) * 2);

      .command,
      .duration {
        color: var(--uchu-yin-3);
        user-select: none;
      }

      .command {
        margin-bottom: var(--grid-unit);
      }

      .duration,
      .error,
      .result {
        padding-left: 2ch;
      }

      .result {
        white-space: pre-wrap;
        word-break: break-word;
      }

      .error {
        color: var(--uchu-red-5);
      }

      .duration {
        font-size: 0.7rem;
        margin-top: var(--grid-unit);
      }
    }

    .empty {
      color: var(--color-text-dim);
      text-align: center;
      padding: calc(var(--grid-unit) * 4);
    }
  }

  .repl-input {
    align-items: center;
    background-color: var(--uchu-yin-9);
    display: flex;
    font-family: var(--font-mono);
    padding: calc(var(--grid-unit) * 2) calc(var(--grid-unit) * 3);

    .prompt {
      color: var(--uchu-blue-2);
      font-size: 0.875rem;
    }

    .command-input {
      background: transparent;
      border: none;
      color: var(--color-text);
      flex: 1;

      &:focus {
        outline: none;
      }

      &:disabled {
        opacity: 0.5;
      }
    }

    .spinner {
      color: var(--uchu-gray-3);
    }
  }
</style>

<svelte:head>
  <title>Disc &bull; REPL</title>
</svelte:head>

<div class="repl">
  <header>
    <h1>Interactive REPL</h1>
    <button class="button" disabled={history.length === 0} onclick={clearHistory}>Clear</button>
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
        <div class="empty">No history. Enter an EdgeQL statement below.</div>
      {/if}
    </div>

    <div class="repl-input">
      <label class="prompt" for="repl-input">disc&gt;</label>

      <input
        autocomplete="off"
        class="command-input"
        data-1p-ignore
        disabled={executing}
        id="repl-input"
        onkeydown={handleKeyDown}
        placeholder="select User {"{ name, email }"};"
        spellcheck="false"
        bind:value={command}/>

      {#if executing}
        <span class="spinner">&hellip;</span>
      {/if}
    </div>
  </div>
</div>
