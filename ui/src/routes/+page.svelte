<script lang="ts">
  /*** IMPORT ------------------------------------------- ***/

  import { onMount } from "svelte";

  /*** UTILITY ------------------------------------------ ***/

  import { discAPI } from "$lib/api/client";

  /*** Dashboard wired to real /stats, /schema, /migrations endpoints. "Total objects" was
       previously a fictional stat — there’s no efficient server-side count across every type.
       Replaced with "Migrations applied" which has a dedicated endpoint and is actually useful at a
       glance. Recent queries are read from `discQueryHistory` localStorage (shared with the query
       editor route) since there’s no server-side query log. ***/
  interface Stats {
    connections: number;
    migrations: number;
    queries: number;
    types: number;
  }

  let stats: Stats = {
    connections: 0,
    migrations: 0,
    queries: 0,
    types: 0
  };

  let databaseName = "";
  let errorMessage = "";
  let isLoading = true;
  let recentQueries: string[] = [];

  /*** RUNTIME ------------------------------------------ ***/

  onMount(async () => {
    if (typeof localStorage !== "undefined") {
      const history = localStorage.getItem("discQueryHistory");

      if (history) {
        try {
          const parsed = JSON.parse(history);

          if (Array.isArray(parsed))
            recentQueries = parsed.slice(0, 5);
        } catch {
          /*** Ignore malformed history ***/
        }
      }
    }

    try {
      const [serverStats, schema, migrations] = await Promise.all([
        discAPI.getStats(),
        discAPI.getSchema(),
        discAPI.getMigrations()
      ]);

      stats = {
        connections: serverStats?.connections?.active ?? 0,
        migrations: migrations?.length ?? 0,
        queries: serverStats?.queries?.total ?? 0,
        types: schema?.types?.length ?? 0
      };

      databaseName = serverStats?.database ?? "";
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : "Failed to load dashboard";
    } finally {
      isLoading = false;
    }
  });
</script>

<style lang="scss">
  @use "@inc/uchu/scss" as *;
  @use "../styles/mixins" as *;

  h1 {
    border-bottom: 1px solid $uchu-gray-1;
    line-height: 1;
    padding-bottom: calc(var(--grid-unit) * 2);

    .database-name {
      color: $uchu-yin-3;
      font-family: var(--font-mono);
      font-weight: 400;
      margin-left: var(--grid-unit);

      &::before {
        content: "·";
        margin-right: var(--grid-unit);
      }
    }
  }

  .error-banner {
    align-items: center;
    display: flex;
    font-family: var(--font-mono);
    font-size: 0.875rem;
    gap: var(--grid-unit);
    margin-bottom: calc(var(--grid-unit) * 3);
    padding: calc(var(--grid-unit) * 2);

    .error-icon {
      font-size: 1.25rem;
    }
  }

  .stats-grid {
    border-bottom: 1px solid $uchu-gray-1;
    display: grid;
    gap: calc(var(--grid-unit) * 3);
    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
    margin-bottom: calc(var(--grid-unit) * 6);

    &.is-loading .stat-value {
      opacity: 0.4;
    }
  }

  .stat-card {
    line-height: 1;
    overflow: hidden;
    padding: calc(var(--grid-unit) * 3) calc(var(--grid-unit) * 2);
    position: relative;
    transition: all var(--transition-fast);

    .stat-value {
      font-family: var(--font-display);
      font-size: 2rem;
      font-weight: 500;
    }

    .stat-label {
      font-family: var(--font-mono);
      font-size: 0.875rem;
      letter-spacing: 0.05rem;
      margin-top: var(--grid-unit);
      text-transform: uppercase;
    }

    .stat-icon {
      top: calc(var(--grid-unit) * 2); right: calc(var(--grid-unit) * 2);

      font-size: 3rem;
      opacity: 0.2;
      position: absolute;
    }
  }

  .content-grid {
    display: grid;
    gap: calc(var(--grid-unit) * 3);

    @media (min-width: 769px) {
      grid-template-columns: 1fr 1fr;
    }

    @media (max-width: 768px) {
      grid-template-columns: 1fr;
    }
  }

  section {
    h2 {
      font-size: 1.25rem;
      margin-bottom: calc(var(--grid-unit) * 2);
    }
  }

  .recent-queries {
    .query-list {
      padding: calc(var(--grid-unit) * 2);
    }

    .query-item {
      margin-bottom: var(--grid-unit);
      padding: calc(var(--grid-unit) * 1.5);
      transition: all var(--transition-fast);

      &:last-child {
        margin-bottom: 0;
      }

      code {
        font-size: 0.875rem;
      }
    }

    .empty-state {
      font-family: var(--font-mono);
      padding: calc(var(--grid-unit) * 4);
      text-align: center;
    }
  }

  .quick-actions {
    .action-grid {
      display: grid;
      gap: calc(var(--grid-unit) * 2);
      grid-template-columns: 1fr 1fr;
    }

    .action-card {
      align-items: center;
      display: flex;
      flex-direction: column;
      justify-content: center;
      padding: calc(var(--grid-unit) * 3);
      text-decoration: none;
      transition: all var(--transition-fast);

      &:hover {
        .action-icon {
          transform: scale(1.1);
        }
      }

      .action-icon {
        font-size: 2.5rem;
        margin-bottom: var(--grid-unit);
        transition: transform var(--transition-fast);
      }

      .action-label {
        font-family: var(--font-mono);
        font-size: 0.875rem;
        letter-spacing: 0.05rem;
        text-transform: uppercase;
      }
    }
  }
