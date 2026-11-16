/** @OnlyCurrentDoc */
/* ^ limits the script to the spreadsheet it is bound to (narrower OAuth scope). */

/**
 * Oxálsav konduktometriás titrálás – Google Apps Script backend
 * ----------------------------------------------------------------
 * Container-bound script of a Google Sheet (Extensions → Apps Script).
 * Deploy as Web app: Execute as "Me", Who has access "Anyone".
 *
 * Script property (Project Settings → Script properties):
 *   TEACHER_PASSWORD = <your password>     (required for the teacher page)
 *
 * Requests: POST, body = JSON text, Content-Type text/plain (no CORS preflight).
 *   {action:"save", key, rev, state}               – student autosave / submit (no password)
 *   {action:"list", password}                      – summary of all students
 *   {action:"get",  password, key}                 – one student incl. full state
 *   {action:"all",  password}                      – all students incl. full state (CSV export)
 * Every response: {ok:true, ...} or {ok:false, error:"<code>"}.
 */

var SHEET_NAME = 'Adatok';
var HEADERS = [
  'Kulcs', 'Név', 'Eszköz', 'Utolsó mentés', 'Beküldve', 'Beküldés ideje', 'Beküldés után módosítva',
  '1. EP V (cm3)', '1. EP dĨ/dV / (mA/cm³)', '2. EP V (cm3)', '2. EP dĨ/dV / (mA/cm³)', 'Mérési pontok', 'Rev', 'Állapot (JSON)'
];
var COL = {
  KEY: 1, NAME: 2, DEVICE: 3, SAVED: 4, SUBMITTED: 5, SUBMITTED_AT: 6, CHANGED: 7,
  EP1V: 8, EP1D: 9, EP2V: 10, EP2D: 11, POINTS: 12, REV: 13, JSON: 14
};
var NCOL = HEADERS.length;
var MAX_STATE_CHARS = 45000; // a Sheets cell holds max 50 000 characters
var MAX_ROWS = 400;
var LOCK_WAIT_MS = 20000;

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
      case 'list': return json_(checkPassword_(req) || list_(false));
      case 'all': return json_(checkPassword_(req) || list_(true));
      case 'get': return json_(checkPassword_(req) || get_(req));
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

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) return { ok: false, error: 'busy' };
  try {
    var sh = getSheet_(true);
    var found = findRow_(sh, key);
    if (found) {
      if (rev < found.rev) return { ok: true, stale: true }; // an older request arrived late
      sh.getRange(found.row, 1, 1, NCOL).setValues([values]);
    } else {
      var row = sh.getLastRow() + 1;
      sh.getRange(row, 1, 1, NCOL).setValues([values]);
      cachePut_(key, row);
    }
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  return { ok: true, savedAt: now.toISOString() };
}

function list_(withState) {
  var sh = getSheet_(false);
  if (!sh || sh.getLastRow() < 2) return { ok: true, students: [] };
  var n = sh.getLastRow() - 1;
  var data = sh.getRange(2, 1, n, withState ? NCOL : NCOL - 1).getValues();
  var out = [];
  for (var k = 0; k < data.length; k++) {
    if (!data[k][COL.KEY - 1]) continue;
    out.push(rowToObj_(data[k], withState));
  }
  return { ok: true, students: out };
}

function get_(req) {
  var sh = getSheet_(false);
  if (!sh) return { ok: false, error: 'not_found' };
  var found = findRow_(sh, String(req.key || ''));
  if (!found) return { ok: false, error: 'not_found' };
  var vals = sh.getRange(found.row, 1, 1, NCOL).getValues()[0];
  return { ok: true, student: rowToObj_(vals, true) };
}

/* ================================================================ helpers */

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

/** Locate the row of a key: cached row number first (verified), otherwise a scan of column A. */
function findRow_(sh, key) {
  var last = sh.getLastRow();
  if (last < 2) return null;
  var cached = cacheGet_(key);
  if (cached && cached >= 2 && cached <= last) {
    var v = sh.getRange(cached, 1, 1, COL.REV).getValues()[0];
    if (v[COL.KEY - 1] === key) return { row: cached, rev: Number(v[COL.REV - 1]) || 0 };
  }
  var keys = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var k = 0; k < keys.length; k++) {
    if (keys[k][0] === key) {
      var row = k + 2;
      cachePut_(key, row);
      return { row: row, rev: Number(sh.getRange(row, COL.REV).getValue()) || 0 };
    }
  }
  return null;
}

function cacheKey_(key) {
  var d = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, SHEET_NAME + '|' + key, Utilities.Charset.UTF_8);
  return 'row_' + Utilities.base64EncodeWebSafe(d);
}
function cacheGet_(key) {
  try { var v = CacheService.getScriptCache().get(cacheKey_(key)); return v ? Number(v) : null; } catch (e) { return null; }
}
function cachePut_(key, row) {
  try { CacheService.getScriptCache().put(cacheKey_(key), String(row), 21600); } catch (e) { /* ignore */ }
}

function rowToObj_(r, withState) {
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
    points: numOut_(r[COL.POINTS - 1])
  };
  if (withState) {
    try { o.state = JSON.parse(r[COL.JSON - 1]); } catch (e) { o.state = null; }
    if (o.state && o.state.name) o.name = o.state.name;
  }
  return o;
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

/* ================================================================ run these from the editor */

/** Run once after pasting the code: creates the "Adatok" sheet and asks for authorization. */
function setup() {
  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_WAIT_MS);
  try { getSheet_(true); } finally { lock.releaseLock(); }
  var pw = PropertiesService.getScriptProperties().getProperty('TEACHER_PASSWORD');
  console.log('Sheet "' + SHEET_NAME + '" OK. TEACHER_PASSWORD is ' + (pw ? 'set.' : 'NOT set – add it under Project Settings → Script properties!'));
}

/** Saves a test student, reads it back, then deletes the test row. */
function selfTest() {
  var st = { name: 'ÖNTESZT tanuló', deviceId: 'selftest01', rows: [{ v: '0', i: '1' }, { v: '1', i: '2,5' }], ep1: { v: 0.5, d: 0, i: 1.7 }, ep2: null, submitted: false };
  var r1 = save_({ action: 'save', key: 'selftest01|ÖNTESZT tanuló', rev: 1, state: st });
  var found = findRow_(getSheet_(false), 'selftest01|ÖNTESZT tanuló');
  var back = get_({ key: 'selftest01|ÖNTESZT tanuló' });
  console.log('save: ' + JSON.stringify(r1));
  console.log('read back: ' + JSON.stringify(back.student && { name: back.student.name, points: back.student.points, ep1v: back.student.ep1v }));
  if (found) getSheet_(false).deleteRow(found.row);
  console.log(r1.ok && back.ok && back.student.points === 2 ? 'SELF TEST PASSED' : 'SELF TEST FAILED');
}
