/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

<script lang="ts">
  /**
   * Live Schema Diff (Bundle K — Disc-original feature #3a).
   *
   * Subscribes to `/admin/schema-watch` (SSE) and renders the
   * structured diff between the running server's applied schema and
   * whatever's currently in `dbschema/default.disc`. Click "Apply"
   * to POST `/admin/schema-apply` and run the migration through the
   * existing engine (lock_timeout + advisory lock + classification
   * gate compose for free).
   *
   * Gel-UI shows applied schema only; the operator switches to their
   * editor + CLI. Disc keeps the loop inside the admin UI.
   */
  import { onDestroy, onMount } from 'svelte';

  interface DiffPropertySnapshot {
    name: string;
    type: string;
    required: boolean;
    default?: string;
  }
  interface DiffLinkSnapshot {
    name: string;
    target: string;
    required: boolean;
    multi: boolean;
  }
  interface DiffTypeSnapshot {
    module: string;
    name: string;
    abstract: boolean;
    properties: DiffPropertySnapshot[];
    links: DiffLinkSnapshot[];
  }
  interface DiffPropertyChange {
    name: string;
    before: DiffPropertySnapshot;
    after: DiffPropertySnapshot;
  }
  interface DiffLinkChange {
    name: string;
    before: DiffLinkSnapshot;
    after: DiffLinkSnapshot;
  }
  interface DiffModifiedType {
    module: string;
    name: string;
    addedProperties: DiffPropertySnapshot[];
    removedProperties: DiffPropertySnapshot[];
    changedProperties: DiffPropertyChange[];
    addedLinks: DiffLinkSnapshot[];
    removedLinks: DiffLinkSnapshot[];
    changedLinks: DiffLinkChange[];
  }
  interface DiffParseError {
    source: 'applied' | 'onDisk';
    message: string;
    line?: number;
    column?: number;
  }
  interface SchemaDiffSummary {
    changed: boolean;
    added: DiffTypeSnapshot[];
    removed: DiffTypeSnapshot[];
    modified: DiffModifiedType[];
    errors: DiffParseError[];
  }

  let diff: SchemaDiffSummary | null = null;
  let connectionError: string | null = null;
  let connectionStatus: 'connecting' | 'live' | 'disconnected' = 'connecting';
  let lastUpdate: Date | null = null;
  let applying = false;
  let applyResult: string | null = null;
  let applyError: string | null = null;
  let forceApply = false;
  let eventSource: EventSource | null = null;

  const totalChanges = (d: SchemaDiffSummary | null) =>
    d ? d.added.length + d.removed.length + d.modified.length : 0;

  $: hasParseErrors = diff?.errors?.length ?? 0;

  function connect() {
    if (typeof EventSource === 'undefined') {
      connectionError = 'EventSource not available in this browser';
      connectionStatus = 'disconnected';
      return;
    }
    connectionStatus = 'connecting';
    eventSource = new EventSource('/admin/schema-watch');

    eventSource.addEventListener('snapshot', (e) => {
      try {
        diff = JSON.parse((e as MessageEvent).data);
        lastUpdate = new Date();
        connectionStatus = 'live';
      } catch (err) {
        connectionError = err instanceof Error ? err.message : String(err);
      }
    });
    eventSource.addEventListener('delta', (e) => {
      try {
        diff = JSON.parse((e as MessageEvent).data);
        lastUpdate = new Date();
      } catch (err) {
        connectionError = err instanceof Error ? err.message : String(err);
      }
    });
    eventSource.addEventListener('error', () => {
      connectionStatus = 'disconnected';
      connectionError = 'Lost connection to schema-watch stream';
    });
  }

  function disconnect() {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
  }

  async function applyMigration() {
    if (!diff || !diff.changed) return;
    applying = true;
    applyResult = null;
    applyError = null;
    try {
      const params = forceApply ? '?force=true' : '';

      const res = await fetch(`/admin/schema-apply${params}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      const body = await res.json();

      if (res.ok && body.ok)
        applyResult = `Applied ${body.applied?.length ?? 0} migration${body.applied?.length === 1 ? "" : "s"}`;
      else
        applyError = body.error || `HTTP ${res.status}`;
    } catch (err) {
      applyError = err instanceof Error ? err.message : String(err);
    } finally {
      applying = false;
    }
  }

  function formatTime(d: Date | null) {
    if (!d) return '—';
    return d.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  onMount(connect);
  onDestroy(disconnect);
</script>

<style lang="scss">
  @use "../../../styles/mixins" as *;

  .schema-diff {
    max-width: 1400px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: calc(var(--grid-unit) * 3);
  }

  .page-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: calc(var(--grid-unit) * 4);

    h1 {
      margin: 0 0 calc(var(--grid-unit) * 0.5) 0;
    }
    .subtitle {
      margin: 0;
      color: var(--color-text-dim);
      font-family: var(--font-mono);
      font-size: 0.875rem;

      code {
        color: var(--color-info);
      }
    }
  }

  .status {
    display: flex;
    align-items: center;
    gap: var(--grid-unit);
    padding: var(--grid-unit) calc(var(--grid-unit) * 1.5);
    border: 1px solid var(--color-border);
    border-radius: var(--border-radius);
    font-family: var(--font-mono);
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-text-dim);

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--color-warning, #ffaa00);
      animation: pulse 2s ease-in-out infinite;

      &[data-status='live'] { background: var(--color-success, #00ff88); }
      &[data-status='disconnected'] { background: var(--color-error, #ff4444); }
    }

    .last-update {
      margin-left: var(--grid-unit);
      opacity: 0.7;
    }
  }

  .banner {
    display: flex;
    align-items: flex-start;
    gap: var(--grid-unit);
    padding: calc(var(--grid-unit) * 1.5) calc(var(--grid-unit) * 2);
    border: 1px solid var(--color-border);
    border-radius: var(--border-radius);
    font-family: var(--font-mono);
    font-size: 0.875rem;

    .banner-icon { font-size: 1.25rem; }

    &.error {
      border-color: var(--color-error, #ff4444);
      color: var(--color-error, #ff4444);
      background: rgb(255 68 68 / 0.05);
    }
    &.warning {
      border-color: var(--color-warning, #ffaa00);
      color: var(--color-warning, #ffaa00);
      background: rgb(255 170 0 / 0.05);
      ul { margin: var(--grid-unit) 0 0 calc(var(--grid-unit) * 2); }
      .error-source { color: var(--color-text-dim); }
      .error-loc { color: var(--color-text-dim); }
    }
    &.clean {
      border-color: var(--color-success, #00ff88);
      color: var(--color-success, #00ff88);
      background: rgb(0 255 136 / 0.05);
    }
  }

  .apply-strip {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: calc(var(--grid-unit) * 2);
    padding: calc(var(--grid-unit) * 2);
    background: var(--color-surface);
    border: 1px solid var(--color-primary);
    border-radius: var(--border-radius);
    @include glow(var(--color-primary-rgb), 0.2);
  }

  .counts {
    display: flex;
    align-items: center;
    gap: calc(var(--grid-unit) * 2);
    font-family: var(--font-mono);

    .count {
      font-size: 1.25rem;
      font-weight: 700;

      &.count-added { color: var(--color-success, #00ff88); }
      &.count-modified { color: var(--color-warning, #ffaa00); }
      &.count-removed { color: var(--color-error, #ff4444); }
    }
    .count-label {
      color: var(--color-text-dim);
      font-size: 0.875rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
  }

  .apply-controls {
    display: flex;
    align-items: center;
    gap: calc(var(--grid-unit) * 2);
  }

  .force-toggle {
    display: flex;
    align-items: center;
    gap: var(--grid-unit);
    font-family: var(--font-mono);
    font-size: 0.75rem;
    color: var(--color-text-dim);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    cursor: pointer;
  }

  .apply-button {
    padding: calc(var(--grid-unit) * 1.5) calc(var(--grid-unit) * 3);
    background: rgb(var(--color-primary-rgb) / 0.15);
    color: var(--color-primary);
    border: 1px solid var(--color-primary);
    border-radius: var(--border-radius);
    font-family: var(--font-mono);
    font-size: 0.875rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    cursor: pointer;
    transition: all var(--transition-fast);

    &:hover:not(:disabled) {
      background: rgb(var(--color-primary-rgb) / 0.3);
      @include glow(var(--color-primary-rgb), 0.4);
    }
    &:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  }

  .diff-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: calc(var(--grid-unit) * 2);
  }

  .diff-card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--border-radius);
    overflow: hidden;
    display: flex;
    flex-direction: column;

    header {
      display: flex;
      align-items: center;
      gap: var(--grid-unit);
      padding: calc(var(--grid-unit) * 1.5) calc(var(--grid-unit) * 2);
      border-bottom: 1px solid var(--color-border);

      h3 {
        margin: 0;
        font-family: var(--font-mono);
        font-size: 1rem;
      }
    }
    .badge {
      font-family: var(--font-mono);
      font-size: 0.625rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      padding: 0.2em 0.5em;
      border-radius: 4px;
    }
    &.added {
      border-color: var(--color-success, #00ff88);
      .badge { background: rgb(0 255 136 / 0.2); color: var(--color-success, #00ff88); }
      h3 { color: var(--color-success, #00ff88); }
    }
    &.removed {
      border-color: var(--color-error, #ff4444);
      .badge { background: rgb(255 68 68 / 0.2); color: var(--color-error, #ff4444); }
      h3 { color: var(--color-error, #ff4444); }
    }
    &.modified {
      border-color: var(--color-warning, #ffaa00);
      .badge { background: rgb(255 170 0 / 0.2); color: var(--color-warning, #ffaa00); }
      h3 { color: var(--color-warning, #ffaa00); }
    }

    .card-body {
      padding: calc(var(--grid-unit) * 2);
      display: flex;
      flex-direction: column;
      gap: var(--grid-unit);
    }
    .meta {
      font-family: var(--font-mono);
      font-size: 0.75rem;
      color: var(--color-text-dim);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      code { color: var(--color-info); text-transform: none; }
    }
    .member {
      display: flex;
      justify-content: space-between;
      gap: var(--grid-unit);
      font-family: var(--font-mono);
      font-size: 0.8125rem;
      padding: calc(var(--grid-unit) * 0.5) 0;

      .member-key { color: var(--color-text); }
      .member-type { color: var(--color-info); }
      &.added { .member-key { color: var(--color-success, #00ff88); } }
      &.removed { .member-key { color: var(--color-error, #ff4444); } }
      &.changed { flex-direction: column; gap: calc(var(--grid-unit) * 0.5); }
      &.changed .member-key { color: var(--color-warning, #ffaa00); }
      .member-change {
        display: flex;
        gap: var(--grid-unit);
        align-items: center;
        font-size: 0.75rem;
        .before { color: var(--color-error, #ff4444); }
        .after { color: var(--color-success, #00ff88); }
        .arrow { color: var(--color-text-dim); }
      }
    }
    .group {
      border-top: 1px solid var(--color-border);
      padding-top: var(--grid-unit);
      margin-top: var(--grid-unit);
    }
    .group-label {
      font-family: var(--font-mono);
      font-size: 0.625rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--color-text-dim);
      margin-bottom: var(--grid-unit);
      &.group-added { color: var(--color-success, #00ff88); }
      &.group-removed { color: var(--color-error, #ff4444); }
      &.group-modified { color: var(--color-warning, #ffaa00); }
    }
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }
</style>

<div class="schema-diff">
  <header class="page-header">
    <div>
      <h1>Live Schema Diff</h1>
      <p class="subtitle">
        Watching <code>dbschema/default.disc</code> for changes.
      </p>
    </div>
    <div class="status">
      <span class="status-dot" data-status={connectionStatus}></span>
      <span class="status-label">{connectionStatus}</span>
      <span class="last-update">{formatTime(lastUpdate)}</span>
    </div>
  </header>

  {#if connectionError}
    <div class="banner error">
      <span class="banner-icon">⚠</span>
      <span>{connectionError}</span>
    </div>
  {/if}

  {#if hasParseErrors > 0 && diff}
    <div class="banner warning">
      <span class="banner-icon">⚠</span>
      <div>
        <strong>Schema file has {hasParseErrors} parse error{hasParseErrors === 1 ? '' : 's'}:</strong>
        <ul>
          {#each diff.errors as err}
            <li>
              <span class="error-source">[{err.source}]</span>
              {err.message}
              {#if err.line}<span class="error-loc"> (line {err.line})</span>{/if}
            </li>
          {/each}
        </ul>
      </div>
    </div>
  {/if}

  {#if diff && !diff.changed && hasParseErrors === 0}
    <div class="banner clean">
      <span class="banner-icon">✓</span>
      <span>Schema is in sync.</span>
    </div>
  {/if}

  {#if diff && diff.changed}
    <section class="apply-strip">
      <div class="counts">
        <span class="count count-added">+{diff.added.length}</span>
        <span class="count count-modified">~{diff.modified.length}</span>
        <span class="count count-removed">−{diff.removed.length}</span>
        <span class="count-label">{totalChanges(diff)} pending change{totalChanges(diff) === 1 ? '' : 's'}</span>
      </div>
      <div class="apply-controls">
        <label class="force-toggle">
          <input type="checkbox" bind:checked={forceApply} />
          <span>Force (allow unsafe / ambiguous)</span>
        </label>
        <button class="apply-button" on:click={applyMigration} disabled={applying}>
          {applying ? 'Applying…' : forceApply ? 'Force Apply' : 'Apply Migration'}
        </button>
      </div>
    </section>

    {#if applyResult}
      <div class="banner clean"><span class="banner-icon">✓</span><span>{applyResult}</span></div>
    {/if}
    {#if applyError}
      <div class="banner error"><span class="banner-icon">⚠</span><span>{applyError}</span></div>
    {/if}

    <div class="diff-grid">
      {#each diff.added as t}
        <article class="diff-card added">
          <header><span class="badge">+ added</span><h3>{t.name}</h3></header>
          <div class="card-body">
            <div class="meta">module: <code>{t.module}</code>{#if t.abstract} · <code>abstract</code>{/if}</div>
            {#each t.properties as p}
              <div class="member">
                <span class="member-key">{p.required ? 'required ' : ''}{p.name}</span>
                <span class="member-type">{p.type}</span>
              </div>
            {/each}
            {#each t.links as l}
              <div class="member link">
                <span class="member-key">link {l.required ? 'required ' : ''}{l.multi ? 'multi ' : ''}{l.name}</span>
                <span class="member-type">→ {l.target}</span>
              </div>
            {/each}
          </div>
        </article>
      {/each}

      {#each diff.removed as t}
        <article class="diff-card removed">
          <header><span class="badge">− removed</span><h3>{t.name}</h3></header>
          <div class="card-body">
            <div class="meta">module: <code>{t.module}</code></div>
            {#each t.properties as p}
              <div class="member">
                <span class="member-key">{p.required ? 'required ' : ''}{p.name}</span>
                <span class="member-type">{p.type}</span>
              </div>
            {/each}
          </div>
        </article>
      {/each}

      {#each diff.modified as t}
        <article class="diff-card modified">
          <header><span class="badge">~ modified</span><h3>{t.name}</h3></header>
          <div class="card-body">
            <div class="meta">module: <code>{t.module}</code></div>
            {#if t.addedProperties.length > 0}
              <div class="group">
                <div class="group-label group-added">added properties</div>
                {#each t.addedProperties as p}
                  <div class="member added"><span class="member-key">+ {p.required ? 'required ' : ''}{p.name}</span><span class="member-type">{p.type}</span></div>
                {/each}
              </div>
            {/if}
            {#if t.removedProperties.length > 0}
              <div class="group">
                <div class="group-label group-removed">removed properties</div>
                {#each t.removedProperties as p}
                  <div class="member removed"><span class="member-key">− {p.name}</span><span class="member-type">{p.type}</span></div>
                {/each}
              </div>
            {/if}
            {#if t.changedProperties.length > 0}
              <div class="group">
                <div class="group-label group-modified">changed properties</div>
                {#each t.changedProperties as c}
                  <div class="member changed">
                    <span class="member-key">~ {c.name}</span>
                    <span class="member-change">
                      <span class="before">{c.before.required ? 'required ' : ''}{c.before.type}</span>
                      <span class="arrow">→</span>
                      <span class="after">{c.after.required ? 'required ' : ''}{c.after.type}</span>
                    </span>
                  </div>
                {/each}
              </div>
            {/if}
            {#if t.addedLinks.length + t.removedLinks.length + t.changedLinks.length > 0}
              <div class="group">
                <div class="group-label">links</div>
                {#each t.addedLinks as l}
                  <div class="member added"><span class="member-key">+ link {l.required ? 'required ' : ''}{l.multi ? 'multi ' : ''}{l.name}</span><span class="member-type">→ {l.target}</span></div>
                {/each}
                {#each t.removedLinks as l}
                  <div class="member removed"><span class="member-key">− link {l.name}</span><span class="member-type">→ {l.target}</span></div>
                {/each}
                {#each t.changedLinks as c}
                  <div class="member changed">
                    <span class="member-key">~ link {c.name}</span>
                    <span class="member-change">
                      <span class="before">{c.before.required ? 'required ' : ''}{c.before.multi ? 'multi ' : ''}→ {c.before.target}</span>
                      <span class="arrow">→</span>
                      <span class="after">{c.after.required ? 'required ' : ''}{c.after.multi ? 'multi ' : ''}→ {c.after.target}</span>
                    </span>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        </article>
      {/each}
    </div>
  {/if}
</div>
