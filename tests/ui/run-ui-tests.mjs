// End-to-end mobile UI tests with Playwright (headless Chromium).
//   npm install && npx playwright install chromium
//   npm run test:ui
// Screenshots are written to tests/ui/screenshots/.
import { chromium, webkit, devices } from "playwright";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { startServer } from "./static-server.mjs";
import { startFakeAppsScript } from "./fake-apps-script.mjs";
import { createRequire } from "node:module";
const { loadTsv } = createRequire(import.meta.url)("../fixtures/load-fixture.js");

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, "screenshots");
await mkdir(SHOTS, { recursive: true });
const WEB = "http://127.0.0.1:8090";

const results = [];
async function step(name, fn) {
  try { await fn(); results.push([true, name]); console.log("  ✔ " + name); }
  catch (e) { results.push([false, name, e]); console.log("  ✖ " + name + "\n      " + (e && e.message || e).split("\n").join("\n      ")); }
}
const shot = (page, name, full = false) => page.screenshot({ path: join(SHOTS, name + ".png"), fullPage: full });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Realistic-looking oxalic acid titration (homemade AC conductometer, mA).
 * Falling branch → minimum (EP1 ≈ 8 cm³) → slow rise → steep rise after EP2 ≈ 16 cm³. */
function current(v) {
  const s1 = 1 / (1 + Math.exp(-(v - 8) * 3));
  const s2 = 1 / (1 + Math.exp(-(v - 16) * 3));
  const fall = 30 - 2.6 * v;
  const mid = 9.2 + 0.55 * (v - 8);
  const rise = 13.6 + 3.4 * (v - 16) - 0.08 * (v - 16) ** 2;
  const y = (1 - s1) * fall + s1 * ((1 - s2) * mid + s2 * rise);
  return Math.round(y * 10) / 10;
}

/* Config override injected into the page (real-backend path against the fake Apps Script). */
function configScript(apiUrl, fast) {
  return `window.LAB_CONFIG = {
    API_URL: ${JSON.stringify(apiUrl)},
    PRESET_VOLUMES: [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20],
    TITLE: "Oxálsav konduktometriás titrálása",
    SAVE_DEBOUNCE_MS: ${fast ? 600 : 10000},
    SAVE_MIN_INTERVAL_MS: ${fast ? 1200 : 60000},
    SAVE_MAX_WAIT_MS: ${fast ? 5000 : 60000},
    REQUEST_TIMEOUT_MS: 8000 };`;
}
async function useConfig(ctx, apiUrl, fast = true) {
  // match js/config.js with or without the ?v= cache-busting query
  await ctx.route((url) => url.pathname.endsWith("/js/config.js"), (route) => route.fulfill({ contentType: "text/javascript", body: configScript(apiUrl, fast) }));
}

/* scroll so that an element sits just below the sticky top bar, wait for toasts to go away */
async function showBelowTopbar(page, id) {
  await page.waitForFunction(() => document.getElementById("toast").hidden, null, { timeout: 8000 });
  await page.evaluate((id) => {
    const r = document.getElementById(id).getBoundingClientRect();
    window.scrollBy(0, r.top - document.querySelector(".topbar").getBoundingClientRect().height - 6);
  }, id);
  await sleep(100);
}

/* ---- touch helpers (CDP → real touch events → pointer events in the page) */
async function touch(page) {
  const cdp = await page.context().newCDPSession(page);
  const send = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map((p, k) => ({ x: p.x, y: p.y, id: p.id ?? k })) });
  return {
    async tap(x, y) { await send("touchStart", [{ x, y }]); await sleep(40); await send("touchEnd", []); },
    async drag(x1, y1, x2, y2, steps = 12, onStep) {
      await send("touchStart", [{ x: x1, y: y1 }]);
      for (let k = 1; k <= steps; k++) {
        await send("touchMove", [{ x: x1 + (x2 - x1) * k / steps, y: y1 + (y2 - y1) * k / steps }]);
        await sleep(25);
        if (onStep) await onStep(k);
      }
      await send("touchEnd", []);
    },
    async pinch(cx, cy, d0, d1, steps = 10, vertical = 0) {
      const pts = (d) => [{ x: cx - d / 2, y: cy - vertical * d / 2, id: 1 }, { x: cx + d / 2, y: cy + vertical * d / 2, id: 2 }];
      await send("touchStart", [pts(d0)[0]]);
      await sleep(30);
      await send("touchStart", pts(d0));
      for (let k = 1; k <= steps; k++) { await send("touchMove", pts(d0 + (d1 - d0) * k / steps)); await sleep(25); }
      await send("touchEnd", [pts(d1)[1]]);
      await sleep(20);
      await send("touchEnd", []);
    }
  };
}

/* canvas-pixel position (viewport coordinates) of a data point */
async function plotPos(page, v, y, axis = "R") {
  return page.evaluate(async ([v, y, axis]) => {
    const cv = document.getElementById("plot") || document.getElementById("dPlot");
    const p = cv.__labPlot;
    // wait until smooth scrolling has finished and the plot has been redrawn
    let last = null, same = 0;
    for (let k = 0; k < 120 && same < 4; k++) {
      await new Promise((r) => requestAnimationFrame(r));
      const top = cv.getBoundingClientRect().top;
      same = top === last ? same + 1 : 0;
      last = top;
    }
    const r = cv.getBoundingClientRect();
    const L = p.layout;
    return {
      x: r.left + p._X(v),
      y: r.top + (y === null ? L.top + L.h / 2 : (axis === "R" ? p._YR(y) : p._YL(y))),
      top: r.top, left: r.left, width: r.width, height: r.height
    };
  }, [v, y, axis]);
}
const readout = (page) => page.locator("#readout").innerText();
// "Mentve" = server confirmed ("Mentve hh:mm"), not the grey "Mentve a telefonon"
const waitStatus = (page, prefix, timeout = 30000) =>
  page.waitForFunction((p) => { const t = document.getElementById("saveStatus").textContent; return p === "Mentve" ? /^Mentve \d\d:\d\d$/.test(t) : t.startsWith(p); }, prefix, { timeout });
const readoutV = async (page) => {
  const m = (await readout(page)).match(/V = ([\d,]+)/);
  return m ? Number(m[1].replace(",", ".")) : null;
};

/* ======================================================================= */
const web = await startServer(8090);
const fake = await startFakeAppsScript(8092, { password: "titok" });
const browser = await chromium.launch();
const iPhone = devices["iPhone 13"];
const iPhoneLand = devices["iPhone 13 landscape"];
const pixel = devices["Pixel 7"];
let savedState = null;

