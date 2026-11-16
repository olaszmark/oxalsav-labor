// Cache-busting: give every CSS/JS reference in index.html and teacher.html a new ?v=… value,
// so phones download the changed files (e.g. a new config.js) instead of using cached copies.
//
//   npm run bump            → v=YYYY.MM.DD-HHMM (current time)
//   npm run bump -- 1.2.0   → v=1.2.0
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const p = (n) => String(n).padStart(2, "0");
const d = new Date();
const version = process.argv[2] || `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
if (!/^[\w.-]+$/.test(version)) { console.error("Invalid version: " + version); process.exit(1); }

for (const file of ["index.html", "teacher.html"]) {
  const path = join(ROOT, file);
  const html = readFileSync(path, "utf8");
  let n = 0;
  const out = html.replace(/((?:href|src)="(?:css|js)\/[\w.-]+\.(?:css|js))(?:\?v=[\w.-]*)?"/g, (m, url) => { n++; return `${url}?v=${version}"`; });
  writeFileSync(path, out);
  console.log(`${file}: ${n} references → ?v=${version}`);
}
