// Every account connected for a service: the first one and any added after
// it, which are kept as <service>_extra_<slug> (google_extra_work,
// microsoft_extra_home). Reporting only the first told an agent that a second
// Gmail, whose booking it had just changed, was "not connected".
// An account its provider stopped accepting says so, so it is never reported
// as working.
function accountsFor(connections, key) {
  const name = (c) => c?.metadata?.email || c?.metadata?.name || c?.metadata?.shopDomain || null;
  const label = (c) => name(c) && (c.metadata?.reconnect_required ? `${name(c)} (needs signing in again)` : name(c));
  const out = [];
  if (connections?.[key]?.tokens) out.push(label(connections[key]));
  for (const [k, c] of Object.entries(connections || {})) {
    if (k.startsWith(key + "_extra_") && c?.tokens) out.push(label(c));
  }
  return out.filter(Boolean);
}
module.exports = { accountsFor };
