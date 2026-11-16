# Terv – Oxálsav konduktometriás titrálás webapp

(Plan written in English for the teacher; all student/teacher-facing UI text is Hungarian.)

## Architecture

| Part | Choice | Notes |
|---|---|---|
| Frontend | Static HTML/CSS/JS on GitHub Pages, no build step | **No CDN libraries at all** – see "Deviation" below |
| Backend | Google Apps Script web app (`doPost`) + Google Sheet | One row per student, `LockService` around every write |
| Transport | `fetch` POST with `Content-Type: text/plain` | "Simple request" → no CORS preflight; Apps Script answers via its usual 302 → googleusercontent redirect, which `fetch` follows |
| Mock mode | `?mock=1` in the URL (or empty `API_URL`) | localStorage-backed fake server with latency and optional random failures (`&fail=0.3`) – student *and* teacher page work offline |

### Deviation from the brief (one, small)
The plot is a **hand-written canvas component** (`js/plot.js`, ~600 lines) instead of Chart.js/Plotly.
Reason: the gesture rules (one finger = cursor, two fingers = pinch/pan, never both, first-quadrant clamp,
dual axes with a negative right axis, snapping cursor) fight the gesture handling of every chart library
I know (chartjs-plugin-zoom + Hammer.js in particular behaves badly on iOS Safari). A custom canvas gives
exact control, zero external dependencies, and the app keeps working if a CDN is blocked on the school Wi-Fi.

## Files

```
index.html            student page
teacher.html          teacher page
css/style.css         shared styles (mobile first, portrait + landscape)
js/config.js          ★ the ONLY file you need to edit: API_URL + PRESET_VOLUMES + timing
js/core.js            pure logic (parsing, derivative, interpolation, row ops, formatting) – unit-tested
js/api.js             backend client (real Apps Script + mock), retry/backoff, sendBeacon on page hide
js/plot.js            canvas plot: dual axes, cursor, pinch zoom/pan, EP markers
js/student.js         student page controller
js/teacher.js         teacher page controller
apps-script/Code.gs   backend
tests/core.test.js    unit tests (node --test)
tests/ui/*            Playwright mobile UI tests + screenshots
README.md             deployment guide + pre-lab checklist
```

## Key decisions

* **Student key** = `deviceId + "|" + name`. `deviceId` is a random 12-char ID in localStorage, generated once per phone/browser.
* **State model** (stored as JSON in the sheet): raw input strings per row (what the student typed, e.g. `"12,5"`),
  saved EPs `{v, dIdV, I}`, derivative-toggle, submitted flag, `rev` (monotonic save counter).
* **Derivative**: computed on the valid points (both V and I parse) **sorted by volume**; for each point, the nearest
  valid neighbours on either side are used: `d = (I₊ − I₋)/(V₊ − V₋)`. First/last valid points → empty. Zero denominator → empty.
  Rows with a missing/invalid value get an empty derivative and are skipped by their neighbours. Uneven spacing is handled naturally.
  If the table is not in increasing volume order a hint + "Sorba rendezés" button appears.
* **Cursor**: only x matters; y = linear interpolation on the derivative points (or current points if the derivative is hidden),
  x clamped to the data range. Saving an EP stores volume + interpolated dI/dV + interpolated I.
* **Gestures**: Pointer Events + `touch-action:none` on the canvas. One pointer → cursor. When a second pointer arrives the
  cursor is restored to where it was before the gesture and we switch to pinch/pan; after a pinch, the remaining finger is ignored
  until all fingers are lifted. Pinch scales each axis by the finger spread along that axis (horizontal pinch → x zoom only).
  View is clamped to the auto-scaled "home" range, so the first quadrant is always what you see. Desktop: mouse wheel zoom.
* **Save pipeline**: every change → localStorage immediately → server save after 5 s debounce, at most one request in flight,
  ≥ 20 s between server saves per student (adaptive: 40–60 s if the server is slow), skipped if nothing changed,
  exponential backoff on errors (5 → 60 s, jitter). "Beküldés" saves immediately. `sendBeacon` on page hide if unsaved.
  Server ignores out-of-order writes using `rev`.
* **Quota estimate**: worst case 70 students all typing continuously = 3.5 req/s; each execution ≈ 0.5–1.5 s → ≈ 5 concurrent
  executions (limit 30). The lock is held only for find-row + one `setValues` (row lookup cached in `CacheService`).
* **Teacher**: password stored in Script Properties (`TEACHER_PASSWORD`), never in the frontend. List, sort, filter, auto-refresh,
  read-only detail view (same table + plot), CSV export (summary, and all measurement points) with `;` separator and decimal comma for Hungarian Excel.

## Test plan
1. Unit tests: number parsing, derivative (even/uneven spacing, gaps, unsorted, duplicates), interpolation, row add/delete/sort, formatting.
2. Playwright, mock backend, iPhone-size portrait + landscape, Pixel-size portrait: start screen, data entry, plot, tap, drag,
   pinch (CDP multi-touch), EP save, submit, reload restore, server failure + retry, teacher list/detail/CSV.