console.log("\nStudent – iPhone 13 portrait, backend = Code.gs behind a fake Apps Script server");
{
  const ctx = await browser.newContext({ ...iPhone, locale: "hu-HU" });
  await useConfig(ctx, fake.url, true);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  const t = await touch(page);

  await step("start screen asks for the name", async () => {
    await page.goto(WEB + "/index.html");
    await page.locator("#startScreen").waitFor();
    await shot(page, "01_start_portrait");
    await page.click("#startForm button");
    assert.equal(await page.locator("#nameError").isVisible(), true);
  });

  await step("student starts; row registered on the server", async () => {
    await page.fill("#nameInput", "  Kiss   Anna ");
    await page.click("#startForm button");
    await page.locator("#app").waitFor();
    assert.equal(await page.locator("#studentName").innerText(), "Kiss Anna");
    await page.waitForFunction(() => /^Mentve \d\d:\d\d$/.test(document.getElementById("saveStatus").textContent));
    const list = fake.gas.post({ action: "list", password: "titok" });
    assert.equal(list.students.length, 1);
    assert.equal(list.students[0].name, "Kiss Anna");
  });

  await step("presets prefilled, inputs use the decimal keyboard", async () => {
    const vs = await page.$$eval('input[data-f="v"]', (els) => els.map((e) => e.value));
    assert.equal(vs.length, 21);
    assert.equal(vs[0], "0"); assert.equal(vs[20], "20");
    assert.equal(await page.getAttribute('input[data-f="i"]', "inputmode"), "decimal");
  });

  await step("typing currents (comma and point) fills the derivative column live", async () => {
    const ins = await page.$$('input[data-f="i"]');
    for (let k = 0; k < ins.length; k++) {
      const val = current(k);
      await ins[k].fill(k % 2 ? String(val).replace(".", ",") : String(val));
    }
    const d = await page.$$eval("#dataBody output", (els) => els.map((e) => e.textContent));
    assert.equal(d[0], ""); assert.equal(d[20], "");
    const exp = (current(2) - current(0)) / 2;
    assert.equal(d[1], exp.toFixed(3).replace(".", ",").replace("-", "−"));
    assert.equal(await page.locator("#pointCount").innerText(), "21 mérési pont");
  });

  await step("invalid input is marked red and ignored", async () => {
    const inp = page.locator('input[data-f="i"]').nth(3);
    await inp.fill("12,3,4");
    assert.equal(await inp.evaluate((e) => e.classList.contains("invalid")), true);
    assert.equal(await page.locator("#pointCount").innerText(), "20 mérési pont");
    await inp.scrollIntoViewIfNeeded();
    await shot(page, "02_invalid_input");
    await inp.fill(String(current(3)).replace(".", ","));
    assert.equal(await inp.evaluate((e) => e.classList.contains("invalid")), false);
  });

  await step("full page portrait screenshot", async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, "03_portrait_full", true);
  });

  await step("tap on the plot puts the cursor on the derivative curve", async () => {
    await page.locator("#plotBox").scrollIntoViewIfNeeded();
    const p = await plotPos(page, 12.3, 0);
    await t.tap(p.x, p.y - 60); // y does not matter
    await sleep(80);
    const v = await readoutV(page);
    assert.ok(Math.abs(v - 12.3) < 0.15, "V = " + v);
    assert.match(await readout(page), /dĨ\/dV = /);
    await shot(page, "04_tap_cursor");
  });

  await step("one-finger drag moves the cursor continuously", async () => {
    const a = await plotPos(page, 3, 0), b = await plotPos(page, 18, 0);
    const seen = [];
    await t.drag(a.x, a.y, b.x, b.y + 40, 12, async () => seen.push(await readoutV(page)));
    assert.ok(seen.length === 12);
    for (let k = 1; k < seen.length; k++) assert.ok(seen[k] > seen[k - 1], "monotonic: " + seen.join(" "));
    assert.ok(Math.abs(seen.at(-1) - 18) < 0.2);
    await shot(page, "05_drag_cursor");
  });

  await step("two-finger pinch zooms (x) and does not move the cursor", async () => {
    const before = await readout(page);
    const c = await plotPos(page, 8, 0);
    await t.pinch(c.x, c.y, 60, 220);
    await sleep(80);
    assert.equal(await page.locator("#resetZoomBtn").isVisible(), true);
    assert.equal(await readout(page), before, "cursor unchanged by the pinch");
    const win = await page.evaluate(() => document.getElementById("plot").__labPlot.win);
    assert.ok(win.x1 - win.x0 < 0.5, "x zoomed in: " + JSON.stringify(win));
    assert.ok(Math.abs(win.y1 - win.y0 - 1) < 1e-9, "horizontal pinch keeps y: " + JSON.stringify(win));
    await shot(page, "06_pinch_zoomed");
  });

  await step("diagonal pinch zooms both axes; view stays in the first quadrant", async () => {
    const c = await plotPos(page, 8, 0);
    await t.pinch(c.x, c.y, 80, 200, 8, 1);
    const win = await page.evaluate(() => document.getElementById("plot").__labPlot.win);
    assert.ok(win.y1 - win.y0 < 1 && win.x0 >= 0 && win.y0 >= 0, JSON.stringify(win));
  });

  await step("reset zoom button restores the full view", async () => {
    await page.click("#resetZoomBtn");
    const win = await page.evaluate(() => document.getElementById("plot").__labPlot.win);
    assert.deepEqual(win, { x0: 0, x1: 1, y0: 0, y1: 1 });
    assert.equal(await page.locator("#resetZoomBtn").isVisible(), false);
  });

  await step("EP1: select mode, drag to derivative = 0, save", async () => {
    await page.click("#ep1Btn");
    assert.equal(await page.locator("#epSelect").isVisible(), true);
    assert.equal(await page.locator("#epSaveBtn").isEnabled(), true); // cursor exists already
    // find the zero crossing of the derivative from the page's own series, then drag there
    const x0 = await page.evaluate(() => {
      const s = window.LabCore.buildSeries(JSON.parse(localStorage.getItem("oxalsav_state")).rows).deriv;
      for (let k = 1; k < s.length; k++) if (s[k - 1].y < 0 && s[k].y >= 0) return s[k - 1].x - s[k - 1].y * (s[k].x - s[k - 1].x) / (s[k].y - s[k - 1].y);
    });
    const a = await plotPos(page, 4, 0), b = await plotPos(page, x0, 0);
    await t.drag(a.x, a.y, b.x, b.y, 8);
    await shot(page, "07_ep1_selecting");
    await page.click("#epSaveBtn");
    const txt = await page.locator("#ep1Val").innerText();
    assert.match(txt, /V = [\d,]+ cm³/);
    const ep1 = await page.evaluate(() => JSON.parse(localStorage.getItem("oxalsav_state")).ep1);
    assert.ok(Math.abs(ep1.v - x0) < 0.1 && Math.abs(ep1.d) < 0.15, JSON.stringify(ep1));
  });

  await step("EP2: maximum of the derivative, save; both markers shown", async () => {
    await page.click("#ep2Btn");
    const xm = await page.evaluate(() => {
      const s = window.LabCore.buildSeries(JSON.parse(localStorage.getItem("oxalsav_state")).rows).deriv;
      return s.reduce((a, b) => (b.y > a.y ? b : a)).x;
    });
    const p = await plotPos(page, xm, 0);
    await t.tap(p.x, p.y);
    await page.click("#epSaveBtn");
    const st = await page.evaluate(() => JSON.parse(localStorage.getItem("oxalsav_state")));
    assert.ok(Math.abs(st.ep2.v - xm) < 0.1);
    await page.locator("#plotCard").scrollIntoViewIfNeeded();
    await shot(page, "08_both_eps");
  });

  await step("hiding the derivative: cursor snaps to the current curve", async () => {
    await page.click(".switch");
    assert.equal(await page.locator("#derivToggle").isChecked(), false);
    const p = await plotPos(page, 10, 0);
    await t.tap(p.x, p.y);
    const ro = await readout(page);
    assert.match(ro, /Ĩ = [\d,]+ mA/);
    const exp = (current(10)).toFixed(3).replace(".", ",");
    assert.ok(ro.includes(exp), ro + " vs " + exp);
    await shot(page, "09_derivative_hidden");
    await page.click(".switch");
  });

  await step("delete a row + undo, add a row", async () => {
    await page.locator(".del-btn").nth(5).click();
    assert.equal(await page.locator("#dataBody tr").count(), 20);
    await shot(page, "10_row_deleted_undo");
    await page.click("#toastAction");
    assert.equal(await page.locator("#dataBody tr").count(), 21);
    assert.equal(await page.locator('input[data-f="v"]').nth(5).inputValue(), "5");
    await page.click("#addRowBtn");
    assert.equal(await page.locator("#dataBody tr").count(), 22);
    await page.locator('input[data-f="v"]').nth(21).fill("8,5");
    await page.locator('input[data-f="i"]').nth(21).fill(String(current(8.5)));
    assert.equal(await page.locator("#sortHint").isVisible(), true);
    await page.click("#sortBtn");
    assert.equal(await page.locator('input[data-f="v"]').nth(9).inputValue(), "8,5");
    assert.equal(await page.locator("#sortHint").isVisible(), false);
  });

  await step("submit → server row says submitted, with EP values", async () => {
    await page.click("#submitBtn");
    await page.waitForFunction(() => document.getElementById("submitState").classList.contains("ok"), null, { timeout: 8000 });
    await page.locator("#submitCard").scrollIntoViewIfNeeded();
    await shot(page, "11_submitted");
    const s = fake.gas.post({ action: "list", password: "titok" }).students[0];
    assert.equal(s.submitted, true);
    assert.equal(typeof s.ep1v, "number");
    assert.equal(typeof s.ep2v, "number");
    assert.equal(s.points, 22);
  });

  await step("editing after submit → 'küldd be újra' + server flag", async () => {
    await page.locator('input[data-f="i"]').nth(0).fill("30,5");
    assert.match(await page.locator("#submitState").innerText(), /Küldd be újra/);
    await page.waitForFunction(() => /^Mentve \d\d:\d\d$/.test(document.getElementById("saveStatus").textContent), null, { timeout: 8000 });
    await sleep(1500);
    await page.waitForFunction(() => /^Mentve \d\d:\d\d$/.test(document.getElementById("saveStatus").textContent), null, { timeout: 8000 });
    const s = fake.gas.post({ action: "list", password: "titok" }).students[0];
    assert.equal(s.changedAfterSubmit, true);
    await page.click("#submitBtn");
    await page.waitForFunction(() => document.getElementById("submitState").classList.contains("ok"), null, { timeout: 8000 });
  });

  await step("server only busy → 'Küldés…' (not 'Hiba') for the first 2 retries, then saved", async () => {
    const statuses = new Set();
    await page.exposeFunction("__statusSeen", (t) => statuses.add(t)).catch(() => {});
    await page.evaluate(() => new MutationObserver(() => window.__statusSeen(document.getElementById("saveStatus").textContent))
      .observe(document.getElementById("saveStatus"), { childList: true, characterData: true, subtree: true }));
    fake.log.busyNext = 2;
    await page.locator('input[data-f="i"]').nth(2).fill("24,9");
    await page.click("#submitBtn");                 // immediate save → busy, busy, ok
    await page.waitForFunction(() => /^Mentve \d\d:\d\d$/.test(document.getElementById("saveStatus").textContent), null, { timeout: 30000 });
    assert.ok(![...statuses].some((t) => t.startsWith("Hiba")), "never showed Hiba: " + [...statuses].join(" | "));
    assert.ok([...statuses].includes("Küldés…"));
    assert.equal(fake.log.busyNext, 0);
  });

  await step("server busy 3 times in a row → 'Hiba – újrapróbálás' from the 3rd failure, then saved", async () => {
    fake.log.busyNext = 3;
    await page.locator('input[data-f="i"]').nth(2).fill("25,1");
    await page.click("#submitBtn");
    await page.waitForFunction(() => document.getElementById("saveStatus").textContent === "Hiba – újrapróbálás", null, { timeout: 30000 });
    await page.waitForFunction(() => /^Mentve \d\d:\d\d$/.test(document.getElementById("saveStatus").textContent), null, { timeout: 45000 });
    await page.locator('input[data-f="i"]').nth(2).fill("25,5");
    await page.click("#submitBtn");
    await page.waitForFunction(() => /^Mentve \d\d:\d\d$/.test(document.getElementById("saveStatus").textContent), null, { timeout: 15000 });
  });

  await step("server error → 'Hiba – újrapróbálás', then automatic retry succeeds", async () => {
    fake.log.failing = true;
    await page.locator('input[data-f="i"]').nth(1).fill("27,4");
    await page.waitForFunction(() => document.getElementById("saveStatus").textContent.startsWith("Hiba"), null, { timeout: 8000 });
    assert.equal(await page.locator("#saveStatus").innerText(), "Hiba – újrapróbálás");
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, "12_save_error_retry");
    fake.log.failing = false;
    await page.waitForFunction(() => /^Mentve \d\d:\d\d$/.test(document.getElementById("saveStatus").textContent), null, { timeout: 15000 });
    const st = fake.gas.post({ action: "get", password: "titok", key: fake.gas.post({ action: "list", password: "titok" }).students[0].key }).student.state;
    assert.equal(st.rows[1].i, "27,4");
  });

  await step("reload restores everything from localStorage", async () => {
    const before = await page.evaluate(() => localStorage.getItem("oxalsav_state"));
    await page.reload();
    await page.locator("#app").waitFor();
    assert.equal(await page.locator('input[data-f="i"]').nth(1).inputValue(), "27,4");
    assert.match(await page.locator("#ep1Val").innerText(), /V = /);
    assert.match(await page.locator("#ep2Val").innerText(), /V = /);
    savedState = JSON.parse(before);
  });

  await step("no CORS preflight, text/plain only, no console errors", async () => {
    assert.equal(fake.log.options, 0);
    for (const ct of fake.log.contentTypes) assert.match(ct, /^text\/plain;charset=utf-8$/i);
    // the only expected console error is the HTTP 500 of the simulated server failure
    assert.deepEqual(errors.filter((e) => !/status of 500/.test(e)), []);
  });
  await ctx.close();
}

