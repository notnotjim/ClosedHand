// Backport the QR-registration refresh and pre-login ACK fixes until Baileys
// releases them: WhiskeySockets/Baileys PRs #2765 and #2749.
// Apply before importing Baileys. Keep upgrades explicit: an unexpected source
// layout fails rather than silently shipping a partially patched protocol.
const fs = require("fs");
const path = require("path");

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error("Baileys pairing backport needs review for this library version");
  return source.replace(before, after);
}

function patchSocket(source) {
  if (source.includes("// ClosedHand: pairing registration refresh")) return source;
  source = replaceOnce(source, "    // QR gen\n", `    // ClosedHand: pairing registration refresh
    let refreshPairingQR;
    ws.on('CB:notification,type:companion_reg_refresh', node => {
        if (creds.me || !ws.isOpen) return;
        if (!getBinaryNodeChild(node, 'companion_reg_refresh') &&
            !getBinaryNodeChild(node, 'pair-device-rotate-qr')) return;
        creds.advSecretKey = randomBytes(32).toString('base64');
        ev.emit('creds.update', { advSecretKey: creds.advSecretKey });
        logger.info('pairing registration refreshed; updating QR');
        refreshPairingQR?.();
    });
    // QR gen
`);
  source = replaceOnce(source, "        const advB64 = creds.advSecretKey;", `        let currentRef;
        refreshPairingQR = () => {
            if (!currentRef || !ws.isOpen || creds.me) return;
            const qr = buildPairingQRData(currentRef, noiseKeyB64, identityKeyB64, creds.advSecretKey, browser);
            ev.emit('connection.update', { qr });
        };`);
  source = replaceOnce(source, `            const qr = buildPairingQRData(ref, noiseKeyB64, identityKeyB64, advB64, browser);
            ev.emit('connection.update', { qr });`, `            currentRef = ref;
            refreshPairingQR();`);
  return source;
}

function patchReceiver(source) {
  const fixed = "buildAckStanza(node, errorCode, authState.creds.me?.id)";
  if (source.includes(fixed)) return source;
  return replaceOnce(source, "buildAckStanza(node, errorCode, authState.creds.me.id)", fixed);
}

function applyPairingFix() {
  const lib = path.dirname(require.resolve("@whiskeysockets/baileys"));
  const files = [["socket.js", patchSocket], ["messages-recv.js", patchReceiver]];
  // Validate both transforms before writing either file.
  const changes = files.map(([name, transform]) => {
    const file = path.join(lib, "Socket", name);
    const before = fs.readFileSync(file, "utf8");
    return { file, before, after: transform(before) };
  });
  for (const { file, before, after } of changes) {
    if (before !== after) fs.writeFileSync(file, after);
  }
}

module.exports = { applyPairingFix, patchSocket, patchReceiver };
