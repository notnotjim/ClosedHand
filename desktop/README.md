# ClosedHand for Mac (desktop app)

The native Mac version of ClosedHand: one app that runs the whole stack
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
- a bundled cloudflared connection runtime for the optional personal dashboard
  address, without requiring a separate installation;
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
  Resources/bin/cloudflared        optional dashboard connection runtime
  Resources/pg/{bin,lib,share}     relocatable Postgres + pgvector
  Resources/app/                   the repo: index.js, lib/, webapp/, migrations/, skills/
```

## The Workspace

The browser, code and package installers run as an unprivileged user inside a
Linux VM managed by Apple's Virtualization framework. No Mac folders, browser
profiles, clipboard or application credentials are mounted in it. The root disk
is read-only; files, installed user packages and browser sign-ins live on a
separate persistent disk. Chromium also retains its Linux namespace/seccomp
sandbox. The optional real-Mac controls still use Bridge outside the VM, with
exactly the same permissions as before.

The signed app includes a manifest pinning the kernel, initial RAM disk and
compressed Linux disk by SHA-256. Its small host controller downloads and checks
these on first use, without blocking chat, recall, setup or connected services.
The Computers panel shows download/startup progress and opens the same interactive
browser used by Docker installations. No Docker installation is required.

`WorkspaceVM` exposes only private Unix sockets backed by virtio sockets. The
guest can reach public internet addresses; its firewall blocks private networks.
The only guest-to-host service is the authenticated `/gateway/api` and
`/gateway/fetch` proxy. Provider credentials remain on the host, provider URLs
are restricted, and generic fetches pin validated public DNS addresses.

The VM has two CPUs and a 2 GiB memory capacity. It starts on demand and stops
after 15 minutes without requests, a browser viewer, running user programs or
unfinished downloads. Its persistent disk survives shutdown and app updates.
Health polling alone never starts it. A failed VM never falls back to executing
Workspace code on the Mac. Native file access remains a separate Bridge choice.

Upgrades import regular files from the old native Workspace without deleting or
overwriting the originals. Mac Python environments, native dependencies and
Mac-encrypted browser profiles remain in the old folder. Existing native
Workspace browser sign-ins need renewing once in the new Linux browser. New
sign-ins persist across VM restarts. This does not affect the user's own browser
or Docker's existing Workspace profile.

Build a runtime with `bash desktop/workspace/build-runtime.sh OUTPUT_DIRECTORY`.
Docker is needed by this maintainer build only. Publish the generated kernel,
initrd and compressed root disk to the manifest's versioned GitHub release; copy
the generated manifest into `desktop/workspace/manifest.json` for the app build.
The VM runtime currently targets Apple Silicon, matching the public Mac download.

## Release

`desktop/dmg.sh` wraps the built app in a signed DMG; `desktop/notarize.sh`
submits it to Apple with the `closedhand` keychain profile and staples the
ticket. `.github/workflows/build-desktop.yml` does both for Apple Silicon
on a `v*` tag, given the signing and notary secrets.

## Not yet

- Auto-update (Sparkle), an Intel test, bundle trimming.
