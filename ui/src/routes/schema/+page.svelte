<script lang="ts">
  /*** IMPORT ------------------------------------------- ***/

  import { onMount } from "svelte";

  /*** UTILITY ------------------------------------------ ***/

  import { discAPI, type SchemaTypeDescription } from "$lib/api/client";

  let loadError: string | null = null;
  let loading = true;
  let schemaTypes: SchemaTypeDescription[] = [];
  let searchQuery = "";
  let selectedType: SchemaTypeDescription | null = null;

  /*** RUNTIME ------------------------------------------ ***/

  $: filteredTypes = schemaTypes.filter(type => type.name.toLowerCase().includes(searchQuery.toLowerCase()));

  onMount(async () => {
    try {
      const description = await discAPI.getSchema();
      schemaTypes = description.types;

      if (schemaTypes.length > 0)
        selectedType = schemaTypes[0];
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  });

  /*** HELPER ------------------------------------------- ***/

  function annotationEntries(a: Record<string, string> | undefined): Array<[string, string]> {
    return a ? Object.entries(a) : [];
  }

  function selectType(type: SchemaTypeDescription) {
    selectedType = type;
  }
</script>

<style lang="scss">
  @use "@inc/uchu/scss" as *;
  @use "../../styles/mixins" as *;

  .schema-browser {
    display: flex;
    gap: calc(var(--grid-unit) * 3);
  }

  .schema-sidebar {
    width: 300px; height: 80vh;

    border-bottom: 1px solid var(--uchu-gray-1);
    display: flex;
    flex-direction: column;
    overflow: hidden;

    .sidebar-header {
      .search-input {
        border-color: $uchu-gray-1;
        width: 100%;
      }
    }

    .type-list {
      flex: 1;
      overflow-y: auto;
      padding-bottom: var(--grid-unit);
      padding-top: var(--grid-unit);
    }

    .type-item {
      align-items: center;
      background-color: oklch(var(--uchu-gray-1-raw) / 30%);
      border: 1px solid var(--uchu-gray-1);
      border-image-slice: 1;
      cursor: pointer;
      display: flex;
      font-family: var(--font-mono);
      font-size: 0.875rem;
      gap: var(--grid-unit);
      padding: var(--grid-unit) var(--grid-unit) var(--grid-unit) calc(var(--grid-unit) * 2);
      position: relative;
      text-align: left;
      transition: all var(--transition-fast);
      width: 100%;

      &:not(:last-of-type) {
        margin-bottom: calc(var(--grid-unit) * 0.5);
      }

      &:hover {
        background-color: var(--uchu-gray-1);
        border-image-source: linear-gradient(
          to right,
          var(--uchu-gray-2),
          var(--uchu-gray-2) 1%,
          var(--uchu-gray-1) 1%,
          var(--uchu-gray-1) 99%,
          var(--uchu-gray-2) 99%,
          var(--uchu-gray-2)
        );
      }

      /* @include glow(var(--color-primary-rgb), 0.2); */

      &.active {
        background-color: var(--uchu-gray-1);
        border-image-source: linear-gradient(
          to right,
          var(--uchu-gray-2),
          var(--uchu-gray-2) 2%,
          var(--uchu-gray-1) 2%,
          var(--uchu-gray-1) 98%,
          var(--uchu-gray-2) 98%,
          var(--uchu-gray-2)
        );
      }

      .type-name {
        flex: 1;
      }

      .type-count {
        background-color: var(--uchu-yin-1);
        font-size: 0.75rem;
        padding: 2px 6px;
      }
    }
  }

  .schema-details {
    flex: 1;

    .type-header {
      align-items: center;
      display: flex;
      justify-content: space-between;
      line-height: 1;
      margin-bottom: calc(var(--grid-unit) * 2.25);

      h1 {
        font-size: 1.5rem;

        span {
          color: var(--uchu-yin-3);
        }
      }

      .type-meta {
        display: flex;
        flex-wrap: wrap;
        gap: var(--grid-unit);
      }

      .meta-tag {
        font-family: var(--font-mono);
        font-size: 0.75rem;
        text-transform: uppercase;

        &.abstract {
          color: var(--uchu-purple-4);
        }

        &.enum {
          color: var(--uchu-blue-4);
        }

        span {
          opacity: 0.3;
          pointer-events: none;

          &:first-of-type {
            padding-right: 0.5ch;
          }

          &:last-of-type {
            padding-left: 0.5ch;
          }
        }
      }
    }

    section {
      margin-bottom: calc(var(--grid-unit) * 4);
    }

    .property-item,
    .link-item {
      font-family: var(--font-mono);
      font-size: 0.875rem;
      position: relative;

      &:not(:first-of-type) {
        padding-top: var(--grid-unit);
      }

      &:not(:last-of-type) {
        padding-bottom: var(--grid-unit);

        &::after {
          width: 100%; height: 1px;
          bottom: -1px; left: 0;

          background-color: var(--uchu-gray-1);
          content: "";
          position: absolute;
        }
      }
    }

    .link-item {
      align-items: center;
      display: flex;
      gap: calc(var(--grid-unit) * 2);
    }

    .property-row {
      align-items: center;
      display: flex;
      gap: calc(var(--grid-unit) * 2);
      position: relative;
    }

    .constraint-list {
      display: flex;
      flex-wrap: wrap;
      gap: calc(var(--grid-unit) * 0.75);
      margin-left: calc(200px + calc(var(--grid-unit) * 2));
      margin-top: calc(var(--grid-unit) * 0.5);
    }

    .constraint {
      color: var(--uchu-purple-3);
      font-size: 0.7rem;
    }

    .annotation {
      font-size: 0.75rem;
      margin-left: 200px;
      margin-top: calc(var(--grid-unit) * 0.5);
    }

    .entry-list {
      display: flex;
      flex-direction: column;
      gap: var(--grid-unit);
    }

    .enum-values-list {
      display: flex;
      flex-wrap: wrap;
      gap: var(--grid-unit);
    }

    .enum-value {
      background-color: oklch(var(--uchu-blue-1-raw) / 30%);
      color: var(--uchu-blue-9);
      font-family: var(--font-mono);
      font-size: 0.75rem;
      padding: 2px 8px;
    }

    .index-expr,
    .policy-expr {
      display: block;
      font-family: var(--font-mono);
      font-size: 0.875rem;
      font-weight: 500;
    }

    .index-expr {
      span {
        color: var(--uchu-gray-3);
        font-weight: normal;
        pointer-events: none;
      }
    }

    .property-name,
    .link-name {
      font-weight: 500;
      min-width: 200px;
    }

    .link-arrow {
      color: var(--uchu-gray-3);
    }

    .property-flags {
      display: flex;
      gap: var(--grid-unit);
      margin-left: auto;
    }

    .flag {
      font-size: 0.75rem;
      padding: 2px 8px;
      text-transform: uppercase;

      &.computed {
        background-color: oklch(var(--uchu-blue-2-raw) / 50%);
        color: var(--uchu-blue-9);
      }

      &.default {
        background-color: oklch(var(--uchu-gray-2-raw) / 50%);
        color: var(--uchu-gray-9);
      }

      &.readonly {
        background-color: oklch(var(--uchu-yellow-2-raw) / 50%);
        color: var(--uchu-yellow-9);
      }

      &.required {
        background-color: oklch(var(--uchu-red-1-raw) / 50%);
        color: var(--uchu-red-9);
      }

      &.multi {
        background-image: linear-gradient(to top right, var(--uchu-pink-2), var(--uchu-yellow-2), var(--uchu-gray-2));
        color: var(--uchu-yin-9);
      }
    }

    .empty-state {
      align-items: center;
      /* color: var(--color-text-dim); */
      display: flex;
      flex-direction: column;
      justify-content: center;
      height: 100%;

      .empty-icon {
        /* color: var(--color-primary); */
        font-size: 4rem;
        margin-bottom: calc(var(--grid-unit) * 2);
        opacity: 0.2;
      }

      p {
        font-family: var(--font-mono);
        font-size: 0.875rem;
        letter-spacing: 0.05rem;
        text-transform: uppercase;
      }
    }
  }
</style>

<svelte:head>
  <title>Disc &bull; Schema Viewer</title>
</svelte:head>

<div class="schema-browser">
  <aside class="schema-sidebar">
    <div class="sidebar-header">
      <h5 style="--ch: 12ch;">Object Types</h5>
      <input
        class="search-input"
        name="object type search"
        placeholder="Search types…"
        type="text"
        bind:value={searchQuery}/>
    </div>

    <div class="type-list">
      {#each filteredTypes as type}
        <button
          class="type-item"
          class:active={selectedType?.name === type.name}
          on:click={() => selectType(type)}>
          <span class="type-name">{type.name}</span>
          <span class="type-count">
            {type.kind === "enum" ?
              (type.enumValues?.length ?? 0) :
              type.properties.length + type.links.length}
          </span>
        </button>
      {/each}
    </div>
  </aside>

  <div class="schema-details">
    {#if selectedType}
      <h5 style="--ch: 13ch;">Object Detail</h5>

      <div class="type-header">
        <h1>{#if selectedType.module !== "default"}<span>{selectedType.module}::</span>{/if}{selectedType.name}</h1>

        <div class="type-meta">
          {#if selectedType.module}
            <span class="meta-tag"><span>[</span>module: {selectedType.module}<span>]</span></span>
          {/if}

          {#if selectedType.kind !== 'object'}
            <span class="meta-tag enum"><span>[</span>{selectedType.kind}<span>]</span></span>
          {/if}

          {#if selectedType.abstract}
            <span class="meta-tag abstract"><span>[</span>abstract<span>]</span></span>
          {/if}

          {#if selectedType.parentTypes.length > 0}
            <span class="meta-tag"><span>[</span>extends {selectedType.parentTypes.join(", ")}<span>]</span></span>
          {/if}
        </div>
      </div>

      <div class="type-sections">
        {#if selectedType.kind === "enum" && selectedType.enumValues && selectedType.enumValues.length > 0}
          <section class="enum-values-section">
            <h5 style="--ch: 6ch;">Values</h5>

            <div class="enum-values-list">
              {#each selectedType.enumValues as value}
                <code class="enum-value">{value}</code>
              {/each}
            </div>
          </section>
        {/if}

        {#if selectedType.properties.length > 0}
          <section class="properties-section">
            <h5 style="--ch: 10ch;">Properties</h5>

            <div class="properties-list">
              {#each selectedType.properties as prop}
                <div class="property-item">
                  <div class="property-row">
                    <span class="property-name">{prop.name}</span>
                    <span class="property-type">{prop.type}</span>

                    <div class="property-flags">
                      {#if prop.readonly}
                        <span class="flag readonly">readonly</span>
                      {/if}

                      {#if prop.required}
                        <span class="flag required">required</span>
                      {/if}

                      {#if prop.computed}
                        <span class="flag computed">computed</span>
                      {/if}

                      {#if prop.hasDefault}
                        <span class="flag default">default</span>
                      {/if}
                    </div>
                  </div>

                  {#if prop.constraints && prop.constraints.length > 0}
                    <div class="constraint-list">
                      {#each prop.constraints as c}
                        <code class="constraint">{c}</code>
                      {/each}
                    </div>
                  {/if}

                  {#each annotationEntries(prop.annotations) as [k, v]}
                    <div class="annotation"><code>@{k}</code>: {v}</div>
                  {/each}
                </div>
              {/each}
            </div>
          </section>
        {/if}

        {#if selectedType.links.length > 0}
          <section class="links-section">
            <h5 style="--ch: 5ch;">Links</h5>

            <div class="links-list">
              {#each selectedType.links as link}
                <div class="link-item">
                  <span class="link-name">{link.name}</span>
                  <span class="link-arrow">→</span>
                  <span class="link-target">{link.target}</span>

                  {#if link.readonly}
                    <span class="flag readonly">readonly</span>
                  {/if}

                  {#if link.cardinality === "multi"}
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

        {#if selectedType.indexes.length > 0}
          <section class="indexes-section">
            <h5 style="--ch: 7ch;">Indexes</h5>

            <div class="entry-list">
              {#each selectedType.indexes as idx}
                <span class="index-expr">
                  {idx.name ? `${idx.name}: ` : ""}
                  {#each idx.columns as idxc, i}
                    {idxc}{#if i + 1 < idx.columns.length}<span>,&nbsp;</span>{/if}
                  {/each}
                </span>
              {/each}
            </div>
          </section>
        {/if}

        {#if selectedType.accessPolicies.length > 0}
          <section class="policies-section">
            <h5 style="--ch: 15ch;">Access Policies</h5>

            <div class="entry-list">
              {#each selectedType.accessPolicies as policy}
                <span class="policy-expr">{policy}</span>
              {/each}
            </div>
          </section>
        {/if}

        {#if annotationEntries(selectedType.annotations).length > 0}
          <section class="annotations-section">
            <h5 style="--ch: 11ch;">Annotations</h5>

            <div class="entry-list">
              {#each annotationEntries(selectedType.annotations) as [k, v]}
                <div class="annotation"><code>@{k}</code>: {v}</div>
              {/each}
            </div>
          </section>
        {/if}
      </div>
    {:else if loading}
      <div class="empty-state">
        <p>Loading…</p>
      </div>
    {:else if loadError}
      <div class="empty-state error">
        <p>{loadError}</p>
      </div>
    {:else}
      <div class="empty-state">
        <span class="empty-icon">◈</span>
        <p>Select a type to view details</p>
      </div>
    {/if}
  </div>
</div>
