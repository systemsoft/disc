<script lang="ts">
  // P1-23: the Disc HTTP server doesn't expose a migrations endpoint
  // (only EdgeQL `/query` and schema introspection are reachable). Until
  // a `/migrations` route lands, this page renders a clear, honest state
  // pointing the user at the CLI commands that *do* show migration history.
  // Replacing it with mock data would be worse than admitting the gap.
  const cliCommands: Array<{ cmd: string; desc: string }> = [
    { cmd: 'disc migrate --status', desc: 'Show applied + pending migrations' },
    { cmd: 'disc migrate --create', desc: 'Generate a migration without applying it' },
    { cmd: 'disc migrate', desc: 'Apply all pending migrations' },
  ];
</script>

<div class="migrations">
  <header>
    <h1>Migration History</h1>
  </header>

  <div class="notice">
    <h3>Not yet wired</h3>
    <p>
      The Disc HTTP server doesn't expose a migrations endpoint yet, so
      the UI can't list migration history. Use the CLI in the meantime:
    </p>

    <ul class="cli-list">
      {#each cliCommands as { cmd, desc }}
        <li>
          <code>{cmd}</code>
          <span>{desc}</span>
        </li>
      {/each}
    </ul>

    <p class="footnote">
      Tracking issue: see <code>FIX_BACKLOG.md</code> &mdash; outside the
      audit-remediation scope. Adding a server route to expose
      <code>disc_migrations</code> over HTTP would unblock this page.
    </p>
  </div>
</div>

<style lang="scss">
  @import '../../styles/variables.scss';

  .migrations {
    max-width: 1000px;
    margin: 0 auto;

    header {
      margin-bottom: $grid-unit * 3;
    }
  }

  .notice {
    background: $color-surface;
    border: 1px solid $color-border;
    border-radius: $border-radius;
    padding: $grid-unit * 4;

    h3 {
      font-size: 1rem;
      margin-bottom: $grid-unit * 2;
      color: $color-warning;
    }

    p {
      color: $color-text;
      font-family: $font-mono;
      font-size: 0.875rem;
      margin-bottom: $grid-unit * 2;
      line-height: 1.5;
    }
  }

  .cli-list {
    list-style: none;
    padding: 0;
    margin: $grid-unit * 2 0;
    display: flex;
    flex-direction: column;
    gap: $grid-unit;

    li {
      display: flex;
      gap: $grid-unit * 2;
      padding: $grid-unit * 1.5;
      background: $color-background-dark;
      border: 1px solid $color-border;
      border-radius: $border-radius;
      align-items: center;

      code {
        color: $color-info;
        font-family: $font-mono;
        font-size: 0.875rem;
        min-width: 240px;
      }

      span {
        color: $color-text-dim;
        font-family: $font-mono;
        font-size: 0.8rem;
      }
    }
  }

  .footnote {
    color: $color-text-dim !important;
    font-size: 0.75rem !important;
    margin-top: $grid-unit * 3;
  }
</style>
