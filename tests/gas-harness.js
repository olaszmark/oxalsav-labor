// Loads apps-script/Code.gs into a Node VM with fake Google services
// (SpreadsheetApp, LockService, CacheService, PropertiesService, Utilities, ContentService).
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");

function colToNum(letter) { return letter.toUpperCase().charCodeAt(0) - 64; }

function makeSheet(name) {
  const sheet = {
    name,
    data: [], // data[r][c], 0-based
    frozen: 0,
    getLastRow() { return this.data.length; },
    _ensure(r, c) {
      while (this.data.length < r) this.data.push([]);
      for (let k = 0; k < r; k++) while (this.data[k].length < c) this.data[k].push("");
    },
    getRange(a, b, nr, nc) {
      const sh = this;
      let r0, c0, rows, cols;
      if (typeof a === "string") { // "A:C" style – formatting only
        const [x, y] = a.split(":");
        r0 = 1; c0 = colToNum(x); rows = 0; cols = colToNum(y) - c0 + 1;
      } else { r0 = a; c0 = b; rows = nr || 1; cols = nc || 1; }
      const range = {
        getValues() {
          sh.stats.reads++;
          const out = [];
          for (let r = 0; r < rows; r++) {
            const row = [];
            for (let c = 0; c < cols; c++) {
              const v = (sh.data[r0 - 1 + r] || [])[c0 - 1 + c];
              row.push(v === undefined ? "" : v);
            }
            out.push(row);
          }
          return out;
        },
        getValue() { return range.getValues()[0][0]; },
        setValues(vals) {
          sh.stats.writes++;
          if (sh.lockCheck && !sh.lockCheck()) throw new Error("write without lock");
          sh._ensure(r0 - 1 + vals.length, c0 - 1 + vals[0].length);
          vals.forEach((row, r) => row.forEach((v, c) => {
            // emulate Sheets: a string starting with "=" becomes a formula unless escaped with '
            if (typeof v === "string" && v.startsWith("=")) v = { formula: v };
            else if (typeof v === "string" && v.startsWith("'")) v = v.slice(1);
            sh.data[r0 - 1 + r][c0 - 1 + c] = v;
          }));
          return range;
        },
        setFontWeight() { return range; },
        setBackground() { return range; },
        setNumberFormat(f) { sh.formats.push({ row: r0, col: c0, rows, cols, format: f }); return range; }
      };
      return range;
    },
    /** like Sheets: appends after the last row with content; writes must happen under the script lock */
    appendRow(vals) {
      if (sheet.lockCheck && !sheet.lockCheck()) throw new Error("appendRow without lock");
      sheet.stats.appends++;
      sheet.getRange(sheet.data.length + 1, 1, 1, vals.length).setValues([vals]);
      return sheet;
    },
    clearContents() { this.data = []; return sheet; },
    setFrozenRows(n) { this.frozen = n; },
    setColumnWidth() {},
    deleteRow(r) { this.data.splice(r - 1, 1); },
    stats: { reads: 0, writes: 0, appends: 0 },
    formats: []
  };
  return sheet;
}

function loadGas(opts = {}) {
  const sheets = {};
  let lockHeld = 0;
  let lockAcquisitions = 0;
  const cache = new Map();
  const props = { TEACHER_PASSWORD: opts.password === undefined ? "titok" : opts.password };
  const ss = {
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => {
      sheets[n] = makeSheet(n);
      if (n === "Adatok") sheets[n].lockCheck = () => lockHeld > 0; // the log tab is written only under the lock
      return sheets[n];
    }
  };
  const sandbox = {
    console: { log() {}, error() {} },
    JSON, Date, Math, Number, String, Array, Object, isFinite, isNaN,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss, flush() {},
      getUi: () => { const m = { items: [], addItem(l, f) { m.items.push([l, f]); return m; }, addToUi() { sandbox.__menu = m; return m; } }; return { createMenu: (t) => { m.title = t; return m; } }; }
    },
    LockService: {
      getScriptLock: () => ({
        tryLock() { lockHeld++; lockAcquisitions++; return true; },
        waitLock() { lockHeld++; lockAcquisitions++; },
        releaseLock() { lockHeld--; }
      })
    },
    CacheService: { getScriptCache: () => ({ get: (k) => (cache.has(k) ? cache.get(k) : null), put: (k, v) => cache.set(k, v) }) },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (props[k] === undefined ? null : props[k]),
        setProperty(k, v) { props[k] = String(v); return this; },
        deleteProperty(k) { delete props[k]; return this; }
      })
    },
    Utilities: {
      DigestAlgorithm: { MD5: "md5" },
      Charset: { UTF_8: "utf8" },
      computeDigest: (alg, s) => Array.from(crypto.createHash(alg).update(s, "utf8").digest()).map((b) => (b > 127 ? b - 256 : b)),
      base64EncodeWebSafe: (bytes) => Buffer.from(bytes.map((b) => (b + 256) % 256)).toString("base64url"),
      sleep() {}
    },
    ContentService: {
      MimeType: { JSON: "application/json" },
      createTextOutput: (s) => ({ content: s, setMimeType() { return this; } })
    }
  };
  vm.createContext(sandbox);
  const code = fs.readFileSync(path.join(__dirname, "..", "apps-script", "Code.gs"), "utf8");
  vm.runInContext(code, sandbox, { filename: "Code.gs" });
  return {
    sandbox,
    sheets,
    cache,
    props,
    isLockHeld: () => lockHeld > 0,
    lockAcquisitions: () => lockAcquisitions,
    post(body) {
      const out = sandbox.doPost({ postData: { contents: typeof body === "string" ? body : JSON.stringify(body) } });
      return JSON.parse(out.content);
    },
    get() { return JSON.parse(sandbox.doGet().content); }
  };
}

module.exports = { loadGas };
