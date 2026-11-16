// Tests apps-script/Code.gs against fake Google services (see gas-harness.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadGas } = require("./gas-harness.js");

function state(name, dev, extra = {}) {
  return Object.assign({
    name, deviceId: dev, rows: [{ v: "0", i: "2,1" }, { v: "1", i: "1,6" }, { v: "2", i: "" }],
    ep1: null, ep2: null, submitted: false, submittedAt: null, changedAfterSubmit: false
  }, extra);
}
const save = (g, name, dev, rev, extra) => g.post({ action: "save", key: dev + "|" + name, rev, state: state(name, dev, extra) });

test("doGet health check", () => {
  const g = loadGas();
  assert.equal(g.get().ok, true);
});

test("first save creates the sheet with headers and one row", () => {
  const g = loadGas();
  const r = save(g, "Kiss Anna", "abcdef123456", 1);
  assert.equal(r.ok, true);
  const sh = g.sheets.Adatok;
  assert.equal(sh.getLastRow(), 2);
  assert.equal(sh.data[0][0], "Kulcs");
  assert.equal(sh.data[1][0], "abcdef123456|Kiss Anna");
  assert.equal(sh.data[1][1], "Kiss Anna");
  assert.equal(sh.data[1][4], "nem");
  assert.equal(sh.data[1][11], 2); // two valid points
  assert.equal(JSON.parse(sh.data[1][13]).name, "Kiss Anna");
  assert.equal(g.isLockHeld(), false, "lock released");
});

test("saving again replaces the same row (latest version only)", () => {
  const g = loadGas();
  save(g, "Kiss Anna", "abcdef123456", 1);
  save(g, "Kiss Anna", "abcdef123456", 2, { submitted: true, submittedAt: new Date().toISOString(), ep1: { v: 4.2, d: 0.001, i: 0.5 }, ep2: { v: 9.9, d: 0.8, i: 2 } });
  const sh = g.sheets.Adatok;
  assert.equal(sh.getLastRow(), 2);
  assert.equal(sh.data[1][4], "igen");
  assert.equal(sh.data[1][7], 4.2);
  assert.equal(sh.data[1][9], 9.9);
  assert.equal(sh.data[1][12], 2);
});

test("same name on two devices → two separate rows", () => {
  const g = loadGas();
  save(g, "Nagy Béla", "device000001", 1);
  save(g, "Nagy Béla", "device000002", 1);
  assert.equal(g.sheets.Adatok.getLastRow(), 3);
});

test("an older revision arriving late is ignored", () => {
  const g = loadGas();
  save(g, "Kiss Anna", "abcdef123456", 5, { submitted: true });
  const r = save(g, "Kiss Anna", "abcdef123456", 3, { submitted: false });
  assert.equal(r.stale, true);
  assert.equal(g.sheets.Adatok.data[1][4], "igen");
});

test("row lookup survives rows deleted by the teacher (stale cache)", () => {
  const g = loadGas();
  save(g, "A", "device00000a", 1);
  save(g, "B", "device00000b", 1);
  save(g, "C", "device00000c", 1);
  g.sheets.Adatok.deleteRow(2); // teacher deletes "A"
  save(g, "C", "device00000c", 2, { submitted: true });
  const keys = g.sheets.Adatok.data.slice(1).map((r) => r[0]);
  assert.deepEqual(keys, ["device00000b|B", "device00000c|C"]);
  assert.equal(g.sheets.Adatok.data[2][4], "igen");
  assert.equal(g.sheets.Adatok.data[1][4], "nem");
});

test("names that look like formulas are stored as text", () => {
  const g = loadGas();
  save(g, "=HYPERLINK(1)", "abcdef123456", 1);
  assert.equal(typeof g.sheets.Adatok.data[1][1], "string");
  const list = g.post({ action: "list", password: "titok" });
  assert.equal(list.students[0].name, "=HYPERLINK(1)");
});

