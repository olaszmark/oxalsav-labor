/* Canvas plot: current (left, blue, scatter) + derivative (right, orange, line+points),
 * snapping cursor (one finger / mouse), pinch zoom + pan (two fingers), wheel zoom (desktop).
 * Depends on LabCore (core.js). */
(function () {
  "use strict";
  var C = window.LabCore;

  var COLORS = {
    current: "#1565c0",
    deriv: "#ef6c00",
    cursor: "#d50000",
    ep1: "#2e7d32",
    ep2: "#7b1fa2",
    grid: "#e3e7ee",
    axis: "#455a64",
    text: "#37474f",
    bg: "#ffffff"
  };
  var MIN_WIN = 0.02;       // max zoom: 1/50 of the home range
  var PINCH_AXIS_PX = 40;   // finger spread along an axis needed to zoom that axis
  var RESTORE_MS = 350;     // 2nd finger within this time → cursor goes back to where it was

  function LabPlot(canvas, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.opts = opts || {};
    this.series = { current: [], deriv: [] };
    this.showDeriv = true;
    this.eps = { ep1: null, ep2: null };
    this.cursorX = null;
    this.win = { x0: 0, x1: 1, y0: 0, y1: 1 }; // visible fraction of the home ranges
    this.home = C.autoRanges(this.series);
    this.pointers = new Map();
    this.gesture = null;
    this.layout = null;
    this._raf = 0;
    canvas.__labPlot = this; // handle for automated UI tests
    this._bind();
    this._resize();
  }

  /* ----------------------------------------------------------- public API */

  LabPlot.prototype.setData = function (d) {
    if (d.series) { this.series = d.series; this.home = C.autoRanges(d.series); }
    if (d.showDeriv !== undefined) this.showDeriv = !!d.showDeriv;
    if (d.ep1 !== undefined) this.eps.ep1 = d.ep1;
    if (d.ep2 !== undefined) this.eps.ep2 = d.ep2;
    if (this.cursorX !== null) this._snapCursor(this.cursorX, false);
    this.render();
  };

  LabPlot.prototype.resetZoom = function () {
    this.win = { x0: 0, x1: 1, y0: 0, y1: 1 };
    this.render();
    this._emitView();
  };

  LabPlot.prototype.isZoomed = function () {
    var w = this.win;
    return w.x0 > 1e-6 || w.x1 < 1 - 1e-6 || w.y0 > 1e-6 || w.y1 < 1 - 1e-6;
  };

  /** Set the cursor to a volume (data units), snapping to the active curve. */
  LabPlot.prototype.setCursor = function (x, emit) {
    if (x === null || x === undefined) { this.cursorX = null; this.render(); if (emit !== false) this._emitCursor(); return; }
    this._snapCursor(x, emit !== false);
    this.render();
  };

  /** Current cursor info: {x, d, i, on} or null. */
  LabPlot.prototype.getCursorInfo = function () {
    if (this.cursorX === null) return null;
    var x = this.cursorX;
    return {
      x: x,
      d: valueInRange(this.series.deriv, x),
      i: valueInRange(this.series.current, x),
      on: this._activeCurveName()
    };
  };

  /* ---------------------------------------------------------- internals */

  function valueInRange(series, x) {
    if (!series.length || x < series[0].x - 1e-9 || x > series[series.length - 1].x + 1e-9) return null;
    var p = C.interpolate(series, x);
    return p ? p.y : null;
  }

  LabPlot.prototype._activeCurveName = function () {
    return this.showDeriv && this.series.deriv.length > 0 ? "deriv" : "current";
  };
  LabPlot.prototype._activeCurve = function () {
    return this._activeCurveName() === "deriv" ? this.series.deriv : this.series.current;
  };

  LabPlot.prototype._snapCursor = function (x, emit) {
    var p = C.interpolate(this._activeCurve(), x);
    this.cursorX = p ? p.x : null;
    if (emit) this._emitCursor();
  };

  LabPlot.prototype._emitCursor = function () {
    if (this.opts.onCursor) this.opts.onCursor(this.getCursorInfo());
  };
  LabPlot.prototype._emitView = function () {
    if (this.opts.onView) this.opts.onView(this.isZoomed());
  };

  /** Visible data ranges for the current zoom window. */
  LabPlot.prototype._view = function () {
    var h = this.home, w = this.win;
    function sub(r, a, b) { var s = r.max - r.min; return { min: r.min + a * s, max: r.min + b * s }; }
    return { x: sub(h.x, w.x0, w.x1), yL: sub(h.yL, w.y0, w.y1), yR: sub(h.yR, w.y0, w.y1) };
  };

  LabPlot.prototype._resize = function () {
    var dpr = Math.min(window.devicePixelRatio || 1, 3);
    var r = this.canvas.getBoundingClientRect();
    var w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    this.cssW = w; this.cssH = h; this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.render(true);
  };

  LabPlot.prototype.render = function (now) {
    var self = this;
    if (now === true) { cancelAnimationFrame(this._raf); this._raf = 0; this._draw(); return; }
    if (this._raf) return;
    this._raf = requestAnimationFrame(function () { self._raf = 0; self._draw(); });
  };

  LabPlot.prototype._computeLayout = function () {
    var showR = this.showDeriv;
    var compact = this.cssW < 360;
    var L = { left: compact ? 40 : 46, right: showR ? (compact ? 48 : 56) : 14, top: 30, bottom: 38 };
    L.w = Math.max(10, this.cssW - L.left - L.right);
    L.h = Math.max(10, this.cssH - L.top - L.bottom);
    this.layout = L;
    return L;
  };

  function tickDecimals(step) {
    return Math.min(6, Math.max(0, -Math.floor(Math.log10(step) + 1e-9)));
  }

  LabPlot.prototype._draw = function () {
    var ctx = this.ctx, dpr = this.dpr;
    var L = this._computeLayout();
    var V = this._view();
    var showD = this.showDeriv;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, this.cssW, this.cssH);

    var X = function (x) { return L.left + (x - V.x.min) / (V.x.max - V.x.min) * L.w; };
    var YL = function (y) { return L.top + L.h - (y - V.yL.min) / (V.yL.max - V.yL.min) * L.h; };
    var YR = function (y) { return L.top + L.h - (y - V.yR.min) / (V.yR.max - V.yR.min) * L.h; };
    this._X = X; this._YL = YL; this._YR = YR;

    var fontSize = this.cssW < 360 ? 10 : 11;
    ctx.font = fontSize + "px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
    ctx.textBaseline = "middle";

    // grid + x ticks
    var tx = C.ticks(V.x.min, V.x.max, Math.max(3, Math.floor(L.w / 55)));
    var txd = tickDecimals(tx.step);
    ctx.strokeStyle = COLORS.grid; ctx.lineWidth = 1;
    ctx.fillStyle = COLORS.text; ctx.textAlign = "center";
    tx.values.forEach(function (t) {
      var px = Math.round(X(t)) + 0.5;
      ctx.beginPath(); ctx.moveTo(px, L.top); ctx.lineTo(px, L.top + L.h); ctx.stroke();
      ctx.fillText(C.formatNum(t, txd), px, L.top + L.h + 11);
    });
    // left y ticks (blue)
    var tyl = C.ticks(V.yL.min, V.yL.max, Math.max(4, Math.floor(L.h / 32)));
    var tyld = tickDecimals(tyl.step);
    ctx.textAlign = "right"; ctx.fillStyle = COLORS.current;
    tyl.values.forEach(function (t) {
      var py = Math.round(YL(t)) + 0.5;
      ctx.strokeStyle = COLORS.grid;
      ctx.beginPath(); ctx.moveTo(L.left, py); ctx.lineTo(L.left + L.w, py); ctx.stroke();
      ctx.fillText(C.formatNum(t, tyld), L.left - 5, py);
    });
    // right y ticks (orange)
    if (showD) {
      var tyr = C.ticks(V.yR.min, V.yR.max, Math.max(4, Math.floor(L.h / 32)));
      var tyrd = tickDecimals(tyr.step);
      ctx.textAlign = "left"; ctx.fillStyle = COLORS.deriv; ctx.strokeStyle = COLORS.deriv;
      tyr.values.forEach(function (t) {
        var py = Math.round(YR(t)) + 0.5;
        ctx.beginPath(); ctx.moveTo(L.left + L.w, py); ctx.lineTo(L.left + L.w + 4, py); ctx.stroke();
        ctx.fillText(C.formatNum(t, tyrd), L.left + L.w + 6, py);
      });
    }

    // axes frame
    ctx.strokeStyle = COLORS.axis; ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(L.left, L.top); ctx.lineTo(L.left, L.top + L.h); ctx.lineTo(L.left + L.w, L.top + L.h);
    ctx.stroke();
    ctx.strokeStyle = COLORS.current; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(L.left, L.top); ctx.lineTo(L.left, L.top + L.h); ctx.stroke();
    if (showD) {
      ctx.strokeStyle = COLORS.deriv;
      ctx.beginPath(); ctx.moveTo(L.left + L.w, L.top); ctx.lineTo(L.left + L.w, L.top + L.h); ctx.stroke();
    }

    // axis titles
    ctx.font = "600 " + (fontSize + 1) + "px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = COLORS.current; ctx.textAlign = "left";
    ctx.fillText("Ĩ / mA", 4, 16);
    if (showD) {
      ctx.fillStyle = COLORS.deriv; ctx.textAlign = "right";
      ctx.fillText("dĨ/dV / (mA/cm³)", this.cssW - 4, 16);
    }
    ctx.fillStyle = COLORS.text; ctx.textAlign = "center";
    ctx.fillText("V(NaOH) / cm³", L.left + L.w / 2, this.cssH - 5);
    ctx.font = fontSize + "px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";

    // ---- data (clipped to the plot area)
    ctx.save();
    ctx.beginPath(); ctx.rect(L.left - 1, L.top - 1, L.w + 2, L.h + 2); ctx.clip();

    if (showD) {
      // zero line, dashed orange
      if (V.yR.min <= 0 && V.yR.max >= 0) {
        var y0 = Math.round(YR(0)) + 0.5;
        ctx.setLineDash([6, 5]); ctx.strokeStyle = COLORS.deriv; ctx.lineWidth = 1.3;
        ctx.beginPath(); ctx.moveTo(L.left, y0); ctx.lineTo(L.left + L.w, y0); ctx.stroke();
        ctx.setLineDash([]);
      }
      var der = this.series.deriv;
      if (der.length > 1) {
        ctx.strokeStyle = COLORS.deriv; ctx.lineWidth = 1.8;
        ctx.beginPath();
        der.forEach(function (p, k) { if (k === 0) ctx.moveTo(X(p.x), YR(p.y)); else ctx.lineTo(X(p.x), YR(p.y)); });
        ctx.stroke();
      }
      ctx.fillStyle = COLORS.deriv;
      der.forEach(function (p) { dot(ctx, X(p.x), YR(p.y), 3.2); });
    }

    ctx.fillStyle = COLORS.current; ctx.strokeStyle = "#fff"; ctx.lineWidth = 1;
    this.series.current.forEach(function (p) { dot(ctx, X(p.x), YL(p.y), 3.8, true); });

    // saved equivalence points
    this._drawEp(this.eps.ep1, "1. EP", COLORS.ep1, "diamond");
    this._drawEp(this.eps.ep2, "2. EP", COLORS.ep2, "triangle");

    // cursor
    var info = this.getCursorInfo();
    if (info) {
      var cx = X(info.x);
      var cy = info.on === "deriv" ? (info.d !== null ? YR(info.d) : null) : (info.i !== null ? YL(info.i) : null);
      ctx.strokeStyle = COLORS.cursor; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(Math.round(cx) + 0.5, L.top); ctx.lineTo(Math.round(cx) + 0.5, L.top + L.h); ctx.stroke();
      if (cy !== null) {
        ctx.fillStyle = "rgba(213,0,0,0.18)";
        ctx.beginPath(); ctx.arc(cx, cy, 11, 0, Math.PI * 2); ctx.fill();
        ctx.lineWidth = 2.5; ctx.strokeStyle = COLORS.cursor;
        ctx.beginPath(); ctx.arc(cx, cy, 6.5, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = COLORS.cursor;
        ctx.beginPath(); ctx.arc(cx, cy, 2.2, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.restore();

    // empty-state hint
    if (this.series.current.length === 0) {
      ctx.fillStyle = "#90a4ae"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("Írd be a mért adatokat a táblázatba", L.left + L.w / 2, L.top + L.h / 2);
    }
  };

  LabPlot.prototype._drawEp = function (ep, label, color, shape) {
    if (!ep || !isFinite(ep.v)) return;
    var ctx = this.ctx, L = this.layout;
    var x = this._X(ep.v);
    var useDeriv = this.showDeriv && ep.d !== null && ep.d !== undefined && isFinite(ep.d);
    var y = useDeriv ? this._YR(ep.d) : (ep.i !== null && isFinite(ep.i) ? this._YL(ep.i) : L.top + L.h / 2);
    ctx.setLineDash([3, 3]); ctx.strokeStyle = color; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(x, L.top); ctx.lineTo(x, L.top + L.h); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color; ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (shape === "diamond") { ctx.moveTo(x, y - 8); ctx.lineTo(x + 8, y); ctx.lineTo(x, y + 8); ctx.lineTo(x - 8, y); }
    else { ctx.moveTo(x, y - 8); ctx.lineTo(x + 8, y + 6); ctx.lineTo(x - 8, y + 6); }
    ctx.closePath(); ctx.fill(); ctx.stroke();
    // label box at the top of the line
    ctx.font = "700 11px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
    var tw = ctx.measureText(label).width + 8;
    var lx = Math.min(Math.max(x - tw / 2, L.left + 1), L.left + L.w - tw - 1);
    var ly = shape === "diamond" ? L.top + 2 : L.top + 20;
    ctx.fillStyle = color;
    roundRect(ctx, lx, ly, tw, 16, 3); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(label, lx + tw / 2, ly + 8.5);
  };

  function dot(ctx, x, y, r, outline) {
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    if (outline) ctx.stroke();
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
  }

  /* -------------------------------------------------------------- input */

  LabPlot.prototype._local = function (e) {
    var r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  LabPlot.prototype._cursorFromPx = function (px) {
    var L = this.layout, V = this._view();
    var x = V.x.min + (px - L.left) / L.w * (V.x.max - V.x.min);
    this._snapCursor(x, true);
    this.render();
  };

  LabPlot.prototype._bind = function () {
    var self = this, cv = this.canvas;
    cv.style.touchAction = "none";

    cv.addEventListener("pointerdown", function (e) {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      try { cv.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      // a new primary pointer means no other finger is down: drop any stale pointers
      if (e.isPrimary) { self.pointers.clear(); self.gesture = null; }
      self.pointers.set(e.pointerId, self._local(e));
      var n = self.pointers.size;
      if (n === 1) {
        self.gesture = { type: "cursor", id: e.pointerId, t0: Date.now(), before: self.cursorX };
        self._cursorFromPx(self._local(e).x);
      } else if (n === 2) {
        if (self.gesture && self.gesture.type === "cursor" && Date.now() - self.gesture.t0 < RESTORE_MS) {
          self.cursorX = self.gesture.before; // the first finger was the start of a pinch, not a tap
          self._emitCursor();
        }
        self._startPinch();
      }
      e.preventDefault();
    });

    cv.addEventListener("pointermove", function (e) {
      if (!self.pointers.has(e.pointerId)) return;
      self.pointers.set(e.pointerId, self._local(e));
      var g = self.gesture;
      if (!g) return;
      if (g.type === "cursor" && g.id === e.pointerId) self._cursorFromPx(self._local(e).x);
      else if (g.type === "pinch") self._movePinch();
      e.preventDefault();
    });

    function end(e) {
      if (!self.pointers.has(e.pointerId)) return;
      self.pointers.delete(e.pointerId);
      if (self.pointers.size === 0) self.gesture = null;
      else if (self.gesture && self.gesture.type === "pinch") self.gesture = { type: "wait" }; // ignore leftover finger
    }
    cv.addEventListener("pointerup", end);
    cv.addEventListener("pointercancel", end);
    cv.addEventListener("lostpointercapture", end);

    // iOS Safari: stop page zoom / scroll while interacting with the plot
    ["gesturestart", "gesturechange", "gestureend"].forEach(function (t) {
      cv.addEventListener(t, function (e) { e.preventDefault(); }, { passive: false });
    });
    cv.addEventListener("touchmove", function (e) { e.preventDefault(); }, { passive: false });
    cv.addEventListener("touchstart", function (e) { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });

    // desktop: wheel zoom around the pointer (shift = x only)
    cv.addEventListener("wheel", function (e) {
      e.preventDefault();
      var p = self._local(e);
      var f = Math.exp(Math.max(-1, Math.min(1, e.deltaY * 0.0015)));
      self._zoomAt(p, f, e.shiftKey ? 1 : f);
    }, { passive: false });

    if (window.ResizeObserver) new ResizeObserver(function () { self._resize(); }).observe(cv);
    else window.addEventListener("resize", function () { self._resize(); });
  };

  LabPlot.prototype._startPinch = function () {
    var pts = Array.from(this.pointers.values()).slice(0, 2);
    var ids = Array.from(this.pointers.keys()).slice(0, 2);
    this.gesture = { type: "pinch", ids: ids, p0: pts, win0: Object.assign({}, this.win) };
  };

  LabPlot.prototype._movePinch = function () {
    var g = this.gesture, L = this.layout;
    var a = this.pointers.get(g.ids[0]), b = this.pointers.get(g.ids[1]);
    if (!a || !b) return;
    var a0 = g.p0[0], b0 = g.p0[1];
    var dx0 = Math.abs(a0.x - b0.x), dy0 = Math.abs(a0.y - b0.y);
    var dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y);
    var sx = 1, sy = 1;
    if (dx0 < PINCH_AXIS_PX && dy0 < PINCH_AXIS_PX) {
      var d0 = Math.hypot(dx0, dy0), d1 = Math.hypot(dx, dy);
      if (d0 > 10) sx = sy = d0 / Math.max(d1, 10);
    } else {
      if (dx0 >= PINCH_AXIS_PX) sx = dx0 / Math.max(dx, 10);
      if (dy0 >= PINCH_AXIS_PX) sy = dy0 / Math.max(dy, 10);
    }
    var w0 = g.win0;
    var m0 = { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2 };
    var m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    var nx = axisWin(w0.x0, w0.x1, sx, (m0.x - L.left) / L.w, (m.x - L.left) / L.w);
    var ny = axisWin(w0.y0, w0.y1, sy, (L.top + L.h - m0.y) / L.h, (L.top + L.h - m.y) / L.h);
    this.win = { x0: nx[0], x1: nx[1], y0: ny[0], y1: ny[1] };
    this.render();
    this._emitView();
  };

  /** New [lo, hi] window: scale width by s, keep data under the start midpoint under the current midpoint. */
  function axisWin(lo0, hi0, s, f0, f1) {
    var w0 = hi0 - lo0;
    var w = Math.min(1, Math.max(MIN_WIN, w0 * s));
    var anchor = lo0 + f0 * w0;
    var lo = anchor - f1 * w;
    lo = Math.min(Math.max(lo, 0), 1 - w);
    return [lo, lo + w];
  }

  LabPlot.prototype._zoomAt = function (p, fx, fy) {
    var L = this.layout, w = this.win;
    var f1x = (p.x - L.left) / L.w, f1y = (L.top + L.h - p.y) / L.h;
    var nx = axisWin(w.x0, w.x1, fx, f1x, f1x);
    var ny = axisWin(w.y0, w.y1, fy, f1y, f1y);
    this.win = { x0: nx[0], x1: nx[1], y0: ny[0], y1: ny[1] };
    this.render();
    this._emitView();
  };

  LabPlot.COLORS = COLORS;
  window.LabPlot = LabPlot;
})();
