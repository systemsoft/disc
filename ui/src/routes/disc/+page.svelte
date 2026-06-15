<script lang="ts">
  /*** IMPORT ------------------------------------------- ***/

  import { onMount } from "svelte";

  /*** UTILITY ------------------------------------------ ***/

  import {
    discAPI,
    type SchemaLinkDescription,
    type SchemaTypeDescription,
  } from "$lib/api/client";

  import { layoutDisc, type OrbitalPoint } from "$lib/identity-disc-layout";

  /*** The identity-disc metaphor taken seriously: a row’s outgoing links and incoming references rendered as
       a literal disc — the centered object at the middle, links radiating outward, linked objects
       orbiting at the rim. Click an orbital to recenter on that object; breadcrumb tracks recent
       centers so navigation is reversible.

       Outgoing links read from the centered object’s own row (one query). Incoming references are
       discovered by walking the schema for any (SourceType, linkName) pair whose link targets the
       centered type; each such pair becomes one orbital cluster fetched via a forward filter
       (`select Source filter .linkName.id = <uuid>$id`) so the backlink syntax stays out of the
       request layer. ***/

  interface OrbitalCluster {
    /** What the orbital represents — outgoing means "I link to that"; incoming means "they link to me". */
    direction: "outgoing" | "incoming";
    /** Edge label drawn along the radius. */
    edgeLabel: string;
    /** First-of-cluster object id used as the click target. Empty if the cluster is itself empty. */
    primaryId: string;
    primaryLabel: string;
    /** Type name to navigate to when the orbital is clicked. */
    targetType: string;
    /** Total cluster size (e.g. 12 multi-linked posts). 1 means no badge. */
    totalCount: number;
  }

  interface Crumb {
    id: string;
    label: string;
    type: string;
  }

  interface DiscData {
    clusters: OrbitalCluster[];
    id: string;
    label: string;
    type: string;
  }

  const RADIUS = 220;
  const SVG_SIZE = 600;
  const CENTER = SVG_SIZE / 2;
  let breadcrumb: Crumb[] = [];
  let discData: DiscData | null = null;
  let lastSelectedType = "";
  let loadError = "";
  let loadingDisc = false;
  let loadingSchema = true;
  let objectList: Array<{ id: string; label: string }> = [];
  let selectedObjectId = "";
  let selectedType = "";
  let typeIndex: Record<string, SchemaTypeDescription> = {};
  let types: SchemaTypeDescription[] = [];

  /*** RUNTIME ------------------------------------------ ***/

  $: if (selectedType !== lastSelectedType) {
    lastSelectedType = selectedType;
    objectList = [];
    selectedObjectId = "";

    if (selectedType)
      void loadObjectList(selectedType);
  }

  $: incomingCount = discData?.clusters.filter((c) => c.direction === "incoming").length ?? 0;
  $: outgoingCount = discData?.clusters.filter((c) => c.direction === "outgoing").length ?? 0;
  $: layout = layoutDisc({ cx: CENTER, cy: CENTER, radius: RADIUS, outgoingCount, incomingCount });

  /*** Pair clusters with their layout points in source order. ***/
  $: positionedClusters = (() => {
    if (!discData)
      return [];

    const out: Array<{ cluster: OrbitalCluster; pt: OrbitalPoint }> = [];
    let ii = 0;
    let oi = 0;

    for (const c of discData.clusters) {
      const pt = c.direction === "outgoing" ? layout.outgoing[oi++] : layout.incoming[ii++];

      if (pt)
        out.push({ cluster: c, pt });
    }

    return out;
  })();

  onMount(async () => {
    const schema = await discAPI.getSchema();
    types = schema.types.filter((t) => !t.abstract);
    typeIndex = Object.fromEntries(types.map((t) => [t.name, t]));

    if (types.length > 0)
      selectedType = qualify(types[0]);

    loadingSchema = false;
  });

  /*** HELPER ------------------------------------------- ***/

  /** Module-stripped name for display in the cramped disc nodes. */
  function bare(ref: string): string {
    return ref.includes("::") ? ref.split("::")[1] : ref;
  }

  function findIncomingPairs(center: SchemaTypeDescription): Array<{ source: SchemaTypeDescription; link: SchemaLinkDescription }> {
    const pairs: Array<{ source: SchemaTypeDescription; link: SchemaLinkDescription }> = [];

    for (const t of types) {
      for (const link of t.links) {
        /*** link.target may be bare or qualified; resolve before comparing so cross-module
             references aren’t missed (`default::User` vs `User`). ***/
        const resolved = findType(link.target);

        if (resolved && resolved.module === center.module && resolved.name === center.name)
          pairs.push({ source: t, link });
      }
    }

    return pairs;
  }

  /*** Type names arrive bare with the module carried separately, but link targets arrive qualified
       for cross-module links. Resolve either form to its loaded type, and always re-qualify before
       a query so non-default modules compile. (Mirrors the data viewer.) ***/
  function findType(ref: string): SchemaTypeDescription | undefined {
    if (ref.includes("::")) {
      const [mod, name] = ref.split("::");
      return types.find((t) => t.module === mod && t.name === name);
    }

    return typeIndex[ref] ?? types.find((t) => t.name === ref);
  }

  async function loadDisc(typeName: string, id: string) {
    const type = findType(typeName);
    loadingDisc = true;
    loadError = "";
    discData = null;

    if (!type) {
      loadError = `Type ${JSON.stringify(typeName)} is not in the current schema.`;
      loadingDisc = false;

      return;
    }

    const centerDisplay = pickDisplayField(type);

    /*** Compose a single query that pulls the centered row + every outgoing link’s id (multi-link
         arrays come back already sized). ***/
    const linkShapes = type.links.map((l) => {
      const targetType = findType(l.target);
      const targetDisplay = pickDisplayField(targetType);

      return targetDisplay ? `${l.name}: { id, ${targetDisplay} }` : `${l.name}: { id }`;
    });

    const centerShape = ["id", ...(centerDisplay ? [centerDisplay] : []), ...linkShapes].join(", ");
    const centerQuery = `select ${qualify(type)} { ${centerShape} } filter .id = <uuid>$id limit 1`;
    const centerResult = await discAPI.executeQuery(centerQuery, { id });

    if (centerResult.error || !Array.isArray(centerResult.data) || centerResult.data.length === 0) {
      loadError = centerResult.error ?? `Object ${id} not found.`;
      loadingDisc = false;

      return;
    }

    const centerRow = centerResult.data[0];
    const centerLabel = rowLabel(centerRow, centerDisplay, id);
    const clusters: OrbitalCluster[] = [];

    /*** Outgoing — one cluster per link. ***/
    for (const link of type.links) {
      const raw = centerRow[link.name];
      const targetTypeDesc = findType(link.target);
      const targetDisplay = pickDisplayField(targetTypeDesc);
      /*** Carry a qualified, resolvable name so the click handler can recenter. ***/
      const targetRef = targetTypeDesc ? qualify(targetTypeDesc) : link.target;

      if (link.cardinality === "multi") {
        const arr = Array.isArray(raw) ? raw : [];
        const first = arr[0];
        /*** Skip empty multi-links and any entry without a real id — a missing record must not
             render as an "undefined" orbital. ***/
        if (!first || typeof first.id !== "string")
          continue;

        clusters.push({
          direction: "outgoing",
          edgeLabel: link.name,
          primaryId: first.id,
          primaryLabel: rowLabel(first, targetDisplay, first.id),
          targetType: targetRef,
          totalCount: arr.length
        });
      } else {
        /*** Single links come back wrapped in a one-element array; unwrap it. ***/
        const obj = Array.isArray(raw) ? raw[0] : raw;

        if (!obj || typeof obj.id !== "string")
          continue; /*** skip null/undefined single links ***/

        clusters.push({
          direction: "outgoing",
          edgeLabel: link.name,
          primaryId: obj.id,
          primaryLabel: rowLabel(obj, targetDisplay, obj.id),
          targetType: targetRef,
          totalCount: 1
        });
      }
    }

    /*** Incoming — schema-walk every type that links here, run one filter per pair. ***/
    const incomingPairs = findIncomingPairs(type);

    await Promise.all(
      incomingPairs.map(async ({ source, link }) => {
        const sourceDisplay = pickDisplayField(source);
        const shape = sourceDisplay ? `{ id, ${sourceDisplay} }` : `{ id }`;
        const q = `select ${qualify(source)} ${shape} filter .${link.name}.id = <uuid>$id limit 6`;
        const r = await discAPI.executeQuery(q, { id });

        if (r.error || !Array.isArray(r.data) || r.data.length === 0)
          return;

        const first = r.data[0];

        if (!first || typeof first.id !== "string")
          return; /*** skip records without a real id ***/

        clusters.push({
          direction: "incoming",
          edgeLabel: `${source.name}.${link.name}`,
          primaryId: first.id,
          primaryLabel: rowLabel(first, sourceDisplay, first.id),
          targetType: qualify(source),
          totalCount: r.data.length
        });
      }),
    );

    discData = {
      clusters,
      id,
      label: centerLabel,
      type: typeName
    };

    loadingDisc = false;
  }

  async function loadObjectList(typeRef: string) {
    const type = findType(typeRef);

    if (!type) {
      objectList = [];
      return;
    }

    const display = pickDisplayField(type);
    const shape = display ? `{ id, ${display} }` : `{ id }`;
    const query = `select ${qualify(type)} ${shape} limit 25`;
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

  function navigateBack() {
    if (breadcrumb.length === 0)
      return;

    const prev = breadcrumb[breadcrumb.length - 1];
    breadcrumb = breadcrumb.slice(0, -1);
    void loadDisc(prev.type, prev.id);
  }

  function navigateTo(targetType: string, targetId: string) {
    if (discData) {
      breadcrumb = [...breadcrumb, {
        id: discData.id,
        label: discData.label,
        type: discData.type
      }];
    }

    void loadDisc(targetType, targetId);
  }

  function pickDisplayField(type: SchemaTypeDescription | undefined): string | null {
    if (!type)
      return null;

    const preferred = ["name", "title", "email", "label"];

    for (const n of preferred) {
      if (type.properties.some((p) => p.name === n))
        return n;
    }

    return null;
  }

  function qualify(type: SchemaTypeDescription): string {
    return `${type.module}::${type.name}`;
  }

  function rowLabel(row: any, displayField: string | null, fallbackId: string): string {
    if (displayField && row && typeof row[displayField] === "string")
      return row[displayField];

    if (row && typeof row.id === "string")
      return row.id.slice(0, 8) + "…";

    return fallbackId.slice(0, 8) + "…";
  }

  function selectObject() {
    if (selectedType && selectedObjectId) {
      breadcrumb = [];
      void loadDisc(selectedType, selectedObjectId);
    }
  }
</script>

<style lang="scss">
  @use "@inc/uchu/scss" as *;
  @use "../../styles/mixins" as *;

  .identity-disc {
    display: flex;
    gap: calc(var(--grid-unit) * 3);
  }

  .sidebar {
    width: 300px; height: 80vh;

    border-bottom: 1px solid var(--uchu-gray-1);
    display: flex;
    flex-direction: column;
    overflow: hidden;

    h5:not(:first-of-type) {
      margin-top: calc(var(--grid-unit) * 2.5);
    }

    select {
      border-color: var(--uchu-gray-1);
    }

    button {
      font-family: var(--font-mono);
      font-size: 0.75rem;
      text-transform: uppercase;
    }

    .breadcrumb {
      font-family: var(--font-mono);
      font-size: 0.75rem;
      line-height: 1.33;
      padding-bottom: var(--grid-unit);
      padding-top: var(--grid-unit);

      .crumb-sep {
        color: var(--uchu-yin-3);
        margin-left: var(--grid-unit);
        margin-right: var(--grid-unit);
      }
    }
  }

  .details {
    flex: 1;
    font-family: var(--font-mono);
  }

  .canvas-wrap {
    @include grid-lines();
    align-items: center;
    /* background-color: var(--color-surface); */
    background-color: var(--uchu-yin);
    display: flex;
    justify-content: center;
    min-height: 640px;
    padding: calc(var(--grid-unit) * 2);
  }

  .disc-svg {
    width: 100%; height: auto;
    max-width: 700px;

    .text {
      pointer-events: none;
      user-select: none;
    }
  }

  .ring-mid,
  .ring-outer {
    fill: none;
    stroke: rgb(var(--color-primary-rgb) / 0.15);
    stroke-dasharray: 4 6;
    stroke-width: 1;
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
    fill: var(--uchu-yin-3);
    /* font-family: var(--font-mono); */
    font-size: 11px;
    pointer-events: none;
    user-select: none;
  }

  .orbital {
    cursor: pointer;

    &:not(:focus):not(:hover) {
      .orbital-bg {
        fill: var(--color-bg);
      }
    }

    &:focus,
    &:hover {
      .orbital-bg {
        fill: rgb(var(--color-primary-rgb) / 0.15);
      }
    }

    &:focus {
      outline: none;
    }

    .orbital-bg {
      stroke-width: 2;
      transition: fill 0.15s, stroke 0.15s;

      &:not(.orbital-incoming) {
        stroke: rgb(var(--color-primary-rgb));
      }

      &.orbital-incoming {
        stroke: rgb(var(--color-warning-rgb, 255 200 0));
      }
    }

    .orbital-type {
      fill: rgb(var(--color-primary-rgb));
      font-size: 11px;
      font-weight: 600;
    }

    .orbital-label {
      fill: var(--color-text);
      font-size: 10px;
    }
  }

  .badge-bg {
    fill: rgb(var(--color-primary-rgb));
  }

  .badge-text {
    fill: var(--color-bg);
    /* font-family: var(--font-mono); */
    font-size: 10px;
    font-weight: 700;
    pointer-events: none;
    user-select: none;
  }

  .center-node {
    .center-bg {
      fill: rgb(var(--color-primary-rgb) / 0.1);
      filter: drop-shadow(0 0 8px rgb(var(--color-primary-rgb) / 0.6));
      stroke: rgb(var(--color-primary-rgb));
      stroke-width: 2.5;
    }

    .center-type {
      fill: rgb(var(--color-primary-rgb));
      /* font-family: var(--font-mono); */
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.05rem;
    }

    .center-label {
      fill: var(--color-text);
      /* font-family: var(--font-mono); */
      font-size: 11px;
    }
  }

  .run-error {
    background-color: oklch(var(--uchu-red-1-raw) / 20%);
    color: var(--uchu-red-5);
    /* font-family: var(--font-mono); */
    margin-bottom: calc(var(--grid-unit) * 2);
    padding: calc(var(--grid-unit) * 1.5);
  }

  .empty,
  .loading {
    color: var(--uchu-yin-3);
    padding: calc(var(--grid-unit) * 4);
    text-align: center;
  }
</style>

<svelte:head>
  <title>Disc &bull; Identity Disc</title>
</svelte:head>

<div class="identity-disc">
  <aside class="sidebar">
    <h5 style="--ch: 11ch;">Object Type</h5>

    <select bind:value={selectedType}>
      {#each types as t}
        <option value={qualify(t)}>{t.name}</option>
      {/each}
    </select>

    <h5 style="--ch: 11ch;">Object Data</h5>

    <select bind:value={selectedObjectId} disabled={objectList.length === 0}>
      <option value="">Select data</option>
      {#each objectList as obj}
        <option value={obj.id}>{obj.label}</option>
      {/each}
    </select>

    <h5 style="--ch: 16ch;">Object Controls</h5>

    <button
      class="button primary"
      disabled={!selectedObjectId}
      onclick={selectObject}>Show disc</button>

    {#if breadcrumb.length > 0}
      <h5 style="--ch: 12ch;">Breadcrumbs</h5>
      <button class="button small" onclick={navigateBack}>← Back ({breadcrumb.length})</button>

      <div class="breadcrumb">
        {#each breadcrumb as crumb, i}
          <span class="crumb">{bare(crumb.type)}: {crumb.label}</span>{#if i < breadcrumb.length - 1}<span class="crumb-sep"> → </span>{/if}
        {/each}
      </div>
    {/if}
  </aside>

  <div class="details">
    {#if loadingSchema}
      <p class="loading">Loading schema…</p>
    {:else}
      {#if loadError}
        <div class="run-error"><strong>Error:</strong> {loadError}</div>
      {/if}

      <div class="canvas-wrap">
        {#if !discData && !loadingDisc}
          <p class="empty">Select data to render its disc.</p>
        {:else if loadingDisc}
          <p class="loading">Loading disc…</p>
        {:else if discData}
          <svg
            aria-label="Identity disc visualization"
            class="disc-svg"
            role="img"
            viewBox="0 0 {SVG_SIZE} {SVG_SIZE}">
            <circle class="ring-outer" cx={CENTER} cy={CENTER} r={RADIUS}/>
            <circle class="ring-mid" cx={CENTER} cy={CENTER} r={RADIUS * 0.66}/>

            <!-- Edges: line from center to each orbital -->
            {#each positionedClusters as { cluster, pt }}
              <line
                class="edge"
                class:edge-incoming={cluster.direction === "incoming"}
                class:edge-outgoing={cluster.direction === "outgoing"}
                x1={CENTER}
                y1={CENTER}
                x2={pt.x}
                y2={pt.y}/>
              <text
                class="edge-label text"
                text-anchor="middle"
                x={(CENTER + pt.x) / 2}
                y={(CENTER + pt.y) / 2 - 6}>{cluster.edgeLabel}</text>
            {/each}

            <!-- Orbital nodes -->
            {#each positionedClusters as { cluster, pt }}
              <g
                class="orbital"
                onclick={() => navigateTo(cluster.targetType, cluster.primaryId)}
                onkeydown={(e) => e.key === "Enter" && navigateTo(cluster.targetType, cluster.primaryId)}
                role="button"
                tabindex="0">
                <circle
                  class="orbital-bg"
                  class:orbital-incoming={cluster.direction === "incoming"}
                  cx={pt.x}
                  cy={pt.y}
                  r="28"/>
                <text
                  class="orbital-type text"
                  text-anchor="middle"
                  x={pt.x}
                  y={pt.y - 2}>{bare(cluster.targetType)}</text>
                <text
                  class="orbital-label text"
                  text-anchor="middle"
                  x={pt.x}
                  y={pt.y + 12}>{cluster.primaryLabel}</text>
                {#if cluster.totalCount > 1}
                  <g>
                    <circle
                      class="badge-bg"
                      cx={pt.x + 22}
                      cy={pt.y - 22}
                      r="10"/>
                    <text
                      class="badge-text text"
                      text-anchor="middle"
                      x={pt.x + 22}
                      y={pt.y - 18}>+{cluster.totalCount - 1}</text>
                  </g>
                {/if}
              </g>
            {/each}

            <!-- Center node (rendered last so it sits on top) -->
            <g class="center-node">
              <circle class="center-bg" cx={CENTER} cy={CENTER} r="46"/>
              <text class="center-type text" text-anchor="middle" x={CENTER} y={CENTER - 6}>{bare(discData.type)}</text>
              <text class="center-label text" text-anchor="middle" x={CENTER} y={CENTER + 14}>{discData.label}</text>
            </g>
          </svg>

          {#if discData.clusters.length === 0}
            <p class="empty">No outgoing links or incoming references.</p>
          {/if}
        {/if}
      </div>
    {/if}
  </div>
</div>
