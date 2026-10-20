// Express answers a request with the first route registered for it, so a
// second route with the same method and path is never reached. One was
// added beside an older route of the same name and silently did nothing.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

for (const file of ["webapp/server.js", "closedhand-com/server.js", "sandbox-image/agent/server.js"]) {
  test(`every route in ${file} is registered once`, () => {
    const src = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    const seen = new Map();
    for (const [, method, route] of src.matchAll(/\bapp\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g)) {
      const key = `${method.toUpperCase()} ${route}`;
      seen.set(key, (seen.get(key) || 0) + 1);
    }
    assert.ok(seen.size > 0, "found its routes");
    assert.deepEqual([...seen].filter(([, n]) => n > 1).map(([key]) => key), []);
  });
}
