#!/bin/sh
# Всеки ден в 03:30: pg_dump → /backups/qr-ГГГГ-ММ-ДД.sql.gz; пази 14 дни.
while true; do
  now=$(date +%H%M)
  if [ "$now" = "0330" ] || [ ! -f /backups/.first ]; then
    f="/backups/qr-$(date +%F).sql.gz"
    if pg_dump -h db -U postgres qr | gzip > "$f.tmp"; then mv "$f.tmp" "$f"; touch /backups/.first; echo "архив: $f"; fi
    find /backups -name 'qr-*.sql.gz' -mtime +14 -delete
    sleep 61
  fi
  sleep 30
done
