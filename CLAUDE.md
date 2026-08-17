# ClosedHand Project Rules

## Architecture
- Two services: Bot (`index.js`) and Webapp (`webapp/server.js`), run as separate processes
  (docker compose in the self-host setup)
- They share the database but CANNOT import each other's code. Shared code is vendored into
  both (kept byte-identical); everything else communicates through the database.
- Vanilla HTML/CSS/JS only for the dashboard. No React, no Tailwind, no build step.
- Use available UI skills for design work. Never code UI from scratch.

## Code Standards
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
- Key positioning phrase: "recalls by meaning, not keywords" (Context Brain / File Search
  copy). Reuse it, don't invent variants.
- "Knowledge base" is called "Context Brain" (the dashboard knowledge-base feature ONLY);
  the homepage file-retrieval tab is "File Search". Distinct features never share a name.
- Don't name-drop specific AI models to users. "ClosedHand picks the best model", never
  "Opus is working on it".
- LLM providers are equal. No provider gets special treatment, fallback priority, or
  hardcoded references. Each provider is fully isolated.
- No staccato ad-copy ("We do X. We don't do Y. No Z."). Plain flowing sentences that
  state facts directly.
- Connected services sort to the top, not the bottom.

## Workflow
- Plan first for anything with 3+ steps.
- When something goes sideways, stop and re-plan. Don't keep pushing the same approach.
- Verify before marking done. Don't just assume it works.
