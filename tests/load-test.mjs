// Load test for the deployed Apps Script web app. Run it against a TEST deployment
// (it writes rows named "TERHELÉSTESZT 01" … into the "Adatok" tab).
//
//   node tests/load-test.mjs "<…/exec URL>" [--mode realistic|bench|stress] [options]
//
// Modes
//   realistic (default) 70 students start over 2 min, type ~8 min with the app's real save rules
//                       (10 s debounce, ≥ 60 s between autosaves, autosave ≤ 60 s after the first
//                       unsaved change, one request at a time, retries),
//                       immediate saves for EP Mentés/Törlés and page hides (beacons), then ALL press
//                       Beküldés within 60 s and confirm it in the dialog (some press "Mégse" first).
//                       Submitting is final: the app stops saving, shows the results screen and asks for
//                       the result every 30 s. When half of the class has submitted, the simulated teacher
//                       enters the true value (restored to the old value at the end). Some students send a
//                       stray save after submitting (like an old cached app) – the server must ignore it.
//                       The teacher polls the list every 30 s and opens a detail view now and then.
//                       Ends with a "nothing lost / submitted version is final" check and a PASS/FAIL table.
//   bench               quick check (~1 min): 20 students × 3 saves, reports the server's lock hold time.
//   stress              the old test: 70 students × 3 saves with 3–10 s pauses, all at once.
//
// Options: --students N  --minutes M (typing time)  --ramp S (start spread)  --burst S (Beküldés window)
//          --saves N (bench/stress)  --no-teacher  --allow-local (http://127.0.0.1 test server)
// Teacher password (realistic mode, for the teacher poller and the final check): asked with a hidden
// prompt, or taken from the environment variable LOADTEST_PASSWORD. It is never printed.

const args = process.argv.slice(2);
const url = args.find((a) => /^https?:\/\//.test(a));
const opt = (name, def) => { const i = args.indexOf("--" + name); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : def; };
const flag = (name) => args.includes("--" + name);
const MODE = opt("mode", "realistic");
const allowLocal = flag("allow-local");
if (!url || !(/^https:\/\/script\.google\.com\//.test(url) || (allowLocal && /^http:\/\/127\.0\.0\.1:\d+\//.test(url)))) {
  console.error('Usage: node tests/load-test.mjs "https://script.google.com/macros/s/…/exec" [--mode realistic|bench|stress] [--students N] [--minutes M]');
  process.exit(1);
}

/* ----------------------------------------------------------------- helpers */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const pct = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const fmt = (ms) => (ms === null || ms === undefined ? "–" : ms >= 10000 ? (ms / 1000).toFixed(1) + " s" : Math.round(ms) + " ms");
const stats = (arr) => `median ${fmt(pct(arr, 0.5))}, p95 ${fmt(pct(arr, 0.95))}, max ${fmt(arr.length ? Math.max(...arr) : null)} (n=${arr.length})`;
const runId = Date.now().toString(36).slice(-6);
let T0 = Date.now(); // reset after the password prompt (realistic mode)
const now = () => Date.now() - T0;

async function post(payload, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t = Date.now();
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(payload), redirect: "follow", signal: ctrl.signal });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { return { ok: false, error: res.ok ? "bad_response" : "http_" + res.status, ms: Date.now() - t }; }
    return Object.assign({ ms: Date.now() - t }, json, json.ok ? {} : { error: json.error || "unknown" });
  } catch (e) {
    return { ok: false, error: e.name === "AbortError" ? "timeout" : "network", ms: Date.now() - t };
  } finally { clearTimeout(timer); }
}

