// Load test against the REAL deployed Apps Script web app (run before the lab, not during!).
//
//   node tests/load-test.mjs "https://script.google.com/macros/s/XXXX/exec" [students=70] [savesPerStudent=3]
//
// Every simulated student saves `savesPerStudent` times with 3–10 s random pauses. All students run
// at the same time, so this is HEAVIER than the real app (which saves at most every 20 s per student).
// Rows are named "TERHELÉSTESZT 01" … – delete them (or the whole "Adatok" tab) afterwards.
const url = process.argv[2];
const N = Number(process.argv[3] || 70);
const SAVES = Number(process.argv[4] || 3);
if (!url || !/^https:\/\/script\.google\.com\//.test(url)) {
  console.error('Usage: node tests/load-test.mjs "https://script.google.com/macros/s/…/exec" [students] [saves]');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lat = [];
const errors = {};
let ok = 0;

function rows(seed) {
  return Array.from({ length: 21 }, (_, v) => ({ id: "r" + v, v: String(v), i: (20 + Math.sin(v + seed) * 5).toFixed(1).replace(".", ",") }));
}

async function student(k) {
  const name = "TERHELÉSTESZT " + String(k + 1).padStart(2, "0");
  const deviceId = "loadtest" + String(k).padStart(4, "0");
  await sleep(Math.random() * 3000);
  for (let s = 1; s <= SAVES; s++) {
    const state = { version: 1, name, deviceId, key: deviceId + "|" + name, rows: rows(k + s), showDeriv: true,
      ep1: { v: 8.1, d: 0, i: 9 }, ep2: s === SAVES ? { v: 16.4, d: 3.2, i: 15 } : null,
      submitted: s === SAVES, submittedAt: s === SAVES ? new Date().toISOString() : null, changedAfterSubmit: false };
    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action: "save", key: state.key, rev: Date.now(), state }), redirect: "follow"
      });
      const json = await res.json();
      lat.push(Date.now() - t0);
      if (json.ok) ok++; else errors[json.error] = (errors[json.error] || 0) + 1;
    } catch (e) {
      lat.push(Date.now() - t0);
      errors[e.message] = (errors[e.message] || 0) + 1;
    }
    await sleep(3000 + Math.random() * 7000);
  }
}

console.log(`Load test: ${N} students × ${SAVES} saves → ${url}`);
const t = Date.now();
await Promise.all(Array.from({ length: N }, (_, k) => student(k)));
lat.sort((a, b) => a - b);
const pct = (p) => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))];
console.log(`Done in ${((Date.now() - t) / 1000).toFixed(0)} s. OK: ${ok}/${N * SAVES}`);
console.log(`Latency ms – median ${pct(0.5)}, 90% ${pct(0.9)}, max ${lat.at(-1)}`);
console.log("Errors:", Object.keys(errors).length ? errors : "none");
console.log('Now delete the "TERHELÉSTESZT" rows (or the whole "Adatok" tab – it is re-created automatically).');
process.exit(Object.keys(errors).length ? 1 : 0);
