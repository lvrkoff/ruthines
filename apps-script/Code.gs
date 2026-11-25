/** @OnlyCurrentDoc */
/**
 * Ruthines MKII: Google Sheet backend.
 *
 * Paste this whole file into Extensions > Apps Script of your Ruthines Sheet,
 * run setup() once, then Deploy > New deployment > Web app
 * (Execute as: Me, Who has access: Anyone).
 *
 * Security: the app sends the key only inside the POST body, never in a URL,
 * so it stays out of browser history and Google's request logs. After
 * MAX_FAILS wrong keys in a row, every request is refused for LOCK_MINUTES.
 * Running setup() again clears a lockout. To change the key, delete SECRET
 * under Project Settings > Script properties and run setup() again.
 *
 * The Sheet is the master copy. You can edit any tab by hand: add or rename
 * routines, add chores, fix a tick. The app picks changes up on next sync.
 *
 * Tabs
 *   Routines  one row per habit             id, name, icon, order, archived
 *   Chores    one row per recurring chore   id, name, zone, every_days, archived
 *   Checkins  one row per habit per day     date, routine_id, done, updated_at, key
 *   ChoreLog  one row per chore per day     chore_id, date, logged_at, key
 *   Checkins_YYYY  older Checkins, moved there automatically (see archiveOldLogs)
 *
 * Every value is stored as plain text so dates never shift with time zones.
 * done: 1 = done, 0 = not done. archived: empty = active, a date = archived.
 * key is filled in automatically; it is how rows are found quickly.
 */

const TABS = {
  Routines: ['id', 'name', 'icon', 'order', 'archived'],
  Chores: ['id', 'name', 'zone', 'every_days', 'archived'],
  Checkins: ['date', 'routine_id', 'done', 'updated_at', 'key'],
  ChoreLog: ['chore_id', 'date', 'logged_at', 'key'],
};

const WINDOW_DAYS = 90;   // how far back a normal sync reaches
const ARCHIVE_DAYS = 400; // Checkins older than this move to Checkins_YYYY tabs
const MAX_FAILS = 10;     // wrong keys in a row before the lockout
const LOCK_MINUTES = 15;  // how long the lockout lasts

// Example habits, added only when the Routines tab is empty. Edit or delete
// them in the Routines tab, or replace this list before running setup().
const STARTER_ROUTINES = [
  ['💧', 'Drink water'],
  ['📖', 'Read'],
  ['🚶', 'Walk'],
  ['🧹', 'Tidy desk'],
];

/* ---------- one-time setup ---------- */

/** Run once from the editor. Safe to run again: it never deletes data. */
function setup() {
  const ss = SpreadsheetApp.getActive();
  Object.keys(TABS).forEach(function (name) {
    const sh = ss.getSheetByName(name) || ss.insertSheet(name);
    prepareTab_(sh, TABS[name]);
  });

  const routines = ss.getSheetByName('Routines');
  if (routines.getLastRow() === 1) {
    const rows = STARTER_ROUTINES.map(function (r, i) {
      return [uid_(), r[1], r[0], String(i + 1), ''];
    });
    routines.getRange(2, 1, rows.length, 5).setValues(rows);
  }

  // Monthly clean-up at 03:00 on the 1st; it only moves Checkins older than ARCHIVE_DAYS.
  const hasTrigger = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'archiveOldLogs';
  });
  if (!hasTrigger) {
    ScriptApp.newTrigger('archiveOldLogs').timeBased().onMonthDay(1).atHour(3).create();
  }

  const props = PropertiesService.getScriptProperties();
  props.deleteProperty('FAILS');
  props.deleteProperty('LOCKED_UNTIL');
  if (!props.getProperty('SECRET')) {
    props.setProperty('SECRET', Utilities.getUuid().replace(/-/g, ''));
  }
  Logger.log('Your Ruthines key (keep it private): ' + props.getProperty('SECRET'));
}

function prepareTab_(sh, header) {
  sh.getRange(1, 1, sh.getMaxRows(), header.length).setNumberFormat('@');
  sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
  sh.setFrozenRows(1);
  const k = header.indexOf('key');
  if (k >= 0) sh.hideColumns(k + 1); // helper column, filled automatically
}

/* ---------- web app ---------- */

/**
 * GET: a health check only. Open the Web app URL in a browser (no key, nothing
 * added to the URL) and you should see {"ok":true,"app":"ruthines"}.
 * It never returns data and never reads a key, so keys never go in URLs.
 */
function doGet() {
  return respond_(function () {
    return { ok: true, app: 'ruthines', message: 'The script is running. The app sends its key in the request body.' };
  });
}

