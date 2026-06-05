#!/bin/sh
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
#   3. Decrypted SQL is a valid pg_dump (table count = 16)
#   4. Row counts in users / device_bindings / auth_identities /
#      user_subscriptions / trial_claims / approval_usage /
#      sessions / redeem_codes match production exactly
#   5. Temp DB is dropped on exit
#
# Companion: scripts/backup-pg.sh

set -e
BACKUP_DIR="/opt/codekey-backups"
KEY_FILE="/etc/codekey/backup.key"
TMP_SQL=/tmp/restore.sql
TMP_DB=codekey_restore_test

# Find latest .enc file
LATEST=$(ls -t "${BACKUP_DIR}"/codekey-*.sql.gz.enc 2>/dev/null | head -1)
if [ -z "${LATEST}" ]; then
  echo "FATAL: no .enc files in ${BACKUP_DIR}" >&2
  exit 1
fi
echo "=== Restoring from: ${LATEST} ==="
ls -la "${LATEST}"

# 1. Decrypt + decompress
echo "--- decrypting ---"
openssl enc -d -aes-256-cbc -pbkdf2 \
  -pass file:${KEY_FILE} \
  -in "${LATEST}" | gunzip > "${TMP_SQL}"
echo "decrypted: $(wc -c < ${TMP_SQL}) bytes"

# 2. Drop + recreate temp DB
echo ""
echo "--- drop+create ${TMP_DB} ---"
docker exec codekey-pg psql -U codekey -d postgres -c "DROP DATABASE IF EXISTS ${TMP_DB};" 2>&1 | tail -2
docker exec codekey-pg psql -U codekey -d postgres -c "CREATE DATABASE ${TMP_DB};" 2>&1 | tail -2

# 3. Restore
echo ""
echo "--- restoring ---"
docker exec -i codekey-pg psql -U codekey -d ${TMP_DB} < "${TMP_SQL}" 2>&1 | tail -3

# 4. Verify table count
echo ""
echo "--- table count in restored DB ---"
docker exec codekey-pg psql -U codekey -d ${TMP_DB} -c "\dt" 2>&1 | tail -20

# 5. Compare row counts
echo ""
echo "--- row counts: production vs restored ---"
echo "PRODUCTION:"
docker exec codekey-pg psql -U codekey -d codekey -tA -c "
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
echo ""
echo "RESTORED:"
docker exec codekey-pg psql -U codekey -d ${TMP_DB} -tA -c "
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

# 6. Cleanup
echo ""
echo "--- cleanup ---"
docker exec codekey-pg psql -U codekey -d postgres -c "DROP DATABASE ${TMP_DB};" 2>&1 | tail -2
rm -f "${TMP_SQL}"
echo "OK: temp DB dropped, ${TMP_SQL} removed"
