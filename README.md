# Disc Database

> "Your data's identity disc."

A schema-first, TypeScript-native database built on Deno. Disc is a fork of [Gel](https://geldata.com) (formerly EdgeDB), reimplemented in TypeScript/Deno while preserving PostgreSQL as the storage engine.

## Status

🚧 **Early Development** - Not ready for production use

## Architecture

Disc replaces Gel's Python/Rust core with TypeScript while maintaining:

- EdgeQL query language
- SDL schema definitions
- PostgreSQL storage backend
- Automatic migrations

## Quick Start

```bash
# Install Deno
curl -fsSL https://deno.land/install.sh | sh

# Run CLI
deno task cli --help

# Run tests
deno task test

# Format & lint
deno task check
```

## Project Structure

```
disc/
├── cli/               # CLI commands
├── schema/            # SDL parser
├── edgeql/            # EdgeQL parser
├── compiler/          # EdgeQL → SQL
├── migration/         # Schema migrations
├── server/            # Protocol & connections
├── lib/               # Shared utilities
├── tests/             # Test suite
└── reference-gel/     # Original Python/Rust implementation
```

## Development

See [CLAUDE.md](./CLAUDE.md) for detailed development guidelines and architecture documentation.

## License

AGPL-3.0
