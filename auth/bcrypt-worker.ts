/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/// <reference lib="deno.worker" />

/**
 * Worker thread that runs one bcrypt operation and exits.
 *
 * Owned by Disc rather than reused from `@da/bcrypt` so `deno compile` can
 * embed it — see the header comment in `auth/bcrypt.ts` for why that matters.
 * Registered with the build via `--include auth/bcrypt-worker.ts`
 * (`cli/build.ts`).
 *
 * Kept deliberately tiny: it performs the CPU-bound hash, posts the result
 * back, and closes. All validation lives on the main thread in `bcrypt.ts`.
 */

import { compareSync, genSaltSync, hashSync } from "@da/bcrypt";

/** Request posted from `auth/bcrypt.ts`. */
export type BcryptRequest =
  | { action: "compare"; hash: string; plaintext: string; }
  | { action: "genSalt"; rounds: number; }
  | { action: "hash"; plaintext: string; salt: string; };

/**
 * Reply posted back to the main thread. Errors are marshalled as a message
 * rather than thrown, so the caller sees the real bcrypt failure instead of
 * the opaque "Unhandled error in child worker".
 */
export type BcryptResponse =
  | { error: string; ok: false; }
  | { ok: true; value: boolean | string; };

function run(request: BcryptRequest): boolean | string {
  switch (request.action) {
    case "compare":
      return compareSync(request.plaintext, request.hash);

    case "genSalt":
      return genSaltSync(request.rounds);

    case "hash":
      return hashSync(request.plaintext, request.salt);
  }
}

self.onmessage = (event: MessageEvent<BcryptRequest>) => {
  let response: BcryptResponse;

  try {
    response = { ok: true, value: run(event.data) };
  } catch (error) {
    response = {
      error: error instanceof Error ? error.message : String(error),
      ok: false
    };
  }

  self.postMessage(response);
  self.close();
};
