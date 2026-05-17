/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

<script lang="ts">
  import { onMount } from 'svelte';
  import {
    discAPI,
    type SchemaLinkDescription,
    type SchemaTypeDescription,
  } from '$lib/api/client';
  import { layoutDisc, type OrbitalPoint } from '$lib/identity-disc-layout';

  // Disc-original feature #3d — identity-disc visualization.
  //
  // The TRON metaphor taken seriously: a row's outgoing links and
  // incoming references rendered as a literal disc — the centered
  // object at the middle, links radiating outward, linked objects
  // orbiting at the rim. Click an orbital to recenter on that object;
  // breadcrumb tracks recent centers so navigation is reversible.
  //
  // Outgoing links read from the centered object's own row (one query).
  // Incoming references are discovered by walking the schema for any
  // (SourceType, linkName) pair whose link targets the centered type;
  // each such pair becomes one orbital cluster fetched via a forward
  // filter (`select Source filter .linkName.id = <uuid>$id`) so the
  // backlink syntax stays out of the request layer.

  interface OrbitalCluster {
    /** What the orbital represents — outgoing means "I link to that"; incoming means "they link to me". */
    direction: 'outgoing' | 'incoming';
    /** Edge label drawn along the radius. */
    edgeLabel: string;
    /** Type name to navigate to when the orbital is clicked. */
    targetType: string;
    /** First-of-cluster object id used as the click target. Empty if the cluster is itself empty. */
    primaryId: string;
    primaryLabel: string;
    /** Total cluster size (e.g. 12 multi-linked posts). 1 means no badge. */
    totalCount: number;
  }

  interface DiscData {
    type: string;
    id: string;
    label: string;
    clusters: OrbitalCluster[];
  }

  interface Crumb {
    type: string;
    id: string;
    label: string;
  }

  let types: SchemaTypeDescription[] = [];
  let typeIndex: Record<string, SchemaTypeDescription> = {};
  let loadingSchema = true;

  let selectedType = '';
  let objectList: Array<{ id: string; label: string }> = [];
  let selectedObjectId = '';

  let discData: DiscData | null = null;
  let loadingDisc = false;
  let loadError = '';
  let breadcrumb: Crumb[] = [];

  // SVG dimensions.
  const SVG_SIZE = 600;
  const CENTER = SVG_SIZE / 2;
  const RADIUS = 220;

  function pickDisplayField(type: SchemaTypeDescription | undefined): string | null {
    if (!type) return null;
    const preferred = ['name', 'title', 'email', 'label'];
    for (const n of preferred) {
      if (type.properties.some((p) => p.name === n)) return n;
    }
    return null;
  }

  function rowLabel(row: any, displayField: string | null, fallbackId: string): string {
    if (displayField && row && typeof row[displayField] === 'string') return row[displayField];
    if (row && typeof row.id === 'string') return row.id.slice(0, 8) + '…';
    return fallbackId.slice(0, 8) + '…';
  }

  onMount(async () => {
    const schema = await discAPI.getSchema();
    types = schema.types.filter((t) => !t.abstract);
    typeIndex = Object.fromEntries(types.map((t) => [t.name, t]));
    if (types.length > 0) selectedType = types[0].name;
    loadingSchema = false;
  });

  let lastSelectedType = '';
  $: if (selectedType !== lastSelectedType) {
    lastSelectedType = selectedType;
    objectList = [];
    selectedObjectId = '';
    if (selectedType) void loadObjectList(selectedType);
  }

  async function loadObjectList(typeName: string) {
    const type = typeIndex[typeName];
    const display = pickDisplayField(type);
    const shape = display ? `{ id, ${display} }` : `{ id }`;
    const query = `select ${typeName} ${shape} limit 25`;
    const result = await discAPI.executeQuery(query);
    if (result.error || !Array.isArray(result.data)) {
      objectList = [];
      return;
    }
    objectList = result.data.map((row: any) => ({
      id: String(row.id),
      label: rowLabel(row, display, String(row.id)),
    }));
  }

  function findIncomingPairs(typeName: string): Array<{ sourceType: string; link: SchemaLinkDescription }> {
    const pairs: Array<{ sourceType: string; link: SchemaLinkDescription }> = [];
    for (const t of types) {
      for (const link of t.links) {
        if (link.target === typeName) pairs.push({ sourceType: t.name, link });
      }
    }
    return pairs;
  }

  async function loadDisc(typeName: string, id: string) {
    loadingDisc = true;
    loadError = '';
    discData = null;

    const type = typeIndex[typeName];
    if (!type) {
      loadError = `Type ${JSON.stringify(typeName)} is not in the current schema.`;
      loadingDisc = false;
      return;
    }
    const centerDisplay = pickDisplayField(type);

    // Compose a single query that pulls the centered row + every
    // outgoing link's id (multi-link arrays come back already sized).
    const linkShapes = type.links.map((l) => {
      const targetType = typeIndex[l.target];
      const targetDisplay = pickDisplayField(targetType);
      return targetDisplay ? `${l.name}: { id, ${targetDisplay} }` : `${l.name}: { id }`;
    });
    const centerShape = ['id', ...(centerDisplay ? [centerDisplay] : []), ...linkShapes].join(', ');
    const centerQuery = `select ${typeName} { ${centerShape} } filter .id = <uuid>$id limit 1`;
    const centerResult = await discAPI.executeQuery(centerQuery, { id });
    if (centerResult.error || !Array.isArray(centerResult.data) || centerResult.data.length === 0) {
      loadError = centerResult.error ?? `Object ${id} not found.`;
      loadingDisc = false;
      return;
    }
    const centerRow = centerResult.data[0];
    const centerLabel = rowLabel(centerRow, centerDisplay, id);

    const clusters: OrbitalCluster[] = [];

    // Outgoing — one cluster per link.
    for (const link of type.links) {
      const raw = centerRow[link.name];
      const targetTypeDesc = typeIndex[link.target];
      const targetDisplay = pickDisplayField(targetTypeDesc);
      if (link.cardinality === 'multi') {
        const arr = Array.isArray(raw) ? raw : [];
        if (arr.length === 0) continue; // skip empty multi-link orbitals
        const first = arr[0];
        clusters.push({
          direction: 'outgoing',
          edgeLabel: link.name,
          targetType: link.target,
          primaryId: String(first.id),
          primaryLabel: rowLabel(first, targetDisplay, String(first.id)),
          totalCount: arr.length,
        });
      } else {
        if (!raw) continue; // skip null single links
        clusters.push({
          direction: 'outgoing',
          edgeLabel: link.name,
          targetType: link.target,
          primaryId: String(raw.id),
          primaryLabel: rowLabel(raw, targetDisplay, String(raw.id)),
          totalCount: 1,
        });
      }
    }

    // Incoming — schema-walk every type that links here, run one filter per pair.
    const incomingPairs = findIncomingPairs(typeName);
    await Promise.all(
      incomingPairs.map(async ({ sourceType, link }) => {
        const sourceTypeDesc = typeIndex[sourceType];
        const sourceDisplay = pickDisplayField(sourceTypeDesc);
        const shape = sourceDisplay ? `{ id, ${sourceDisplay} }` : `{ id }`;
        const q = `select ${sourceType} ${shape} filter .${link.name}.id = <uuid>$id limit 6`;
        const r = await discAPI.executeQuery(q, { id });
        if (r.error || !Array.isArray(r.data) || r.data.length === 0) return;
        const first = r.data[0];
        clusters.push({
          direction: 'incoming',
          edgeLabel: `${sourceType}.${link.name}`,
          targetType: sourceType,
          primaryId: String(first.id),
          primaryLabel: rowLabel(first, sourceDisplay, String(first.id)),
          totalCount: r.data.length,
        });
      }),
    );

    discData = { type: typeName, id, label: centerLabel, clusters };
    loadingDisc = false;
  }

  function selectObject() {
    if (selectedType && selectedObjectId) {
      breadcrumb = [];
      void loadDisc(selectedType, selectedObjectId);
    }
  }

  function navigateTo(targetType: string, targetId: string) {
    if (discData) {
      breadcrumb = [...breadcrumb, { type: discData.type, id: discData.id, label: discData.label }];
    }
    void loadDisc(targetType, targetId);
  }

  function navigateBack() {
    if (breadcrumb.length === 0) return;
    const prev = breadcrumb[breadcrumb.length - 1];
    breadcrumb = breadcrumb.slice(0, -1);
    void loadDisc(prev.type, prev.id);
  }

  $: outgoingCount = discData?.clusters.filter((c) => c.direction === 'outgoing').length ?? 0;
  $: incomingCount = discData?.clusters.filter((c) => c.direction === 'incoming').length ?? 0;
  $: layout = layoutDisc({ cx: CENTER, cy: CENTER, radius: RADIUS, outgoingCount, incomingCount });

  // Pair clusters with their layout points in source order.
  $: positionedClusters = (() => {
    if (!discData) return [];
    const out: Array<{ cluster: OrbitalCluster; pt: OrbitalPoint }> = [];
    let oi = 0;
    let ii = 0;
    for (const c of discData.clusters) {
      const pt = c.direction === 'outgoing' ? layout.outgoing[oi++] : layout.incoming[ii++];
      if (pt) out.push({ cluster: c, pt });
    }
    return out;
  })();
