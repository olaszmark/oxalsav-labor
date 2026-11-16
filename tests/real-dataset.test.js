// Real measurement (10 cm³ ~0.5 M oxalic acid titrated with ~0.5 M NaOH, homemade AC conductometer).
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../js/core.js");
const { loadTsv } = require("./fixtures/load-fixture.js");

const raw = loadTsv("real-oxalic-acid.tsv");
const rows = raw.map((r) => C.makeRow(r.v, r.i));
const d = C.derivativeColumn(rows);
const at = (v) => {
  const k = raw.findIndex((r) => C.parseNum(r.v) === v);
  assert.ok(k >= 0, "volume " + v + " in fixture");
  return d[k];
};

test("fixture: 43 rows, all values parse (decimal commas)", () => {
  assert.equal(raw.length, 43);
  assert.equal(C.getPoints(rows).length, 43);
  assert.equal(raw[9].v, "8,50");
  assert.equal(C.parseNum(raw[9].i), 16.99);
  assert.equal(C.isSortedByVolume(rows), true);
});

test("3-point derivative matches the hand-calculated values (mA/cm³)", () => {
  const expected = [[1, 0], [2, -0.015], [8.5, -0.03], [12, 0], [14, 0.1067], [18, 0.1], [24, 0.12]];
  for (const [v, e] of expected) {
    assert.ok(Math.abs(at(v) - e) < 5e-5, `V=${v}: ${at(v)} ≠ ${e}`);
  }
});

test("first and last rows are blank", () => {
  assert.equal(d[0], null);
  assert.equal(d[d.length - 1], null);
  assert.equal(d.filter((x) => x === null).length, 2);
});

test("derivative column as displayed in the table (decimal comma)", () => {
  assert.equal(C.formatDeriv(at(1)), "0,0000");
  assert.equal(C.formatDeriv(at(2)), "−0,0150");
  assert.equal(C.formatDeriv(at(8.5)), "−0,0300");
  assert.equal(C.formatDeriv(at(12)), "0,0000");
  assert.equal(C.formatDeriv(at(14)), "0,1067");
  assert.equal(C.formatDeriv(at(18)), "0,1000");
  assert.equal(C.formatDeriv(at(24)), "0,1200");
});

test("cursor interpolation near the expected equivalence points", () => {
  const s = C.buildSeries(rows);
  assert.ok(Math.abs(C.interpolate(s.deriv, 12).y) < 1e-12);           // EP1: derivative = 0 at 12 cm³
  const max = s.deriv.reduce((a, b) => (b.y > a.y ? b : a));
  assert.equal(max.x, 24);                                             // EP2: derivative maximum in this dataset
  assert.ok(Math.abs(max.y - 0.12) < 1e-9);
  // axis scaling: current 16,88 … 17,96 → spread 1,08 → 16,772 … 18,068 (≈ 16,8 – 18,1 mA)
  const r = C.autoRanges(s);
  assert.ok(Math.abs(r.yL.min - 16.772) < 1e-9, "yL.min " + r.yL.min);
  assert.ok(Math.abs(r.yL.max - 18.068) < 1e-9, "yL.max " + r.yL.max);
  assert.equal(r.x.min, 0);
  assert.ok(r.yR.min < 0 && r.yR.max > 0.12);
});
