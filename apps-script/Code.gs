/** @OnlyCurrentDoc */
/* ^ limits the script to the spreadsheet it is bound to (narrower OAuth scope). */

/**
 * Oxálsav konduktometriás titrálás – Google Apps Script backend
 * ----------------------------------------------------------------
 * Container-bound script of a Google Sheet (Extensions → Apps Script).
 * Deploy as Web app: Execute as "Me", Who has access "Anyone".
 *
 * Script properties (Project Settings → Script properties):
 *   TEACHER_PASSWORD = <your password>     (required for the teacher page)
 *   TRUE_VALUE_EP2   = true NaOH volume of the 2nd equivalence point (cm³) – set from the teacher page
 *
 * Requests: POST, body = JSON text, Content-Type text/plain (no CORS preflight).
 *   {action:"save", key, rev, state}               – student autosave / submit (no password)
 *   {action:"result", key}                         – student's relative error after submitting (no password;
 *                                                    returns only the percentage, never the true value)
 *   {action:"list", password}                      – current version of every student (summary) + true value
 *   {action:"get",  password, key}                 – current version of one student incl. full state
 *   {action:"all",  password}                      – current version of every student incl. full state (CSV export)
 *   {action:"setTrue", password, value}            – store the true value ("24,15"; "" clears it)
 * Every response: {ok:true, ...} or {ok:false, error:"<code>"}.
 *
 * Storage model: APPEND-ONLY. Every save adds one row to the "Adatok" tab (a log).
 * The write lock covers only appendRow + flush (no reads), so it is held as briefly as possible.
 * Reads take no lock and pick the current version of every student (Kulcs):
 *   - SUBMITTED students: the FIRST submitted version (lowest Rev among the rows with Beküldve = igen;
 *     for an equal Rev the earlier row) is final – any later save is ignored at read time;
 *   - otherwise the row with the highest Rev (for an equal Rev the later row wins), so an older save
 *     that arrives late can never hide a newer one.
 * Relative error = |2. EP volume (as shown, 2 decimals) − true value| / true value × 100, 1 decimal,
 * computed at read time, so changing the true value updates every student at once.
 * Sheet menu "Oxálsav labor → Összesítő frissítése" writes one row per student to the "Összesítő" tab.
 */

var SHEET_NAME = 'Adatok';
var SUMMARY_SHEET = 'Összesítő';
var TRUE_PROP = 'TRUE_VALUE_EP2';
// column 7 is kept so the log layout stays the same as before (no longer used: submitting is final)
var HEADERS = [
  'Kulcs', 'Név', 'Eszköz', 'Utolsó mentés', 'Beküldve', 'Beküldés ideje', 'Beküldés után módosítva',
  '1. EP Vvalós / cm3', '1. EP Meredekség', '2. EP Vvalós / cm3', '2. EP Meredekség', 'Mérési pontok', 'Rev', 'Állapot (JSON)'
];
var COL = {
  KEY: 1, NAME: 2, DEVICE: 3, SAVED: 4, SUBMITTED: 5, SUBMITTED_AT: 6, CHANGED: 7,
  EP1V: 8, EP1D: 9, EP2V: 10, EP2D: 11, POINTS: 12, REV: 13, JSON: 14
};
var NCOL = HEADERS.length;
var MAX_STATE_CHARS = 45000; // a Sheets cell holds max 50 000 characters
var MAX_ROWS = 400;
var LOCK_WAIT_MS = 8000;     // short: a busy server answers "busy" quickly and the app retries

/* ================================================================ entry points */

function doGet() {
  return json_({ ok: true, service: 'oxalsav-labor', time: new Date().toISOString() });
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse(e && e.postData && e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'bad_request' });
  }
  if (!req || typeof req !== 'object') return json_({ ok: false, error: 'bad_request' });
  try {
    switch (req.action) {
      case 'save': return json_(save_(req));
      case 'result': return json_(result_(req));
      case 'list': return json_(checkPassword_(req) || list_(false));
      case 'all': return json_(checkPassword_(req) || list_(true));
      case 'get': return json_(checkPassword_(req) || get_(req));
      case 'setTrue': return json_(checkPassword_(req) || setTrue_(req));
      default: return json_({ ok: false, error: 'bad_action' });
    }
  } catch (err) {
    console.error(err && err.stack || err);
    return json_({ ok: false, error: 'server_error', message: String(err && err.message || err) });
  }
}

