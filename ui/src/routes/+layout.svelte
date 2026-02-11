<script lang="ts">
  import '../app.scss';
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  
  let currentPath = '';
  
  $: currentPath = $page.url.pathname;
  
  const navItems = [
    { path: '/ui', label: 'Dashboard', icon: '⊞' },
    { path: '/ui/schema', label: 'Schema', icon: '◈' },
    { path: '/ui/data', label: 'Data', icon: '▦' },
    { path: '/ui/query', label: 'Query', icon: '⟩' },
    { path: '/ui/repl', label: 'REPL', icon: '›_' },
    { path: '/ui/migrations', label: 'Migrations', icon: '⟲' },
  ];
  
  let connectionStatus = 'connecting';
  
  onMount(() => {
    // Simulate connection check
    setTimeout(() => {
      connectionStatus = 'connected';
    }, 1000);
  });
</script>

<div class="app-layout">
  <header class="app-header">
    <div class="logo">
      <span class="logo-icon">◉</span>
      <span class="logo-text">DISC</span>
    </div>
    
    <nav class="main-nav">
      {#each navItems as item}
        <a 
          href={item.path} 
          class="nav-item"
          class:active={currentPath === item.path}
        >
          <span class="nav-icon">{item.icon}</span>
          <span class="nav-label">{item.label}</span>
        </a>
      {/each}
    </nav>
    
    <div class="connection-status" class:connected={connectionStatus === 'connected'}>
      <span class="status-dot"></span>
      <span class="status-text">{connectionStatus}</span>
    </div>
  </header>
  
  <main class="app-main">
    <slot />
  </main>
</div>

<style lang="scss">
  @import '../styles/variables.scss';
  
  .app-layout {
    display: flex;
    flex-direction: column;
    height: 100vh;
    width: 100vw;
    overflow: hidden;
  }
  
  .app-header {
    display: flex;
    align-items: center;
    gap: $grid-unit * 4;
    padding: $grid-unit * 2;
    background: $color-surface;
    border-bottom: 1px solid $color-border;
    position: relative;
    
    &::after {
      content: '';
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      height: 2px;
      background: linear-gradient(90deg, 
        transparent,
        $color-primary 20%,
        $color-primary 80%,
        transparent
      );
      opacity: 0.5;
    }
  }
  
  .logo {
    display: flex;
    align-items: center;
    gap: $grid-unit;
    font-family: $font-display;
    font-size: 1.5rem;
    font-weight: 900;
    letter-spacing: 0.1em;
    
    .logo-icon {
      color: $color-primary;
      font-size: 2rem;
      animation: pulse 2s ease-in-out infinite;
    }
    
    .logo-text {
      @include neon-text($color-primary);
    }
  }
  
  .main-nav {
    display: flex;
    gap: $grid-unit;
    flex: 1;
    
    .nav-item {
      display: flex;
      align-items: center;
      gap: $grid-unit;
      padding: $grid-unit $grid-unit * 2;
      color: $color-text-dim;
      font-family: $font-mono;
      font-size: 0.875rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      border: 1px solid transparent;
      border-radius: $border-radius;
      transition: all $transition-fast;
      
      .nav-icon {
        font-size: 1.25rem;
      }
      
      &:hover {
        color: $color-primary;
        background: rgba($color-primary, 0.1);
        border-color: rgba($color-primary, 0.3);
      }
      
      &.active {
        color: $color-primary;
        background: rgba($color-primary, 0.15);
        border-color: $color-primary;
        @include glow($color-primary, 0.3);
      }
    }
  }
  
  .connection-status {
    display: flex;
    align-items: center;
    gap: $grid-unit;
    padding: $grid-unit $grid-unit * 2;
    font-family: $font-mono;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: $color-text-dim;
    border: 1px solid $color-border;
    border-radius: $border-radius;
    
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: $color-warning;
      animation: pulse 2s ease-in-out infinite;
    }
    
    &.connected {
      color: $color-success;
      border-color: rgba($color-success, 0.3);
      
      .status-dot {
        background: $color-success;
      }
    }
  }
  
  .app-main {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    padding: $grid-unit * 3;
    position: relative;
  }
  
  @keyframes pulse {
    0%, 100% {
      opacity: 1;
    }
    50% {
      opacity: 0.5;
    }
  }
</style>