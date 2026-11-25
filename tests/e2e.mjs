// End-to-end check in headless Chromium: serves the app locally and answers
// the script URL with the real Code.gs running on a fake Sheet.
// Run: node tests/e2e.mjs  (needs playwright and python3)
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createBackend } from './fake-apps-script.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.env.SHOTS_DIR;
const PORT = 8123;
const APP = `http://localhost:${PORT}/`;
const SCRIPT = 'https://script.google.com/macros/s/TESTDEPLOYMENT/exec';

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));

const backend = createBackend();
let online = true;
let requests = 0;

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
const errors = [];

await context.route('https://script.google.com/**', async (route) => {
  if (!online) return route.abort('internetdisconnected');
  requests++;
  const req = route.request();
  // The key must never appear in a URL, and the app only ever POSTs.
  assert.ok(!req.url().includes(backend.key), 'key leaked into a URL');
  assert.equal(req.method(), 'POST');
  const url = new URL(req.url());
  const body = req.method() === 'POST'
    ? backend.post(req.postData())
    : backend.get(Object.fromEntries(url.searchParams));
  await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
});

const page = await context.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !m.text().includes('ERR_INTERNET_DISCONNECTED') && errors.push(m.text()));

const rows = (tab) => backend.sheets.get(tab).getDataRange().getDisplayValues().slice(1).filter((r) => r.some(Boolean));
const synced = () => page.waitForFunction(() => /^Synced/.test(document.getElementById('status')?.textContent || ''));

