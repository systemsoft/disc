/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * bcrypt password hashing, run off the main thread.
 *
 * `@da/bcrypt`'s async API spawns its worker from
 * `new URL("worker.ts", import.meta.url)`. That specifier never enters the
 * static module graph, so `deno compile` cannot embed it and the compiled
 * `disc` binary dies on the first password hash with:
 *
 *   Module not found: https://jsr.io/@da/bcrypt/1.0.1/src/worker.ts
 *
 * Running `disc serve` from source hides the bug — Deno just fetches the
 * module over the network — so it only ever surfaced in release binaries.
 *
 * Owning the worker file locally (`auth/bcrypt-worker.ts`) gives the build
 * something it can `--include` (see `cli/build.ts`), and drops the dependency
 * on `@da/bcrypt`'s internal file layout.
 *
 * The sync API would sidestep workers entirely, but bcrypt at the default 12
 * rounds measures ~275ms per hash — long enough that hashing on the main
 * thread would stall every other query on the server for the duration of a
 * single login. One worker per operation matches what `@da/bcrypt` did before
 * and keeps the event loop free.
 */

import type { BcryptRequest, BcryptResponse } from "./bcrypt-worker.ts";

/**
 * Run one bcrypt operation in a short-lived worker.
 *
 * The worker closes itself after replying; `terminate()` here covers the
 * error paths, where it may still be alive.
 */
function runInWorker(request: BcryptRequest): Promise<boolean | string> {
  const worker = new Worker(
    new URL("./bcrypt-worker.ts", import.meta.url).href,
    { type: "module" }
  );

  return new Promise<boolean | string>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<BcryptResponse>) => {
      worker.terminate();

      if (event.data.ok) {
        resolve(event.data.value);
      } else {
        reject(new Error(`bcrypt: ${event.data.error}`));
      }
    };

    worker.onerror = event => {
      worker.terminate();
      event.preventDefault();
      reject(new Error(`bcrypt worker failed: ${event.message}`));
    };

    /*** Posted after both handlers are wired so a reply can never land
         before there is something listening for it. ***/
    worker.postMessage(request);
  });
}

/** Generate a salt with the given cost factor. */
export async function genSalt(rounds: number): Promise<string> {
  return await runInWorker({ action: "genSalt", rounds }) as string;
}

/** Hash `plaintext` with a salt from {@linkcode genSalt}. */
export async function hash(plaintext: string, salt: string): Promise<string> {
  return await runInWorker({ action: "hash", plaintext, salt }) as string;
}

/** Constant-time comparison of `plaintext` against an existing bcrypt hash. */
export async function compare(plaintext: string, hashed: string): Promise<boolean> {
  return await runInWorker({ action: "compare", hash: hashed, plaintext }) as boolean;
}