console.log("\nStudent – save rate limiting with the production timing (10 s debounce, 60 s min interval)");
{
  const ctx = await browser.newContext({ ...iPhone });
  await useConfig(ctx, fake.url, false);
  const page = await ctx.newPage();
  await step("21 quick edits → 1 save after the debounce, next save not before 60 s", async () => {
    await page.goto(WEB + "/index.html");
    await page.fill("#nameInput", "Rate Teszt");
    await page.click("#startForm button");
    await page.waitForFunction(() => /^Mentve \d\d:\d\d$/.test(document.getElementById("saveStatus").textContent));
    const p0 = fake.log.posts;
    const ins = await page.$$('input[data-f="i"]');
    const t0 = Date.now();
    for (let k = 0; k < ins.length; k++) { await ins[k].fill(String(current(k))); await sleep(100); }
    assert.equal(fake.log.posts - p0, 0, "nothing sent while typing");
    await page.waitForFunction(() => /^Mentve \d\d:\d\d$/.test(document.getElementById("saveStatus").textContent), null, { timeout: 75000 });
    const tFirst = Date.now();
    assert.equal(fake.log.posts - p0, 1, "exactly one save");
    await ins[0].fill("31");
    await sleep(15000);
    assert.equal(fake.log.posts - p0, 1, "still one save – min interval not yet over");
    await page.waitForFunction(() => /^Mentve \d\d:\d\d$/.test(document.getElementById("saveStatus").textContent), null, { timeout: 75000 });
    const gap = Date.now() - tFirst;
    assert.equal(fake.log.posts - p0, 2);
    assert.ok(gap >= 55000, "second save after ≥ 60 s since the first was sent (gap " + gap + " ms, typing took " + (tFirst - t0) + " ms)");
  });
  await ctx.close();
}

console.log("\nStudent – autosave cap: ≤ 60 s after the first unsaved change, even while typing (production timing)");
{
  const ctx = await browser.newContext({ ...iPhone });
  await useConfig(ctx, fake.url, false);
  const page = await ctx.newPage();
  await step("typing every 4 s for 72 s (debounce never fires) → exactly one autosave ≈ 60 s after the first change", async () => {
    await page.goto(WEB + "/index.html");
    await page.fill("#nameInput", "Cap Teszt");
    await page.click("#startForm button");
    await page.waitForFunction(() => /^Mentve \d\d:\d\d$/.test(document.getElementById("saveStatus").textContent));
    const capSaves = () => fake.log.requests.filter((r) => r.action === "save" && r.state && r.state.name === "Cap Teszt");
    const n0 = capSaves().length;
    const tFirst = Date.now();
    for (let k = 0; k < 18; k++) {                  // 18 edits × 4 s = 72 s of continuous typing
      await page.locator('input[data-f="i"]').nth(k).fill(String(current(k)));
      await sleep(4000);
    }
    const autosaves = capSaves().slice(n0);
    assert.equal(autosaves.length, 1, "exactly one autosave while typing (got " + autosaves.length + ")");
    const after = autosaves[0].t - tFirst;
    assert.ok(after >= 55000 && after <= 66000, "autosave " + after + " ms after the first change (expected ≈ 60 s)");
    assert.ok(autosaves[0].state.rows.filter((r) => r.i !== "").length >= 14, "it carries the values typed so far");
    console.log(`      (autosave ${(after / 1000).toFixed(1)} s after the first change, while still typing)`);
  });
  await ctx.close();
}

