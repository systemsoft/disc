# Disc Admin UI

A TRON-inspired admin interface for Disc Database, built with SvelteKit and TypeScript.

## Features

- 🎨 **TRON-inspired Design** - Dark theme with luminous accents and grid-based layouts
- 📊 **Schema Browser** - Visual representation of database schema
- 📝 **Query Editor** - EdgeQL query editor with syntax highlighting
- 📋 **Data Viewer** - Browse and edit database objects
- 🎯 **REPL Interface** - Interactive EdgeQL shell
- 🔄 **Migration History** - Track schema evolution over time

## Architecture

The UI is built as a static SvelteKit application that gets bundled with the Disc server. When `disc serve` runs, it serves the UI at the `/ui` route.

```
ui/
├── build/                # Built output (gitignored)
├── src/
│   ├── lib/              # Shared components and utilities
│   │   ├── api/          # API client for Disc server
│   │   ├── components/   # Reusable Svelte components
│   │   └── stores/       # Svelte stores for state management
│   ├── routes/           # Page components
│   │   ├── data/         # Data viewer/editor
│   │   ├── migrations/   # Migration history
│   │   ├── query/        # Query editor
│   │   ├── repl/         # REPL interface
│   │   └── schema/       # Schema browser
│   └── styles/           # SCSS styles and variables
├── static/               # Static assets
└── package.json
```

## Development

```bash
# Install dependencies
bun install

# Start development server
bun run dev

# Build for production
bun run build

# Preview production build
bun run preview
```

## Integration with Disc Server

The UI is served by the Disc server when running `disc serve`. The built UI files are served from the `/ui` route.

### CLI Commands

```bash
# Open UI in browser
disc ui

# Start server with UI
disc serve

# Start server without UI
disc serve --no-ui
```

## Design System

### Colors

- **Background**: `#0a0e1b` - Deep space black
- **Primary**: `#00d9ff` - Cyan glow (main accent)
- **Secondary**: `#ff9f00` - Orange glow
- **Success**: `#00ff88` - Green glow
- **Warning**: `#ffbb00` - Yellow glow
- **Danger**: `#ff0055` - Red glow

### Typography

- **Display**: Orbitron - Used for headings
- **Monospace**: Space Mono - Used for code and data
- **Body**: System font stack

### Components

All components follow the TRON aesthetic with:
- Glowing borders on hover/focus
- Grid-based layouts
- Monospace typography for data
- Luminous accent colors
- Subtle animations

## Building for Production

```bash
# Using the build script
./build.sh

# Or manually
bun run build
```

The built files will be in the `build/` directory, ready to be served by the Disc server.

## License

Part of the Disc Database project.
