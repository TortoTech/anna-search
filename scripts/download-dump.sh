#!/bin/sh
set -eu

DIR=/data/dumps
mkdir -p "$DIR"

# Anna's Archive — aacid zlib3_records (Z-Library metadata, ~21.4 GB)
# 来源: https://annas-archive.gl/dyn/torrents.json
MAGNET="${MAGNET:-magnet:?xt=urn:btih:57a0493f9bb32271d6c9b473194dc7513355bf96&dn=annas_archive_meta__aacid__zlib3_records__20240809T171652Z--20260211T235731Z.jsonl.seekable.zst.torrent&tr=udp://tracker.opentrackr.org:1337/announce}"

TRACKERS="${BT_TRACKERS:-udp://tracker.opentrackr.org:1337/announce,udp://open.stealth.si:80/announce,udp://exodus.desync.com:6969/announce,udp://tracker.torrent.eu.org:451/announce,udp://explodie.org:6969/announce}"

echo "==> Downloading zlib3_records metadata dump (~21.4 GB) to $DIR"

exec aria2c \
  --dir="$DIR" \
  --seed-time=0 \
  --bt-stop-timeout="${BT_STOP_TIMEOUT:-900}" \
  --bt-tracker="$TRACKERS" \
  --max-tries=0 \
  --retry-wait=10 \
  --listen-port=6881 \
  --dht-listen-port=6881 \
  --enable-dht=true \
  --bt-request-peer-speed-limit=20M \
  --file-allocation=none \
  --summary-interval=30 \
  --console-log-level=notice \
  "$MAGNET"
