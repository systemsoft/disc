<script lang="ts">
  let command = '';
  let history: Array<{command: string; result: string}> = [];
  
  function executeCommand() {
    if (!command.trim()) return;
    
    // Add to history
    history = [...history, {
      command,
      result: `Result of: ${command}`
    }];
    
    command = '';
  }
  
  function handleKeyDown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      executeCommand();
    }
  }
</script>

<div class="repl">
  <h1>Interactive REPL</h1>
  
  <div class="repl-container">
    <div class="repl-history">
      {#each history as item}
        <div class="history-item">
          <div class="command">disc&gt; {item.command}</div>
          <div class="result">{item.result}</div>
        </div>
      {/each}
    </div>
    
    <div class="repl-input">
      <span class="prompt">disc&gt;</span>
      <input
        bind:value={command}
        on:keydown={handleKeyDown}
        placeholder="Enter EdgeQL command..."
        class="command-input"
      />
    </div>
  </div>
</div>

<style lang="scss">
  @import '../../styles/variables.scss';
  
  .repl {
    max-width: 1400px;
    margin: 0 auto;
  }
  
  .repl-container {
    background: $color-surface;
    border: 1px solid $color-border;
    border-radius: $border-radius;
    height: calc(100vh - 250px);
    display: flex;
    flex-direction: column;
  }
  
  .repl-history {
    flex: 1;
    overflow-y: auto;
    padding: $grid-unit * 2;
    font-family: $font-mono;
    font-size: 0.875rem;
    
    .history-item {
      margin-bottom: $grid-unit * 2;
      
      .command {
        color: $color-info;
        margin-bottom: $grid-unit;
      }
      
      .result {
        color: $color-success;
        padding-left: $grid-unit * 2;
      }
    }
  }
  
  .repl-input {
    display: flex;
    align-items: center;
    gap: $grid-unit;
    padding: $grid-unit * 2;
    border-top: 1px solid $color-border;
    background: $color-background-dark;
    
    .prompt {
      color: $color-primary;
      font-family: $font-mono;
      font-weight: bold;
    }
    
    .command-input {
      flex: 1;
      background: transparent;
      border: none;
      color: $color-text;
      font-family: $font-mono;
      font-size: 0.875rem;
      
      &:focus {
        outline: none;
      }
    }
  }
</style>