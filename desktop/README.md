# ClosedHand for Mac (desktop app)

The single-download version of ClosedHand: one app that runs the whole stack
on this Mac. It grew out of the Bridge app and keeps Bridge's bundle identity
(`ai.closedhand.bridge`, signed by the same team), so a Mac that already
granted Bridge its permissions keeps them.

The Docker install in the repo root is untouched by any of this. It stays the
route for a Mac mini, a VPS, Windows and Linux, and for anyone who prefers
containers. Same code, same database layout, same setup page.

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

## Not yet

- Bridge's Mac capabilities in-process (files, apps, screen): milestone 2.
- The sandbox (ClosedHand's own browser): milestone 3. `SANDBOX_URL` is empty
  and the webapp knows it is the desktop app (`CLOSEDHAND_DESKTOP=1`).
- Notarisation, auto-update, an Intel build and the download page: milestone 4.
- MCP servers run with `uvx` need Python's `uv`, which the app does not bundle.
