/* Backend client: real Apps Script web app or a localStorage mock, plus the
 * autosave pipeline (debounce, min interval, single request in flight, retry). */
(function () {
  "use strict";
  var CFG = window.LAB_CONFIG || {};
  var params = new URLSearchParams(location.search);
  var MOCK = params.get("mock") === "1" || !CFG.API_URL;
  var MOCK_FAIL = parseFloat(params.get("fail") || "0") || 0;     // e.g. ?mock=1&fail=0.5
  var MOCK_DELAY = parseInt(params.get("delay") || "600", 10);     // ms
  var MOCK_DB = "oxalsav_mock_db";
  var MOCK_PASSWORD = "tanar";

  /* -------------------------------------------------------- transport */

  function realCall(payload) {
    var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, CFG.REQUEST_TIMEOUT_MS || 25000) : 0;
    return fetch(CFG.API_URL, {
      method: "POST",
      // text/plain = "simple request": no CORS preflight (Apps Script cannot answer OPTIONS)
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
      redirect: "follow",
      cache: "no-store",
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      clearTimeout(timer);
      if (!res.ok) throw apiError("http_" + res.status);
      return res.text();
    }, function (err) {
      clearTimeout(timer);
      throw apiError(err && err.name === "AbortError" ? "timeout" : "network");
    }).then(function (text) {
      var json;
      try { json = JSON.parse(text); } catch (e) { throw apiError("bad_response"); }
      if (!json || json.ok !== true) throw apiError((json && json.error) || "unknown");
      return json;
    });
  }

  function apiError(code) {
    var e = new Error(code);
    e.code = code;
    return e;
  }

  /* ------------------------------------------------------------- mock */

  function mockLoad() {
    try { return JSON.parse(localStorage.getItem(MOCK_DB) || "{}"); } catch (e) { return {}; }
  }
  function mockStore(db) {
    try { localStorage.setItem(MOCK_DB, JSON.stringify(db)); } catch (e) { /* ignore */ }
  }
  function summary(rec) {
    var s = {};
    Object.keys(rec).forEach(function (k) { if (k !== "state") s[k] = rec[k]; });
    return s;
  }
  function epNum(ep, f) { return ep && typeof ep[f] === "number" ? ep[f] : null; }

  function mockHandle(p) {
    var db = mockLoad();
    switch (p.action) {
      case "save": {
        if (!p.key || !p.state) throw apiError("bad_request");
        var old = db[p.key];
        if (old && typeof old.rev === "number" && p.rev < old.rev) return { ok: true, stale: true };
        var st = p.state;
        var pts = (window.LabCore ? window.LabCore.getPoints(st.rows || []).length : 0);
        db[p.key] = {
          key: p.key, name: st.name, deviceId: st.deviceId, savedAt: new Date().toISOString(),
          submitted: !!st.submitted, submittedAt: st.submittedAt || null, changedAfterSubmit: !!st.changedAfterSubmit,
          ep1v: epNum(st.ep1, "v"), ep1d: epNum(st.ep1, "d"), ep2v: epNum(st.ep2, "v"), ep2d: epNum(st.ep2, "d"),
          points: pts, rev: p.rev, state: st
        };
        mockStore(db);
        return { ok: true, savedAt: db[p.key].savedAt };
      }
      case "list":
      case "all":
      case "get": {
        if (p.password !== MOCK_PASSWORD) throw apiError("auth");
        if (p.action === "get") {
          if (!db[p.key]) throw apiError("not_found");
          return { ok: true, student: db[p.key] };
        }
        var list = Object.keys(db).map(function (k) { return p.action === "all" ? db[k] : summary(db[k]); });
        return { ok: true, students: list };
      }
      default:
        throw apiError("bad_action");
    }
  }

  function mockCall(payload) {
    var copy = JSON.parse(JSON.stringify(payload));
    return new Promise(function (resolve, reject) {
      setTimeout(function () {
        if (Math.random() < MOCK_FAIL) { reject(apiError("network")); return; }
        try { resolve(mockHandle(copy)); } catch (e) { reject(e); }
      }, MOCK_DELAY * (0.5 + Math.random()));
    });
  }

  function call(payload) { return MOCK ? mockCall(payload) : realCall(payload); }

  /**
   * Fire-and-forget save that survives page unload / app switch / screen lock.
   * 1) navigator.sendBeacon with a string body → Content-Type text/plain;charset=UTF-8
   *    (CORS-safelisted: no preflight). Apps Script runs doPost before it answers with
   *    its 302 redirect, so the redirect does not matter for a beacon.
   * 2) Fallback: fetch with keepalive:true, mode:"no-cors", text/plain (same properties).
   * Returns true if the browser accepted the request for sending.
   */
  function beacon(payload) {
    var body = JSON.stringify(payload);
    if (MOCK) { try { mockHandle(JSON.parse(body)); } catch (e) { /* ignore */ } return true; }
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(CFG.API_URL, body)) return true;
    } catch (e) { /* fall through */ }
    try {
      fetch(CFG.API_URL, {
        method: "POST", body: body, keepalive: true, mode: "no-cors", credentials: "omit",
        headers: { "Content-Type": "text/plain;charset=UTF-8" }
      }).catch(function () { /* ignore */ });
      return true;
    } catch (e) { return false; }
  }

  /* ------------------------------------------------------------ saver */

  /**
   * Autosave pipeline.
   * opts.build()          -> {payload, hash} | null   (current state to send)
   * opts.onStatus(s, info) s: "idle" | "pending" | "saving" | "saved" | "error"
   * opts.onSaved(payload)
   */
  function Saver(opts) {
    this.opts = opts;
    this.debounce = CFG.SAVE_DEBOUNCE_MS || 5000;
    this.minInterval = CFG.SAVE_MIN_INTERVAL_MS || 20000;
    this.interval = this.minInterval;
    this.seq = 0;
    this.savedSeq = 0;
    this.savedHash = null;
    this.inFlight = false;
    this.lastSentAt = 0;
    this.failures = 0;
    this.timer = 0;
    this.force = false;
    this.urgent = false;
    this.hiddenHash = null;
    var self = this;
    window.addEventListener("online", function () { if (self.isDirty()) self._schedule(300); });
  }

  Saver.prototype.isDirty = function () { return this.seq !== this.savedSeq; };

  /** Something changed: save after the debounce delay (respecting the min interval). */
  Saver.prototype.markDirty = function () {
    this.seq += 1;
    if (this.failures > 0) return; // retry timer already running
    this.opts.onStatus("pending");
    var jitter = Math.random() * 1000;
    var wait = Math.max(this.debounce + jitter, this.lastSentAt + this.interval - Date.now());
    this._schedule(wait);
  };

  /**
   * Save as soon as possible, bypassing the debounce and the min interval
   * (submit button, saving an equivalence point, first registration).
   * If a request is already in flight, the next one starts right after it.
   */
  Saver.prototype.saveNow = function () {
    this.seq += 1;
    this.force = true;
    this.urgent = true;
    this.failures = 0;
    this.opts.onStatus("pending");
    this._schedule(0);
  };

  Saver.prototype._schedule = function (ms) {
    var self = this;
    clearTimeout(this.timer);
    this.timer = setTimeout(function () { self._run(); }, Math.max(0, ms));
  };

  Saver.prototype._run = function () {
    var self = this;
    if (this.inFlight) return; // will re-check when the request finishes
    if (!this.isDirty()) return;
    var built = this.opts.build();
    if (!built) return;
    var seqAtSend = this.seq;
    if (built.hash === this.savedHash && !this.force) {
      this.savedSeq = seqAtSend;
      this.opts.onStatus("saved", { time: this.lastSavedTime });
      return;
    }
    this.force = false;
    this.urgent = false;
    this.inFlight = true;
    this.lastSentAt = Date.now();
    this.opts.onStatus("saving");
    var t0 = Date.now();
    call(built.payload).then(function () {
      var latency = Date.now() - t0;
      self.inFlight = false;
      self.failures = 0;
      self.savedSeq = seqAtSend;
      self.savedHash = built.hash;
      self.lastSavedTime = new Date();
      // slow server → space the saves out more (protects Apps Script quotas)
      self.interval = latency > 8000 ? Math.max(self.minInterval, 60000)
        : latency > 4000 ? Math.max(self.minInterval, 40000) : self.minInterval;
      if (self.opts.onSaved) self.opts.onSaved(built.payload);
      if (self.isDirty()) {
        self.opts.onStatus("pending");
        // an urgent save requested during the flight goes out at once
        self._schedule(self.urgent ? 0 : Math.max(self.debounce, self.interval - latency));
      } else {
        self.opts.onStatus("saved", { time: self.lastSavedTime });
      }
    }, function (err) {
      self.inFlight = false;
      self.failures += 1;
      var delay = Math.min(60000, 5000 * Math.pow(2, self.failures - 1)) * (0.75 + Math.random() * 0.5);
      self.opts.onStatus("error", { code: err && err.code, retryIn: delay, offline: navigator.onLine === false });
      self._schedule(delay);
    });
  };

  /**
   * Page is being hidden (tab closed, app switch, screen lock): send the latest state
   * with an unload-safe request – also while a normal save is in flight, because the
   * page may be frozen or killed before that one completes.
   * Delivery is not confirmed, so the state stays "dirty": if the page comes back,
   * resume() sends a normal, confirmed save. Duplicates are harmless – the server
   * keeps the highest revision.
   */
  Saver.prototype.flushBeacon = function () {
    if (!this.isDirty()) return;
    var built = this.opts.build();
    if (!built || built.hash === this.savedHash) return;
    if (built.hash === this.hiddenHash) return; // already sent (visibilitychange + pagehide both fire)
    if (beacon(built.payload)) this.hiddenHash = built.hash;
  };

  /** Page visible again: send pending changes soon. */
  Saver.prototype.resume = function () {
    if (this.isDirty() && !this.inFlight) this._schedule(this.failures > 0 ? 1000 : this.debounce);
  };

  window.LabApi = {
    isMock: MOCK,
    mockPassword: MOCK ? MOCK_PASSWORD : null,
    call: call,
    beacon: beacon,
    Saver: Saver
  };
})();
