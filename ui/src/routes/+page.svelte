<script lang="ts">
  import { onMount } from 'svelte';

  interface Stats {
    types: number;
    objects: number;
    connections: number;
    queries: number;
  }

  let stats: Stats = {
    types: 0,
    objects: 0,
    connections: 0,
    queries: 0
  };

  let recentQueries: string[] = [];

  onMount(async () => {
    // Simulate loading stats
    setTimeout(() => {
      stats = {
        types: 12,
        objects: 1847,
        connections: 3,
        queries: 156
      };

      recentQueries = [
        'SELECT User { name, email }',
        'INSERT User { name := "Ada" }',
        'SELECT Post { title, author: { name } }'
      ];
    }, 500);
  });
</script>

<div class="dashboard">
  <h1>Database Overview</h1>

  <div class="stats-grid">
    <div class="stat-card">
      <div class="stat-value">{stats.types}</div>
      <div class="stat-label">Schema Types</div>
      <div class="stat-icon">◈</div>
    </div>

    <div class="stat-card">
      <div class="stat-value">{stats.objects.toLocaleString()}</div>
      <div class="stat-label">Total Objects</div>
      <div class="stat-icon">▦</div>
    </div>

    <div class="stat-card">
      <div class="stat-value">{stats.connections}</div>
      <div class="stat-label">Active Connections</div>
      <div class="stat-icon">⟗</div>
    </div>

    <div class="stat-card">
      <div class="stat-value">{stats.queries}</div>
      <div class="stat-label">Queries Today</div>
      <div class="stat-icon">⟩</div>
    </div>
  </div>

  <div class="content-grid">
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
  </div>
</div>

<style lang="scss">
  @use "../styles/mixins" as *;
  .dashboard {
    max-width: 1400px;
    margin: 0 auto;
  }

  h1 {
    margin-bottom: calc(var(--grid-unit) * 4);
  }

  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
    gap: calc(var(--grid-unit) * 3);
    margin-bottom: calc(var(--grid-unit) * 6);
  }

  .stat-card {
    position: relative;
    padding: calc(var(--grid-unit) * 3);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--border-radius);
    overflow: hidden;
    transition: all var(--transition-fast);

    &:hover {
      border-color: var(--color-primary);
      @include glow(var(--color-primary-rgb), 0.2);
    }

    .stat-value {
      font-family: var(--font-display);
      font-size: 2.5rem;
      font-weight: 700;
      color: var(--color-primary);
      @include neon-text(var(--color-primary-rgb));
    }

    .stat-label {
      font-family: var(--font-mono);
      font-size: 0.875rem;
      color: var(--color-text-dim);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-top: var(--grid-unit);
    }

    .stat-icon {
      position: absolute;
      top: calc(var(--grid-unit) * 2);
      right: calc(var(--grid-unit) * 2);
      font-size: 3rem;
      color: var(--color-primary);
      opacity: 0.2;
    }
  }

  .content-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: calc(var(--grid-unit) * 3);
  }

  section {
    h2 {
      font-size: 1.25rem;
      margin-bottom: calc(var(--grid-unit) * 2);
    }
  }

  .recent-queries {
    .query-list {
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--border-radius);
      padding: calc(var(--grid-unit) * 2);
    }

    .query-item {
      padding: calc(var(--grid-unit) * 1.5);
      background: var(--color-background);
      border: 1px solid var(--color-border);
      border-radius: var(--border-radius);
      margin-bottom: var(--grid-unit);
      transition: all var(--transition-fast);

      &:last-child {
        margin-bottom: 0;
      }

      &:hover {
        border-color: var(--color-primary);
        background: var(--color-surface-hover);
      }

      code {
        color: var(--color-info);
        font-size: 0.875rem;
      }
    }

    .empty-state {
      padding: calc(var(--grid-unit) * 4);
      text-align: center;
      color: var(--color-text-dim);
      font-family: var(--font-mono);
    }
  }

  .quick-actions {
    .action-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: calc(var(--grid-unit) * 2);
    }

    .action-card {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: calc(var(--grid-unit) * 3);
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--border-radius);
      transition: all var(--transition-fast);
      text-decoration: none;

      &:hover {
        border-color: var(--color-primary);
        background: var(--color-surface-hover);
        @include glow(var(--color-primary-rgb), 0.3);

        .action-icon {
          transform: scale(1.1);
        }
      }

      .action-icon {
        font-size: 2.5rem;
        color: var(--color-primary);
        margin-bottom: var(--grid-unit);
        transition: transform var(--transition-fast);
      }

      .action-label {
        font-family: var(--font-mono);
        font-size: 0.875rem;
        color: var(--color-text);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
    }
  }

  @media (max-width: 768px) {
    .content-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
