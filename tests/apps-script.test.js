// Tests apps-script/Code.gs (append-only storage) against fake Google services (see gas-harness.js).
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
const list = (g) => g.post({ action: "list", password: "titok" }).students;
const getOne = (g, key) => g.post({ action: "get", password: "titok", key }).student;

test("doGet health check", () => {
  const g = loadGas();
  assert.equal(g.get().ok, true);
});

test("first save creates the sheet with headers and one row; reports lock timings", () => {
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
  assert.equal(typeof r.t.wait, "number", "lock wait time reported");
  assert.equal(typeof r.t.hold, "number", "lock hold time reported");
});

test("append-only: every save adds a row; the teacher sees the newest version", () => {
  const g = loadGas();
  save(g, "Kiss Anna", "abcdef123456", 1);
  save(g, "Kiss Anna", "abcdef123456", 2, { submitted: true, submittedAt: new Date().toISOString(), ep1: { v: 4.2, d: 0.001, i: 0.5 }, ep2: { v: 9.9, d: 0.8, i: 2 } });
  const sh = g.sheets.Adatok;
  assert.equal(sh.getLastRow(), 3, "header + 2 save rows");
  assert.equal(sh.stats.appends, 2);
  const l = list(g);
  assert.equal(l.length, 1);
  assert.equal(l[0].submitted, true);
  assert.equal(l[0].ep1v, 4.2);
  assert.equal(l[0].ep2v, 9.9);
  assert.equal(l[0].rev, 2);
  assert.equal(l[0].saves, 2);
  assert.equal(getOne(g, "abcdef123456|Kiss Anna").state.ep2.v, 9.9);
});

test("same name on two devices → two separate students", () => {
  const g = loadGas();
  save(g, "Nagy Béla", "device000001", 1);
  save(g, "Nagy Béla", "device000002", 1);
  assert.equal(g.sheets.Adatok.getLastRow(), 3);
  assert.equal(list(g).length, 2);
});

test("an older revision arriving late never hides the newer one (read-time rule)", () => {
  const g = loadGas();
  save(g, "Kiss Anna", "abcdef123456", 5, { submitted: true });
  const r = save(g, "Kiss Anna", "abcdef123456", 3, { submitted: false }); // late, older
  assert.equal(r.ok, true);
  assert.equal(g.sheets.Adatok.getLastRow(), 3, "both rows are in the log");
  assert.equal(list(g)[0].submitted, true);
  assert.equal(list(g)[0].rev, 5);
  assert.equal(getOne(g, "abcdef123456|Kiss Anna").state.submitted, true);
  assert.equal(g.post({ action: "all", password: "titok" }).students[0].state.submitted, true);
});

test("equal revision twice (beacon + normal save): the later row wins", () => {
  const g = loadGas();
  save(g, "Kiss Anna", "abcdef123456", 4, { rows: [{ v: "0", i: "1" }] });
  save(g, "Kiss Anna", "abcdef123456", 4, { rows: [{ v: "0", i: "2" }] });
  assert.equal(getOne(g, "abcdef123456|Kiss Anna").state.rows[0].i, "2");
});

test("teacher deleting or sorting rows in the Sheet does not break reads or saves", () => {
  const g = loadGas();
  save(g, "A", "device00000a", 1);
  save(g, "B", "device00000b", 1);
  save(g, "C", "device00000c", 1);
  save(g, "C", "device00000c", 2, { submitted: true });
  g.sheets.Adatok.deleteRow(2); // teacher deletes A's row
  const sh = g.sheets.Adatok;
  sh.data = [sh.data[0]].concat(sh.data.slice(1).reverse()); // teacher sorts the tab
  const l = list(g);
  assert.deepEqual(l.map((s) => s.name).sort(), ["B", "C"]);
  assert.equal(l.find((s) => s.name === "C").submitted, true);
  save(g, "B", "device00000b", 2, { submitted: true });
  assert.equal(list(g).find((s) => s.name === "B").submitted, true);
});

test("teacher reads (list / get / all) never take the write lock", () => {
  const g = loadGas();
  save(g, "Kiss Anna", "abcdef123456", 1);
  const before = g.lockAcquisitions();
  list(g);
  getOne(g, "abcdef123456|Kiss Anna");
  g.post({ action: "all", password: "titok" });
  assert.equal(g.lockAcquisitions(), before);
});

