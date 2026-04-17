# ext-fts

Full-text search extension. Emits a generated `tsvector` column and a GIN
index over it, exposing `fts::search` and `fts::rank` builtins.

## Usage

```edgeql
select Post { title } filter fts::search(.body, 'disc database');
```

## Known limitations

### GIN index survives column rename only if the tsvector column is rebuilt

The generated column is `ALWAYS STORED` over a tuple of the source columns.
If you rename one of the source columns in SDL, the migration diff will drop
and recreate the tsvector column (which drops the GIN index) and then
rebuild both — expect a one-time index rebuild cost proportional to table
size. Likewise, dropping a source column cascades to the tsvector column
and its index. (P2-25)

### English-language analyzer only

The stored tsvector uses the `english` text search configuration. Multi-
language corpora need a per-row `regconfig` column and a custom index
expression — not yet exposed through SDL.