/* ================================================================ actions */

function save_(req) {
  var st = req.state;
  if (!st || typeof st !== 'object' || !Array.isArray(st.rows)) return { ok: false, error: 'bad_request' };
  if (st.rows.length > MAX_ROWS) return { ok: false, error: 'too_large' };
  var deviceId = String(st.deviceId || '');
  if (!/^[a-z0-9]{6,32}$/.test(deviceId)) return { ok: false, error: 'bad_request' };
  var name = String(st.name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!name) return { ok: false, error: 'bad_request' };
  var key = deviceId + '|' + name;              // the server builds the key itself
  if (req.key && String(req.key) !== key) return { ok: false, error: 'bad_key' };
  var stateJson = JSON.stringify(st);
  if (stateJson.length > MAX_STATE_CHARS) return { ok: false, error: 'too_large' };
  var rev = Number(req.rev) || 0;
  var now = new Date();

  // everything that does not touch the Sheet is prepared before taking the lock
  var values = [
    key,
    safeText_(name),
    deviceId,
    now,
    st.submitted ? 'igen' : 'nem',
    toDate_(st.submittedAt),
    st.submitted && st.changedAfterSubmit ? 'igen' : 'nem',
    num_(st.ep1 && st.ep1.v), num_(st.ep1 && st.ep1.d),
    num_(st.ep2 && st.ep2.v), num_(st.ep2 && st.ep2.d),
    countPoints_(st.rows),
    rev,
    stateJson
  ];
  var sh = getSheet_(false);                    // lookup only; creating the tab happens under the lock

  var lock = LockService.getScriptLock();
  var t0 = Date.now();
  if (!lock.tryLock(LOCK_WAIT_MS)) return { ok: false, error: 'busy', t: { wait: Date.now() - t0 } };
  var t1 = Date.now(), t2;
  try {
    if (!sh) sh = getSheet_(true);
    sh.appendRow(values);
    SpreadsheetApp.flush();                     // committed before the next save may append
    t2 = Date.now();
  } finally {
    lock.releaseLock();
  }
  return { ok: true, savedAt: now.toISOString(), t: { wait: t1 - t0, hold: t2 - t1 } };
}

function list_(withState) {
  var tv = trueValue_();
  var sh = getSheet_(false);
  if (!sh) return { ok: true, students: [], rows: 0, trueValue: tv };
  var latest = latestRows_(sh);
  var out = latest.map(function (L) { return rowToObj_(L.values, L.saves, tv); });
  if (withState) {
    for (var k = 0; k < latest.length; k++) out[k] = withState_(sh, latest[k], out[k], tv);
  }
  return { ok: true, students: out, rows: latest.totalRows, trueValue: tv };
}

function get_(req) {
  var tv = trueValue_();
  var sh = getSheet_(false);
  if (!sh) return { ok: false, error: 'not_found' };
  var key = String(req.key || '');
  var latest = latestRows_(sh, key)[0];
  if (!latest) return { ok: false, error: 'not_found' };
  return { ok: true, student: withState_(sh, latest, rowToObj_(latest.values, latest.saves, tv), tv), trueValue: tv };
}

/**
 * Student's result after submitting. No password: the key (random device id + name) identifies the
 * student. Returns ONLY the relative error – never the true value.
 * {ok:true, ready:false, reason}   – "pending" (no true value yet) / "not_submitted" / "no_ep2"
 * {ok:true, ready:true, relErr}    – relative error in %, 1 decimal
 */
function result_(req) {
  var key = String(req.key || '');
  if (!key || key.length > 120) return { ok: false, error: 'bad_request' };
  var tv = trueValue_();
  if (tv === null) return { ok: true, ready: false, reason: 'pending' }; // cheap: no Sheet read
  var sh = getSheet_(false);
  var latest = sh ? latestRows_(sh, key)[0] : null;
  if (!latest || !latest.final) return { ok: true, ready: false, reason: 'not_submitted' };
  var o = rowToObj_(latest.values, latest.saves, tv);
  if (o.relErr === null) return { ok: true, ready: false, reason: 'no_ep2' };
  return { ok: true, ready: true, relErr: o.relErr };
}

