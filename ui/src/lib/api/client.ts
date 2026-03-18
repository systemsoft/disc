/**
 * API Client for Disc Server Communication
 */

export interface QueryResult {
  data: any[];
  columns?: string[];
  executionTime: number;
  error?: string;
}

export interface SchemaType {
  name: string;
  module: string;
  properties: Array<{
    name: string;
    type: string;
    required: boolean;
    multi: boolean;
    readonly?: boolean;
    default?: any;
  }>;
  links: Array<{
    name: string;
    target: string;
    multi: boolean;
    required: boolean;
  }>;
  constraints?: Array<{
    type: string;
    expression?: string;
  }>;
}

export interface Migration {
  id: string;
  name: string;
  appliedAt: string;
  checksum: string;
  sql?: string;
}

export interface ConnectionInfo {
  version: string;
  connected: boolean;
  database: string;
  activeConnections: number;
}

export class DiscAPIClient {
  private baseUrl: string;
  private headers: HeadersInit;

  constructor(baseUrl = "") {
    this.baseUrl = baseUrl || "";
    this.headers = {
      "Content-Type": "application/json",
    };
  }

  /**
   * Execute an EdgeQL query
   */
  async executeQuery(
    query: string,
    variables?: Record<string, any>,
  ): Promise<QueryResult> {
    try {
      const response = await fetch(`${this.baseUrl}/api/query`, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({ query, variables }),
      });

      if (!response.ok) {
        throw new Error(`Query failed: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      return {
        data: [],
        executionTime: 0,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Get schema information
   */
  async getSchema(): Promise<SchemaType[]> {
    try {
      const response = await fetch(`${this.baseUrl}/api/schema`, {
        headers: this.headers,
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch schema: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error("Failed to fetch schema:", error);
      return [];
    }
  }

  /**
   * Get specific type information
   */
  async getType(typeName: string): Promise<SchemaType | null> {
    try {
      const response = await fetch(`${this.baseUrl}/api/schema/${typeName}`, {
        headers: this.headers,
      });

      if (!response.ok) {
        return null;
      }

      return await response.json();
    } catch (error) {
      console.error(`Failed to fetch type ${typeName}:`, error);
      return null;
    }
  }

  /**
   * Get data for a specific type
   */
  async getData(typeName: string, options?: {
    limit?: number;
    offset?: number;
    filter?: Record<string, any>;
    orderBy?: string;
  }): Promise<QueryResult> {
    try {
      const params = new URLSearchParams();
      if (options?.limit) params.set("limit", options.limit.toString());
      if (options?.offset) params.set("offset", options.offset.toString());
      if (options?.filter) params.set("filter", JSON.stringify(options.filter));
      if (options?.orderBy) params.set("orderBy", options.orderBy);

      const response = await fetch(
        `${this.baseUrl}/api/data/${typeName}?${params}`,
        { headers: this.headers },
      );

      if (!response.ok) {
        throw new Error(`Failed to fetch data: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      return {
        data: [],
        executionTime: 0,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Insert new object
   */
  async insertObject(
    typeName: string,
    data: Record<string, any>,
  ): Promise<QueryResult> {
    try {
      const response = await fetch(`${this.baseUrl}/api/data/${typeName}`, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(data),
      });

      if (!response.ok) {
        throw new Error(`Failed to insert object: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      return {
        data: [],
        executionTime: 0,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Update object
   */
  async updateObject(
    typeName: string,
    id: string,
    data: Record<string, any>,
  ): Promise<QueryResult> {
    try {
      const response = await fetch(
        `${this.baseUrl}/api/data/${typeName}/${id}`,
        {
          method: "PATCH",
          headers: this.headers,
          body: JSON.stringify(data),
        },
      );

      if (!response.ok) {
        throw new Error(`Failed to update object: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      return {
        data: [],
        executionTime: 0,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Delete object
   */
  async deleteObject(typeName: string, id: string): Promise<QueryResult> {
    try {
      const response = await fetch(
        `${this.baseUrl}/api/data/${typeName}/${id}`,
        {
          method: "DELETE",
          headers: this.headers,
        },
      );

      if (!response.ok) {
        throw new Error(`Failed to delete object: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      return {
        data: [],
        executionTime: 0,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Get migration history
   */
  async getMigrations(): Promise<Migration[]> {
    try {
      const response = await fetch(`${this.baseUrl}/api/migrations`, {
        headers: this.headers,
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch migrations: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error("Failed to fetch migrations:", error);
      return [];
    }
  }

  /**
   * Get connection information
   */
  async getConnectionInfo(): Promise<ConnectionInfo> {
    try {
      const response = await fetch(`${this.baseUrl}/api/connection`, {
        headers: this.headers,
      });

      if (!response.ok) {
        throw new Error(
          `Failed to fetch connection info: ${response.statusText}`,
        );
      }

      return await response.json();
    } catch (error) {
      return {
        version: "unknown",
        connected: false,
        database: "unknown",
        activeConnections: 0,
      };
    }
  }

  /**
   * Execute REPL command
   */
  async executeREPL(command: string): Promise<{
    result: any;
    error?: string;
    executionTime: number;
  }> {
    try {
      const response = await fetch(`${this.baseUrl}/api/repl`, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({ command }),
      });

      if (!response.ok) {
        throw new Error(`REPL command failed: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      return {
        result: null,
        error: error instanceof Error ? error.message : "Unknown error",
        executionTime: 0,
      };
    }
  }
}

// Create default instance
export const discAPI = new DiscAPIClient();
