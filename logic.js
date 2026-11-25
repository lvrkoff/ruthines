// Pure logic: dates, merging the outbox into the synced data, chore status,
// streaks and stats. No DOM, no storage, so it can be tested in Node.

/* ---------- dates (all local, as YYYY-MM-DD strings) ---------- */

const pad = (n) => String(n).padStart(2, '0');

export function fmtDate(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

/** Local noon of a YYYY-MM-DD string, so adding days never trips on DST. */
export function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
}

export function addDays(s, n) {
  const d = parseDate(s);
  d.setDate(d.getDate() + n);
  return fmtDate(d);
}

/** Whole days from a to b (b - a). */
export function daysBetween(a, b) {
  return Math.round((parseDate(b) - parseDate(a)) / 864e5);
}

/** The day a moment belongs to, when the day starts at startHour (04:00 by default). */
export function logicalDay(now = new Date(), startHour = 4) {
  return fmtDate(new Date(now.getTime() - startHour * 3600e3));
}

/** Monday of the week that contains s. */
export function weekStart(s) {
  const dow = (parseDate(s).getDay() + 6) % 7; // Mon = 0
  return addDays(s, -dow);
}

export function dateRange(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function weekdayName(s) {
  return WEEKDAYS[(parseDate(s).getDay() + 6) % 7];
}

/** "Wed 25 Nov" */
export function prettyDate(s) {
  const d = parseDate(s);
  return weekdayName(s) + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()];
}

/** "25 Nov" */
export function shortDate(s) {
  const d = parseDate(s);
  return d.getDate() + ' ' + MONTHS[d.getMonth()];
}

/* ---------- ids ---------- */