/** Teacher: store (or clear with "") the true volume of the 2nd equivalence point. */
function setTrue_(req) {
  var props = PropertiesService.getScriptProperties();
  var raw = req.value;
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    props.deleteProperty(TRUE_PROP);
    return { ok: true, trueValue: null };
  }
  var v = typeof raw === 'number' ? raw : parseNum_(raw);
  if (!(v > 0 && v < 1000)) return { ok: false, error: 'bad_value' };
  v = Math.round(v * 10000) / 10000;
  props.setProperty(TRUE_PROP, String(v));
  return { ok: true, trueValue: v };
}

/* ================================================================ helpers */

/**
 * Current row per student (no lock; reads the short columns Kulcs … Rev in ONE call):
 *   submitted → the FIRST submitted row (lowest Rev with Beküldve = igen; equal Rev: earlier row) is final;
 *   otherwise → highest Rev; for an equal Rev the later row wins.
 * onlyKey (optional): return just that student.
 * Returns [{key, row, rev, saves, final, values, candidates}] with .totalRows.
 */
function latestRows_(sh, onlyKey) {
  var last = sh.getLastRow();
  var result = [];
  result.totalRows = Math.max(0, last - 1);
  if (last < 2) return result;
  var data = sh.getRange(2, 1, last - 1, COL.REV).getValues();
  var best = {};
  var order = [];
  for (var k = 0; k < data.length; k++) {
    var key = data[k][COL.KEY - 1];
    if (!key) continue;
    if (onlyKey !== undefined && String(key) !== onlyKey) continue;
    var rev = Number(data[k][COL.REV - 1]) || 0;
    var b = best[key];
    if (!b) { b = best[key] = { key: String(key), saves: 0, candidates: [] }; order.push(key); }
    b.saves++;
    b.candidates.push({ row: k + 2, rev: rev, values: data[k] });
  }
  for (var j = 0; j < order.length; j++) {
    var e = best[order[j]];
    var submitted = e.candidates.filter(function (c) { return c.values[COL.SUBMITTED - 1] === 'igen'; });
    e.final = submitted.length > 0;
    if (e.final) {
      // submitting is final: the first submitted version wins, later saves are ignored
      e.candidates = submitted.sort(function (a, c) { return a.rev - c.rev || a.row - c.row; });
    } else {
      // newest first: highest rev, then latest row
      e.candidates.sort(function (a, c) { return c.rev - a.rev || c.row - a.row; });
    }
    e.row = e.candidates[0].row; e.rev = e.candidates[0].rev; e.values = e.candidates[0].values;
    result.push(e);
  }
  return result;
}

/** Adds the full state (JSON column) of the newest readable row of a student. */
function withState_(sh, latest, obj, tv) {
  var cands = latest.candidates || [{ row: latest.row, values: latest.values }];
  for (var k = 0; k < cands.length && k < 3; k++) {
    var raw = sh.getRange(cands[k].row, COL.JSON).getValue();
    var st = null;
    try { st = JSON.parse(raw); } catch (e) { st = null; }
    if (st) {
      var o = k === 0 ? obj : rowToObj_(cands[k].values, latest.saves, tv);
      o.state = st;
      if (st.name) o.name = st.name;
      return o;
    }
  }
  obj.state = null;
  return obj;
}

function checkPassword_(req) {
  var pw = PropertiesService.getScriptProperties().getProperty('TEACHER_PASSWORD');
  if (!pw) return { ok: false, error: 'not_configured' };
  if (String(req.password || '') !== pw) {
    Utilities.sleep(400); // slows down guessing a little
    return { ok: false, error: 'auth' };
  }
  return null;
}

function getSheet_(create) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh && create) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.getRange(1, 1, 1, NCOL).setValues([HEADERS]).setFontWeight('bold').setBackground('#e8eaf6');
    sh.setFrozenRows(1);
    sh.getRange('A:C').setNumberFormat('@');
    sh.getRange('D:D').setNumberFormat('yyyy-mm-dd hh:mm:ss');
    sh.getRange('F:F').setNumberFormat('yyyy-mm-dd hh:mm:ss');
    sh.setColumnWidth(COL.KEY, 160);
    sh.setColumnWidth(COL.NAME, 180);
    sh.setColumnWidth(COL.JSON, 300);
  }
  return sh;
}

