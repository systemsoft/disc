<script lang="ts">
  import { onMount, createEventDispatcher } from 'svelte';
  import { EditorView, basicSetup } from 'codemirror';
  import { EditorState, Compartment } from '@codemirror/state';
  import { sql } from '@codemirror/lang-sql';
  import { oneDark } from '@codemirror/theme-one-dark';
  import { keymap } from '@codemirror/view';

  export let value = '';
  export let onExecute: ((query: string) => void) | undefined = undefined;
  export let onChange: ((value: string) => void) | undefined = undefined;
  export let onFormat: (() => string) | undefined = undefined;
  export let loading = false;
  export let error: string | null = null;
  export let showHistory = false;
  export let history: any[] = [];
  export let autoComplete = true;
  export let suggestions: string[] = [];
  export let executionTime: number | null = null;
  export let multiTab = false;

  const dispatch = createEventDispatcher();

  let editorContainer: HTMLDivElement;
  let editor: EditorView;
  let activeTab = 0;
  let tabs = [{ id: 1, name: 'Query 1', query: value }];

  const executeKeymap = keymap.of([
    {
      key: 'Mod-Enter',
      run: () => {
        handleExecute();
        return true;
      }
    }
  ]);

  onMount(() => {
    const startState = EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        sql(),
        oneDark,
        executeKeymap,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const newValue = update.state.doc.toString();
            value = newValue;

            if (multiTab)
              tabs[activeTab].query = newValue;

            if (onChange)
              onChange(newValue);

            dispatch('change', newValue);
          }
        })
      ]
    });

    editor = new EditorView({
      state: startState,
      parent: editorContainer
    });

    return () => {
      editor.destroy();
    };
  });

  function handleExecute() {
    if (!loading && value.trim()) {
      if (onExecute)
        onExecute(value);

      dispatch('execute', value);

      // Add to history
      if (showHistory) {
        history = [{
          query: value,
          timestamp: new Date(),
          success: !error
        }, ...history.slice(0, 19)];
      }
    }
  }

  function handleFormat() {
    if (onFormat) {
      const formatted = onFormat();

      editor.dispatch({
        changes: {
          from: 0,
          to: editor.state.doc.length,
          insert: formatted
        }
      });

      value = formatted;
    }
  }

  function loadFromHistory(item: any) {
    editor.dispatch({
      changes: {
        from: 0,
        to: editor.state.doc.length,
        insert: item.query
      }
    });

    value = item.query;
  }

  function addTab() {
    const newId = Math.max(...tabs.map(t => t.id)) + 1;

    tabs = [...tabs, {
      id: newId,
      name: `Query ${newId}`,
      query: ''
    }];

    activeTab = tabs.length - 1;
    switchTab(activeTab);
  }

  function switchTab(index: number) {
    // Save current tab's query
    if (tabs[activeTab])
      tabs[activeTab].query = value;

    // Switch to new tab
    activeTab = index;
    const newQuery = tabs[index].query;

    editor.dispatch({
      changes: {
        from: 0,
        to: editor.state.doc.length,
        insert: newQuery
      }
    });

    value = newQuery;
  }

  function closeTab(index: number) {
    if (tabs.length > 1) {
      tabs = tabs.filter((_, i) => i !== index);

      if (activeTab >= tabs.length)
        activeTab = tabs.length - 1;

      switchTab(activeTab);
    }
  }
</script>

