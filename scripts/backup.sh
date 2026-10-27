#!/usr/bin/env bash
# Compressed MongoDB backup with retention. Run from cron, e.g. hourly to meet the 1-hour data-loss target:
#   0 * * * * /opt/pharmacy/scripts/backup.sh >> /var/log/pharmacy-backup.log 2>&1
# Env: MONGODB_URI (required), BACKUP_DIR (default ./backups), BACKUP_KEEP_DAYS (default 14),
#      BACKUP_UPLOAD_CMD (optional off-site copy, e.g. 'aws s3 cp "$FILE" s3://my-bucket/pharmacy/'
#                         or 'rclone copy "$FILE" remote:pharmacy-backups'). Off-site storage is required by NFR-06.
set -euo pipefail
: "${MONGODB_URI:?MONGODB_URI must be set}"
DIR="${BACKUP_DIR:-./backups}"; KEEP="${BACKUP_KEEP_DAYS:-14}"
mkdir -p "$DIR"
FILE="$DIR/pharmacy-$(date -u +%Y%m%dT%H%M%SZ).archive.gz"
mongodump --uri="$MONGODB_URI" --archive="$FILE" --gzip --quiet
echo "backup written: $FILE ($(du -h "$FILE" | cut -f1))"
if [ -n "${BACKUP_UPLOAD_CMD:-}" ]; then export FILE; bash -c "$BACKUP_UPLOAD_CMD"; echo "uploaded off-site"; fi
find "$DIR" -name 'pharmacy-*.archive.gz' -mtime +"$KEEP" -delete
