// deno-lint-ignore-file no-console
/**
 * CLI PgLog Command Implementation - PostgreSQL log viewing functionality
 */

import { join } from "@std/path";
import { resolveProjectContext } from "../lib/project-context.ts";

export interface PgLogOptions {
  lines: number;
  follow: boolean;
  level: string | undefined;
  project: string | undefined;
}

export class PgLogCommand {
  /**
   * Resolve the path to the PostgreSQL log file for a given project.
   */
  private resolveLogPath(project: string): string {
    return join(
      Deno.env.get("HOME")!,
      ".disc",
      "instances",
      project,
      "logs",
      "postgresql.log"
    );
  }

  /**
   * Check if a PostgreSQL log line matches the given level filter.
   */
  private filterByLevel(line: string, level: string): boolean {
    const pattern = new RegExp(
      `^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}.*\\b${level}\\b`,
      "i"
    );
    return pattern.test(line);
  }

  /**
   * View and optionally follow PostgreSQL log output.
   */
  async execute(options: PgLogOptions): Promise<void> {
    const project = options.project || this.currentProjectName();
    const logPath = this.resolveLogPath(project);

    // Check if the log file exists
    try {
      await Deno.stat(logPath);
    } catch {
      throw new Error(
        `No log file found at ${logPath}. Is PostgreSQL running for project '${project}'?`
      );
    }

    // Read the log file
    const content = await Deno.readTextFile(logPath);
    let lines = content.split("\n");

    // Filter by level if provided
    if (options.level) {
      lines = lines.filter(line => this.filterByLevel(line, options.level!));
    }

    // Show last N lines
    const count = options.lines || 50;
    const tail = lines.slice(-count);
    for (const line of tail) {
      console.log(line);
    }

    // Follow mode
    if (options.follow) {
      const file = await Deno.open(logPath, { read: true });
      const stat = await file.stat();
      let position = stat.size;

      // Seek to end of file
      await file.seek(position, Deno.SeekMode.Start);

      const decoder = new TextDecoder();
      let remainder = "";

      // Handle SIGINT to cleanly exit follow mode
      let running = true;
      const handler = () => {
        running = false;
      };
      Deno.addSignalListener("SIGINT", handler);

      try {
        while (running) {
          const buf = new Uint8Array(4096);
          const bytesRead = await file.read(buf);

          if (bytesRead !== null && bytesRead > 0) {
            position += bytesRead;
            const chunk = decoder.decode(buf.subarray(0, bytesRead));
            const text = remainder + chunk;
            const parts = text.split("\n");

            // Last element may be incomplete; save it for next iteration
            remainder = parts.pop() || "";

            for (const line of parts) {
              if (options.level) {
                if (this.filterByLevel(line, options.level)) {
                  console.log(line);
                }
              } else {
                console.log(line);
              }
            }
          } else {
            // No new data; wait before polling again
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        }
      } finally {
        Deno.removeSignalListener("SIGINT", handler);
        file.close();
      }
    }
  }

  /**
   * Derive the project name from the current working directory.
   */
  private currentProjectName(): string {
    const ctx = resolveProjectContext();
    return ctx?.instanceName || Deno.cwd().split("/").pop() || "default";
  }
}

export const pgLogCommand = new PgLogCommand();