async function askHidden(question) {
  if (process.env.LOADTEST_PASSWORD) return process.env.LOADTEST_PASSWORD;
  if (!process.stdin.isTTY) { console.error("No terminal for the password prompt – set LOADTEST_PASSWORD."); process.exit(1); }
  process.stdout.write(question);
  return new Promise((resolve) => {
    let pw = "";
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding("utf8");
    const onData = (ch) => {
      if (ch === "\r" || ch === "\n") { process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off("data", onData); process.stdout.write("\n"); resolve(pw); }
      else if (ch === "\u0003") process.exit(130);
      else if (ch === "\u007f" || ch === "\b") pw = pw.slice(0, -1);
      else pw += ch;
    };
    process.stdin.on("data", onData);
  });
}

const holds = [], waits = [], busyWaits = [];
function noteTiming(r) {
  if (r && r.t) { if (typeof r.t.hold === "number") holds.push(r.t.hold); if (typeof r.t.wait === "number") (r.ok ? waits : busyWaits).push(r.t.wait); }
}

function studentState(k, deviceId, name, rows, extra = {}) {
  return Object.assign({ version: 1, name, deviceId, key: deviceId + "|" + name, rows, ep1: null, ep2: null,
    submitted: false, submittedAt: null, changedAfterSubmit: false, submitConfirmed: false, result: null }, extra);
}
const nameOf = (k) => "TERHELÉSTESZT " + String(k + 1).padStart(2, "0");
const devOf = (k) => "lt" + runId + String(k).padStart(4, "0");

/* ================================================================== bench */
async function bench() {
  const N = Number(opt("students", 20)), SAVES = Number(opt("saves", 3));
  console.log(`Benchmark: ${N} students × ${SAVES} saves (start within 5 s, 1–3 s pauses) → ${url}`);
  const lat = [], errors = {};
  let ok = 0;
  const tStart = Date.now();
  await Promise.all(Array.from({ length: N }, async (_, k) => {
    await sleep(rand(0, 5000));
    const rows = Array.from({ length: 21 }, (_, v) => ({ id: "r" + v, v: String(v), i: "" }));
    for (let s = 1; s <= SAVES; s++) {
      rows[s].i = (17 + Math.random()).toFixed(2).replace(".", ",");
      const r = await post({ action: "save", key: devOf(k) + "|" + nameOf(k), rev: s, state: studentState(k, devOf(k), nameOf(k), rows) });
      lat.push(r.ms); noteTiming(r);
      if (r.ok) ok++; else errors[r.error] = (errors[r.error] || 0) + 1;
      await sleep(rand(1000, 3000));
    }
  }));
  const dur = (Date.now() - tStart) / 1000;
  console.log(`\nDone in ${dur.toFixed(0)} s. OK: ${ok}/${N * SAVES}. Errors: ${Object.keys(errors).length ? JSON.stringify(errors) : "none"}`);
  console.log(`Lock HOLD per save (server):   ${stats(holds)}`);
  console.log(`Lock WAIT (successful saves):  ${stats(waits)}`);
  console.log(`Request latency (client):      ${stats(lat)}`);
  const med = pct(holds, 0.5);
  if (med) console.log(`→ Estimated capacity ≈ ${(1000 / med).toFixed(1)} saves/s (1 / median hold). Target ≥ 2,5 saves/s → median hold ≤ 400 ms.`);
  console.log('Delete the "TERHELÉSTESZT" rows afterwards (or delete the whole "Adatok" tab).');
  process.exit(Object.keys(errors).length ? 1 : 0);
}

