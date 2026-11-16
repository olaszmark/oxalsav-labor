# Oxálsav konduktometriás titrálás – mobile lab web app

This is a mobile web app for evaluating a conductometric titration of oxalic acid with NaOH. Students enter
V(NaOH) and Ĩ readings on their phones. The app computes the three-point derivative and plots both curves.
Students then pick the two equivalence points themselves and submit. The teacher sees every student live
on a password-protected page. All user-facing text is in Hungarian.

* **Frontend:** static HTML/CSS/JS with no build step and no external libraries, hosted on **GitHub Pages**.
* **Backend:** a **Google Apps Script** web app and a **Google Sheet**. Every save is appended as a new row (a log); the teacher page, the CSV exports and the optional **Összesítő** tab show each student's newest version.

---

## 1. Folder contents

| Path | What it is | Needed on GitHub Pages? |
|---|---|---|
| `index.html` | Student page | **yes** |
| `teacher.html` | Teacher page | **yes** |
| `css/style.css` | Styles | **yes** |
| `js/config.js` | ★ **The only file you edit**: `API_URL`, `PRESET_VOLUMES`, timings | **yes** |
| `js/core.js`, `js/api.js`, `js/plot.js`, `js/student.js`, `js/teacher.js` | App code | **yes** |
| `apps-script/Code.gs` | Backend: paste into Apps Script | no (harmless; contains no secrets) |
| `tests/` | Unit tests, UI tests, load test, `fixtures/real-oxalic-acid.tsv` (screenshots are generated, not in git) | no |
| `scripts/bump-version.mjs` | `npm run bump`: new cache-busting version (see 4.6b) | no |
| `PLAN.md` | Design notes | no |

---

## 2. Try it locally first (mock mode, no server needed)

Mock mode stores everything in the browser's localStorage, so the full student + teacher workflow runs on one computer.

```bash
npm run serve
```

(or, without Node: `python -m http.server 8080` in this folder)

* Student page: <http://localhost:8080/index.html?mock=1>
* Teacher page: <http://localhost:8080/teacher.html?mock=1>. The mock password is **`tanar`**.
* To simulate a flaky network, use <http://localhost:8080/index.html?mock=1&fail=0.5>. Half of all saves then fail, and you can watch the "Hiba – újrapróbálás" retry.

Mock mode is also used automatically while `API_URL` in `js/config.js` is empty. A yellow **TESZT MÓD** banner is shown whenever mock mode is active.

---

## 3. Set the preset volumes

Open `js/config.js` and edit `PRESET_VOLUMES`. Use a **dot** as the decimal separator here, because these are JavaScript numbers:

```js
PRESET_VOLUMES: [0, 1, 2, 3, 4, 5, 6, 7, 7.5, 8, 8.5, 9, 10, /* … */ 20],
```

These values prefill column 1 for a *new* student. Students who have already started keep their own table.

---

## 4. Deployment, step by step

### 4.1 Create the Google Sheet
1. Go to <https://sheets.google.com>, create a blank spreadsheet and name it, e.g. *Oxálsav labor – eredmények*.
2. Use the account that should **own the data**. See the note on school (Workspace) accounts in 4.4.

### 4.2 Paste the backend script
1. In the Sheet: **Extensions → Apps Script**.
2. Delete the sample `function myFunction() {}`, paste the full contents of `apps-script/Code.gs` and click **Save** (💾).
3. Optionally rename the project (top left), e.g. *Oxálsav labor backend*.

### 4.3 Set the teacher password
1. In the Apps Script editor: **Project Settings** (⚙ gear icon, left side) → scroll to **Script properties** → **Add script property**.
2. Property: `TEACHER_PASSWORD`. Value: your password. → **Save script properties**.
   ⚠ **Do not use `tanar`.** That is the mock-mode password, and it is public in this repository.
   Don't use `titok` either, which the automated tests use. Choose a password that appears in no file.

The password lives only on the server. It is never in the frontend code or on GitHub.

