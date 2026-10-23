// webapp/railway-move.js: Go always-on in one button.
//
// Railway asks the person to sign in (or make an account) and let Closedhand
// set itself up in their own Railway account: Login with Railway, as a
// native app with PKCE, so there is no secret to keep, and the access is used
// for this one move and then dropped. Closedhand then makes a project from its
// template, every service in Amsterdam and with a setup code it chose itself,
// waits for the new Closedhand to answer, and moves everything across
// (move.js). Nothing to copy or paste.
//
// Railway sends the person back to one fixed address, closedhand.com's
// /railway/return, which passes the code straight on to this Closedhand,
// wherever it is reached from. The code is no use without the verifier, which
// never leaves this computer.
const crypto = require("crypto");

// Closedhand's app on Railway, registered as native with PKCE: the ID is
// public, like Closedhand's Google app ID, and there is no secret to hold.
const CLIENT_ID = process.env.RAILWAY_CLIENT_ID || "rlwy_oaci_az4hdCpq4U0seDvW20wyzStx";
const AUTHORIZE = "https://backboard.railway.com/oauth/auth";
const TOKEN = "https://backboard.railway.com/oauth/token";
const API = "https://backboard.railway.com/graphql/v2";
const RETURN = "https://closedhand.com/railway/return";
// Closedhand's template on Railway (railway.com/deploy/closedhand), by its
// ID: its short name changed when it was published, its ID never does.
const TEMPLATE = "86557f2f-7a26-46c6-9599-0b9c8f422dab";
const REGION = "europe-west4-drams3a"; // Amsterdam
const SETUP_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
// Long enough to make a Railway account and add a card on the way.
const SIGN_IN_TIME = 60 * 60 * 1000;
const START_TIME = 20 * 60 * 1000;

let pending = null; // { nonce, verifier, at }: a sign-in under way
let setup = null; // { step, error }: before the move itself starts

// The address this Closedhand is reached at, as the browser that pressed the
// button sees it: its personal URL, or this computer itself.
function backAddress(origin) {
  let u;
  try { u = new URL(String(origin || "")); } catch (_) { return null; }
  if (u.username || u.password || u.pathname !== "/" || u.search || u.hash) return null;
  if (u.protocol === "https:" && /^[a-z][a-z0-9-]{1,30}[a-z0-9]\.closedhand\.ai$/.test(u.hostname)) return u.origin;
  if (u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname)) return u.origin;
  return null;
}

const base64url = (buf) => Buffer.from(buf).toString("base64url");

function available() { return !!CLIENT_ID; }

// The Railway sign-in to send the browser to.
function begin(origin) {
  if (!CLIENT_ID) throw new Error("Going always-on isn't available in this version of Closedhand.");
  const back = backAddress(origin);
  if (!back) throw new Error("Open Closedhand at its personal URL or on its own computer to move it.");
  if (setup && !["failed"].includes(setup.step)) throw new Error("A move is already under way.");
  const nonce = base64url(crypto.randomBytes(24));
  const verifier = base64url(crypto.randomBytes(48));
  pending = { nonce, verifier, at: Date.now() };
  setup = null;
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: RETURN,
    scope: "openid email profile workspace:member",
    state: base64url(JSON.stringify({ b: back, s: nonce })),
    code_challenge: base64url(crypto.createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
    prompt: "consent",
  });
  return AUTHORIZE + "?" + params;
}

// Back from Railway: check it is this sign-in, take the access, and set up.
// Returns at once; status() follows it.
function finish({ code, state, error }, deps) {
  const p = pending;
  pending = null;
  let nonce = null;
  try { nonce = JSON.parse(Buffer.from(String(state || ""), "base64url").toString("utf8")).s; } catch (_) {}
  if (!p || !nonce || nonce !== p.nonce || Date.now() - p.at > SIGN_IN_TIME) {
    setup = { step: "failed", error: "That Railway sign-in has expired. Press Move to Railway again." };
    return;
  }
  if (error || !code) {
    setup = { step: "failed", error: "Railway sign-in was cancelled. Nothing has moved." };
    return;
  }
  setup = { step: "setting-up" };
  run(String(code), p.verifier, deps).catch((e) => {
    console.error("[railway-move]", e.message);
    setup = { step: "failed", error: e.said ? e.message : "Railway didn't finish setting it up. Nothing has moved; Closedhand carries on here." };
  });
}

