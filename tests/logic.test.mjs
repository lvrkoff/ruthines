import test from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../logic.js';

const data = {
  since: '2026-08-27',
  Routines: [
    { id: 'b', name: 'Pills', icon: '💊', order: '2', archived: '' },
    { id: 'a', name: 'Wake', icon: '', order: '1', archived: '' },
    { id: 'z', name: 'Old', icon: '', order: '3', archived: '2026-10-01' },
  ],
  Chores: [
    { id: 'c1', name: 'Fridge', zone: 'Kitchen', every_days: '7', archived: '' },
    { id: 'c2', name: 'Towels', zone: 'Bathroom', every_days: '3', archived: '' },
    { id: 'c3', name: 'Windows', zone: '', every_days: '30', archived: '' },
  ],
  Checkins: [
    { date: '2026-11-23', routine_id: 'a', done: '1', updated_at: '2026-11-23T07:00:00.000Z' },
    { date: '2026-11-24', routine_id: 'a', done: '1', updated_at: '2026-11-24T07:00:00.000Z' },
    { date: '2026-11-25', routine_id: 'a', done: '0', updated_at: '2026-11-25T09:00:00.000Z' },
  ],
  ChoreLog: [
    { chore_id: 'c1', date: '2026-11-15', logged_at: 'x' },
    { chore_id: 'c2', date: '2026-11-23', logged_at: 'x' },
  ],
};

test('dates', () => {
  assert.equal(L.addDays('2026-03-28', 2), '2026-03-30');
  assert.equal(L.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(L.daysBetween('2026-11-20', '2026-11-25'), 5);
  assert.equal(L.weekStart('2026-11-25'), '2026-11-23'); // Wed -> Mon
  assert.equal(L.weekStart('2026-11-29'), '2026-11-23'); // Sun -> Mon
  assert.equal(L.weekdayName('2026-11-25'), 'Wed');
});

test('day starts at 04:00', () => {
  assert.equal(L.logicalDay(new Date(2026, 10, 26, 1, 30), 4), '2026-11-25');
  assert.equal(L.logicalDay(new Date(2026, 10, 26, 4, 0), 4), '2026-11-26');
  assert.equal(L.logicalDay(new Date(2026, 10, 26, 0, 30), 0), '2026-11-26');
});

test('view sorts and splits routines', () => {
  const v = L.buildView(data, []);
  assert.deepEqual(v.routines.map((r) => r.id), ['a', 'b']);
  assert.deepEqual(v.archivedRoutines.map((r) => r.id), ['z']);
});

test('outbox applies on top, newest checkin wins', () => {
  const v = L.buildView(data, [
    { type: 'checkin', date: '2026-11-25', routineId: 'a', done: true, updatedAt: '2026-11-25T08:00:00.000Z' }, // older than sheet
    { type: 'checkin', date: '2026-11-25', routineId: 'b', done: true, updatedAt: '2026-11-25T10:00:00.000Z' },
    { type: 'choreDone', choreId: 'c3', date: '2026-11-25' },
    { type: 'choreUndo', choreId: 'c2', date: '2026-11-23' },
    { type: 'routine', routine: { id: 'n', name: 'New', icon: '', order: 0, archived: '' } },
  ]);
  assert.equal(L.isDone(v, '2026-11-25', 'a'), false);
  assert.equal(L.isDone(v, '2026-11-25', 'b'), true);
  assert.ok(v.choreLog.has('c3|2026-11-25'));
  assert.ok(!v.choreLog.has('c2|2026-11-23'));
  assert.equal(v.routines[0].id, 'n');
});

test('chore status and Today filter', () => {
  const v = L.buildView(data, []);
  const t = '2026-11-25';
  const s1 = L.choreStatus(v, v.chores[0], t); // fridge: 15 + 7 = 22, 3 days overdue
  assert.equal(s1.level, 'overdue');
  assert.equal(s1.label, '3 days overdue');
  const s2 = L.choreStatus(v, v.chores[1], t); // towels: 23 + 3 = 26, tomorrow
  assert.equal(s2.level, 'soon');
  assert.equal(s2.label, 'due tomorrow');
  const s3 = L.choreStatus(v, v.chores[2], t); // never done
  assert.equal(s3.label, 'never done');
  assert.deepEqual(L.choresForToday(v, t).map((x) => x.chore.id), ['c1', 'c3', 'c2']);
  // Viewing an earlier day ignores logs after it.
  assert.equal(L.lastDone(v, 'c2', '2026-11-22'), '');
});

test('chore within a week is not on Today', () => {
  const v = L.buildView({ ...data, ChoreLog: [{ chore_id: 'c1', date: '2026-11-24' }] }, []);
  const s = L.choreStatus(v, v.chores[0], '2026-11-25');
  assert.equal(s.level, 'week');
  assert.ok(!L.choresForToday(v, '2026-11-25').some((x) => x.chore.id === 'c1'));
});

test('streak counts up to yesterday when today is not ticked', () => {
  const v = L.buildView(data, []);
  assert.equal(L.streak(v, 'a', '2026-11-25'), 2);
  assert.equal(L.streak(v, 'b', '2026-11-25'), 0);
  const v2 = L.buildView(data, [{ type: 'checkin', date: '2026-11-25', routineId: 'a', done: true, updatedAt: '2026-11-25T23:00:00.000Z' }]);
  assert.equal(L.streak(v2, 'a', '2026-11-25'), 3);
});

test('rate and weekly totals', () => {
  const v = L.buildView(data, []);
  assert.equal(L.rate(v, 'a', '2026-11-22', '2026-11-25'), 0.5);
  const w = L.weeklyTotals(v, '2026-11-16', '2026-11-25');
  assert.deepEqual(w, [{ week: '2026-11-16', total: 0 }, { week: '2026-11-23', total: 2 }]);
});

test('csv', () => {
  const v = L.buildView(data, []);
  const csv = L.habitsCsv(v, '2026-11-24', '2026-11-25');
  assert.equal(csv, 'date,habit,done\r\n2026-11-24,Wake,1\r\n2026-11-24,Pills,0\r\n2026-11-25,Wake,0\r\n2026-11-25,Pills,0\r\n');
  assert.equal(L.toCsv([['a,b', 'say "hi"']]), '"a,b","say ""hi"""\r\n');
  assert.match(L.choresCsv(v), /^date,chore,zone\r\n2026-11-15,Fridge,Kitchen\r\n2026-11-23,Towels,Bathroom\r\n$/);
});
