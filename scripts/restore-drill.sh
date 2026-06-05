#!/usr/bin/env bash
# restore-drill.sh — recover the latest encrypted backup into a
# TEMPORARY database (codekey_restore_test) and verify row counts
# against production. Does NOT touch the production database.
#
# Use: monthly recovery drill, or after any production incident
# where you need to confirm a recent backup is readable.
#
# Run on the production server:
#   bash scripts/restore-drill.sh
#
# What it checks:
#   1. Backup file exists and is readable
#   2. Decryption + decompression succeed
#   3. Decrypted SQL is a valid pg_dump (16 tables)
#   4. Row counts in users / device_bindings / auth_identities /
#      user_subscriptions / trial_claims / approval_usage /
#      sessions / redeem_codes match production exactly
#   5. Temp DB + plaintext SQL always removed on exit (success or fail)
#
# Failure semantics: bash + set -euo pipefail. Critical commands write
# to log files (not piped to tail) so the exit code is preserved. A
# trap ensures plaintext SQL and the temp DB are removed on ANY exit.
#
# Companion: scripts/backup-pg.sh

set -euo pipefail

# Plaintext backup + temp DB are sensitive. Restrict both with umask
# and explicit permissions from the moment of creation, and guarantee
# cleanup on every exit path.
umask 077

BACKUP_DIR="/opt/codekey-backups"
KEY_FILE="/etc/codekey/backup.key"
TMP_SQL=$(mktemp /tmp/codekey-restore.XXXXXX.sql)
TMP_DB=codekey_restore_test
LOG_DIR=/tmp/codekey-restore-logs

mkdir -p "${LOG_DIR}"
chmod 700 "${LOG_DIR}"

# Per-command log files so we never pipe critical psql/pg_dump output
# through tail (which would swallow the exit code and let the script
# claim "OK" on a failed restore).
LOG_DROP1="${LOG_DIR}/drop1.log"
LOG_DROP2="${LOG_DIR}/drop2.log"
LOG_CREATE="${LOG_DIR}/create.log"
LOG_RESTORE="${LOG_DIR}/restore.log"
LOG_DT_PROD="${LOG_DIR}/dt-prod.log"
LOG_DT_RESTORE="${LOG_DIR}/dt-restore.log"
LOG_COUNT_PROD="${LOG_DIR}/count-prod.log"
LOG_COUNT_RESTORE="${LOG_DIR}/count-restore.log"

# ALWAYS clean up: plaintext SQL, temp DB, and any log files left
# behind. Run on EXIT regardless of success/failure.
cleanup() {
  local rc=$?
  if [ -f "${TMP_SQL}" ]; then
    rm -f "${TMP_SQL}"
    echo "removed plaintext ${TMP_SQL}" >&2
  fi
  # Drop the temp DB only if it exists; ignore errors so cleanup is
  # idempotent and never blocks the real rc from propagating.
  docker exec codekey-pg psql -U codekey -d postgres -c "DROP DATABASE IF EXISTS ${TMP_DB};" >/dev/null 2>&1 || true
  exit $rc
}
trap cleanup EXIT
trap 'exit 1' INT TERM

# Find latest .enc file
LATEST=$(ls -t "${BACKUP_DIR}"/codekey-*.sql.gz.enc 2>/dev/null | head -1)
if [ -z "${LATEST}" ]; then
  echo "FATAL: no .enc files in ${BACKUP_DIR}" >&2
  exit 1
fi
echo "=== Restoring from: ${LATEST} ==="
ls -la "${LATEST}"

# 1. Decrypt + decompress. Decrypted file is created by mktemp with
# umask 077 — owner-only readable.
chmod 600 "${TMP_SQL}"
echo "--- decrypting ---"
openssl enc -d -aes-256-cbc -pbkdf2 \
  -pass "file:${KEY_FILE}" \
  -in "${LATEST}" | gunzip > "${TMP_SQL}"
echo "decrypted: $(wc -c < "${TMP_SQL}") bytes"

# Sanity: refuse to proceed with empty or trivially small plaintext.
if [ ! -s "${TMP_SQL}" ]; then
  echo "FATAL: decrypted SQL is empty; refusing to restore." >&2
  exit 1
