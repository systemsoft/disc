<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { fade, slide } from 'svelte/transition';

  export let schema: any;
  export let searchable = false;
  export let onTypeSelect: ((type: any) => void) | undefined = undefined;

  const dispatch = createEventDispatcher();

  let searchQuery = '';
  let expandedTypes = new Set<string>();
  let selectedType: string | null = null;

  function toggleType(typeName: string) {
    if (expandedTypes.has(typeName))
      expandedTypes.delete(typeName);
    else
      expandedTypes.add(typeName);

    expandedTypes = expandedTypes;

    // Select type
    selectedType = typeName;

    // Find and emit the type object
    const type = findType(typeName);

    if (type && onTypeSelect)
      onTypeSelect(type);

    dispatch('typeSelect', type);
  }

  function findType(typeName: string) {
    for (const module of schema.modules || []) {
      for (const type of module.types || []) {
        if (type.name === typeName)
          return type;
      }
    }

    return null;
  }

  function filterTypes(types: any[], query: string) {
    if (!query)
      return types;

    return types.filter(t => t.name.toLowerCase().includes(query.toLowerCase()));
  }

  function getPropertyIcon(property: any) {
    if (property.required)
      return '◆';

    return '◇';
  }

  function getLinkIcon(link: any) {
    if (link.cardinality === 'many')
      return '⟩⟩';

    return '⟩';
  }
</script>

