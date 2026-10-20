// Every server-side secret is kept encrypted or in the system's own secret
// store, and every way of reading one is audited:
// - the secrets a service starts with leave its environment at start and are
//   read only through an audited guard (crypto-tokens.js, guardEnvironment);
// - Docker hands them over as secret files, never as settings, and the Mac
//   apps keep theirs in the Keychain;
// - the linked WhatsApp session, the bug report keys and an emailed sign-in
//   code are sealed like any stored secret;
// - the database logs every connection, and each service names itself.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");

// The guard replaces process.env for good, so it runs in a child process.
function guarded(script, env = {}, secretsDir) {
  const code = `const ct = require(${JSON.stringify(path.join(root, "crypto-tokens.js"))});
ct.guardEnvironment(${secretsDir ? `{ secretsDir: ${JSON.stringify(secretsDir)} }` : ""});
${script}`;
  return execFileSync(process.execPath, ["-e", code], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });
}

test("secrets leave the environment at start, still answer through it, and every read is logged", () => {
  const out = guarded(`
    console.log("LISTED " + JSON.stringify(Object.keys(process.env).filter((k) => /SECRET|_KEY|TOKEN|PASSWORD/.test(k))));
    console.log("VALUE " + process.env.SLACK_SIGNING_SECRET);
    console.log("URL " + process.env.DATABASE_URL);
    console.log("PG " + process.env.PGPASSWORD);
    console.log("COPY " + JSON.stringify({ ...process.env }).includes("brightwater"));
    console.log("CHILD " + require("child_process").execSync("env").toString().includes("brightwater"));
    console.log("PLAIN " + process.env.BASE_URL);`, {
    SLACK_SIGNING_SECRET: "brightwater-signing-0000000000000",
    TOKEN_ENCRYPTION_KEY: crypto.randomBytes(32).toString("base64"),
    DATABASE_URL: "postgres://postgres:brightwater%40db@db:5432/closedhand",
    BASE_URL: "http://localhost:3000",
  });
  assert.match(out, /^LISTED \[\]$/m, "no secret is listed");
  assert.match(out, /^VALUE brightwater-signing-0000000000000$/m, "but each still reads");
  assert.match(out, /^URL postgres:\/\/postgres@db:5432\/closedhand$/m, "the database address loses its password");
  assert.match(out, /^PG brightwater@db$/m, "which the driver reads as PGPASSWORD");
  assert.match(out, /^COPY false$/m);
  assert.match(out, /^CHILD false$/m, "a program it starts inherits none");
  assert.match(out, /^PLAIN http:\/\/localhost:3000$/m);
  assert.match(out, /\[secret-read\] \S+ read SLACK_SIGNING_SECRET/);
  assert.match(out, /\[secret-read\] \S+ read PGPASSWORD/);
  assert.doesNotMatch(out.replace(/^(VALUE|PG) .*$/gm, ""), /brightwater/, "the audit never prints a value");
});

