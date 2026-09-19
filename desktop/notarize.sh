#!/bin/sh
# Sends a DMG to Apple's notary service, waits, and staples the ticket.
#
# One-time setup on the machine that runs this (an App Store Connect API key
# or an app-specific password; either is fine):
#   xcrun notarytool store-credentials closedhand --apple-id <id> --team-id 826NDD62L9 --password <app-specific-password>
# In CI the same profile is created from secrets before this runs.
set -e
DMG="${1:?usage: notarize.sh <dmg>}"
PROFILE="${NOTARY_PROFILE:-closedhand}"
xcrun notarytool submit "$DMG" --keychain-profile "$PROFILE" --wait
xcrun stapler staple "$DMG"
spctl -a -t open --context context:primary-signature -vv "$DMG" 2>&1 | tail -1
