import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackend } from './fake-apps-script.mjs';

test('GET is a health check: no key needed, no data returned', () => {
  const b = createBackend();
  const res = b.get({ key: b.key });
  assert.equal(res.ok, true);
  assert.equal(res.app, 'ruthines');
  assert.equal(res.data, undefined);
});

test('POST with the key reads and writes', () => {
  const b = createBackend();
  const read = b.post(JSON.stringify({ key: b.key, ops: [] }));
  assert.equal(read.ok, true);
  assert.equal(read.data.Routines.length, 4);
  const id = read.data.Routines[0].id;
  const w = b.post(JSON.stringify({ key: b.key, ops: [{ type: 'checkin', date: '2026-11-25', routineId: id, done: true, updatedAt: '2026-11-25T10:00:00.000Z' }], since: '2026-01-01' }));
  assert.deepEqual(w.results, ['written']);
  assert.equal(w.data.Checkins.length, 1);
});

test('bad bodies are refused without crashing', () => {
  const b = createBackend();
  assert.deepEqual(b.post('not json'), { ok: false, error: 'Wrong or missing key' });
  assert.equal(b.post(JSON.stringify({ ops: [] })).ok, false);
});

test('lockout after 10 wrong keys refuses even the right key; setup() clears it', () => {
  const b = createBackend();
  for (let i = 0; i < 9; i++) assert.equal(b.post(JSON.stringify({ key: 'wrong' + i })).error, 'Wrong or missing key');
  // A right key in between resets the count.
  assert.equal(b.post(JSON.stringify({ key: b.key, ops: [] })).ok, true);
  for (let i = 0; i < 10; i++) b.post(JSON.stringify({ key: 'wrong' + i }));
  const locked = b.post(JSON.stringify({ key: b.key, ops: [] }));
  assert.equal(locked.ok, false);
  assert.match(locked.error, /^Locked after too many wrong keys/);
  b.setup();
  assert.equal(b.post(JSON.stringify({ key: b.key, ops: [] })).ok, true);
});

test('lockout expires after 15 minutes', () => {
  const b = createBackend();
  for (let i = 0; i < 10; i++) b.post(JSON.stringify({ key: 'x' }));
  b.props.set('LOCKED_UNTIL', String(Date.now() - 1));
  assert.equal(b.post(JSON.stringify({ key: b.key, ops: [] })).ok, true);
});
