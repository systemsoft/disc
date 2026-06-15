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
    line-height: 1;
    padding-bottom: calc(var(--grid-unit) * 2);

    .database-name {
      color: var(--uchu-yin-3);
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
  }

  .stats-grid {
    display: grid;
    gap: calc(var(--grid-unit) * 3);
    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
    margin-bottom: calc(var(--grid-unit) * 4);

    &.is-loading .stat-value {
      opacity: 0.4;
    }
  }

  .stat-card {
    border: 1px solid var(--uchu-gray-1);
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

  .recent-queries {
    .query-item {
      background-color: oklch(var(--uchu-gray-1-raw) / 50%);
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
      border: 1px solid var(--uchu-gray-1);
      color: currentColor;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      justify-content: center;
      padding: calc(var(--grid-unit) * 2);
      text-decoration: none;
      transition: all var(--transition-fast);

      &:hover {
        .action-icon {
          transform: scale(1.1);
        }
      }

      .action-icon {
        width: 3rem; height: 3rem;

        line-height: 1;
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

<svelte:head>
  <title>Disc</title>
</svelte:head>

<div class="dashboard">
  <h1>
    Database Overview
    {#if databaseName}
      <span class="database-name">{databaseName}</span>
    {/if}
  </h1>

  {#if errorMessage}
    <div class="error-banner" role="alert">
      <span>Could not load stats: {errorMessage}</span>
    </div>
  {/if}

  <div class="stats-grid" class:is-loading={isLoading}>
    <div class="stat-card">
      <div class="stat-value">{isLoading ? "—" : stats.types}</div>
      <div class="stat-label">Schema Types</div>
    </div>

    <div class="stat-card">
      <div class="stat-value">{isLoading ? "—" : stats.migrations}</div>
      <div class="stat-label">Migrations Applied</div>
    </div>

    <div class="stat-card">
      <div class="stat-value">{isLoading ? "—" : stats.connections}</div>
      <div class="stat-label">Active Connections</div>
    </div>

    <div class="stat-card">
      <div class="stat-value">{isLoading ? "—" : stats.queries.toLocaleString()}</div>
      <div class="stat-label">Queries (lifetime)</div>
    </div>
  </div>

  <div class="content-grid">
    <section class="quick-actions">
      <h5 style="--ch: 13ch;">Quick Actions</h5>

      <div class="action-grid">
        <a href="/ui/schema" class="action-card">
          <svg class="action-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M6.75 15.4812C6.75 15.4812 6.75 8.02553 6.75 5.74689C6.75 5.21697 6.96052 4.70894 7.33617 4.33455C7.71104 3.96015 8.21974 3.75049 8.75035 3.75049C11.9215 3.75049 18.4997 3.75049 18.4997 3.75049" stroke="black" stroke-width="1.5" stroke-miterlimit="1.5" stroke-linecap="square"/>
            <path d="M14.5 20.25H5.7829C5.24368 20.25 4.72658 20.0359 4.34526 19.6547C3.96395 19.2735 3.75 18.7564 3.75 18.2175C3.75 17.2284 3.75 15.75 3.75 15.75C7.26472 15.75 9.73528 15.75 13.25 15.75L13.25 18.252C13.25 19.355 14.145 20.25 15.248 20.25H15.252C16.355 20.25 17.25 19.355 17.25 18.252V9.5" stroke="black" stroke-width="1.5" stroke-miterlimit="1.5" stroke-linecap="square"/>
            <path fill-rule="evenodd" clip-rule="evenodd" d="M19.25 3.75C20.3393 3.75 21.25 4.66068 21.25 5.75C21.25 7.1423 21.25 9.25 21.25 9.25H17.25V5.75C17.25 5.21954 17.4608 4.71092 17.8357 4.33585C18.2107 3.96077 18.7196 3.75 19.25 3.75Z" stroke="black" stroke-width="1.5" stroke-miterlimit="1.5" stroke-linecap="round"/>
            <path d="M10.75 7.75H13.25" stroke="black" stroke-width="1.5" stroke-miterlimit="1.5" stroke-linecap="square"/>
            <path d="M10.75 10.75H12.25" stroke="black" stroke-width="1.5" stroke-miterlimit="1.5" stroke-linecap="square"/>
          </svg>

          <span class="action-label">Browse Schema</span>
        </a>

        <a href="/ui/query" class="action-card">
          <svg class="action-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M4.75 6.75L10 12L4.75 17.25M12.75 17.25H19.25" stroke="black" stroke-width="1.5" stroke-linecap="square"/>
          </svg>

          <span class="action-label">New Query</span>
        </a>

        <a href="/ui/data" class="action-card">
          <svg class="action-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M21.25 12V4.75H2.75V12M21.25 12H2.75M21.25 12V19.25H2.75V12" stroke="black" stroke-width="1.5" stroke-linecap="square"/>
            <path d="M6.5 14.875C6.91421 14.875 7.25 15.2108 7.25 15.625C7.25 16.0392 6.91421 16.375 6.5 16.375C6.08579 16.375 5.75 16.0392 5.75 15.625C5.75 15.2108 6.08579 14.875 6.5 14.875ZM6.5 7.625C6.91421 7.625 7.25 7.96079 7.25 8.375C7.25 8.78921 6.91421 9.125 6.5 9.125C6.08579 9.125 5.75 8.78921 5.75 8.375C5.75 7.96079 6.08579 7.625 6.5 7.625Z" fill="black" stroke="black" stroke-width="0.5"/>
          </svg>

          <span class="action-label">View Data</span>
        </a>

        <a href="/ui/migrations" class="action-card">
          <svg class="action-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M13.25 4.75H2.75V19.25H13.25M16.2454 4.75H21.2454V19.25H16.2454M16.2454 4.75V2.75M16.2454 4.75V19.25M16.2454 19.25V21.25M8.5 9.5L11 12L8.5 14.5" stroke="black" stroke-width="1.5" stroke-linecap="square"/>
          </svg>

          <span class="action-label">Migrations</span>
        </a>
      </div>
    </section>

    <section class="recent-queries">
      <h5 style="--ch: 14ch;">Recent Queries</h5>

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
