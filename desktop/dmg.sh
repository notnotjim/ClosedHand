#!/bin/sh
# Wraps desktop/dist/Closedhand.app in a DMG that opens to a laid-out window
# (the app, an arrow, an Applications shortcut, over desktop/dmg's background),
# and signs the DMG when IDENTITY is set. Output: desktop/dist/Closedhand-<version>-<arch>.dmg
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$HERE/dist/Closedhand.app"
[ -d "$APP" ] || { echo "Build the app first: desktop/build.sh"; exit 1; }
# Never wrap a half-signed app: the notary rejects the whole archive for one bad binary.
codesign --verify --deep --strict "$APP" || { echo "The app's signature does not verify; rebuild first."; exit 1; }
VERSION="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$APP/Contents/Info.plist")"
ARCH="${ARCH:-$(uname -m)}"
OUT="$HERE/dist/Closedhand-$VERSION-$ARCH.dmg"

# dmgbuild lays the window out without driving Finder, so it works on a build
# machine with no one logged in. Pinned, in its own environment.
TOOLS="$HERE/.cache/dmgbuild"
if [ ! -x "$TOOLS/bin/dmgbuild" ]; then
  python3 -m venv "$TOOLS"
  "$TOOLS/bin/pip" install --quiet "dmgbuild==1.6.7"
fi
# One background file holding both sizes, so Retina screens get the sharp one.
WORK="$(mktemp -d)"
tiffutil -cathidpicheck "$HERE/dmg/background.png" "$HERE/dmg/background@2x.png" -out "$WORK/background.tiff" >/dev/null 2>&1

rm -f "$OUT"
# hdiutil (under dmgbuild) can fail with "Resource busy" while the system is
# still scanning a freshly written app (GitHub's macOS machines especially):
# try again, and show its error rather than failing silently.
for try in 1 2 3; do
  "$TOOLS/bin/dmgbuild" -s "$HERE/dmg/settings.py" -D app="$APP" -D background="$WORK/background.tiff" "Closedhand" "$OUT" && break
  if [ "$try" = 3 ]; then rm -rf "$WORK"; echo "Could not create the DMG."; exit 1; fi
  sleep 15
done
rm -rf "$WORK"
if [ -n "${IDENTITY:-}" ]; then codesign --force --timestamp --sign "$IDENTITY" "$OUT"; fi
echo "$OUT"
