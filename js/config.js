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
    0, 1, 2, 3, 4, 5, 6, 7, 8, 8.5, 9, 9.5, 10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14,
    15, 16, 17, 17.5, 18, 18.5, 19, 19.5, 20, 20.5, 21, 21.5, 22, 22.5, 23, 24, 25
  ],

  /* ------------------------------------------------------------------------
   * 3) Page texts that you may want to change
   * --------------------------------------------------------------------- */
  TITLE: "Oxálsav konduktometriás titrálása",

  /* ------------------------------------------------------------------------
   * 4) Save timing (milliseconds) for normal autosaves. The defaults keep
   *    70 simultaneous students within what the Apps Script backend can write
   *    (measured – see README). Beküldés, EP Mentés/Törlés and hiding or
   *    closing the page always save immediately. Change only if needed.
   * --------------------------------------------------------------------- */
  SAVE_DEBOUNCE_MS: 10000,     // wait this long after the last change
  SAVE_MIN_INTERVAL_MS: 60000, // at least this much time between two server autosaves
  SAVE_MAX_WAIT_MS: 60000,     // …but autosave no later than this after the first unsaved change,
                               //    even while the student keeps typing
  REQUEST_TIMEOUT_MS: 25000    // give up a request after this long (then retry)
};
