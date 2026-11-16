/* Teacher page controller: password login, student list, read-only detail view, CSV export. */
(function () {
  "use strict";
  var C = window.LabCore, API = window.LabApi, CFG = window.LAB_CONFIG || {};
  var SS_PW = "oxalsav_teacher_pw";
  var $ = function (id) { return document.getElementById(id); };

  var password = null;
  var students = [];
  var sort = { key: "name", dir: 1 };
  var autoTimer = 0;
  var plot = null;
  var detailState = null;

  function ssGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  function ssDel(k) { try { sessionStorage.removeItem(k); } catch (e) { /* ignore */ } }

  function esc(s) {
    return String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function fmtTime(iso) {
    if (!iso) return "–";
    var d = new Date(iso);
    if (isNaN(d)) return "–";
    var now = new Date();
    var hm = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    if (d.toDateString() === now.toDateString()) return hm;
    return d.getFullYear() + ". " + String(d.getMonth() + 1).padStart(2, "0") + ". " + String(d.getDate()).padStart(2, "0") + ". " + hm;
  }

  function errorText(err) {
    var c = err && err.code;
    if (c === "auth") return "Hibás jelszó.";
    if (c === "not_configured") return "A szerveren nincs beállítva a TEACHER_PASSWORD (lásd README).";
    if (c === "network" || c === "timeout") return "Nem érhető el a szerver. Ellenőrizd az internetkapcsolatot.";
    return "Hiba történt (" + (c || "ismeretlen") + ").";
  }

  function setStatus(cls, text) {
    var el = $("loadStatus");
    el.className = "save-status " + cls;
    el.textContent = text;
  }

  /* ------------------------------------------------------------- login */

  function init() {
    if (API.isMock) { $("mockNote").hidden = false; $("mockNoteLogin").hidden = false; }
    if (CFG.TITLE) { $("loginSub").textContent = CFG.TITLE; $("topSub").textContent = CFG.TITLE; }
    $("loginForm").addEventListener("submit", function (e) {
      e.preventDefault();
      tryLogin($("pwInput").value);
    });
    var saved = ssGet(SS_PW);
    if (saved) tryLogin(saved, true);
    else showLogin();
  }

  function showLogin(msg) {
    $("app").hidden = true;
    $("loginScreen").hidden = false;
    $("loginError").hidden = !msg;
    $("loginError").textContent = msg || "";
    setTimeout(function () { $("pwInput").focus(); }, 50);
  }

  function tryLogin(pw, silent) {
    $("loginBtn").disabled = true;
    API.call({ action: "list", password: pw }).then(function (res) {
      $("loginBtn").disabled = false;
      password = pw;
      ssSet(SS_PW, pw);
      $("loginScreen").hidden = true;
      $("app").hidden = false;
      bindApp();
      gotList(res);
    }, function (err) {
      $("loginBtn").disabled = false;
      if (err.code === "auth") ssDel(SS_PW);
      showLogin(silent && err.code === "auth" ? "" : errorText(err));
    });
  }

  /* -------------------------------------------------------------- list */

  var bound = false;
  function bindApp() {
    if (bound) return;
    bound = true;
    $("refreshBtn").addEventListener("click", refresh);
    $("searchInput").addEventListener("input", renderList);
    $("autoRefresh").addEventListener("change", function () {
      clearInterval(autoTimer);
      if (this.checked) autoTimer = setInterval(function () { if ($("detailView").hidden) refresh(); }, 30000);
    });
    $("logoutBtn").addEventListener("click", function () { ssDel(SS_PW); location.reload(); });
    $("csvSummaryBtn").addEventListener("click", exportSummary);
    $("csvAllBtn").addEventListener("click", exportAll);
    Array.prototype.forEach.call(document.querySelectorAll("#listTable th[data-sort]"), function (th) {
      th.addEventListener("click", function () {
        var k = th.dataset.sort;
        sort = { key: k, dir: sort.key === k ? -sort.dir : (k === "savedAt" ? -1 : 1) };
        renderList();
      });
    });
    $("listBody").addEventListener("click", function (e) {
      var tr = e.target.closest("tr[data-key]");
      if (tr) openDetail(tr.dataset.key);
    });
    $("backBtn").addEventListener("click", closeDetail);
    $("dDerivToggle").addEventListener("change", function () {
      if (plot) { plot.setData({ showDeriv: this.checked }); onCursor(plot.getCursorInfo()); }
    });
    $("dResetZoom").addEventListener("click", function () { if (plot) plot.resetZoom(); });
    window.addEventListener("popstate", function () { if (!$("detailView").hidden) closeDetail(true); });
  }

  function refresh() {
    setStatus("saving", "Betöltés…");
    API.call({ action: "list", password: password }).then(gotList, function (err) {
      setStatus("error", "Hiba");
      if (err.code === "auth") { ssDel(SS_PW); showLogin(errorText(err)); }
      else window.alert(errorText(err));
    });
  }

  function gotList(res) {
    students = res.students || [];
    setStatus("saved", "Frissítve " + fmtTime(new Date().toISOString()));
    renderList();
  }

  function sortValue(s, k) {
    if (k === "name") return (s.name || "").toLocaleLowerCase("hu");
    if (k === "savedAt") return s.savedAt ? new Date(s.savedAt).getTime() : 0;
    if (k === "submitted") return s.submitted ? (s.changedAfterSubmit ? 1 : 2) : 0;
    var v = s[k];
    return typeof v === "number" ? v : -Infinity;
  }

  function renderList() {
    var q = $("searchInput").value.trim().toLocaleLowerCase("hu");
    var list = students.filter(function (s) { return !q || (s.name || "").toLocaleLowerCase("hu").indexOf(q) >= 0; });
    list.sort(function (a, b) {
      var x = sortValue(a, sort.key), y = sortValue(b, sort.key);
      if (typeof x === "string") return sort.dir * x.localeCompare(y, "hu");
      return sort.dir * (x - y) || (a.name || "").localeCompare(b.name || "", "hu");
    });
    Array.prototype.forEach.call(document.querySelectorAll("#listTable th[data-sort]"), function (th) {
      th.querySelector(".arrow").textContent = th.dataset.sort === sort.key ? (sort.dir > 0 ? "▲" : "▼") : "";
    });
    // names that occur on several devices get the device id shown
    var nameCount = {};
    students.forEach(function (s) { nameCount[s.name] = (nameCount[s.name] || 0) + 1; });

    $("listBody").innerHTML = list.map(function (s) {
      var sub = s.submitted
        ? (s.changedAfterSubmit ? '<span class="tag mod" title="Beküldés után módosította">igen*</span>' : '<span class="tag yes">igen</span>')
        : '<span class="tag no">nem</span>';
      return '<tr data-key="' + esc(s.key) + '">' +
        "<td>" + esc(s.name) + (nameCount[s.name] > 1 ? ' <span class="dev">(' + esc(s.deviceId) + ")</span>" : "") + "</td>" +
        '<td class="num">' + fmtTime(s.savedAt) + "</td>" +
        "<td>" + sub + "</td>" +
        '<td class="num">' + (typeof s.ep1v === "number" ? C.formatNum(s.ep1v, 2) : "–") + "</td>" +
        '<td class="num">' + (typeof s.ep2v === "number" ? C.formatNum(s.ep2v, 2) : "–") + "</td>" +
        '<td class="num">' + (s.points === undefined || s.points === "" ? "–" : esc(s.points)) + "</td>" +
        "</tr>";
    }).join("");
    var nSub = students.filter(function (s) { return s.submitted; }).length;
    $("stats").textContent = "Tanulók: " + students.length + " · beküldte: " + nSub +
      (q ? " · szűrve: " + list.length : "") + "   (* = beküldés után módosított)";
    $("emptyNote").hidden = students.length > 0;
  }

  /* ------------------------------------------------------------ detail */

  function openDetail(key) {
    setStatus("saving", "Betöltés…");
    API.call({ action: "get", password: password, key: key }).then(function (res) {
      setStatus("saved", "Betöltve");
      showDetail(res.student);
      try { history.pushState({ detail: key }, ""); } catch (e) { /* ignore */ }
    }, function (err) {
      setStatus("error", "Hiba");
      window.alert(errorText(err));
    });
  }

  function showDetail(stu) {
    var st = stu.state || {};
    detailState = st;
    $("listView").hidden = true;
    $("detailView").hidden = false;
    window.scrollTo(0, 0);
    $("dName").textContent = stu.name || st.name || "";
    $("dSubmitted").innerHTML = stu.submitted
      ? (stu.changedAfterSubmit ? '<span class="tag mod">beküldve, utána módosítva</span>' : '<span class="tag yes">beküldve</span>')
      : '<span class="tag no">nincs beküldve</span>';
    $("dMeta").innerHTML =
      "<span>Utolsó mentés: <b>" + fmtTime(stu.savedAt) + "</b></span>" +
      (stu.submittedAt ? "<span>Beküldés: <b>" + fmtTime(stu.submittedAt) + "</b></span>" : "") +
      "<span>Eszköz: " + esc(stu.deviceId || st.deviceId) + "</span>";

    var rows = Array.isArray(st.rows) ? st.rows : [];
    var d = C.derivativeColumn(rows);
    $("dBody").innerHTML = rows.map(function (r, k) {
      return "<tr><td class=\"col-n\">" + (k + 1) + "</td>" +
        '<td class="ro">' + esc(r.v) + "</td>" +
        '<td class="ro">' + esc(r.i) + "</td>" +
        '<td class="col-d ro">' + (d[k] === null ? "" : C.formatDeriv(d[k])) + "</td></tr>";
    }).join("") || '<tr><td colspan="4" class="muted">Nincs adat.</td></tr>';

    $("dEp1").innerHTML = epText(st.ep1);
    $("dEp2").innerHTML = epText(st.ep2);
    $("dDerivToggle").checked = st.showDeriv !== false;

    if (!plot) {
      plot = new window.LabPlot($("dPlot"), {
        onCursor: onCursor,
        onView: function (z) { $("dResetZoom").hidden = !z; }
      });
    }
    plot.setCursor(null, false);
    plot.win = { x0: 0, x1: 1, y0: 0, y1: 1 };
    plot._resize();
    plot.setData({ series: C.buildSeries(rows), showDeriv: st.showDeriv !== false, ep1: st.ep1 || null, ep2: st.ep2 || null });
    $("dResetZoom").hidden = true;
    onCursor(null);
  }

  function epText(ep) {
    if (!ep || typeof ep.v !== "number") return '<span class="muted"><i>nincs kijelölve</i></span>';
    return '<span class="nowrap">V = <b>' + C.formatNum(ep.v, 2) + '</b> cm³</span> &nbsp; <span class="nowrap">dĨ/dV = <b>' +
      (typeof ep.d === "number" ? C.formatDeriv(ep.d) : "–") + '</b> mA/cm³</span> &nbsp; <span class="nowrap">Ĩ = ' +
      (typeof ep.i === "number" ? C.formatNum(ep.i, 3) : "–") + " mA</span>";
  }

  function onCursor(info) {
    var el = $("dReadout");
    if (!info) { el.textContent = "Kattints / érintsd meg a grafikont az értékek leolvasásához."; return; }
    var html = '<span class="ro-v">V = <b>' + C.formatNum(info.x, 2) + "</b> cm³</span>";
    if (info.on === "deriv") html += '<span class="ro-d">dĨ/dV = <b>' + (info.d === null ? "–" : C.formatDeriv(info.d)) + "</b> mA/cm³</span>";
    else html += '<span class="ro-i">Ĩ = <b>' + (info.i === null ? "–" : C.formatNum(info.i, 3)) + "</b> mA</span>";
    el.innerHTML = html;
  }

  function closeDetail(fromPop) {
    $("detailView").hidden = true;
    $("listView").hidden = false;
    detailState = null;
    if (fromPop !== true) { try { history.back(); } catch (e) { /* ignore */ } }
  }

  /* --------------------------------------------------------------- CSV */

  function csvCell(v) {
    var s = v === null || v === undefined ? "" : String(v);
    return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function csvNum(x, dec) { return typeof x === "number" && isFinite(x) ? C.formatNum(x, dec, { asciiMinus: true }) : ""; }
  function csvDeriv(x) { return typeof x === "number" && isFinite(x) ? C.formatNum(x, 6, { asciiMinus: true }) : ""; }
  function csvTime(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d)) return "";
    var p = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }

  function download(name, lines) {
    // BOM + semicolons + decimal comma → opens correctly in Hungarian Excel
    var blob = new Blob(["﻿" + lines.map(function (r) { return r.map(csvCell).join(";"); }).join("\r\n")], { type: "text/csv;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function stamp() {
    var d = new Date(), p = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "_" + p(d.getHours()) + p(d.getMinutes());
  }

  function exportSummary() {
    var lines = [["Név", "Eszköz", "Utolsó mentés", "Beküldve", "Beküldés ideje", "Beküldés után módosítva",
      "1. EP V (cm3)", "1. EP dĨ/dV / (mA/cm³)", "2. EP V (cm3)", "2. EP dĨ/dV / (mA/cm³)", "Mérési pontok"]];
    students.slice().sort(function (a, b) { return (a.name || "").localeCompare(b.name || "", "hu"); }).forEach(function (s) {
      lines.push([s.name, s.deviceId, csvTime(s.savedAt), s.submitted ? "igen" : "nem", csvTime(s.submittedAt),
        s.changedAfterSubmit ? "igen" : "nem", csvNum(s.ep1v, 2), csvDeriv(s.ep1d), csvNum(s.ep2v, 2), csvDeriv(s.ep2d), s.points]);
    });
    download("oxalsav_osszesito_" + stamp() + ".csv", lines);
  }

  function exportAll() {
    setStatus("saving", "Letöltés…");
    API.call({ action: "all", password: password }).then(function (res) {
      setStatus("saved", "Kész");
      var lines = [["Név", "Eszköz", "Sor", "V(NaOH) (cm3)", "Ĩ / mA", "dĨ/dV / (mA/cm³)"]];
      (res.students || []).sort(function (a, b) { return (a.name || "").localeCompare(b.name || "", "hu"); }).forEach(function (s) {
        var rows = (s.state && Array.isArray(s.state.rows)) ? s.state.rows : [];
        var d = C.derivativeColumn(rows);
        rows.forEach(function (r, k) {
          var v = C.parseNum(r.v), i = C.parseNum(r.i);
          lines.push([s.name, s.deviceId, k + 1,
            typeof v === "number" && isFinite(v) ? csvNum(v, 3) : r.v,
            typeof i === "number" && isFinite(i) ? csvNum(i, 4) : r.i,
            csvDeriv(d[k])]);
        });
      });
      download("oxalsav_meresi_adatok_" + stamp() + ".csv", lines);
    }, function (err) { setStatus("error", "Hiba"); window.alert(errorText(err)); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
