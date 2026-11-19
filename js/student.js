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
  var lastDeleted = null;
  var lastStatus = null;      // last save status ("saving", "error", …) – shown on the submit card while submitting
  var view = { deriv: false, ep1: true, ep2: true }; // plot toggles; every page open starts like this
  var resultTimer = 0;
  var RESULT_POLL_MS = CFG.RESULT_POLL_MS || 30000; // light polling until the teacher enters the true value

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
      ep1: null,
      ep2: null,
      submitted: false,          // the student confirmed "Beküldés" (final: editing is locked from here on)
      submittedAt: null,
      changedAfterSubmit: false, // always false now (kept for the server's log layout)
      submitConfirmed: false,    // the server confirmed the submitted version → results screen
      result: null,              // {relErr, at} last result received from the server
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
    if (state.submitted) return; // submitting is final: nothing is saved after it
    state.updatedAt = new Date().toISOString();
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
        // the server has the submitted version → it is final: results screen
        if (payload.state.submitted && state.submitted && !state.submitConfirmed) {
          state.submitConfirmed = true;
          state.submitConfirmedAt = new Date().toISOString();
          persistLocal();
          showResults();
          return;
        }
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
    $("derivToggle").checked = view.deriv;
    $("ep1Toggle").checked = view.ep1;
    $("ep2Toggle").checked = view.ep2;

    plot = new window.LabPlot($("plot"), {
      onCursor: onCursor,
      onView: function (zoomed) { $("resetZoomBtn").hidden = !zoomed; }
    });
    bindUi();
    renderTable();
    refreshComputed();
    renderEps();
    if (state.submitConfirmed) { showResults(); return; } // final: results screen, nothing more to save
    if (state.submitted) { lockEditing(); saver.saveNow(); renderSubmitState(); return; } // still sending
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
    lastStatus = { s: s, info: info || null };
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
    if (state && state.submitted && !state.submitConfirmed) renderSubmitState();
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
    plot.setData({ series: series, showDeriv: view.deriv, showEp1: view.ep1, showEp2: view.ep2, ep1: state.ep1, ep2: state.ep2 });
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
      var html = '<span class="ro-v">V<sub>valós</sub> = <b>' + C.formatNum(info.x, 2) + "</b> cm³</span>";
      if (info.on === "deriv") {
        html += '<span class="ro-d">Meredekség = <b>' + (info.d === null ? "–" : C.formatDeriv(info.d)) + "</b></span>";
      } else {
        html += '<span class="ro-i">Ĩ = <b>' + (info.i === null ? "–" : C.formatNum(info.i, 3)) + "</b> mA</span>";
      }
      el.innerHTML = html;
    }
    $("epSaveBtn").disabled = !info;
  }

  /* ---------------------------------------------------- equivalence points */

  function startSelect(n) {
    if (state.submitted) return;
    selecting = n;
    // full diagram + Meredekség on, so the red marker reads Meredekség values as the instruction says
    plot.resetZoom();
    if (!view.deriv) {
      view.deriv = true;
      $("derivToggle").checked = true;
      plot.setData({ showDeriv: true });
    }
    $("epButtons").hidden = true;
    $("epSelect").hidden = false;
    $("epSelect").className = "ep-select ep" + n;
    $("epSelectText").innerHTML = n === 1
      ? "<b>1. ekvivalenciapont kijelölése.</b> Érintsd meg a grafikont és a piros jelölőt az ujjaddal húzva keresd meg, ahol a <b>Meredekség = 0</b>, majd nyomd meg a Mentés gombot."
      : "<b>2. ekvivalenciapont kijelölése.</b> Érintsd meg a grafikont és a piros jelölőt az ujjaddal húzva keresd meg a <b>Meredekség maximumát</b>, majd nyomd meg a Mentés gombot.";
    $("epSelectShort").textContent = n === 1 ? "1. EP (Meredekség = 0):" : "2. EP (Meredekség max.):";
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
    changed(false, true); // immediate server save, bypassing the debounce / min interval
    toast(n + ". ekvivalenciapont elmentve.");
    if (n === 1 && !state.ep2) $("ep2Btn").classList.add("pulse");
  }

  function deleteEp(n) {
    if (state.submitted) return;
    if (!window.confirm("Biztosan törlöd a(z) " + n + ". ekvivalenciapontot?")) return;
    state["ep" + n] = null;
    plot.setData({ ep1: state.ep1, ep2: state.ep2 });
    renderEps();
    changed(false, true); // immediate server save, bypassing the debounce / min interval
  }

  function epText(ep) {
    if (!ep) return "még nincs kijelölve";
    return '<span class="nowrap">V<sub>valós</sub> = <b>' + C.formatNum(ep.v, 2) + '</b> cm³</span> &nbsp; <span class="nowrap">Meredekség = <b>' +
      (ep.d === null || ep.d === undefined ? "–" : C.formatDeriv(ep.d)) + "</b></span>";
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
    if (state && !state.submitted) renderSubmitState(); // "Beküldés" needs both equivalence points
  }

  /* ------------------------------------------------------------- submit */

  function renderSubmitState() {
    var el = $("submitState");
    var ready = !!(state.ep1 && state.ep2);
    $("retryBtn").hidden = true;
    if (!state.submitted) {
      $("submitBtn").hidden = false;
      $("submitBtn").disabled = !ready;
      el.className = "submit-state" + (ready ? "" : " muted");
      el.textContent = ready ? "Még nem küldted be." : "A beküldéshez előbb mentsd el mindkét ekvivalenciapontot.";
      return;
    }
    // submitted, waiting for the server's confirmation (then the results screen replaces this card)
    $("submitBtn").hidden = true;
    $("submitNote").hidden = true;
    var failed = lastStatus && lastStatus.s === "error";
    if (failed) {
      var why = lastStatus.info && lastStatus.info.offline ? "nincs internetkapcsolat"
        : lastStatus.info && lastStatus.info.code === "storage" ? "a telefon tárhelye megtelt" : "szerverhiba";
      el.className = "submit-state warn";
      el.textContent = "Nem sikerült beküldeni (" + why + "). Semmi sem veszett el: az adataid a telefonon vannak, " +
        "és az alkalmazás automatikusan újrapróbálja. Most is újrapróbálhatod:";
      $("retryBtn").hidden = false;
    } else {
      el.className = "submit-state pending";
      el.textContent = "Beküldés folyamatban…";
    }
  }

  function submit() {
    if (state.submitted || !state.ep1 || !state.ep2) return;
    if (selecting) endSelect();
    openConfirm();
  }

  function openConfirm() {
    $("confirmDlg").hidden = false;
    $("confirmOk").focus();
  }
  function closeConfirm() { $("confirmDlg").hidden = true; }

  /** The student confirmed: from here on the work is final. */
  function doSubmit() {
    closeConfirm();
    if (state.submitted || !state.ep1 || !state.ep2) return;
    state.submitted = true;
    state.submittedAt = new Date().toISOString();
    state.changedAfterSubmit = false;
    state.updatedAt = state.submittedAt;
    persistLocal();
    lockEditing();
    saver.saveNow();
    renderSubmitState();
  }

  /** After submitting: the table, the EP buttons and the submit button can no longer change anything. */
  function lockEditing() {
    if (selecting) endSelect();
    document.body.classList.add("locked");
    Array.prototype.forEach.call($("dataBody").querySelectorAll("input"), function (i) { i.readOnly = true; });
    ["addRowBtn", "sortBtn", "ep1Btn", "ep2Btn", "ep1Del", "ep2Del", "submitBtn"].forEach(function (id) { $(id).disabled = true; });
    Array.prototype.forEach.call($("dataBody").querySelectorAll(".del-btn"), function (b) { b.disabled = true; });
  }

  /* ----------------------------------------------------------- results */

  function showResults() {
    saver.stop(); // final: no more autosaves
    if (selecting) endSelect();
    closeConfirm();
    hideToast();
    ["dataCard", "plotCard", "submitCard"].forEach(function (id) { $(id).hidden = true; });
    $("resultCard").hidden = false;
    renderResult();
    window.scrollTo(0, 0);
    fetchResult();
  }

  function renderResult() {
    var r = state.result;
    $("resultText").textContent = r && typeof r.relErr === "number"
      ? "Az általad meghatározott ekvivalenciapont " + C.formatNum(r.relErr, 1) + "%-kal tér el a valós értéktől."
      : "Sikeres beküldés. Az eredményed hamarosan megjelenik ezen az oldalon.";
    $("resultCard").classList.toggle("waiting", !(r && typeof r.relErr === "number"));
  }

  /** Asks the server for the relative error; until the teacher enters the true value, again every 30 s. */
  function fetchResult() {
    clearTimeout(resultTimer);
    API.call({ action: "result", key: state.key }).then(function (res) {
      if (res.ready && typeof res.relErr === "number") {
        state.result = { relErr: res.relErr, at: new Date().toISOString() };
        persistLocal();
        renderResult();
      } else {
        resultTimer = setTimeout(fetchResult, RESULT_POLL_MS);
      }
    }, function () {
      resultTimer = setTimeout(fetchResult, RESULT_POLL_MS);
    });
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
      if (!t.matches("input.num") || state.submitted) return;
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
      if (!b || state.submitted) return;
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

    // view toggles: only change what is drawn (not saved, every page open starts with the defaults)
    $("derivToggle").addEventListener("change", function () {
      view.deriv = this.checked;
      plot.setData({ showDeriv: view.deriv });
      onCursor(plot.getCursorInfo());
    });
    $("ep1Toggle").addEventListener("change", function () { view.ep1 = this.checked; plot.setData({ showEp1: view.ep1 }); });
    $("ep2Toggle").addEventListener("change", function () { view.ep2 = this.checked; plot.setData({ showEp2: view.ep2 }); });
    $("resetZoomBtn").addEventListener("click", function () { plot.resetZoom(); });

    $("ep1Btn").addEventListener("click", function () { startSelect(1); });
    $("ep2Btn").addEventListener("click", function () { startSelect(2); });
    $("epSaveBtn").addEventListener("click", saveEp);
    $("epCancelBtn").addEventListener("click", endSelect);
    $("ep1Del").addEventListener("click", function () { deleteEp(1); });
    $("ep2Del").addEventListener("click", function () { deleteEp(2); });
    $("submitBtn").addEventListener("click", submit);
    $("retryBtn").addEventListener("click", function () { saver.saveNow(); });
    $("confirmOk").addEventListener("click", doSubmit);
    $("confirmCancel").addEventListener("click", closeConfirm);
    $("confirmDlg").addEventListener("click", function (e) { if (e.target === this) closeConfirm(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !$("confirmDlg").hidden) closeConfirm(); });

    $("switchUserBtn").addEventListener("click", function () {
      if (!state.submitConfirmed && saver.isDirty()) {
        window.alert("Még nem mentődött el minden a szerverre. Várd meg, amíg a felső sarokban a zöld „Mentve óó:pp” felirat megjelenik.");
        return;
      }
      if (!window.confirm("Új tanuló kezd ezen a telefonon? A(z) " + state.name +
        " nevű tanuló adatai a szerveren megmaradnak, de erről a telefonról többé nem szerkeszthetők.")) return;
      clearTimeout(resultTimer);
      lsDel(LS_STATE);
      location.reload();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
