# ClosedHand for Mac (desktop app)

The single-download version of ClosedHand: one app that runs the whole stack
on this Mac. It grew out of the Bridge app and keeps Bridge's bundle identity
(`ai.closedhand.bridge`, signed by the same team), so a Mac that already
granted Bridge its permissions keeps them.

The Docker install in the repo root is another way to run ClosedHand on Mac,
Windows or Linux, including a VPS. A Mac can use either method. Same code, same
database layout, same setup page. Docker uses the separate Bridge app for access
to a Mac’s files and apps; this app includes that access.

## What the app does

`Sources/ClosedHand/Supervisor.swift` is Docker Compose in a menu-bar app:

- a bundled Postgres 16 with pgvector, initialised on first launch into
  `~/Library/Application Support/ClosedHand/pgdata` with the baseline schema,
  exactly as the pgvector image does on its first boot;
- the bot (`index.js`) and the webapp (`webapp/server.js`) as child processes,
  with the environment the compose file gives them; the bot runs its own
  migrations on boot as on Docker;
- the generated secrets install.sh would put in `.env`, kept in
  `config.env` beside the data (mode 600);
- ports: 3000/3001 when free, the nearest free ones otherwise (a Docker
  ClosedHand on the same Mac keeps its own), remembered for next time;
- logs in `~/Library/Application Support/ClosedHand/logs`;
- a clean stop on quit: node processes first, then a fast Postgres shutdown.

The dashboard opens in the default browser, not an embedded web view, because
Google refuses to sign in inside embedded views and the setup page needs it.

## Build

```sh
desktop/build.sh                                   # ad-hoc signed, this Mac only
IDENTITY="Developer ID Application: ..." desktop/build.sh   # for distribution
```

The first build fetches Node 22 and builds Postgres + pgvector from source
(`pg.sh`, a few minutes), then stages the repo at HEAD with production
dependencies for this architecture. All of it is cached in `desktop/.cache`.
`SOURCE=worktree` stages the working tree instead of HEAD; `REUSE_APP=1`
skips the npm install. Output: `desktop/dist/ClosedHand.app`.

Signing: every Mach-O inside (dylibs, `.node` addons, the Node and Postgres
executables) is signed on its own, Node and Postgres with
`Runtime.entitlements` (JIT and unsigned executable memory, which V8 needs
under the hardened runtime), then the app with `ClosedHand.entitlements`.

## Layout inside the bundle

```
ClosedHand.app/Contents/
  MacOS/ClosedHand                 the Swift shell
  Resources/node/bin/node          Node runtime (+ npm and npx for MCP servers run by command)
  Resources/pg/{bin,lib,share}     relocatable Postgres + pgvector
  Resources/app/                   the repo: index.js, lib/, webapp/, migrations/, skills/
```

## The Workspace

The container's agent (`sandbox-image/agent`) runs on the Mac with
`SANDBOX_MODE=desktop`: a workspace folder in the app's data, a Python that uv
(bundled) sets up on first start with the image's package set, and the user's
own Chrome launched with ClosedHand's profile on a debugging port. Code the
model runs is confined with `sandbox-exec` and a profile the app writes
(`workspace.sb`): it can read the system, the bundle and the workspace, write
only the workspace, and use the network. The Computers tab watches the
Workspace browser through screenshots.

## Release

`desktop/dmg.sh` wraps the built app in a signed DMG; `desktop/notarize.sh`
submits it to Apple with the `closedhand` keychain profile and staples the
ticket. `.github/workflows/build-desktop.yml` does both for arm64 and x86_64
on a `v*` tag, given the signing and notary secrets.

## Not yet

- Auto-update (Sparkle), an Intel test, bundle trimming.
- The sandbox image in a Linux VM (Virtualization.framework), the fuller
  isolation story for the Workspace.