function rowToObj_(r, saves, tv) {
  var o = {
    key: String(r[COL.KEY - 1]),
    name: String(r[COL.NAME - 1]).replace(/^'(?=[=+\-@])/, ''),
    deviceId: String(r[COL.DEVICE - 1]),
    savedAt: iso_(r[COL.SAVED - 1]),
    submitted: r[COL.SUBMITTED - 1] === 'igen',
    submittedAt: iso_(r[COL.SUBMITTED_AT - 1]),
    changedAfterSubmit: r[COL.CHANGED - 1] === 'igen',
    ep1v: numOut_(r[COL.EP1V - 1]), ep1d: numOut_(r[COL.EP1D - 1]),
    ep2v: numOut_(r[COL.EP2V - 1]), ep2d: numOut_(r[COL.EP2D - 1]),
    points: numOut_(r[COL.POINTS - 1]),
    rev: numOut_(r[COL.REV - 1]),
    saves: saves || 1
  };
  o.relErr = relErr_(o.ep2v, tv);
  return o;
}

/** The true value from the Script properties, or null if not set. */
function trueValue_() {
  var s = PropertiesService.getScriptProperties().getProperty(TRUE_PROP);
  var v = s === null || s === undefined ? NaN : Number(s);
  return v > 0 ? v : null;
}

/** |V2 − true| / true × 100 with V2 rounded to 2 decimals (as shown), result rounded to 1 decimal. */
function relErr_(v2, tv) {
  if (typeof v2 !== 'number' || !isFinite(v2) || !tv) return null;
  var shown = Number(v2.toFixed(2));
  return Math.round(Math.abs(shown - tv) / tv * 1000 + 1e-9) / 10;
}

/** Number of rows where both volume and current are valid non-negative numbers. */
function countPoints_(rows) {
  var n = 0;
  for (var k = 0; k < rows.length; k++) {
    var r = rows[k] || {};
    if (parseNum_(r.v) >= 0 && parseNum_(r.i) >= 0) n++;
  }
  return n;
}
function parseNum_(s) {
  if (s === null || s === undefined) return NaN;
  s = String(s).replace(/[\s  ]/g, '').replace(/−/g, '-');
  if (!/^[+-]?(\d+([.,]\d*)?|[.,]\d+)$/.test(s)) return NaN;
  return Number(s.replace(',', '.'));
}

function num_(x) { return typeof x === 'number' && isFinite(x) ? x : ''; }
function numOut_(x) { return typeof x === 'number' && isFinite(x) ? x : null; }
function toDate_(iso) { if (!iso) return ''; var d = new Date(iso); return isNaN(d.getTime()) ? '' : d; }
function iso_(v) { return v instanceof Date ? v.toISOString() : (v ? String(v) : null); }
/** Text starting with = + - @ would be read as a formula by Sheets. */
function safeText_(s) { return /^[=+\-@]/.test(s) ? "'" + s : s; }

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ================================================================ Sheet menu: summary tab */

/** Simple trigger: adds the "Oxálsav labor" menu when the Sheet is opened. */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Oxálsav labor')
    .addItem('Összesítő frissítése', 'refreshSummary')
    .addToUi();
}