### 4.4 Authorize and self-test
1. Back in the **Editor** (`< >` icon), choose the function **`setup`** in the toolbar dropdown and click **Run**.
2. Google asks for authorization: **Review permissions** → choose your account → *"Google hasn't verified this app"* → **Advanced** → **Go to … (unsafe)** → **Allow**. This warning is normal for your own scripts.
3. The execution log should say `Sheet "Adatok" OK. TEACHER_PASSWORD is set.` A tab named **Adatok** now exists in the Sheet.
4. Select **`selfTest`** → **Run**. The log must end with **`SELF TEST PASSED`**. The test rows are deleted automatically.
5. Reload the Sheet: a menu **Oxálsav labor → Összesítő frissítése** appears (writes one row per student to the **Összesítő** tab; see section 7).

### 4.5 Deploy as a web app
1. **Deploy → New deployment**.
2. Click the ⚙ next to *Select type* → **Web app**.
3. Description: e.g. `v1`. **Execute as: Me**. **Who has access: Anyone**.
4. Click **Deploy** and copy the **Web app URL**. It looks like `https://script.google.com/macros/s/AKfy…/exec`.
5. Paste that URL into a browser tab. You should see something like `{"ok":true,"service":"oxalsav-labor","time":"…"}`.

> **School / Workspace accounts:** some admins hide the *"Anyone"* option and only allow *"Anyone within <school>"*.
> With that setting every student would have to be signed in to a school Google account in their phone browser, and the saves would fail otherwise.
> If you don't see *"Anyone"*, deploy from a personal Gmail account or ask the admin.

> **Updating the script later:** saving the code is **not** enough. Go to **Deploy → Manage deployments → ✏ (edit) → Version: New version → Deploy**.
> The URL stays the same. A *New deployment* would create a *new* URL instead.

### 4.6 Put the URL into the frontend
In `js/config.js`:

```js
API_URL: "https://script.google.com/macros/s/AKfy…/exec",
```

### 4.6b Bump the version (cache-busting) – every time you change a file
Phones keep CSS/JS files in their cache. Every reference in `index.html` / `teacher.html` therefore carries a version, e.g. `js/config.js?v=2026.11.16-1`.
After **any** change (for example a new `API_URL` in `config.js`), give it a new version before pushing:

```bash
npm run bump
```

This sets `?v=` to the current date and time in both HTML files. You can also edit the `?v=` values by hand, as long as they all stay identical.
`npm test` checks that they match. The HTML pages themselves are cached by GitHub Pages for at most 10 minutes.

### 4.7 Publish on GitHub Pages
1. On <https://github.com>: **New repository**, e.g. `oxalsav-labor`, **Public**. GitHub Pages on private repos requires a paid plan.
2. Upload the files. The simplest way: **Add file → Upload files** and drag in `index.html`, `teacher.html` and the `css` and `js` folders.
   Uploading the whole folder is fine too, but **do not upload `node_modules/`**.
   With git instead:
   ```bash
   git init && git add . && git commit -m "Oxálsav labor app"
   git branch -M main
   git remote add origin https://github.com/<you>/oxalsav-labor.git
   git push -u origin main
   ```
3. Repository **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `main`, folder `/ (root)` → Save**.
4. After about 1 minute the site is live:
   * Student page: `https://<you>.github.io/oxalsav-labor/`
   * Teacher page: `https://<you>.github.io/oxalsav-labor/teacher.html`. Don't put this link in the QR code.
5. Open the student page and confirm that **no** yellow TESZT MÓD banner is shown. That banner would mean `API_URL` is still empty.

GitHub Pages caches files for up to about 10 minutes. After changing `config.js`, wait a little or hard-reload (Ctrl+F5).

### 4.8 Make a QR code
Use any of these. None needs an online QR service:
* **Chrome / Edge on a computer:** open the student page → right-click the page (or use the address-bar share icon) → **Create QR code** → **Download**.
* **Node:** `npx qrcode -o qr.png "https://<you>.github.io/oxalsav-labor/"`
* **Android Chrome:** ⋮ → Share → QR code.

