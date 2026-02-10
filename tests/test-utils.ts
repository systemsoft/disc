/**
 * Test utilities for Disc database tests
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";

/**
 * Create a temporary directory for test files
 */
export async function createTempDir(): Promise<string> {
  const tempDir = await Deno.makeTempDir({ prefix: "disc_test_" });
  return tempDir;
}

/**
 * Clean up temporary directory
 */
export async function cleanupTempDir(dir: string): Promise<void> {
  try {
    await Deno.remove(dir, { recursive: true });
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Create a test schema file
 */
export async function createTestSchema(dir: string, content: string): Promise<string> {
  const schemaPath = join(dir, "schema.esdl");
  await Deno.writeTextFile(schemaPath, content);
  return schemaPath;
}

/**
 * Mock schema content for testing
 */
export const TEST_SCHEMA = `
module default {
  type User {
    required name: str;
    required email: str {
      constraint exclusive;
    };
    multi posts: Post;
    created_at: datetime {
      default := datetime_current();
      readonly := true;
    };
  };

  type Post {
    required title: str;
    required body: str;
    required author: User;
    created_at: datetime {
      default := datetime_current();
    };
  };
}`;

/**
 * Simple test schema for basic testing
 */
export const SIMPLE_SCHEMA = `
module default {
  type User {
    required name: str;
    required email: str;
  };
}`;

/**
 * Capture console output for testing
 */
export class ConsoleCapture {
  private originalLog: typeof console.log;
  private originalError: typeof console.error;
  private logs: string[] = [];
  private errors: string[] = [];

  constructor() {
    this.originalLog = console.log;
    this.originalError = console.error;
  }

  start(): void {
    this.logs = [];
    this.errors = [];
    
    console.log = (...args: unknown[]) => {
      this.logs.push(args.join(" "));
    };
    
    console.error = (...args: unknown[]) => {
      this.errors.push(args.join(" "));
    };
  }

  stop(): void {
    console.log = this.originalLog;
    console.error = this.originalError;
  }

  getLogs(): string[] {
    return [...this.logs];
  }

  getErrors(): string[] {
    return [...this.errors];
  }

  hasLog(pattern: string | RegExp): boolean {
    return this.logs.some(log => 
      typeof pattern === "string" 
        ? log.includes(pattern)
        : pattern.test(log)
    );
  }

  hasError(pattern: string | RegExp): boolean {
    return this.errors.some(error => 
      typeof pattern === "string" 
        ? error.includes(pattern)
        : pattern.test(error)
    );
  }
}

/**
 * Mock environment variables for testing
 */
export class EnvMock {
  private original: Record<string, string | undefined> = {};

  set(key: string, value: string): void {
    if (!(key in this.original)) {
      this.original[key] = Deno.env.get(key);
    }
    Deno.env.set(key, value);
  }

  restore(): void {
    for (const [key, value] of Object.entries(this.original)) {
      if (value === undefined) {
        Deno.env.delete(key);
      } else {
        Deno.env.set(key, value);
      }
    }
    this.original = {};
  }
}

/**
 * Test assertions helpers
 */
export function assertLogContains(console: ConsoleCapture, pattern: string | RegExp): void {
  if (!console.hasLog(pattern)) {
    const logs = console.getLogs().join("\n");
    throw new Error(`Expected log to contain ${pattern}, but got:\n${logs}`);
  }
}

export function assertErrorContains(console: ConsoleCapture, pattern: string | RegExp): void {
  if (!console.hasError(pattern)) {
    const errors = console.getErrors().join("\n");
    throw new Error(`Expected error to contain ${pattern}, but got:\n${errors}`);
  }
}

/**
 * Mock CLI arguments for testing
 */
export function mockCliArgs(args: string[]): () => void {
  // Store original args
  const originalArgs = [...Deno.args];
  
  // Replace args
  Deno.args.length = 0;
  Deno.args.push(...args);
  
  // Return cleanup function
  return () => {
    Deno.args.length = 0;
    Deno.args.push(...originalArgs);
  };
}

/**
 * Wait for a condition to be true
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeout = 1000
): Promise<void> {
  const start = Date.now();
  
  while (Date.now() - start < timeout) {
    if (await condition()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  
  throw new Error(`Timeout waiting for condition after ${timeout}ms`);
}