<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { fade } from 'svelte/transition';
  
  interface Column {
    key: string;
    label: string;
    sortable?: boolean;
    type?: 'text' | 'number' | 'date' | 'boolean';
    render?: (value: any, row: any) => string;
  }
  
  export let data: any[] = [];
  export let columns: Column[] = [];
  export let selectable = false;
  export let editable = false;
  export let paginated = false;
  export let pageSize = 10;
  export let searchable = false;
  export let exportable = false;
  export let hoverable = true;
  export let loading = false;
  export let emptyMessage = 'No data available';
  export let onSelect: ((selected: any[]) => void) | undefined = undefined;
  export let onEdit: ((edit: {row: any, field: string, value: any}) => void) | undefined = undefined;
  export let onExport: ((data: any[]) => void) | undefined = undefined;
  
  const dispatch = createEventDispatcher();
  
  let searchQuery = '';
  let sortColumn: string | null = null;
  let sortDirection: 'asc' | 'desc' = 'asc';
  let currentPage = 0;
  let selectedRows = new Set<any>();
  let editingCell: {row: number, col: string} | null = null;
  let editValue = '';
  let hoveredRow: number | null = null;
  
  $: filteredData = filterData(data, searchQuery);
  $: sortedData = sortData(filteredData, sortColumn, sortDirection);
  $: paginatedData = paginated 
    ? sortedData.slice(currentPage * pageSize, (currentPage + 1) * pageSize)
    : sortedData;
  $: totalPages = Math.ceil(sortedData.length / pageSize);
  
  function filterData(data: any[], query: string) {
    if (!query) return data;
    
    const lowerQuery = query.toLowerCase();
    return data.filter(row => 
      Object.values(row).some(val => 
        String(val).toLowerCase().includes(lowerQuery)
      )
    );
  }
  
  function sortData(data: any[], column: string | null, direction: 'asc' | 'desc') {
    if (!column) return data;
    
    return [...data].sort((a, b) => {
      const aVal = a[column];
      const bVal = b[column];
      
      if (aVal === bVal) return 0;
      
      const comparison = aVal < bVal ? -1 : 1;
      return direction === 'asc' ? comparison : -comparison;
    });
  }
  
  function handleSort(column: Column) {
    if (!column.sortable) return;
    
    if (sortColumn === column.key) {
      sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      sortColumn = column.key;
      sortDirection = 'asc';
    }
  }
  
  function toggleRowSelection(row: any) {
    if (selectedRows.has(row)) {
      selectedRows.delete(row);
    } else {
      selectedRows.add(row);
    }
    selectedRows = selectedRows;
    
    if (onSelect) {
      onSelect(Array.from(selectedRows));
    }
    dispatch('select', Array.from(selectedRows));
  }
  
  function toggleSelectAll() {
    if (selectedRows.size === paginatedData.length) {
      selectedRows.clear();
    } else {
      selectedRows = new Set(paginatedData);
    }
    
    if (onSelect) {
      onSelect(Array.from(selectedRows));
    }
    dispatch('select', Array.from(selectedRows));
  }
  
  function startEdit(rowIndex: number, column: string, value: any) {
    if (!editable) return;
    
    editingCell = { row: rowIndex, col: column };
    editValue = String(value);
  }
  
  function saveEdit() {
    if (!editingCell) return;
    
    const row = paginatedData[editingCell.row];
    
    if (onEdit) {
      onEdit({
        row,
        field: editingCell.col,
        value: editValue
      });
    }
    
    dispatch('edit', {
      row,
      field: editingCell.col,
      value: editValue
    });
    
    editingCell = null;
  }
  
  function cancelEdit() {
    editingCell = null;
    editValue = '';
  }
  
  function handleKeydown(event: KeyboardEvent) {
    if (editingCell) {
      if (event.key === 'Enter') {
        saveEdit();
      } else if (event.key === 'Escape') {
        cancelEdit();
      }
    }
  }
  
  function handleExport() {
    if (onExport) {
      onExport(sortedData);
    }
    dispatch('export', sortedData);
  }
  
  function nextPage() {
    if (currentPage < totalPages - 1) {
      currentPage++;
    }
  }
  
  function prevPage() {
    if (currentPage > 0) {
      currentPage--;
    }
  }
  
  function getCellValue(row: any, column: Column) {
    if (column.render) {
      return column.render(row[column.key], row);
    }
    return row[column.key];
  }
