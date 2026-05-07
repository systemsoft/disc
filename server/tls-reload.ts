/**
 * TLS certificate hot-reload.
 *
 * Watches the configured cert + key files via `Deno.watchFs` and
 * invokes a reload callback on change, debounced to collapse the
 * burst of events that cert-renewal tools (certbot, cert-manager)
 * generate when they write key and cert back-to-back.
 *
 * Validates the on-disk PEM envelope before triggering the callback
 * so a half-rewritten file doesn't get the listener swapped out from
 * under us. Real cryptographic validation happens when the new
 * listener actually starts — if that fails the caller keeps the old
 * listener running.
 *
 * (gh/geldata#4277, ports geldata/gel#4297)
 */

import { getLogger } from "../lib/logger.ts";

const log = getLogger("tls-reload");

/**
 * Quick PEM-envelope check. Validates that the content looks like a
 * cert (`BEGIN CERTIFICATE`) or key (`BEGIN ... PRIVATE KEY` /
 * `BEGIN ENCRYPTED PRIVATE KEY` / `BEGIN RSA PRIVATE KEY` /
 * `BEGIN EC PRIVATE KEY`). Doesn't validate the cryptography — the
 * real check is the actual listener constructor.
 */
export function validatePemEnvelope(
  content: string,
  kind: "cert" | "key",
): boolean {
  if (kind === "cert") {
    return /-----BEGIN CERTIFICATE-----/.test(content) &&
      /-----END CERTIFICATE-----/.test(content);
  }
  // key: any of the standard private-key envelopes
  const keyPattern = /-----BEGIN (?:RSA |EC |ENCRYPTED |DSA )?PRIVATE KEY-----/;
  const keyEndPattern = /-----END (?:RSA |EC |ENCRYPTED |DSA )?PRIVATE KEY-----/;
  return keyPattern.test(content) && keyEndPattern.test(content);
}

export interface TlsReloadCallback {
  (cert: string, key: string): Promise<void>;
}

export interface TlsCertWatcherOptions {
  certFile: string;
  keyFile: string;
  /** Debounce window (ms) for collapsing burst events. Default 500. */
  debounceMs?: number;
  /** Async callback invoked with the new cert + key after debounce. */
  onReload: TlsReloadCallback;
}

/**
 * Watches `certFile` and `keyFile` and triggers `onReload(cert, key)`
 * after a debounced period. Single-instance lifecycle — call `start()`
 * once, `stop()` once.
 */
export class TlsCertWatcher {
  private opts: Required<TlsCertWatcherOptions>;
  private watcher?: Deno.FsWatcher;
  private debounceTimer?: number;
  private running = false;
  private loopPromise?: Promise<void>;

  constructor(opts: TlsCertWatcherOptions) {
    this.opts = {
      ...opts,
      debounceMs: opts.debounceMs ?? 500,
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    log.info("watching TLS certificate files for changes", {
      certFile: this.opts.certFile,
      keyFile: this.opts.keyFile,
    });

    this.watcher = Deno.watchFs([this.opts.certFile, this.opts.keyFile]);
    this.loopPromise = this.consumeEvents();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }

    try {
      this.watcher?.close();
    } catch {
      // Already closed; ignore.
    }

    if (this.loopPromise) {
      try {
        await this.loopPromise;
      } catch {
        // Swallow — Deno.watchFs throws on close which is expected.
      }
    }
  }

  private async consumeEvents(): Promise<void> {
    if (!this.watcher) return;
    try {
      for await (const event of this.watcher) {
        if (!this.running) break;
        if (event.kind === "modify" || event.kind === "create") {
          this.scheduleReload();
        }
      }
    } catch (err) {
      if (this.running) {
        log.error("TLS file watcher errored", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private scheduleReload(): void {
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.fireReload();
    }, this.opts.debounceMs);
  }

  private async fireReload(): Promise<void> {
    let cert: string;
    let key: string;
    try {
      [cert, key] = await Promise.all([
        Deno.readTextFile(this.opts.certFile),
        Deno.readTextFile(this.opts.keyFile),
      ]);
    } catch (err) {
      // Mid-rename or partial write — log and bail; another event
      // will trigger us once the rename settles.
      log.warn("TLS reload skipped: failed to read cert/key files", {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    if (!validatePemEnvelope(cert, "cert")) {
      log.warn("TLS reload skipped: cert file does not look like a PEM certificate");
      return;
    }
    if (!validatePemEnvelope(key, "key")) {
      log.warn("TLS reload skipped: key file does not look like a PEM private key");
      return;
    }

    try {
      await this.opts.onReload(cert, key);
    } catch (err) {
      // Caller is expected to log critical and keep the old listener.
      log.error("TLS reload callback threw", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
