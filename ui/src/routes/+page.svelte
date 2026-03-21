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
  @import '../styles/variables.scss';

  .dashboard {
    max-width: 1400px;
    margin: 0 auto;
  }

  h1 {
    margin-bottom: $grid-unit * 4;
  }

  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
    gap: $grid-unit * 3;
    margin-bottom: $grid-unit * 6;
  }

  .stat-card {
    position: relative;
    padding: $grid-unit * 3;
    background: $color-surface;
    border: 1px solid $color-border;
    border-radius: $border-radius;
    overflow: hidden;
    transition: all $transition-fast;

    &:hover {
      border-color: $color-primary;
      @include glow($color-primary, 0.2);
    }

    .stat-value {
      font-family: $font-display;
      font-size: 2.5rem;
      font-weight: 700;
      color: $color-primary;
      @include neon-text($color-primary);
    }

    .stat-label {
      font-family: $font-mono;
      font-size: 0.875rem;
      color: $color-text-dim;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-top: $grid-unit;
    }

    .stat-icon {
      position: absolute;
      top: $grid-unit * 2;
      right: $grid-unit * 2;
      font-size: 3rem;
      color: $color-primary;
      opacity: 0.2;
    }
  }

  .content-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: $grid-unit * 3;
  }

  section {
    h2 {
      font-size: 1.25rem;
      margin-bottom: $grid-unit * 2;
    }
  }

  .recent-queries {
    .query-list {
      background: $color-surface;
      border: 1px solid $color-border;
      border-radius: $border-radius;
      padding: $grid-unit * 2;
    }

    .query-item {
      padding: $grid-unit * 1.5;
      background: $color-background;
      border: 1px solid $color-border;
      border-radius: $border-radius;
      margin-bottom: $grid-unit;
      transition: all $transition-fast;

      &:last-child {
        margin-bottom: 0;
      }

      &:hover {
        border-color: $color-primary;
        background: $color-surface-hover;
      }

      code {
        color: $color-info;
        font-size: 0.875rem;
      }
    }

    .empty-state {
      padding: $grid-unit * 4;
      text-align: center;
      color: $color-text-dim;
      font-family: $font-mono;
    }
  }

  .quick-actions {
    .action-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: $grid-unit * 2;
    }

    .action-card {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: $grid-unit * 3;
      background: $color-surface;
      border: 1px solid $color-border;
      border-radius: $border-radius;
      transition: all $transition-fast;
      text-decoration: none;

      &:hover {
        border-color: $color-primary;
        background: $color-surface-hover;
        @include glow($color-primary, 0.3);

        .action-icon {
          transform: scale(1.1);
        }
      }

      .action-icon {
        font-size: 2.5rem;
        color: $color-primary;
        margin-bottom: $grid-unit;
        transition: transform $transition-fast;
      }

      .action-label {
        font-family: $font-mono;
        font-size: 0.875rem;
        color: $color-text;
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
