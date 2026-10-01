// lib/realtime-driver-poll.js — Polling realtime for the pg path.
//
// Emulates the subset of supabase Realtime the app uses:
//   db.channel(name).on("postgres_changes", {event, schema, table, filter}, cb)
//     .subscribe(statusCb?)
//   db.removeChannel(ch)
//
// It polls the table on an interval and fires cb({ eventType, new: row, old })
// for rows newer than a per-subscription high-watermark. This is deliberate, not
// a fallback: on this codebase Realtime is not load-bearing — live web chat uses
// the direct WebSocket (web-chat-ws.js, no Realtime), and the bridge paths carry
// their own poll/sweeper fallbacks. Single-tenant self-host means one user, so a
// 1.5s poll is negligible.
//
// Scope: INSERT is detected via a `created_at` watermark. UPDATE is detected via
// `updated_at` when the table has one; web_messages/bridge_requests do NOT, so
// their UPDATE subs are inert (the web_messages UPDATE only drove a cosmetic
// "typing" tick on the legacy SSE; bridge_requests UPDATE has a 3s poll fallback
// in bridge-relay.js). DELETE is not emulated. Needs `vector`-free plain columns.
//
// Vendored duplicate: webapp/realtime-driver-poll.js must be kept in sync.

const POLL_MS = Number(process.env.REALTIME_POLL_MS) || 1500;

// "user_id=eq.abc" -> { col: "user_id", val: "abc" }. Only the eq operator is used
// by the call-sites; anything else is treated as no filter.
function parseFilter(filter) {
  if (!filter || typeof filter !== "string") return null;
  const m = filter.match(/^([\w.]+)=eq\.(.*)$/);
  return m ? { col: m[1], val: m[2] } : null;
}

class PollChannel {
  constructor(name, db, registry, nowIso) {
    this.name = name;
    this._db = db;
    this._registry = registry;
    this._nowIso = nowIso;
    this._subs = [];
    this._timers = [];
    this._stopped = false;
  }

  on(type, config, cb) {
    if (type === "postgres_changes" && typeof cb === "function") this._subs.push({ config, cb });
    return this;
  }

  subscribe(statusCb) {
    for (const { config, cb } of this._subs) this._startPoll(config, cb);
    this._registry.add(this);
    if (typeof statusCb === "function") { try { statusCb("SUBSCRIBED"); } catch (_) {} }
    return this;
  }

  _startPoll(config, cb) {
    const event = (config && config.event) || "*";
    const table = config && config.table;
    if (!table) return;
    const tsCol = event === "UPDATE" ? "updated_at" : "created_at";
    const f = parseFilter(config && config.filter);
    // Start from "now" so we emit only rows that arrive after subscribe (no replay).
    let watermark = this._nowIso();
    const seen = new Set();

    const poll = async () => {
      if (this._stopped) return;
      try {
        let q = this._db.from(table).select("*");
        if (f) q = q.eq(f.col, f.val);
        q = q.gt(tsCol, watermark).order(tsCol, { ascending: true }).limit(200);
        const { data, error } = await q;
        if (error || !data || !data.length) return; // missing tsCol (e.g. no updated_at) => error => inert
        for (const row of data) {
          // De-dupe by primary key: node-pg parses timestamptz to a ms-precision
          // Date, so advancing the watermark to it leaves the µs-precision boundary
          // row still matching `.gt` next tick. `seen` guarantees one fire per row.
          const key = row.id != null ? String(row.id) : JSON.stringify(row);
          if (seen.has(key)) continue;
          seen.add(key);
          if (row[tsCol]) watermark = row[tsCol];
          try { cb({ eventType: event, new: row, old: {} }); } catch (_) {}
        }
        if (seen.size > 5000) seen.clear(); // bound memory; the watermark keeps us positioned
      } catch (_) { /* transient DB error — try again next tick */ }
    };

    this._timers.push(setInterval(poll, POLL_MS));
  }

  _stop() {
    this._stopped = true;
    for (const t of this._timers) clearInterval(t);
    this._timers = [];
  }

  unsubscribe() { this._stop(); this._registry.delete(this); return this; }
}

// `db` is the pg client (must expose .from().select().eq().gt().order().limit()).
// `nowIso` lets tests inject a clock; defaults to real time.
function createPollRealtime(db, { nowIso } = {}) {
  const registry = new Set();
  const clock = nowIso || (() => new Date().toISOString());
  return {
    channel(name) { return new PollChannel(name, db, registry, clock); },
    removeChannel(ch) { if (ch && ch._stop) ch._stop(); registry.delete(ch); },
    removeAllChannels() { for (const ch of registry) ch._stop(); registry.clear(); },
  };
}

module.exports = { createPollRealtime, _internals: { parseFilter } };
