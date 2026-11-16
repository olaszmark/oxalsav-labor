const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../js/core.js");

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const rows = (pairs) => pairs.map(([v, i]) => C.makeRow(v, i));

/* ------------------------------------------------------------ parseNum */
test("parseNum: decimal comma and point", () => {
  assert.equal(C.parseNum("12,5"), 12.5);
  assert.equal(C.parseNum("12.5"), 12.5);
  assert.equal(C.parseNum(" 7 "), 7);
  assert.equal(C.parseNum(",5"), 0.5);
  assert.equal(C.parseNum("5,"), 5);
  assert.equal(C.parseNum("-0,3"), -0.3);
  assert.equal(C.parseNum("−0,3"), -0.3);
  assert.equal(C.parseNum("+2"), 2);
  assert.equal(C.parseNum("1 0,5"), 10.5); // stray space inside
  assert.equal(C.parseNum(3.25), 3.25);
});
test("parseNum: empty → null", () => {
  assert.equal(C.parseNum(""), null);
  assert.equal(C.parseNum("   "), null);
  assert.equal(C.parseNum(null), null);
  assert.equal(C.parseNum(undefined), null);
});
test("parseNum: invalid → NaN", () => {
  for (const s of ["abc", "1,2,3", "1.2.3", "1,2.3", "1e5", "12mA", ",", ".", "-", "--1", "Infinity"]) {
    assert.ok(Number.isNaN(C.parseNum(s)), s);
  }
});
test("classifyInput", () => {
  assert.equal(C.classifyInput(""), "empty");
  assert.equal(C.classifyInput("3,4"), "ok");
  assert.equal(C.classifyInput("0"), "ok");
  assert.equal(C.classifyInput("-1"), "invalid");
  assert.equal(C.classifyInput("x"), "invalid");
});

/* ------------------------------------------------------------ formatting */
test("formatNum / formatDeriv use decimal comma and unicode minus", () => {
  assert.equal(C.formatNum(12.345, 2), "12,35");
  assert.equal(C.formatNum(-1.5, 1), "−1,5");
  assert.equal(C.formatNum(-1.5, 1, { asciiMinus: true }), "-1,5");
  assert.equal(C.formatNum(-0.0001, 2), "0,00");
  assert.equal(C.formatNum(NaN, 2), "");
  assert.equal(C.formatDeriv(0.01234), "0,0123");
  assert.equal(C.formatDeriv(2.5), "2,500");
  assert.equal(C.formatDeriv(-12.345), "−12,35");
  assert.equal(C.formatDeriv(null), "");
});

/* ------------------------------------------------------------ derivative */
test("derivative: even spacing, first and last empty", () => {
  const r = rows([[0, 10], [1, 8], [2, 6], [3, 7], [4, 9]]);
  const d = C.derivativeColumn(r);
  assert.equal(d[0], null);
  close(d[1], (6 - 10) / 2);
  close(d[2], (7 - 8) / 2);
  close(d[3], (9 - 6) / 2);
  assert.equal(d[4], null);
});
test("derivative: uneven spacing", () => {
  const r = rows([[0, 0], [1, 2], [1.5, 2.5], [3, 6]]);
  const d = C.derivativeColumn(r);
  close(d[1], (2.5 - 0) / (1.5 - 0));
  close(d[2], (6 - 2) / (3 - 1));
});
test("derivative: string input with decimal comma", () => {
  const r = [{ id: "a", v: "0", i: "1" }, { id: "b", v: "0,5", i: "1,5" }, { id: "c", v: "1,0", i: "3" }];
  close(C.derivativeColumn(r)[1], (3 - 1) / 1);
});
test("derivative: rows with missing values are skipped, neighbours bridge the gap", () => {
  const r = rows([[0, 10], [1, ""], [2, 6], ["", 5], [3, 7], [4, 9]]);
  const d = C.derivativeColumn(r);
  assert.equal(d[0], null);      // first valid point
  assert.equal(d[1], null);      // missing I
  close(d[2], (7 - 10) / (3 - 0)); // neighbours: rows 0 and 4
  assert.equal(d[3], null);      // missing V
  close(d[4], (9 - 6) / (4 - 2));
  assert.equal(d[5], null);      // last valid point
});
test("derivative: invalid and negative values are treated as missing", () => {
  const r = rows([[0, 1], [1, "abc"], [2, -3], [3, 4], [4, 5], [5, 7]]);
  const d = C.derivativeColumn(r);
  assert.equal(d[1], null);
  assert.equal(d[2], null);
  close(d[3], (5 - 1) / (4 - 0));
});
test("derivative: unsorted table is evaluated in volume order", () => {
  const r = rows([[0, 0], [2, 4], [1, 1], [3, 9]]);
  const d = C.derivativeColumn(r);
  close(d[2], (4 - 0) / 2); // V=1: neighbours V=0, V=2
  close(d[1], (9 - 1) / 2); // V=2: neighbours V=1, V=3
  assert.equal(d[0], null);
  assert.equal(d[3], null);
});
test("derivative: duplicate volumes never divide by zero", () => {
  const r = rows([[1, 1], [1, 2], [1, 3]]);
  assert.deepEqual(C.derivativeColumn(r), [null, null, null]);
});
test("derivative: fewer than 3 points → all empty", () => {
  assert.deepEqual(C.derivativeColumn(rows([[0, 1], [1, 2]])), [null, null]);
  assert.deepEqual(C.derivativeColumn([]), []);
});

