<script lang="ts">
  import { onMount } from 'svelte';
  
  interface SchemaType {
    name: string;
    properties: Array<{
      name: string;
      type: string;
      required: boolean;
      multi: boolean;
    }>;
    links: Array<{
      name: string;
      target: string;
      multi: boolean;
    }>;
  }
  
  let schemaTypes: SchemaType[] = [];
  let selectedType: SchemaType | null = null;
  let searchQuery = '';
  
  $: filteredTypes = schemaTypes.filter(type => 
    type.name.toLowerCase().includes(searchQuery.toLowerCase())
  );
  
  onMount(() => {
    // Simulate loading schema
    schemaTypes = [
      {
        name: 'User',
        properties: [
          { name: 'id', type: 'uuid', required: true, multi: false },
          { name: 'name', type: 'str', required: true, multi: false },
          { name: 'email', type: 'str', required: true, multi: false },
          { name: 'created_at', type: 'datetime', required: true, multi: false }
        ],
        links: [
          { name: 'posts', target: 'Post', multi: true },
          { name: 'profile', target: 'Profile', multi: false }
        ]
      },
      {
        name: 'Post',
        properties: [
          { name: 'id', type: 'uuid', required: true, multi: false },
          { name: 'title', type: 'str', required: true, multi: false },
          { name: 'body', type: 'str', required: true, multi: false },
          { name: 'published', type: 'bool', required: false, multi: false },
          { name: 'created_at', type: 'datetime', required: true, multi: false }
        ],
        links: [
          { name: 'author', target: 'User', multi: false },
          { name: 'tags', target: 'Tag', multi: true }
        ]
      },
      {
        name: 'Profile',
        properties: [
          { name: 'id', type: 'uuid', required: true, multi: false },
          { name: 'bio', type: 'str', required: false, multi: false },
          { name: 'avatar_url', type: 'str', required: false, multi: false }
        ],
        links: [
          { name: 'user', target: 'User', multi: false }
        ]
      },
      {
        name: 'Tag',
        properties: [
          { name: 'id', type: 'uuid', required: true, multi: false },
          { name: 'name', type: 'str', required: true, multi: false }
        ],
        links: [
          { name: 'posts', target: 'Post', multi: true }
        ]
      }
    ];
    
    if (schemaTypes.length > 0) {
      selectedType = schemaTypes[0];
    }
  });
  
  function selectType(type: SchemaType) {
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
                  {#if prop.multi}
                    <span class="flag multi">multi</span>
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
                  {#if link.multi}
                    <span class="flag multi">multi</span>
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
  @import '../../styles/variables.scss';
  
  .schema-browser {
    display: flex;
    gap: $grid-unit * 3;
    height: calc(100vh - 120px);
    max-width: 1400px;
    margin: 0 auto;
  }
  
  .schema-sidebar {
    width: 300px;
    background: $color-surface;
    border: 1px solid $color-border;
    border-radius: $border-radius;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    
    .sidebar-header {
      padding: $grid-unit * 2;
      border-bottom: 1px solid $color-border;
      
      h2 {
        font-size: 1rem;
        margin-bottom: $grid-unit * 2;
      }
      
      .search-input {
        width: 100%;
      }
    }
    
    .type-list {
      flex: 1;
      overflow-y: auto;
      padding: $grid-unit;
    }
    
    .type-item {
      display: flex;
      align-items: center;
      gap: $grid-unit;
      width: 100%;
      padding: $grid-unit * 1.5;
      background: transparent;
      border: 1px solid transparent;
      border-radius: $border-radius;
      color: $color-text;
      font-family: $font-mono;
      font-size: 0.875rem;
      text-align: left;
      cursor: pointer;
      transition: all $transition-fast;
      margin-bottom: $grid-unit * 0.5;
      
      .type-icon {
        color: $color-primary;
        opacity: 0.5;
      }
      
      .type-name {
        flex: 1;
      }
      
      .type-count {
        padding: 2px 6px;
        background: $color-background;
        border-radius: $border-radius;
        font-size: 0.75rem;
        color: $color-text-dim;
      }
      
      &:hover {
        background: $color-surface-hover;
        border-color: $color-border;
      }
      
      &.active {
        background: rgba($color-primary, 0.1);
        border-color: $color-primary;
        @include glow($color-primary, 0.2);
        
        .type-icon {
          opacity: 1;
        }
      }
    }
  }
  
  .schema-details {
    flex: 1;
    background: $color-surface;
    border: 1px solid $color-border;
    border-radius: $border-radius;
    overflow-y: auto;
    
    .type-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: $grid-unit * 3;
      border-bottom: 1px solid $color-border;
      
      h1 {
        font-size: 1.5rem;
      }
      
      .type-actions {
        display: flex;
        gap: $grid-unit;
      }
    }
    
    .type-sections {
      padding: $grid-unit * 3;
    }
    
    section {
      margin-bottom: $grid-unit * 4;
      
      h3 {
        font-size: 1rem;
        margin-bottom: $grid-unit * 2;
        color: $color-secondary;
        @include neon-text($color-secondary);
      }
    }
    
    .properties-list,
    .links-list {
      background: $color-background;
      border: 1px solid $color-border;
      border-radius: $border-radius;
      padding: $grid-unit * 2;
    }
    
    .property-item,
    .link-item {
      display: flex;
      align-items: center;
      gap: $grid-unit * 2;
      padding: $grid-unit * 1.5;
      border-bottom: 1px solid $color-border;
      font-family: $font-mono;
      font-size: 0.875rem;
      
      &:last-child {
        border-bottom: none;
      }
    }
    
    .property-name,
    .link-name {
      color: $color-info;
      min-width: 150px;
    }
    
    .property-type,
    .link-target {
      color: $color-success;
    }
    
    .link-arrow {
      color: $color-text-dim;
    }
    
    .property-flags {
      display: flex;
      gap: $grid-unit;
      margin-left: auto;
    }
    
    .flag {
      padding: 2px 8px;
      border-radius: $border-radius;
      font-size: 0.75rem;
      text-transform: uppercase;
      
      &.required {
        background: rgba($color-danger, 0.2);
        color: $color-danger;
        border: 1px solid rgba($color-danger, 0.3);
      }
      
      &.multi {
        background: rgba($color-info, 0.2);
        color: $color-info;
        border: 1px solid rgba($color-info, 0.3);
      }
    }
    
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: $color-text-dim;
      
      .empty-icon {
        font-size: 4rem;
        color: $color-primary;
        opacity: 0.2;
        margin-bottom: $grid-unit * 2;
      }
      
      p {
        font-family: $font-mono;
        font-size: 0.875rem;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
    }
  }
</style>