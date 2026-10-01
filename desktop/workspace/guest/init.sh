#!/bin/bash
# PID 1. No host directories or host credentials are mounted in this guest.
set -eu
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
mountpoint -q /proc || mount -t proc proc /proc
mountpoint -q /sys || mount -t sysfs sysfs /sys
mountpoint -q /dev || mount -t devtmpfs devtmpfs /dev
mkdir -p /dev/pts /dev/shm
mount -t devpts devpts /dev/pts
mount -t tmpfs -o mode=1777,size=512m tmpfs /dev/shm
mount -t tmpfs -o mode=755,size=32m tmpfs /run
mount -t tmpfs -o mode=1777,size=512m tmpfs /tmp
mount -t tmpfs -o mode=755,size=32m tmpfs /var/log
modprobe virtio_rng
mkdir -p /run/dbus
dbus-daemon --system --nofork --nopidfile --nosyslog &
echo '[Workspace] Preparing the persistent disk'

TOKEN=""
for arg in $(cat /proc/cmdline); do
    case "$arg" in closedhand.token=*) TOKEN="${arg#closedhand.token=}" ;; esac
done
[[ "$TOKEN" =~ ^[0-9a-f]{48}$ ]] || { echo 'Workspace token missing'; exec sleep infinity; }

# Format only a genuinely blank disk. Never silently replace damaged data.
if ! blkid /dev/vdb >/dev/null 2>&1; then
    if [ "$(dd if=/dev/vdb bs=4096 count=1 2>/dev/null | tr -d '\000' | wc -c)" -ne 0 ]; then
        echo 'Workspace disk is not blank and could not be opened'; exec sleep infinity
    fi
    mkfs.ext4 -q -m 0 -L workspace /dev/vdb
fi
mount -o nosuid,nodev /dev/vdb /workspace
mkdir -p /workspace/.home /workspace/.chromium-profile
chown sandbox:sandbox /workspace /workspace/.home /workspace/.chromium-profile
echo '[Workspace] Disk ready, starting the network'

ip link set lo up
modprobe virtio_net
modprobe vmw_vsock_virtio_transport
# Guest programs can reach the internet, but not the Mac or its local network.
# Only the narrow, authenticated connected-service gateway crosses to the host.
iptables -P INPUT DROP
iptables -A INPUT -i lo -j ACCEPT
iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A INPUT -p udp --sport 67 --dport 68 -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -p udp --sport 68 --dport 67 -j ACCEPT
for range in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 224.0.0.0/4; do
    iptables -A OUTPUT -d "$range" -j REJECT
done
ip6tables -P INPUT DROP
ip6tables -P OUTPUT DROP
ip6tables -A INPUT -i lo -j ACCEPT
ip6tables -A OUTPUT -o lo -j ACCEPT
IFACE=$(ls /sys/class/net | awk '$0 != "lo" { print; exit }')
ip link set "$IFACE" up
printf 'nameserver 1.1.1.1\nnameserver 1.0.0.1\n' > /run/resolv.conf
busybox udhcpc -i "$IFACE" -s /usr/local/sbin/closedhand-dhcp -b -q &
echo '[Workspace] Network ready, starting the browser'

export SANDBOX_TOKEN="$TOKEN" USER_ID=admin GATEWAY_URL=http://127.0.0.1:9001
export WORKSPACE=/workspace EXEC_HOME=/home/sandbox SANDBOX_MODE=vm
export DISPLAY=:99 MPLBACKEND=Agg MPLCONFIGDIR=/tmp/matplotlib
# Host -> guest API and desktop. These are not exposed on the guest network.
socat VSOCK-LISTEN:8080,reuseaddr,fork TCP:127.0.0.1:8080 &
socat VSOCK-LISTEN:6080,reuseaddr,fork TCP:127.0.0.1:6080 &
# Guest -> host, exclusively the existing /gateway/{api,fetch} handler.
gosu sandbox socat TCP-LISTEN:9001,bind=127.0.0.1,reuseaddr,fork VSOCK-CONNECT:2:9001 &
# A graceful host stop flushes the persistent disk before the VM exits.
socat VSOCK-LISTEN:9002,reuseaddr,fork EXEC:'/usr/local/sbin/closedhand-poweroff' &
/entrypoint.sh node /app/server.js &
wait