/* ================================================================== stress (old test) */
async function stress() {
  const N = Number(opt("students", 70)), SAVES = Number(opt("saves", 3));
  console.log(`Stress test: ${N} students × ${SAVES} saves → ${url}`);
  const lat = [], errors = {};
  let ok = 0;
  const t = Date.now();
  await Promise.all(Array.from({ length: N }, async (_, k) => {
    await sleep(Math.random() * 3000);
    for (let s = 1; s <= SAVES; s++) {
      const rows = Array.from({ length: 21 }, (_, v) => ({ id: "r" + v, v: String(v), i: (20 + Math.sin(v + k + s) * 5).toFixed(1).replace(".", ",") }));
      const r = await post({ action: "save", key: devOf(k) + "|" + nameOf(k), rev: s, state: studentState(k, devOf(k), nameOf(k), rows, { submitted: s === SAVES }) });
      lat.push(r.ms); noteTiming(r);
      if (r.ok) ok++; else errors[r.error] = (errors[r.error] || 0) + 1;
      await sleep(3000 + Math.random() * 7000);
    }
  }));
  console.log(`Done in ${((Date.now() - t) / 1000).toFixed(0)} s. OK: ${ok}/${N * SAVES}`);
  console.log(`Latency ms – median ${pct(lat, 0.5)}, 90% ${pct(lat, 0.9)}, max ${Math.max(...lat)}`);
  console.log(`Lock hold: ${stats(holds)}`);
  console.log("Errors:", Object.keys(errors).length ? errors : "none");
  console.log('Now delete the "TERHELÉSTESZT" rows (or the whole "Adatok" tab – it is re-created automatically).');
  process.exit(Object.keys(errors).length ? 1 : 0);
}

/* ================================================================== realistic */
const DEBOUNCE = 10000, MIN_INTERVAL = 60000, MAX_WAIT = 60000; // = js/config.js
const RESULT_POLL = 30000;                                         // = js/student.js
const TRUE_VALUE = 24.15;                                          // the simulated teacher enters this
const relErrOf = (v2, tv) => Math.round(Math.abs(Number(v2.toFixed(2)) - tv) / tv * 1000 + 1e-9) / 10; // = Code.gs
const BUSY = /^(busy|timeout|http_429|http_503)$/;