Print the QR code large enough (at least 6 cm) or project it, and add the URL in text below it as a fallback.

---

## 5. Pre-lab checklist ✅

**One or more days before**
- [ ] `selfTest` in Apps Script prints `SELF TEST PASSED`.
- [ ] The Web app URL opens in a browser and shows `{"ok":true,…}`.
- [ ] The student page on GitHub Pages shows **no** TESZT MÓD banner.
- [ ] Enter a few values on your own phone and wait for **"Mentve hh:mm"** (green) in the top-right corner (autosave comes 10 s after your last change, at most once a minute; press **Beküldés** to save at once). Check that rows appear in the **Adatok** tab.
- [ ] The teacher page opens with your password and the test student is visible. The detail view shows the table and plot.
- [ ] **Several phones at once:** have 3–5 people (colleagues, or students at the start of class) use the page simultaneously, including at least one **iPhone (Safari)** and one **Android (Chrome)**. Try:
      a tap on the plot, a finger drag, a two-finger pinch, both EP selections, Beküldés, and a page reload (data must come back).
- [ ] **Last edit reaches the server** (on one iPhone and one Android phone): change a value, then *immediately* (within 2 s)
      a) lock the phone, b) switch to another app, c) close the tab via the tab switcher. Each time, refresh the teacher page:
      the changed value must be visible in the detail view within a few seconds, without reopening the student page.
