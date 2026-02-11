<script lang="ts">
  let migrations = [
    { id: 'm001', name: 'initial_schema', applied_at: '2024-01-15 10:30:00', status: 'applied' },
    { id: 'm002', name: 'add_user_profile', applied_at: '2024-01-16 14:20:00', status: 'applied' },
    { id: 'm003', name: 'add_posts_table', applied_at: '2024-01-17 09:15:00', status: 'applied' },
    { id: 'm004', name: 'add_tags_system', applied_at: null, status: 'pending' }
  ];
</script>

<div class="migrations">
  <h1>Migration History</h1>
  
  <div class="migrations-list">
    {#each migrations as migration}
      <div class="migration-item" class:pending={migration.status === 'pending'}>
        <div class="migration-header">
          <span class="migration-id">{migration.id}</span>
          <span class="migration-name">{migration.name}</span>
          <span class="migration-status" class:applied={migration.status === 'applied'}>
            {migration.status}
          </span>
        </div>
        {#if migration.applied_at}
          <div class="migration-date">Applied: {migration.applied_at}</div>
        {/if}
      </div>
    {/each}
  </div>
</div>

<style lang="scss">
  @import '../../styles/variables.scss';
  
  .migrations {
    max-width: 1400px;
    margin: 0 auto;
  }
  
  .migrations-list {
    background: $color-surface;
    border: 1px solid $color-border;
    border-radius: $border-radius;
    padding: $grid-unit * 2;
  }
  
  .migration-item {
    padding: $grid-unit * 2;
    background: $color-background;
    border: 1px solid $color-border;
    border-radius: $border-radius;
    margin-bottom: $grid-unit;
    
    &.pending {
      opacity: 0.6;
      border-style: dashed;
    }
    
    .migration-header {
      display: flex;
      align-items: center;
      gap: $grid-unit * 2;
      font-family: $font-mono;
      font-size: 0.875rem;
      
      .migration-id {
        color: $color-primary;
        font-weight: bold;
      }
      
      .migration-name {
        flex: 1;
        color: $color-text;
      }
      
      .migration-status {
        padding: 2px 8px;
        border-radius: $border-radius;
        font-size: 0.75rem;
        text-transform: uppercase;
        background: rgba($color-warning, 0.2);
        color: $color-warning;
        
        &.applied {
          background: rgba($color-success, 0.2);
          color: $color-success;
        }
      }
    }
    
    .migration-date {
      margin-top: $grid-unit;
      font-family: $font-mono;
      font-size: 0.75rem;
      color: $color-text-dim;
    }
  }
</style>