/**
 * POST body (sent as text/plain JSON). This is the only way to read or write data.
 * { key, since?: 'YYYY-MM-DD' (default: WINDOW_DAYS ago), ops: [
 *   { type: 'checkin', date, routineId, done: true|false, updatedAt: ISO time on the device },
 *   { type: 'choreDone', choreId, date, loggedAt? },
 *   { type: 'choreUndo', choreId, date },
 *   { type: 'routine', routine: { id, name, icon, order, archived } },
 *   { type: 'chore', chore: { id, name, zone, every_days, archived } } ] }
 * Applies the ops in order (none = just read) and returns the data.
 * Each op result is reported in `results` ('written', 'kept-newer', 'exists', 'removed', 'none').
 */
function doPost(e) {
  return respond_(function () {
    let body;
    try {
      body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    } catch (err) {
      body = {};
    }
    return withLock_(function () {
      checkKey_(body.key);
      const results = (body.ops || []).map(applyOp_);
      return { ok: true, results: results, data: readAll_(body.since) };
    });
  });
}

function applyOp_(op) {
  switch (op.type) {
    case 'checkin': {
      const sh = sheet_('Checkins');
      const key = op.date + '|' + op.routineId;
      const stamp = op.updatedAt || new Date().toISOString();
      const row = findRow_(sh, 5, key);
      if (row) {
        const current = sh.getRange(row, 4).getDisplayValue();
        if (current && current > stamp) return 'kept-newer'; // a newer edit is already there
        writeRow_(sh, row, [op.date, op.routineId, op.done ? '1' : '0', stamp, key]);
      } else {
        appendRow_(sh, [op.date, op.routineId, op.done ? '1' : '0', stamp, key]);
      }
      return 'written';
    }
    case 'choreDone': {
      const sh = sheet_('ChoreLog');
      const key = op.choreId + '|' + op.date;
      if (findRow_(sh, 4, key)) return 'exists'; // one entry per chore per day
      appendRow_(sh, [op.choreId, op.date, op.loggedAt || new Date().toISOString(), key]);
      return 'written';
    }
    case 'choreUndo': {
      const sh = sheet_('ChoreLog');
      const row = findRow_(sh, 4, op.choreId + '|' + op.date);
      if (!row) return 'none';
      sh.deleteRow(row);
      return 'removed';
    }
    case 'routine': {
      const x = op.routine;
      return upsertById_('Routines', [x.id || uid_(), x.name || '', x.icon || '',
        String(x.order || ''), x.archived || '']);
    }
    case 'chore': {
      const x = op.chore;
      return upsertById_('Chores', [x.id || uid_(), x.name || '', x.zone || '',
        String(x.every_days || ''), x.archived || '']);
    }
    default:
      throw new Error('Unknown op: ' + op.type);
  }
}

function upsertById_(tab, row) {
  const sh = sheet_(tab);
  const at = findRow_(sh, 1, row[0]);
  if (at) writeRow_(sh, at, row);
  else appendRow_(sh, row);
  return 'written';
}

/* ---------- reading ---------- */

function readAll_(since) {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(since || '') ? since : daysAgo_(WINDOW_DAYS);
  const routines = readTab_('Routines');
  const chores = readTab_('Chores');

  let checkins = readTab_('Checkins');
  // Reach into yearly archives only when asked for older data.
  const ss = SpreadsheetApp.getActive();
  ss.getSheets().forEach(function (sh) {
    const m = /^Checkins_(\d{4})$/.exec(sh.getName());
    if (m && m[1] >= from.slice(0, 4)) checkins = checkins.concat(readTab_(sh.getName()));
  });
  checkins = checkins.filter(function (r) { return r.date >= from; });

  // ChoreLog: the window, plus the latest entry of every chore, so a chore done
  // every 180 days still knows when it was last done.
  const log = readTab_('ChoreLog');
  const latest = {};
  log.forEach(function (r) {
    if (!latest[r.chore_id] || r.date > latest[r.chore_id].date) latest[r.chore_id] = r;
  });
  const choreLog = log.filter(function (r) {
    return r.date >= from || latest[r.chore_id] === r;
  });

  return { since: from, Routines: routines, Chores: chores, Checkins: checkins, ChoreLog: choreLog };
}

/** Reads a tab as objects. Fills missing ids and keys left by hand edits. */
function readTab_(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) return [];
  const values = sh.getDataRange().getDisplayValues();
  const head = values.shift() || [];
  const out = [];
  values.forEach(function (r, i) {
    if (!r.some(function (c) { return c !== ''; })) return;
    const fixed = fillAuto_(name.replace(/_\d{4}$/, ''), r);
    if (fixed) writeRow_(sh, i + 2, r);
    const o = {};
    head.forEach(function (h, j) { o[h] = r[j]; });
    out.push(o);
  });
  return out;
}

/** Fills id or key in place. Returns true if the row changed. */
function fillAuto_(tab, r) {
  if ((tab === 'Routines' || tab === 'Chores') && r[0] === '') {
    r[0] = uid_();
    return true;
  }
  if (tab === 'Checkins' && r[0] && r[1] && r[4] !== r[0] + '|' + r[1]) {
    r[4] = r[0] + '|' + r[1];
    return true;
  }
  if (tab === 'ChoreLog' && r[0] && r[1] && r[3] !== r[0] + '|' + r[1]) {
    r[3] = r[0] + '|' + r[1];
    return true;
  }
  return false;
}