{#if searchable}
  <div class="search-container">
    <input
      type="text"
      class="search-input"
      placeholder="Search types..."
      bind:value={searchQuery}
    />
    <span class="search-icon">⊙</span>
  </div>
{/if}

<div class="schema-tree">
  {#each schema.modules || [] as module}
    <div class="module-node">
      <div class="module-header">
        <span class="module-icon">◈</span>
        <span class="module-name">{module.name}</span>
      </div>

      <div class="types-container">
        {#each filterTypes(module.types || [], searchQuery) as type}
          <div class="type-node" class:expanded={expandedTypes.has(type.name)}>
            <button
              class="type-header"
              class:selected={selectedType === type.name}
              on:click={() => toggleType(type.name)}
            >
              <span class="expand-icon">
                {expandedTypes.has(type.name) ? '▼' : '▶'}
              </span>
              <span class="type-icon">▦</span>
              <span class="type-name">{type.name}</span>
            </button>

            {#if expandedTypes.has(type.name)}
              <div class="type-details" transition:slide={{ duration: 200 }}>
                {#if type.properties?.length > 0}
                  <div class="properties-section">
                    <div class="section-label">Properties</div>
                    {#each type.properties as property}
                      <div class="property-item">
                        <span class="property-icon">{getPropertyIcon(property)}</span>
                        <span class="property-name">{property.name}</span>
                        <span class="property-type">{property.type}</span>
                        {#if property.required}
                          <span class="property-badge required">required</span>
                        {/if}
                        {#if property.constraint}
                          <span class="property-badge constraint">{property.constraint}</span>
                        {/if}
                        {#if property.default}
                          <span class="property-default" title={property.default}>⚡</span>
                        {/if}
                      </div>
                    {/each}
                  </div>
                {/if}

                {#if type.links?.length > 0}
                  <div class="links-section">
                    <div class="section-label">Links</div>
                    {#each type.links as link}
                      <div class="link-item">
                        <span class="link-icon">{getLinkIcon(link)}</span>
                        <span class="link-name">{link.name}</span>
                        <span class="link-arrow">→</span>
                        <span class="link-target">{link.target}</span>
                        <span class="link-cardinality">[{link.cardinality}]</span>
                        {#if link.required}
                          <span class="link-badge required">required</span>
                        {/if}
                      </div>
                    {/each}
                  </div>
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  {/each}
</div>

<style lang="scss">
  @import '../../styles/component-base.scss';

  .search-container {
    margin-bottom: $grid-unit * 2;
    position: relative;

    .search-input {
      width: 100%;
      padding: $grid-unit $grid-unit * 5 $grid-unit $grid-unit * 2;
      background: $color-surface;
      border: 1px solid $color-border;
      border-radius: $border-radius;
      color: $color-text;
      font-family: $font-mono;
      font-size: 0.875rem;
      transition: all $transition-fast;

      &:focus {
        outline: none;
        border-color: $color-primary;
        @include glow($color-primary, 0.3);
      }

      &::placeholder {
        color: $color-text-dim;
      }
    }

    .search-icon {
      position: absolute;
      right: $grid-unit * 2;
      top: 50%;
      transform: translateY(-50%);
      color: $color-primary;
      font-size: 1.25rem;
    }
  }

  .schema-tree {
    font-family: $font-mono;
    font-size: 0.875rem;
  }

  .module-node {
    margin-bottom: $grid-unit * 2;

    .module-header {
      display: flex;
      align-items: center;
      gap: $grid-unit;
      padding: $grid-unit;
      color: $color-secondary;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.1em;

      .module-icon {
        font-size: 1.25rem;
      }
    }
  }

  .types-container {
    padding-left: $grid-unit * 3;
  }

  .type-node {
    margin-bottom: $grid-unit;

    .type-header {
      display: flex;
      align-items: center;
      gap: $grid-unit;
      width: 100%;
      padding: $grid-unit;
      background: transparent;
      border: 1px solid transparent;
      border-radius: $border-radius;
      color: $color-text-dim;
      text-align: left;
      cursor: pointer;
      transition: all $transition-fast;

      &:hover {
        background: rgba($color-primary, 0.05);
        color: $color-text;
        border-color: rgba($color-primary, 0.2);
      }

      &.selected {
        background: rgba($color-primary, 0.1);
        color: $color-primary;
        border-color: $color-primary;
        @include glow($color-primary, 0.2);
      }

      .expand-icon {
        width: 12px;
        font-size: 0.625rem;
        transition: transform $transition-fast;
      }

      .type-icon {
        color: $color-primary;
      }

      .type-name {
        font-weight: 600;
      }
    }

    &.expanded .type-header .expand-icon {
      transform: rotate(0deg);
    }
  }

  .type-details {
    margin-left: $grid-unit * 4;
    padding: $grid-unit;
    border-left: 1px solid rgba($color-primary, 0.2);
  }

  .section-label {
    color: $color-text-dim;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    margin-bottom: $grid-unit;
    opacity: 0.7;
  }

  .properties-section,
  .links-section {
    margin-bottom: $grid-unit * 2;
  }

  .property-item,
  .link-item {
    display: flex;
    align-items: center;
    gap: $grid-unit;
    padding: $grid-unit / 2 $grid-unit;
    margin-bottom: $grid-unit / 2;
    border-radius: $border-radius;
    transition: background $transition-fast;

    &:hover {
      background: rgba($color-primary, 0.05);
    }

    .property-icon,
    .link-icon {
      color: $color-info;
      font-size: 0.875rem;
    }

    .property-name,
    .link-name {
      color: $color-text;
      font-weight: 500;
    }

    .property-type {
      color: $color-success;
      font-size: 0.75rem;
      padding: 2px 6px;
      background: rgba($color-success, 0.1);
      border-radius: $border-radius;
    }

    .link-arrow {
      color: $color-text-dim;
      font-size: 0.875rem;
    }

    .link-target {
      color: $color-info;
      font-weight: 500;
    }

    .link-cardinality {
      color: $color-text-dim;
      font-size: 0.75rem;
    }

    .property-badge,
    .link-badge {
      padding: 2px 6px;
      font-size: 0.625rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      border-radius: $border-radius;

      &.required {
        color: $color-warning;
        background: rgba($color-warning, 0.1);
        border: 1px solid rgba($color-warning, 0.3);
      }

      &.constraint {
        color: $color-info;
        background: rgba($color-info, 0.1);
        border: 1px solid rgba($color-info, 0.3);
      }
    }

    .property-default {
      color: $color-secondary;
      cursor: help;
    }
  }
</style>