<div class="query-editor-container">
  {#if multiTab}
    <div class="tabs-bar">
      {#each tabs as tab, index}
        <button
          class="tab"
          class:active={activeTab === index}
          on:click={() => switchTab(index)}
        >
          {tab.name}
          {#if tabs.length > 1}
            <span class="close-tab" on:click|stopPropagation={() => closeTab(index)}>×</span>
          {/if}
        </button>
      {/each}
      <button class="add-tab" on:click={addTab} aria-label="New tab">+</button>
    </div>
  {/if}

  <div class="editor-wrapper">
    <div class="query-editor" bind:this={editorContainer}></div>

    <div class="editor-toolbar">
      <button
        class="execute-btn"
        on:click={handleExecute}
        disabled={loading || !value.trim()}
        aria-label="Execute query"
      >
        {#if loading}
          <span class="spinner">⟳</span>
          Executing...
        {:else}
          <span class="play-icon">▶</span>
          Execute
        {/if}
      </button>

      {#if onFormat}
        <button
          class="format-btn"
          on:click={handleFormat}
          aria-label="Format query"
        >
          <span class="format-icon">⊞</span>
          Format
        </button>
      {/if}

      <div class="toolbar-info">
        {#if executionTime !== null}
          <span class="execution-time">
            Executed in {executionTime}ms
          </span>
        {/if}

        <span class="shortcut-hint">
          {#if navigator.platform.includes('Mac')}Cmd{:else}Ctrl{/if}+Enter to run
        </span>
      </div>
    </div>

    {#if error}
      <div class="error-message">
        <span class="error-icon">⚠</span>
        {error}
      </div>
    {/if}
  </div>

  {#if showHistory && history.length > 0}
    <div class="history-panel">
      <h3 class="history-title">Query History</h3>
      <div class="history-list">
        {#each history as item}
          <button
            class="history-item"
            class:success={item.success}
            class:failed={!item.success}
            on:click={() => loadFromHistory(item)}
          >
            <span class="history-status">
              {item.success ? '✓' : '×'}
            </span>
            <div class="history-content">
              <div class="history-query">{item.query}</div>
              <div class="history-time">
                {new Date(item.timestamp).toLocaleTimeString()}
              </div>
            </div>
          </button>
        {/each}
      </div>
    </div>
  {/if}
</div>

<style lang="scss">
  @use "../../../styles/mixins" as *;
  @import '../../styles/component-base.scss';

  .query-editor-container {
    display: flex;
    gap: calc(var(--grid-unit) * 2);
    height: 100%;
  }

  .tabs-bar {
    display: flex;
    gap: var(--grid-unit);
    padding: var(--grid-unit);
    background: var(--color-surface);
    border-bottom: 1px solid var(--color-border);

    .tab {
      display: flex;
      align-items: center;
      gap: var(--grid-unit);
      padding: var(--grid-unit) calc(var(--grid-unit) * 2);
      background: transparent;
      border: 1px solid transparent;
      border-radius: var(--border-radius) var(--border-radius) 0 0;
      color: var(--color-text-dim);
      font-family: var(--font-mono);
      font-size: 0.875rem;
      transition: all var(--transition-fast);

      &:hover {
        background: rgb(var(--color-primary-rgb) / 0.05);
        color: var(--color-text);
      }

      &.active {
        background: var(--color-background);
        color: var(--color-primary);
        border-color: var(--color-border);
        border-bottom-color: var(--color-background);
      }

      .close-tab {
        display: inline-block;
        width: 16px;
        height: 16px;
        line-height: 14px;
        text-align: center;
        border-radius: 50%;
        transition: all var(--transition-fast);

        &:hover {
          background: rgb(var(--color-danger-rgb) / 0.2);
          color: var(--color-danger);
        }
      }
    }

    .add-tab {
      padding: var(--grid-unit);
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      border: 1px dashed var(--color-border);
      border-radius: var(--border-radius);
      color: var(--color-text-dim);
      font-size: 1.25rem;
      transition: all var(--transition-fast);

      &:hover {
        border-color: var(--color-primary);
        color: var(--color-primary);
        background: rgb(var(--color-primary-rgb) / 0.05);
      }
    }
  }

  .editor-wrapper {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .query-editor {
    flex: 1;
    border: 1px solid var(--color-border);
    border-radius: var(--border-radius);
    overflow: hidden;
    background: var(--color-surface);

    :global(.cm-editor) {
      height: 100%;

      &.cm-focused {
        outline: none;
        box-shadow: 0 0 0 1px var(--color-primary);
      }
    }

    :global(.cm-content) {
      font-family: var(--font-mono);
      font-size: 0.875rem;
      padding: calc(var(--grid-unit) * 2);
    }

    :global(.cm-line) {
      padding: 2px 0;
    }

    :global(.cm-autocomplete) {
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--border-radius);
      font-family: var(--font-mono);
      font-size: 0.875rem;
    }
  }

  .editor-toolbar {
    display: flex;
    align-items: center;
    gap: calc(var(--grid-unit) * 2);
    padding: calc(var(--grid-unit) * 2);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-top: none;
    border-radius: 0 0 var(--border-radius) var(--border-radius);

    .execute-btn,
    .format-btn {
      display: flex;
      align-items: center;
      gap: var(--grid-unit);
      padding: var(--grid-unit) calc(var(--grid-unit) * 2);
      border: 1px solid var(--color-border);
      border-radius: var(--border-radius);
      font-family: var(--font-mono);
      font-size: 0.875rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      transition: all var(--transition-fast);

      &:hover:not(:disabled) {
        border-color: var(--color-primary);
        color: var(--color-primary);
        background: rgb(var(--color-primary-rgb) / 0.1);
        @include glow(var(--color-primary-rgb), 0.2);
      }

      &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    }

    .execute-btn {
      background: rgb(var(--color-success-rgb) / 0.1);
      border-color: rgb(var(--color-success-rgb) / 0.3);
      color: var(--color-success);

      .play-icon {
        font-size: 0.75rem;
      }

      .spinner {
        animation: spin 1s linear infinite;
      }
    }

    .format-btn {
      color: var(--color-info);
      border-color: rgb(var(--color-info-rgb) / 0.3);
    }

    .toolbar-info {
      display: flex;
      align-items: center;
      gap: calc(var(--grid-unit) * 2);
      margin-left: auto;
      font-family: var(--font-mono);
      font-size: 0.75rem;
      color: var(--color-text-dim);

      .execution-time {
        color: var(--color-success);
        padding: 4px 8px;
        background: rgb(var(--color-success-rgb) / 0.1);
        border-radius: var(--border-radius);
      }
    }
  }

  .error-message {
    display: flex;
    align-items: center;
    gap: var(--grid-unit);
    margin-top: var(--grid-unit);
    padding: calc(var(--grid-unit) * 2);
    background: rgb(var(--color-danger-rgb) / 0.1);
    border: 1px solid rgb(var(--color-danger-rgb) / 0.3);
    border-radius: var(--border-radius);
    color: var(--color-danger);
    font-family: var(--font-mono);
    font-size: 0.875rem;

    .error-icon {
      font-size: 1.25rem;
    }
  }

  .history-panel {
    width: 300px;
    padding: calc(var(--grid-unit) * 2);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--border-radius);
    overflow-y: auto;

    .history-title {
      margin: 0 0 calc(var(--grid-unit) * 2);
      font-family: var(--font-mono);
      font-size: 0.875rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--color-text-dim);
    }

    .history-list {
      display: flex;
      flex-direction: column;
      gap: var(--grid-unit);
    }

    .history-item {
      display: flex;
      gap: var(--grid-unit);
      width: 100%;
      padding: var(--grid-unit);
      text-align: left;
      background: var(--color-background);
      border: 1px solid var(--color-border);
      border-radius: var(--border-radius);
      transition: all var(--transition-fast);

      &:hover {
        border-color: var(--color-primary);
        background: rgb(var(--color-primary-rgb) / 0.05);
      }

      .history-status {
        font-size: 1rem;

        &.success {
          color: var(--color-success);
        }

        &.failed {
          color: var(--color-danger);
        }
      }

      .history-content {
        flex: 1;
        min-width: 0;
      }

      .history-query {
        font-family: var(--font-mono);
        font-size: 0.75rem;
        color: var(--color-text);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .history-time {
        font-size: 0.625rem;
        color: var(--color-text-dim);
        margin-top: 4px;
      }
    }
  }

  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
</style>
