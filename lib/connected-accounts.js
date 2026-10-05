// Every account connected for a service: the first one and any added after
// it, which are kept as <service>_extra_<slug> (google_extra_work,
// microsoft_extra_home). Reporting only the first told an agent that a second
// Gmail, whose booking it had just changed, was "not connected".
function accountsFor(connections, key) {
  const label = (c) => c?.metadata?.email || c?.metadata?.name || c?.metadata?.shopDomain || null;
  const out = [];
  if (connections?.[key]?.tokens) out.push(label(connections[key]));
  for (const [k, c] of Object.entries(connections || {})) {
    if (k.startsWith(key + "_extra_") && c?.tokens) out.push(label(c));
  }
  return out.filter(Boolean);
}
module.exports = { accountsFor };
