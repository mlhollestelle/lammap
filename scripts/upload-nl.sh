#!/usr/bin/env bash
# Uploads the output of scripts/collect-nl.mjs to the R2 bucket with rclone. The collector runs it
# (see pi/README.md), with R2_DEST set to the rclone remote and bucket, e.g. r2:lammap-data.
#
#   scripts/upload-nl.sh live   live.json, every 5 minutes
#   scripts/upload-nl.sh fd     the day files, station list and meta.json, every 30 minutes, and
#                               deletes the days the page no longer shows
set -euo pipefail
OUT=${OUT:-nl}
: "${R2_DEST:?set R2_DEST to the rclone remote and bucket, e.g. r2:lammap-data}"
DEST="$R2_DEST/nl"
# All files are stored gzipped, so browsers unpack them.
json=(--header-upload "Content-Type: application/json" --header-upload "Content-Encoding: gzip")

put_gz() {
  gzip -9 -n -c "$OUT/$1" > "$OUT/.$1.gz"
  rclone copyto -q "$OUT/.$1.gz" "$DEST/$1" "${json[@]}" --header-upload "Cache-Control: $2"
  rm -f "$OUT/.$1.gz"
}

case "${1:-}" in
  live)
    put_gz live.json "public, max-age=60"
    ;;
  fd)
    # The collector writes the day files gzipped. Today's grow during the day, so they are cached briefly;
    # only files that changed are uploaded.
    rclone copy -q "$OUT/fd" "$DEST/fd" "${json[@]}" --header-upload "Cache-Control: public, max-age=300"
    for f in stations.json meta.json; do put_gz "$f" "public, max-age=300"; done
    # The page shows the last 7 days and today.
    cutoff=$(TZ=Europe/Amsterdam date -d "-7 day" +%F)
    rclone lsf -q --dirs-only "$DEST/fd" | while read -r day; do
      day=${day%/}
      if [[ "$day" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ && "$day" < "$cutoff" ]]; then
        rclone purge -q "$DEST/fd/$day"
      fi
    done
    ;;
  *) echo "usage: $0 live|fd" >&2; exit 2 ;;
esac
