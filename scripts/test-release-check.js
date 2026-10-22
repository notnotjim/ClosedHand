// When a newer Closedhand is out, Settings and a "Fixed" notice say the one
// step that updates it where it runs (lib/release-check.js), instead of a bare
// "update Closedhand" with no way to do it. GitHub is asked once a day.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const releases = require("../lib/release-check");

function github(answers, calls = []) {
  return async (url) => {
    calls.push(url);
    for (const [part, body, status = 200] of answers) {
      if (url.includes(part)) return { ok: status < 400, status, json: async () => body };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

test("Docker compares its commit with the newest image build, the Mac app with the newest release", async () => {
  releases._reset();
  const calls = [];
  const docker = await releases.status({
    env: { CLOSEDHAND_SHA: "aaa1111" }, now: 1000,
    fetchImpl: github([["/actions/workflows/build-selfhost-images.yml/runs", { workflow_runs: [{ head_sha: "bbb2222" }] }], ["/compare/aaa1111...bbb2222", { status: "ahead" }]], calls),
  });
  assert.deepEqual(docker, { newer: true, kind: "docker" });
  assert.equal(calls.length, 2);
  const again = await releases.status({ env: { CLOSEDHAND_SHA: "aaa1111" }, now: 2000, fetchImpl: github([], calls) });
  assert.deepEqual(again, docker, "asked once a day");
  assert.equal(calls.length, 2);

  releases._reset();
  const mac = await releases.status({
    env: { CLOSEDHAND_SHA: "ccc3333", CLOSEDHAND_DESKTOP: "1" }, now: 1000,
    fetchImpl: github([["/releases/latest", { tag_name: "v2.0.40" }], ["/compare/ccc3333...v2.0.40", { status: "identical" }]]),
  });
  assert.deepEqual(mac, { newer: false, kind: "mac" }, "already the newest");
});

test("nothing is asked on a host that updates itself, or a build from source", async () => {
  releases._reset();
  const calls = [];
  assert.deepEqual(await releases.status({ env: { CLOSEDHAND_SHA: "aaa", SETUP_CODE: "x" }, fetchImpl: github([], calls) }), { newer: false, kind: null });
  assert.deepEqual(await releases.status({ env: {}, fetchImpl: github([], calls) }), { newer: false, kind: null });
  assert.equal(calls.length, 0);
});

test("a failed check says nothing new and asks again in an hour", async () => {
  releases._reset();
  const calls = [];
  const env = { CLOSEDHAND_SHA: "aaa1111" };
  assert.deepEqual(await releases.status({ env, now: 0, fetchImpl: github([["/runs", {}, 403]], calls) }), { newer: false, kind: "docker" });
  await releases.status({ env, now: 30 * 60 * 1000, fetchImpl: github([], calls) });
  assert.equal(calls.length, 1, "not again within the hour");
  await releases.status({ env, now: 61 * 60 * 1000, fetchImpl: github([], calls) });
  assert.equal(calls.length, 2);
});

test("the step is the installer line for Docker and a download for the Mac app", () => {
  assert.equal(releases.howToUpdate("docker"), "To update, open Terminal on the computer running Closedhand and run: curl -fsSL https://closedhand.com/install | sh");
  assert.match(releases.howToUpdate("mac"), /download the new Closedhand from closedhand\.com and drag it into Applications/);
  assert.equal(releases.howToUpdate(null), "");
  assert.match(read("install.sh"), /a plain re-run already upgrades and keeps your data/, "running the line again is an update");
  assert.match(read("install.sh"), /else say "Opening Closedhand in your browser: \$DASH_URL"; fi/, "an update opens Closedhand, not the setup page");
});

test("both privacy pages say what the daily check sends", () => {
  for (const page of ["webapp/views/privacy.html", "closedhand-com/views/privacy.html"]) {
    assert.match(read(page), /Once a day Closedhand asks GitHub whether a newer version is out\. GitHub sees the version it runs and the internet address of the computer running it\./, page);
  }
});

test("a Fixed notice carries the step, and Settings shows it", () => {
  const bug = read("lib/bug-reports.js");
  const fixedText = new Function(bug.slice(bug.indexOf("function fixedText("), bug.indexOf("// Each sent report not yet told about")) + "; return fixedText;")();
  const note = "Fixed in the next update. Update Closedhand to get it.";
  assert.equal(fixedText({ at: "2026-10-21T12:00:00Z", comment: "plans missed" }, note, releases.howToUpdate("docker")),
    'Fixed: the problem you reported on 21 Oct ("plans missed"). Fixed in the next update. Update Closedhand to get it. To update, open Terminal on the computer running Closedhand and run: curl -fsSL https://closedhand.com/install | sh');
  assert.equal(fixedText({ at: "2026-10-21T12:00:00Z", comment: null }, note), "Fixed: the problem you reported on 21 Oct. " + note, "already the newest: nothing added");
  assert.match(bug, /howTo = update\.newer \? require\("\.\/release-check"\)\.howToUpdate\(update\.kind\) : "";/);
  assert.match(read("webapp/server.js"), /app\.get\("\/api\/update", async \(req, res\) => \{/);
  const dash = read("webapp/views/dashboard.html");
  assert.match(dash, /<div class="update-note" id="update-note" hidden>/);
  assert.match(dash, /'A new version of Closedhand is out\. To update, open Terminal on the computer running Closedhand and run:'/);
});
