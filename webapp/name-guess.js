// name-guess.js: vendored. lib/name-guess.js and webapp/name-guess.js are
// byte-identical (scripts/vendored-manifest.json).
//
// The setup scan guesses the person's name from their mail and files what it
// read about them under that name. A guess can be wrong: one read "Robbie"
// from shops greeting the address while the person signs "Robert", and the
// guess stayed in Context Brain after they said otherwise. When the person
// says what they want to be called and the first names differ, the guess
// goes: its profile-name note is removed, and the scan's other notes are
// filed under the chosen name, so Closedhand never holds two names for them.

const first = (v) => String(v || "").trim().split(/\s+/)[0].toLowerCase();

function unpack(raw) {
  if (raw && typeof raw === "object") return raw;
  try {
    const o = JSON.parse(raw);
    return o && typeof o === "object" ? o : { value: raw };
  } catch (_) {
    return { value: raw };
  }
}

// rows: [{ key, value, subject }] as the facts table holds them.
function plan(rows, chosen) {
  const none = { remove: [], refile: [], guessed: null };
  const all = Array.isArray(rows) ? rows : [];
  const row = all.find((r) => r.key === "profile-name");
  const guess = row ? unpack(row.value) : null;
  if (!guess || guess.source !== "setup scan" || !first(chosen) || first(guess.value) === first(chosen)) return none;
  const guessed = String(guess.value);
  const refile = all
    .filter((r) => r.key !== "profile-name" && unpack(r.value).source === "setup scan")
    .filter((r) => r.subject === guessed || unpack(r.value).subject === guessed)
    .map((r) => r.key);
  return { remove: ["profile-name"], refile, guessed };
}

// db: the Supabase-shaped client; store: the bot's loaded UserStore, if any;
// removeVector(userId, key): drops the note's copy in recall.
async function correct({ db, userId, chosen, store = null, removeVector = null }) {
  const { data, error } = await db.from("facts").select("key, value, subject").eq("user_id", userId);
  if (error || !data) return { removed: 0, refiled: 0 };
  const p = plan(data, chosen);
  const name = String(chosen).trim();
  let removed = 0, refiled = 0;
  for (const key of p.remove) {
    const { error: e } = await db.from("facts").delete().eq("user_id", userId).eq("key", key);
    if (e) { console.error(`[name-guess] could not remove ${key}: ${e.message}`); continue; }
    if (store && store.facts) delete store.facts[key];
    if (removeVector) await Promise.resolve(removeVector(userId, key)).catch(() => {});
    removed++;
  }
  for (const key of p.refile) {
    const value = { ...unpack(data.find((r) => r.key === key).value), subject: name };
    const { error: e } = await db.from("facts").update({ subject: name, value: JSON.stringify(value), updated_at: new Date().toISOString() }).eq("user_id", userId).eq("key", key);
    if (e) { console.error(`[name-guess] could not refile ${key}: ${e.message}`); continue; }
    if (store && store.facts && store.facts[key] && typeof store.facts[key] === "object") store.facts[key].subject = name;
    refiled++;
  }
  return { removed, refiled };
}

module.exports = { plan, correct };