test("Docker secret files are read in, and win over the environment", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ch-secrets-"));
  fs.writeFileSync(path.join(dir, "sandbox_token"), "from-the-file\n");
  fs.writeFileSync(path.join(dir, "pgpassword"), "file-password");
  const out = guarded(`console.log("SANDBOX " + process.env.SANDBOX_TOKEN); console.log("PG " + process.env.PGPASSWORD);`,
    { SANDBOX_TOKEN: "from-the-environment", DATABASE_URL: "postgres://postgres:env-password@db/closedhand" }, dir);
  assert.match(out, /^SANDBOX from-the-file$/m);
  assert.match(out, /^PG file-password$/m);
  assert.match(out, /2 from secret files/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("both services guard their environment before anything else loads", () => {
  for (const [file, mod] of [["index.js", "./crypto-tokens"], ["webapp/server.js", "./crypto-tokens"]]) {
    const src = read(file);
    const guard = src.indexOf(`require("${mod}").guardEnvironment();`);
    assert.ok(guard > 0, file);
    assert.ok(guard < src.indexOf(".assertReady();"), `${file}: before the key is checked`);
    assert.equal(src.slice(0, guard).match(/require\(/g).length, 1, `${file}: only dotenv loads before it`);
  }
});

test("a legacy plain value is audited when read, like a sealed one", () => {
  const out = guarded(`console.log(ct.decryptString("left-from-before", "a test secret"));`, { TOKEN_ENCRYPTION_KEY: crypto.randomBytes(32).toString("base64") });
  assert.match(out, /\[secret-read\] \S+ read a test secret/);
});

test("Docker hands secrets over as files, to the containers that use them, and logs database connections", () => {
  const compose = read("docker-compose.yml");
  assert.doesNotMatch(compose, /\$\{(POSTGRES_PASSWORD|WS_AUTH_SECRET|SANDBOX_TOKEN|COOKIE_SECRET|TOKEN_ENCRYPTION_KEY)/, "no secret comes from .env");
  assert.doesNotMatch(compose, /^\s+(WS_AUTH_SECRET|SANDBOX_TOKEN|POSTGRES_PASSWORD|TOKEN_ENCRYPTION_KEY):/m, "none is a container setting");
  for (const name of ["postgres_password", "token_encryption_key", "ws_auth_secret", "sandbox_token", "cookie_secret"]) {
    assert.match(compose, new RegExp(`  ${name}:\\n    file: \\./secrets/${name}`));
  }
  const service = (name) => compose.slice(compose.indexOf(`\n  ${name}:\n`), compose.indexOf("\n\n", compose.indexOf(`\n  ${name}:\n`)) + 1 || undefined);
  assert.match(service("db"), /POSTGRES_PASSWORD_FILE: \/run\/secrets\/postgres_password/);
  assert.match(service("db"), /secrets: \[postgres_password\]/);
  assert.match(service("db"), /"log_connections=on", "-c", "log_disconnections=on"/);
  assert.match(service("sandbox"), /secrets: \[sandbox_token\]/, "the sandbox gets only its own token");
  assert.match(service("sandbox"), /exit 1/, "and does not start without it");
  assert.doesNotMatch(service("sandbox"), /ports:/, "its screen is not published on the computer's ports");
  assert.match(compose, /DATABASE_URL: postgres:\/\/postgres@db:5432\/\$\{POSTGRES_DB:-closedhand\}\?application_name=closedhand-bot/);
  assert.match(compose, /application_name=closedhand-webapp/);
  assert.match(read(".gitignore"), /^secrets\/$/m, "the secret files are never committed");
  assert.doesNotMatch(read(".env.example"), /^(POSTGRES_PASSWORD|WS_AUTH_SECRET|SANDBOX_TOKEN|TOKEN_ENCRYPTION_KEY)=/m);
});

test("the installer moves an older .env's secrets into secrets/ once, and keeps them", () => {
  const install = read("install.sh");
  const block = install.slice(install.indexOf("# --- Secrets, one file each in secrets/"), install.indexOf("# --- Up ---"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ch-install-"));
  fs.writeFileSync(path.join(dir, ".env"), 'POSTGRES_PASSWORD=pg-brightwater\nPOSTGRES_DB=closedhand\nWS_AUTH_SECRET="ws-brightwater"\nSANDBOX_TOKEN=sb-brightwater\nTOKEN_ENCRYPTION_KEY=a2V5LWJyaWdodHdhdGVyLWtleS1icmlnaHR3YXRlcjA=\nBASE_URL=http://localhost:3000\n');
  const run = () => execFileSync("sh", ["-c", "step() { :; }\n" + block], { cwd: dir });
  run();
  const env = fs.readFileSync(path.join(dir, ".env"), "utf8");
  assert.equal(env, "POSTGRES_DB=closedhand\nBASE_URL=http://localhost:3000\n", "only settings stay in .env");
  const secret = (n) => fs.readFileSync(path.join(dir, "secrets", n), "utf8");
  assert.equal(secret("postgres_password"), "pg-brightwater");
  assert.equal(secret("ws_auth_secret"), "ws-brightwater", "quotes are not part of the value");
  assert.equal(secret("token_encryption_key"), "a2V5LWJyaWdodHdhdGVyLWtleS1icmlnaHR3YXRlcjA=");
  assert.match(secret("cookie_secret"), /^[0-9a-f]{48}$/, "a missing one is made");
  assert.equal(fs.statSync(path.join(dir, "secrets")).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, "secrets", "ws_auth_secret")).mode & 0o777, 0o600);
  run();
  assert.equal(secret("ws_auth_secret"), "ws-brightwater", "a re-run keeps every value");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the linked WhatsApp session is sealed, and plain files from before are sealed in place", async () => {
  process.env.TOKEN_ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY || crypto.randomBytes(32).toString("base64");
  const { useSealedAuthState } = require("../lib/sealed-auth-state");
  const BufferJSON = {
    replacer: (k, v) => (v && v.type === "Buffer" && Array.isArray(v.data) ? { type: "Buffer", data: Buffer.from(v.data).toString("base64") } : v),
    reviver: (k, v) => (v && v.type === "Buffer" && typeof v.data === "string" ? Buffer.from(v.data, "base64") : v),
  };
  const baileys = { BufferJSON, initAuthCreds: () => ({ registrationId: 7, noiseKey: { private: Buffer.from("n".repeat(32)) } }), proto: { Message: { AppStateSyncKeyData: { fromObject: (o) => ({ ...o, revived: true }) } } } };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ch-wa-"));
  fs.writeFileSync(path.join(dir, "creds.json"), JSON.stringify({ registrationId: 41, noiseKey: { private: Buffer.from("p".repeat(32)) } }, BufferJSON.replacer));
  fs.writeFileSync(path.join(dir, "pre-key-1.json"), JSON.stringify({ private: Buffer.from("k".repeat(32)) }, BufferJSON.replacer));
  const { state, saveCreds } = await useSealedAuthState(dir, baileys);
  assert.equal(state.creds.registrationId, 41, "an existing session carries on");
  for (const f of fs.readdirSync(dir)) assert.match(fs.readFileSync(path.join(dir, f), "utf8"), /^enc:v1:/, `${f} is sealed`);
  assert.ok(Buffer.from(state.creds.noiseKey.private).equals(Buffer.from("p".repeat(32))));
  assert.ok((await state.keys.get("pre-key", ["1"]))["1"].private.equals(Buffer.from("k".repeat(32))));
  await state.keys.set({ "app-state-sync-key": { A: { keyData: Buffer.from("s") } }, "pre-key": { 1: null } });
  assert.equal((await state.keys.get("app-state-sync-key", ["A"])).A.revived, true);
  assert.equal(fs.existsSync(path.join(dir, "pre-key-1.json")), false);
  await saveCreds();
  assert.doesNotMatch(fs.readFileSync(path.join(dir, "creds.json"), "utf8"), /registrationId/);
  assert.match(read("lib/platforms/whatsapp-linked.js"), /require\("\.\.\/sealed-auth-state"\)\.useSealedAuthState\(SESSION_DIR, baileys\)/);
  assert.doesNotMatch(read("lib/platforms/whatsapp-linked.js"), /useMultiFileAuthState\(/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a sign-in code sent by email is sealed until sent, then not kept", () => {
  const email = read("lib/assistant-email.js");
  assert.match(email, /const stored = sealed \? \{ \.\.\.mail, text: encryptString\(mail\.text\), sealed: true \} : mail;/);
  assert.equal((email.match(/call\(account, 'outbox', 'POST', openEnvelope\(message\.envelope\)\)/g) || []).length, 2, "opened only to hand to the relay");
  assert.match(email, /if \(message\.envelope\.sealed && \['sent', 'failed'\]\.includes\(status\.state\)\) update\.envelope = \{ \.\.\.message\.envelope, text: GONE, sealed: false \};/);
  assert.match(read("lib/sign-in-code.js"), /sendToOwner\(userId, "Your Closedhand sign-in code", text, \{ sealed: true \}\)/);
});

test("the Mac apps keep their secrets in the Keychain, not in files or preferences", () => {
  const sup = read("desktop/Sources/ClosedHand/Supervisor.swift");
  assert.match(sup, /static let secretKeys = \["POSTGRES_PASSWORD", "WS_AUTH_SECRET", "SANDBOX_TOKEN", "COOKIE_SECRET", "BRIDGE_TOKEN", "TOKEN_ENCRYPTION_KEY"\]/);
  assert.match(sup, /if let kept = Keychain\.get\(key\)/);
  assert.match(sup, /let kept = config\.keys\.filter \{ !Supervisor\.secretKeys\.contains\(\$0\) \|\| secretsOutsideKeychain\.contains\(\$0\) \}/, "config.env is written without them");
  assert.match(sup, /-c log_connections=on -c log_disconnections=on/);
  assert.match(sup, /application_name=closedhand-\\\(which\)/);
  assert.match(read("desktop/Sources/ClosedHand/Keychain.swift"), /kSecClassGenericPassword/);
  const bridge = read("bridge-app/Sources/BridgeManager.swift");
  assert.match(bridge, /bridgeToken = BridgeManager\.keychainToken\(\)/);
  assert.doesNotMatch(bridge, /defaults\.set\(bridgeToken, forKey: "bridgeToken"\)/);
});

test("the database names each service, and the sandbox agent answers nothing without its token", () => {
  assert.match(read("lib/db.js"), /applicationName: "closedhand-bot"/);
  assert.match(read("webapp/db.js"), /applicationName: "closedhand-webapp"/);
  assert.match(read("lib/db-driver-pg.js"), /application_name: applicationName/);
  assert.match(read("lib/db-driver-pg.js"), /pool\.on\("error", /, "a database restart no longer ends the process");
  const agent = read("sandbox-image/agent/server.js");
  assert.match(agent, /if \(!SANDBOX_TOKEN\) \{\n    if \(process\.env\.SANDBOX_DEV === "1"\) return next\(\);\n    return res\.status\(503\)/);
});

test("the bug report receipts are sealed", () => {
  const bugs = read("lib/bug-reports.js");
  assert.match(bugs, /receipt: entry\.receipt \? encryptString\(entry\.receipt\) : null/);
  assert.match(bugs, /const receipt = entry\.receipt \? decryptString\(entry\.receipt, "bug report receipt"\) : null;/);
});