/* ------------------------------------------------------------ interpolation */
test("interpolate: linear between points, clamps outside", () => {
  const s = [{ x: 0, y: 0 }, { x: 2, y: 4 }, { x: 4, y: 0 }];
  assert.deepEqual(C.interpolate(s, 1), { x: 1, y: 2 });
  assert.deepEqual(C.interpolate(s, 3), { x: 3, y: 2 });
  assert.deepEqual(C.interpolate(s, 2), { x: 2, y: 4 });
  assert.deepEqual(C.interpolate(s, -5), { x: 0, y: 0 });
  assert.deepEqual(C.interpolate(s, 99), { x: 4, y: 0 });
});
test("interpolate: negative values (derivative) and uneven spacing", () => {
  const s = [{ x: 1, y: -2 }, { x: 1.5, y: -1 }, { x: 4, y: 4 }];
  close(C.interpolate(s, 1.25).y, -1.5);
  close(C.interpolate(s, 2.75).y, 1.5);
});
test("interpolate: degenerate series", () => {
  assert.equal(C.interpolate([], 1), null);
  assert.deepEqual(C.interpolate([{ x: 3, y: 5 }], 10), { x: 3, y: 5 });
  assert.equal(C.interpolate([{ x: 1, y: 1 }], NaN), null);
});
test("interpolate: zero crossing of a derivative-like curve", () => {
  const s = [{ x: 8, y: -0.2 }, { x: 9, y: 0.3 }];
  // student looks for d = 0 → x = 8.4
  close(C.interpolate(s, 8.4).y, 0, 1e-12);
});
test("buildSeries gives sorted current and derivative series", () => {
  const s = C.buildSeries(rows([[2, 4], [0, 0], [1, 1], [3, 9]]));
  assert.deepEqual(s.current.map((p) => p.x), [0, 1, 2, 3]);
  assert.deepEqual(s.deriv.map((p) => p.x), [1, 2]);
});

/* ------------------------------------------------------------ rows */
test("rowsFromPresets prefills volumes with empty currents", () => {
  const r = C.rowsFromPresets([0, 0.5, 12.25]);
  assert.deepEqual(r.map((x) => x.v), ["0", "0,5", "12,25"]);
  assert.deepEqual(r.map((x) => x.i), ["", "", ""]);
  assert.equal(new Set(r.map((x) => x.id)).size, 3);
});
test("addRow: at end and at index, immutably", () => {
  const r = rows([[0, 1], [1, 2]]);
  const a = C.addRow(r);
  assert.equal(a.length, 3);
  assert.equal(r.length, 2);
  assert.deepEqual([a[2].v, a[2].i], ["", ""]);
  const b = C.addRow(r, 1, C.makeRow(0.5, ""));
  assert.deepEqual(b.map((x) => x.v), ["0", "0,5", "1"]);
  assert.equal(C.addRow(r, 99).length, 3);
});
test("deleteRow: removes the right row, ignores bad index", () => {
  const r = rows([[0, 1], [1, 2], [2, 3]]);
  assert.deepEqual(C.deleteRow(r, 1).map((x) => x.v), ["0", "2"]);
  assert.equal(r.length, 3);
  assert.equal(C.deleteRow(r, 5).length, 3);
  assert.equal(C.deleteRow(r, -1).length, 3);
  assert.equal(C.deleteRow([], 0).length, 0);
});
test("delete + derivative stay consistent", () => {
  const r = rows([[0, 0], [1, 1], [2, 4], [3, 9]]);
  const d = C.derivativeColumn(C.deleteRow(r, 1));
  close(d[1], (9 - 0) / 3);
});
test("updateRow changes one field immutably", () => {
  const r = rows([[0, 1], [1, 2]]);
  const u = C.updateRow(r, 1, "i", "2,5");
  assert.equal(u[1].i, "2,5");
  assert.equal(r[1].i, "2");
  assert.equal(u[1].id, r[1].id);
});
test("sortRowsByVolume: stable, empty volumes at the end", () => {
  const r = rows([[2, "a"], ["", "x"], [1, "b"], [2, "c"], ["q", "y"], [0, "d"]]);
  assert.deepEqual(C.sortRowsByVolume(r).map((x) => x.i), ["d", "b", "a", "c", "x", "y"]);
  assert.equal(C.isSortedByVolume(r), false);
  assert.equal(C.isSortedByVolume(C.sortRowsByVolume(r)), true);
  assert.equal(C.isSortedByVolume(rows([[0, 1], ["", ""], [1, 1]])), true);
});

