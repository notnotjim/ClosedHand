#!/bin/bash
# Unlike the Docker image, a full Linux guest supports Chromium's own sandbox.
set -eu
rm -f /workspace/.chromium-profile/Singleton{Lock,Socket,Cookie}
args=()
for arg in "$@"; do
    # Restoring the profile should not add another blank tab on every wake.
    if [ "$arg" = about:blank ] && [ -f /workspace/.chromium-profile/Default/Preferences ]; then continue; fi
    args+=("$arg")
done
exec /usr/bin/chromium --user-data-dir=/workspace/.chromium-profile \
    --remote-debugging-port=9222 --no-first-run --no-default-browser-check \
    --password-store=basic --restore-last-session "${args[@]}"
