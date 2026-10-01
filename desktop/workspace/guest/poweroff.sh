#!/bin/sh
trap '' HUP PIPE
echo '[Workspace] Saving files before shutdown'
pkill -TERM -x entrypoint.sh 2>/dev/null || true
# Ask the browser to close normally so its cookie store is committed. Killing
# all Chromium subprocesses together can lose recently created sign-ins.
node <<'JS'
const http = require('http');
const WebSocket = require('/app/node_modules/ws');
setTimeout(() => process.exit(0), 3000);
const req = http.get('http://127.0.0.1:9222/json/version', response => {
    let text = ''; response.on('data', chunk => text += chunk);
    response.on('end', () => {
        try {
            const ws = new WebSocket(JSON.parse(text).webSocketDebuggerUrl);
            ws.on('open', () => ws.send(JSON.stringify({id:1,method:'Browser.close'})));
            ws.on('close', () => process.exit(0));
            ws.on('error', () => process.exit(0));
        } catch { process.exit(0); }
    });
});
req.on('error', () => process.exit(0));
JS
for attempt in 1 2 3 4 5; do
    pgrep -x chromium >/dev/null || break
    sleep 1
done
pkill -TERM -x chromium 2>/dev/null || true
pkill -TERM -x node 2>/dev/null || true
sync
echo '[Workspace] Files saved, powering off'
poweroff -f