/** Writes one row per student (newest version) to the "Összesítő" tab. Does not touch "Adatok". */
function refreshSummary() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var src = ss.getSheetByName(SHEET_NAME);
  var latest = src ? latestRows_(src) : [];
  var tv = trueValue_();
  var head = ['Név', 'Eszköz', 'Utolsó mentés', 'Beküldve', 'Beküldés ideje',
    '1. EP Vvalós / cm3', '1. EP Meredekség', '2. EP Vvalós / cm3', '2. EP Meredekség', 'Relatív hiba (%)', 'Mérési pontok', 'Mentések száma'];
  var rows = latest.map(function (L) {
    var v = L.values;
    var rel = relErr_(numOut_(v[COL.EP2V - 1]), tv);
    return [v[COL.NAME - 1], v[COL.DEVICE - 1], v[COL.SAVED - 1], v[COL.SUBMITTED - 1], v[COL.SUBMITTED_AT - 1],
      v[COL.EP1V - 1], v[COL.EP1D - 1], v[COL.EP2V - 1], v[COL.EP2D - 1], rel === null ? '' : rel, v[COL.POINTS - 1], L.saves];
  }).sort(function (a, b) { return String(a[0]).localeCompare(String(b[0]), 'hu'); });
  var sh = ss.getSheetByName(SUMMARY_SHEET) || ss.insertSheet(SUMMARY_SHEET);
  sh.clearContents();
  sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold').setBackground('#e8eaf6');
  sh.setFrozenRows(1);
  if (rows.length) {
    sh.getRange(2, 2, rows.length, 1).setNumberFormat('@');
    sh.getRange(2, 1, rows.length, head.length).setValues(rows);
    sh.getRange(2, 3, rows.length, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
    sh.getRange(2, 5, rows.length, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
    sh.getRange(2, 10, rows.length, 1).setNumberFormat('0.0'); // Relatív hiba (%): always 1 decimal, e.g. 3,0
  }
  return rows.length;
}

/* ================================================================ run these from the editor */

/** Run once after pasting the code: creates the "Adatok" sheet and asks for authorization. */
function setup() {
  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_WAIT_MS);
  try { getSheet_(true); } finally { lock.releaseLock(); }
  var pw = PropertiesService.getScriptProperties().getProperty('TEACHER_PASSWORD');
  console.log('Sheet "' + SHEET_NAME + '" OK. TEACHER_PASSWORD is ' + (pw ? 'set.' : 'NOT set – add it under Project Settings → Script properties!'));
}

/**
 * Saves a test student several times, reads the current version back, then deletes the test rows:
 * a late older save must not win, and after submitting, a later save must not change what is shown.
 */
function selfTest() {
  var key = 'selftest01|ÖNTESZT tanuló';
  var st = { name: 'ÖNTESZT tanuló', deviceId: 'selftest01', rows: [{ v: '0', i: '1' }, { v: '1', i: '2,5' }], ep1: { v: 0.5, d: 0, i: 1.7 }, ep2: null, submitted: false };
  var r1 = save_({ action: 'save', key: key, rev: 2, state: st });
  var r0 = save_({ action: 'save', key: key, rev: 1, state: { name: st.name, deviceId: st.deviceId, rows: [], submitted: false } }); // older, arrives late
  var back = get_({ key: key });
  console.log('save: ' + JSON.stringify(r1) + ' / late older save: ' + JSON.stringify(r0));
  console.log('read back: ' + JSON.stringify(back.student && { name: back.student.name, points: back.student.points, ep1v: back.student.ep1v, rev: back.student.rev }));
  var sub = JSON.parse(JSON.stringify(st)); sub.ep2 = { v: 0.9, d: 1, i: 2 }; sub.submitted = true; sub.submittedAt = new Date().toISOString();
  var r3 = save_({ action: 'save', key: key, rev: 3, state: sub });
  var late = JSON.parse(JSON.stringify(sub)); late.ep2.v = 0.95;
  var r4 = save_({ action: 'save', key: key, rev: 4, state: late }); // a save after submitting: must be ignored
  var fin = get_({ key: key });
  var subOk = !!(r3.ok && r4.ok && fin.ok && fin.student.rev === 3 && fin.student.ep2v === 0.9 && fin.student.submitted);
  console.log('after submit + a later save: ' + JSON.stringify(fin.student && { rev: fin.student.rev, ep2v: fin.student.ep2v, submitted: fin.student.submitted }) +
    (subOk ? ' – the later save is ignored' : ' – WRONG'));
  var sh = getSheet_(false);
  if (sh && sh.getLastRow() >= 2) {
    var keys = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
    for (var k = keys.length - 1; k >= 0; k--) if (keys[k][0] === key) sh.deleteRow(k + 2);
  }
  console.log(r1.ok && r0.ok && back.ok && back.student.points === 2 && back.student.rev === 2 && subOk ? 'SELF TEST PASSED' : 'SELF TEST FAILED');
}