- [ ] **Scrolling on a small phone** (e.g. iPhone SE or any phone with a ~4,7" screen), portrait and landscape: scroll from the top of the page
      to the Beküldés button and back by swiping *beside* the plot. You must never get stuck.
- [ ] Optional **load test** (needs Node.js; run it against a **separate test deployment**, see section 9): `node tests/load-test.mjs "<test /exec URL>"`.
      It simulates a realistic lab (70 students, a teacher polling the list, the Beküldés burst) and prints a PASS/FAIL table.
      Then delete the whole *Adatok* tab of the test Sheet (it is re-created automatically).
- [ ] Delete your own test rows from the **Adatok** tab.
- [ ] The QR code is printed and scanned once with a phone.
- [ ] `PRESET_VOLUMES` in `config.js` match the lab protocol.

**On the day**
- [ ] The school Wi-Fi allows `script.google.com` and `*.github.io`. Mobile data works as a fallback.
- [ ] Tell students: *enter your full name exactly once; use your own phone; don't use a private/incognito tab; one finger on the plot moves the cursor, two fingers zoom; to scroll the page, swipe above or below the plot*.
- [ ] Keep the teacher page open with **automatikus (30 s)** refresh to see who is saving.

**After the lab**
- [ ] Export **CSV – összesítő** and **CSV – összes mérési adat**. They use semicolons and decimal commas, so they open directly in Hungarian Excel.
- [ ] To start fresh for the next group, **rename** the *Adatok* tab (e.g. `2026-11-20 11.B`). A new empty *Adatok* tab is created at the next save.
      The teacher page always shows the *Adatok* tab only. (Rename or delete an old *Összesítő* tab too; the menu creates a new one.)

---

## 6. Short student instructions (Hungarian, to project or print)

> 1. Olvasd be a QR-kódot, és nyisd meg az oldalt a **saját telefonodon** (ne privát/inkognitó lapon).
> 2. Írd be a **teljes neved**, majd nyomd meg a **Kezdés** gombot.
> 3. Írd be a táblázatba a mért **áramerősségeket** (Ĩ / mA). A térfogatok előre ki vannak töltve, de átírhatók; sort hozzáadhatsz és törölhetsz.
> 4. A grafikonon **egy ujjal** mozgathatod a kurzort, **két ujjal** nagyíthatsz. Görgetni a grafikon fölött vagy alatt tudsz.
> 5. **1. ekvivalenciapont kijelölése** → keresd meg, ahol a derivált = 0 → **Mentés**.
>    **2. ekvivalenciapont kijelölése** → keresd meg a derivált maximumát → **Mentés**.
> 6. Végül nyomd meg a **Beküldés** gombot. A jobb felső sarokban a zöld „Mentve óó:pp” feliratnak kell látszania.
> 7. A jobb felső sarokban: szürke **„Mentve a telefonon”** = az adataid biztonságban vannak a telefonon, és automatikusan elküldjük őket; zöld **„Mentve óó:pp”** = megérkeztek a tanárhoz.
>    Piros felirat = probléma van, de semmi sem veszett el, az alkalmazás tovább próbálkozik – ha sokáig piros marad, szólj a tanárnak.

---

## 7. How it works (details you may want to know)

**Student identity.** Each phone/browser gets a random 12-character device ID in localStorage. The server key is `deviceId|name`,
so two students with the same name never overwrite each other. The teacher list shows the device ID next to duplicate names.
If a student switches phones, the new phone creates a new row. The old row stays visible to the teacher.

**Saving.**
* Every change is written to **localStorage immediately**, so a reload or a closed tab restores everything.
* A server autosave happens **10 s after the last change** (each change restarts this wait). There is never more than one request in flight per student, and at most one autosave **every 60 s** per student.
* Unchanged data is not re-sent. On failure the app retries with exponential backoff (5 s → 60 s, with jitter).
  The status chip (top right): grey **"Mentve a telefonon"** while the data is on the phone and the next autosave is scheduled, grey **"Küldés…"** while a save is being sent,
  green **"Mentve hh:mm"** when the server confirmed it, red **"Hiba – újrapróbálás"** / **"Nincs internet – újrapróbálás"** on errors.
  If the server only answers **busy** (or times out / is overloaded), the phone keeps showing **"Küldés…"** for the first two retries; from the third failure, or for any other error, it shows **"Hiba – újrapróbálás"**.
* **Immediate saves** that bypass the 10 s / 60 s throttle:
  * **Beküldés**, and **Mentés** or **Törlés** of an equivalence point. If another save is still on its way, the new one goes out right after it.
  * **The page becoming hidden or closed:** tab closed, app switch, screen lock, or the tab switcher (`visibilitychange → hidden` and `pagehide`).
    The latest state goes out at once with `navigator.sendBeacon`, or `fetch(…, {keepalive: true})` as a fallback, which both survive the page being frozen or unloaded.
    This also happens while a normal save is in flight. The body is `text/plain`, so there is no CORS preflight, and Apps Script runs `doPost` before its 302 redirect, so the redirect doesn't matter.
    When the page becomes visible again, a normal confirmed save follows.
  * **The connection coming back** (the browser's `online` event): the failed save is retried at once, without waiting for the backoff.
* **No overwriting with old data:** every save carries a revision number that increases on each send from that phone (kept in localStorage, with an in-memory fallback).
  Every save is stored as a new row; when reading, the server takes the row with the **highest revision** per student (for an equal revision, the later row).
  An older save that arrives late is therefore stored but ignored, so it can never hide a newer one.

**Write path and quotas.** A save prepares everything first and then holds the script lock (`LockService`) only for one `appendRow`
plus `SpreadsheetApp.flush()` – no reads. If the lock is not free within 8 s, the server answers `busy` and the app retries.
Teacher reads (list, detail view, CSV) take **no** lock. Apps Script allows 30 simultaneous executions per user (Google's quota page).
With the 10 s / 60 s timing, 70 students produce at most about 1,2 autosaves/s, and a Beküldés burst of 70 within a minute about the same.
The realistic load test (section 9) measures what your deployment actually handles.

**CORS.** Requests are `POST` with `Content-Type: text/plain`. That makes them "simple requests" with no preflight, which Apps Script couldn't answer anyway.
The browser follows Apps Script's 302 redirect to `script.googleusercontent.com` automatically.

**Sheet tabs.**
* **Adatok** – the log: **one row per save** (about 20–30 rows per student per lab). Columns: Kulcs · Név · Eszköz · Utolsó mentés (time of that save) ·
  Beküldve · Beküldés ideje · Beküldés után módosítva · 1. EP V · 1. EP dĨ/dV · 2. EP V · 2. EP dĨ/dV · Mérési pontok · Rev · Állapot (JSON).
  The JSON column holds the full student state of that save. You can sort or filter the tab freely: rows are matched by Kulcs and Rev, not by position.
  Avoid editing columns A (Kulcs) and M (Rev). To delete one student, delete **all** of their rows (Data → Create a filter → Név).
* **Összesítő** – optional, one row per student (newest version) plus *Mentések száma* (number of saves). Created or refreshed on demand with
  the Sheet menu **Oxálsav labor → Összesítő frissítése**; it is not updated automatically (a live formula would slow down every save).

**Derivative.** `(dĨ/dV)ᵢ = (Ĩᵢ₊₁ − Ĩᵢ₋₁) / (Vᵢ₊₁ − Vᵢ₋₁)`, computed on all rows where both V and Ĩ are valid numbers, **in increasing volume order**.
* **Empty or invalid rows are skipped.** Such a row gets an empty derivative cell, and its neighbours are calculated from the nearest *filled* rows on either side.
  Example: if the Ĩ value at 9,00 cm³ is still empty, the derivative at 8,50 cm³ is calculated from the rows at 8,00 and 9,50 cm³, i.e. `(Ĩ(9,50) − Ĩ(8,00)) / 1,50`.
  Students can therefore fill the table in any order. The derivative column and the plot update as soon as a row is complete.
* The first and last valid points have no derivative.
* Uneven spacing is handled by the formula itself. Equal neighbour volumes give an empty cell, never a division by zero.
* If the table is not in volume order, a hint with a **Sorba rendezés** button appears.
* Input accepts `12,5` and `12.5`. Negative numbers or text are marked red and ignored.

**Cursor.** Only the x position of a touch matters. The cursor snaps to the derivative curve, which is linearly interpolated between derivative points.
It snaps to the current curve instead when the derivative is hidden. The x value is clamped to the curve's range.
Saving an EP stores the volume plus the interpolated dĨ/dV and Ĩ at that volume. If the student later edits the data, those values are recomputed for the same volume.

**Gestures.**
* One finger (or the mouse) moves the cursor.
* A second finger switches to pinch/pan. If it arrives within 0.35 s, the cursor jumps back to where it was, so starting a pinch never moves the cursor.
* A horizontal pinch zooms only the x axis, a vertical pinch only y, and a diagonal pinch both.
* **Axes:** volume from 0 to max + 10 %; Ĩ fitted to the data, from min − 10 % to max + 10 % of the spread (never below 0); dĨ/dV including its negative range and the dashed zero line. The teacher detail view uses the same axis logic. You can't zoom out beyond this automatic view.
* **⟲ Teljes nézet** resets the zoom. On a computer, the mouse wheel zooms (Shift+wheel zooms x only).
* Because one finger on the plot is the cursor, the page can't be scrolled *on* the plot. In the single-column layout (phones in portrait, small phones in landscape),
  the plot is capped at **55 % of the visible screen height**, so there is always a strip above or below it to swipe on.

**Plot library.** None. The plot is a small hand-written canvas component (`js/plot.js`), which gives exact control over the touch gestures on iOS
and Android. The app has no CDN dependencies, so it keeps working if the school network blocks a CDN.

**Privacy.** Student names and data are stored only in your Google Sheet. GitHub hosts only the code.

---

## 8. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Students see **"Hiba – újrapróbálás"** permanently | Open the Web app URL in a browser. If it asks for a login, access is not *"Anyone"*. If the URL is wrong, check `API_URL`. After changing `Code.gs`, deploy a **new version** (4.5). |
| Teacher page: *"nincs beállítva a TEACHER_PASSWORD"* | Add the script property (4.3). No redeploy is needed. |
| Teacher page: *"Hibás jelszó"* | The password is case-sensitive. Check for spaces at the end of the property value. |
| Yellow **TESZT MÓD** banner on the live site | `API_URL` is empty in the deployed `config.js`, or GitHub Pages still serves the old file (wait ~10 min). |
| A student's data vanished after a reload | They were in a private/incognito tab, or cleared browser data. Their last server save is still visible on the teacher page. |
| Two rows for one student | They used two phones/browsers, or typed their name differently. Both rows are kept, so check the times. |
| Need to give a student a fresh start on the same phone | Footer link **"Másik tanuló ezen a telefonon"**. The old row stays on the server. |

---

## 9. Tests

```bash
npm install                      # installs Playwright (dev only)
npx playwright install chromium webkit  # downloads the headless browsers (first time only)
npm test                         # 51 unit tests: parsing, derivative, interpolation, rows, axes, your real dataset + Code.gs against fake Google services
npm run test:ui                  # end-to-end checks (~8 min), screenshots in tests/ui/screenshots/
node tests/live-check.mjs https://<user>.github.io/<repo>/ --expect-api   # smoke test of the LIVE site on phone-sized browsers
```

**Load test** (against a separate **test** deployment – it writes `TERHELÉSTESZT` rows):

```bash
node tests/load-test.mjs "<test /exec URL>" --mode bench      # ~1 min: lock hold time per save (median, max), estimated capacity
node tests/load-test.mjs "<test /exec URL>"                   # ~13 min: realistic lab + teacher poller + Beküldés burst, PASS/FAIL table
node tests/load-test.mjs "<test /exec URL>" --mode stress     # the old all-at-once stress test
```

The realistic mode asks for the test deployment's teacher password with a hidden prompt (or reads `LOADTEST_PASSWORD`). Its pass criteria:
nothing lost (the server's newest version equals every student's last save), every save eventually succeeds, all submitted,
server delay (send → confirmed, incl. retries) p95 ≤ 30 s and max ≤ 90 s, Beküldés burst confirmed ≤ 2 min after the last press (p95 ≤ 30 s),
≤ 10 % failed attempts, no student shows "Hiba" for more than 60 s in a row, teacher list ≤ 5 s, CSV "all" ≤ 20 s.
It also reports the time until "Mentve" from the edit (which includes the deliberate 10 s / 60 s delay) and whether teacher reads slow down saves.

The UI tests run the real frontend against `Code.gs` itself. It is executed in Node with fake `SpreadsheetApp`, `LockService` and `CacheService`
behind a local server that imitates Apps Script's POST → 302 → GET behaviour. The tests use real touch events (tap, drag, two-finger pinch) through
the Chrome DevTools Protocol. They also cover the 10 s / 60 s save throttling with production timings, a simulated server outage with automatic retry,
reload/restore, and the teacher list, detail view and CSV exports.

They also test that the last change always reaches the server, with production timings:
* Beküldés, EP Mentés and EP Törlés are sent at once, even inside the 60 s window and even while another save is in flight.
* Hiding the page or closing the tab sends a beacon, text/plain with no preflight. This also runs in **WebKit**, the Safari engine.
* An older request arriving late is rejected as stale.
* A save is retried at once when the connection returns.

**Small phones:** iPhone SE (375×667) portrait and landscape are scrolled from top to bottom and back with real touch swipes beside the plot.
Every swipe must scroll, and the table, both EP buttons and Beküldés must be reached.

**Your real dataset:** `tests/fixtures/real-oxalic-acid.tsv` is checked against your hand-calculated derivatives in a unit test.
In a UI test it is typed in with decimal commas, both EPs are picked, it is submitted, and the teacher detail view is compared with the student view.

What headless tests cannot prove is the behaviour of a real phone's OS (screen lock, app switching, the iOS tab switcher). That is why the "last edit reaches the server" item is in the pre-lab checklist.