try {
  await page.goto(APP);

  // 1. Connect: wrong key, then right key.
  await page.fill('input[name=url]', SCRIPT);
  await page.fill('input[name=key]', 'nope');
  await page.click('button[type=submit]');
  await page.getByText('The script says the key is wrong.').waitFor();
  await page.fill('input[name=key]', backend.key);
  await page.click('button[type=submit]');
  await page.getByRole('heading', { name: 'Today' }).waitFor();
  assert.equal(await page.locator('ul.habits li').count(), 4);
  console.log('ok connect: 4 habits');

  // 2. Tick a habit; it reaches the Sheet.
  await page.getByLabel('📖 Read').check();
  await synced();
  const routines = rows('Routines');
  const readId = routines.find((r) => r[1] === 'Read')[0];
  let ck = rows('Checkins');
  assert.equal(ck.length, 1);
  assert.equal(ck[0][1], readId);
  assert.equal(ck[0][2], '1');
  console.log('ok tick synced:', ck[0].slice(0, 3).join(' '));

  // Untick writes done = 0 on the same row.
  await page.getByLabel('📖 Read').uncheck();
  await synced();
  ck = rows('Checkins');
  assert.equal(ck.length, 1);
  assert.equal(ck[0][2], '0');
  await page.getByLabel('📖 Read').check();
  await synced();
  console.log('ok untick and re-tick');

  // 3. Chores typed into the Sheet by hand show up after a sync.
  backend.addChore('Clean fridge', 'Kitchen', 7);
  backend.addChore('Wash towels', 'Bathroom', 3);
  await page.click('#status');
  await page.getByText('Clean fridge').waitFor();
  assert.equal(await page.locator('ul.chores li').count(), 2);
  await page.locator('li.chore', { hasText: 'Clean fridge' }).getByRole('button', { name: 'Done' }).click();
  await synced();
  assert.equal(rows('ChoreLog').length, 1);
  await page.locator('li.chore', { hasText: 'Clean fridge' }).getByRole('button', { name: 'Undo' }).click();
  await synced();
  assert.equal(rows('ChoreLog').length, 0);
  await page.locator('li.chore', { hasText: 'Clean fridge' }).getByRole('button', { name: 'Done' }).click();
  await synced();
  console.log('ok chore done, undo, done');

  // 4. Offline: tick, reload with no network, the tick and the outbox survive; then it syncs.
  await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller);
  online = false;
  await context.setOffline(true);
  await page.getByLabel('🚶 Walk').check();
  await page.waitForFunction(() => /1 unsent/.test(document.getElementById('status').textContent));
  await page.reload();
  await page.getByRole('heading', { name: 'Today' }).waitFor();
  assert.equal(await page.getByLabel('🚶 Walk').isChecked(), true);
  console.log('ok offline reload keeps tick:', await page.locator('#status').textContent());
  if (shots) await page.screenshot({ path: path.join(shots, 'today-offline.png') });
  online = true;
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await synced();
  assert.equal(rows('Checkins').length, 2);
  console.log('ok outbox flushed after reconnect');

  // 5. An older offline edit doesn't overwrite a newer one in the Sheet.
  const res = backend.post(JSON.stringify({ key: backend.key, ops: [{ type: 'checkin', date: ck[0][0], routineId: readId, done: false, updatedAt: '2000-01-01T00:00:00.000Z' }] }));
  assert.equal(res.results[0], 'kept-newer');
  console.log('ok stale edit kept-newer');

  if (shots) {
    await page.reload();
    await page.getByText('Clean fridge').waitFor();
    await page.screenshot({ path: path.join(shots, 'today-phone.png'), fullPage: true });
  }

  // 6. Previous day: tick yesterday.
  await page.getByRole('button', { name: 'Previous day' }).click();
  await page.getByText('Back to today').waitFor();
  await page.getByLabel('🧹 Tidy desk').check();
  await synced();
  assert.ok(rows('Checkins').some((r) => r[1] === routines.find((x) => x[1] === 'Tidy desk')[0] && r[0] < ck[0][0]));
  await page.getByText('Back to today').click();
  console.log('ok tick on previous day');

  // 7. Week grid.
  await page.click('a[href="#week"]');
  await page.getByRole('heading', { name: 'This week' }).waitFor();
  assert.equal(await page.locator('table.grid tbody tr').count(), 4);
  const weekChecked = await page.locator('table.grid tbody input:checked').count();
  assert.equal(weekChecked >= 2, true);
  if (shots) await page.screenshot({ path: path.join(shots, 'week-phone.png'), fullPage: true });
  console.log('ok week grid, checked cells:', weekChecked);

  // 8. Chores screen: add a chore with a last-done date.
  await page.click('a[href="#chores"]');
  await page.getByText('Add a chore').click();
  await page.getByPlaceholder('e.g. Clean the fridge').fill('Descale kettle');
  await page.getByPlaceholder('e.g. Kitchen').fill('Kitchen');
  await page.locator('details.add input[type=number]').fill('30');
  await page.locator('details.add input[type=date]').fill('2026-11-01');
  await page.getByRole('button', { name: 'Add chore' }).click();
  await synced();
  assert.ok(rows('Chores').some((r) => r[1] === 'Descale kettle' && r[3] === '30'));
  assert.ok(rows('ChoreLog').some((r) => r[1] === '2026-11-01'));
  if (shots) await page.screenshot({ path: path.join(shots, 'chores-phone.png'), fullPage: true });
  console.log('ok add chore');

  // 9. Settings: rename, reorder, add, archive a habit.
  await page.click('a[href="#settings"]');
  await page.locator('.edit-list li').first().locator('input:not(.icon)').fill('Drink more water');
  await page.locator('.edit-list li').first().locator('input:not(.icon)').press('Tab');
  await synced();
  assert.ok(rows('Routines').some((r) => r[1] === 'Drink more water'));
  await page.getByRole('button', { name: 'Move Read up' }).click();
  await synced();
  const order = rows('Routines').sort((a, b) => a[3] - b[3]).map((r) => r[1]);
  assert.equal(order[0], 'Read');
  await page.getByPlaceholder('New habit').fill('Stretch');
  await page.getByRole('button', { name: 'Add habit' }).click();
  await synced();
  assert.ok(rows('Routines').some((r) => r[1] === 'Stretch' && r[3] === '5'));
  await page.getByRole('button', { name: 'Archive Tidy desk' }).click();
  await synced();
  assert.ok(rows('Routines').find((r) => r[1] === 'Tidy desk')[4]);
  if (shots) await page.screenshot({ path: path.join(shots, 'settings-phone.png'), fullPage: true });
  console.log('ok settings: rename, reorder, add, archive');

  // 10. Progress and CSV export.
  await page.click('a[href="#progress"]');
  await page.getByRole('heading', { name: 'Ticks per week' }).waitFor();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Habits CSV' }).click()]);
  const csv = fs.readFileSync(await dl.path(), 'utf8');
  assert.match(csv, /^date,habit,done\r\n/);
  assert.ok(csv.includes(',Read,1'));
  await page.selectOption('select', 'all');
  await page.waitForFunction(() => !document.body.textContent.includes('Loading full history'));
  if (shots) await page.screenshot({ path: path.join(shots, 'progress-phone.png'), fullPage: true });
  console.log('ok progress + CSV (' + csv.trim().split('\n').length + ' lines)');

  // 11. Desktop layout.
  if (shots) {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.click('a[href="#today"]');
    await page.getByRole('heading', { name: 'Today' }).waitFor();
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: path.join(shots, 'today-desktop.png') });
  }

  // 12. Disconnect clears the device.
  await page.click('a[href="#settings"]');
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Disconnect this device' }).click();
  await page.locator('input[name=url]').waitFor();
  await page.reload();
  await page.locator('input[name=url]').waitFor();
  console.log('ok disconnect');

  assert.deepEqual(errors, []);
  console.log('ALL OK, script requests:', requests);
} catch (e) {
  console.error('FAILED:', e);
  console.error('page errors:', errors);
  if (shots) await page.screenshot({ path: path.join(shots, 'failure.png'), fullPage: true });
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill();
}
