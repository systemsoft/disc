<script lang="ts">
  import { onMount } from 'svelte';
  import { discAPI, type SchemaTypeDescription } from '$lib/api/client';

  let schemaTypes: SchemaTypeDescription[] = [];
  let selectedType: SchemaTypeDescription | null = null;
  let searchQuery = '';
  let loadError: string | null = null;
  let loading = true;

  $: filteredTypes = schemaTypes.filter(type =>
    type.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // P1-23: call the real /schema endpoint instead of the mock fixture
  // that shipped with the UI scaffold. The server returns SchemaDescription;
  // we render its `types` list. An empty schema is not an error.
  onMount(async () => {
    try {
      const description = await discAPI.getSchema();
      schemaTypes = description.types;
      if (schemaTypes.length > 0) {
        selectedType = schemaTypes[0];
      }
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  });

  function selectType(type: SchemaTypeDescription) {
    selectedType = type;
  }
</script>

<div class="schema-browser">
  <aside class="schema-sidebar">
    <div class="sidebar-header">
      <h2>Object Types</h2>
      <input 
        type="text" 
        placeholder="Search types..." 
        bind:value={searchQuery}
        class="search-input"
      />
    </div>
    
    <div class="type-list">
      {#each filteredTypes as type}
        <button 
          class="type-item"
          class:active={selectedType?.name === type.name}
          on:click={() => selectType(type)}
        >
          <span class="type-icon">◈</span>
          <span class="type-name">{type.name}</span>
          <span class="type-count">
            {type.properties.length + type.links.length}
          </span>
        </button>
      {/each}
    </div>
  </aside>
  
  <div class="schema-details">
    {#if selectedType}
      <div class="type-header">
        <h1>{selectedType.name}</h1>
        <div class="type-actions">
          <button class="button">View Data</button>
          <button class="button">Query Builder</button>
        </div>
      </div>
      
      <div class="type-sections">
        <section class="properties-section">
          <h3>Properties</h3>
          <div class="properties-list">
            {#each selectedType.properties as prop}
              <div class="property-item">
                <span class="property-name">{prop.name}</span>
                <span class="property-type">{prop.type}</span>
                <div class="property-flags">
                  {#if prop.required}
                    <span class="flag required">required</span>
                  {/if}
                  {#if prop.readonly}
                    <span class="flag">readonly</span>
                  {/if}
                  {#if prop.computed}
                    <span class="flag">computed</span>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        </section>
        
        {#if selectedType.links.length > 0}
          <section class="links-section">
            <h3>Links</h3>
            <div class="links-list">
              {#each selectedType.links as link}
                <div class="link-item">
                  <span class="link-name">{link.name}</span>
                  <span class="link-arrow">→</span>
                  <span class="link-target">{link.target}</span>
                  {#if link.cardinality === 'multi'}
                    <span class="flag multi">multi</span>
                  {/if}
                  {#if link.required}
                    <span class="flag required">required</span>
                  {/if}
                </div>
              {/each}
            </div>
          </section>
        {/if}
      </div>
    {:else}
      <div class="empty-state">
        <span class="empty-icon">◈</span>
        <p>Select a type to view details</p>
      </div>
    {/if}
  </div>
</div>

<style lang="scss">
  @use "../../styles/mixins" as *;
  .schema-browser {
    display: flex;
    gap: calc(var(--grid-unit) * 3);
    height: calc(100vh - 120px);
    max-width: 1400px;
    margin: 0 auto;
  }
  
  .schema-sidebar {
    width: 300px;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--border-radius);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    
    .sidebar-header {
      padding: calc(var(--grid-unit) * 2);
      border-bottom: 1px solid var(--color-border);
      
      h2 {
        font-size: 1rem;
        margin-bottom: calc(var(--grid-unit) * 2);
      }
      
      .search-input {
        width: 100%;
      }
    }
    
    .type-list {
      flex: 1;
      overflow-y: auto;
      padding: var(--grid-unit);
    }
    
    .type-item {
      display: flex;
      align-items: center;
      gap: var(--grid-unit);
      width: 100%;
      padding: calc(var(--grid-unit) * 1.5);
      background: transparent;
      border: 1px solid transparent;
      border-radius: var(--border-radius);
      color: var(--color-text);
      font-family: var(--font-mono);
      font-size: 0.875rem;
      text-align: left;
      cursor: pointer;
      transition: all var(--transition-fast);
      margin-bottom: calc(var(--grid-unit) * 0.5);
      
      .type-icon {
        color: var(--color-primary);
        opacity: 0.5;
      }
      
      .type-name {
        flex: 1;
      }
      
      .type-count {
        padding: 2px 6px;
        background: var(--color-background);
        border-radius: var(--border-radius);
        font-size: 0.75rem;
        color: var(--color-text-dim);
      }
      
      &:hover {
        background: var(--color-surface-hover);
        border-color: var(--color-border);
      }
      
      &.active {
        background: rgb(var(--color-primary-rgb) / 0.1);
        border-color: var(--color-primary);
        @include glow(var(--color-primary-rgb), 0.2);
        
        .type-icon {
          opacity: 1;
        }
      }
    }
  }
  
  .schema-details {
    flex: 1;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--border-radius);
    overflow-y: auto;
    
    .type-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: calc(var(--grid-unit) * 3);
      border-bottom: 1px solid var(--color-border);
      
      h1 {
        font-size: 1.5rem;
      }
      
      .type-actions {
        display: flex;
        gap: var(--grid-unit);
      }
    }
    
    .type-sections {
      padding: calc(var(--grid-unit) * 3);
    }
    
    section {
      margin-bottom: calc(var(--grid-unit) * 4);
      
      h3 {
        font-size: 1rem;
        margin-bottom: calc(var(--grid-unit) * 2);
        color: var(--color-secondary);
        @include neon-text(var(--color-secondary-rgb));
      }
    }
    
    .properties-list,
    .links-list {
      background: var(--color-background);
      border: 1px solid var(--color-border);
      border-radius: var(--border-radius);
      padding: calc(var(--grid-unit) * 2);
    }
    
    .property-item,
    .link-item {
      display: flex;
      align-items: center;
      gap: calc(var(--grid-unit) * 2);
      padding: calc(var(--grid-unit) * 1.5);
      border-bottom: 1px solid var(--color-border);
      font-family: var(--font-mono);
      font-size: 0.875rem;
      
      &:last-child {
        border-bottom: none;
      }
    }
    
    .property-name,
    .link-name {
      color: var(--color-info);
      min-width: 150px;
    }
    
    .property-type,
    .link-target {
      color: var(--color-success);
    }
    
    .link-arrow {
      color: var(--color-text-dim);
    }
    
    .property-flags {
      display: flex;
      gap: var(--grid-unit);
      margin-left: auto;
    }
    
    .flag {
      padding: 2px 8px;
      border-radius: var(--border-radius);
      font-size: 0.75rem;
      text-transform: uppercase;
      
      &.required {
        background: rgb(var(--color-danger-rgb) / 0.2);
        color: var(--color-danger);
        border: 1px solid rgb(var(--color-danger-rgb) / 0.3);
      }
      
      &.multi {
        background: rgb(var(--color-info-rgb) / 0.2);
        color: var(--color-info);
        border: 1px solid rgb(var(--color-info-rgb) / 0.3);
      }
    }
    
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: var(--color-text-dim);
      
      .empty-icon {
        font-size: 4rem;
        color: var(--color-primary);
        opacity: 0.2;
        margin-bottom: calc(var(--grid-unit) * 2);
      }
      
      p {
        font-family: var(--font-mono);
        font-size: 0.875rem;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
    }
  }
</style>