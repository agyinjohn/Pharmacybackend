#!/usr/bin/env bash
# Restore a backup made by backup.sh into the database named in MONGODB_URI.
# Test this at least twice a year (NFR-06): restore into a scratch database and run `npm run smoke` style checks.
#   MONGODB_URI=mongodb://localhost:27017/pharmacy_restore_test scripts/restore.sh backups/pharmacy-2026....archive.gz
set -euo pipefail
: "${MONGODB_URI:?MONGODB_URI must be set}"
FILE="${1:?usage: restore.sh <backup.archive.gz>}"
read -r -p "This DROPS existing collections in the target database. Type YES to continue: " OK
[ "$OK" = "YES" ] || { echo aborted; exit 1; }
mongorestore --uri="$MONGODB_URI" --archive="$FILE" --gzip --drop --nsInclude='*.*'
echo "restore complete"
