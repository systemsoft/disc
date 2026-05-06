/**
 * Tests for UI asset serving (Bundle I Phase 1).
 *
 * The handler resolves `/ui/...` paths to embedded UI build files. In the
 * compiled binary the files come from `deno compile --include ui/build`;
 * during development they come straight from the filesystem.
 */

import { assertEquals } from "@std/assert";
import { createUiAssetHandler, getUiContentType } from "./ui-assets.ts";

Deno.test("getUiContentType - HTML", () => {
  assertEquals(getUiContentType("index.html"), "text/html; charset=utf-8");
});

Deno.test("getUiContentType - JS", () => {
  assertEquals(
    getUiContentType("app.js"),
    "application/javascript; charset=utf-8",
  );
});

Deno.test("getUiContentType - CSS", () => {
  assertEquals(getUiContentType("style.css"), "text/css; charset=utf-8");
});

Deno.test("getUiContentType - SVG", () => {
  assertEquals(getUiContentType("logo.svg"), "image/svg+xml");
});

Deno.test("getUiContentType - JSON", () => {
  assertEquals(
    getUiContentType("version.json"),
    "application/json; charset=utf-8",
  );
});

Deno.test("getUiContentType - unknown extension defaults to octet-stream", () => {
  assertEquals(getUiContentType("file.xyz"), "application/octet-stream");
});

Deno.test("createUiAssetHandler - returns null for non-/ui paths", async () => {
  const handler = createUiAssetHandler();
  const res = await handler(new Request("http://localhost/health"));
  assertEquals(res, null);
});

Deno.test("createUiAssetHandler - serves index.html on /ui", async () => {
  const handler = createUiAssetHandler();
  const res = await handler(new Request("http://localhost/ui"));
  assertEquals(res?.status, 200);
  assertEquals(res?.headers.get("content-type"), "text/html; charset=utf-8");
});

Deno.test("createUiAssetHandler - serves index.html on /ui/", async () => {
  const handler = createUiAssetHandler();
  const res = await handler(new Request("http://localhost/ui/"));
  assertEquals(res?.status, 200);
  const body = await res!.text();
  assertEquals(body.includes("<!DOCTYPE html>") || body.includes("<!doctype html>"), true);
});

Deno.test("createUiAssetHandler - SPA fallback returns index.html for unknown route", async () => {
  const handler = createUiAssetHandler();
  const res = await handler(new Request("http://localhost/ui/some/spa/route"));
  assertEquals(res?.status, 200);
  assertEquals(res?.headers.get("content-type"), "text/html; charset=utf-8");
});

Deno.test("createUiAssetHandler - 404 for unknown asset with file extension", async () => {
  const handler = createUiAssetHandler();
  const res = await handler(new Request("http://localhost/ui/nope.css"));
  assertEquals(res?.status, 404);
});

Deno.test("createUiAssetHandler - immutable cache header for /_app/ assets", async () => {
  const handler = createUiAssetHandler();
  // Pick the first known _app file from the manifest.
  const { UI_ASSET_MANIFEST } = await import("./ui-asset-manifest.ts");
  const appAsset = UI_ASSET_MANIFEST.find((p) => p.startsWith("_app/"));
  if (!appAsset) {
    // No _app assets shipped — skip rather than fail.
    return;
  }
  const res = await handler(new Request(`http://localhost/ui/${appAsset}`));
  assertEquals(res?.status, 200);
  assertEquals(
    res?.headers.get("cache-control"),
    "public, max-age=31536000, immutable",
  );
});
