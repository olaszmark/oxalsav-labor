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

test("sheet headers: Vvalós / cm3 and Meredekség (no unit), same column layout as before", () => {
  const g = loadGas();
  save(g, "Kiss Anna", "abcdef123456", 1);
  const h = g.sheets.Adatok.data[0];
  assert.deepEqual(h.slice(7, 11), ["1. EP Vvalós / cm3", "1. EP Meredekség", "2. EP Vvalós / cm3", "2. EP Meredekség"]);
  assert.equal(h.length, 14);
  assert.equal(h[12], "Rev");
  assert.ok(!h.join("|").includes("dĨ") && !h.join("|").includes("V(NaOH)"));
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
  assert.deepEqual(sum[0], ["Név", "Eszköz", "Utolsó mentés", "Beküldve", "Beküldés ideje", "1. EP Vvalós / cm3", "1. EP Meredekség",
    "2. EP Vvalós / cm3", "2. EP Meredekség", "Relatív hiba (%)", "Mérési pontok", "Mentések száma"]);
  assert.equal(sum[1][0], "Kiss Anna"); // sorted by name
  assert.equal(sum[1][3], "igen");
  assert.equal(sum[1][5], 8.1);
  assert.equal(sum[1][9], "", "no true value yet → empty relative error");
  assert.equal(sum[1][11], 3);
  assert.equal(sum[2][0], "Nagy Béla");
  assert.equal(g.sheets.Adatok.getLastRow(), 5, "Adatok untouched");
  save(g, "Tóth Dani", "device00000c", 1);
  assert.equal(g.sandbox.refreshSummary(), 3, "refresh rewrites the tab");
  assert.equal(g.sheets["Összesítő"].data.filter((r) => r[0]).length, 4);
});

/* ------------------------------------------------------------ submitting is final */

const EP1 = { v: 12, d: 0, i: 16.9 };
const sub = (v2, extra = {}) => Object.assign({ submitted: true, submittedAt: new Date().toISOString(), ep1: EP1, ep2: { v: v2, d: 0.12, i: 17.6 } }, extra);

test("submit-once: the FIRST submitted version is final; later saves do not change what the teacher sees", () => {
  const g = loadGas();
  const key = "abcdef123456|Kiss Anna";
  save(g, "Kiss Anna", "abcdef123456", 1);
  save(g, "Kiss Anna", "abcdef123456", 2, { ep1: EP1 });
  save(g, "Kiss Anna", "abcdef123456", 3, sub(24.0));               // the submission
  save(g, "Kiss Anna", "abcdef123456", 3, sub(24.0));               // same revision again (beacon)
  save(g, "Kiss Anna", "abcdef123456", 4, sub(25.5));               // a later "resubmit" (e.g. an old cached app)
  save(g, "Kiss Anna", "abcdef123456", 5, { ep1: EP1, rows: [] });  // a later normal save
  assert.equal(g.sheets.Adatok.getLastRow(), 7, "every save is still logged");
  const l = list(g)[0];
  assert.equal(l.submitted, true);
  assert.equal(l.rev, 3);
  assert.equal(l.ep2v, 24.0);
  assert.equal(l.saves, 6);
  const one = getOne(g, key);
  assert.equal(one.state.ep2.v, 24.0);
  assert.equal(one.state.rows.length, 3, "rows of the submitted version");
  assert.equal(g.post({ action: "all", password: "titok" }).students[0].state.ep2.v, 24.0);
  g.sandbox.refreshSummary();
  assert.equal(g.sheets["Összesítő"].data[1][7], 24.0);
});

test("submit-once: a late-arriving older submitted revision is the first one (lowest Rev wins)", () => {
  const g = loadGas();
  save(g, "Kiss Anna", "abcdef123456", 9, sub(25.0));
  save(g, "Kiss Anna", "abcdef123456", 8, sub(24.0)); // arrives late but was submitted first
  assert.equal(list(g)[0].ep2v, 24.0);
  assert.equal(list(g)[0].rev, 8);
});

test("submit-once: the write path is unchanged – one append under the lock, no reads inside it", () => {
  const g = loadGas();
  save(g, "Kiss Anna", "abcdef123456", 1, sub(24.0));
  const sh = g.sheets.Adatok;
  const reads0 = sh.stats.reads, locks0 = g.lockAcquisitions(), appends0 = sh.stats.appends;
  const r = save(g, "Kiss Anna", "abcdef123456", 2, sub(26.0));
  assert.equal(r.ok, true);
  assert.equal(sh.stats.appends - appends0, 1);
  assert.equal(g.lockAcquisitions() - locks0, 1);
  assert.equal(sh.stats.reads - reads0, 0, "a save never reads the log");
});

