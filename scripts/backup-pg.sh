#!/usr/bin/env bash
# backup-pg.sh — full database backup with encryption + 90-day retention.
#
# Pipeline: pg_dump (inside codekey-pg container) | gzip | openssl enc.
# Output:   /opt/codekey-backups/codekey-YYYYMMDD-HHMMSS.sql.gz.enc (chmod 600)
# Key:      /etc/codekey/backup.key (chmod 400) — NEVER sync this off-box.
# Retention: 90 days, deleted by mtime.
#
# Installed by: docs/subscription-server-config.md P0-2
# Run by:       /etc/cron.d/codekey-backup (daily 02:00 Asia/Shanghai)
#
# Recovery drill: see scripts/restore-drill.sh
#
# Failure semantics: bash + set -euo pipefail so any failure in the
# pg_dump | gzip | openssl pipeline is propagated. The file is written
# to ${BACKUP_FILE}.tmp first; on success it is atomically renamed to
# the final name. A half-written or empty .enc is never left in
# /opt/codekey-backups/ for cron to mistake for success.

set -euo pipefail

BACKUP_DIR="/opt/codekey-backups"
KEY_FILE="/etc/codekey/backup.key"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/codekey-${TIMESTAMP}.sql.gz.enc"
TMP_FILE="${BACKUP_FILE}.tmp"

# Sanity: key must exist with 400 perms. If not, fail loud — never silently
# write an unencrypted backup.
if [ ! -f "${KEY_FILE}" ]; then
  echo "FATAL: ${KEY_FILE} not found; refusing to back up unencrypted." >&2
  exit 1
fi
KEY_PERMS=$(stat -c '%a' "${KEY_FILE}")
if [ "${KEY_PERMS}" != "400" ]; then
  echo "FATAL: ${KEY_FILE} has mode ${KEY_PERMS}, expected 400." >&2
  exit 1
fi

# Cleanup the half-written .tmp on any failure (pipefail covers
# the pg_dump/gzip/openssl legs; we add an EXIT trap so a crash
# mid-pipeline leaves no orphan .tmp).
cleanup() {
  local rc=$?
  if [ $rc -ne 0 ] && [ -f "${TMP_FILE}" ]; then
    rm -f "${TMP_FILE}"
    echo "cleaned up ${TMP_FILE} after failure (rc=${rc})" >&2
  fi
}
trap cleanup EXIT

# Full DB backup. Default schema includes all tables, sequences, DDL.
# Write to .tmp first, then atomically mv to final name only on success.
docker exec codekey-pg pg_dump -U codekey -d codekey \
  | gzip -9 \
  | openssl enc -aes-256-cbc -salt -pbkdf2 \
      -pass file:${KEY_FILE} \
      -out "${TMP_FILE}"

chmod 600 "${TMP_FILE}"

# Sanity: refuse to publish a 0-byte or tiny file. An empty .enc is
# the classic "pg_dump silently failed but openssl still wrote"
# failure mode that a plain set -e misses in POSIX sh.
if [ ! -s "${TMP_FILE}" ]; then
  echo "FATAL: ${TMP_FILE} is empty; refusing to publish." >&2
  exit 1
fi
# Heuristic: a healthy codekey backup is currently ~2.4MB. A file
# much smaller is a partial dump. Threshold is conservative — set
# well below the smallest known-good backup.
MIN_BYTES=10000
ACTUAL=$(stat -c '%s' "${TMP_FILE}")
if [ "${ACTUAL}" -lt "${MIN_BYTES}" ]; then
  echo "FATAL: ${TMP_FILE} is only ${ACTUAL} bytes (min=${MIN_BYTES}); refusing to publish." >&2
  exit 1
fi

mv "${TMP_FILE}" "${BACKUP_FILE}"
trap - EXIT  # success — release the cleanup trap so we don't try to remove the final file

# Retention: 90 days
find "${BACKUP_DIR}" -name 'codekey-*.sql.gz.enc' -mtime +90 -delete

echo "OK: $(ls -la "${BACKUP_FILE}")"
