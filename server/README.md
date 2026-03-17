# Disc Server

HTTP/WebSocket server implementation for the Disc database system.

## Features

- **HTTP/JSON API** - RESTful endpoints for executing EdgeQL queries
- **WebSocket Support** - Real-time query execution and subscriptions
- **Connection Management** - Automatic connection pooling and cleanup
- **Session Tracking** - User session management with timeout handling
- **Transaction Support** - Database transaction management
- **Health Monitoring** - Built-in health checks and server statistics
- **CORS Support** - Cross-origin resource sharing configuration
- **Security** - Input validation and SQL injection protection

## Architecture

```
┌─────────────────────────────────────┐
│             Disc Server             │
├─────────────────────────────────────┤
│    HTTP Server │ WebSocket Server   │
├─────────────────────────────────────┤
│          Protocol Handler           │
│        (EdgeQL → Mock Data)         │
├─────────────────────────────────────┤
│  Connection Manager │ Session Mgr   │
├─────────────────────────────────────┤
│         Transaction Manager         │
└─────────────────────────────────────┘
```

## Endpoints

### HTTP Endpoints

- `GET /` - Server information
- `POST /query` - Execute EdgeQL queries
- `GET /health` - Health check and uptime
- `GET /stats` - Server statistics
- `OPTIONS *` - CORS preflight handling

### WebSocket Protocol

Upgrade to WebSocket for real-time queries:

```javascript
const ws = new WebSocket("ws://localhost:5656");

// Send query
ws.send(JSON.stringify({
  type: "query",
  payload: {
    query: "select User { name, email }",
    variables: {},
  },
}));

// Receive response
ws.onmessage = (event) => {
  const response = JSON.parse(event.data);
  console.log(response.type, response.payload);
};
```

## Configuration

Server can be configured via environment variables:

```bash
DISC_HOST=localhost              # Server host (default: localhost)
DISC_PORT=5656                   # Server port (default: 5656)
DATABASE_URL=postgresql://...    # PostgreSQL connection string
DISC_MAX_CONNECTIONS=100         # Maximum concurrent connections
DISC_REQUEST_TIMEOUT=30000       # Request timeout in milliseconds
DISC_ENABLE_CORS=true           # Enable CORS (default: true)
DISC_ENABLE_WEBSOCKETS=true     # Enable WebSockets (default: true)
DISC_CORS_ORIGINS=origin1,origin2 # Allowed CORS origins
DISC_JWT_SECRET=secret          # JWT signing secret
DISC_TLS_CERT=/path/to/cert.pem # TLS certificate file
DISC_TLS_KEY=/path/to/key.pem   # TLS private key file
```

## Usage

### Programmatic

```typescript
import { DiscServer } from "./server/server.ts";

const server = new DiscServer({
  host: "0.0.0.0",
  port: 8080,
  enable_cors: true,
  enable_websockets: true,
});

await server.start();
```

### CLI

```bash
# Start server with default settings
deno run --allow-all cli/main.ts serve

# Start with custom port
deno run --allow-all cli/main.ts serve --port 8080

# With environment configuration
DISC_PORT=3000 deno run --allow-all cli/main.ts serve
```

### Demo

```bash
# Run the interactive demo
deno run --allow-all server/demo.ts
```

## Query Format

POST requests to `/query` should include:

```json
{
  "query": "select User { name, email }",
  "variables": {},
  "operation_name": "GetUsers"
}
```

Response format:

```json
{
  "data": [
    {
      "name": "Alice",
      "email": "alice@example.com"
    }
  ],
  "extensions": {
    "duration_ms": 45,
    "query_hash": "abc123"
  }
}
```

## Error Handling

Errors are returned in standard format:

```json
{
  "errors": [
    {
      "message": "Query syntax error",
      "locations": [{ "line": 1, "column": 10 }],
      "extensions": { "code": "SYNTAX_ERROR" }
    }
  ]
}
```

## Testing

```bash
# Run all server tests
deno test server/server.test.ts --allow-all

# Run specific test
deno test server/server.test.ts --allow-all --filter "Protocol Handler"
```

## Integration

The server integrates with:

- **Migration Engine** - Schema evolution support
- **EdgeQL Compiler** - Query compilation (future)
- **PostgreSQL** - Database storage backend
- **Auth System** - User authentication (future)

## Status

✅ **Complete** - HTTP/JSON API with mock EdgeQL support
✅ **Complete** - WebSocket real-time queries
✅ **Complete** - Connection and session management
✅ **Complete** - Health monitoring and statistics
🔄 **In Progress** - Integration with real EdgeQL compiler
🔄 **Future** - Authentication and authorization
🔄 **Future** - Subscription support for live queries
🔄 **Future** - Binary protocol compatibility
