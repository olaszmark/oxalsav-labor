/* Pure calculation / data helpers. No DOM access – unit-tested in Node (tests/core.test.js). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.LabCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ---------------------------------------------------------------- numbers */

  /**
   * Parse a user-typed number. Accepts decimal comma or point, surrounding
   * spaces, thousands-free input such as "12,5", "12.5", ",5", "5,", "-0,3".
   * Returns: null for empty input, NaN for invalid input, otherwise a number.
   */
  function parseNum(input) {
    if (input === null || input === undefined) return null;
    if (typeof input === "number") return isFinite(input) ? input : NaN;
    var s = String(input).replace(/[\s  ]/g, "");
    if (s === "") return null;
    s = s.replace(/−/g, "-"); // unicode minus
    if (!/^[+-]?(\d+([.,]\d*)?|[.,]\d+)$/.test(s)) return NaN;
    var n = Number(s.replace(",", "."));
    return isFinite(n) ? n : NaN;
  }

  /** Is the value a usable non-negative number (volumes, currents)? */
  function isValidNonNeg(n) {
    return typeof n === "number" && isFinite(n) && n >= 0;
  }

  /** Classify a raw input string: "empty" | "ok" | "invalid" (negative counts as invalid). */
  function classifyInput(raw) {
    var n = parseNum(raw);
    if (n === null) return "empty";
    return isValidNonNeg(n) ? "ok" : "invalid";
  }

  /** Format with a fixed number of decimals and a decimal comma (Hungarian). */
  function formatNum(x, decimals, opts) {
    if (x === null || x === undefined || !isFinite(x)) return "";
    var d = decimals === undefined ? 2 : decimals;
    var s = Number(x).toFixed(d);
    if (/^-0(\.0+)?$/.test(s)) s = s.slice(1); // no "-0,00"
    s = s.replace(".", ",");
    if (!(opts && opts.asciiMinus)) s = s.replace("-", "−");
    return s;
  }

  /** Decimals suited to a derivative value of this magnitude. */
  function derivDecimals(x) {
    var a = Math.abs(x);
    if (a >= 100) return 1;
    if (a >= 10) return 2;
    if (a >= 1) return 3;
    return 4;
  }

  function formatDeriv(x, opts) {
    if (x === null || x === undefined || !isFinite(x)) return "";
    return formatNum(x, derivDecimals(x), opts);
  }

  /* ------------------------------------------------------------------ rows */

  var idCounter = 0;
  function newId() {
    idCounter += 1;
    return "r" + Date.now().toString(36) + idCounter.toString(36) + Math.floor(Math.random() * 1296).toString(36);
  }

  function toRawString(v) {
    if (v === null || v === undefined || v === "") return "";
    if (typeof v === "number") return formatNum(v, decimalsOf(v), { asciiMinus: true });
    return String(v);
  }

  function decimalsOf(n) {
    var s = String(n);
    var p = s.indexOf(".");
    return p < 0 ? 0 : Math.min(6, s.length - p - 1);
  }

  /** A table row: raw strings exactly as typed by the student. */
  function makeRow(v, i) {
    return { id: newId(), v: toRawString(v), i: toRawString(i) };
  }

  function rowsFromPresets(presets) {
    return (presets || []).map(function (v) { return makeRow(v, ""); });
  }

  /** Insert an empty row at index (default: at the end). Returns a new array. */
  function addRow(rows, index, row) {
    var out = rows.slice();
    var r = row || makeRow("", "");
    if (index === undefined || index === null || index < 0 || index > out.length) out.push(r);
    else out.splice(index, 0, r);
    return out;
  }

  /** Remove the row at index. Returns a new array (unchanged copy if index is out of range). */
  function deleteRow(rows, index) {
    var out = rows.slice();
    if (index >= 0 && index < out.length) out.splice(index, 1);
    return out;
  }

  function updateRow(rows, index, field, value) {
    return rows.map(function (r, k) {
      if (k !== index) return r;
      var c = { id: r.id, v: r.v, i: r.i };
      c[field] = value;
      return c;
    });
  }

  /** Stable sort by volume; rows with an empty/invalid volume go to the end in original order. */
  function sortRowsByVolume(rows) {
    return rows
      .map(function (r, k) { return { r: r, k: k, v: parseNum(r.v) }; })
      .sort(function (a, b) {
        var av = isValidNonNeg(a.v), bv = isValidNonNeg(b.v);
        if (av && bv && a.v !== b.v) return a.v - b.v;
        if (av !== bv) return av ? -1 : 1;
        return a.k - b.k;
      })
      .map(function (o) { return o.r; });
  }

  /** True if all valid volumes appear in non-decreasing order. */
  function isSortedByVolume(rows) {
    var last = -Infinity;
    for (var k = 0; k < rows.length; k++) {
      var v = parseNum(rows[k].v);
      if (!isValidNonNeg(v)) continue;
      if (v < last) return false;
      last = v;
    }
    return true;
  }

  /* ------------------------------------------------------------ derivative */

  /** Valid measured points (V and I both valid), sorted by volume (stable). */
  function getPoints(rows) {
    var pts = [];
    for (var k = 0; k < rows.length; k++) {
      var v = parseNum(rows[k].v), i = parseNum(rows[k].i);
      if (isValidNonNeg(v) && isValidNonNeg(i)) pts.push({ idx: k, v: v, i: i });
    }
    pts.sort(function (a, b) { return a.v - b.v || a.idx - b.idx; });
    return pts;
  }

  /**
   * Three-point derivative on (volume-sorted) points:
   *   d_k = (I_{k+1} − I_{k−1}) / (V_{k+1} − V_{k−1})
   * Works for uneven spacing. First and last point → no value.
   * Returns [{idx, v, d}] for the points that have a derivative.
   */
  function derivativePoints(points) {
    var out = [];
    for (var k = 1; k < points.length - 1; k++) {
      var dv = points[k + 1].v - points[k - 1].v;
      if (dv <= 0) continue; // duplicate volumes – undefined
      out.push({ idx: points[k].idx, v: points[k].v, d: (points[k + 1].i - points[k - 1].i) / dv });
    }
    return out;
  }

  /**
   * Derivative column for the table: array aligned with rows, number or null.
   * Rows with missing/invalid values are skipped; their neighbours use the
   * nearest valid rows (in volume order) instead.
   */
  function derivativeColumn(rows) {
    var col = rows.map(function () { return null; });
    derivativePoints(getPoints(rows)).forEach(function (p) { col[p.idx] = p.d; });
    return col;
  }

  /* --------------------------------------------------------- interpolation */

  /**
   * Linear interpolation on a series of {x, y} sorted by x.
   * x is clamped to the series range. Returns {x, y} or null for an empty series.
   */
  function interpolate(series, x) {
    if (!series || series.length === 0 || !isFinite(x)) return null;
    var n = series.length;
    if (n === 1 || x <= series[0].x) return { x: n === 1 ? series[0].x : Math.max(x, series[0].x), y: series[0].y };
    if (x >= series[n - 1].x) return { x: series[n - 1].x, y: series[n - 1].y };
    // binary search for the segment
    var lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (series[mid].x <= x) lo = mid; else hi = mid;
    }
    var a = series[lo], b = series[hi];
    if (b.x === a.x) return { x: x, y: a.y };
    var t = (x - a.x) / (b.x - a.x);
    return { x: x, y: a.y + t * (b.y - a.y) };
  }

  /** Series used by the plot / cursor. */
  function buildSeries(rows) {
    var pts = getPoints(rows);
    var der = derivativePoints(pts);
    return {
      current: pts.map(function (p) { return { x: p.v, y: p.i }; }),
      deriv: der.map(function (p) { return { x: p.v, y: p.d }; })
    };
  }

  /* ----------------------------------------------------------------- axes */

  /** "Nice" tick step for a range, ~maxTicks ticks. */
  function niceStep(range, maxTicks) {
    if (!(range > 0)) return 1;
    var raw = range / Math.max(1, maxTicks || 6);
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var f = raw / mag;
    var nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
    return nf * mag;
  }

  function ticks(min, max, maxTicks) {
    var step = niceStep(max - min, maxTicks);
    var out = [];
    var start = Math.ceil(min / step - 1e-9) * step;
    for (var t = start; t <= max + step * 1e-9; t += step) {
      out.push(Math.abs(t) < step * 1e-9 ? 0 : +t.toPrecision(12));
      if (out.length > 100) break;
    }
    return { step: step, values: out };
  }

  /**
   * Auto-scaled "home" ranges: max = data max + 10 %, first quadrant for V and I,
   * derivative axis includes 0 and its negative range (min − 10 %).
   * Current axis (left) fits the data: [min − 10 % of spread, max + 10 % of spread], never below 0.
   */
  function autoRanges(series) {
    var xmax = 0, imin = Infinity, imax = -Infinity, dmin = 0, dmax = 0;
    series.current.forEach(function (p) {
      xmax = Math.max(xmax, p.x); imin = Math.min(imin, p.y); imax = Math.max(imax, p.y);
    });
    series.deriv.forEach(function (p) { dmin = Math.min(dmin, p.y); dmax = Math.max(dmax, p.y); });
    var x = { min: 0, max: xmax > 0 ? xmax * 1.1 : 25 };
    var yL = currentRange(series.current.length, imin, imax);
    var yR = { min: dmin < 0 ? dmin * 1.1 : 0, max: dmax > 0 ? dmax * 1.1 : 0 };
    if (yR.max - yR.min <= 0) { yR.min = -1; yR.max = 1; }
    return { x: x, yL: yL, yR: yR };
  }

  /** Left-axis range for the current values. */
  function currentRange(n, imin, imax) {
    if (n === 0) return { min: 0, max: 10 };                    // no data yet: default
    var spread = imax - imin;
    if (spread > 0) return { min: Math.max(0, imin - 0.1 * spread), max: imax + 0.1 * spread };
    if (imax > 0) return { min: Math.max(0, imax * 0.9), max: imax * 1.1 }; // one value / all equal: ±10 %
    return { min: 0, max: 1 };                                   // all values 0
  }

  /* ------------------------------------------------------------- misc */

  function normalizeName(name) {
    return String(name || "").replace(/\s+/g, " ").trim().slice(0, 80);
  }

  function randomId(len) {
    var chars = "abcdefghijkmnpqrstuvwxyz23456789";
    var out = "";
    var arr = null;
    try {
      arr = new Uint8Array(len);
      (typeof crypto !== "undefined" ? crypto : self.crypto).getRandomValues(arr);
    } catch (e) { arr = null; }
    for (var k = 0; k < len; k++) {
      var r = arr ? arr[k] : Math.floor(Math.random() * 256);
      out += chars[r % chars.length];
    }
    return out;
  }

  return {
    parseNum: parseNum,
    isValidNonNeg: isValidNonNeg,
    classifyInput: classifyInput,
    formatNum: formatNum,
    formatDeriv: formatDeriv,
    derivDecimals: derivDecimals,
    newId: newId,
    makeRow: makeRow,
    rowsFromPresets: rowsFromPresets,
    addRow: addRow,
    deleteRow: deleteRow,
    updateRow: updateRow,
    sortRowsByVolume: sortRowsByVolume,
    isSortedByVolume: isSortedByVolume,
    getPoints: getPoints,
    derivativePoints: derivativePoints,
    derivativeColumn: derivativeColumn,
    interpolate: interpolate,
    buildSeries: buildSeries,
    niceStep: niceStep,
    ticks: ticks,
    autoRanges: autoRanges,
    normalizeName: normalizeName,
    randomId: randomId
  };
});
