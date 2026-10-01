#!/bin/bash
# Launch the user-facing browser: stock Google Chrome with the persistent
# profile on the /workspace volume so logins survive redeploys.
# The debug port lets agents attach to this same browser via CDP, so the
# user watches bot actions live over VNC and shares its logins.
CHROME=""
for c in /usr/bin/google-chrome-stable /usr/bin/chromium /usr/bin/chromium-browser; do
    if [ -x "$c" ]; then CHROME="$c"; break; fi
done
if [ -z "$CHROME" ]; then
    echo "ERROR: no Chrome/Chromium binary found" >&2
    exit 1
fi
# An unclean exit (OOM kill, container stop) leaves a SingletonLock in the
# profile on the persistent volume, pointing at a PID that is now gone. On
# restart Chrome sees the lock, decides another Chrome owns the profile, and
# refuses to start, crash-looping for ever on a machine where Chrome IS the
# screen. Nothing here is ever a second real Chrome on this profile, the
# supervisor runs exactly one, so clearing these stale locks on launch is
# always safe.
rm -f /workspace/.chromium-profile/SingletonLock \
      /workspace/.chromium-profile/SingletonSocket \
      /workspace/.chromium-profile/SingletonCookie 2>/dev/null || true

# --test-type suppresses the "--no-sandbox is unsupported" infobar
# (the container is the isolation layer; Chrome's own sandbox can't run here)
exec "$CHROME" \
    --user-data-dir=/workspace/.chromium-profile \
    --remote-debugging-port=9222 \
    --no-first-run --no-default-browser-check \
    --test-type \
    --no-sandbox --disable-dev-shm-usage "$@"
