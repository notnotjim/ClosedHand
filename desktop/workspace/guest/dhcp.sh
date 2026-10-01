#!/bin/sh
set -eu
case "$1" in
    bound|renew)
        ip addr flush dev "$interface"
        ip addr add "$ip/${mask:-24}" dev "$interface"
        for gateway in $router; do ip route replace default via "$gateway" dev "$interface"; break; done
        ;;
esac