test("an unreadable newest row falls back to the previous version", () => {
  const g = loadGas();
  save(g, "Kiss Anna", "abcdef123456", 1, { rows: [{ v: "0", i: "1" }] });
  save(g, "Kiss Anna", "abcdef123456", 2, { rows: [{ v: "0", i: "2" }] });
  g.sheets.Adatok.data[2][13] = "{broken";
  assert.equal(getOne(g, "abcdef123456|Kiss Anna").state.rows[0].i, "1");
});

test("names that look like formulas are stored as text", () => {
  const g = loadGas();
  save(g, "=HYPERLINK(1)", "abcdef123456", 1);
  assert.equal(typeof g.sheets.Adatok.data[1][1], "string");
  assert.equal(list(g)[0].name, "=HYPERLINK(1)");
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
  const one = getOne(g, "abcdef123456|Kiss Anna");
  assert.equal(one.state.rows.length, 3);
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
  assert.deepEqual(list(g), []);
});

test("70 students × 5 saves → 350 log rows, 70 students, every append under the lock", () => {
  const g = loadGas();
  for (let rev = 1; rev <= 5; rev++) {
    for (let s = 0; s < 70; s++) {
      const r = save(g, "Tanuló " + s, "dev" + String(s).padStart(6, "0"), rev);
      assert.equal(r.ok, true);
    }
  }
  assert.equal(g.sheets.Adatok.getLastRow(), 351);
  const l = g.post({ action: "list", password: "titok" });
  assert.equal(l.students.length, 70);
  assert.equal(l.rows, 350);
  assert.ok(l.students.every((s) => s.rev === 5 && s.saves === 5));
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

test("real dataset: server counts 43 points; a lower revision arriving later is ignored at read time", () => {
  const { loadTsv } = require("./fixtures/load-fixture.js");
  const g = loadGas();
  const rows = loadTsv("real-oxalic-acid.tsv").map((r, k) => ({ id: "r" + k, v: r.v, i: r.i }));
  const st = { name: "Valós Adat", deviceId: "realdata0001", rows, ep1: { v: 12, d: 0, i: 16.88 }, ep2: { v: 24, d: 0.12, i: 17.64 }, submitted: true };
  assert.equal(g.post({ action: "save", key: "realdata0001|Valós Adat", rev: 7, state: st }).ok, true);
  assert.equal(g.post({ action: "save", key: "realdata0001|Valós Adat", rev: 7, state: st }).ok, true);
  assert.equal(g.post({ action: "save", key: "realdata0001|Valós Adat", rev: 6, state: Object.assign({}, st, { submitted: false }) }).ok, true);
  const s = list(g)[0];
  assert.equal(s.points, 43);
  assert.equal(s.submitted, true);
  assert.equal(s.ep1v, 12);
  assert.equal(s.saves, 3);
});

test("Sheet menu: onOpen adds 'Oxálsav labor → Összesítő frissítése'", () => {
  const g = loadGas();
  g.sandbox.onOpen();
  assert.equal(g.sandbox.__menu.title, "Oxálsav labor");
  assert.deepEqual(g.sandbox.__menu.items, [["Összesítő frissítése", "refreshSummary"]]);
});

test("refreshSummary writes one row per student (newest version) with the number of saves", () => {
  const g = loadGas();
  save(g, "Nagy Béla", "device00000b", 1);
  save(g, "Kiss Anna", "device00000a", 1);
  save(g, "Kiss Anna", "device00000a", 3, { submitted: true, ep1: { v: 8.1, d: 0, i: 9 } });
  save(g, "Kiss Anna", "device00000a", 2); // late, older
  assert.equal(g.sandbox.refreshSummary(), 2);
  const sum = g.sheets["Összesítő"].data;
  assert.equal(sum[0][0], "Név");
  assert.equal(sum[0][11], "Mentések száma");
  assert.equal(sum[1][0], "Kiss Anna"); // sorted by name
  assert.equal(sum[1][3], "igen");
  assert.equal(sum[1][6], 8.1);
  assert.equal(sum[1][11], 3);
  assert.equal(sum[2][0], "Nagy Béla");
  assert.equal(g.sheets.Adatok.getLastRow(), 5, "Adatok untouched");
  save(g, "Tóth Dani", "device00000c", 1);
  assert.equal(g.sandbox.refreshSummary(), 3, "refresh rewrites the tab");
  assert.equal(g.sheets["Összesítő"].data.filter((r) => r[0]).length, 4);
});
