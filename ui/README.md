# Disc Admin UI

A modern, lightly-futuristic admin interface for Disc Database, built with SvelteKit and TypeScript.

## Features

- 🎨 **Modern, lightly-futuristic design** - Light theme with crisp accents and grid-based layouts
- 📊 **Schema Browser** - Visual representation of database schema
- 📝 **Query Editor** - EdgeQL query editor with syntax highlighting
- 📋 **Data Viewer** - Browse and edit database objects
- 🎯 **REPL Interface** - Interactive EdgeQL shell
- 🔄 **Migration History** - Track schema evolution over time

## Architecture

The UI is built as a static SvelteKit application that gets bundled with the Disc server. When `disc serve` runs, it serves the UI at the `/ui` route.

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

The UI is served by the Disc server when running `disc serve`. The built UI files are served from the `/ui` route.

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

A modern, lightly-futuristic **light theme** built on the [Uchū](https://uchu.style) color palette, with crisp accents, grid-based layouts, and monospaced type for data.

### Colors

Colors come from the Uchū palette, exposed as `$uchu-*` Sass variables and `--uchu-*` custom properties. Semantic accents (info, success, warning, danger) draw from its blue, green, orange, and red ramps. See `src/styles/tokens.css` and `@inc/uchu/scss` for the source of truth.

### Typography

- **Display**: Tektur - Used for headings
- **Monospace**: Berkeley Mono - Used for code and data
- **Body**: Inter

### Components

Components share a consistent, restrained aesthetic:

- Crisp borders and subtle focus states
- Grid-based layouts
- Monospace typography for data
- A light surface with measured accent color
- Subtle animations

## Building for Production

```bash
# Using the build script
./build.sh

# Or manually
bun run build
```

The built files will be in the `build/` directory, ready to be served by the Disc server.

## License

Part of the Disc Database project.
