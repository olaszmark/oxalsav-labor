// Release checks: things that must hold for every version pushed to GitHub Pages.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

test("every local CSS/JS reference carries the same ?v= cache-busting version", () => {
  const versions = new Set();
  for (const f of ["index.html", "teacher.html"]) {
    const refs = [...read(f).matchAll(/(?:href|src)="((?:css|js)\/[^"]+)"/g)].map((m) => m[1]);
    assert.ok(refs.length >= 5, f);
    for (const r of refs) {
      const m = r.match(/\.(?:css|js)\?v=([\w.-]+)$/);
      assert.ok(m, `${f}: ${r} has no ?v=`);
      versions.add(m[1]);
    }
  }
  assert.equal(versions.size, 1, "one version everywhere: " + [...versions].join(", "));
});

test("both pages ask search engines not to index them", () => {
  for (const f of ["index.html", "teacher.html"]) {
    assert.match(read(f), /<meta name="robots" content="noindex[^"]*">/, f);
  }
});

test("Code.gs is limited to its own spreadsheet (@OnlyCurrentDoc)", () => {
  assert.match(read("apps-script/Code.gs"), /^\/\*\* @OnlyCurrentDoc \*\//);
});

test("no teacher password value is stored in the frontend", () => {
  const cfg = read("js/config.js");
  assert.doesNotMatch(cfg, /PASSWORD/i);
  // the only password string in the frontend is the public mock-mode one
  const api = read("js/api.js");
  assert.match(api, /MOCK_PASSWORD = "tanar"/);
  assert.match(api, /MOCK = params\.get\("mock"\) === "1" \|\| !CFG\.API_URL/, "mock password only works in mock mode");
});