</script>

<div class="data-grid-container">
  {#if searchable || exportable}
    <div class="grid-toolbar">
      {#if searchable}
        <div class="search-box">
          <input
            type="text"
            class="search-input"
            placeholder="Search..."
            bind:value={searchQuery}
          />
          <span class="search-icon">⊙</span>
        </div>
      {/if}
      
      {#if exportable}
        <button class="export-btn" on:click={handleExport} aria-label="Export">
          <span class="export-icon">⬇</span>
          Export
        </button>
      {/if}
    </div>
  {/if}
  
  <div class="grid-wrapper">
    {#if loading}
      <div class="loading-state">
        <span class="spinner">◉</span>
        Loading...
      </div>
    {:else if paginatedData.length === 0}
      <div class="empty-state">
        <span class="empty-icon">◇</span>
        {emptyMessage}
      </div>
    {:else}
      <table class="data-grid">
        <thead>
          <tr>
            {#if selectable}
              <th class="checkbox-column">
                <input
                  type="checkbox"
                  checked={selectedRows.size === paginatedData.length && paginatedData.length > 0}
                  on:change={toggleSelectAll}
                />
              </th>
            {/if}
            {#each columns as column}
              <th
                class:sortable={column.sortable}
                class:sorted={sortColumn === column.key}
                on:click={() => handleSort(column)}
              >
                <div class="header-content">
                  <span>{column.label}</span>
                  {#if column.sortable}
                    <span class="sort-icon">
                      {#if sortColumn === column.key}
                        {sortDirection === 'asc' ? '▲' : '▼'}
                      {:else}
                        ◆
                      {/if}
                    </span>
                  {/if}
                </div>
              </th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each paginatedData as row, rowIndex}
            <tr
              class:hover={hoverable && hoveredRow === rowIndex}
              class:selected={selectedRows.has(row)}
              on:mouseenter={() => hoveredRow = rowIndex}
              on:mouseleave={() => hoveredRow = null}
            >
              {#if selectable}
                <td class="checkbox-column">
                  <input
                    type="checkbox"
                    checked={selectedRows.has(row)}
                    on:change={() => toggleRowSelection(row)}
                  />
                </td>
              {/if}
              {#each columns as column}
                <td
                  class:editing={editingCell?.row === rowIndex && editingCell?.col === column.key}
                  on:dblclick={() => startEdit(rowIndex, column.key, row[column.key])}
                  role="cell"
                >
                  {#if editingCell?.row === rowIndex && editingCell?.col === column.key}
                    <input
                      type="text"
                      class="edit-input"
                      bind:value={editValue}
                      on:keydown={handleKeydown}
                      on:blur={saveEdit}
                      autofocus
                    />
                  {:else}
                    {@html getCellValue(row, column)}
                  {/if}
                </td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>
  
  {#if paginated && totalPages > 1}
    <div class="pagination">
      <button
        class="pagination-btn"
        on:click={prevPage}
        disabled={currentPage === 0}
        aria-label="Previous"
      >
        ◀
      </button>
      
      <span class="page-info">
        Page {currentPage + 1} of {totalPages}
      </span>
      
      <button
        class="pagination-btn"
        on:click={nextPage}
        disabled={currentPage === totalPages - 1}
        aria-label="Next"
      >
        ▶
      </button>
    </div>
  {/if}
</div>

<style lang="scss">
  @import '../../styles/component-base.scss';
  
  .data-grid-container {
    display: flex;
    flex-direction: column;
    gap: $grid-unit * 2;
    height: 100%;
  }
  
  .grid-toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: $grid-unit * 2;
    
    .search-box {
      position: relative;
      flex: 1;
      max-width: 400px;
      
      .search-input {
        width: 100%;
        padding: $grid-unit $grid-unit * 5 $grid-unit $grid-unit * 2;
        background: $color-surface;
        border: 1px solid $color-border;
        border-radius: $border-radius;
        color: $color-text;
        font-family: $font-mono;
        font-size: 0.875rem;
        
        &:focus {
          border-color: $color-primary;
          @include glow($color-primary, 0.3);
        }
      }
      
      .search-icon {
        position: absolute;
        right: $grid-unit * 2;
        top: 50%;
        transform: translateY(-50%);
        color: $color-primary;
      }
    }
    
    .export-btn {
      display: flex;
      align-items: center;
      gap: $grid-unit;
      padding: $grid-unit $grid-unit * 2;
      background: rgba($color-info, 0.1);
      border: 1px solid rgba($color-info, 0.3);
      border-radius: $border-radius;
      color: $color-info;
      font-family: $font-mono;
      font-size: 0.875rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      cursor: pointer;
      transition: all $transition-fast;
      
      &:hover {
        background: rgba($color-info, 0.2);
        @include glow($color-info, 0.3);
      }
    }
  }
  
  .grid-wrapper {
    flex: 1;
    overflow: auto;
    background: $color-surface;
    border: 1px solid $color-border;
    border-radius: $border-radius;
  }
  
  .data-grid {
    width: 100%;
    border-collapse: collapse;
    font-family: $font-mono;
    font-size: 0.875rem;
    
    thead {
      position: sticky;
      top: 0;
      background: $color-surface;
      z-index: 10;
      
      th {
        padding: $grid-unit * 2;
        text-align: left;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: $color-text-dim;
        border-bottom: 2px solid $color-border;
        user-select: none;
        
        &.sortable {
          cursor: pointer;
          transition: all $transition-fast;
          
          &:hover {
            background: rgba($color-primary, 0.05);
            color: $color-text;
          }
        }
        
        &.sorted {
          color: $color-primary;
          background: rgba($color-primary, 0.05);
        }
        
        .header-content {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: $grid-unit;
          
          .sort-icon {
            font-size: 0.75rem;
            opacity: 0.5;
            transition: opacity $transition-fast;
          }
        }
        
        &.sorted .sort-icon {
          opacity: 1;
          color: $color-primary;
        }
      }
    }
    
    tbody {
      tr {
        border-bottom: 1px solid rgba($color-border, 0.5);
        transition: background $transition-fast;
        
        &.hover {
          background: rgba($color-primary, 0.05);
        }
        
        &.selected {
          background: rgba($color-primary, 0.1);
        }
        
        td {
          padding: $grid-unit * 1.5 $grid-unit * 2;
          color: $color-text;
          position: relative;
          
          &.editing {
            padding: 0;
          }
        }
      }
    }
    
    .checkbox-column {
      width: 40px;
      text-align: center;
      
      input[type="checkbox"] {
        cursor: pointer;
      }
    }
  }
  
  .edit-input {
    width: 100%;
    padding: $grid-unit * 1.5 $grid-unit * 2;
    background: $color-background;
    border: 2px solid $color-primary;
    color: $color-text;
    font-family: inherit;
    font-size: inherit;
    
    &:focus {
      outline: none;
      @include glow($color-primary, 0.5);
    }
  }
  
  .loading-state,
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: $grid-unit * 2;
    padding: $grid-unit * 8;
    color: $color-text-dim;
    font-family: $font-mono;
    
    .spinner,
    .empty-icon {
      font-size: 3rem;
      color: $color-primary;
      opacity: 0.5;
    }
    
    .spinner {
      animation: pulse 2s ease-in-out infinite;
    }
  }
  
  .pagination {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: $grid-unit * 2;
    padding: $grid-unit * 2;
    background: $color-surface;
    border: 1px solid $color-border;
    border-radius: $border-radius;
    
    .pagination-btn {
      padding: $grid-unit;
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      border: 1px solid $color-border;
      border-radius: $border-radius;
      color: $color-primary;
      cursor: pointer;
      transition: all $transition-fast;
      
      &:hover:not(:disabled) {
        background: rgba($color-primary, 0.1);
        border-color: $color-primary;
        @include glow($color-primary, 0.3);
      }
      
      &:disabled {
        opacity: 0.3;
        cursor: not-allowed;
      }
    }
    
    .page-info {
      font-family: $font-mono;
      font-size: 0.875rem;
      color: $color-text-dim;
    }
  }
  
  @keyframes pulse {
    0%, 100% { opacity: 0.5; }
    50% { opacity: 1; }
  }
</style>