/* ------------------------------------------------------------ true value + relative error */

const setTrue = (g, value, password = "titok") => g.post({ action: "setTrue", password, value });
const result = (g, key) => g.post({ action: "result", key });

test("setTrue: needs the password, accepts a decimal comma, stores it in the Script properties, can be changed", () => {
  const g = loadGas();
  assert.equal(setTrue(g, "24,15", "rossz").error, "auth");
  assert.equal(g.props.TRUE_VALUE_EP2, undefined);
  const r = setTrue(g, "24,15");
  assert.equal(r.ok, true);
  assert.equal(r.trueValue, 24.15);
  assert.equal(g.props.TRUE_VALUE_EP2, "24.15");
  assert.equal(g.post({ action: "list", password: "titok" }).trueValue, 24.15);
  assert.equal(setTrue(g, "23.9").trueValue, 23.9, "changing it");
  assert.equal(g.post({ action: "list", password: "titok" }).trueValue, 23.9);
  for (const bad of ["abc", "-3", "0", "1e9"]) assert.equal(setTrue(g, bad).error, "bad_value", bad);
  assert.equal(setTrue(g, "").trueValue, null, "empty clears it");
  assert.equal(g.post({ action: "list", password: "titok" }).trueValue, null);
});

test("relative error: |V2 − true| / true × 100, V2 as shown (2 decimals), 1 decimal, no sign", () => {
  const g = loadGas();
  save(g, "A", "device00000a", 1, sub(24.5));      // +2.083… % → 2.1
  save(g, "B", "device00000b", 1, sub(23.0));      // −4.166… % → 4.2 (no sign)
  save(g, "C", "device00000c", 1, sub(24.0137));   // shown 24.01 → 0.0 %
  save(g, "D", "device00000d", 1, { ep1: EP1 });   // no 2nd EP → null
  save(g, "E", "device00000e", 1, sub(24.006));    // shown 24.01 → 0.0 (not 0.025 → 0.0)
  assert.ok(list(g).every((s) => s.relErr === null), "no true value yet");
  setTrue(g, "24,00");
  const by = Object.fromEntries(list(g).map((s) => [s.name, s.relErr]));
  assert.deepEqual(by, { A: 2.1, B: 4.2, C: 0, D: null, E: 0 });
  setTrue(g, "20");
  assert.equal(list(g).find((s) => s.name === "A").relErr, 22.5, "changing the true value updates every student");
  assert.equal(getOne(g, "device00000a|A").relErr, 22.5);
  assert.equal(g.post({ action: "all", password: "titok" }).students.find((s) => s.name === "A").relErr, 22.5);
  g.sandbox.refreshSummary();
  const row = g.sheets["Összesítő"].data.find((r) => r[0] === "A");
  assert.equal(row[9], 22.5);
  const fmt = g.sheets["Összesítő"].formats.find((f) => f.col === 10);
  assert.ok(fmt && fmt.format === "0.0" && fmt.row === 2, "Relatív hiba column shown with 1 decimal: " + JSON.stringify(fmt));
});

test("result (student): only the percentage, never the true value; pending until the true value is entered", () => {
  const g = loadGas();
  const key = "abcdef123456|Kiss Anna";
  save(g, "Kiss Anna", "abcdef123456", 1, sub(24.5));
  const sh = g.sheets.Adatok;
  const reads0 = sh.stats.reads;
  assert.deepEqual(result(g, key), { ok: true, ready: false, reason: "pending" });
  assert.equal(sh.stats.reads, reads0, "pending answer does not read the Sheet");
  setTrue(g, "24,00");
  const r = result(g, key);
  assert.deepEqual(r, { ok: true, ready: true, relErr: 2.1 });
  assert.ok(!JSON.stringify(r).includes("24"), "the true value is not in the answer");
  assert.equal(r.trueValue, undefined);
  // later saves do not change the result
  save(g, "Kiss Anna", "abcdef123456", 2, sub(24.0));
  assert.equal(result(g, key).relErr, 2.1);
});

test("result (student): not submitted / unknown key / bad key / no lock", () => {
  const g = loadGas();
  setTrue(g, "24");
  save(g, "Nagy Béla", "device00000b", 1, { ep1: EP1, ep2: { v: 24, d: 0.1, i: 1 } });
  assert.equal(result(g, "device00000b|Nagy Béla").reason, "not_submitted");
  assert.equal(result(g, "nope|Nobody").reason, "not_submitted");
  assert.equal(result(g, "").error, "bad_request");
  const before = g.lockAcquisitions();
  result(g, "device00000b|Nagy Béla");
  assert.equal(g.lockAcquisitions(), before, "result takes no lock");
});
