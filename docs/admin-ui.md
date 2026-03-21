# Admin UI

Disc ships with a built-in web-based admin interface for browsing schemas, viewing data, running queries, and inspecting migrations. The UI is built with SvelteKit and served as static assets by the Disc server.

---

## Accessing the UI

Open the admin UI in your default browser:

```bash
disc ui
```

This navigates to `http://localhost:5656/ui`. If the server is running on a different port, pass it explicitly:

```bash
disc ui --port 8080
```

You can also navigate directly in any browser while the Disc server is running. The UI is served from the `/ui` route on the same host and port as the HTTP API.

The header bar shows a connection status indicator. When the UI connects to the server successfully, the indicator turns green and displays "connected". If the server is unreachable, the indicator stays amber in a "connecting" state.

---

## Dashboard

The root page (`/ui`) is the dashboard. It displays four summary cards:

- **Schema Types** -- number of object types defined in your schema.
- **Total Objects** -- total number of objects across all types.
- **Active Connections** -- current open connections to the database.
- **Queries Today** -- number of queries executed in the current day.

Below the summary cards, two panels appear side by side:

- **Recent Queries** -- the last few EdgeQL queries executed against the server. Click any query to load it in the query editor.
- **Quick Actions** -- shortcuts to Browse Schema, New Query, View Data, and Migrations.

---

## Schema Browser

Navigate to **Schema** in the header bar, or go to `/ui/schema`.

The schema browser displays your object types in a two-panel layout:

**Left sidebar** -- a searchable list of all object types. Each entry shows the type name and the total count of properties and links. Type the name of a type in the search field to filter the list.

**Right detail panel** -- when you select a type, the detail panel shows:

- **Properties** -- each property listed with its name, scalar type, and flags (`required`, `multi`). Required properties are marked with a red badge; multi properties with a blue badge.
- **Links** -- each link listed with its name, target type, and cardinality. An arrow indicates the direction of the relationship.

Two action buttons appear in the type header: "View Data" navigates to the data viewer filtered to that type, and "Query Builder" opens the query editor pre-populated with a SELECT for that type.

The `SchemaTree` component provides an alternative tree view of the schema organized by module. Types can be expanded to reveal their properties and links inline. Properties display their scalar type in a green badge. Required fields and constraints are shown as small labeled badges.

---

## Query Editor

Navigate to **Query** in the header bar, or go to `/ui/query`.

The query editor provides a code editing environment for writing and executing EdgeQL queries.

**Editor pane.** The main editing area uses CodeMirror with SQL syntax highlighting and the One Dark theme. Line numbers are displayed in a gutter along the left edge. Press `Cmd+Enter` (macOS) or `Ctrl+Enter` (other platforms) to execute the current query.

**Toolbar.** Three buttons sit above the editor:

- **Format** -- reformats the query text for readability.
- **Save** -- saves the current query with a name. Saved queries appear in the sidebar.
- **Execute** -- runs the query against the server and displays results below.

**Sidebar.** The left sidebar has two sections:

- **Saved Queries** -- named queries saved during this session. Click any entry to load it into the editor.
- **History** -- the 20 most recent queries, stored in browser localStorage. Click to reload.

**Results table.** After execution, results appear in a table with column headers matching the query shape. The execution time is displayed in milliseconds. A "Clear" button dismisses the results.

**Error display.** If a query fails, an error message appears between the editor and results area with the error text from the server.

**Multi-tab support.** The `QueryEditor` component supports multiple tabs. Click the "+" button to open a new query tab. Each tab maintains its own query text independently. Close tabs with the "x" button on the tab  label.

---

## Data Viewer

Navigate to **Data** in the header bar, or go to `/ui/data`.

The data viewer lets you browse objects by type. Select a type from the dropdown to load its data into a table.

The `DataGrid` component powers the table view and supports:

- **Search** -- a text field filters rows across all visible columns.
- **Sorting** -- click any sortable column header to sort ascending or descending. The active sort column is highlighted.
- **Pagination** -- when enabled, data is paginated with Previous/Next buttons and a page counter.
- **Row selection** -- checkboxes for selecting individual rows or all rows at once.
- **Inline editing** -- double-click any cell to edit its value. Press Enter to save, Escape to cancel.
- **Export** -- export the current filtered and sorted dataset.

