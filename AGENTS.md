# ClosedHand: project rules

Rules for working on this codebase, for anyone doing it, human or agent. Personal
working preferences are deliberately not here: they belong outside the repo, so
they neither get published nor drift out of step with a second copy.

## Architecture
- Two services: Bot (`index.js`) and Webapp (`webapp/server.js`), run as separate processes
  (docker compose in the self-host setup)
- They share the database but CANNOT import each other's code. Shared code is vendored into
  both (kept byte-identical); everything else communicates through the database.
- Vanilla HTML/CSS/JS only for the dashboard. No React, no Tailwind, no build step.
- Use available UI skills for design work. Never code UI from scratch.

## Code Standards
- Copy sells what it does for the user, never how it works. "A thousand songs in
  your pocket", not "512MB of storage": mechanism words (index, background, cache,
  API, embed) do not belong in user-facing copy; one concrete moment from the
  user's life does. (2026-08-30)
- No emdashes anywhere. Use commas, full stops, or rewrite.
- Simplicity first. Minimal changes. Don't over-engineer.
- No temporary fixes. Find root causes.
- Verify syntax before committing. Run `node -c` on all changed JS files.
- Check inline script syntax in dashboard.html before pushing (a parse error ships a
  dashboard with no working script).
- Gate `git push` behind checks with `&&`, never `;`, so a failed check stops the push.

## User-Facing Copy
- The bot is "ClosedHand", not "your assistant".
- It's chat-based. Don't call anything "voice control".
- Key positioning phrase: "recalls by meaning, not just keywords" (Context Brain / File
  Search copy). Reuse it, don't invent variants. The "just" is load-bearing: retrieval
  has been hybrid since August 2026, meaning and exact words fused, so the old phrasing
  ("not keywords") is false and must not come back.
- "Knowledge base" is called "Context Brain" (the dashboard knowledge-base feature ONLY);
  the homepage file-retrieval tab is "File Search". Distinct features never share a name.
- Memory vocabulary, used exactly and everywhere: "Pinned facts" are the facts ClosedHand
  pins about the user; "Context Notes" are the distilled summaries of past conversations;
  both live in "Context Brain". Never "saved memory", bare "notes", or invented synonyms.
  A destructive action names what it deletes and what it keeps in these terms.
- Don't name-drop specific AI models to users. "ClosedHand picks the best model", never
  "Opus is working on it".
- LLM providers are equal. No provider gets special treatment, fallback priority, or
  hardcoded references. Each provider is fully isolated.
- No staccato ad-copy ("We do X. We don't do Y. No Z."). Plain flowing sentences that
  state facts directly.
- Connected services sort to the top, not the bottom.
- The stance is part of the copy: anti big tech, pro privacy, the user owns the lot.
  Explain a chore by who gets to see your data, in words anyone knows: "other apps
  read your Google data through their own company first; ClosedHand has no company in
  between". Never "key", "credential", "server" or "OAuth" where "your data" and
  "company" will do. State what, why and how like a friend would; never sell, never
  persuade, no "the one cost is". The facts speak for themselves. Brief, readable at a
  glance. (James, 2026-09-05)
- Two tiers share the home page and dashboard, so copy there must be true for the
  hosted product as well as self-host. The installer, the setup page and the Google
  guide are self-host only and can say "this machine" outright. (James, 2026-09-05)
- Names: the self-host onboarding at /setup is "the setup page" (never "wizard"); the
  Google console walkthrough at /setup/google is "the Google guide". Two things, two
  names. (James, 2026-09-05)

## Workflow
- Plan first for anything with 3+ steps.
- When something goes sideways, stop and re-plan. Don't keep pushing the same approach.
- Verify before marking done. Don't just assume it works.
