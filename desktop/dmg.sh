#!/bin/sh
# Wraps desktop/dist/ClosedHand.app in a DMG with an Applications shortcut,
# and signs the DMG when IDENTITY is set. Output: desktop/dist/ClosedHand-<version>-<arch>.dmg
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$HERE/dist/ClosedHand.app"
[ -d "$APP" ] || { echo "Build the app first: desktop/build.sh"; exit 1; }
# Never wrap a half-signed app: the notary rejects the whole archive for one bad binary.
codesign --verify --deep --strict "$APP" || { echo "The app's signature does not verify; rebuild first."; exit 1; }
VERSION="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$APP/Contents/Info.plist")"
ARCH="${ARCH:-$(uname -m)}"
OUT="$HERE/dist/ClosedHand-$VERSION-$ARCH.dmg"
STAGE="$(mktemp -d)"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
rm -f "$OUT"
hdiutil create -quiet -volname "ClosedHand" -srcfolder "$STAGE" -ov -format UDZO "$OUT"
rm -rf "$STAGE"
if [ -n "${IDENTITY:-}" ]; then codesign --force --timestamp --sign "$IDENTITY" "$OUT"; fi
echo "$OUT"