class SimStudent {
  constructor(k, R) {
    this.k = k; this.R = R; this.name = nameOf(k); this.dev = devOf(k); this.key = this.dev + "|" + this.name;
    this.rows = Array.from({ length: 43 }, (_, v) => ({ id: "r" + v, v: (v * 0.7).toFixed(2).replace(".", ","), i: "" }));
    this.extra = { ep1: null, ep2: null, submitted: false, submittedAt: null, changedAfterSubmit: false };
    this.rev = 0; this.seq = 0; this.savedSeq = 0; this.inFlight = false; this.lastSentAt = -1e9; this.failures = 0;
    this.timer = null; this.urgent = false; this.editTime = {}; this.urgentPending = []; this.lastConfirmed = null;
    this.status = "idle"; this.chainStart = null; this.unsavedSince = null; this.changedInFlight = null; this.hibaSince = null; this.maxHiba = 0; this.sawHiba = false; this.filled = 0; this.hidden = false;
    this.stopped = false; this.submittedJson = null; this.confirmedAt = null; this.result = null; this.resultAt = null; this.cancelledOnce = false;
  }
  state() { return studentState(this.k, this.dev, this.name, this.rows, this.extra); }
  change() {
    this.seq++; this.editTime[this.seq] = now();
    if (this.unsavedSince === null) this.unsavedSince = now();
    if (this.inFlight && this.changedInFlight === null) this.changedInFlight = now();
  }
  autoWait() { // same rule as Saver._autoWait in js/api.js
    let at = now() + DEBOUNCE + rand(0, 1000);
    if (this.unsavedSince !== null) at = Math.min(at, this.unsavedSince + MAX_WAIT);
    return Math.max(at, this.lastSentAt + MIN_INTERVAL) - now();
  }
  edit() {
    if (this.hidden || this.extra.submitted) return; // after Beküldés the table is locked
    const r = this.rows[this.filled % this.rows.length];
    r.i = (16.8 + Math.random() * 1.2).toFixed(2).replace(".", ",");
    this.filled++;
    this.change();
    this.markDirty();
  }
  markDirty() {
    if (this.failures > 0) return;
    this.setStatus("pending");
    this.schedule(this.autoWait());
  }
  saveNow(kind, mutate) {
    if (this.stopped || (this.extra.submitted && kind !== "submit")) return;
    if (mutate) mutate();
    this.change();
    this.urgentPending.push({ seq: this.seq, t: now(), kind });
    this.urgent = true; this.failures = 0;
    this.setStatus("pending");
    this.schedule(0);
  }
  schedule(ms) { clearTimeout(this.timer); this.timer = setTimeout(() => this.run(), Math.max(0, ms)); }
  setStatus(s) {
    const t = now();
    if (s === "error" && this.hibaSince === null) { this.hibaSince = t; this.sawHiba = true; }
    if (s !== "error" && this.hibaSince !== null) { this.maxHiba = Math.max(this.maxHiba, t - this.hibaSince); this.hibaSince = null; }
    this.status = s;
  }
  async run() {
    if (this.stopped || this.inFlight || this.seq === this.savedSeq) return;
    const seqAtSend = this.seq, rev = ++this.rev, st = this.state();
    this.urgent = false; this.inFlight = true; this.lastSentAt = now(); this.changedInFlight = null;
    const R = this.R, tSend = now();
    if (this.chainStart === null) this.chainStart = tSend; // first attempt of this save (retries keep it)
    R.attempts++;
    const r = await post({ action: "save", key: this.key, rev, state: st });
    noteTiming(r);
    R.saveLog.push({ t: tSend, ms: r.ms, ok: r.ok, hold: r.t && r.t.hold });
    this.inFlight = false;
    if (r.ok) {
      this.failures = 0;
      R.serverDelay.push(now() - this.chainStart); this.chainStart = null;
      // time until "Mentve" for the oldest unsaved change covered by this save
      const firstUnsaved = this.savedSeq + 1;
      if (this.editTime[firstUnsaved] !== undefined) R.toMentve.push(now() - this.editTime[firstUnsaved]);
      this.savedSeq = seqAtSend;
      this.lastConfirmed = { rev, json: JSON.stringify(st) };
      if (st.submitted) { // the server confirmed the submission: final → results screen, no more saves
        this.stopped = true; this.submittedJson = JSON.stringify(st); this.confirmedAt = now();
        R.confirmed++;
        this.pollResult();
      }
      this.urgentPending = this.urgentPending.filter((u) => {
        if (u.seq > seqAtSend) return true;
        (R.urgentLat[u.kind] = R.urgentLat[u.kind] || []).push(now() - u.t);
        if (u.kind === "submit") R.submitConfirmedAt = Math.max(R.submitConfirmedAt, now());
        return false;
      });
      if (this.seq !== this.savedSeq) {
        this.unsavedSince = this.changedInFlight !== null ? this.changedInFlight : now();
        this.setStatus("pending"); this.schedule(this.urgent ? 0 : this.autoWait());
      } else { this.unsavedSince = null; this.setStatus("saved"); }
    } else {
      this.failures++; R.failedAttempts++; R.errors[r.error] = (R.errors[r.error] || 0) + 1;
      const delay = Math.min(60000, 5000 * Math.pow(2, this.failures - 1)) * (0.75 + Math.random() * 0.5);
      this.setStatus(BUSY.test(r.error) && this.failures <= 2 ? "pending" : "error");
      this.schedule(delay);
    }
  }
  beacon() { // page hidden: unload-safe request, delivery not confirmed
    if (this.stopped || this.seq === this.savedSeq) return;
    const st = this.state(), rev = ++this.rev;
    this.R.beacons++;
    post({ action: "save", key: this.key, rev, state: st }).then((r) => { noteTiming(r); if (!r.ok) this.R.beaconErrors++; });
  }
  resume() { this.hidden = false; if (!this.stopped && this.seq !== this.savedSeq && !this.inFlight) this.schedule(this.failures > 0 ? 1000 : DEBOUNCE); }
  /** results screen: ask for the result now and every 30 s until the true value has been entered */
  async pollResult() {
    const R = this.R;
    while (!R.stopPolling) {
      const r = await post({ action: "result", key: this.key }, 60000);
      R.resultReq.push({ ms: r.ms, ok: r.ok, ready: !!(r.ok && r.ready), afterTrue: R.trueSetAt !== null });
      if (!r.ok) R.resultErrors++;
      if (r.ok && ("trueValue" in r || JSON.stringify(r).includes(String(TRUE_VALUE)))) R.leaks++;
      if (r.ok && r.ready) { this.result = r.relErr; this.resultAt = now(); return; }
      await sleep(RESULT_POLL);
    }
  }
  /** an old cached app (or a stray beacon) sends one more save after the submission */
  async straySave() {
    const st = JSON.parse(this.submittedJson);
    st.rows[0].i = "99,99"; st.ep2 = { v: 30, d: 0.5, i: 18 }; st.changedAfterSubmit = true;
    const r = await post({ action: "save", key: this.key, rev: ++this.rev, state: st });
    noteTiming(r);
    this.R.stray.push(r.ok);
  }
}

