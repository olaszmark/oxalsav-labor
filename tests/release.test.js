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

test("PRESET_VOLUMES: the 38 values of the lab (cm³), JavaScript numbers with dots", () => {
  const vm = require("node:vm");
  const box = { window: {} };
  vm.runInNewContext(read("js/config.js"), box);
  assert.deepEqual([...box.window.LAB_CONFIG.PRESET_VOLUMES], [0, 1, 2, 3, 4, 5, 6, 7, 8, 8.5, 9, 9.5, 10, 10.5, 11, 11.5, 12, 12.5, 13,
    13.5, 14, 15, 16, 17, 17.5, 18, 18.5, 19, 19.5, 20, 20.5, 21, 21.5, 22, 22.5, 23, 24, 25]);
  const C = require("../js/core.js");
  const rows = C.rowsFromPresets(box.window.LAB_CONFIG.PRESET_VOLUMES);
  assert.equal(rows.length, 38);
  assert.equal(rows[9].v, "8,5", "shown to students with a decimal comma");
});

test("no old volume / derivative labels left in what students and the teacher see", () => {
  for (const f of ["index.html", "teacher.html", "js/student.js", "js/teacher.js", "js/plot.js", "apps-script/Code.gs"]) {
    const src = read(f);
    for (const bad of ["V(NaOH)", "dĨ/dV", "mA/cm³", "erivált"]) assert.ok(!src.includes(bad), `${f} still contains "${bad}"`);
  }
  assert.match(read("index.html"), /V<sub>valós<\/sub> \/ cm³/);
  assert.match(read("index.html"), /Meredekség megjelenítése/);
});