The data viewer communicates with the server through the API client, which provides `getData`, `insertObject`, `updateObject`, and `deleteObject` methods for full CRUD operations.

---

## REPL

Navigate to **REPL** in the header bar, or go to `/ui/repl`.

The web REPL mirrors the experience of `disc shell` in the browser. It provides a scrollable history area and a command input at the bottom.

- The prompt displays `disc>` followed by a text input field.
- Type an EdgeQL command and press Enter to execute it.
- Results appear above the input, with commands shown in blue and results in green.
- The full session history scrolls upward as you enter more commands.
- Use Shift+Enter to enter multi-line queries.

The REPL uses the same API endpoint (`/api/repl`) as the CLI shell, so behavior is identical.

---

## Migration History

Navigate to **Migrations** in the header bar, or go to `/ui/migrations`.

The migration history page lists all migrations in chronological order. Each entry shows:

- **Migration ID** -- the short identifier (e.g., `m001`).
- **Name** -- the migration name derived from the schema change (e.g., `add_user_profile`).
- **Status** -- either "applied" (green badge) or "pending" (amber badge).
- **Applied date** -- the timestamp when the migration was applied, if applicable.

Pending migrations appear with a dashed border and reduced opacity to visually distinguish them from applied migrations.

---

## Health Monitoring

The Disc server exposes health and statistics endpoints that the UI reads:

- `GET /health` -- overall server health, PostgreSQL status, uptime, memory usage, and extension health.
- `GET /health/live` -- liveness probe, returns `{"status": "alive"}`.
- `GET /health/ready` -- readiness probe, returns healthy/degraded/unhealthy.
- `GET /stats` -- connection statistics, query counts, average duration, transaction stats, subscription stats, cache metrics, and rate limit status.
- `GET /metrics` -- Prometheus-compatible metrics when `DISC_ENABLE_METRICS=true`.

The dashboard connection status indicator reflects the result of these health checks.

---

## Configuration

### Disabling the UI

To run the Disc server without serving UI assets:

```bash
disc serve --no-ui
```

The HTTP API remains fully functional. This is useful in production deployments where the admin UI is not needed or is served separately.

### Server Integration

The UI is built as a static SvelteKit application using `adapter-static`. The compiled assets are bundled into the Disc server distribution. When `disc serve` starts, it serves these assets at the `/ui` path prefix. The UI communicates with the server through the same HTTP API available to any client -- there is no special internal protocol.

The API client (`DiscAPIClient`) connects to the server’s base URL and provides methods for:

- `executeQuery(query, variables)` -- run EdgeQL queries.
- `getSchema()` -- fetch all schema types.
- `getType(name)` -- fetch a single type definition.
- `getData(type, options)` -- browse data with filtering, pagination, and sorting.
- `insertObject(type, data)` -- insert a new object.
- `updateObject(type, id, data)` -- update an existing object.
- `deleteObject(type, id)` -- delete an object.
- `getMigrations()` -- list migration history.
- `getConnectionInfo()` -- server version, database name, active connections.
- `executeREPL(command)` -- run a REPL command.

---

## Design

The admin UI uses a TRON-inspired dark theme with luminous accent lines, consistent with the Disc project’s visual identity. Key visual elements:

- **Dark background** with elevated surface panels in a slightly lighter shade.
- **Luminous primary color** with neon glow effects on active elements and headings.
- **Monospaced typography** for data, code, and status labels. A display font is used for headings and stat values.
- **Grid-based layouts** with consistent spacing derived from a base grid unit.
- **Color-coded badges** -- red for required fields, blue for multi cardinality, green for success states, amber for warnings.
- **Smooth transitions** on hover and active states, with subtle glow effects on interactive borders.
- **Connection status indicator** in the header with a pulsing dot that changes color based on server connectivity.

The navigation bar runs horizontally across the top with icon-and-label entries for Dashboard, Schema, Data, Query, REPL, and Migrations.
