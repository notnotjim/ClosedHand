#!/bin/bash
# Build on Linux or a Mac with Docker. Docker is a build dependency only.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT=${1:?Pass an output directory}
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
mkdir "$OUT/.build-lock" || { echo 'A Workspace build already owns this output directory.'; exit 1; }
SOURCE=''
trap 'if [ -n "$SOURCE" ]; then docker rm "$SOURCE" >/dev/null; fi; rmdir "$OUT/.build-lock"' EXIT
IMAGE=closedhand-workspace-vm:build
docker build --platform linux/arm64 -f "$ROOT/desktop/workspace/guest/Dockerfile" -t "$IMAGE" "$ROOT"
SOURCE=$(docker create "$IMAGE")
# Stream the export, avoiding a second multi-gigabyte tar file on the Mac.
docker export "$SOURCE" | docker run --rm -i --platform linux/arm64 --entrypoint /bin/bash \
    -v "$OUT:/out" "$IMAGE" -c '
set -euo pipefail
mkdir /rootfs
tar -xf - -C /rootfs
rm -f /rootfs/etc/resolv.conf
ln -s /run/resolv.conf /rootfs/etc/resolv.conf
# Docker supplies hosts as a mount, so an exported filesystem leaves it empty.
printf "127.0.0.1 localhost\n::1 localhost\n" > /rootfs/etc/hosts
rm -rf /rootfs/boot/* /rootfs/var/cache/apt/* /rootfs/var/log/*
mkdir -p /rootfs/var/log
truncate -s 3G /out/root.ext4
mkfs.ext4 -q -m 0 -d /rootfs /out/root.ext4
cp /boot/vmlinuz-* /out/kernel
cp /boot/initrd.img-* /out/initrd
'
gzip -c "$OUT/root.ext4" > "$OUT/root.ext4.gz.partial"
mv "$OUT/root.ext4.gz.partial" "$OUT/root.ext4.gz"
node "$ROOT/desktop/workspace/write-manifest.js" "$OUT"
