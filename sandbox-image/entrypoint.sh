#!/bin/bash
set -e

# 1. Fix workspace ownership (Railway volumes mount as root)
chown sandbox:sandbox /workspace 2>/dev/null || true
mkdir -p /tmp/matplotlib && chown sandbox:sandbox /tmp/matplotlib
# Browser profile lives ON the volume so logins survive redeploys
mkdir -p /workspace/.chromium-profile && chown -R sandbox:sandbox /workspace/.chromium-profile

# 2. Downloads go to workspace
mkdir -p /home/sandbox/.config
cat > /home/sandbox/.config/user-dirs.dirs <<'XDGEOF'
XDG_DOWNLOAD_DIR="/workspace"
XDG_DOCUMENTS_DIR="/workspace"
XDGEOF
chown -R sandbox:sandbox /home/sandbox/.config

# 3. Start Xvfb (1920x1080), supervised. Chrome already had a supervisor; the
# display it depends on did not, so an OOM-killed Xvfb left Chrome
# crash-looping on "Missing X server" for ever with nothing to heal it.
xvfb_supervisor() {
    while true; do
        gosu sandbox Xvfb :99 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset || true
        echo "[entrypoint] Xvfb exited, restarting" >&2
        sleep 1
    done
}
xvfb_supervisor &
sleep 0.5

export DISPLAY=:99

# 4. Openbox, same treatment: without it windows lose management quietly.
openbox_supervisor() {
    while true; do
        gosu sandbox env DISPLAY=:99 openbox || true
        echo "[entrypoint] openbox exited, restarting" >&2
        sleep 1
    done
}
openbox_supervisor &
sleep 0.3

# 5. Launch Chrome in near-fullscreen (persistent profile on volume).
# Fresh profile: open Google sign-in so the first thing a user does is log in.
START_URL="about:blank"
if [ ! -d /workspace/.chromium-profile/Default ]; then
    START_URL="https://accounts.google.com"
fi

# Chrome IS the interface on this machine. There is no dock, panel or desktop to
# relaunch it from, so closing the last tab used to quit Chrome and leave the
# user staring at a black screen with no way back, and take the CDP port down
# with it so the bot could not use the browser either. Keep it running: on exit
# it comes straight back on a new tab page, the way closing the last tab behaves
# on a normal desktop.
browser_supervisor() {
    local url="$1"
    local fails=0 started ran
    while true; do
        started=$(date +%s)
        if [ -n "$url" ]; then
            gosu sandbox env DISPLAY=:99 /usr/local/bin/chromium-launcher \
                --start-maximized --window-size=1920,1040 --window-position=0,0 \
                --disable-session-crashed-bubble --hide-crash-restore-bubble --no-first-run "$url" || true
        else
            gosu sandbox env DISPLAY=:99 /usr/local/bin/chromium-launcher \
                --start-maximized --window-size=1920,1040 --window-position=0,0 \
                --disable-session-crashed-bubble --hide-crash-restore-bubble --no-first-run || true
        fi
        ran=$(( $(date +%s) - started ))
        url=""  # relaunches land on the new tab page, not the first-run sign-in
        echo "[entrypoint] Chrome exited after ${ran}s, restarting" >&2

        # Exiting instantly and repeatedly means the profile or display is
        # broken, not that a user closed a tab. Back off rather than spin.
        if [ "$ran" -lt 5 ]; then fails=$((fails + 1)); else fails=0; fi
        if [ "$fails" -ge 5 ]; then
            echo "[entrypoint] Chrome failed to stay up $fails times, waiting 30s" >&2
            sleep 30
            fails=0
        else
            sleep 1
        fi
    done
}
browser_supervisor "$START_URL" &
sleep 1

# 6. VNC server, supervised: -forever only survives client disconnects, not
# the X server it is attached to going away.
x11vnc_supervisor() {
    while true; do
        gosu sandbox x11vnc -display :99 -nopw -shared -forever -rfbport 5900 -xkb -q || true
        echo "[entrypoint] x11vnc exited, restarting" >&2
        sleep 2
    done
}
x11vnc_supervisor &
sleep 0.3

# 7. Start websockify on IPv6 (Railway routes internal traffic via IPv6)
gosu sandbox websockify --web=/usr/share/novnc/ [::]:6080 localhost:5900 &

# 8. Run the CMD (agent server)
exec gosu sandbox env DISPLAY=:99 "$@"