console.log("\nStatus chip – every state on an iPhone SE (375×667), portrait and landscape");
{
  const contrast = (fg, bg) => {
    const lum = (c) => { const [r, g, b] = c.match(/\d+/g).slice(0, 3).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    return (a + 0.05) / (b + 0.05);
  };
  for (const [dev, orient] of [
    [{ ...devices["iPhone 8"], viewport: { width: 375, height: 667 } }, "portrait"],
    [{ ...devices["iPhone 8 landscape"], viewport: { width: 667, height: 375 } }, "landscape"]
  ]) {
    const ctx = await browser.newContext({ ...dev });
    await useConfig(ctx, fake.url, false);           // production timing: 10 s debounce, 60 s interval
    const page = await ctx.newPage();
    page.on("dialog", (d) => d.accept());
    const NAME = "Szentgyörgyi-Nagy Krisztina";      // a long name: the title must give way, not the chip
    const inp = (k) => page.locator('input[data-f="i"]').nth(k);
    let topH = null;
    const check = async (label, text, cls, minContrast) => {
      const g = await page.evaluate(() => {
        const chip = document.getElementById("saveStatus"), title = document.querySelector(".topbar-title"), bar = document.querySelector(".topbar");
        const c = chip.getBoundingClientRect(), t = title.getBoundingClientRect(), b = bar.getBoundingClientRect();
        const cs = getComputedStyle(chip);
        return { text: chip.textContent, cls: chip.className, cH: c.height, cL: c.left, cR: c.right, tR: t.right, bH: b.height, vw: window.innerWidth,
          over: chip.scrollWidth - chip.clientWidth, lh: parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4, fg: cs.color, bg: cs.backgroundColor };
      });
      if (text instanceof RegExp) assert.match(g.text, text, label); else assert.equal(g.text, text, label);
      assert.ok(g.cls.split(" ").includes(cls), label + ": class " + g.cls);
      assert.ok(g.cH < g.lh * 1.6 + 12, `${label}: chip wraps (height ${g.cH})`);
      assert.ok(g.over <= 1, `${label}: text overflows the chip by ${g.over}px`);
      assert.ok(g.cR <= g.vw + 0.5, `${label}: chip leaves the screen`);
      assert.ok(g.tR <= g.cL + 0.5, `${label}: title overlaps the chip`);
      if (topH === null) topH = g.bH; else assert.ok(Math.abs(g.bH - topH) < 1, `${label}: top bar height changed ${topH} → ${g.bH}`);
      const cr = contrast(g.fg, g.bg);
      assert.ok(cr >= minContrast, `${label}: contrast ${cr.toFixed(1)} < ${minContrast}`);
      const bar = await page.locator(".topbar").boundingBox();
      await page.screenshot({ path: join(SHOTS, `chip_${orient}_${label}.png`), clip: { x: 0, y: 0, width: bar.width, height: bar.height } });
      return cr;
    };
    const ratios = {};
    await step(`chip (${orient}): all states fit on one line, no overlap, readable`, async () => {
      await page.goto(WEB + "/index.html");
      await page.fill("#nameInput", NAME);
      await page.click("#startForm button");
      await waitStatus(page, "Mentve");
      ratios.saved = await check("4_confirmed", /^Mentve \d\d:\d\d$/, "saved", 4.5);
      // 1) waiting for the next autosave: data is on the phone
      await inp(0).fill("17,27");
      ratios.local = await check("1_waiting", "Mentve a telefonon", "local", 7);
      // 2) actually sending (the server holds the request 4 s)
      fake.log.delayNext = 4000;
      await page.click("#submitBtn");
      await page.waitForFunction(() => document.getElementById("saveStatus").textContent === "Küldés…");
      ratios.sending = await check("2_sending", "Küldés…", "sending", 7);
      await waitStatus(page, "Mentve");
      // 3) the server is only busy → still "Küldés…" while the app waits to retry
      fake.log.busyNext = 1;
      await inp(1).fill("17,28");
      await page.click("#submitBtn");
      for (let k = 0; k < 100 && fake.log.busyNext > 0; k++) await sleep(50);
      await sleep(400);
      await check("3_busy_retry", "Küldés…", "sending", 7);
      await waitStatus(page, "Mentve");
      // 5) server error
      fake.log.failing = true;
      await inp(2).fill("17,27");
      await page.click("#submitBtn");
      await waitStatus(page, "Hiba");
      ratios.error = await check("5_error", "Hiba – újrapróbálás", "error", 4.5);
      fake.log.failing = false;
      await waitStatus(page, "Mentve", 30000);
      // 6) offline
      await ctx.setOffline(true);
      await inp(3).fill("17,25");
      await page.click("#submitBtn");
      await waitStatus(page, "Nincs internet");
      await check("6_offline", "Nincs internet – újrapróbálás", "error", 4.5);
      await ctx.setOffline(false);
      await waitStatus(page, "Mentve", 30000);
      // 7) the phone cannot store the data → never claim "Mentve a telefonon"
      await page.evaluate(() => { window.__origSet = Storage.prototype.setItem; Storage.prototype.setItem = function () { throw new Error("QuotaExceededError"); }; });
      await inp(4).fill("17,22");
      await check("7_storage", "Hiba – a telefon tárhelye megtelt", "error", 4.5);
      await page.evaluate(() => { Storage.prototype.setItem = window.__origSet; });
      console.log(`      (contrast: waiting ${ratios.local.toFixed(1)}:1, sending ${ratios.sending.toFixed(1)}:1, confirmed ${ratios.saved.toFixed(1)}:1, error ${ratios.error.toFixed(1)}:1)`);
    });
    await ctx.close();
  }
}

console.log("\nStudent – landscape + Android");
for (const [dev, name] of [[iPhoneLand, "13_landscape_iphone"], [pixel, "14_portrait_pixel7"]]) {
  const ctx = await browser.newContext({ ...dev });
  await useConfig(ctx, fake.url, true);
  await ctx.addInitScript((s) => {
    if (!localStorage.getItem("oxalsav_state")) {
      localStorage.setItem("oxalsav_device_id", s.deviceId);
      localStorage.setItem("oxalsav_state", JSON.stringify(s));
    }
  }, savedState);
  const page = await ctx.newPage();
  const t = await touch(page);
  await step(name + ": layout + touch cursor", async () => {
    await page.goto(WEB + "/index.html");
    await page.locator("#app").waitFor();
    await page.locator("#plotBox").scrollIntoViewIfNeeded();
    const p = await plotPos(page, 9.5, 0);
    await t.tap(p.x, p.y);
    assert.ok(Math.abs((await readoutV(page)) - 9.5) < 0.2);
    const box = await page.locator("#plot").boundingBox();
    const vp = page.viewportSize();
    assert.ok(box.width > 150 && box.height > 150, JSON.stringify(box));
    assert.ok(box.x + box.width <= vp.width + 1, "plot fits horizontally");
    if (dev === iPhoneLand) {
      assert.ok(box.y + box.height <= vp.height, "plot fully visible in landscape: " + JSON.stringify(box));
      const ep = await page.locator("#ep1Btn").boundingBox();
      assert.ok(ep.y + ep.height <= vp.height, "EP buttons visible in landscape");
    }
    const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(scrollW <= vp.width + 1, "no horizontal page scroll (" + scrollW + ")");
    await shot(page, name);
  });
  if (dev === iPhoneLand) {
    await step(name + ": EP selection mode in landscape", async () => {
      await page.click("#ep1Btn");
      const p = await plotPos(page, 8, 0);
      await t.tap(p.x, p.y);
      await shot(page, "13b_landscape_selecting");
      await page.click("#epCancelBtn");
    });
  }
  await ctx.close();
}

console.log("\nStudent – mock mode (no server)");
{
  const ctx = await browser.newContext({ ...iPhone });
  const page = await ctx.newPage();
  await step("?mock=1 shows the test banner and saves locally", async () => {
    await page.goto(WEB + "/index.html?mock=1&delay=50");
    assert.equal(await page.locator("#mockNoteStart").isVisible(), true);
    await page.fill("#nameInput", "Mock Mária");
    await page.click("#startForm button");
    await page.waitForFunction(() => /^Mentve \d\d:\d\d$/.test(document.getElementById("saveStatus").textContent));
    const db = await page.evaluate(() => JSON.parse(localStorage.getItem("oxalsav_mock_db")));
    assert.equal(Object.values(db)[0].name, "Mock Mária");
  });
  await step("mock teacher page (password: tanar) sees the mock student", async () => {
    await page.goto(WEB + "/teacher.html?mock=1&delay=50");
    await page.fill("#pwInput", "tanar");
    await page.click("#loginBtn");
    await page.locator("#listBody tr").first().waitFor();
    assert.match(await page.locator("#listBody").innerText(), /Mock Mária/);
  });
  await ctx.close();
}

console.log("\nTeacher page");
{
  // add a few more students directly on the server
  const names = ["Nagy Béla", "Szabó Csilla", "Tóth Dániel", "Kiss Anna"];
  names.forEach((n, k) => {
    const dev = "teacherdev" + k;
    const rows = Array.from({ length: 21 }, (_, v) => ({ id: "r" + v, v: String(v), i: String(current(v) + (k - 1) * 0.4).replace(".", ",") }));
    fake.gas.post({ action: "save", key: dev + "|" + n, rev: 1, state: {
      name: n, deviceId: dev, rows, showDeriv: true,
      ep1: k === 2 ? null : { v: 8 + k * 0.1, d: 0.01, i: 9 }, ep2: k === 2 ? null : { v: 16.4 + k * 0.1, d: 3.3, i: 15 },
      submitted: k !== 2, submittedAt: new Date().toISOString(), changedAfterSubmit: false } });
  });

  for (const [dev, suffix] of [[{ viewport: { width: 1280, height: 800 } }, "desktop"], [iPhone, "mobile"]]) {
    const ctx = await browser.newContext({ ...dev, acceptDownloads: true });
    await useConfig(ctx, fake.url, true);
    const page = await ctx.newPage();
    await step(`teacher (${suffix}): wrong password rejected, right one accepted`, async () => {
      await page.goto(WEB + "/teacher.html");
      await page.fill("#pwInput", "rossz");
      await page.click("#loginBtn");
      await page.locator("#loginError").waitFor();
      assert.match(await page.locator("#loginError").innerText(), /Hibás jelszó/);
      if (suffix === "desktop") await shot(page, "20_teacher_login_error");
      await page.fill("#pwInput", "titok");
      await page.click("#loginBtn");
      await page.locator("#listBody tr").first().waitFor();
      assert.equal(await page.locator("#listBody tr").count(), fake.gas.post({ action: "list", password: "titok" }).students.length);
    });
    await step(`teacher (${suffix}): sorting and search`, async () => {
      await page.click('th[data-sort="name"]'); // toggles to descending
      const first = await page.locator("#listBody tr td").first().innerText();
      assert.match(first, /Tóth Dániel/);
      await page.click('th[data-sort="ep1v"]');
      await page.fill("#searchInput", "kiss");
      assert.equal(await page.locator("#listBody tr").count(), 2); // same name, two devices
      assert.match(await page.locator("#listBody").innerText(), /\(/); // device id shown for duplicate names
      await page.fill("#searchInput", "");
      await page.click('th[data-sort="name"]');
      await shot(page, "21_teacher_list_" + suffix, suffix === "mobile");
    });
    await step(`teacher (${suffix}): read-only detail view with table, plot, EPs`, async () => {
      await page.locator("#listBody tr", { hasText: "Kiss Anna" }).first().click();
      await page.locator("#detailView").waitFor();
      assert.equal(await page.locator("#dBody input").count(), 0, "read-only");
      assert.ok((await page.locator("#dBody tr").count()) >= 21);
      assert.match(await page.locator("#dEp1").innerText(), /V = /);
      const p = await plotPos(page, 12, 0);
      await page.mouse.click(p.x, p.y);
      assert.match(await page.locator("#dReadout").innerText(), /V = 12/);
      await shot(page, "22_teacher_detail_" + suffix, suffix === "mobile");
      await page.click("#backBtn");
      await page.locator("#listView").waitFor();
    });
    if (suffix === "desktop") {
      await step("teacher: CSV exports (summary + all data)", async () => {
        const [d1] = await Promise.all([page.waitForEvent("download"), page.click("#csvSummaryBtn")]);
        const bytes1 = await readFile(await d1.path());
        assert.deepEqual([...bytes1.subarray(0, 3)], [0xef, 0xbb, 0xbf], "UTF-8 BOM for Excel");
        const csv1 = bytes1.toString("utf8");
        assert.ok(csv1.includes(";1. EP dĨ/dV / (mA/cm³);"), "summary header uses dĨ/dV");
        assert.ok(csv1.startsWith("﻿Név;Eszköz;Utolsó mentés;Beküldve"), csv1.slice(0, 80));
        assert.equal(csv1.split("\r\n").length, fake.gas.post({ action: "list", password: "titok" }).students.length + 1, "header + one line per student");
        assert.match(csv1, /Kiss Anna;[a-z0-9]+;[\d-]+ [\d:]+;igen/);
        const [d2] = await Promise.all([page.waitForEvent("download"), page.click("#csvAllBtn")]);
        const bytes2 = await readFile(await d2.path());
        assert.deepEqual([...bytes2.subarray(0, 3)], [0xef, 0xbb, 0xbf], "UTF-8 BOM for Excel");
        assert.ok(bytes2.includes(Buffer.from([0xc4, 0xa8])), "Ĩ (U+0128) encoded as UTF-8 C4 A8");
        const csv2 = bytes2.toString("utf8");
        assert.ok(csv2.includes("Név;Eszköz;Sor;V(NaOH) (cm3);Ĩ / mA;dĨ/dV / (mA/cm³)"));
        assert.ok(csv2.split("\r\n").length > 100);
        assert.match(csv2, /;\d+,\d{3};\d+,\d{4};-?\d+,\d{6}/);
      });
    }
    await ctx.close();
  }
}

/* ======================================================================= *
 *  Save guarantees: the last change always reaches the server             *
 * ======================================================================= */
const serverStudent = (name) => {
  const s = fake.gas.post({ action: "list", password: "titok" }).students.find((x) => x.name === name);
  return s ? fake.gas.post({ action: "get", password: "titok", key: s.key }).student : null;
};
const savesOf = (name) => fake.log.requests.filter((r) => r.action === "save" && r.state && r.state.name === name);
async function waitSaves(name, n, ms) {
  const t0 = Date.now();
  while (savesOf(name).length < n) {
    if (Date.now() - t0 > ms) throw new Error(`expected ${n} saves of ${name}, got ${savesOf(name).length} after ${ms} ms`);
    await sleep(25);
  }
  return Date.now() - t0;
}
async function setHidden(page, hidden) {
  await page.evaluate((h) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (h ? "hidden" : "visible") });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => h });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

