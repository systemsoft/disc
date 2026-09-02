#!/bin/sh
#
# install-disc.sh — non-interactive Disc install + systemd deployment.
# POSIX sh compatible: safe to run as `curl -fsSL .../install-disc.sh | sh`.
# Run as root, or as a user with passwordless sudo.
#
# Override any of these at invocation time, e.g.
#   curl -fsSL .../install-disc.sh | DISC_PORT=6000 DISC_HOST=0.0.0.0 sh
#   DISC_PREFIX=/srv/disc DISC_USER=discd ./install-disc.sh
#
set -eu
# Enable pipefail only when the shell supports it (dash >= 0.5.12, bash, etc.).
(set -o pipefail) 2>/dev/null && set -o pipefail

# --- Tunables (override via environment) -------------------------------------
DISC_USER="${DISC_USER:-disc}"
DISC_PROJECT="${DISC_PROJECT:-disc}"   # project + managed-instance + db name
DISC_PREFIX="${DISC_PREFIX:-/opt/disc}"
DISC_ETC="${DISC_ETC:-/etc/disc}"
DISC_HOME="${DISC_HOME:-${DISC_PREFIX}}"
DISC_HOST="${DISC_HOST:-127.0.0.1}"
DISC_PORT="${DISC_PORT:-5656}"
DATABASE_URL="${DATABASE_URL:-}"   # leave empty to use bundled PostgreSQL
DEPLOY_DIR="${DEPLOY_DIR:-/tmp/disc-deploy}"
# -----------------------------------------------------------------------------

DISC_ENV="${DISC_ETC}/disc.env"

# Use sudo only when we are not already root, so the script runs either way.
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  SUDO="sudo"
fi

# 1. Create a dedicated, login-less system user (skip if it already exists).
#    --system also creates a matching group named "${DISC_USER}", which the
#    unit's Group= directive relies on.
if ! id "${DISC_USER}" >/dev/null 2>&1; then
  ${SUDO} useradd --system --create-home --shell /usr/sbin/nologin "${DISC_USER}"
fi

# 2. Install Disc.
${SUDO} env DISC_INSTALL="${DISC_PREFIX}" sh -c \
  'curl -fsSL https://disc.sh/install | sh -s -- --no-modify-path --no-man'

# Ensure the system user owns the installation directory.
${SUDO} chown -R "${DISC_USER}:${DISC_USER}" "${DISC_PREFIX}"

# 3. Write the environment file the unit reads (EnvironmentFile=/etc/disc/disc.env).
#    Unquoted heredoc so the variables above expand; literal $ in comments is escaped.
${SUDO} mkdir -p "${DISC_ETC}"
${SUDO} tee "${DISC_ENV}" >/dev/null <<ENV
# Data root. We override HOME (not DISC_HOME) deliberately: the bundled
# PostgreSQL instance manager resolves its data dir from \$HOME/.disc/instances,
# while the project context resolves from \$DISC_HOME -- setting only DISC_HOME
# makes the two disagree. Pointing HOME at ${DISC_HOME} makes every resolver
# (instance manager, project context, embedded-PG extraction) agree on
# ${DISC_HOME}/.disc, which lives inside the unit's ReadWritePaths. The unit
# also sets ProtectHome=true, which only blanks /home and /root -- HOME here is
# under /opt, so it stays writable.
HOME=${DISC_HOME}
DISC_HOST=${DISC_HOST}
DISC_PORT=${DISC_PORT}
# Bundled PostgreSQL needs no DATABASE_URL -- the embedded distribution is
# extracted under \$HOME/.disc and managed automatically, all as the disc user.
# To use external PostgreSQL instead, set DATABASE_URL with a dedicated,
# non-superuser role (disc.toml below is written with managed=false in that
# case, so the server connects out instead of starting a local instance).
ENV

# Append DATABASE_URL only when one was supplied.
if [ -n "${DATABASE_URL}" ]; then
  echo "DATABASE_URL=${DATABASE_URL}" | ${SUDO} tee -a "${DISC_ENV}" >/dev/null
fi

${SUDO} chown "${DISC_USER}:${DISC_USER}" "${DISC_ENV}"
${SUDO} chmod 0640 "${DISC_ENV}"

