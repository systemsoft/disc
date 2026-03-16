/**
 * Binary protocol TCP server for Gel/EdgeDB compatibility
 * Handles incoming connections and protocol negotiation
 */

import { ProtocolConnection, ConnectionState, AuthenticationCredentials } from "./connection.ts";
import { generateStoredKeys } from "./scram.ts";

export interface ServerOptions {
  hostname?: string;
  port?: number;
  maxConnections?: number;
  connectionTimeout?: number;
  tls?: Deno.ListenTlsOptions & Deno.TlsCertifiedKeyPem;
}

export interface User {
  username: string;
  password?: string;
  storedKey?: Uint8Array;
  serverKey?: Uint8Array;
  salt?: Uint8Array;
  iterations?: number;
}

interface ResolvedServerOptions {
  hostname: string;
  port: number;
  maxConnections: number;
  connectionTimeout: number;
  tls?: Deno.ListenTlsOptions & Deno.TlsCertifiedKeyPem;
}

export class ProtocolServer {
  private listener: Deno.Listener | null = null;
  private connections = new Map<number, Connection>();
  private users = new Map<string, AuthenticationCredentials>();
  private options: ResolvedServerOptions;
  private nextConnectionId = 1;
  private running = false;

  constructor(options: ServerOptions = {}) {
    this.options = {
      hostname: options.hostname ?? "127.0.0.1",
      port: options.port ?? 5656,
      maxConnections: options.maxConnections ?? 100,
      connectionTimeout: options.connectionTimeout ?? 60000,
      tls: options.tls,
    };
  }
  
  /**
   * Add a user for authentication
   */
  async addUser(user: User): Promise<void> {
    let credentials: AuthenticationCredentials;
    
    if (user.storedKey && user.serverKey && user.salt) {
      // Use pre-computed keys
      credentials = {
        username: user.username,
        storedKey: user.storedKey,
        serverKey: user.serverKey,
        salt: user.salt,
        iterations: user.iterations ?? 4096,
      };
    } else if (user.password) {
      // Generate keys from password
      const keys = await generateStoredKeys(user.username, user.password);
      credentials = {
        username: user.username,
        ...keys,
      };
    } else {
      throw new Error("User must have either password or stored keys");
    }
    
    this.users.set(user.username, credentials);
  }
  
  /**
   * Start the server
   */
  async start(): Promise<void> {
    if (this.running) {
      throw new Error("Server is already running");
    }
    
    // Create listener based on TLS configuration
    if (this.options.tls) {
      this.listener = Deno.listenTls({
        ...this.options.tls,
        hostname: this.options.hostname,
        port: this.options.port,
      });
    } else {
      this.listener = Deno.listen({
        hostname: this.options.hostname,
        port: this.options.port,
      });
    }
    
    this.running = true;
    console.log(`Protocol server listening on ${this.options.hostname}:${this.options.port}`);
    
    // Accept connections
    this.acceptConnections();
    
    // Start cleanup timer
    this.startCleanupTimer();
  }
  
  /**
   * Stop the server
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    
    this.running = false;
    
    // Close listener
    if (this.listener) {
      this.listener.close();
      this.listener = null;
    }
    
    // Close all connections
    for (const connection of this.connections.values()) {
      await connection.close();
    }
    this.connections.clear();
    
    console.log("Protocol server stopped");
  }
  
  /**
   * Accept incoming connections
   */
  private async acceptConnections(): Promise<void> {
    if (!this.listener) return;
    
    try {
      for await (const conn of this.listener) {
        if (!this.running) break;
        
        if (this.connections.size >= this.options.maxConnections) {
          console.warn("Max connections reached, rejecting new connection");
          conn.close();
          continue;
        }
        
        this.handleConnection(conn);
      }
    } catch (error) {
      if (this.running) {
        console.error("Error accepting connections:", error);
      }
    }
  }
  
  /**
   * Handle a new connection
   */
  private async handleConnection(conn: Deno.Conn): Promise<void> {
    const connectionId = this.nextConnectionId++;
    const remoteAddr = conn.remoteAddr as Deno.NetAddr;
    
    console.log(`New connection ${connectionId} from ${remoteAddr.hostname}:${remoteAddr.port}`);
    
    // For now, use a default user - in production, this would be determined
    // during authentication based on the username in the SASL exchange
    const defaultCredentials = this.users.values().next().value;
    if (!defaultCredentials) {
      console.error("No users configured, closing connection");
      conn.close();
      return;
    }
    
    const connection = new Connection(
      connectionId,
      conn,
      defaultCredentials,
      {
        onClose: () => {
          this.connections.delete(connectionId);
          console.log(`Connection ${connectionId} closed`);
        },
      }
    );
    
    this.connections.set(connectionId, connection);
    await connection.start();
  }
  
  /**
   * Cleanup timed out connections
   */
  private startCleanupTimer(): void {
    const cleanup = async () => {
      if (!this.running) return;
      
      for (const [id, connection] of this.connections) {
        if (connection.isTimedOut()) {
          console.log(`Connection ${id} timed out, closing`);
          await connection.close();
          this.connections.delete(id);
        }
      }
      
      if (this.running) {
        setTimeout(cleanup, 10000); // Check every 10 seconds
      }
    };
    
    setTimeout(cleanup, 10000);
  }
  
  /**
   * Get server statistics
   */
  getStats(): {
    running: boolean;
    connections: number;
    maxConnections: number;
    address: string;
  } {
    return {
      running: this.running,
      connections: this.connections.size,
      maxConnections: this.options.maxConnections,
      address: `${this.options.hostname}:${this.options.port}`,
    };
  }
}

/**
 * Individual connection handler
 */
class Connection {
  private protocol: ProtocolConnection;
  private conn: Deno.Conn;
  private connectionId: number;
  private buffer = new Uint8Array(65536); // 64KB read buffer
  private running = false;
  private onClose?: () => void;
  
  constructor(
    connectionId: number,
    conn: Deno.Conn,
    credentials: AuthenticationCredentials,
    options?: {
      onClose?: () => void;
    }
  ) {
    this.connectionId = connectionId;
    this.conn = conn;
    this.protocol = new ProtocolConnection(credentials);
    this.onClose = options?.onClose;
  }
  
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    
    try {
      while (this.running) {
        // Read data from connection
        const n = await this.conn.read(this.buffer);
        
        if (n === null) {
          // Connection closed by client
          break;
        }
        
        // Process the data
        const data = this.buffer.subarray(0, n);
        const responses = await this.protocol.processData(data);
        
        // Send responses
        for (const response of responses) {
          await this.conn.write(response);
        }
        
        // Check if connection should be closed
        if (this.protocol.getState() === ConnectionState.Terminated) {
          break;
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.BadResource) {
        // Connection already closed
      } else {
        console.error(`Connection ${this.connectionId} error:`, error);
      }
    } finally {
      await this.close();
    }
  }
  
  async close(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    
    try {
      this.protocol.close();
      this.conn.close();
    } catch {
      // Ignore errors during close
    }
    
    this.onClose?.();
  }
  
  isTimedOut(): boolean {
    return this.protocol.isTimedOut();
  }
  
  getStats(): any {
    return this.protocol.getStats();
  }
}

/**
 * Create and start a protocol server with default configuration
 */
export async function createServer(options?: ServerOptions): Promise<ProtocolServer> {
  const server = new ProtocolServer(options);
  
  // Add a default test user
  await server.addUser({
    username: "edgedb",
    password: "edgedb",
  });
  
  return server;
}