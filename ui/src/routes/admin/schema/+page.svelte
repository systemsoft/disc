<script lang="ts">
  /**
   * Live Schema Diff (Bundle K — Disc-original feature #3a).
   *
   * Subscribes to `/admin/schema-watch` (SSE) and renders the
   * structured diff between the running server’s applied schema and
   * whatever’s currently in `dbschema/default.disc`. Click "Apply"
   * to POST `/admin/schema-apply` and run the migration through the
   * existing engine (lock_timeout + advisory lock + classification
   * gate compose for free).
   *
   * Gel-UI shows applied schema only; the operator switches to their
   * editor + CLI. Disc keeps the loop inside the admin UI.
   */

  /*** IMPORT ------------------------------------------- ***/

  import { onDestroy, onMount } from "svelte";

  /*** UTILITY ------------------------------------------ ***/

  interface DiffPropertySnapshot {
    default?: string;
    name: string;
    required: boolean;
    type: string;
  }

  interface DiffLinkSnapshot {
    multi: boolean;
    name: string;
    required: boolean;
    target: string;
  }

  interface DiffTypeSnapshot {
    abstract: boolean;
    module: string;
    name: string;
    links: DiffLinkSnapshot[];
    properties: DiffPropertySnapshot[];
  }

  interface DiffPropertyChange {
    after: DiffPropertySnapshot;
    before: DiffPropertySnapshot;
    name: string;
  }

  interface DiffLinkChange {
    after: DiffLinkSnapshot;
    before: DiffLinkSnapshot;
    name: string;
  }

  interface DiffModifiedType {
    addedLinks: DiffLinkSnapshot[];
    addedProperties: DiffPropertySnapshot[];
    changedLinks: DiffLinkChange[];
    changedProperties: DiffPropertyChange[];
    module: string;
    name: string;
    removedLinks: DiffLinkSnapshot[];
    removedProperties: DiffPropertySnapshot[];
  }

  interface DiffParseError {
    column?: number;
    line?: number;
    message: string;
    source: "applied" | "onDisk";
  }

  interface SchemaDiffSummary {
    added: DiffTypeSnapshot[];
    changed: boolean;
    errors: DiffParseError[];
    modified: DiffModifiedType[];
    removed: DiffTypeSnapshot[];
  }

  const totalChanges = (d: SchemaDiffSummary | null) =>
    d ? d.added.length + d.removed.length + d.modified.length : 0;

  let applyError: string | null = null;
  let applying = false;
  let applyResult: string | null = null;
  let connectionError: string | null = null;
  let connectionStatus: "connecting" | "disconnected" | "live" = "connecting";
  let diff: SchemaDiffSummary | null = null;
  let eventSource: EventSource | null = null;
  let forceApply = false;
  let lastUpdate: Date | null = null;
  /*** Surfaces structured `error` frames from the SSE stream (e.g. "schema directory not found") so
       they render as a banner instead of looking like a dropped connection. ***/
  let serverNotice: string | null = null;

  /*** RUNTIME ------------------------------------------ ***/

  $: hasParseErrors = diff?.errors?.length ?? 0;

  onDestroy(disconnect);
  onMount(connect);

  /*** HELPER ------------------------------------------- ***/

  async function applyMigration() {
    if (!diff || !diff.changed)
      return;

    applying = true;
    applyResult = null;
    applyError = null;

    try {
      const params = forceApply ? "?force=true" : "";

      const res = await fetch(`/admin/schema-apply${params}`, {
        headers: { "Content-Type": "application/json" },
        method: "POST"
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

  function connect() {
    if (typeof EventSource === "undefined") {
      connectionError = "EventSource not available in this browser";
      connectionStatus = "disconnected";

      return;
    }

    connectionStatus = "connecting";
    eventSource = new EventSource("/admin/schema-watch");

    eventSource.addEventListener("snapshot", (e) => {
      try {
        diff = JSON.parse((e as MessageEvent).data);
        lastUpdate = new Date();
        connectionStatus = "live";
        serverNotice = null;
      } catch (err) {
        connectionError = err instanceof Error ? err.message : String(err);
      }
    });

    eventSource.addEventListener("delta", (e) => {
      try {
        diff = JSON.parse((e as MessageEvent).data);
        lastUpdate = new Date();
        serverNotice = null;
      } catch (err) {
        connectionError = err instanceof Error ? err.message : String(err);
      }
    });

    /*** Named `error` frames are application-level (missing schema dir, unreadable file, etc.) —
         the connection is fine, the server is just telling us it can’t compute a diff. Surface
         them as a banner instead of "lost connection". ***/
    eventSource.addEventListener("error", (e) => {
      const me = e as MessageEvent;

      if (me && typeof me.data === "string" && me.data.length > 0) {
        try {
          const payload = JSON.parse(me.data);
          serverNotice = payload?.message ?? "Schema watcher reported an error";
          connectionStatus = "live";

          return;
        } catch {
          /*** fall through to connection-loss handling ***/
        }
      }

      connectionStatus = "disconnected";
      connectionError = "Lost connection to schema-watch stream";
    });
  }

  function disconnect() {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
  }

  function formatTime(d: Date | null) {
    if (!d)
      return null;

    return d.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
  }
</script>

<style lang="scss">
  @use "../../../styles/mixins" as *;

  .schema-diff {
    display: flex;
    flex-direction: column;
    gap: calc(var(--grid-unit) * 3);
  }

  .page-header {
    align-items: center;
    display: flex;
    gap: calc(var(--grid-unit) * 4);
    justify-content: space-between;

    h1 {
      line-height: 1;
    }

    .subtitle {
      color: var(--uchu-yin-3);
      font-family: var(--font-mono);
      font-size: 0.875rem;
      margin: 0;

      code {
        color: var(--uchu-yin-7);
        position: relative;

        &::after {
          width: calc(100% + var(--grid-unit)); height: 100%;
          bottom: 0; left: calc(calc(var(--grid-unit)/2) * -1);

          background-color: var(--uchu-yellow-1);
          content: "";
          position: absolute;
          z-index: -1;
        }
      }
    }
  }

  .status {
    align-items: center;
    display: flex;
    font-family: var(--font-mono);
    font-size: 0.75rem;
    gap: var(--grid-unit);
    letter-spacing: 0.05rem;
    text-transform: uppercase;

    .status-dot {
      width: var(--grid-unit); height: var(--grid-unit);

      animation: pulse 2s ease-in-out infinite;
      border-radius: 50%;

      &:not([data-status="disconnected"]):not([data-status="live"]) {
        background-color: var(--uchu-orange-4);
      }

      &[data-status="disconnected"] {
        background-color: var(--uchu-red-4);
      }

      &[data-status="live"] {
        background-color: var(--uchu-green-4);
      }
    }

    .last-update {
      margin-left: var(--grid-unit);
      opacity: 0.7;
    }
  }

  .banner {
    align-items: flex-start;
    display: flex;
    font-family: var(--font-mono);
    font-size: 0.875rem;
    gap: var(--grid-unit);
    padding: calc(var(--grid-unit) * 1.5) calc(var(--grid-unit) * 2);

    &.clean {
      background-color: oklch(var(--uchu-green-1-raw) / 20%);
      border: 1px solid var(--uchu-green-1);
      color: var(--uchu-green-5);
    }

    &.error {
      background-color: oklch(var(--uchu-red-1-raw) / 20%);
      border: 1px solid var(--uchu-red-1);
      color: var(--uchu-red-5);
    }

    &.warning {
      background-color: oklch(var(--uchu-orange-1-raw) / 20%);
      border: 1px solid var(--uchu-orange-1);
      color: var(--uchu-orange-5);

      ul {
        margin: var(--grid-unit) 0 0 calc(var(--grid-unit) * 2);
      }
    }
  }

  .apply-strip {
    /* @include glow(var(--color-primary-rgb), 0.2); */
    align-items: center;
    border: 1px solid var(--uchu-gray-1);
    background-color: oklch(var(--uchu-gray-1-raw) / 30%);
    display: flex;
    gap: calc(var(--grid-unit) * 2);
    justify-content: space-between;
    padding: calc(var(--grid-unit) * 2);
  }

  .counts {
    align-items: center;
    display: flex;
    font-family: var(--font-mono);
    gap: calc(var(--grid-unit) * 2);

    .count {
      font-size: 1.25rem;
      font-weight: 700;

      &.count-added {
        color: var(--uchu-green-4);
      }

      &.count-modified {
        color: var(--uchu-orange-4);
      }

      &.count-removed {
        color: var(--uchu-red-4);
      }
    }

    .count-label {
      color: var(--uchu-yin-3);
      font-size: 0.875rem;
      letter-spacing: 0.05rem;
      text-transform: uppercase;
    }
  }

  .apply-controls {
    align-items: center;
    display: flex;
    gap: calc(var(--grid-unit) * 2);
  }

  .force-toggle {
    align-items: center;
    cursor: pointer;
    display: flex;
    font-family: var(--font-mono);
    font-size: 0.75rem;
    gap: var(--grid-unit);
    letter-spacing: 0.05em;
    text-transform: uppercase;

    input[type="checkbox"] {
      width: calc(var(--grid-unit) * 1.75); height: calc(var(--grid-unit) * 1.75);

      background-position: center;
      background-repeat: no-repeat;
      background-size: calc(var(--grid-unit) * 2);
      border-radius: 0;
      padding: 0;

      &:checked {
        background-image: url("data:image/svg+xml,<svg viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M17.2835 7.51131L11.0738 17.4468L6.68933 13.0623L7.74999 12.0016L10.8012 15.0528L16.0115 6.71631L17.2835 7.51131Z\"/></svg>");
      }
    }
  }

  .apply-button {
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: 0.875rem;
    letter-spacing: 0.1rem;
    text-transform: uppercase;

    /* &:hover:not(:disabled) {
      @include glow(var(--color-primary-rgb), 0.4);
    } */

    &:disabled {
      cursor: not-allowed;
      opacity: 0.5;
    }

    &.force {
      background-color: var(--uchu-red-4);
      color: var(--uchu-yang);
    }
  }

  .diff-grid {
    display: grid;
    gap: calc(var(--grid-unit) * 2);
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  }

  .diff-card {
    border: 1px solid;
    border-color: var(--uchu-gray-1);
    display: flex;
    flex-direction: column;
    overflow: hidden;

    header {
      align-items: center;
      background-color: oklch(var(--uchu-gray-1-raw) / 50%);
      border-bottom: 1px solid var(--uchu-gray-1);
      display: flex;
      flex-direction: row-reverse;
      gap: var(--grid-unit);
      justify-content: space-between;
      padding: var(--grid-unit) calc(var(--grid-unit) * 2);

      h3 {
        font-family: var(--font-mono);
        font-size: 0.875rem;
        letter-spacing: normal;
        margin: 0;

        span {
          color: var(--uchu-yin-3);
        }
      }
    }

    .badge {
      font-family: var(--font-mono);
      font-size: 0.625rem;
      letter-spacing: 0.05rem;
      padding: calc(var(--grid-unit) / 4) var(--grid-unit);
      text-transform: uppercase;
    }

    &.added {
      .badge {
        background-color: oklch(var(--uchu-green-2-raw) / 50%);
        color: var(--uchu-green-9);
      }
    }

    &.removed {
      .badge {
        background-color: oklch(var(--uchu-red-2-raw) / 50%);
        color: var(--uchu-red-9);
      }
    }

    &.modified {
      .badge {
        background-color: oklch(var(--uchu-orange-2-raw) / 50%);
        color: var(--uchu-orange-9);
      }
    }

    .card-body {
      display: flex;
      flex-direction: column;
      padding: calc(var(--grid-unit) * 2);
    }

    .member {
      display: flex;
      font-family: var(--font-mono);
      font-size: 0.8125rem;
      justify-content: space-between;
      white-space: nowrap;

      &:not(.added):not(.changed):not(.removed) {
        .member-key {
          color: var(--uchu-yin-3);
        }
      }

      .member-key {
        overflow: hidden;
        text-overflow: ellipsis;
        width: 100%;
      }

      .member-type {
        color: var(--uchu-blue-3);
        flex: 1;
        margin-left: var(--grid-unit);
        white-space: nowrap;
        width: 100%;
      }

      &.added {
        .member-key {
          color: var(--uchu-green-5);
        }
      }

      &.changed {
        flex-direction: column;

        .member-key {
          color: var(--uchu-orange-5);
        }
      }

      &.removed {
        .member-key {
          color: var(--uchu-red-5);
        }
      }

      .multi,
      .required {
        margin-right: 1ch;
        text-transform: uppercase;
      }

      .multi {
        color: var(--uchu-yellow-6);
      }

      .required {
        color: var(--uchu-red-5);
      }

      .member-change {
        align-items: center;
        display: flex;
        gap: var(--grid-unit);
        margin-left: 2ch;

        .after {
          color: var(--uchu-green-5);
        }

        .arrow {
          color: var(--uchu-yin-3);
        }

        .before {
          color: var(--uchu-red-5);
        }
      }
    }

    .group-label {
      font-family: var(--font-display);
      font-size: 0.575rem;
      letter-spacing: 0.1rem;
      line-height: 1;
      margin-bottom: var(--grid-unit);
      position: relative;
      text-transform: uppercase;
      user-select: none;

      &::after {
        width: calc(100% - (var(--ch) + 2.5ch)); height: 1px;
        bottom: 1.5px; right: 0;

        background-color: var(--uchu-gray-1);
        content: "";
        position: absolute;
        z-index: -1;
      }

      &.group-added {
        color: var(--uchu-green-4);
      }

      &.group-modified {
        color: var(--uchu-orange-4);
      }

      &.group-removed {
        color: var(--uchu-red-4);
      }
    }
  }

  @keyframes pulse {
    0%, 100% {
      opacity: 1;
    }

    50% {
      opacity: 0.5;
    }
  }
</style>

<svelte:head>
  <title>Disc Viewer &bull; Diff</title>
</svelte:head>

<div class="schema-diff">
  <header class="page-header">
    <div>
      <h1>Live Schema Diff</h1>
      <p class="subtitle">Watching <code>dbschema/default.disc</code> for changes.</p>
    </div>

    <div class="status">
      <span class="status-dot" data-status={connectionStatus}></span>
      <span class="status-label">{connectionStatus}</span>
      {#if formatTime(lastUpdate)}
        <span class="last-update">{formatTime(lastUpdate)}</span>
      {/if}
    </div>
  </header>

  {#if connectionError}
    <div class="banner error">
      <span>{connectionError}</span>
    </div>
  {/if}

  {#if serverNotice}
    <div class="banner warning">
      <span class="banner-icon">⚠</span>
      <span>{serverNotice}</span>
    </div>
  {/if}

  {#if hasParseErrors > 0 && diff}
    <div class="banner warning">
      <span class="banner-icon">⚠</span>

      <div>
        <strong>Schema file has {hasParseErrors} parse error{hasParseErrors === 1 ? "" : "s"}:</strong>

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
        <span class="count-label">{totalChanges(diff)} pending change{totalChanges(diff) === 1 ? "" : "s"}</span>
      </div>

      <div class="apply-controls">
        <label class="force-toggle">
          <input bind:checked={forceApply} type="checkbox"/>
          <span>Force (allow unsafe / ambiguous)</span>
        </label>

        <button
          class="apply-button"
          class:force={forceApply}
          disabled={applying}
          onclick={applyMigration}>
          {applying ? "Applying…" : forceApply ? "Force Migration" : "Apply Migration"}
        </button>
      </div>
    </section>

    {#if applyResult}
      <div class="banner clean">
        <span class="banner-icon">✓</span>
        <span>{applyResult}</span>
      </div>
    {/if}

    {#if applyError}
      <div class="banner error">
        <span class="banner-icon">⚠</span>
        <span>{applyError}</span>
      </div>
    {/if}

    <div class="diff-grid">
      {#each diff.added as t}
        <article class="diff-card added">
          <header>
            <span class="badge">+ added</span>
            <h3><span>{t.module}::</span>{t.name}</h3>
          </header>

          <div class="card-body">
            <!-- <div class="meta">module: <code>{t.module}</code>{#if t.abstract} · <code>abstract</code>{/if}</div> -->

            {#each t.properties as p}
              <div class="member">
                <span class="member-key">{#if p.required}<span class="required">required</span>{/if}{p.name}</span>
                <span class="member-type">{p.type}</span>
              </div>
            {/each}

            {#each t.links as l}
              <div class="member link">
                <span class="member-key">link {#if l.required}<span class="required">required</span>{/if}{#if l.multi}<span class="multi">multi</span>{/if}{l.name}</span>
                <span class="member-type">→ {l.target}</span>
              </div>
            {/each}
          </div>
        </article>
      {/each}

      {#each diff.removed as t}
        <article class="diff-card removed">
          <header>
            <span class="badge">− removed</span>
            <h3><span>{t.module}::</span>{t.name}</h3>
          </header>

          <div class="card-body">
            {#each t.properties as p}
              <div class="member">
                <span class="member-key">{#if p.required}<span class="required">required</span>{/if}{p.name}</span>
                <span class="member-type">{p.type}</span>
              </div>
            {/each}
          </div>
        </article>
      {/each}

      {#each diff.modified as t}
        <article class="diff-card modified">
          <header>
            <span class="badge">~ modified</span>
            <h3><span>{t.module}::</span>{t.name}</h3>
          </header>

          <div class="card-body">
            {#if t.addedProperties.length > 0}
              <div class="group">
                <div class="group-label group-added" style="--ch: 5ch;">added</div>

                {#each t.addedProperties as p}
                  <div class="member added">
                    <span class="member-key">+ {#if p.required}<span class="required">required</span>{/if}{p.name}</span>
                    <span class="member-type">{p.type}</span>
                  </div>
                {/each}
              </div>
            {/if}

            {#if t.removedProperties.length > 0}
              <div class="group">
                <div class="group-label group-removed" style="--ch: 7ch;">removed</div>

                {#each t.removedProperties as p}
                  <div class="member removed">
                    <span class="member-key">− {p.name}</span>
                    <span class="member-type">{p.type}</span>
                  </div>
                {/each}
              </div>
            {/if}

            {#if t.changedProperties.length > 0}
              <div class="group">
                <div class="group-label group-modified" style="--ch: 7ch;">changed</div>

                {#each t.changedProperties as c}
                  <div class="member changed">
                    <span class="member-key">~ {c.name}</span>

                    <span class="member-change">
                      <span class="before">{#if c.before.required}<span class="required">required</span>{/if}{c.before.type}</span>
                      <span class="arrow">→</span>
                      <span class="after">{#if c.after.required}<span class="required">required</span>{/if}{c.after.type}</span>
                    </span>
                  </div>
                {/each}
              </div>
            {/if}

            {#if t.addedLinks.length + t.removedLinks.length + t.changedLinks.length > 0}
              <div class="group">
                <div class="group-label" style="--ch: 5ch;">links</div>

                {#each t.addedLinks as l}
                  <div class="member added">
                    <span class="member-key">+ link {#if l.required}<span class="required">required</span>{/if}{#if l.multi}<span class="multi">multi</span>{/if}{l.name}</span>
                    <span class="member-type">→ {l.target}</span>
                  </div>
                {/each}

                {#each t.removedLinks as l}
                  <div class="member removed">
                    <span class="member-key">− link {l.name}</span>
                    <span class="member-type">→ {l.target}</span>
                  </div>
                {/each}

                {#each t.changedLinks as c}
                  <div class="member changed">
                    <span class="member-key">~ link {c.name}</span>

                    <span class="member-change">
                      <span class="before">{#if c.before.required}<span class="required">required</span>{/if}{#if c.before.multi}<span class="multi">multi</span>{/if} {c.before.target}</span>
                      <span class="arrow">→</span>
                      <span class="after">{#if c.after.required}<span class="required">required</span>{/if}{#if c.after.multi}<span class="multi">multi</span>{/if} {c.after.target}</span>
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