# 3b. Write the project config the server resolves at startup. Without a
#     disc.toml on (or above) the unit's WorkingDirectory, `disc serve` finds
#     no project context, skips starting the bundled PostgreSQL entirely, and
#     falls back to a TCP DSN nothing is listening on (ConnectionRefused). It
#     must live at ${DISC_HOME}/disc.toml because the unit's WorkingDirectory is
#     ${DISC_HOME} and the server walks UP from there to find it. We write it by
#     hand rather than `disc init` -- init scaffolds dev files, nests the project
#     in a subdirectory, and creates the instance in the default HOME location.
if [ -n "${DATABASE_URL}" ]; then
  DB_BLOCK="# External PostgreSQL -- disc does not manage the instance lifecycle
managed = false
backend_dsn = \"${DATABASE_URL}\""
else
  DB_BLOCK="# Managed PostgreSQL instance (bundled, started by disc serve)
managed = true
instance_name = \"${DISC_PROJECT}\""
fi

${SUDO} tee "${DISC_HOME}/disc.toml" >/dev/null <<TOML
# Disc Project Configuration
name = "${DISC_PROJECT}"

[database]
${DB_BLOCK}

[server]
port = ${DISC_PORT}
host = "${DISC_HOST}"
TOML
${SUDO} chown "${DISC_USER}:${DISC_USER}" "${DISC_HOME}/disc.toml"

# Make `disc` resolve for every user (-f so a re-run replaces the symlink).
${SUDO} ln -sf "${DISC_PREFIX}/bin/disc" /usr/local/bin/disc
export PATH="/usr/local/bin:${PATH}"
disc --version

# Note: future project commands must run as the disc user, with the env loaded,
# AND from the project dir so `disc` finds disc.toml by walking up, e.g.
#   sudo -u disc env $(grep -v '^#' /etc/disc/disc.env | xargs) \
#     sh -c 'cd ${DISC_HOME} && disc migrate'
# Worth wrapping that in an alias/helper so you don't retype it.

# 4. Generate the unit, then rewrite its directives to match THIS install.
#    `disc deploy` emits literal values for the default layout (User=disc,
#    /opt/disc, ExecStart=/opt/disc/disc). systemd does NOT expand env vars in
#    unit directives, so the only way to honour DISC_USER/DISC_PREFIX overrides
#    -- and to point ExecStart at the curl|sh binary path (${DISC_PREFIX}/bin/disc,
#    which the generator doesn't know about) -- is to substitute them here. The
#    ^Directive= anchors match whether the value is literal or an unsupported
#    ${VAR:-default} (older binaries emitted the latter, which systemd rejects
#    with "bad unit file setting"); the `#` comment lines are left untouched.
rm -rf "${DEPLOY_DIR}"
disc deploy --format systemd --output "${DEPLOY_DIR}"

UNIT="${DEPLOY_DIR}/disc.service"
sed -i \
  -e "s#^User=.*#User=${DISC_USER}#" \
  -e "s#^Group=.*#Group=${DISC_USER}#" \
  -e "s#^WorkingDirectory=.*#WorkingDirectory=${DISC_HOME}#" \
  -e "s#^EnvironmentFile=.*#EnvironmentFile=${DISC_ENV}#" \
  -e "s#^ExecStart=.*#ExecStart=${DISC_PREFIX}/bin/disc serve#" \
  -e "s#^ReadWritePaths=.*#ReadWritePaths=${DISC_PREFIX} ${DISC_HOME}#" \
  "${UNIT}"

${SUDO} cp "${UNIT}" /etc/systemd/system/disc.service
${SUDO} systemctl daemon-reload

# Catch a malformed unit before enable instead of at start time.
${SUDO} systemd-analyze verify /etc/systemd/system/disc.service || \
  echo "WARNING: systemd-analyze flagged the unit; review the output above." >&2

# `enable --now` only *starts* an inactive unit, so on a re-run against a
# running service it is a no-op and the old binary keeps serving. Enable and
# restart separately: restart covers the upgrade case and starts the unit from
# cold on a first install, so one call is correct either way.
${SUDO} systemctl enable disc
${SUDO} systemctl restart disc

# 5. Verify it came up as the disc user, not root.
${SUDO} systemctl status disc --no-pager