fi
MIN_BYTES=1000
ACTUAL=$(stat -c '%s' "${TMP_SQL}")
if [ "${ACTUAL}" -lt "${MIN_BYTES}" ]; then
  echo "FATAL: decrypted SQL is only ${ACTUAL} bytes; refusing to restore." >&2
  exit 1
fi

# 2. Drop + recreate temp DB. Each critical command writes to its own
# log file; we then explicitly check the exit code.
echo ""
echo "--- drop+create ${TMP_DB} ---"
docker exec codekey-pg psql -U codekey -d postgres \
  -c "DROP DATABASE IF EXISTS ${TMP_DB};" >"${LOG_DROP1}" 2>&1
echo "  drop-if-exists: rc=$?"
docker exec codekey-pg psql -U codekey -d postgres \
  -c "CREATE DATABASE ${TMP_DB};" >"${LOG_CREATE}" 2>&1
echo "  create: rc=$?"

# 3. Restore. Critical — exit code is checked, not piped away.
echo ""
echo "--- restoring ---"
docker exec -i codekey-pg psql -U codekey -d "${TMP_DB}" \
  -v ON_ERROR_STOP=1 \
  < "${TMP_SQL}" >"${LOG_RESTORE}" 2>&1
RESTORE_RC=$?
echo "  restore: rc=${RESTORE_RC}"
if [ "${RESTORE_RC}" -ne 0 ]; then
  echo "FATAL: restore failed; last 20 lines:" >&2
  tail -20 "${LOG_RESTORE}" >&2
  exit 1
fi

# 4. Verify table count
echo ""
echo "--- table count in restored DB ---"
docker exec codekey-pg psql -U codekey -d "${TMP_DB}" \
  -c "\dt" >"${LOG_DT_RESTORE}" 2>&1
echo "  dt restore: rc=$?"
TABLE_COUNT=$(grep -c '^ public |' "${LOG_DT_RESTORE}" || true)
echo "  tables found: ${TABLE_COUNT}"
if [ "${TABLE_COUNT}" -ne 16 ]; then
  echo "FATAL: expected 16 tables, found ${TABLE_COUNT}" >&2
  tail -20 "${LOG_DT_RESTORE}" >&2
  exit 1
fi

# 5. Compare row counts
echo ""
echo "--- row counts: production vs restored ---"
ROW_QUERY="
  SELECT 'users', count(*) FROM users
  UNION ALL SELECT 'device_bindings', count(*) FROM device_bindings
  UNION ALL SELECT 'auth_identities', count(*) FROM auth_identities
  UNION ALL SELECT 'user_subscriptions', count(*) FROM user_subscriptions
  UNION ALL SELECT 'trial_claims', count(*) FROM trial_claims
  UNION ALL SELECT 'approval_usage', count(*) FROM approval_usage
  UNION ALL SELECT 'sessions', count(*) FROM sessions
  UNION ALL SELECT 'redeem_codes', count(*) FROM redeem_codes
  ORDER BY 1;
"

echo "PRODUCTION:"
docker exec codekey-pg psql -U codekey -d codekey -tA \
  -c "${ROW_QUERY}" >"${LOG_COUNT_PROD}" 2>&1
echo "  rc=$?"
cat "${LOG_COUNT_PROD}"

echo ""
echo "RESTORED:"
docker exec codekey-pg psql -U codekey -d "${TMP_DB}" -tA \
  -c "${ROW_QUERY}" >"${LOG_COUNT_RESTORE}" 2>&1
echo "  rc=$?"
cat "${LOG_COUNT_RESTORE}"

# 6. Diff
echo ""
echo "--- diff ---"
if diff -q "${LOG_COUNT_PROD}" "${LOG_COUNT_RESTORE}" >/dev/null 2>&1; then
  echo "OK: row counts match exactly"
else
  echo "FATAL: row counts differ" >&2
  diff "${LOG_COUNT_PROD}" "${LOG_COUNT_RESTORE}" >&2 || true
  exit 1
fi

# Cleanup runs from the EXIT trap (drops temp DB, removes plaintext).
echo ""
echo "OK: drill complete; cleanup will run via EXIT trap"
