#!/usr/bin/env bash
#
# tests/gel-compat/run.sh — local + CI runner for the Gel-client compat smoke.
#
# Boots `disc serve --binary-port 5656` from the fixture project, waits for
# the binary protocol port to open, runs the Python and Node smoke suites,
# then tears down. Either suite is skipped if its toolchain is missing
# (uv/python3 for Python, node/npm for Node) so contributors without one
# language installed can still run the other.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
COMPAT_DIR="$ROOT/tests/gel-compat"
FIXTURE_DIR="$COMPAT_DIR/fixture"

DISC_HOST="${DISC_HOST:-127.0.0.1}"
DISC_BINARY_PORT="${DISC_BINARY_PORT:-5656}"
DISC_HTTP_PORT="${DISC_HTTP_PORT:-5757}"

LOG="$COMPAT_DIR/disc-serve.log"
PIDFILE="$COMPAT_DIR/disc-serve.pid"

cleanup() {
  if [[ -f "$PIDFILE" ]]; then
    local pid
    pid="$(cat "$PIDFILE" || true)"
    if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      # Give it a beat to release the ports
      for _ in 1 2 3 4 5; do
        if ! kill -0 "$pid" 2>/dev/null; then break; fi
        sleep 1
      done
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$PIDFILE"
  fi
  # Stop bundled PG instance left running by `disc serve`
  (cd "$FIXTURE_DIR" && deno run --allow-all "$ROOT/cli/main.ts" stop 2>/dev/null || true)
}
trap cleanup EXIT

CERT_DIR="$COMPAT_DIR/.tls"
CERT_FILE="$CERT_DIR/cert.pem"
KEY_FILE="$CERT_DIR/key.pem"

if [[ ! -f "$CERT_FILE" || ! -f "$KEY_FILE" ]]; then
  echo "==> Generating self-signed TLS cert (Gel clients require TLS+ALPN)"
  mkdir -p "$CERT_DIR"
  openssl req -x509 -newkey rsa:2048 -keyout "$KEY_FILE" -out "$CERT_FILE" \
    -days 365 -nodes -subj "/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
    >/dev/null 2>&1
fi

echo "==> Applying migrations (idempotent)"
(
  cd "$FIXTURE_DIR"
  deno run --allow-all "$ROOT/cli/main.ts" migrate >> "$LOG" 2>&1 || true
)

echo "==> Starting disc serve (HTTP=$DISC_HTTP_PORT, binary=$DISC_BINARY_PORT, TLS on)"
(
  cd "$FIXTURE_DIR"
  DISC_BINARY_TLS_CERT="$CERT_FILE" \
  DISC_BINARY_TLS_KEY="$KEY_FILE" \
  nohup deno run --allow-all "$ROOT/cli/main.ts" serve \
    --port "$DISC_HTTP_PORT" \
    --binary-port "$DISC_BINARY_PORT" \
    > "$LOG" 2>&1 &
  echo $! > "$PIDFILE"
)

echo "==> Waiting for binary port $DISC_BINARY_PORT to accept connections"
for i in $(seq 1 60); do
  if (echo > "/dev/tcp/$DISC_HOST/$DISC_BINARY_PORT") 2>/dev/null; then
    echo "    ready after ${i}s"
    break
  fi
  if [[ $i -eq 60 ]]; then
    echo "ERROR: disc serve did not open port $DISC_BINARY_PORT in 60s" >&2
    echo "----- last 50 lines of $LOG -----" >&2
    tail -50 "$LOG" >&2 || true
    exit 1
  fi
  sleep 1
done

PY_OK=skipped
NODE_OK=skipped

if command -v python3 >/dev/null 2>&1; then
  echo "==> Running Python smoke"
  pushd "$COMPAT_DIR/python" > /dev/null
  if [[ ! -d .venv ]]; then
    python3 -m venv .venv
  fi
  # shellcheck source=/dev/null
  . .venv/bin/activate
  pip install --quiet --upgrade pip
  pip install --quiet -r requirements.txt
  if DISC_HOST="$DISC_HOST" DISC_BINARY_PORT="$DISC_BINARY_PORT" \
       pytest -v --tb=short; then
    PY_OK=passed
  else
    PY_OK=failed
  fi
  deactivate
  popd > /dev/null
else
  echo "==> Skipping Python smoke (python3 not found)"
fi

if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  echo "==> Running Node smoke"
  pushd "$COMPAT_DIR/node" > /dev/null
  npm install --silent --no-audit --no-fund
  if DISC_HOST="$DISC_HOST" DISC_BINARY_PORT="$DISC_BINARY_PORT" \
       npm test --silent; then
    NODE_OK=passed
  else
    NODE_OK=failed
  fi
  popd > /dev/null
else
  echo "==> Skipping Node smoke (node/npm not found)"
fi

echo "==> Summary: python=$PY_OK node=$NODE_OK"

if [[ "$PY_OK" == "failed" || "$NODE_OK" == "failed" ]]; then
  exit 1
fi