/* ---------- hand edits ---------- */

/**
 * Runs by itself when you edit the Sheet by hand (not when the app writes).
 * Stamps updated_at on edited Checkins rows, so your hand edit counts as the
 * newest, and keeps keys right in Checkins and ChoreLog.
 */
function onEdit(e) {
  const sh = e.range.getSheet();
  const name = sh.getName();
  if (name !== 'Checkins' && name !== 'ChoreLog') return;
  const first = Math.max(2, e.range.getRow());
  const last = e.range.getLastRow();
  if (last < first) return;
  const width = TABS[name].length;
  const rows = sh.getRange(first, 1, last - first + 1, width).getDisplayValues();
  const now = new Date().toISOString();
  rows.forEach(function (r) {
    if (!r[0] || !r[1]) return;
    if (name === 'Checkins') r[3] = now;
    else if (!r[2]) r[2] = now;
    fillAuto_(name, r);
  });
  sh.getRange(first, 1, rows.length, width).setNumberFormat('@').setValues(rows);
}

/* ---------- archive ---------- */

/** Moves Checkins older than ARCHIVE_DAYS into Checkins_YYYY tabs. Runs monthly. */
function archiveOldLogs() {
  withLock_(function () {
    const ss = SpreadsheetApp.getActive();
    const sh = sheet_('Checkins');
    const width = TABS.Checkins.length;
    const values = sh.getDataRange().getDisplayValues();
    values.shift(); // header
    const cutoff = daysAgo_(ARCHIVE_DAYS);
    const keep = [];
    const byYear = {};
    values.forEach(function (r) {
      if (r[0] && r[0] < cutoff) (byYear[r[0].slice(0, 4)] = byYear[r[0].slice(0, 4)] || []).push(r);
      else if (r.some(function (c) { return c !== ''; })) keep.push(r);
    });
    const years = Object.keys(byYear);
    if (!years.length) return;
    years.forEach(function (y) {
      const name = 'Checkins_' + y;
      let arch = ss.getSheetByName(name);
      if (!arch) {
        arch = ss.insertSheet(name);
        prepareTab_(arch, TABS.Checkins);
      }
      byYear[y].forEach(function (r) { appendRow_(arch, r); });
    });
    // Rewrite the live tab with what stays, then clear the leftover rows below it.
    sh.getRange(2, 1, values.length, width).clearContent();
    if (keep.length) sh.getRange(2, 1, keep.length, width).setNumberFormat('@').setValues(keep);
  });
}

/* ---------- helpers ---------- */

/** Row number (1-based) of the first cell in column col that equals value, or 0. */
function findRow_(sh, col, value) {
  const last = sh.getLastRow();
  if (last < 2 || !value) return 0;
  const cell = sh.getRange(2, col, last - 1, 1)
    .createTextFinder(String(value)).matchEntireCell(true).findNext();
  return cell ? cell.getRow() : 0;
}

function writeRow_(sh, row, values) {
  sh.getRange(row, 1, 1, values.length).setNumberFormat('@').setValues([values]);
}

function appendRow_(sh, values) {
  const r = sh.getLastRow() + 1;
  if (r > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 500);
  writeRow_(sh, r, values);
}

function sheet_(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw new Error('Missing tab "' + name + '". Run setup() first.');
  return sh;
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/** Checks the key; counts wrong keys and locks every request after MAX_FAILS in a row. */
function checkKey_(key) {
  const props = PropertiesService.getScriptProperties();
  const until = Number(props.getProperty('LOCKED_UNTIL') || 0);
  if (until > Date.now()) {
    throw new Error('Locked after too many wrong keys. Try again in ' +
      Math.ceil((until - Date.now()) / 60000) + ' min, or run setup() in the script editor.');
  }
  const secret = props.getProperty('SECRET');
  if (secret && typeof key === 'string' && key === secret) {
    if (props.getProperty('FAILS')) props.deleteProperty('FAILS');
    return;
  }
  const fails = Number(props.getProperty('FAILS') || 0) + 1;
  if (fails >= MAX_FAILS) {
    props.setProperty('LOCKED_UNTIL', String(Date.now() + LOCK_MINUTES * 60000));
    props.deleteProperty('FAILS');
  } else {
    props.setProperty('FAILS', String(fails));
  }
  throw new Error('Wrong or missing key');
}

function respond_(fn) {
  let out;
  try {
    out = fn();
  } catch (err) {
    out = { ok: false, error: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

/** YYYY-MM-DD for n days ago, in the Sheet's time zone. */
function daysAgo_(n) {
  const tz = SpreadsheetApp.getActive().getSpreadsheetTimeZone();
  return Utilities.formatDate(new Date(Date.now() - n * 864e5), tz, 'yyyy-MM-dd');
}

function uid_() {
  return Utilities.getUuid().slice(0, 8);
}
