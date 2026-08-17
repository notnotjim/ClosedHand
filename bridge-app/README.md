# ClosedHand Bridge (macOS app)

The Mac app that lets ClosedHand act on the user's own computer: calendar, files,
shell, browser, accessibility, and raw input. It connects out to the bot over a
WebSocket and waits for actions, so it needs no inbound network access.

It lives in this repo rather than its own because it is one half of a wire
protocol. The action names it implements (`browser.execute_js`, `files.read`,
`ax.click`, and so on) are dispatched from `lib/tools/handlers.js`, and the two
sides have to agree. Keeping them together means a change to the protocol is one
commit instead of two repos drifting apart, which is how the browser tools ended
up Safari-only on the app side while the server offered them for Chrome too.

## Layout

- `Sources/BridgeManager.swift` receives actions and routes them to a bridge
- `Sources/Bridges/*.swift` one file per capability area
- `Sources/*View.swift` menu bar UI, settings, onboarding
- `ClosedHandBridge-Permissions.mobileconfig` the TCC permissions profile

## Build

```sh
cd bridge-app
swift build -c release
```

## Install over an existing copy

The app in `/Applications` is a bundle; `swift build` produces only the
executable inside it. Replace the binary and re-sign with the same Developer ID
so the code signature keeps its identity, otherwise macOS treats it as a
different app and the user has to grant Accessibility and Automation again.

```sh
cp .build/release/ClosedHandBridge /Applications/ClosedHandBridge.app/Contents/MacOS/
codesign --force --sign "Developer ID Application: james chatt-ramsey (826NDD62L9)" \
  /Applications/ClosedHandBridge.app
```

Quit the app first if it is running, and check `codesign -dv` afterwards.

## Browsers

Safari and Chrome both drive through AppleScript but use different vocabularies,
so `BrowserBridge` builds each script per browser. Every browser action takes a
`browser` param (`safari` default, or `chrome`) and callers must keep it
consistent: reading Safari after opening a page in Chrome shows a different
browser with different sessions, which looks like the user is signed out.

Chrome refuses JavaScript from AppleScript unless a hidden Develop-menu option
is ticked, and sending users hunting through menus is not something ClosedHand
does. `BrowserBridge` treats that refusal as a routing signal instead:

- Reading a page falls back to Chrome's accessibility tree automatically, using
  the Accessibility permission granted during onboarding. The caller gets the
  text either way, with `method: "accessibility"` noting how.
- Clicking and typing have no script-free equivalent for CSS selectors, so the
  error tells the *model* to use `bridge_ax_click` / `bridge_ax_set_value` on
  Google Chrome, or to use Safari. It never instructs the user.

Most Chrome actions never needed scripting anyway: active tab, tab listing, tab
switching, closing and navigation are all plain AppleScript.
