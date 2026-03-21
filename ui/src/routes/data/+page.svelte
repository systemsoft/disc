<script lang="ts">
  import { onMount } from 'svelte';

  let selectedType = 'User';
  let data: any[] = [];
  let loading = false;

  onMount(() => {
    loadData();
  });

  async function loadData() {
    loading = true;
    // Simulate data loading
    setTimeout(() => {
      data = [
        { id: '1', name: 'Ada', email: 'ada@example.com', created_at: '2024-01-15' },
        { id: '2', name: 'Billie', email: 'billie@example.com', created_at: '2024-01-16' },
        { id: '3', name: 'Cher', email: 'cher@example.com', created_at: '2024-01-17' }
      ];
      loading = false;
    }, 500);
  }
</script>

<div class="data-viewer">
  <h1>Data Viewer</h1>
  <p class="coming-soon">Full data viewer/editor interface coming soon...</p>

  <div class="demo-data">
    <h3>Sample {selectedType} Data</h3>
    <table>
      <thead>
        <tr>
          <th>ID</th>
          <th>Name</th>
          <th>Email</th>
          <th>Created</th>
        </tr>
      </thead>
      <tbody>
        {#each data as row}
          <tr>
            <td>{row.id}</td>
            <td>{row.name}</td>
            <td>{row.email}</td>
            <td>{row.created_at}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</div>

<style lang="scss">
  @import '../../styles/variables.scss';

  .data-viewer {
    max-width: 1400px;
    margin: 0 auto;
  }

  .coming-soon {
    padding: $grid-unit * 4;
    background: $color-surface;
    border: 1px solid $color-border;
    border-radius: $border-radius;
    text-align: center;
    color: $color-text-dim;
    font-family: $font-mono;
    margin: $grid-unit * 3 0;
  }

  .demo-data {
    background: $color-surface;
    border: 1px solid $color-border;
    border-radius: $border-radius;
    padding: $grid-unit * 3;

    h3 {
      margin-bottom: $grid-unit * 2;
    }

    table {
      width: 100%;
      font-family: $font-mono;
      font-size: 0.875rem;

      th, td {
        padding: $grid-unit * 1.5;
        text-align: left;
        border-bottom: 1px solid $color-border;
      }

      th {
        background: $color-background-dark;
        color: $color-primary;
      }
    }
  }
</style>
