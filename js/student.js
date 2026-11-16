/* Student page controller. */
(function () {
  "use strict";
  var C = window.LabCore, API = window.LabApi, CFG = window.LAB_CONFIG || {};
  var LS_DEVICE = "oxalsav_device_id";
  var LS_STATE = "oxalsav_state";
  var LS_REV = "oxalsav_rev";

  var $ = function (id) { return document.getElementById(id); };
  var state = null;           // see newState()
  var plot = null;
  var saver = null;
  var selecting = 0;          // 0 = none, 1 or 2 = choosing that equivalence point
  var cursorInfo = null;
  var confirmedSubmitAt = null; // submittedAt value the server has confirmed
  var lastDeleted = null;

  /* ------------------------------------------------------------ storage */

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }

  function deviceId() {
    var id = lsGet(LS_DEVICE);
    if (!id) { id = C.randomId(12); lsSet(LS_DEVICE, id); }
    return id;
  }

  var revMem = 0;
  /** Monotonic revision number per device; the server never lets a lower one overwrite a higher one. */
  function nextRev() {
    var stored = parseInt(lsGet(LS_REV) || "0", 10) || 0;
    revMem = Math.max(revMem, stored) + 1; // in-memory fallback if localStorage is unavailable
    lsSet(LS_REV, String(revMem));
    return revMem;
  }

  function newState(name) {
    var dev = deviceId();
    return {
      version: 1,
      name: name,
      deviceId: dev,
      key: dev + "|" + name,
      rows: C.rowsFromPresets(CFG.PRESET_VOLUMES || []),
      showDeriv: true,
      ep1: null,
      ep2: null,
      submitted: false,
      submittedAt: null,
      changedAfterSubmit: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }

  function loadState() {
    var raw = lsGet(LS_STATE);
    if (!raw) return null;
    try {
      var s = JSON.parse(raw);
      if (!s || !s.name || !Array.isArray(s.rows)) return null;
      s.rows = s.rows.map(function (r) { return { id: r.id || C.newId(), v: String(r.v || ""), i: String(r.i || "") }; });
      return s;
    } catch (e) { return null; }
  }

  var localSaveFailed = false; // the last write to the phone's storage failed

  function persistLocal() {
    localSaveFailed = !lsSet(LS_STATE, JSON.stringify(state));
    if (localSaveFailed) setStatus("error", { code: "storage" });
  }

  /** Called after every change made by the student. */
  function changed(viewOnly, urgent) {
    state.updatedAt = new Date().toISOString();
    if (state.submitted && !viewOnly) state.changedAfterSubmit = true;
    persistLocal();
    if (urgent) saver.saveNow(); else saver.markDirty();
    renderSubmitState();
  }

  /* ------------------------------------------------------------- start */

  function init() {
    document.title = (CFG.TITLE || "Oxálsav titrálás") + " – tanulói felület";
    $("appTitle").textContent = CFG.TITLE || $("appTitle").textContent;
    if (API.isMock) { $("mockNote").hidden = false; $("mockNoteStart").hidden = false; }

    saver = new API.Saver({
      build: buildPayload,
      onStatus: setStatus,
      onSaved: function (payload) {
        if (payload.state.submitted) confirmedSubmitAt = payload.state.submittedAt;
        renderSubmitState();
      }
    });

    state = loadState();
    if (state) startApp(false);
    else showStart();

    document.addEventListener("visibilitychange", function () {
      if (!saver) return;
      if (document.visibilityState === "hidden") saver.flushBeacon();
      else saver.resume();
    });
    window.addEventListener("pagehide", function () { if (saver) saver.flushBeacon(); });
  }

  function showStart() {
    $("app").hidden = true;
    $("startScreen").hidden = false;
    $("startForm").onsubmit = function (e) {
      e.preventDefault();
      var name = C.normalizeName($("nameInput").value);
      if (name.length < 3) { $("nameError").hidden = false; $("nameInput").focus(); return; }
      state = newState(name);
      persistLocal();
      startApp(true);
    };
  }

  function startApp(isNew) {
    $("startScreen").hidden = true;
    $("app").hidden = false;
    $("studentName").textContent = state.name;
    $("topTitle").textContent = CFG.TITLE ? shortTitle(CFG.TITLE) : "Oxálsav titrálás";
    $("deviceInfo").textContent = "Eszközazonosító: " + state.deviceId;
    $("derivToggle").checked = state.showDeriv !== false;

    plot = new window.LabPlot($("plot"), {
      onCursor: onCursor,
      onView: function (zoomed) { $("resetZoomBtn").hidden = !zoomed; }
    });
    bindUi();
    renderTable();
    refreshComputed();
    renderEps();
    renderSubmitState();
    if (isNew) saver.saveNow(); // register the student on the server right away
    else saver.markDirty(); // make sure the server has the latest version after a reload
  }

  function shortTitle(t) { return t.length > 28 ? "Oxálsav titrálás" : t; }

  /* ------------------------------------------------------------ payload */

  function buildPayload() {
    var st = JSON.parse(JSON.stringify(state));
    var hash = JSON.stringify(st);
    return {
      hash: hash,
      payload: { action: "save", key: state.key, rev: nextRev(), clientTime: new Date().toISOString(), state: st }
    };
  }

  /* ------------------------------------------------------------- status */

  function hhmm(d) {
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }

  /**
   * Status chip (top right):
   *   pending → grey  "Mentve a telefonon"  data is on the phone, the next autosave is scheduled
   *   saving  → grey  "Küldés…"             a request is on its way (or retrying while the server is only busy)
   *   saved   → green "Mentve hh:mm"        the server confirmed the save
   *   error   → red   "Hiba – …" / "Nincs internet – …"
   */
  function setStatus(s, info) {
    var el = $("saveStatus");
    // never claim "saved on the phone" if writing to the phone's storage failed
    if (s === "pending" && localSaveFailed) { s = "error"; info = { code: "storage" }; }
    el.className = "save-status " + ({ pending: "local", saving: "sending", saved: "saved", error: "error" }[s] || "");
    if (s === "saved") el.textContent = "Mentve " + hhmm(info && info.time ? info.time : new Date());
    else if (s === "saving") el.textContent = "Küldés…";
    else if (s === "pending") el.textContent = "Mentve a telefonon";
    else if (s === "error") {
      el.textContent = info && info.code === "storage" ? "Hiba – a telefon tárhelye megtelt"
        : info && info.offline ? "Nincs internet – újrapróbálás" : "Hiba – újrapróbálás";
    } else el.textContent = "–";
  }

  /* ------------------------------------------------------------- table */

  function renderTable() {
    var body = $("dataBody");
    body.textContent = "";
    var frag = document.createDocumentFragment();
    state.rows.forEach(function (r, k) {
      var tr = document.createElement("tr");
      tr.dataset.id = r.id;
      tr.innerHTML =
        '<td class="col-n"></td>' +
        '<td><input class="num" data-f="v" inputmode="decimal" enterkeyhint="next" autocomplete="off" spellcheck="false"></td>' +
        '<td><input class="num" data-f="i" inputmode="decimal" enterkeyhint="next" autocomplete="off" spellcheck="false"></td>' +
        '<td class="col-d"><output></output></td>' +
        '<td class="col-x"><button type="button" class="del-btn" aria-label="Sor törlése">×</button></td>';
      tr.cells[0].textContent = k + 1;
      var iv = tr.querySelector('[data-f="v"]'), ii = tr.querySelector('[data-f="i"]');
      iv.value = r.v; ii.value = r.i;
      iv.setAttribute("aria-label", (k + 1) + ". sor, NaOH térfogat");
      ii.setAttribute("aria-label", (k + 1) + ". sor, áramerősség");
      markValidity(iv); markValidity(ii);
      frag.appendChild(tr);
    });
    body.appendChild(frag);
  }

  function markValidity(input) {
    var c = C.classifyInput(input.value);
    input.classList.toggle("invalid", c === "invalid");
    input.title = c === "invalid" ? "Érvénytelen szám" : "";
  }

  function rowIndexOf(el) {
    var tr = el.closest("tr");
    if (!tr) return -1;
    var id = tr.dataset.id;
    for (var k = 0; k < state.rows.length; k++) if (state.rows[k].id === id) return k;
    return -1;
  }

  /** Recompute derivative column, plot, counters and saved EP values. */
  function refreshComputed() {
    var d = C.derivativeColumn(state.rows);
    var outs = $("dataBody").querySelectorAll("output");
    for (var k = 0; k < outs.length; k++) outs[k].textContent = d[k] === null ? "" : C.formatDeriv(d[k]);
    var series = C.buildSeries(state.rows);
    // keep the saved EP values consistent with the (possibly edited) data
    ["ep1", "ep2"].forEach(function (k) {
      var ep = state[k];
      if (!ep) return;
      ep.d = valueAt(series.deriv, ep.v);
      ep.i = valueAt(series.current, ep.v);
    });
    plot.setData({ series: series, showDeriv: state.showDeriv !== false, ep1: state.ep1, ep2: state.ep2 });
    var n = series.current.length;
    $("pointCount").textContent = n + " mérési pont";
    $("sortHint").hidden = C.isSortedByVolume(state.rows);
    renderEps();
    onCursor(plot.getCursorInfo());
  }

  function valueAt(series, x) {
    if (!series.length || x < series[0].x - 1e-9 || x > series[series.length - 1].x + 1e-9) return null;
    var p = C.interpolate(series, x);
    return p ? round(p.y, 6) : null;
  }
  function round(x, n) { var f = Math.pow(10, n); return Math.round(x * f) / f; }

  /* ------------------------------------------------------------ cursor */

  function onCursor(info) {
    cursorInfo = info;
    var el = $("readout");
    if (!info) {
      el.innerHTML = "Érintsd meg a grafikont az értékek leolvasásához.";
    } else {
      var html = '<span class="ro-v">V = <b>' + C.formatNum(info.x, 2) + "</b> cm³</span>";
      if (info.on === "deriv") {
        html += '<span class="ro-d">dĨ/dV = <b>' + (info.d === null ? "–" : C.formatDeriv(info.d)) + "</b> mA/cm³</span>";
      } else {
        html += '<span class="ro-i">Ĩ = <b>' + (info.i === null ? "–" : C.formatNum(info.i, 3)) + "</b> mA</span>";
      }
      el.innerHTML = html;
    }
    $("epSaveBtn").disabled = !info;
  }

  /* ---------------------------------------------------- equivalence points */

  function startSelect(n) {
    selecting = n;
    $("epButtons").hidden = true;
    $("epSelect").hidden = false;
    $("epSelect").className = "ep-select ep" + n;
    $("epSelectText").innerHTML = n === 1
      ? "<b>1. ekvivalenciapont kijelölése.</b> Érintsd meg vagy húzd az ujjad a grafikonon. Keresd meg, ahol a <b>derivált = 0</b>, majd nyomd meg a Mentés gombot."
      : "<b>2. ekvivalenciapont kijelölése.</b> Érintsd meg vagy húzd az ujjad a grafikonon. Keresd meg a <b>derivált maximumát</b>, majd nyomd meg a Mentés gombot.";
    $("epSelectShort").textContent = n === 1 ? "1. EP (derivált = 0):" : "2. EP (derivált max.):";
    $("plotBox").classList.add("selecting", "sel-ep" + n);
    var ep = state["ep" + n];
    if (ep) plot.setCursor(ep.v);
    else onCursor(plot.getCursorInfo());
    $("plotBox").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function endSelect() {
    selecting = 0;
    $("epButtons").hidden = false;
    $("epSelect").hidden = true;
    $("plotBox").classList.remove("selecting", "sel-ep1", "sel-ep2");
  }

  function saveEp() {
    var info = plot.getCursorInfo();
    if (!selecting || !info) return;
    state["ep" + selecting] = {
      v: round(info.x, 4),
      d: info.d === null ? null : round(info.d, 6),
      i: info.i === null ? null : round(info.i, 6),
      on: info.on,
      at: new Date().toISOString()
    };
    var n = selecting;
    endSelect();
    plot.setData({ ep1: state.ep1, ep2: state.ep2 });
    renderEps();
    changed(false, true); // immediate server save, bypassing the 5 s / 20 s throttle
    toast(n + ". ekvivalenciapont elmentve.");
    if (n === 1 && !state.ep2) $("ep2Btn").classList.add("pulse");
  }

  function deleteEp(n) {
    if (!window.confirm("Biztosan törlöd a(z) " + n + ". ekvivalenciapontot?")) return;
    state["ep" + n] = null;
    plot.setData({ ep1: state.ep1, ep2: state.ep2 });
    renderEps();
    changed(false, true); // immediate server save, bypassing the 5 s / 20 s throttle
  }

  function epText(ep) {
    if (!ep) return "még nincs kijelölve";
    return '<span class="nowrap">V = <b>' + C.formatNum(ep.v, 2) + '</b> cm³</span> &nbsp; <span class="nowrap">dĨ/dV = <b>' +
      (ep.d === null || ep.d === undefined ? "–" : C.formatDeriv(ep.d)) + "</b> mA/cm³</span>";
  }

  function renderEps() {
    [1, 2].forEach(function (n) {
      var ep = state["ep" + n];
      $("ep" + n + "Val").innerHTML = epText(ep);
      $("ep" + n + "Val").classList.toggle("empty", !ep);
      $("ep" + n + "Del").hidden = !ep;
      $("ep" + n + "Btn").textContent = ep ? n + ". ekvivalenciapont újra kijelölése" : n + ". ekvivalenciapont kijelölése";
      $("ep" + n + "Btn").classList.toggle("done", !!ep);
    });
    if (state.ep2) $("ep2Btn").classList.remove("pulse");
  }

  /* ------------------------------------------------------------- submit */

  function renderSubmitState() {
    var el = $("submitState");
    if (!state.submitted) {
      el.className = "submit-state";
      el.textContent = "Még nem küldted be.";
      $("submitBtn").textContent = "Beküldés";
      return;
    }
    var t = hhmm(new Date(state.submittedAt));
    if (state.changedAfterSubmit) {
      el.className = "submit-state warn";
      el.textContent = "Beküldve " + t + ", de azóta módosítottál. Küldd be újra!";
      $("submitBtn").textContent = "Újra beküldés";
    } else if (confirmedSubmitAt !== state.submittedAt) {
      el.className = "submit-state pending";
      el.textContent = "Beküldés folyamatban… (ha nincs internet, automatikusan újrapróbáljuk)";
      $("submitBtn").textContent = "Újra beküldés";
    } else {
      el.className = "submit-state ok";
      el.textContent = "✔ Beküldve " + t + ". Ha módosítasz, küldd be újra.";
      $("submitBtn").textContent = "Újra beküldés";
    }
  }

  function submit() {
    var missing = [];
    if (C.getPoints(state.rows).length < 3) missing.push("kevés mérési pont van");
    if (!state.ep1) missing.push("nincs kijelölve az 1. ekvivalenciapont");
    if (!state.ep2) missing.push("nincs kijelölve a 2. ekvivalenciapont");
    if (missing.length && !window.confirm("Figyelem: " + missing.join(", ") + ".\nBiztosan beküldöd így?")) return;
    if (selecting) endSelect();
    state.submitted = true;
    state.submittedAt = new Date().toISOString();
    state.changedAfterSubmit = false;
    state.updatedAt = state.submittedAt;
    persistLocal();
    saver.saveNow();
    renderSubmitState();
  }

  /* ------------------------------------------------------------- toast */

  var toastTimer = 0;
  function toast(text, actionLabel, action) {
    $("toastText").textContent = text;
    var btn = $("toastAction");
    btn.hidden = !actionLabel;
    btn.textContent = actionLabel || "";
    btn.onclick = function () { hideToast(); if (action) action(); };
    $("toast").hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, actionLabel ? 6000 : 2500);
  }
  function hideToast() { $("toast").hidden = true; }

  /* ---------------------------------------------------------------- ui */

  function bindUi() {
    var body = $("dataBody");

    body.addEventListener("input", function (e) {
      var t = e.target;
      if (!t.matches("input.num")) return;
      var k = rowIndexOf(t);
      if (k < 0) return;
      state.rows = C.updateRow(state.rows, k, t.dataset.f, t.value);
      markValidity(t);
      refreshComputed();
      changed();
    });

    body.addEventListener("keydown", function (e) {
      if (e.key !== "Enter" || !e.target.matches("input.num")) return;
      e.preventDefault();
      var inputs = Array.prototype.slice.call(body.querySelectorAll("input.num"));
      var pos = inputs.indexOf(e.target);
      // V → same row I; I → next row I
      var next = e.target.dataset.f === "v" ? inputs[pos + 1] : inputs[pos + 2];
      if (next) { next.focus(); next.select(); } else e.target.blur();
    });

    body.addEventListener("click", function (e) {
      var b = e.target.closest(".del-btn");
      if (!b) return;
      var k = rowIndexOf(b);
      if (k < 0) return;
      lastDeleted = { row: state.rows[k], index: k };
      state.rows = C.deleteRow(state.rows, k);
      renderTable(); refreshComputed(); changed();
      toast((k + 1) + ". sor törölve.", "Visszavonás", function () {
        if (!lastDeleted) return;
        state.rows = C.addRow(state.rows, lastDeleted.index, lastDeleted.row);
        lastDeleted = null;
        renderTable(); refreshComputed(); changed();
      });
    });

    $("addRowBtn").addEventListener("click", function () {
      state.rows = C.addRow(state.rows);
      renderTable(); refreshComputed(); changed();
      var inputs = body.querySelectorAll('input[data-f="v"]');
      var last = inputs[inputs.length - 1];
      if (last) { last.focus(); last.scrollIntoView({ block: "center", behavior: "smooth" }); }
    });

    $("sortBtn").addEventListener("click", function () {
      state.rows = C.sortRowsByVolume(state.rows);
      renderTable(); refreshComputed(); changed();
    });

    $("derivToggle").addEventListener("change", function () {
      state.showDeriv = this.checked;
      plot.setData({ showDeriv: state.showDeriv });
      onCursor(plot.getCursorInfo());
      changed(true);
    });
    $("resetZoomBtn").addEventListener("click", function () { plot.resetZoom(); });

    $("ep1Btn").addEventListener("click", function () { startSelect(1); });
    $("ep2Btn").addEventListener("click", function () { startSelect(2); });
    $("epSaveBtn").addEventListener("click", saveEp);
    $("epCancelBtn").addEventListener("click", endSelect);
    $("ep1Del").addEventListener("click", function () { deleteEp(1); });
    $("ep2Del").addEventListener("click", function () { deleteEp(2); });
    $("submitBtn").addEventListener("click", submit);

    $("switchUserBtn").addEventListener("click", function () {
      if (saver.isDirty()) {
        window.alert("Még nem mentődött el minden a szerverre. Várd meg, amíg a felső sarokban a zöld „Mentve óó:pp” felirat megjelenik.");
        return;
      }
      if (!window.confirm("Új tanuló kezd ezen a telefonon? A(z) " + state.name +
        " nevű tanuló adatai a szerveren megmaradnak, de erről a telefonról többé nem szerkeszthetők.")) return;
      lsDel(LS_STATE);
      location.reload();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