console.log("\nSave guarantees – production timing (10 s debounce, 60 s min interval), Chromium / Pixel 7");
{
  const ctx = await browser.newContext({ ...pixel });
  await useConfig(ctx, fake.url, false);
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.accept());
  const t = await touch(page);
  const NAME = "Mentés Márton";
  const inp = (k) => page.locator('input[data-f="i"]').nth(k);

  await step("setup: student registered and table filled (one debounced save)", async () => {
    await page.goto(WEB + "/index.html");
    await page.fill("#nameInput", NAME);
    await page.click("#startForm button");
    await waitStatus(page, "Mentve");
    const ins = await page.$$('input[data-f="i"]');
    for (let k = 0; k < ins.length; k++) await ins[k].fill(String(current(k)));
    await waitSaves(NAME, 2, 75000);                // ≥ 60 s after the registration save
    await waitStatus(page, "Mentve");
  });

  await step("a) Beküldés right after an edit (inside the 60 s window) is saved at once", async () => {
    const n = savesOf(NAME).length;
    await inp(0).fill("31,1");
    await page.click("#submitBtn");
    const dt = await waitSaves(NAME, n + 1, 2000);
    const last = savesOf(NAME).at(-1);
    assert.equal(last.state.submitted, true);
    assert.equal(last.state.rows[0].i, "31,1");
    await waitStatus(page, "Mentve");
    assert.equal(serverStudent(NAME).submitted, true);
    console.log(`      (request sent ${dt} ms after the click)`);
  });

  await step("b) EP 'Mentés' is saved at once (both points)", async () => {
    for (const n of [1, 2]) {
      const before = savesOf(NAME).length;
      await page.click(`#ep${n}Btn`);
      const p = await plotPos(page, n === 1 ? 8 : 16.5, 0);
      await t.tap(p.x, p.y);
      await page.click("#epSaveBtn");
      const dt = await waitSaves(NAME, before + 1, 2000);
      assert.equal(typeof savesOf(NAME).at(-1).state["ep" + n].v, "number");
      await waitStatus(page, "Mentve");
      assert.equal(typeof serverStudent(NAME)["ep" + n + "v"], "number");
      console.log(`      (EP${n}: request sent ${dt} ms after Mentés)`);
    }
  });

  await step("EP 'Törlés' inside the 60 s window is saved at once", async () => {
    const n = savesOf(NAME).length;
    await page.click("#ep2Del");                    // confirm() is accepted by the dialog handler
    const dt = await waitSaves(NAME, n + 1, 2000);
    assert.equal(savesOf(NAME).at(-1).state.ep2, null);
    await waitStatus(page, "Mentve");
    assert.equal(serverStudent(NAME).ep2v, null);
    console.log(`      (request sent ${dt} ms after Törlés)`);
  });

  await step("EP 'Törlés' while another save is in flight → sent right after it", async () => {
    const n = savesOf(NAME).length;
    fake.log.delayNext = 2500;
    await inp(9).fill("13,3");
    await page.click("#submitBtn");                 // request A, held 2.5 s by the server
    await waitSaves(NAME, n + 1, 2000);
    await page.click("#ep1Del");                    // urgent while A is in flight
    await waitSaves(NAME, n + 2, 6000);
    const [a, b] = savesOf(NAME).slice(-2);
    await waitStatus(page, "Mentve");
    const gap = b.t - a.done;
    assert.ok(gap < 1500, `delete sent ${gap} ms after the in-flight save finished (would be ~60 s throttled)`);
    assert.equal(b.state.ep1, null);
    assert.equal(serverStudent(NAME).ep1v, null);
  });

  await step("a) Beküldés while another save is still in flight → sent right after it", async () => {
    const n = savesOf(NAME).length;
    fake.log.delayNext = 2500;
    await inp(1).fill("27,7");
    await page.click("#submitBtn");                 // request A, held 2.5 s by the server
    await waitSaves(NAME, n + 1, 2000);
    await inp(2).fill("25,5");
    await page.click("#submitBtn");                 // urgent again while A is in flight
    await waitSaves(NAME, n + 2, 6000);
    const [a, b] = savesOf(NAME).slice(-2);
    await waitStatus(page, "Mentve");
    const gap = b.t - a.done;
    assert.ok(gap < 1500, `second request ${gap} ms after the first finished (would be ~60 s throttled)`);
    assert.equal(serverStudent(NAME).state.rows[2].i, "25,5");
  });

  await step("c) page hidden (visibilitychange) → sendBeacon, text/plain, no preflight, arrives at once", async () => {
    const n = savesOf(NAME).length;
    await inp(3).fill("21,9");
    await setHidden(page, true);
    const dt = await waitSaves(NAME, n + 1, 1500);
    const last = savesOf(NAME).at(-1);
    assert.equal(last.mode, "no-cors", "sent as a beacon / keepalive request");
    assert.match(last.contentType, /^text\/plain/i);
    await sleep(200);
    assert.equal(serverStudent(NAME).state.rows[3].i, "21,9");
    // visibilitychange + pagehide would both fire on a real close: no duplicate for the same state
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    await sleep(300);
    assert.equal(savesOf(NAME).length, n + 1, "same state is not beaconed twice");
    await setHidden(page, false);
    await waitStatus(page, "Mentve");               // a normal, confirmed save follows when visible again
    console.log(`      (beacon arrived ${dt} ms after the page was hidden)`);
  });

  await step("c) hidden while a save is in flight; the older request arriving late cannot overwrite", async () => {
    const n = savesOf(NAME).length;
    fake.log.delayNext = 3000;
    await inp(4).fill("22,2");
    await page.click("#submitBtn");                 // request A (older rev) held 3 s
    await waitSaves(NAME, n + 1, 2000);
    await inp(5).fill("23,3");
    await setHidden(page, true);                    // beacon B (newer rev) overtakes A
    await waitSaves(NAME, n + 2, 1500);
    const [a, b] = savesOf(NAME).slice(-2);
    assert.ok(b.rev > a.rev);
    for (let k = 0; k < 80 && !a.result; k++) await sleep(50);
    assert.equal(a.result.ok, true, "the late, older save is stored in the log …");
    assert.ok(a.done > b.done, "… after the newer one");
    const st = serverStudent(NAME).state;                // … but the teacher sees the newest revision
    assert.equal(serverStudent(NAME).rev, b.rev);
    assert.equal(st.rows[5].i, "23,3", "newest edit kept");
    assert.equal(st.rows[4].i, "22,2");
    await setHidden(page, false);
    await waitStatus(page, "Mentve", 80000);        // next confirmed save may follow the 60 s interval
  });

  await step("d) connection back after a failed save → retried at once (no backoff wait)", async () => {
    await ctx.setOffline(true);
    await inp(6).fill("24,4");
    // the normal throttle still applies here (up to 60 s since the last save)
    await page.waitForFunction(() => /Nincs internet|Hiba/.test(document.getElementById("saveStatus").textContent), null, { timeout: 80000 });
    assert.equal(await page.locator("#saveStatus").innerText(), "Nincs internet – újrapróbálás");
    const n = savesOf(NAME).length;
    await ctx.setOffline(false);
    const dt = await waitSaves(NAME, n + 1, 2500);   // first backoff retry would be ≥ 3,75 s
    await waitStatus(page, "Mentve");
    assert.equal(serverStudent(NAME).state.rows[6].i, "24,4");
    console.log(`      (retried ${dt} ms after the connection came back)`);
  });

  await step("c) closing the tab right after an edit (pagehide) → the edit reaches the server", async () => {
    const n = savesOf(NAME).length;
    await inp(7).fill("25,7");
    await page.close({ runBeforeUnload: true });
    await waitSaves(NAME, n + 1, 2000);
    await sleep(200);
    assert.equal(serverStudent(NAME).state.rows[7].i, "25,7");
  });
  await ctx.close();
}