/* ------------------------------------------------------------ axes */
test("autoRanges: volume +10 %, current fitted to the data, negative derivative range", () => {
  const a = C.autoRanges({
    current: [{ x: 0, y: 2 }, { x: 20, y: 10 }],
    deriv: [{ x: 5, y: -0.5 }, { x: 10, y: 1 }]
  });
  close(a.x.max, 22); assert.equal(a.x.min, 0);
  // current 2 … 10 → spread 8 → 2 − 0,8 … 10 + 0,8
  close(a.yL.min, 1.2); close(a.yL.max, 10.8);
  close(a.yR.max, 1.1); close(a.yR.min, -0.55);
});
test("autoRanges: positive-only derivative still includes 0; empty data has defaults", () => {
  const a = C.autoRanges({ current: [{ x: 1, y: 1 }], deriv: [{ x: 1, y: 2 }] });
  assert.equal(a.yR.min, 0);
  const e = C.autoRanges({ current: [], deriv: [] });
  assert.ok(e.x.max > 0 && e.yL.max > 0 && e.yR.max > e.yR.min);
});
test("autoRanges: current axis lower bound never below 0", () => {
  const a = C.autoRanges({ current: [{ x: 0, y: 0.5 }, { x: 1, y: 20 }], deriv: [] });
  assert.equal(a.yL.min, 0);                    // 0,5 − 1,95 < 0 → 0
  close(a.yL.max, 21.95);
});
test("autoRanges: current fallback for one value / all equal / all zero / no data", () => {
  const one = C.autoRanges({ current: [{ x: 1, y: 5 }], deriv: [] });
  close(one.yL.min, 4.5); close(one.yL.max, 5.5);
  const eq = C.autoRanges({ current: [{ x: 1, y: 2 }, { x: 2, y: 2 }, { x: 3, y: 2 }], deriv: [] });
  close(eq.yL.min, 1.8); close(eq.yL.max, 2.2);
  const zero = C.autoRanges({ current: [{ x: 1, y: 0 }, { x: 2, y: 0 }], deriv: [] });
  assert.deepEqual(zero.yL, { min: 0, max: 1 });
  const none = C.autoRanges({ current: [], deriv: [] });
  assert.deepEqual(none.yL, { min: 0, max: 10 }); // unchanged default
  assert.deepEqual(none.x, { min: 0, max: 25 });
});
test("autoRanges: volume axis still starts at 0, derivative axis unchanged", () => {
  const a = C.autoRanges({ current: [{ x: 5, y: 16 }, { x: 10, y: 17 }], deriv: [{ x: 7, y: 0.2 }] });
  assert.equal(a.x.min, 0); close(a.x.max, 11);
  assert.equal(a.yR.min, 0); close(a.yR.max, 0.22);
});

test("ticks are nice and cover the range", () => {
  const t = C.ticks(0, 22, 6);
  assert.equal(t.step, 5);
  assert.deepEqual(t.values, [0, 5, 10, 15, 20]);
  const n = C.ticks(-0.55, 1.1, 6);
  assert.ok(n.values.includes(0));
  // a fitted current range gets clean labels (the plot asks for ~7 ticks at phone height)
  const c = C.ticks(16.772, 18.068, 7);
  assert.equal(c.step, 0.2);
  assert.deepEqual(c.values, [16.8, 17, 17.2, 17.4, 17.6, 17.8, 18]);
});

/* ------------------------------------------------------------ misc */
test("normalizeName and randomId", () => {
  assert.equal(C.normalizeName("  Kiss   Anna "), "Kiss Anna");
  const id = C.randomId(12);
  assert.match(id, /^[a-z2-9]{12}$/);
  assert.notEqual(C.randomId(12), id);
});
