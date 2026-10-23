// Go always-on in one button (webapp/railway-move.js): Railway's sign-in as a
// native app with PKCE, back through closedhand.com, then a project made from
// the template in Amsterdam with a setup code Closedhand chose, and the move
// once the new Closedhand answers. Railway is played here by a stand-in.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

process.env.RAILWAY_CLIENT_ID = "test-client";
const railwayMove = require("../webapp/railway-move");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

test("only a personal URL or the computer itself can be sent back to", () => {
  assert.equal(railwayMove.backAddress("https://quiet-isle-53.closedhand.ai"), "https://quiet-isle-53.closedhand.ai");
  assert.equal(railwayMove.backAddress("http://localhost:3000"), "http://localhost:3000");
  assert.equal(railwayMove.backAddress("http://127.0.0.1:4100"), "http://127.0.0.1:4100");
  for (const bad of ["https://evil.example", "http://quiet-isle-53.closedhand.ai", "https://a.closedhand.ai.evil.example", "https://user:pw@quiet-isle-53.closedhand.ai", "", null])
    assert.equal(railwayMove.backAddress(bad), null, String(bad));
  assert.throws(() => railwayMove.begin("https://evil.example"), /personal URL/);
});

test("the sign-in is PKCE with no secret, and says where to come back to", () => {
  const url = new URL(railwayMove.begin("https://quiet-isle-53.closedhand.ai"));
  assert.equal(url.origin + url.pathname, "https://backboard.railway.com/oauth/auth");
  const q = url.searchParams;
  assert.equal(q.get("client_id"), "test-client");
  assert.equal(q.get("redirect_uri"), "https://closedhand.com/railway/return");
  assert.equal(q.get("code_challenge_method"), "S256");
  assert.match(q.get("code_challenge"), /^[A-Za-z0-9_-]{43}$/);
  assert.match(q.get("scope"), /\bworkspace:member\b/);
  const state = JSON.parse(Buffer.from(q.get("state"), "base64url").toString());
  assert.equal(state.b, "https://quiet-isle-53.closedhand.ai");
  assert.ok(state.s.length >= 32);
  assert.ok(!url.href.includes("secret"));
});

test("a stale or cancelled sign-in moves nothing", () => {
  railwayMove.begin("http://localhost:3000");
  railwayMove.finish({ code: "c", state: Buffer.from(JSON.stringify({ b: "http://localhost:3000", s: "not-this-one" })).toString("base64url") }, { startMove: () => assert.fail("moved") });
  assert.equal(railwayMove.status().step, "failed");
  assert.match(railwayMove.status().error, /expired/);
  const state = new URL(railwayMove.begin("http://localhost:3000")).searchParams.get("state");
  railwayMove.finish({ error: "access_denied", state }, { startMove: () => assert.fail("moved") });
  assert.match(railwayMove.status().error, /cancelled\. Nothing has moved/);
});