</style>

<div class="dashboard">
  <h1>
    Database Overview
    {#if databaseName}
      <span class="database-name">{databaseName}</span>
    {/if}
  </h1>

  {#if errorMessage}
    <div class="error-banner" role="alert">
      <span class="error-icon">⚠</span>
      <span>Could not load stats: {errorMessage}</span>
    </div>
  {/if}

  <div class="stats-grid" class:is-loading={isLoading}>
    <div class="stat-card">
      <div class="stat-value">{isLoading ? "—" : stats.types}</div>
      <div class="stat-label">Schema Types</div>
      <div class="stat-icon">◈</div>
    </div>

    <div class="stat-card">
      <div class="stat-value">{isLoading ? "—" : stats.migrations}</div>
      <div class="stat-label">Migrations Applied</div>
      <div class="stat-icon">▦</div>
    </div>

    <div class="stat-card">
      <div class="stat-value">{isLoading ? "—" : stats.connections}</div>
      <div class="stat-label">Active Connections</div>
      <div class="stat-icon">⟗</div>
    </div>

    <div class="stat-card">
      <div class="stat-value">{isLoading ? "—" : stats.queries.toLocaleString()}</div>
      <div class="stat-label">Queries (lifetime)</div>
      <div class="stat-icon">⟩</div>
    </div>
  </div>

  <div class="content-grid">
    <section class="quick-actions">
      <h2>Quick Actions</h2>

      <div class="action-grid">
        <a href="/ui/schema" class="action-card">
          <span class="action-icon">◈</span>
          <span class="action-label">Browse Schema</span>
        </a>

        <a href="/ui/query" class="action-card">
          <span class="action-icon">⟩</span>
          <span class="action-label">New Query</span>
        </a>

        <a href="/ui/data" class="action-card">
          <span class="action-icon">▦</span>
          <span class="action-label">View Data</span>
        </a>

        <a href="/ui/migrations" class="action-card">
          <span class="action-icon">⟲</span>
          <span class="action-label">Migrations</span>
        </a>
      </div>
    </section>

    <section class="recent-queries">
      <h2>Recent Queries</h2>

      <div class="query-list">
        {#each recentQueries as query}
          <div class="query-item">
            <code>{query}</code>
          </div>
        {/each}

        {#if recentQueries.length === 0}
          <div class="empty-state">No recent queries</div>
        {/if}
      </div>
    </section>
  </div>
</div>