console.log("\nSave guarantees – WebKit (Safari engine) with iPhone 13 emulation");
{
  let wk = null;
  try { wk = await webkit.launch(); } catch (e) { results.push([false, "WebKit launch", e]); console.log("  ✖ WebKit could not start: " + e.message); }
  if (wk) {
    const ctx = await wk.newContext({ ...iPhone });
    await useConfig(ctx, fake.url, false);
    const page = await ctx.newPage();
    const NAME = "Safari Sára";
    const inp = (k) => page.locator('input[data-f="i"]').nth(k);
    await step("WebKit: page hidden → beacon arrives at once, text/plain, no preflight", async () => {
      await page.goto(WEB + "/index.html");
      await page.fill("#nameInput", NAME);
      await page.click("#startForm button");
      await waitStatus(page, "Mentve");
      const n = savesOf(NAME).length;
      await inp(0).fill("30,3");
      await setHidden(page, true);
      await waitSaves(NAME, n + 1, 1500);
      assert.match(savesOf(NAME).at(-1).contentType, /^text\/plain/i);
      await sleep(200);
      assert.equal(serverStudent(NAME).state.rows[0].i, "30,3");
      await setHidden(page, false);
    });
    await step("WebKit: Beküldés inside the 60 s window → saved at once", async () => {
      page.on("dialog", (d) => d.accept());
      const n = savesOf(NAME).length;
      await inp(1).fill("28,8");
      await page.click("#submitBtn");
      await waitSaves(NAME, n + 1, 2000);
      assert.equal(savesOf(NAME).at(-1).state.submitted, true);
    });
    // Playwright's WebKit does not run unload handlers on page.close(), so leave the page instead
    // (fires pagehide exactly like closing/leaving the tab does in Safari).
    await step("WebKit: leaving the page right after an edit (pagehide) → the edit reaches the server", async () => {
      const n = savesOf(NAME).length;
      await inp(2).fill("26,6");
      await page.goto("about:blank");
      await waitSaves(NAME, n + 1, 2000);
      await sleep(200);
      assert.equal(serverStudent(NAME).state.rows[2].i, "26,6");
    });
    await ctx.close();
    await wk.close();
  }
}

