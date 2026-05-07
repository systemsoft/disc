/**
 * EdgeQL Parser Benchmarks
 *
 * Benchmarks parsing of EdgeQL queries at varying complexity levels.
 */

import { EdgeQLParser } from "../edgeql/parser.ts";

const queries: Record<string, string> = {
  "simple select": "SELECT User",
  "select with shape": "SELECT User { name, email }",
  "select with filter": "SELECT User FILTER .name = 'Ada'",
  "select with nested shape": "SELECT User { name, posts: { title, body } }",
  "select with order and limit": "SELECT User { name } ORDER BY .name LIMIT 10",
  "insert": "INSERT User { name := 'Ada', email := 'ada@example.com' }",
  "update": "UPDATE User FILTER .id = <uuid>'123' SET { name := 'Billie' }",
  "delete": "DELETE User FILTER .name = 'Ada'",
  "select with multiple filters": "SELECT User FILTER .name = 'Ada' AND .email LIKE '%@example.com'",
  "complex nested": "SELECT User { name, email, posts: { title, body, createdAt } } FILTER .name = 'Ada' ORDER BY .name OFFSET 5 LIMIT 10",
};

for (const [name, query] of Object.entries(queries)) {
  Deno.bench(`parse: ${name}`, () => {
    const parser = new EdgeQLParser(query);
    parser.parse();
  });
}
