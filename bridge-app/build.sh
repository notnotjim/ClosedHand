#!/bin/sh
# Builds Closedhand Bridge, the menu bar app that gives a Closedhand running in
# Docker access to a Mac, into the signed DMG the dashboard offers for
# download (webapp/public/download/ClosedHandBridge.dmg).
#
#   VERSION=1.7.0 IDENTITY="Developer ID Application: ..." bridge-app/build.sh
#   desktop/notarize.sh webapp/public/download/ClosedHandBridge.dmg
#
# Without IDENTITY the app is ad hoc signed, which is only good for checking
# that it builds. The Closedhand Mac app (desktop/) carries the same Bridge
# code, so this download is only for Docker setups.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
VERSION="${VERSION:?Set VERSION, for example VERSION=1.7.0}"
SHA="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo dev)"
ARCH="${ARCH:-arm64}"
STAGE="$HERE/.build/stage"
APP="$STAGE/ClosedHandBridge.app"
OUT="${OUT:-$ROOT/webapp/public/download/ClosedHandBridge.dmg}"
say() { printf '\033[1m%s\033[0m\n' "$*"; }

say "Building Closedhand Bridge $VERSION at $SHA"
(cd "$HERE" && swift build -c release --arch "$ARCH")
BIN="$HERE/.build/$ARCH-apple-macosx/release/ClosedHandBridge"
[ -x "$BIN" ] || BIN="$HERE/.build/release/ClosedHandBridge"
[ -x "$BIN" ] || { echo "swift build produced no executable"; exit 1; }
BUNDLE_RES="$(dirname "$BIN")/ClosedHandBridge_ClosedHandBridge.bundle"

say "Assembling the app"
rm -rf "$STAGE" && mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/ClosedHandBridge"
[ -d "$BUNDLE_RES" ] && cp -R "$BUNDLE_RES" "$APP/Contents/Resources/"
cp "$ROOT/desktop/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
sed -e "s/__VERSION__/$VERSION/g" -e "s/__SHA__/$SHA/g" "$HERE/Info.plist" > "$APP/Contents/Info.plist"
plutil -lint "$APP/Contents/Info.plist" >/dev/null

say "Signing"
if [ -n "${IDENTITY:-}" ]; then
  codesign --force --timestamp --options runtime --entitlements "$HERE/Sources/ClosedHandBridge.entitlements" --sign "$IDENTITY" "$APP"
else
  codesign --force --entitlements "$HERE/Sources/ClosedHandBridge.entitlements" --sign - "$APP"
fi
codesign --verify --deep --strict "$APP"

say "Making the DMG"
ln -s /Applications "$STAGE/Applications"
TMP_DMG="$HERE/.build/ClosedHandBridge-$VERSION.dmg"
rm -f "$TMP_DMG"
hdiutil create -quiet -volname "Closedhand Bridge" -srcfolder "$STAGE" -ov -format UDZO "$TMP_DMG"
if [ -n "${IDENTITY:-}" ]; then codesign --force --timestamp --sign "$IDENTITY" "$TMP_DMG"; fi
mv "$TMP_DMG" "$OUT"
say "Built $OUT"