/* ======================================================================= *
 *  Small phones: the page can always be scrolled past the plot            *
 * ======================================================================= */
console.log("\nScrolling on small phones – iPhone SE (375×667) portrait and landscape");
for (const [dev, label] of [
  [{ ...devices["iPhone 8"], viewport: { width: 375, height: 667 } }, "15_iphone_se_portrait"],
  [{ ...devices["iPhone 8 landscape"], viewport: { width: 667, height: 375 } }, "16_iphone_se_landscape"]
]) {
  const ctx = await browser.newContext({ ...dev });
  await useConfig(ctx, fake.url, true);
  await ctx.addInitScript((s) => {
    if (!localStorage.getItem("oxalsav_state")) {
      localStorage.setItem("oxalsav_device_id", s.deviceId);
      localStorage.setItem("oxalsav_state", JSON.stringify(s));
    }
  }, savedState);
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  const geom = () => page.evaluate(() => {
    const top = document.querySelector(".topbar").getBoundingClientRect().bottom;
    const c = document.getElementById("plot").getBoundingClientRect();
    const H = window.innerHeight;
    const vis = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return r.height > 0 && r.top >= top - 1 && r.bottom <= H + 1; };
    const ins = document.querySelectorAll("#dataBody input");
    const visEl = (el) => { const r = el.getBoundingClientRect(); return r.top >= top - 1 && r.bottom <= H + 1; };
    return {
      H, top, cTop: c.top, cBottom: c.bottom, plotH: c.height, scrollY: window.scrollY,
      maxScroll: document.documentElement.scrollHeight - H,
      seen: { firstRow: visEl(ins[0]), lastRow: visEl(ins[ins.length - 1]), ep1Btn: vis("ep1Btn"), ep2Btn: vis("ep2Btn"), submitBtn: vis("submitBtn") }
    };
  });
  let minFree = Infinity;
  /** one-finger swipe that starts outside the plot, in the largest free band of the screen */
  async function swipe(down) {
    const g = await geom();
    const bands = [[g.top, Math.max(g.top, Math.min(g.cTop, g.H))], [Math.min(Math.max(g.cBottom, g.top), g.H), g.H]];
    const [a, b] = bands.sort((x, y) => (y[1] - y[0]) - (x[1] - x[0]))[0];
    const free = b - a;
    // a free strip above or below the plot of at least ~1,5 finger widths, at every scroll position
    assert.ok(free >= 60, `free (scrollable) strip only ${Math.round(free)} px of ${g.H} at scrollY=${g.scrollY}`);
    minFree = Math.min(minFree, free);
    const dist = free * 0.7;
    const y = down ? a + free * 0.85 : a + free * 0.15;
    await touchDrag(30, y, down ? y - dist : y + dist);
    return g;
  }
  /** real one-finger touch drag (touchstart → touchmove… → touchend) */
  async function touchDrag(x, y0, y1) {
    const send = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts });
    await send("touchStart", [{ x, y: Math.round(y0) }]);
    for (let k = 1; k <= 10; k++) { await send("touchMove", [{ x, y: Math.round(y0 + (y1 - y0) * k / 10) }]); await sleep(16); }
    await send("touchEnd", []);
    await sleep(250);
  }

  await step(label + ": plot ≤ 55 % of the screen height", async () => {
    await page.goto(WEB + "/index.html");
    await page.locator("#app").waitFor();
    const g = await geom();
    assert.ok(g.plotH <= 0.55 * g.H + 1, `plot ${g.plotH} px of ${g.H}`);
  });
  await step(label + ": a swipe on the plot moves the cursor, not the page (by design)", async () => {
    await page.locator("#plotBox").scrollIntoViewIfNeeded();
    const g = await geom();
    const yMid = (Math.max(g.cTop, g.top) + Math.min(g.cBottom, g.H)) / 2;
    await touchDrag(200, yMid, yMid - 120);
    assert.equal((await geom()).scrollY, g.scrollY, "page did not scroll");
    assert.match(await readout(page), /V = [\d,]+ cm³/, "the cursor moved instead");
    await page.evaluate(() => window.scrollTo(0, 0));
  });
  await step(label + ": swiping outside the plot reaches table, EP buttons and Beküldés, top to bottom and back", async () => {
    const seen = {};
    let g = await geom(), shotTaken = false;
    for (let k = 0; k < 80 && g.scrollY < g.maxScroll - 2; k++) {
      Object.keys(g.seen).forEach((key) => { if (g.seen[key]) seen[key] = true; });
      const before = g.scrollY;
      await swipe(true);
      g = await geom();
      assert.ok(g.scrollY > before, `swipe ${k} did not scroll (stuck at ${before})`);
      if (!shotTaken && g.cTop > g.top + 20 && g.cBottom < g.H - 20) { await shot(page, label); shotTaken = true; }
    }
    Object.keys(g.seen).forEach((key) => { if (g.seen[key]) seen[key] = true; });
    assert.ok(g.scrollY >= g.maxScroll - 2, "reached the bottom of the page");
    assert.deepEqual(seen, { firstRow: true, lastRow: true, ep1Btn: true, ep2Btn: true, submitBtn: true });
    for (let k = 0; k < 80 && g.scrollY > 0; k++) {
      const before = g.scrollY;
      await swipe(false);
      g = await geom();
      assert.ok(g.scrollY < before, `upward swipe ${k} did not scroll (stuck at ${before})`);
    }
    assert.equal(g.scrollY, 0, "back at the top");
    console.log(`      (smallest free strip while scrolling: ${Math.round(minFree)} px of ${g.H} px)`);
    if (!shotTaken) await shot(page, label);
  });
  await ctx.close();
}

/* ======================================================================= *
 *  Real dataset: student types it in, teacher sees the same               *
 * ======================================================================= */
