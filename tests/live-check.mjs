// Smoke test of the LIVE GitHub Pages site on a phone-sized browser.
//   node tests/live-check.mjs [https://<user>.github.io/<repo>/] [--expect-mock | --expect-api]
// Checks: page loads, no console/page errors, every CSS/JS file loads (with ?v=) from the
// /<repo>/ subpath, the app starts, and whether the TESZT MÓD banner is shown as expected.
import { chromium, devices } from "playwright";

const base = (process.argv.find((a) => a.startsWith("https://")) || "https://olaszmark.github.io/oxalsav-labor/").replace(/\/?$/, "/");
const expectMock = process.argv.includes("--expect-mock");
const expectApi = process.argv.includes("--expect-api");
const browser = await chromium.launch();
let failures = 0;
const ok = (cond, msg) => { console.log((cond ? "  ✔ " : "  ✖ ") + msg); if (!cond) failures++; };

for (const [label, dev] of [["iPhone 13", devices["iPhone 13"]], ["Pixel 7", devices["Pixel 7"]]]) {
  for (const page of ["", "teacher.html"]) {
    const url = base + page;
    console.log(`\n${label} – ${url}`);
    const ctx = await browser.newContext({ ...dev });
    const p = await ctx.newPage();
    const errors = [], failed = [], assets = [];
    p.on("pageerror", (e) => errors.push(e.message));
    p.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    p.on("requestfailed", (r) => failed.push(r.url() + " " + (r.failure() && r.failure().errorText)));
    p.on("response", (r) => {
      const u = r.url();
      if (/\.(css|js)(\?|$)/.test(u)) assets.push([u, r.status()]);
      if (r.status() >= 400) failed.push(u + " HTTP " + r.status());
    });
    const res = await p.goto(url, { waitUntil: "networkidle" });
    ok(res.status() === 200, `HTTP ${res.status()}`);
    ok(errors.length === 0, "no console/page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    ok(failed.length === 0, "no failed requests" + (failed.length ? ": " + failed.join(" | ") : ""));
    const prefix = new URL(base).pathname; // e.g. /oxalsav-labor/
    ok(assets.length >= 6 && assets.every(([u, s]) => s === 200 && new URL(u).pathname.startsWith(prefix) && /\?v=[\w.-]+$/.test(u)),
      `${assets.length} CSS/JS files loaded from ${prefix} with ?v=` + (assets.length ? " (" + new URL(assets[0][0]).search + ")" : ""));
    const st = await p.evaluate(() => ({
      core: !!window.LabCore, plot: !!window.LabPlot, api: !!window.LabApi, mock: window.LabApi && window.LabApi.isMock,
      bg: getComputedStyle(document.body).backgroundColor,
      robots: (document.querySelector('meta[name="robots"]') || {}).content,
      start: !!document.querySelector("#startScreen:not([hidden]), #loginScreen:not([hidden])"),
      banner: [...document.querySelectorAll(".mock-note")].some((e) => !e.hidden && e.offsetParent !== null)
    }));
    ok(st.core && st.plot && st.api, "scripts executed (LabCore, LabPlot, LabApi)");
    ok(st.bg === "rgb(238, 241, 246)", "stylesheet applied");
    ok(st.start, "start / login screen shown");
    ok(/noindex/.test(st.robots || ""), `robots meta: ${st.robots}`);
    if (expectMock) ok(st.mock && st.banner, "TESZT MÓD banner shown (API_URL empty)");
    if (expectApi) ok(!st.mock && !st.banner, "no TESZT MÓD banner (API_URL set)");
    await p.screenshot({ path: `tests/ui/screenshots/live_${label.replace(/\W/g, "")}_${page ? "teacher" : "student"}.png` });
    await ctx.close();
  }
}
await browser.close();
console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll live checks passed.");
process.exit(failures ? 1 : 0);