async function run(code, verifier, deps) {
  const doFetch = deps.fetch || fetch;
  const said = (message) => Object.assign(new Error(message), { said: true });
  const tokenRes = await doFetch(TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: RETURN, client_id: CLIENT_ID, code_verifier: verifier }),
    signal: AbortSignal.timeout(30000),
  });
  const tokens = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokens.access_token) throw new Error(`token exchange ${tokenRes.status}`);
  const gql = async (query, variables = {}) => {
    const r = await doFetch(API, {
      method: "POST",
      headers: { Authorization: "Bearer " + tokens.access_token, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(60000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.errors) {
      const reason = (j.errors && j.errors[0] && j.errors[0].message) || `Railway answered ${r.status}`;
      throw said(`Railway didn't set it up: ${reason}. Nothing has moved; Closedhand carries on here.`);
    }
    return j.data;
  };

  // 1. The workspace the person let Closedhand into.
  const workspaces = ((await gql("query { me { workspaces { id } } }")).me || {}).workspaces || [];
  if (!workspaces.length) throw said("Railway didn't give Closedhand a workspace to set up in. Press Move to Railway and choose one.");
  const workspaceId = workspaces[0].id;

  // 2. The template, in Amsterdam, with a setup code chosen here.
  const template = (await gql("query($t: String!) { template(id: $t) { id serializedConfig } }", { t: TEMPLATE })).template;
  const config = template.serializedConfig;
  const setupCode = Array.from(crypto.randomBytes(24), (b) => SETUP_LETTERS[b % SETUP_LETTERS.length]).join("");
  for (const service of Object.values(config.services || {})) {
    service.deploy = { ...(service.deploy || {}), multiRegionConfig: { [REGION]: { numReplicas: 1 } } };
    if (service.name === "webapp") service.variables = { ...service.variables, SETUP_CODE: { ...(service.variables || {}).SETUP_CODE, defaultValue: setupCode } };
  }

  // 3. A project of its own, with the template deployed into it. A move that
  // fails from here on takes the project away again, so nothing is left
  // running on the person's Railway bill.
  const project = (await gql("mutation($i: ProjectCreateInput!) { projectCreate(input: $i) { id environments { edges { node { id } } } } }",
    { i: { name: "Closedhand", workspaceId } })).projectCreate;
  const removeProject = () => gql("mutation($p: String!) { projectDelete(id: $p) }", { p: project.id })
    .catch((e) => console.error("[railway-move] could not remove the project it made:", e.message));
  try {
    await deployAndMove(gql, doFetch, deps, { template, config, project, workspaceId, setupCode });
  } catch (e) {
    await removeProject();
    throw e;
  }
  watchMove(deps, removeProject);
}

async function deployAndMove(gql, doFetch, deps, { template, config, project, workspaceId, setupCode }) {
  const said = (message) => Object.assign(new Error(message), { said: true });
  const environmentId = project.environments.edges[0].node.id;
  await gql("mutation($i: TemplateDeployV2Input!) { templateDeployV2(input: $i) { projectId } }",
    { i: { templateId: template.id, serializedConfig: config, projectId: project.id, environmentId, workspaceId } });

  // 4. Wait for the new Closedhand to answer at its address.
  const started = Date.now();
  let address = null;
  while (Date.now() - started < START_TIME) {
    await new Promise((r) => setTimeout(r, deps.pollMs || 10000));
    const services = (await gql(`query($p: String!) { project(id: $p) { services { edges { node { name serviceInstances { edges { node {
      latestDeployment { status } domains { serviceDomains { domain } } } } } } } } } }`, { p: project.id })).project.services.edges.map((e) => e.node);
    const webapp = services.find((s) => s.name === "webapp");
    const instance = webapp && webapp.serviceInstances.edges[0] && webapp.serviceInstances.edges[0].node;
    const status = instance && instance.latestDeployment && instance.latestDeployment.status;
    if (["FAILED", "CRASHED"].includes(status)) throw said("Closedhand didn't start on Railway. Nothing has moved; Closedhand carries on here.");
    const domain = instance && instance.domains.serviceDomains[0] && instance.domains.serviceDomains[0].domain;
    if (status !== "SUCCESS" || !domain) continue;
    const health = await doFetch(`https://${domain}/health`, { signal: AbortSignal.timeout(10000) }).catch(() => null);
    if (health && health.ok) { address = `https://${domain}`; break; }
  }
  if (!address) throw said("Closedhand took too long to start on Railway. Nothing has moved; Closedhand carries on here.");

  // 5. The move itself, as if its address and code had been pasted in.
  setup = null;
  deps.startMove({ address, code: setupCode });
}

// Follows the move it started: one that stops takes the Railway project away.
function watchMove(deps, removeProject) {
  if (!deps.moveStatus) return;
  const timer = setInterval(() => {
    const step = (deps.moveStatus() || {}).step;
    if (step === "done") clearInterval(timer);
    else if (step === "failed") { clearInterval(timer); removeProject(); }
  }, deps.pollMs || 5000);
  if (timer.unref) timer.unref();
}

function status() { return setup; }

module.exports = { available, begin, finish, status, backAddress, RETURN };
