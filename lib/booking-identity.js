// lib/booking-identity.js — when are two bookings the same booking?
//
// The scanner asks a model to read confirmation emails, and the model's
// wording wobbles from pass to pass: "Ngũ Hành Sơn, Vietnam" one time and
// "Ngũ Hành Sơn, Da Nang, Vietnam" the next, check-in at midnight or at
// three in the afternoon. Identity must not rest on that wording. It rests
// on things that hold still: the email a booking came from, its reference,
// and for a stay the nights it covers. Pure functions, no database.

const HOUR = 3600000;

function norm(x) {
  return String(x || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
function refOf(b) {
  return String((b && b.reference) || "").replace(/[\s-]+/g, "").toUpperCase();
}
function ms(v) {
  const t = Date.parse(v || "");
  return isNaN(t) ? null : t;
}
function close(a, b, hours) {
  return a != null && b != null && Math.abs(a - b) <= hours * HOUR;
}
// Two provider names agree when either is missing, one contains the other
// ("Airbnb" and "Airbnb (host Hoan)"), or they open with the same word.
function providersAgree(a, b) {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  return na.split(" ")[0] === nb.split(" ")[0];
}
// Two place strings agree when either is missing or they share a word of
// substance (three letters or more).
function placesAgree(a, b) {
  const wa = norm(a).split(" ").filter((w) => w.length >= 3);
  const wb = norm(b).split(" ").filter((w) => w.length >= 3);
  if (!wa.length || !wb.length) return true;
  return wa.some((w) => wb.includes(w));
}
// How much of the shorter interval the two intervals share, 0 to 1.
function overlap(a, b) {
  const sa = ms(a.starts_at), ea = ms(a.ends_at), sb = ms(b.starts_at), eb = ms(b.ends_at);
  if ([sa, ea, sb, eb].some((v) => v == null)) return 0;
  const shared = Math.min(ea, eb) - Math.max(sa, sb);
  const shorter = Math.min(ea - sa, eb - sb);
  if (shorter <= 0) return 0;
  return Math.max(0, shared) / shorter;
}

// The same booking, judged on what holds still:
//  - when both carry a reference, the reference decides;
//  - otherwise the kind and provider must agree, and then a stay is the same
//    stay when the two span mostly the same nights at an agreeing place,
//    and a timed booking is the same when it starts within three hours.
function sameBooking(a, b) {
  if (!a || !b) return false;
  const ra = refOf(a), rb = refOf(b);
  if (ra && rb) return ra === rb;
  if (String(a.kind || "") !== String(b.kind || "")) return false;
  if (!providersAgree(a.provider, b.provider)) return false;
  if (a.ends_at && b.ends_at) return overlap(a, b) >= 0.5 && placesAgree(a.location, b.location);
  return close(ms(a.starts_at), ms(b.starts_at), 3);
}

// Two rows from the same email are one booking when they are of one kind
// and sit on the same nights (a stay) or start together (a timed booking).
// A return train is two bookings from one email, hours or days apart, and
// stays two rows. Two references that differ are two bookings.
function sameFromEmail(a, b) {
  if (!a || !b || !a.source_email_id || a.source_email_id !== b.source_email_id) return false;
  if (String(a.kind || "") !== String(b.kind || "")) return false;
  const ra = refOf(a), rb = refOf(b);
  if (ra && rb && ra !== rb) return false;
  if (a.ends_at && b.ends_at) return overlap(a, b) >= 0.5;
  return close(ms(a.starts_at), ms(b.starts_at), a.kind === "hotel" ? 24 : 3);
}

// The row a freshly extracted booking should update, or null when it is new.
// The email it came from is the strongest tie; failing that, sameBooking
// across emails. `claimed` holds ids already taken by other new rows from
// the same pass so two bookings from one email keep two rows.
function findMatch(row, existing, claimed = new Set()) {
  const free = existing.filter((x) => x && x.id && !claimed.has(x.id));
  const byStart = (list) => list.slice().sort((x, y) => Math.abs((ms(x.starts_at) || 0) - (ms(row.starts_at) || 0)) - Math.abs((ms(y.starts_at) || 0) - (ms(row.starts_at) || 0)))[0] || null;
  return byStart(free.filter((x) => sameFromEmail(row, x))) || byStart(free.filter((x) => sameBooking(row, x)));
}

// Merged fields for the surviving row: a reference is never lost, details
// gain what the other row knew, everything else comes from `fresh`.
function mergeInto(fresh, old) {
  const details = Object.assign({}, (old && old.details) || {}, (fresh && fresh.details) || {});
  return Object.assign({}, fresh, {
    reference: fresh.reference || (old && old.reference) || null,
    details,
  });
}

// Rows already in the table that are one booking wearing several rows.
// Returns the survivors with their merged patch and the ids to drop. The
// survivor is the row with a reference, else the most recently updated.
function mergePlan(rows) {
  const groups = [];
  for (const r of rows) {
    const g = groups.find((grp) => grp.some((x) => sameFromEmail(x, r) || sameBooking(x, r)));
    if (g) g.push(r); else groups.push([r]);
  }
  const keep = [], drop = [];
  for (const g of groups) {
    if (g.length < 2) continue;
    const ordered = g.slice().sort((x, y) => (ms(y.updated_at) || 0) - (ms(x.updated_at) || 0));
    const survivor = ordered.find((x) => refOf(x)) || ordered[0];
    let patch = survivor;
    for (const other of ordered) if (other !== survivor) patch = mergeInto(patch, other);
    keep.push({ id: survivor.id, patch: { reference: patch.reference, details: patch.details } });
    for (const other of g) if (other !== survivor) drop.push(other.id);
  }
  return { keep, drop };
}

module.exports = { sameBooking, sameFromEmail, findMatch, mergeInto, mergePlan, overlap, placesAgree, providersAgree };
