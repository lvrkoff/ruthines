// Demo mode: an in-browser stand-in for the Apps Script, filled with sample
// data, so the app can be tried without a Sheet. Nothing leaves the device.
// It follows the same rules as Code.gs: newest tick wins, one chore entry per day.
import * as L from './logic.js';

export const DEMO_URL = 'demo:';
const STORE = 'ruthines-demo';

const ROUTINES = [
  ['⏰', 'Up by 7:00'], ['💧', 'Drink water'], ['🥗', 'Cook a real meal'], ['🚶', 'Walk 30 minutes'],
  ['📖', 'Read 10 pages'], ['🧘', 'Stretch'], ['📵', 'No phone in bed'], ['🗓️', 'Plan tomorrow'],
];
const CHORES = [
  ['Clean oven', 'Kitchen', 30, 33], ['Wipe fridge', 'Kitchen', 14, 6], ['Bathroom sink', 'Bathroom', 7, 6],
  ['Change towels', 'Bathroom', 7, 4], ['Vacuum', 'Living room', 7, 2], ['Water plants', 'Living room', 4, 5],
  ['Defrost freezer', 'Kitchen', 90, 55], ['Descale kettle', 'Kitchen', 60, null],
];
// How likely each habit is ticked on a given day, so Progress has a spread.
const ODDS = [0.7, 0.9, 0.5, 0.6, 0.3, 0.45, 0.25, 0.65];

function seeded(seed) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
}

function sample(today) {
  const rand = seeded(42);
  const Routines = ROUTINES.map(([icon, name], i) => ({ id: 'r' + i, name, icon, order: String(i + 1), archived: '' }));
  const Chores = CHORES.map(([name, zone, every], i) => ({ id: 'c' + i, name, zone, every_days: String(every), archived: '' }));
  const Checkins = [];
  for (let d = L.addDays(today, -200); d < today; d = L.addDays(d, 1)) {
    const ramp = 0.75 + 0.25 * (1 - L.daysBetween(d, today) / 200); // a little better lately
    Routines.forEach((r, i) => {
      if (rand() < ODDS[i] * ramp) Checkins.push({ date: d, routine_id: r.id, done: '1', updated_at: d + 'T20:00:00.000Z' });
    });
  }
  // Today: a few already ticked.
  ['r0', 'r1'].forEach((id) => Checkins.push({ date: today, routine_id: id, done: '1', updated_at: today + 'T08:00:00.000Z' }));
  const ChoreLog = [];
  CHORES.forEach(([, , every, ago], i) => {
    if (ago == null) return;
    for (let k = 0; k < 4; k++) ChoreLog.push({ chore_id: 'c' + i, date: L.addDays(today, -(ago + k * every)), logged_at: '' });
  });
  return { Routines, Chores, Checkins, ChoreLog };
}

let db = null;

function load(today) {
  if (db) return db;
  try {
    db = JSON.parse(localStorage.getItem(STORE) || 'null');
  } catch (e) {
    db = null;
  }
  if (!db) db = sample(today);
  return db;
}

function persist() {
  try {
    localStorage.setItem(STORE, JSON.stringify(db));
  } catch (e) { /* demo only */ }
}

export function resetDemo() {
  db = null;
  try { localStorage.removeItem(STORE); } catch (e) { /* ignore */ }
}

function apply(op) {
  switch (op.type) {
    case 'checkin': {
      const row = db.Checkins.find((r) => r.date === op.date && r.routine_id === op.routineId);
      if (row && row.updated_at > op.updatedAt) return 'kept-newer';
      const next = { date: op.date, routine_id: op.routineId, done: op.done ? '1' : '0', updated_at: op.updatedAt };
      if (row) Object.assign(row, next);
      else db.Checkins.push(next);
      return 'written';
    }
    case 'choreDone':
      if (db.ChoreLog.some((r) => r.chore_id === op.choreId && r.date === op.date)) return 'exists';
      db.ChoreLog.push({ chore_id: op.choreId, date: op.date, logged_at: op.loggedAt || '' });
      return 'written';
    case 'choreUndo': {
      const i = db.ChoreLog.findIndex((r) => r.chore_id === op.choreId && r.date === op.date);
      if (i < 0) return 'none';
      db.ChoreLog.splice(i, 1);
      return 'removed';
    }
    case 'routine':
    case 'chore': {
      const tab = op.type === 'routine' ? db.Routines : db.Chores;
      const x = { ...op[op.type] };
      const i = tab.findIndex((r) => r.id === x.id);
      if (i >= 0) tab[i] = x;
      else tab.push(x);
      return 'written';
    }
    default:
      throw new Error('Unknown op: ' + op.type);
  }
}

/** Same reply shape as Code.gs doPost. */
export async function demoPost(payload, today) {
  load(today);
  const results = (payload.ops || []).map(apply);
  persist();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(payload.since || '') ? payload.since : L.addDays(today, -90);
  const latest = {};
  db.ChoreLog.forEach((r) => { if (!latest[r.chore_id] || r.date > latest[r.chore_id].date) latest[r.chore_id] = r; });
  await new Promise((r) => setTimeout(r, 250)); // feel like a network call
  return {
    ok: true,
    results,
    data: {
      since: from,
      Routines: db.Routines.map((r) => ({ ...r })),
      Chores: db.Chores.map((c) => ({ ...c })),
      Checkins: db.Checkins.filter((r) => r.date >= from).map((r) => ({ ...r })),
      ChoreLog: db.ChoreLog.filter((r) => r.date >= from || latest[r.chore_id] === r).map((r) => ({ ...r })),
    },
  };
}
