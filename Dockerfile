# =============================================================================
# Disc Database — Production Dockerfile (external PostgreSQL)
# =============================================================================
# Multi-stage build for minimal image size and optimal layer caching.
# Expects DATABASE_URL to point at an external PostgreSQL instance.
#
# Usage:
#   docker build -t disc .
#   docker run -e DATABASE_URL=postgres://user:pass@host:5432/disc disc
#   docker run disc migrate   # run a different CLI command
# =============================================================================

# ---------------------------------------------------------------------------
# Stage 1: deps — install Ende and cache dependencies
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim AS deps

# Ende publishes no container image, so install a pinned release with its
# install script, which verifies the download's checksum. The default
# matches ENDE_VERSION in .github/workflows/ci.yml; release.yml passes it.
ARG ENDE_VERSION=v2026.10.20
ENV ENDE_INSTALL_ROOT=/opt/ende
ENV PATH="/opt/ende/bin:$PATH"
# hadolint ignore=DL3008
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl unzip \
  && curl -fsSL https://ende.sh/install.sh | sh -s "$ENDE_VERSION" \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Keep the dependency cache under /app so the non-root disc user can read
# it once the runtime stage chowns /app. Both stages use the same path.
ENV ENDE_DIR=/app/.ende-cache

# Copy only the files Ende needs to resolve and cache dependencies.
# This layer is invalidated only when dependencies change, not on every
# source edit.
COPY ende.json ./

RUN ende install

# ---------------------------------------------------------------------------
# Stage 2: production
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim

# The runtime stage needs only the Ende binary from the deps stage, plus CA
# certificates for outbound TLS.
COPY --from=deps /opt/ende /opt/ende
ENV PATH="/opt/ende/bin:$PATH"
# hadolint ignore=DL3008
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV ENDE_DIR=/app/.ende-cache

# Create a non-root user for running the server.
RUN groupadd --system disc && useradd --system --gid disc disc

# Pull the cached dependency tree from the deps stage.
COPY --from=deps /app/.ende-cache /app/.ende-cache

# Copy the full source tree.
COPY . .

# Remove files that are not needed at runtime to keep the image lean.
RUN rm -rf \
  .git \
  .claude \
  thoughts \
  reference-gel \
  tests/ \
  benchmarks/ \
  docs/ \
  ui/node_modules \
  ui/.svelte-kit \
  **/*.test.ts

# Pre-cache modules so the first run does not need network access.
RUN ende install --entrypoint cli/main.ts

# Let the non-root user read the dependency cache and the source.
RUN chown -R disc:disc /app

# Switch to the non-root user.
USER disc

# Disc listens on port 5656 by default.
EXPOSE 5656

# Health check — uses Ende itself so the image does not need curl.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ende eval "const r = await fetch('http://localhost:5656/health/ready'); if (!r.ok) Deno.exit(1);"

# ENTRYPOINT/CMD split allows overriding the subcommand:
#   docker run disc serve        (default)
#   docker run disc migrate
#   docker run disc shell
ENTRYPOINT ["ende", "run", "--allow-all", "--no-check", "cli/main.ts"]
CMD ["serve"]