test("bad requests are rejected", () => {
  const g = loadGas();
  assert.equal(g.post("not json").error, "bad_request");
  assert.equal(g.post({ action: "nope" }).error, "bad_action");
  assert.equal(g.post({ action: "save", state: { name: "x", deviceId: "BAD ID!", rows: [] } }).error, "bad_request");
  assert.equal(g.post({ action: "save", key: "other|Kiss", state: state("Kiss", "abcdef123456") }).error, "bad_key");
  const huge = state("Kiss", "abcdef123456");
  huge.note = "x".repeat(50000);
  assert.equal(g.post({ action: "save", state: huge }).error, "too_large");
});

test("teacher actions need the password", () => {
  const g = loadGas();
  save(g, "Kiss Anna", "abcdef123456", 1);
  assert.equal(g.post({ action: "list", password: "rossz" }).error, "auth");
  assert.equal(g.post({ action: "list" }).error, "auth");
  const l = g.post({ action: "list", password: "titok" });
  assert.equal(l.ok, true);
  assert.equal(l.students.length, 1);
  assert.equal(l.students[0].state, undefined, "list does not ship the JSON");
  assert.equal(l.students[0].points, 2);
  const one = g.post({ action: "get", password: "titok", key: "abcdef123456|Kiss Anna" });
  assert.equal(one.student.state.rows.length, 3);
  assert.equal(g.post({ action: "get", password: "titok", key: "nope" }).error, "not_found");
  const all = g.post({ action: "all", password: "titok" });
  assert.equal(all.students[0].state.name, "Kiss Anna");
});

test("missing TEACHER_PASSWORD property → not_configured", () => {
  const g = loadGas({ password: null });
  assert.equal(g.post({ action: "list", password: "" }).error, "not_configured");
});

test("list on an empty spreadsheet", () => {
  const g = loadGas();
  assert.deepEqual(g.post({ action: "list", password: "titok" }).students, []);
});

test("70 students × 5 saves → 70 rows, every write under the lock", () => {
  const g = loadGas();
  for (let rev = 1; rev <= 5; rev++) {
    for (let s = 0; s < 70; s++) {
      const r = save(g, "Tanuló " + s, "dev" + String(s).padStart(6, "0"), rev);
      assert.equal(r.ok, true);
    }
  }
  assert.equal(g.sheets.Adatok.getLastRow(), 71);
  assert.equal(g.post({ action: "list", password: "titok" }).students.length, 70);
});

test("selfTest() helper passes and cleans up", () => {
  const g = loadGas();
  const logs = [];
  g.sandbox.console.log = (m) => logs.push(m);
  g.sandbox.setup();
  g.sandbox.selfTest();
  assert.ok(logs.some((m) => m.includes("SELF TEST PASSED")), logs.join("\n"));
  assert.equal(g.sheets.Adatok.getLastRow(), 1);
});

test("sheet headers use the Ĩ symbol", () => {
  const g = loadGas();
  save(g, "Kiss Anna", "abcdef123456", 1);
  const h = g.sheets.Adatok.data[0];
  assert.ok(h.includes("1. EP dĨ/dV / (mA/cm³)") && h.includes("2. EP dĨ/dV / (mA/cm³)"), h.join(" | "));
});

test("real dataset: server counts 43 points; equal revision (resend) is accepted, lower is not", () => {
  const { loadTsv } = require("./fixtures/load-fixture.js");
  const g = loadGas();
  const rows = loadTsv("real-oxalic-acid.tsv").map((r, k) => ({ id: "r" + k, v: r.v, i: r.i }));
  const st = { name: "Valós Adat", deviceId: "realdata0001", rows, ep1: { v: 12, d: 0, i: 16.88 }, ep2: { v: 24, d: 0.12, i: 17.64 }, submitted: true };
  assert.equal(g.post({ action: "save", key: "realdata0001|Valós Adat", rev: 7, state: st }).ok, true);
  assert.equal(g.post({ action: "save", key: "realdata0001|Valós Adat", rev: 7, state: st }).stale, undefined);
  assert.equal(g.post({ action: "save", key: "realdata0001|Valós Adat", rev: 6, state: Object.assign({}, st, { submitted: false }) }).stale, true);
  const s = g.post({ action: "list", password: "titok" }).students[0];
  assert.equal(s.points, 43);
  assert.equal(s.submitted, true);
  assert.equal(s.ep1v, 12);
});
