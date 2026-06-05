#!/bin/sh
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

set -e

BACKUP_DIR="/opt/codekey-backups"
KEY_FILE="/etc/codekey/backup.key"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/codekey-${TIMESTAMP}.sql.gz.enc"

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

# Full DB backup. Default schema includes all tables, sequences, DDL.
docker exec codekey-pg pg_dump -U codekey -d codekey \
  | gzip -9 \
  | openssl enc -aes-256-cbc -salt -pbkdf2 \
      -pass file:${KEY_FILE} \
      -out "${BACKUP_FILE}"

chmod 600 "${BACKUP_FILE}"

# Retention: 90 days
find "${BACKUP_DIR}" -name 'codekey-*.sql.gz.enc' -mtime +90 -delete

echo "OK: $(ls -la "${BACKUP_FILE}")"
