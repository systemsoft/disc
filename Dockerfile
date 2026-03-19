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
# Stage 1: deps — cache Deno dependencies
# ---------------------------------------------------------------------------
FROM denoland/deno:latest AS deps

WORKDIR /app

# Copy only the files Deno needs to resolve and cache dependencies.
# This layer is invalidated only when dependencies change, not on every
# source edit.
COPY deno.json deno.lock* ./

RUN deno install

# ---------------------------------------------------------------------------
# Stage 2: production
# ---------------------------------------------------------------------------
FROM denoland/deno:latest

WORKDIR /app

# Create a non-root user for running the server.
RUN groupadd --system disc && useradd --system --gid disc disc

# Pull the cached dependency tree from the deps stage.
COPY --from=deps /root/.cache/deno /root/.cache/deno

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
RUN deno cache cli/main.ts

# Switch to the non-root user.
USER disc

# Disc listens on port 5656 by default.
EXPOSE 5656

# Health check — uses Deno itself so the image does not need curl.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD deno eval "const r = await fetch('http://localhost:5656/health/ready'); if (!r.ok) Deno.exit(1);"

# ENTRYPOINT/CMD split allows overriding the subcommand:
#   docker run disc serve        (default)
#   docker run disc migrate
#   docker run disc shell
ENTRYPOINT ["deno", "run", "--allow-all", "--no-check", "cli/main.ts"]
CMD ["serve"]