async function realistic() {
  const N = Number(opt("students", 70)), MIN = Number(opt("minutes", 8)), RAMP = Number(opt("ramp", 120)), BURST = Number(opt("burst", 60));
  const teacher = !flag("no-teacher");
  const password = await askHidden("Test deployment teacher password (input hidden): ");
  const chk = await post({ action: "list", password });
  if (!chk.ok) { console.error("Teacher password check failed: " + chk.error); process.exit(1); }
  const probe = await post({ action: "result", key: "probe|probe" });
  if (!probe.ok) { console.error(`The deployment does not know the "result" action (${probe.error}) – publish the new Code.gs to it first.`); process.exit(1); }
  const prevTrue = typeof chk.trueValue === "number" ? chk.trueValue : null; // restored at the end
  if (prevTrue !== null) { const c = await post({ action: "setTrue", password, value: "" }); if (!c.ok) { console.error("Could not clear the true value: " + c.error); process.exit(1); } }
  T0 = Date.now(); // the simulated lab starts now, not when the script was started

  const R = { serverDelay: [], attempts: 0, failedAttempts: 0, errors: {}, toMentve: [], urgentLat: {}, saveLog: [], beacons: 0, beaconErrors: 0, submitConfirmedAt: 0, teacher: [], teacherErrors: 0,
    confirmed: 0, resultReq: [], resultErrors: 0, leaks: 0, stray: [], trueSetAt: null, stopPolling: false, cancels: 0 };
  const burstStart = (RAMP + MIN * 60) * 1000;
  const endBy = burstStart + BURST * 1000 + 300000;
  console.log(`Realistic test (run ${runId}): ${N} students, start over ${RAMP} s, typing ~${MIN} min, all press Beküldés within ${BURST} s at ~${Math.round(burstStart / 60000)} min; teacher poller: ${teacher ? "on" : "off"}`);
  console.log(`Expected duration ≈ ${Math.ceil(endBy / 60000 - 3)}–${Math.ceil(endBy / 60000)} min. Rows are named "${nameOf(0)}" …`);

  const students = Array.from({ length: N }, (_, k) => new SimStudent(k, R));
  const timers = [];
  const at = (ms, fn) => timers.push(setTimeout(fn, Math.max(0, ms - now())));
  let lastPress = 0;
  for (const s of students) {
    const start = rand(0, RAMP * 1000), typeEnd = start + MIN * 60000 * rand(0.75, 1.0);
    at(start, () => s.saveNow("register"));
    for (let t = start + rand(4000, 20000); t < typeEnd; t += rand(4000, 20000)) at(t, () => s.edit());
    const epBase = start + (typeEnd - start) * 0.6;
    at(rand(epBase, typeEnd), () => s.saveNow("ep", () => { s.extra.ep1 = { v: 12, d: 0, i: 16.88 }; }));
    at(rand(epBase, typeEnd), () => s.saveNow("ep", () => { s.extra.ep2 = { v: 24, d: 0.12, i: 17.64 }; }));
    if (Math.random() < 0.3) { // EP deleted and selected again
      const t = rand(epBase, typeEnd);
      at(t, () => s.saveNow("ep", () => { s.extra.ep2 = null; }));
      at(t + rand(5000, 20000), () => s.saveNow("ep", () => { s.extra.ep2 = { v: 23.9, d: 0.11, i: 17.62 }; }));
    }
    if (Math.random() < 0.3) { // page hidden (app switch / lock) for 10–40 s
      const t = rand(start + 30000, typeEnd);
      at(t, () => { s.hidden = true; s.beacon(); });
      at(t + rand(10000, 40000), () => s.resume());
    }
    // Beküldés → confirmation dialog: most confirm after 1,5–5 s, every 5th presses "Mégse" first and confirms 10–30 s later
    const press = burstStart + rand(0, BURST * 1000);
    const cancelFirst = Math.random() < 0.2;
    const confirmAt = press + (cancelFirst ? rand(10000, 30000) : rand(1500, 5000));
    if (cancelFirst) R.cancels++;
    lastPress = Math.max(lastPress, confirmAt);
    at(confirmAt, () => s.saveNow("submit", () => { s.extra.submitted = true; s.extra.submittedAt = new Date().toISOString(); s.extra.changedAfterSubmit = false; }));
  }
  const strayStudents = students.filter(() => Math.random() < 0.15);

  // simulated teacher: list every 30 s, a detail view every ~2 min
  let polls = 0, teacherStop = false;
  const teacherLoop = (async () => {
    if (!teacher) return;
    while (!teacherStop) {
      const t = now();
      const r = await post({ action: "list", password }, 60000);
      R.teacher.push({ t, ms: r.ms, kind: "list", rows: r.rows, n: r.students ? r.students.length : null, ok: r.ok });
      if (!r.ok) R.teacherErrors++;
      if (++polls % 4 === 0 && r.ok && r.students && r.students.length) {
        const st = r.students[Math.floor(Math.random() * r.students.length)];
        const t2 = now();
        const g = await post({ action: "get", password, key: st.key }, 60000);
        R.teacher.push({ t: t2, ms: g.ms, kind: "get", ok: g.ok });
        if (!g.ok) R.teacherErrors++;
      }
      await sleep(Math.max(0, 30000 - (now() - t)));
    }
  })();

  // progress + wait until everyone is saved and has a result (or the time limit)
  let lastLog = 0;
  const strayDone = new Set();
  while (now() < endBy) {
    await sleep(1000);
    // the teacher enters the true value when half of the class has submitted
    if (R.trueSetAt === null && R.confirmed >= N / 2) {
      const r = await post({ action: "setTrue", password, value: String(TRUE_VALUE).replace(".", ",") });
      R.trueSetAt = now();
      console.log(`  ${(now() / 60000).toFixed(1)} min: ${R.confirmed}/${N} submitted → teacher enters the true value (${r.ok ? "ok" : r.error})`);
    }
    for (const s of strayStudents) {
      if (s.confirmedAt !== null && !strayDone.has(s) && now() > s.confirmedAt + 5000 + (s.k % 25) * 1000) { strayDone.add(s); s.straySave(); }
    }
    const pressedAll = now() > lastPress + 1000;
    const clean = students.every((s) => !s.inFlight && s.seq === s.savedSeq);
    const results = students.every((s) => s.result !== null);
    if (now() - lastLog > 60000) {
      lastLog = now();
      const err = students.filter((s) => s.status === "error").length;
      console.log(`  ${(now() / 60000).toFixed(1)} min: saves ${R.attempts - R.failedAttempts}/${R.attempts} ok, showing Hiba now: ${err}, unsaved: ${students.filter((s) => s.seq !== s.savedSeq).length}`);
    }
    if (pressedAll && clean && results && strayDone.size === strayStudents.length) break;
  }
  R.stopPolling = true;
  await sleep(2000); // let the stray saves finish
  timers.forEach(clearTimeout);
  students.forEach((s) => { clearTimeout(s.timer); s.setStatus(s.status === "error" ? "error_end" : s.status); });
  teacherStop = true;
  await teacherLoop;

  // final check: what the teacher sees == what each student last saved; time the CSV-all read
  const tAll = Date.now();
  const all = await post({ action: "all", password }, 120000);
  const allMs = Date.now() - tAll;
  const tList = Date.now();
  const lst = await post({ action: "list", password }, 60000);
  const listMs = Date.now() - tList;
  const server = {};
  (all.students || []).forEach((s) => { server[s.key] = s; });
  // restore the true value the test deployment had before
  const restore = await post({ action: "setTrue", password, value: prevTrue === null ? "" : String(prevTrue) });
  let lost = 0, unsaved = 0, notSubmitted = 0, strayWon = 0, noResult = 0, wrongResult = 0;
  const resultWait = [];
  for (const s of students) {
    if (s.seq !== s.savedSeq) unsaved++;
    const sv = server[s.key];
    // submitted: the teacher must see exactly the submitted version (later stray saves ignored)
    const expected = s.submittedJson || (s.lastConfirmed && s.lastConfirmed.json);
    if (!sv || !expected || JSON.stringify(sv.state) !== expected) { lost++; if (strayStudents.includes(s)) strayWon++; }
    if (!sv || !sv.submitted) notSubmitted++;
    if (s.result === null) noResult++;
    else {
      const exp = relErrOf(JSON.parse(s.submittedJson).ep2.v, TRUE_VALUE);
      if (s.result !== exp) wrongResult++;
      resultWait.push(s.resultAt - Math.max(R.trueSetAt, s.confirmedAt));
    }
  }

  // do teacher reads slow down saves? compare saves that overlap a teacher read with the others
  const reads = R.teacher.map((x) => [x.t, x.t + x.ms]);
  const overlaps = (sv) => reads.some(([a, b]) => sv.t < b && sv.t + sv.ms > a);
  const during = R.saveLog.filter((x) => x.ok && overlaps(x)), outside = R.saveLog.filter((x) => x.ok && !overlaps(x));

  const submitLat = R.urgentLat.submit || [];
  const burstDone = R.submitConfirmedAt ? R.submitConfirmedAt - lastPress : null;
  const retryRatio = R.attempts ? R.failedAttempts / R.attempts : 0;
  const maxHiba = Math.max(0, ...students.map((s) => s.maxHiba));
  const listT = R.teacher.filter((x) => x.kind === "list" && x.ok).map((x) => x.ms);
  const getT = R.teacher.filter((x) => x.kind === "get" && x.ok).map((x) => x.ms);

  console.log(`\n================ RESULTS (run ${runId}) ================`);
  console.log(`Save attempts: ${R.attempts}, failed attempts (retried): ${R.failedAttempts} (${(retryRatio * 100).toFixed(1)} %), errors: ${JSON.stringify(R.errors)}`);
  console.log(`Beacons (page hidden): ${R.beacons}, beacon errors: ${R.beaconErrors}. Log rows written: ${lst.rows ?? "?"}`);
  console.log(`Lock HOLD per save:             ${stats(holds)}`);
  console.log(`Lock WAIT (successful saves):   ${stats(waits)}`);
  console.log(`Server delay (send → confirmed, incl. retries): ${stats(R.serverDelay)}`);
  console.log(`Time until "Mentve" from the edit (incl. the deliberate 10 s debounce / 60 s interval): ${stats(R.toMentve)}`);
  console.log(`EP Mentés/Törlés → confirmed:   ${stats(R.urgentLat.ep || [])}`);
  console.log(`Beküldés → confirmed:           ${stats(submitLat)}; last confirmation ${fmt(burstDone)} after the last press`);
  console.log(`Students who saw "Hiba": ${students.filter((s) => s.sawHiba).length}/${N}; longest continuous "Hiba": ${fmt(maxHiba)}`);
  console.log(`Teacher list (every 30 s):      ${stats(listT)}; detail view: ${stats(getT)}; teacher errors: ${R.teacherErrors}`);
  console.log(`Saves overlapping a teacher read: ${stats(during.map((x) => x.ms))}; hold ${stats(during.map((x) => x.hold).filter((x) => x != null))}`);
  console.log(`Saves without a teacher read:     ${stats(outside.map((x) => x.ms))}; hold ${stats(outside.map((x) => x.hold).filter((x) => x != null))}`);
  console.log(`Final: list ${fmt(listMs)} (${lst.rows ?? "?"} rows), CSV "all" ${fmt(allMs)}; unsaved at end: ${unsaved}; lost: ${lost}; not submitted: ${notSubmitted}`);
  const resPending = R.resultReq.filter((x) => x.ok && !x.ready).map((x) => x.ms), resReady = R.resultReq.filter((x) => x.ok && x.ready).map((x) => x.ms);
  console.log(`Confirmation dialog: ${R.cancels} students pressed "Mégse" first. Stray saves after submitting: ${R.stray.length} (accepted into the log: ${R.stray.filter(Boolean).length}, changed what the teacher sees: ${strayWon})`);
  console.log(`Result requests: ${R.resultReq.length}, errors ${R.resultErrors}; "pending" answers ${stats(resPending)}; with the result ${stats(resReady)}`);
  console.log(`Result on the student's screen after the true value was entered (or after submitting, if later): ${stats(resultWait)}; no result: ${noResult}; wrong result: ${wrongResult}; true value leaked: ${R.leaks}`);
  console.log(`True value restored to ${prevTrue === null ? "(not set)" : prevTrue}: ${restore.ok ? "ok" : restore.error}`);

  const crit = [
    ["Nothing lost; teacher sees exactly the submitted version (stray later saves ignored)", lost === 0],
    ["Every save eventually succeeded (nothing unsaved at the end)", unsaved === 0],
    ["All students submitted", notSubmitted === 0],
    ["Server delay (send → confirmed): p95 ≤ 30 s", (pct(R.serverDelay, 0.95) ?? 0) <= 30000],
    ["Server delay (send → confirmed): max ≤ 90 s", Math.max(0, ...R.serverDelay) <= 90000],
    ["Beküldés burst: all confirmed ≤ 2 min after the last press", burstDone !== null && burstDone <= 120000],
    ["Beküldés: p95 ≤ 30 s", (pct(submitLat, 0.95) ?? 0) <= 30000],
    ["Failed attempts (retries) ≤ 10 %", retryRatio <= 0.10],
    ["No student shows \"Hiba\" > 60 s in a row", maxHiba <= 60000],
    ["Teacher list ≤ 5 s (max)", !teacher || (listT.length > 0 && Math.max(...listT) <= 5000)],
    ["CSV \"all\" ≤ 20 s", all.ok && allMs <= 20000],
    ["Every student got the correct result; the true value never reached a student", noResult === 0 && wrongResult === 0 && R.leaks === 0],
    ["Result shown ≤ 60 s after the true value was entered (30 s polling)", resultWait.length === N && Math.max(...resultWait) <= 60000],
    ["Result requests: no errors", R.resultErrors === 0]
  ];
  console.log("\nPass criteria:");
  crit.forEach(([n, okk]) => console.log(`  ${okk ? "PASS" : "FAIL"}  ${n}`));
  const failed = crit.filter((c) => !c[1]).length;
  console.log(failed ? `\n${failed} criterion/criteria FAILED.` : "\nALL CRITERIA PASSED.");
  console.log('Delete the "TERHELÉSTESZT" rows afterwards (or delete the whole "Adatok" tab).');
  process.exit(failed ? 1 : 0);
}

if (MODE === "bench") await bench();
else if (MODE === "stress") await stress();
else await realistic();
