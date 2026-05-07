/**
 * Test utilities for Disc database tests
 */

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
export async function createTestSchema(
  dir: string,
  content: string,
): Promise<string> {
  const schemaPath = join(dir, "schema.disc");
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
    createdAt: datetime {
      default := datetime_current();
      readonly := true;
    };
  };

  type Post {
    required title: str;
    required body: str;
    required author: User;
    createdAt: datetime {
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
 * Capture console output for testing.
 *
 * Supports two usage patterns:
 *   1. Call start()/stop() to intercept global console
 *   2. Shadow global console with an instance and call log()/error() directly
 */
export class ConsoleCapture {
  private originalLog: typeof console.log;
  private originalError: typeof console.error;
  private logs: string[] = [];
  private errors: string[] = [];

  constructor() {
    // deno-lint-ignore no-console
    this.originalLog = console.log;
    // deno-lint-ignore no-console
    this.originalError = console.error;
  }

  /** Alias for start() - begin capturing */
  capture(): void {
    this.start();
  }

  start(): void {
    this.logs = [];
    this.errors = [];

    // deno-lint-ignore no-console
    console.log = (...args: unknown[]) => {
      this.logs.push(args.join(" "));
    };

    // deno-lint-ignore no-console
    console.error = (...args: unknown[]) => {
      this.errors.push(args.join(" "));
    };
  }

  /** Alias for stop() - restore original console */
  restore(): void {
    this.stop();
  }

  stop(): void {
    // deno-lint-ignore no-console
    console.log = this.originalLog;
    // deno-lint-ignore no-console
    console.error = this.originalError;
  }

  /** Record a log message directly (when shadowing console) */
  log(...args: unknown[]): void {
    this.logs.push(args.join(" "));
  }

  /** Record an error message directly (when shadowing console) */
  error(...args: unknown[]): void {
    this.errors.push(args.join(" "));
  }

  getLogs(): string[] {
    return [...this.logs];
  }

  getErrors(): string[] {
    return [...this.errors];
  }

  /** Alias for getErrors() */
  getErrorLogs(): string[] {
    return this.getErrors();
  }

  hasLog(pattern: string | RegExp): boolean {
    return this.logs.some((log) => typeof pattern === "string" ? log.includes(pattern) : pattern.test(log));
  }

  hasError(pattern: string | RegExp): boolean {
    return this.errors.some((error) => typeof pattern === "string" ? error.includes(pattern) : pattern.test(error));
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

  /** Delete an environment variable (saves original for restore) */
  clear(key: string): void {
    if (!(key in this.original)) {
      this.original[key] = Deno.env.get(key);
    }
    Deno.env.delete(key);
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
 * Test assertions helpers.
 * Accepts either a ConsoleCapture instance or a string[] of logs.
 */
export function assertLogContains(
  source: ConsoleCapture | string[],
  pattern: string | RegExp,
): void {
  if (source instanceof ConsoleCapture) {
    if (!source.hasLog(pattern)) {
      const logs = source.getLogs().join("\n");
      throw new Error(`Expected log to contain ${pattern}, but got:\n${logs}`);
    }
  } else {
    const found = source.some((log) => typeof pattern === "string" ? log.includes(pattern) : pattern.test(log));
    if (!found) {
      throw new Error(
        `Expected logs to contain ${pattern}, but got:\n${source.join("\n")}`,
      );
    }
  }
}

export function assertErrorContains(
  source: ConsoleCapture | string[],
  pattern: string | RegExp,
): void {
  if (source instanceof ConsoleCapture) {
    if (!source.hasError(pattern)) {
      const errors = source.getErrors().join("\n");
      throw new Error(
        `Expected error to contain ${pattern}, but got:\n${errors}`,
      );
    }
  } else {
    const found = source.some((err) => typeof pattern === "string" ? err.includes(pattern) : pattern.test(err));
    if (!found) {
      throw new Error(
        `Expected errors to contain ${pattern}, but got:\n${source.join("\n")}`,
      );
    }
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
  timeout = 1000,
): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`Timeout waiting for condition after ${timeout}ms`);
}