test("back from Railway: a project from the template in Amsterdam, its own setup code, then the move", async () => {
  const signIn = new URL(railwayMove.begin("http://localhost:3000"));
  const challenge = signIn.searchParams.get("code_challenge");
  const calls = [];
  let polls = 0;
  const config = { services: {
    a: { name: "db", variables: { POSTGRES_PASSWORD: { defaultValue: "${{secret(32)}}" } } },
    b: { name: "webapp", deploy: { healthcheckPath: "/health" }, variables: { PORT: { defaultValue: "3000" }, SETUP_CODE: { defaultValue: "${{secret(24)}}" } } },
    c: { name: "bot", variables: {} },
    d: { name: "sandbox", variables: {} },
  } };
  const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
  const fakeFetch = async (url, opts = {}) => {
    calls.push({ url, opts });
    if (url === "https://backboard.railway.com/oauth/token") {
      const form = new URLSearchParams(String(opts.body));
      assert.equal(form.get("grant_type"), "authorization_code");
      assert.equal(form.get("code"), "the-code");
      assert.equal(form.get("client_id"), "test-client");
      assert.equal(form.get("redirect_uri"), "https://closedhand.com/railway/return");
      assert.equal(crypto.createHash("sha256").update(form.get("code_verifier")).digest("base64url"), challenge, "the verifier matches the challenge");
      assert.ok(!form.has("client_secret") && !(opts.headers || {}).Authorization, "no secret");
      return reply({ access_token: "tok", token_type: "Bearer", expires_in: 3600 });
    }
    if (url === "https://backboard.railway.com/graphql/v2") {
      assert.equal(opts.headers.Authorization, "Bearer tok");
      const { query, variables } = JSON.parse(opts.body);
      if (/me \{ workspaces/.test(query)) return reply({ data: { me: { workspaces: [{ id: "ws1" }] } } });
      if (/template\(code/.test(query)) { assert.equal(variables.c, "ob3IfQ"); return reply({ data: { template: { id: "tpl", serializedConfig: JSON.parse(JSON.stringify(config)) } } }); }
      if (/projectCreate/.test(query)) { assert.equal(variables.i.workspaceId, "ws1"); return reply({ data: { projectCreate: { id: "proj", environments: { edges: [{ node: { id: "env" } }] } } } }); }
      if (/templateDeployV2/.test(query)) return reply({ data: { templateDeployV2: { projectId: "proj" } } });
      if (/project\(id/.test(query)) {
        polls++;
        const status = polls < 2 ? "DEPLOYING" : "SUCCESS";
        return reply({ data: { project: { services: { edges: [{ node: { name: "webapp", serviceInstances: { edges: [{ node: { latestDeployment: { status }, domains: { serviceDomains: [{ domain: "webapp-production-1.up.railway.app" }] } } }] } } }] } } } });
      }
    }
    if (url === "https://webapp-production-1.up.railway.app/health") return reply({ ok: true });
    throw new Error("unexpected " + url);
  };
  const moved = new Promise((resolve) => {
    railwayMove.finish({ code: "the-code", state: signIn.searchParams.get("state") }, { fetch: fakeFetch, pollMs: 1, startMove: resolve });
  });
  assert.equal(railwayMove.status().step, "setting-up");
  const to = await moved;
  assert.equal(to.address, "https://webapp-production-1.up.railway.app");
  assert.match(to.code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{24}$/);
  const deploy = JSON.parse(calls.find((c) => /templateDeployV2/.test(c.opts.body || "")).opts.body).variables.i;
  assert.deepEqual([deploy.templateId, deploy.projectId, deploy.environmentId, deploy.workspaceId], ["tpl", "proj", "env", "ws1"]);
  for (const svc of Object.values(deploy.serializedConfig.services))
    assert.deepEqual(svc.deploy.multiRegionConfig, { "europe-west4-drams3a": { numReplicas: 1 } }, svc.name + " in Amsterdam");
  assert.equal(deploy.serializedConfig.services.b.deploy.healthcheckPath, "/health", "the template's own settings kept");
  assert.equal(deploy.serializedConfig.services.b.variables.SETUP_CODE.defaultValue, to.code, "the setup code the move then uses");
  assert.equal(deploy.serializedConfig.services.a.variables.POSTGRES_PASSWORD.defaultValue, "${{secret(32)}}", "other secrets still made by Railway");
  assert.equal(railwayMove.status(), null, "from here the move itself reports");
});

test("Settings is one button, and closedhand.com passes the sign-in straight on", () => {
  const dash = read("webapp/views/dashboard.html");
  assert.match(dash, /<button type="button" class="account-action-btn" id="move-go" onclick="startRailwayMove\(\)">Move to Railway<\/button>/);
  assert.doesNotMatch(dash, /move-address|move-code|railway\.com\/deploy/, "nothing to copy or paste");
  assert.match(dash, /window\.top\.location\.href = j\.url;/);
  const server = read("webapp/server.js");
  assert.match(server, /app\.get\("\/api\/move\/railway\/return"[\s\S]{0,300}res\.redirect\("\/\?dash=%23settings"\)/);
  assert.match(server, /canGoAlwaysOn: !setupCode\.enabled && moveMarker\.available\(\) && railwayMove\.available\(\)/);
  const site = read("closedhand-com/server.js");
  assert.match(site, /app\.get\('\/railway\/return'[\s\S]{0,500}new URL\('\/api\/move\/railway\/return', back\)/);
  assert.match(site, /if \(u\.protocol === 'https:'\) return require\('\.\/public\/entry-navigation'\)\.registeredAddress\(u\.origin\);/);
});

test("Closedhand's own Railway app is built in, so Go always-on is there without setup", () => {
  assert.match(read("webapp/railway-move.js"), /const CLIENT_ID = process\.env\.RAILWAY_CLIENT_ID \|\| "rlwy_oaci_[A-Za-z0-9]+";/);
  assert.doesNotMatch(read("webapp/railway-move.js"), /client_secret|CLIENT_SECRET/, "no secret, anywhere");
});

test("a move that fails after the project was made takes the project away, so nothing is left on the bill", async () => {
  const run = async (failAt) => {
    const signIn = new URL(railwayMove.begin("http://localhost:3000"));
    const calls = [];
    const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
    const fakeFetch = async (url, opts = {}) => {
      if (url.endsWith("/oauth/token")) return reply({ access_token: "tok" });
      if (url.endsWith("/health")) return reply({ ok: true });
      const { query } = JSON.parse(opts.body);
      calls.push(query.match(/\b(me|template|projectCreate|templateDeployV2|projectDelete|project)\b/)[1]);
      if (/me \{ workspaces/.test(query)) return reply({ data: { me: { workspaces: [{ id: "ws1" }] } } });
      if (/template\(code/.test(query)) return reply({ data: { template: { id: "tpl", serializedConfig: { services: { b: { name: "webapp", variables: {} } } } } } });
      if (/projectCreate/.test(query)) return reply({ data: { projectCreate: { id: "proj", environments: { edges: [{ node: { id: "env" } }] } } } });
      if (/templateDeployV2/.test(query)) return failAt === "deploy" ? reply({ errors: [{ message: "Your trial has ended" }] }) : reply({ data: { templateDeployV2: { projectId: "proj" } } });
      if (/projectDelete/.test(query)) return reply({ data: { projectDelete: true } });
      return reply({ data: { project: { services: { edges: [{ node: { name: "webapp", serviceInstances: { edges: [{ node: { latestDeployment: { status: "SUCCESS" }, domains: { serviceDomains: [{ domain: "w.up.railway.app" }] } } }] } } }] } } } });
    };
    let moveStep = "sending";
    await new Promise((resolve) => {
      railwayMove.finish({ code: "c", state: signIn.searchParams.get("state") },
        { fetch: fakeFetch, pollMs: 1, startMove: () => { moveStep = "failed"; }, moveStatus: () => ({ step: moveStep }) });
      setTimeout(resolve, 80);
    });
    return calls;
  };
  const atDeploy = await run("deploy");
  assert.deepEqual(atDeploy.slice(-2), ["templateDeployV2", "projectDelete"], "a deploy Railway refuses");
  assert.match(railwayMove.status().error, /Your trial has ended\. Nothing has moved/);
  const laterOn = await run("move");
  assert.equal(laterOn[laterOn.length - 1], "projectDelete", "a move that stops after it started");
});