</script>

<div class="identity-disc">
  <header class="page-header">
    <h1>Identity Disc</h1>
    <p class="subtitle">A row's outgoing links + incoming references, rendered as a circle. Click any orbital to recenter.</p>
  </header>

  {#if loadingSchema}
    <p class="loading">Loading schema…</p>
  {:else}
    <div class="picker-bar">
      <label>Type
        <select bind:value={selectedType}>
          {#each types as t}
            <option value={t.name}>{t.name}</option>
          {/each}
        </select>
      </label>
      <label>Object
        <select bind:value={selectedObjectId} disabled={objectList.length === 0}>
          <option value="">— pick a row —</option>
          {#each objectList as obj}
            <option value={obj.id}>{obj.label}</option>
          {/each}
        </select>
      </label>
      <button class="button primary" on:click={selectObject} disabled={!selectedObjectId}>Show disc</button>
      {#if breadcrumb.length > 0}
        <button class="button small" on:click={navigateBack}>← Back ({breadcrumb.length})</button>
      {/if}
    </div>

    {#if breadcrumb.length > 0}
      <div class="breadcrumb">
        {#each breadcrumb as crumb, i}
          <span class="crumb">{crumb.type}: {crumb.label}</span>{#if i < breadcrumb.length - 1}<span class="crumb-sep"> → </span>{/if}
        {/each}
      </div>
    {/if}

    {#if loadError}
      <div class="run-error"><strong>Error:</strong> {loadError}</div>
    {/if}

    <div class="canvas-wrap">
      {#if !discData && !loadingDisc}
        <p class="empty">Pick a row above to render its disc.</p>
      {:else if loadingDisc}
        <p class="loading">Loading disc…</p>
      {:else if discData}
        <svg viewBox="0 0 {SVG_SIZE} {SVG_SIZE}" class="disc-svg" role="img" aria-label="Identity disc visualization">
          <!-- TRON-aesthetic concentric rings -->
          <circle cx={CENTER} cy={CENTER} r={RADIUS} class="ring-outer" />
          <circle cx={CENTER} cy={CENTER} r={RADIUS * 0.66} class="ring-mid" />

          <!-- Edges: line from center to each orbital -->
          {#each positionedClusters as { cluster, pt }}
            <line
              x1={CENTER}
              y1={CENTER}
              x2={pt.x}
              y2={pt.y}
              class="edge"
              class:edge-outgoing={cluster.direction === 'outgoing'}
              class:edge-incoming={cluster.direction === 'incoming'}
            />
            <text
              x={(CENTER + pt.x) / 2}
              y={(CENTER + pt.y) / 2 - 6}
              class="edge-label"
              text-anchor="middle"
            >{cluster.edgeLabel}</text>
          {/each}

          <!-- Orbital nodes -->
          {#each positionedClusters as { cluster, pt }}
            <g class="orbital" on:click={() => navigateTo(cluster.targetType, cluster.primaryId)} on:keydown={(e) => e.key === 'Enter' && navigateTo(cluster.targetType, cluster.primaryId)} role="button" tabindex="0">
              <circle cx={pt.x} cy={pt.y} r="28" class="orbital-bg" class:orbital-incoming={cluster.direction === 'incoming'} />
              <text x={pt.x} y={pt.y - 2} class="orbital-type" text-anchor="middle">{cluster.targetType}</text>
              <text x={pt.x} y={pt.y + 12} class="orbital-label" text-anchor="middle">{cluster.primaryLabel}</text>
              {#if cluster.totalCount > 1}
                <g>
                  <circle cx={pt.x + 22} cy={pt.y - 22} r="10" class="badge-bg" />
                  <text x={pt.x + 22} y={pt.y - 18} class="badge-text" text-anchor="middle">+{cluster.totalCount - 1}</text>
                </g>
              {/if}
            </g>
          {/each}

          <!-- Center node (rendered last so it sits on top) -->
          <g class="center-node">
            <circle cx={CENTER} cy={CENTER} r="46" class="center-bg" />
            <text x={CENTER} y={CENTER - 6} class="center-type" text-anchor="middle">{discData.type}</text>
            <text x={CENTER} y={CENTER + 14} class="center-label" text-anchor="middle">{discData.label}</text>
          </g>
        </svg>

        {#if discData.clusters.length === 0}
          <p class="empty">No outgoing links or incoming references.</p>
        {/if}
      {/if}
    </div>
  {/if}
</div>

<style lang="scss">
  @use "../../styles/mixins" as *;

  .identity-disc {
    padding: calc(var(--grid-unit) * 3);
    height: 100%;
    overflow: auto;
  }

  .page-header h1 {
    margin: 0 0 calc(var(--grid-unit) * 0.5);
    @include neon-text();
  }
  .subtitle {
    margin: 0 0 calc(var(--grid-unit) * 3);
    color: var(--color-text-dim);
  }

  .picker-bar {
    display: flex;
    gap: calc(var(--grid-unit) * 2);
    align-items: flex-end;
    flex-wrap: wrap;
    margin-bottom: calc(var(--grid-unit) * 2);
    label {
      display: flex;
      flex-direction: column;
      gap: calc(var(--grid-unit) * 0.5);
      font-size: 0.85rem;
      color: var(--color-text-dim);
    }
  }

  .breadcrumb {
    margin-bottom: calc(var(--grid-unit) * 2);
    font-family: var(--font-mono);
    font-size: 0.85rem;
    color: var(--color-text-dim);
    .crumb {
      color: rgb(var(--color-primary-rgb) / 0.7);
    }
    .crumb-sep {
      margin: 0 calc(var(--grid-unit) * 0.5);
    }
  }

  .canvas-wrap {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    padding: calc(var(--grid-unit) * 2);
    @include grid-lines();
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 640px;
  }

  .disc-svg {
    width: 100%;
    max-width: 700px;
    height: auto;
  }

  .ring-outer, .ring-mid {
    fill: none;
    stroke: rgb(var(--color-primary-rgb) / 0.15);
    stroke-width: 1;
    stroke-dasharray: 4 6;
  }

  .edge {
    stroke-width: 1.5;
  }
  .edge-outgoing {
    stroke: rgb(var(--color-primary-rgb) / 0.6);
  }
  .edge-incoming {
    stroke: rgb(var(--color-warning-rgb, 255 200 0) / 0.6);
    stroke-dasharray: 4 4;
  }

  .edge-label {
    fill: var(--color-text-dim);
    font-family: var(--font-mono);
    font-size: 11px;
    pointer-events: none;
  }

  .orbital {
    cursor: pointer;
    .orbital-bg {
      fill: var(--color-bg);
      stroke: rgb(var(--color-primary-rgb));
      stroke-width: 2;
      transition: fill 0.15s, stroke 0.15s;
    }
    .orbital-bg.orbital-incoming {
      stroke: rgb(var(--color-warning-rgb, 255 200 0));
    }
    .orbital-type {
      fill: rgb(var(--color-primary-rgb));
      font-family: var(--font-mono);
      font-size: 11px;
      font-weight: 600;
      pointer-events: none;
    }
    .orbital-label {
      fill: var(--color-text);
      font-family: var(--font-mono);
      font-size: 10px;
      pointer-events: none;
    }
    &:hover .orbital-bg, &:focus .orbital-bg {
      fill: rgb(var(--color-primary-rgb) / 0.15);
    }
    &:focus { outline: none; }
  }

  .badge-bg {
    fill: rgb(var(--color-primary-rgb));
  }
  .badge-text {
    fill: var(--color-bg);
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 700;
    pointer-events: none;
  }

  .center-node {
    .center-bg {
      fill: rgb(var(--color-primary-rgb) / 0.1);
      stroke: rgb(var(--color-primary-rgb));
      stroke-width: 2.5;
      filter: drop-shadow(0 0 8px rgb(var(--color-primary-rgb) / 0.6));
    }
    .center-type {
      fill: rgb(var(--color-primary-rgb));
      font-family: var(--font-mono);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.05em;
    }
    .center-label {
      fill: var(--color-text);
      font-family: var(--font-mono);
      font-size: 11px;
    }
  }

  .run-error {
    background: rgb(var(--color-danger-rgb) / 0.1);
    border: 1px solid rgb(var(--color-danger-rgb) / 0.4);
    color: rgb(var(--color-danger-rgb));
    padding: calc(var(--grid-unit) * 1.5);
    border-radius: 3px;
    margin-bottom: calc(var(--grid-unit) * 2);
    font-family: var(--font-mono);
  }

  .empty, .loading {
    color: var(--color-text-dim);
    padding: calc(var(--grid-unit) * 4);
    text-align: center;
  }
</style>