export function newId() {
  const a = new Uint8Array(4);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

/* ---------- merged view ---------- */

const byOrder = (a, b) =>
  (Number(a.order) || 0) - (Number(b.order) || 0) || a.name.localeCompare(b.name);

/**
 * The synced Sheet data with the unsent outbox applied on top, the same way
 * the script will apply it. This is what every screen shows.
 */
export function buildView(data, outbox = []) {
  data = data || {};
  const routines = new Map((data.Routines || []).filter((r) => r.id).map((r) => [r.id, { ...r }]));
  const chores = new Map((data.Chores || []).filter((c) => c.id).map((c) => [c.id, { ...c }]));
  const checkins = new Map();
  for (const r of data.Checkins || []) {
    checkins.set(r.date + '|' + r.routine_id, {
      date: r.date, routine_id: r.routine_id, done: r.done === '1', updated_at: r.updated_at || '',
    });
  }
  const choreLog = new Map();
  for (const r of data.ChoreLog || []) {
    choreLog.set(r.chore_id + '|' + r.date, { chore_id: r.chore_id, date: r.date, logged_at: r.logged_at });
  }

  for (const op of outbox) {
    switch (op.type) {
      case 'checkin': {
        const k = op.date + '|' + op.routineId;
        const cur = checkins.get(k);
        if (cur && cur.updated_at > op.updatedAt) break;
        checkins.set(k, { date: op.date, routine_id: op.routineId, done: !!op.done, updated_at: op.updatedAt });
        break;
      }
      case 'choreDone': {
        const k = op.choreId + '|' + op.date;
        if (!choreLog.has(k)) choreLog.set(k, { chore_id: op.choreId, date: op.date, logged_at: op.loggedAt });
        break;
      }
      case 'choreUndo':
        choreLog.delete(op.choreId + '|' + op.date);
        break;
      case 'routine':
        routines.set(op.routine.id, { ...op.routine, order: String(op.routine.order ?? '') });
        break;
      case 'chore':
        chores.set(op.chore.id, { ...op.chore, every_days: String(op.chore.every_days ?? '') });
        break;
    }
  }

  const allRoutines = [...routines.values()].sort(byOrder);
  return {
    since: data.since || '',
    routines: allRoutines.filter((r) => !r.archived),
    archivedRoutines: allRoutines.filter((r) => r.archived),
    allRoutines,
    chores: [...chores.values()].filter((c) => !c.archived),
    archivedChores: [...chores.values()].filter((c) => c.archived),
    allChores: [...chores.values()],
    checkins,
    choreLog,
  };
}

export function isDone(view, date, routineId) {
  const c = view.checkins.get(date + '|' + routineId);
  return !!(c && c.done);
}

/* ---------- chores ---------- */

export function lastDone(view, choreId, onOrBefore) {
  let last = '';
  for (const r of view.choreLog.values()) {
    if (r.chore_id === choreId && r.date > last && (!onOrBefore || r.date <= onOrBefore)) last = r.date;
  }
  return last;
}

/**
 * Status of a chore as seen from `today`.
 * level: 'overdue' (red), 'soon' (orange, within 2 days), 'week' (yellow), 'fine' (grey).
 */
export function choreStatus(view, chore, today) {
  const every = parseInt(chore.every_days, 10) || 0;
  const last = lastDone(view, chore.id, today);
  const doneToday = view.choreLog.has(chore.id + '|' + today);
  if (!last) {
    return { last: '', next: '', daysLeft: 0, level: 'soon', label: 'never done', doneToday, every };
  }
  if (!every) {
    return { last, next: '', daysLeft: Infinity, level: 'fine', label: 'no schedule', doneToday, every };
  }
  const next = addDays(last, every);
  const daysLeft = daysBetween(today, next);
  let level = 'fine';
  if (daysLeft < 0) level = 'overdue';
  else if (daysLeft <= 2) level = 'soon';
  else if (daysLeft <= 7) level = 'week';
  let label;
  if (daysLeft < 0) label = -daysLeft + (daysLeft === -1 ? ' day' : ' days') + ' overdue';
  else if (daysLeft === 0) label = 'due today';
  else if (daysLeft === 1) label = 'due tomorrow';
  else label = 'in ' + daysLeft + ' days';
  return { last, next, daysLeft, level, label, doneToday, every };
}

/** Active chores with status, worst first. */
export function choresWithStatus(view, today) {
  return view.chores
    .map((c) => ({ chore: c, s: choreStatus(view, c, today) }))
    .sort((a, b) => a.s.daysLeft - b.s.daysLeft || a.chore.name.localeCompare(b.chore.name));
}

/** What Today shows: overdue or due within 2 days, plus anything ticked off that day. */
export function choresForToday(view, today) {
  return choresWithStatus(view, today).filter(
    ({ chore, s }) => s.daysLeft <= 2 || view.choreLog.has(chore.id + '|' + today),
  );
}

/* ---------- habits: streaks and stats ---------- */

/** Consecutive done days ending today, or ending yesterday if today isn't ticked yet. */
export function streak(view, routineId, today) {
  let d = isDone(view, today, routineId) ? today : addDays(today, -1);
  let n = 0;
  while (isDone(view, d, routineId)) {
    n++;
    d = addDays(d, -1);
  }
  return n;
}

export function earliestCheckin(view) {
  let first = '';
  for (const c of view.checkins.values()) if (c.done && (!first || c.date < first)) first = c.date;
  return first;
}

/** Done days / days in [from, to] for one habit. */
export function rate(view, routineId, from, to) {
  const days = dateRange(from, to);
  if (!days.length) return 0;
  return days.filter((d) => isDone(view, d, routineId)).length / days.length;
}

/** Ticks per Monday-starting week, for weeks touching [from, to]. */
export function weeklyTotals(view, from, to) {
  const out = [];
  for (let w = weekStart(from); w <= to; w = addDays(w, 7)) out.push({ week: w, total: 0 });
  const index = new Map(out.map((x, i) => [x.week, i]));
  for (const c of view.checkins.values()) {
    if (!c.done || c.date < from || c.date > to) continue;
    const i = index.get(weekStart(c.date));
    if (i !== undefined) out[i].total++;
  }
  return out;
}

/* ---------- CSV ---------- */

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function toCsv(rows) {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** One row per habit per day in [from, to]: date, habit, done (1/0). */
export function habitsCsv(view, from, to) {
  const rows = [['date', 'habit', 'done']];
  const routines = view.allRoutines.filter(
    (r) => !r.archived || [...view.checkins.values()].some((c) => c.routine_id === r.id && c.date >= from),
  );
  for (const d of dateRange(from, to)) {
    for (const r of routines) rows.push([d, r.name, isDone(view, d, r.id) ? 1 : 0]);
  }
  return toCsv(rows);
}

/** One row per chore done: date, chore, zone. */
export function choresCsv(view) {
  const names = new Map(view.allChores.map((c) => [c.id, c]));
  const rows = [['date', 'chore', 'zone']];
  [...view.choreLog.values()]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .forEach((r) => {
      const c = names.get(r.chore_id);
      rows.push([r.date, c ? c.name : r.chore_id, c ? c.zone : '']);
    });
  return toCsv(rows);
}

/** ISO week number (weeks start Monday; week 1 holds the year's first Thursday). */
export function isoWeek(s) {
  const thursday = addDays(weekStart(s), 3);
  const jan1 = thursday.slice(0, 4) + '-01-01';
  return Math.floor(daysBetween(jan1, thursday) / 7) + 1;
}

/** Icons show only when every active habit has one, so the list never looks half-done. */
export function showIcons(view) {
  return view.routines.length > 0 && view.routines.every((r) => r.icon);
}
