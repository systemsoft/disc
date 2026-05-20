<script lang="ts">
  /*** IMPORT ------------------------------------------- ***/

  import { onMount, onDestroy } from "svelte";

  /*** UTILITY ------------------------------------------ ***/

  import "../app.scss";

  import { discAPI } from "$lib/api/client";
  import favicon from "$lib/assets/disc.svg";
  import { page } from "$app/stores";

  type ConnectionStatus = "connecting" | "offline" | "online";

  const navItems = [
    { path: "/ui/schema", label: "Schema" },
    { path: "/ui/admin/schema", label: "Diff" },
    { path: "/ui/data", label: "Data" },
    { path: "/ui/query", label: "Query" },
    { path: "/ui/query-builder", label: "Builder" },
    { path: "/ui/disc", label: "Disc" },
    { path: "/ui/repl", label: "REPL" },
    { path: "/ui/migrations", label: "Migrations" },
    { path: "/ui/config", label: "Config" }
  ];

  let connectionStatus: ConnectionStatus = "connecting";
  let currentPath = "";
  let pollHandle: ReturnType<typeof setInterval> | null = null;

  /*** RUNTIME ------------------------------------------ ***/

  $: currentPath = $page.url.pathname;

  onDestroy(() => {
    if (pollHandle !== null)
      clearInterval(pollHandle);
  });

  onMount(() => {
    checkHealth();
    pollHandle = setInterval(checkHealth, 10_000);
  });

  /*** HELPER ------------------------------------------- ***/

  async function checkHealth() {
    const health = await discAPI.getHealth();

    connectionStatus = health && (health.status === "ok" || health.status === "healthy") ?
      "online" :
      "offline";
  }
</script>

<style lang="scss">
  @use "@inc/uchu/scss" as *;
  @use "../styles/mixins" as *;

  .app-layout {
    width: 100vw; height: 100vh;

    color: $uchu-yin-9;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .app-header {
    align-items: center;
    border-bottom: 1px solid $uchu-gray-1;
    display: flex;
    gap: calc(var(--grid-unit) * 4);
    padding: calc(var(--grid-unit) * 2);
    position: relative;
  }

  .main-nav {
    display: flex;
    gap: var(--grid-unit);
    flex: 1;

    .nav-item {
      align-items: center;
      display: flex;
      font-family: var(--font-mono);
      font-size: 0.875rem;
      gap: var(--grid-unit);
      letter-spacing: 0.05rem;
      padding-bottom: var(--grid-unit);
      padding-right: calc(var(--grid-unit) * 2);
      padding-top: var(--grid-unit);
      position: relative;
      text-transform: uppercase;
      transition: all var(--transition-fast);

      &:not(:first-of-type) {
        padding-left: calc(var(--grid-unit) * 2);
      }

      &:not(:last-of-type) {
        &::after {
          top: var(--grid-unit); right: calc(var(--grid-unit) * -1);

          color: $uchu-yin-3;
          content: "/";
          font-weight: normal;
          opacity: 0.2;
          position: absolute;
          width: var(--grid-unit);
        }
      }

      &:not(.active) {
        color: $uchu-yin-3;
      }

      &.active {
        color: inherit;
        font-weight: 700;
      }
    }
  }

  .connection-status {
    align-items: center;
    display: flex;
    font-family: var(--font-mono);
    font-size: 0.75rem;
    font-weight: 700;
    gap: var(--grid-unit);
    letter-spacing: 0.1rem;
    padding: calc(var(--grid-unit) / 4) calc(var(--grid-unit) * 2);
    pointer-events: none;
    text-transform: uppercase;
    user-select: none;

    &:not(.online):not(.offline) {
      background-color: $uchu-orange-4;
      color: $uchu-yin-8;
    }

    &.offline {
      background-color: $uchu-red-4;
      color: $uchu-yin-8;
    }

    &.online {
      background-color: $uchu-green-4;
      color: $uchu-yin-8;
    }
  }

  .logo {
    align-items: center;
    color: inherit;
    display: flex;
    font-family: var(--font-display);
    font-size: 1.5rem;
    font-weight: 900;
    gap: var(--grid-unit);
    letter-spacing: 0.1rem;

    svg {
      height: 2rem;
    }
  }

  .app-main {
    flex: 1;
    overflow-x: hidden;
    overflow-y: auto;
    padding: calc(var(--grid-unit) * 2);
    position: relative;
  }
</style>

<svelte:head>
  <title>Disc Viewer</title>
	<link rel="icon" href={favicon}/>
</svelte:head>

<div class="app-layout">
  <header class="app-header">
    <div class="undershirt">
      <nav class="main-nav">
        {#each navItems as item}
          <a
            class="nav-item"
            class:active={currentPath === item.path}
            href={item.path}>
            <span class="nav-label">{item.label}</span>
          </a>
        {/each}
      </nav>

      <div
        class="connection-status"
        class:online={connectionStatus === "online"}
        class:offline={connectionStatus === "offline"}>
        <span class="status-text">{connectionStatus}</span>
      </div>

      <a class="logo" href="/">
        <svg viewBox="0 0 620 200" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
          <path d="M475 55l0 -30l120 0l0 30l-120 0Zm0 90l-30 0l0 -90l30 0l0 90Zm0 0l120 0l0 30l-120 0l0 -30Zm-90 0l0 30l-120 0l0 -30l120 0Zm0 0l0 -30l-120 0l0 -60l30 0l0 30l120 0l0 60l-30 0Zm-90 -90l0 -30l120 0l0 30l-120 0Zm-150 90l0 30l-120 0l0 -150l120 0l0 30l-90 0l0 90l90 0Zm0 -90l30 0l0 90l-30 0l0 -90Zm60 120l0 -150l30 0l0 150l-30 0Z"/>
        </svg>
      </a>
    </div>
  </header>

  <main class="app-main">
    <div class="undershirt">
      <slot/>
    </div>
  </main>
</div>