console.log("\nReal measurement (tests/fixtures/real-oxalic-acid.tsv) – student → teacher");
{
  const data = loadTsv("real-oxalic-acid.tsv");
  const NAME = "Valós Adat Vera";
  const ctx = await browser.newContext({ ...iPhone, locale: "hu-HU" });
  await useConfig(ctx, fake.url, true);
  const page = await ctx.newPage();
  const t = await touch(page);
  let studentView = null;

  await step("real data: typed in with decimal commas (rows edited and added like a student)", async () => {
    await page.goto(WEB + "/index.html");
    await page.fill("#nameInput", NAME);
    await page.click("#startForm button");
    await page.locator("#app").waitFor();
    for (let k = 0; k < data.length; k++) {
      if (k >= await page.locator("#dataBody tr").count()) await page.click("#addRowBtn");
      const v = page.locator('input[data-f="v"]').nth(k), i = page.locator('input[data-f="i"]').nth(k);
      if ((await v.inputValue()) !== data[k].v) { await v.fill(""); await v.pressSequentially(data[k].v); }
      await i.pressSequentially(data[k].i);
    }
    assert.equal(await page.locator("#pointCount").innerText(), "43 mérési pont");
    const d = await page.$$eval("#dataBody output", (els) => els.map((e) => e.textContent));
    const byV = (v) => d[data.findIndex((r) => r.v === v)];
    assert.equal(byV("0,00"), ""); assert.equal(byV("30,00"), "");
    assert.equal(byV("1,00"), "0,0000");
    assert.equal(byV("2,00"), "−0,0150");
    assert.equal(byV("8,50"), "−0,0300");
    assert.equal(byV("12,00"), "0,0000");
    assert.equal(byV("14,00"), "0,1067");
    assert.equal(byV("18,00"), "0,1000");
    assert.equal(byV("24,00"), "0,1200");
  });

  await step("real data: current axis fits the data (≈ 16,8 – 18,1 mA), reset zoom returns to it", async () => {
    const home = () => page.evaluate(() => document.getElementById("plot").__labPlot.home);
    const view = () => page.evaluate(() => document.getElementById("plot").__labPlot._view());
    const h = await home();
    assert.ok(Math.abs(h.yL.min - 16.772) < 1e-9 && Math.abs(h.yL.max - 18.068) < 1e-9, JSON.stringify(h.yL));
    assert.equal(h.x.min, 0, "volume axis still starts at 0");
    assert.ok(h.yR.min < 0 && h.yR.max > 0.12, "derivative axis unchanged (negative range included)");
    await page.locator("#plotBox").scrollIntoViewIfNeeded();
    const c = await plotPos(page, 15, 0);
    await t.pinch(c.x, c.y, 80, 220, 8, 1);         // diagonal pinch: zooms both axes
    const z = await view();
    assert.ok(z.yL.max - z.yL.min < h.yL.max - h.yL.min, "zoomed in on the current axis");
    assert.ok(z.yL.min >= h.yL.min - 1e-9 && z.yL.max <= h.yL.max + 1e-9, "zoom stays inside the fitted range");
    await page.click("#resetZoomBtn");
    assert.deepEqual(await view(), { x: h.x, yL: h.yL, yR: h.yR }, "reset zoom → automatic range");
  });

  await step("real data: EP1 near 12 cm³ and EP2 by dragging, both saved", async () => {
    await page.click("#ep1Btn");
    let a = await plotPos(page, 9, 0), b = await plotPos(page, 12, 0);
    await t.drag(a.x, a.y, b.x, b.y, 10);
    await page.click("#epSaveBtn");
    await page.click("#ep2Btn");
    a = await plotPos(page, 20, 0); b = await plotPos(page, 24, 0);
    await t.drag(a.x, a.y, b.x, b.y, 10);
    await page.click("#epSaveBtn");
    const st = await page.evaluate(() => JSON.parse(localStorage.getItem("oxalsav_state")));
    assert.ok(Math.abs(st.ep1.v - 12) < 0.15 && Math.abs(st.ep1.d) < 0.01, JSON.stringify(st.ep1));
    assert.ok(Math.abs(st.ep2.v - 24) < 0.15 && st.ep2.d > 0.1, JSON.stringify(st.ep2));
    await showBelowTopbar(page, "plotCard");
    const p = await plotPos(page, 24, 0);
    await t.tap(p.x, p.y);
    await shot(page, "30_real_student_plot_derivative");
  });

  await step("real data: plot without the derivative (cursor on the Ĩ curve)", async () => {
    await page.click(".switch");
    const p = await plotPos(page, 12, 0);
    await t.tap(p.x, p.y);
    assert.match(await readout(page), /Ĩ = 16,880 mA/);
    await showBelowTopbar(page, "plotCard");
    await shot(page, "31_real_student_plot_current");
    await page.click(".switch");
    // canvas axis titles with Ĩ, at device resolution
    await showBelowTopbar(page, "plotBox");
    const box = await page.locator("#plot").boundingBox();
    await page.screenshot({ path: join(SHOTS, "33_axis_titles_zoom.png"), clip: { x: box.x, y: box.y, width: box.width, height: 26 }, scale: "device" });
  });

  await step("real data: Beküldés", async () => {
    await page.click("#submitBtn");
    await page.waitForFunction(() => document.getElementById("submitState").classList.contains("ok"), null, { timeout: 8000 });
    studentView = await page.evaluate(() => ({
      rows: [...document.querySelectorAll("#dataBody tr")].map((tr) => [tr.querySelector('[data-f="v"]').value, tr.querySelector('[data-f="i"]').value, tr.querySelector("output").textContent]),
      series: document.getElementById("plot").__labPlot.series,
      home: document.getElementById("plot").__labPlot.home,
      eps: document.getElementById("plot").__labPlot.eps,
      ep1: document.getElementById("ep1Val").innerText, ep2: document.getElementById("ep2Val").innerText
    }));
  });
  await ctx.close();

  const tctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await useConfig(tctx, fake.url, true);
  const tp = await tctx.newPage();
  await step("real data: teacher detail shows the same table, plot and points", async () => {
    await tp.goto(WEB + "/teacher.html");
    await tp.fill("#pwInput", "titok");
    await tp.click("#loginBtn");
    await tp.locator("#listBody tr", { hasText: NAME }).click();
    await tp.locator("#detailView").waitFor();
    const tv = await tp.evaluate(() => ({
      rows: [...document.querySelectorAll("#dBody tr")].map((tr) => [tr.cells[1].textContent, tr.cells[2].textContent, tr.cells[3].textContent]),
      series: document.getElementById("dPlot").__labPlot.series,
      home: document.getElementById("dPlot").__labPlot.home,
      eps: document.getElementById("dPlot").__labPlot.eps,
      ep1: document.getElementById("dEp1").innerText, ep2: document.getElementById("dEp2").innerText,
      head: document.querySelector("#detailView .data-table thead").innerText
    }));
    assert.deepEqual(tv.rows, studentView.rows, "same table incl. derivative column");
    assert.deepEqual(tv.series, studentView.series, "same plot data");
    assert.deepEqual(tv.home, studentView.home, "same automatic axis ranges as the student");
    const viaJson = (x) => JSON.parse(JSON.stringify(x)); // −0 and 0 are the same value on the server
    assert.deepEqual(viaJson(tv.eps), viaJson(studentView.eps), "same equivalence points");
    const part = (s) => s.match(/V = [\d,]+ cm³/)[0] + " | " + s.match(/dĨ\/dV = [−\d,]+ mA\/cm³/)[0];
    assert.equal(part(tv.ep1), part(studentView.ep1));
    assert.equal(part(tv.ep2), part(studentView.ep2));
    assert.match(tv.head, /Ĩ \/ mA/);
    assert.match(tv.head, /dĨ\/dV/);
    const s = fake.gas.post({ action: "list", password: "titok" }).students.find((x) => x.name === NAME);
    assert.equal(s.submitted, true);
    assert.equal(s.points, 43);
    await shot(tp, "32_real_teacher_detail");
  });
  await tctx.close();
}


await browser.close();
web.close();
fake.server.close();

const failed = results.filter((r) => !r[0]);
console.log(`\n${results.length - failed.length}/${results.length} UI checks passed. Screenshots: ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
