/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

// deno-lint-ignore-file no-console
/**
 * Server Integration Module - Serves the built UI from Disc server
 */

/*** NATIVE ------------------------------------------- ***/

import { exists } from "@std/fs";
import { join } from "@std/path";

/*** EXPORT ------------------------------------------- ***/

export interface UIServerOptions {
  basePath: string;
  buildDir?: string;
  enabled: boolean;
}

export class UIServer {
  private buildPath: string;
  private options: UIServerOptions;

  constructor(options: Partial<UIServerOptions> = {}) {
    this.options = {
      basePath: options.basePath ?? "/ui",
      buildDir: options.buildDir,
      enabled: options.enabled ?? true
    };

    /*** Default build directory relative to this file ***/
    this.buildPath = this.options.buildDir || join(new URL(".", import.meta.url).pathname, "build");
  }

  /**
   * Get handler for serving UI files
   */
  async getHandler() {
    if (!this.options.enabled)
      return null;

    const uiBuilt = await this.isBuilt();

    if (!uiBuilt) {
      console.warn(`UI build not found. Run "bun run build" in the ui/ directory.`);
      return null;
    }

    return async (request: Request): Promise<Response | null> => {
      const url = new URL(request.url);

      /*** Check if this is a UI route ***/
      if (!url.pathname.startsWith(this.options.basePath))
        return null;

      /*** Remove base path to get the actual file path ***/
      let filePath = url.pathname.slice(this.options.basePath.length);

      if (filePath === "" || filePath === "/")
        filePath = "/index.html";

      /*** Construct full file path ***/
      const fullPath = join(this.buildPath, filePath);

      try {
        /*** Check if file exists ***/
        const fileInfo = await Deno.stat(fullPath);

        if (fileInfo.isDirectory) {
          /*** Try to serve index.html from directory ***/
          const indexPath = join(fullPath, "index.html");
          const file = await Deno.readFile(indexPath);

          return new Response(file, {
            headers: {
              "content-type": "text/html; charset=utf-8"
            }
          });
        }

        /*** Read and serve the file ***/
        const file = await Deno.readFile(fullPath);
        const contentType = this.getContentType(filePath);

        return new Response(file, {
          headers: {
            "cache-control": filePath.includes("_app") ?
              "public, max-age=31536000, immutable" : /*** Cache versioned assets ***/
              "public, max-age=3600", /*** Cache other assets for 1 hour ***/
            "content-type": contentType
          }
        });
      } catch (error) {
        /*** If file not found and it’s a route, serve index.html (SPA fallback) ***/
        if (error instanceof Deno.errors.NotFound && !filePath.includes(".")) {
          try {
            const indexPath = join(this.buildPath, "index.html");
            const file = await Deno.readFile(indexPath);

            return new Response(file, {
              headers: {
                "content-type": "text/html; charset=utf-8"
              }
            });
          } catch {
            /*** index.html also not found ***/
          }
        }

        return new Response("Not Found", { status: 404 });
      }
    };
  }

  /**
   * Check if UI build exists
   */
  async isBuilt(): Promise<boolean> {
    return await exists(this.buildPath);
  }

  /**
   * Open UI in browser
   */
  async openInBrowser(port: number) {
    const url = `http://localhost:${port}${this.options.basePath}`;

    const commands: Record<string, string[]> = {
      darwin: ["open", url],
      linux: ["xdg-open", url],
      windows: ["cmd", "/c", "start", url]
    };

    const cmd = commands[Deno.build.os];

    if (!cmd) {
      console.log(`Open browser manually: ${url}`);
      return;
    }

    try {
      const process = new Deno.Command(cmd[0], { args: cmd.slice(1) });
      await process.output();
      console.log(`UI opened in browser: ${url}`);
    } catch {
      console.log(`Failed to open browser. Navigate to: ${url}`);
    }
  }

  /*** PRIVATE ------------------------------------------ ***/

  /**
   * Get content type based on file extension
   */
  private getContentType(filePath: string): string {
    const ext = filePath.split(".").pop()?.toLowerCase();

    const contentTypes: Record<string, string> = {
      css: "text/css",
      gif: "image/gif",
      html: "text/html; charset=utf-8",
      ico: "image/x-icon",
      jpeg: "image/jpeg",
      jpg: "image/jpeg",
      js: "application/javascript",
      json: "application/json",
      mjs: "application/javascript",
      otf: "font/otf",
      png: "image/png",
      svg: "image/svg+xml",
      ttf: "font/ttf",
      woff: "font/woff",
      woff2: "font/woff2"
    };

    return contentTypes[ext || ""] || "application/octet-stream";
  }
}

/*** Export default instance ***/
export const uiServer = new UIServer();
