/* ==========================================================================
 *  KONFIGURÁCIÓ  –  ezt a fájlt kell szerkeszteni telepítéskor
 *  CONFIGURATION –  this is the only file you need to edit when deploying
 * ========================================================================== */
window.LAB_CONFIG = {

  /* ------------------------------------------------------------------------
   * 1) Apps Script web app URL (Deploy → Web app → URL, ends with /exec).
   *    Leave it empty ("") to run in MOCK mode (no server, data stays in
   *    this browser). You can also force mock mode with ?mock=1 in the URL.
   * --------------------------------------------------------------------- */
  API_URL: "https://script.google.com/macros/s/AKfycbxgXd3y3NeIp2A7JDL57DPLa2mc2kezfqAlKD4s8kV4W2ODMHeeTB70jNdxmzYNPA-ydQ/exec",

  /* ------------------------------------------------------------------------
   * 2) ★★★ PRESET NaOH VOLUMES (cm³) ★★★
   *    These prefill column 1 of the data table for a NEW student.
   *    Students can edit them, add and delete rows.
   *    Use a dot as decimal separator here (JavaScript numbers).
   *    (Changing this list does not alter the tables of students who
   *    have already started – their own data is kept.)
   * --------------------------------------------------------------------- */
  PRESET_VOLUMES: [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    11, 12, 13, 14, 15, 16, 17, 18, 19, 20
  ],

  /* ------------------------------------------------------------------------
   * 3) Page texts that you may want to change
   * --------------------------------------------------------------------- */
  TITLE: "Oxálsav konduktometriás titrálása",

  /* ------------------------------------------------------------------------
   * 4) Save timing (milliseconds). The defaults keep 70 simultaneous
   *    students well inside Apps Script quotas – change only if needed.
   * --------------------------------------------------------------------- */
  SAVE_DEBOUNCE_MS: 5000,      // wait this long after the last change
  SAVE_MIN_INTERVAL_MS: 20000, // at least this much time between two server saves
  REQUEST_TIMEOUT_MS: 25000    // give up a request after this long (then retry)
};
