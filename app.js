import * as L from './logic.js';
import * as S from './store.js';
import { DEMO_URL, resetDemo } from './demo.js';

export const VERSION = '1.1.0';

/** Font and accent styles, chosen per device in Settings. */
export const STYLES = [
  { id: 'clay', name: 'Clay', font: 'Manrope', note: 'Rounded sans, terracotta' },
  { id: 'ink', name: 'Ink', font: 'Space Grotesk', note: 'Geometric sans, indigo' },
  { id: 'grove', name: 'Grove', font: 'Fraunces + Figtree', note: 'Serif headings, teal' },
];

const state = {
  config: null, // { url, key } — stored only on this device
  data: null, // last data returned by the script
  outbox: [], // changes not yet confirmed by the script
  settings: { dayStart: 4, style: 'clay' },
  lastSync: '',
  lastError: '',
  syncing: false,
  viewDate: null, // Today screen: day being viewed (null = today)
  weekDate: null, // Week screen: any day in the week being viewed
  zone: '', // Chores screen: zone filter ('' = all)
  openChore: '', // Chores screen: chore being edited
  addingChore: false,
  openHabit: '', // Settings: habit being edited
  progressRange: '8w',
  openStat: '', // Progress: habit whose calendar is open
  ext: null, // { since, data }: older history, fetched on demand for long ranges
  extError: '',
  extLoading: false,
};
let view = L.buildView(null, []);

/* ---------- tiny DOM helper ---------- */

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'checked' || k === 'value' || k === 'disabled' || k === 'selected') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false || c === '') continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const today = () => L.logicalDay(new Date(), state.settings.dayStart);
const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
const isDemo = () => state.config && state.config.url === DEMO_URL;
const label = (r, icons) => (icons && r.icon ? r.icon + ' ' : '') + r.name;

function applyStyle() {
  const s = STYLES.some((x) => x.id === state.settings.style) ? state.settings.style : 'clay';
  document.documentElement.dataset.style = s;
}

function setStyle(id) {
  state.settings.style = id;
  S.save('settings', state.settings);
  applyStyle();
  render(true);
}

/* ---------- state changes ---------- */

function addOp(op) {
  op._id = L.newId();
  state.outbox.push(op);
  S.save('outbox', state.outbox);
  render(true);
  scheduleSync(1000);
}

function routineOp(r, changes) {
  const x = { id: r.id, name: r.name, icon: r.icon || '', order: String(r.order || ''), archived: r.archived || '', ...changes };
  addOp({ type: 'routine', routine: x });
}

function choreOp(c, changes) {
  const x = { id: c.id, name: c.name, zone: c.zone || '', every_days: String(c.every_days || ''), archived: c.archived || '', ...changes };
  addOp({ type: 'chore', chore: x });
}

function toggleHabit(date, routineId) {
  addOp({
    type: 'checkin', date, routineId,
    done: !L.isDone(view, date, routineId),
    updatedAt: new Date().toISOString(),
  });
}

function choreDone(choreId, date) {
  addOp({ type: 'choreDone', choreId, date, loggedAt: new Date().toISOString() });
}

function choreUndo(choreId, date) {
  addOp({ type: 'choreUndo', choreId, date });
}

/* ---------- sync ---------- */

let syncTimer = null;
let syncAgain = false;

function scheduleSync(delay = 0) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sync, delay);
}

async function sync() {
  if (!state.config) return;
  if (state.syncing) {
    syncAgain = true;
    return;
  }
  state.syncing = true;
  renderStatus();
  const sent = state.outbox.slice();
  try {
    const res = sent.length ? await S.pushOps(state.config, sent) : await S.fetchData(state.config);
    state.data = res.data;
    state.outbox = state.outbox.filter((op) => !sent.includes(op));
    state.lastSync = new Date().toISOString();
    state.lastError = '';
    await Promise.all([S.save('data', state.data), S.save('outbox', state.outbox), S.save('lastSync', state.lastSync)]);
  } catch (e) {
    state.lastError = e.message;
  }
  state.syncing = false;
  render();
  if (syncAgain || (state.outbox.length && !state.lastError)) {
    syncAgain = false;
    scheduleSync(300);
  }
}

/* ---------- rendering ---------- */

let renderPending = false;

/** Typing in a text field shouldn't be interrupted by a background sync. */
function isEditing() {
  const a = document.activeElement;
  return !!a && a.closest('#app') && (a.tagName === 'TEXTAREA' ||
    (a.tagName === 'INPUT' && !['checkbox', 'button', 'submit', 'radio'].includes(a.type)));
}

function render(force) {
  if (!force && isEditing()) {
    renderPending = true;
    renderStatus();
    return;
  }
  renderPending = false;
  view = L.buildView(state.data, state.outbox);
  const app = document.getElementById('app');
  if (!state.config) {
    app.replaceChildren(ConnectView());
    return;
  }
  const tab = currentTab();
  const screens = { today: TodayView, week: WeekView, chores: ChoresView, progress: ProgressView, settings: SettingsView };
  const y = app.dataset.tab === tab ? window.scrollY : 0;
  app.dataset.tab = tab;
  app.replaceChildren(...[
    isDemo() && DemoBar(),
    h('div', { class: 'shell' },
      SideNav(tab),
      h('main', { class: 'screen screen-' + tab }, screens[tab]())),
    TabBar(tab)].filter(Boolean));
  window.scrollTo(0, y);
  renderStatus();
}

document.addEventListener('focusout', () => setTimeout(() => renderPending && render(), 0));

const TABS = [['today', 'Today'], ['week', 'Week'], ['chores', 'Chores'], ['progress', 'Progress'], ['settings', 'Settings']];

function currentTab() {
  const t = location.hash.slice(1);
  return TABS.some(([id]) => id === t) ? t : 'today';
}

/* ---------- chrome: navigation, sync dot ---------- */

function SideNav(tab) {
  return h('aside', { class: 'sidenav' },
    h('div', { class: 'brand' }, 'Ruthines'),
    h('nav', null, TABS.map(([id, text]) =>
      h('a', { href: '#' + id, 'aria-current': id === tab ? 'page' : null }, text))),
    h('button', { class: 'sync-line', onclick: () => sync() }, SyncDot(), h('span', { class: 'sync-text' })));
}

function TabBar(tab) {
  return h('nav', { class: 'tabbar' }, TABS.slice(0, 4).map(([id, text]) =>
    h('a', { href: '#' + id, 'aria-current': id === tab ? 'page' : null }, text)));
}

function SyncDot() {
  return h('span', { class: 'dot sync-dot', 'aria-hidden': 'true' });
}

/** Top row of a screen: optional ‹ › around a title, then the sync dot and gear. */
function TopBar(title, nav) {
  return h('div', { class: 'topbar' },
    nav && h('button', { class: 'icon-btn', onclick: nav.prev, 'aria-label': nav.prevLabel }, '‹'),
    h('h1', null, title),
    nav && h('button', { class: 'icon-btn', onclick: nav.next, disabled: nav.atEnd, 'aria-label': nav.nextLabel }, '›'),
    h('span', { class: 'spacer' }),
    h('button', { class: 'icon-btn sync-btn', onclick: () => sync(), title: 'Sync now' }, SyncDot()),
    h('a', { class: 'icon-btn gear', href: '#settings', 'aria-label': 'Settings' }, '⚙'));
}

function statusText() {
  const n = state.outbox.length;
  if (state.syncing) return 'Syncing…';
  if (state.lastError) return (n ? n + ' unsent · ' : '') + state.lastError;
  if (n) return n + ' unsent';
  if (state.lastSync) return 'Synced ' + new Date(state.lastSync).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return '';
}

function renderStatus() {
  const level = state.syncing ? 'busy' : state.lastError ? 'error' : state.outbox.length ? 'pending' : 'ok';
  const text = statusText();
  document.querySelectorAll('.sync-dot').forEach((el) => { el.dataset.level = level; });
  document.querySelectorAll('.sync-btn').forEach((el) => {
    el.setAttribute('aria-label', 'Sync now. ' + text);
    el.title = text;
  });
  document.querySelectorAll('.sync-text').forEach((el) => { el.textContent = text; });
}

function DemoBar() {
  return h('div', { class: 'demobar' },
    h('span', null, 'Demo with sample data'),
    h('span', { class: 'demo-styles' }, 'Style:',
      STYLES.map((s) => h('button', {
        class: 'chip small' + (state.settings.style === s.id ? ' on' : ''),
        'aria-pressed': String(state.settings.style === s.id),
        onclick: () => setStyle(s.id),
      }, s.name))),
    h('button', { class: 'linklike', onclick: exitDemo }, 'Exit'));
}

async function exitDemo() {
  resetDemo();
  Object.assign(state, { config: null, data: null, outbox: [], lastSync: '', lastError: '', ext: null });
  await Promise.all(['config', 'data', 'outbox', 'lastSync'].map((k) => S.save(k, undefined)));
  history.replaceState(null, '', location.pathname);
  render(true);
}

async function startDemo() {
  const config = { url: DEMO_URL, key: 'demo' };
  const res = await S.fetchData(config);
  Object.assign(state, { config, data: res.data, outbox: [], lastSync: new Date().toISOString(), lastError: '' });
  await Promise.all([S.save('config', config), S.save('data', res.data), S.save('outbox', []), S.save('lastSync', state.lastSync)]);
  location.hash = '#today';
  render(true);
}

/* ---------- Connect ---------- */

function ConnectView() {
  const msg = h('p', { class: 'msg', role: 'status' });
  const url = h('input', { type: 'url', name: 'url', required: true, autocomplete: 'off', placeholder: 'https://script.google.com/macros/s/…/exec' });
  const key = h('input', { type: 'password', name: 'key', required: true, autocomplete: 'off' });
  const btn = h('button', { type: 'submit', class: 'btn primary' }, 'Connect');
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      const config = { url: url.value.trim(), key: key.value.trim() };
      if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(config.url)) {
        msg.textContent = 'The URL should start with https://script.google.com/ and end with /exec.';
        return;
      }
      btn.disabled = true;
      msg.textContent = 'Checking…';
      try {
        const res = await S.fetchData(config);
        state.config = config;
        state.data = res.data;
        state.lastSync = new Date().toISOString();
        state.lastError = '';
        await Promise.all([S.save('config', config), S.save('data', res.data), S.save('lastSync', state.lastSync)]);
        location.hash = '#today';
        render(true);
        if (state.outbox.length) scheduleSync();
      } catch (err) {
        msg.textContent = err.message === 'Wrong or missing key' ? 'The script says the key is wrong.' : err.message;
        btn.disabled = false;
      }
    },
  },
  h('label', null, h('span', { class: 'label' }, 'Script URL'), url),
  h('label', null, h('span', { class: 'label' }, 'Key'), key),
  btn, msg);

  return h('main', { class: 'connect' },
    h('div', { class: 'brand big' }, 'Ruthines'),
    h('p', null, 'Connect this device to your Ruthines Sheet once. Paste the Web app URL of your Apps Script and the key that setup() printed.'),
    h('p', { class: 'muted small' }, 'Both are stored only on this device and sent only to your script.'),
    form,
    h('p', { class: 'muted small' }, 'Just looking? ', h('button', { class: 'linklike accent', onclick: startDemo }, 'Try it with sample data')));
}

/* ---------- Today ---------- */

function TodayView() {
  const t = today();
  const d = state.viewDate && state.viewDate < t ? state.viewDate : t;
  const go = (n) => {
    const next = L.addDays(d, n);
    state.viewDate = next >= t ? null : next;
    render(true);
  };
  const icons = L.showIcons(view);
  const doneCount = view.routines.filter((r) => L.isDone(view, d, r.id)).length;
  const total = view.routines.length;
  const chores = L.choresForToday(view, d);

  return [
    TopBar(d === t ? 'Today' : L.prettyDate(d), {
      prev: () => go(-1), next: () => go(1), atEnd: d >= t, prevLabel: 'Previous day', nextLabel: 'Next day',
    }),
    h('p', { class: 'subtitle' }, d === t ? L.prettyDate(d) : h('button', { class: 'linklike accent', onclick: () => { state.viewDate = null; render(true); } }, 'Back to today')),
    d < view.since && h('p', { class: 'note' }, 'This day is older than the 90 days kept on this device, so earlier ticks may not show.'),
    total > 0 && h('div', { class: 'progress' },
      h('div', { class: 'progress-text' }, doneCount + ' of ' + total + ' done'),
      h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': total, 'aria-valuenow': doneCount },
        h('span', { style: 'width:' + (100 * doneCount / total) + '%' }))),
    h('div', { class: 'columns' },
      h('section', null,
        h('h2', { class: 'section-label' }, 'Habits'),
        total
          ? h('ul', { class: 'rows' }, view.routines.map((r) => {
            const done = L.isDone(view, d, r.id);
            return h('li', null, h('label', { class: 'habit' + (done ? ' done' : '') },
              h('input', { type: 'checkbox', class: 'tick', checked: done, onchange: () => toggleHabit(d, r.id) }),
              h('span', { class: 'habit-name' }, label(r, icons))));
          }))
          : h('p', { class: 'empty' }, 'No habits yet. Add them in ', h('a', { href: '#settings' }, 'Settings'), ' or the Routines tab of the Sheet.'),
      ),
      h('section', null,
        h('h2', { class: 'section-label' }, 'Chores due'),
        chores.length
          ? h('ul', { class: 'rows' }, chores.map(({ chore, s }) => TodayChore(chore, s, d)))
          : h('p', { class: 'empty' }, 'Nothing due in the next 2 days. ', h('a', { href: '#chores' }, 'All chores')),
      ),
    ),
  ];
}

function TodayChore(chore, s, d) {
  const done = view.choreLog.has(chore.id + '|' + d);
  const sub = [done ? 'done' : s.label, chore.zone].filter(Boolean).join(' · ');
  return h('li', { class: 'chore' + (done ? ' done' : '') },
    h('span', { class: 'dot status-' + (done ? 'done' : s.last ? s.level : 'never') }),
    h('div', { class: 'chore-main' },
      h('div', { class: 'chore-name' }, chore.name),
      h('div', { class: 'chore-sub' }, sub)),
    done
      ? h('button', { class: 'btn ghost', onclick: () => choreUndo(chore.id, d) }, 'Undo')
      : h('button', { class: 'btn outline', onclick: () => choreDone(chore.id, d) }, 'Done'));
}

/* ---------- Week ---------- */

function WeekView() {
  const t = today();
  const ws = L.weekStart(state.weekDate || t);
  const we = L.addDays(ws, 6);
  const days = L.dateRange(ws, we);
  const move = (n) => {
    const next = L.addDays(ws, 7 * n);
    state.weekDate = next > t ? null : next;
    render(true);
  };
  const isThisWeek = ws === L.weekStart(t);
  const icons = L.showIcons(view);
  const past = days.filter((d) => d <= t);
  const ticks = past.reduce((sum, d) => sum + view.routines.filter((r) => L.isDone(view, d, r.id)).length, 0);
  const range = L.shortDate(ws) + ' – ' + L.shortDate(we);

  return [
    TopBar('W' + L.isoWeek(ws), {
      prev: () => move(-1), next: () => move(1), atEnd: isThisWeek, prevLabel: 'Previous week', nextLabel: 'Next week',
    }),
    h('p', { class: 'subtitle' }, range, !isThisWeek && ' · ',
      !isThisWeek && h('button', { class: 'linklike accent', onclick: () => { state.weekDate = null; render(true); } }, 'This week')),
    we < view.since && h('p', { class: 'note' }, 'This week is older than the 90 days kept on this device, so earlier ticks may not show.'),
    h('div', { class: 'grid-wrap' },
      h('table', { class: 'grid' },
        h('thead', null, h('tr', null,
          h('th', { class: 'name' }, h('span', { class: 'sr-only' }, 'Habit')),
          days.map((d) => h('th', { class: d === t ? 'today' : null, title: L.prettyDate(d) },
            L.weekdayName(d).slice(0, 1), h('span', { class: 'daynum' }, L.parseDate(d).getDate()))),
          h('th', { class: 'count' }, '/7'))),
        h('tbody', null, view.routines.map((r) => {
          const n = days.filter((d) => L.isDone(view, d, r.id)).length;
          return h('tr', null,
            h('th', { class: 'name', scope: 'row' }, label(r, icons)),
            days.map((d) => h('td', { class: d === t ? 'today' : null },
              h('input', {
                type: 'checkbox', class: 'tick small' + (d > t ? ' future' : ''), checked: L.isDone(view, d, r.id), disabled: d > t,
                'aria-label': r.name + ', ' + L.prettyDate(d), onchange: () => toggleHabit(d, r.id),
              }))),
            h('td', { class: 'count' }, n));
        })),
      ),
    ),
    h('p', { class: 'muted small foot' },
      (isThisWeek ? 'Week so far: ' : 'Week total: ') + ticks + ' of ' + past.length * view.routines.length + ' possible'),
  ];
}

/* ---------- Chores ---------- */

/** "3 d late", "today", "in 2 d", "set up" — the short due text on the right. */
function dueShort(s) {
  if (!s.last) return 'not done yet';
  if (!s.every) return 'no interval';
  if (s.daysLeft < 0) return -s.daysLeft + ' d late';
  if (s.daysLeft === 0) return 'today';
  return 'in ' + s.daysLeft + ' d';
}

function ChoresView() {
  const t = today();
  const zones = [...new Set(view.chores.map((c) => c.zone).filter(Boolean))].sort();
  const zone = zones.includes(state.zone) ? state.zone : '';
  const list = L.choresWithStatus(view, t).filter(({ chore }) => !zone || chore.zone === zone);
  const allZones = [...new Set(view.allChores.map((c) => c.zone).filter(Boolean))].sort();
  const setZone = (z) => { state.zone = z; render(true); };

  return [
    TopBar('Chores'),
    zones.length > 0 && h('div', { class: 'chips', role: 'group', 'aria-label': 'Zone' },
      h('button', { class: 'chip' + (zone ? '' : ' on'), 'aria-pressed': String(!zone), onclick: () => setZone('') }, 'All'),
      zones.map((z) => h('button', { class: 'chip' + (zone === z ? ' on' : ''), 'aria-pressed': String(zone === z), onclick: () => setZone(z) }, z))),
    list.length
      ? h('ul', { class: 'rows' }, list.map(({ chore, s }) => ChoreRow(chore, s, t, allZones)))
      : h('p', { class: 'empty' }, view.chores.length ? 'No chores in this zone.' : 'No chores yet. Add one below, or type them into the Chores tab of the Sheet.'),
    AddChore(allZones),
    view.archivedChores.length > 0 && h('details', { class: 'archived' },
      h('summary', null, plural(view.archivedChores.length, 'archived chore')),
      h('ul', { class: 'rows' }, view.archivedChores.map((c) => h('li', { class: 'plain-row' },
        h('span', null, c.name),
        h('button', { class: 'btn ghost', onclick: () => choreOp(c, { archived: '' }) }, 'Restore'))))),
    h('datalist', { id: 'zones' }, allZones.map((z) => h('option', { value: z }))),
  ];
}

function ChoreRow(chore, s, t) {
  const doneToday = view.choreLog.has(chore.id + '|' + t);
  const open = state.openChore === chore.id;
  const sub = [
    s.every ? 'every ' + s.every + ' d' : '',
    s.last ? 'done ' + L.shortDate(s.last) : 'never done yet',
    chore.zone && !state.zone ? chore.zone : '',
  ].filter(Boolean).join(' · ');
  const toggle = () => { state.openChore = open ? '' : chore.id; render(true); };

  return h('li', { class: 'chore' + (open ? ' open' : '') + (doneToday ? ' done' : '') },
    h('span', { class: 'dot status-' + (doneToday ? 'done' : s.last ? s.level : 'never') }),
    h('button', { class: 'chore-main as-button', onclick: toggle, 'aria-expanded': String(open) },
      h('span', { class: 'chore-name' }, chore.name),
      h('span', { class: 'chore-sub' }, sub)),
    h('div', { class: 'chore-side' },
      h('span', { class: 'due status-text-' + (doneToday ? 'done' : s.last ? s.level : 'never') }, doneToday ? 'done today' : dueShort(s)),
      doneToday
        ? h('button', { class: 'btn ghost small', onclick: () => choreUndo(chore.id, t) }, 'Undo')
        : h('button', { class: 'btn outline small', onclick: () => choreDone(chore.id, t) }, 'Done')),
    open && ChoreEditor(chore, t));
}

function ChoreEditor(chore, t) {
  const name = h('input', { type: 'text', value: chore.name, required: true });
  const zone = h('input', { type: 'text', value: chore.zone || '', list: 'zones' });
  const every = h('input', { type: 'number', min: 1, step: 1, value: chore.every_days || '', class: 'short' });
  const when = h('input', { type: 'date', max: t, value: L.addDays(t, -1) });
  const history = [...view.choreLog.values()].filter((r) => r.chore_id === chore.id)
    .map((r) => r.date).sort().reverse().slice(0, 6);

  return h('div', { class: 'editor' },
    h('form', {
      class: 'fields',
      onsubmit: (e) => {
        e.preventDefault();
        if (!name.value.trim()) return;
        state.openChore = '';
        choreOp(chore, { name: name.value.trim(), zone: zone.value.trim(), every_days: every.value });
      },
    },
    h('label', null, h('span', { class: 'label' }, 'Name'), name),
    h('label', null, h('span', { class: 'label' }, 'Zone'), zone),
    h('label', null, h('span', { class: 'label' }, 'Every (days)'), every),
    h('button', { class: 'btn primary' }, 'Save')),
    h('form', {
      class: 'inline',
      onsubmit: (e) => {
        e.preventDefault();
        if (when.value) choreDone(chore.id, when.value);
      },
    }, h('span', { class: 'label' }, 'Done on another day'), when, h('button', { class: 'btn outline' }, 'Log')),
    history.length > 0 && h('p', { class: 'muted small' }, 'Recent: ', history.map(L.shortDate).join(', ')),
    h('button', { class: 'linklike danger', onclick: () => { state.openChore = ''; choreOp(chore, { archived: t }); } }, 'Archive this chore'));
}

function AddChore(zones) {
  if (!state.addingChore) {
    return h('button', { class: 'add-btn', onclick: () => { state.addingChore = true; render(true); } }, '+ Add chore');
  }
  const name = h('input', { type: 'text', required: true, placeholder: 'e.g. Clean the fridge' });
  const zone = h('input', { type: 'text', list: 'zones', placeholder: zones[0] ? 'e.g. ' + zones[0] : 'e.g. Kitchen' });
  const every = h('input', { type: 'number', min: 1, step: 1, required: true, class: 'short', value: 7 });
  const last = h('input', { type: 'date', max: today() });
  setTimeout(() => name.focus(), 0);
  return h('form', {
    class: 'editor add-form',
    onsubmit: (e) => {
      e.preventDefault();
      const id = L.newId();
      state.addingChore = false;
      choreOp({ id }, { name: name.value.trim(), zone: zone.value.trim(), every_days: every.value });
      if (last.value) choreDone(id, last.value);
    },
  },
  h('div', { class: 'fields' },
    h('label', null, h('span', { class: 'label' }, 'Name'), name),
    h('label', null, h('span', { class: 'label' }, 'Zone'), zone),
    h('label', null, h('span', { class: 'label' }, 'Every (days)'), every),
    h('label', null, h('span', { class: 'label' }, 'Last done (optional)'), last)),
  h('div', { class: 'buttons' },
    h('button', { class: 'btn primary' }, 'Add chore'),
    h('button', { type: 'button', class: 'btn ghost', onclick: () => { state.addingChore = false; render(true); } }, 'Cancel')));
}

/* ---------- Progress ---------- */

const RANGES = { '8w': ['8 weeks', 56], '6m': ['6 months', 182], all: ['All', 0] };

async function loadExt(since) {
  state.extLoading = true;
  state.extError = '';
  render(true);
  try {
    const res = await S.fetchData(state.config, since);
    state.ext = { since, data: res.data };
  } catch (e) {
    state.extError = e.message;
  }
  state.extLoading = false;
  render(true);
}

function ProgressView() {
  const t = today();
  const range = state.progressRange;
  // Long ranges reach past the 90 days kept on the device; fetch that history once.
  const need = range === 'all' ? '2000-01-01' : L.addDays(t, -(RANGES[range][1] - 1));
  let pv = view;
  if (need < view.since) {
    const ok = state.ext && state.ext.since <= need;
    if (ok) pv = L.buildView(state.ext.data, state.outbox);
    else if (!state.extLoading && !state.extError) setTimeout(() => loadExt(range === 'all' ? '2000-01-01' : need), 0);
  }
  const from = range === 'all' ? (L.earliestCheckin(pv) || t) : need;
  const weeks = L.weeklyTotals(pv, from, t);
  const icons = L.showIcons(view);
  const rows = pv.routines
    .map((r) => ({ r, rate: L.rate(pv, r.id, from, t), streak: L.streak(pv, r.id, t) }))
    .sort((a, b) => b.rate - a.rate || b.streak - a.streak);

  const download = (name, text, type) => {
    const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  };
  const setRange = (k) => { state.progressRange = k; state.extError = ''; render(true); };

  return [
    TopBar('Progress'),
    h('div', { class: 'chips', role: 'group', 'aria-label': 'Range' },
      Object.entries(RANGES).map(([k, [text]]) =>
        h('button', { class: 'chip' + (k === range ? ' on' : ''), 'aria-pressed': String(k === range), onclick: () => setRange(k) }, text))),
    state.extLoading && h('p', { class: 'note' }, 'Loading older history…'),
    state.extError && h('p', { class: 'msg' }, 'Could not load older history: ' + state.extError + ' ',
      h('button', { class: 'linklike accent', onclick: () => { state.extError = ''; render(true); } }, 'Retry')),
    h('section', { class: 'card' },
      h('h2', { class: 'section-label' }, 'Ticks per week, all habits'),
      WeeklyChart(weeks, t),
      h('details', { class: 'quiet' }, h('summary', null, 'Show as table'),
        h('table', { class: 'data-table' },
          h('thead', null, h('tr', null, h('th', null, 'Week of'), h('th', { class: 'num' }, 'Ticks'))),
          h('tbody', null, weeks.map((w) => h('tr', null, h('td', null, L.shortDate(w.week)), h('td', { class: 'num' }, w.total))))))),
    h('section', null,
      h('h2', { class: 'section-label' }, 'Per habit, ' + (range === 'all' ? 'all time' : 'last ' + RANGES[range][0])),
      h('ul', { class: 'rows stats' }, rows.map(({ r, rate, streak }) => {
        const open = state.openStat === r.id;
        return h('li', { class: 'stat' + (open ? ' open' : '') },
          h('button', {
            class: 'as-button stat-main', 'aria-expanded': String(open),
            onclick: () => { state.openStat = open ? '' : r.id; render(true); },
          },
          h('span', { class: 'stat-top' },
            h('span', { class: 'stat-name' }, label(r, icons)),
            h('span', { class: 'stat-nums' }, Math.round(rate * 100) + '%, streak ' + streak)),
          h('span', { class: 'bar' }, h('span', { style: 'width:' + Math.round(rate * 100) + '%' }))),
          open && MiniCalendar(pv, r.id, t));
      })),
      h('p', { class: 'muted small' }, 'Rate is days done out of days in the range. Streak is days in a row up to today, or up to yesterday if today isn\'t ticked yet. Tap a habit for its calendar.')),
    h('section', null,
      h('h2', { class: 'section-label' }, 'Export'),
      h('div', { class: 'buttons' },
        h('button', { class: 'btn outline', onclick: () => download('ruthines-habits-' + t + '.csv', L.habitsCsv(pv, from, t), 'text/csv') }, 'Habits CSV'),
        h('button', { class: 'btn outline', onclick: () => download('ruthines-chores-' + t + '.csv', L.choresCsv(pv), 'text/csv') }, 'Chores CSV'),
        h('button', { class: 'btn ghost', onclick: () => download('ruthines-backup-' + t + '.json', JSON.stringify(pv === view ? state.data : state.ext.data, null, 2), 'application/json') }, 'Backup JSON')),
      h('p', { class: 'muted small' }, 'Exports use the range picked above.')),
  ];
}

/** Last 5 weeks of one habit, Monday-first. */
function MiniCalendar(pv, routineId, t) {
  const start = L.addDays(L.weekStart(t), -28);
  const days = L.dateRange(start, L.addDays(L.weekStart(t), 6));
  const weeks = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
  return h('table', { class: 'mini' },
    h('thead', null, h('tr', null, ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((x) => h('th', null, x)))),
    h('tbody', null, weeks.map((w) => h('tr', null, w.map((d) => {
      const done = L.isDone(pv, d, routineId);
      return h('td', {
        class: d > t ? 'future' : done ? 'on' : 'off',
        title: L.prettyDate(d) + (d > t ? '' : done ? ': done' : ': not done'),
      }, L.parseDate(d).getDate());
    })))));
}

/** Single-series line chart with hover readout. Plain SVG, no library. */
function WeeklyChart(weeks, t) {
  if (!weeks.length) return h('p', { class: 'empty' }, 'No data yet.');
  const W = 400, H = 180, padL = 28, padR = 12, padT = 12, padB = 26;
  const max = Math.max(4, ...weeks.map((w) => w.total));
  const step = Math.pow(10, Math.floor(Math.log10(max)));
  const top = Math.ceil(max / step) * step;
  const x = (i) => padL + (weeks.length === 1 ? (W - padL - padR) / 2 : (i * (W - padL - padR)) / (weeks.length - 1));
  const y = (v) => padT + (H - padT - padB) * (1 - v / top);
  const ns = 'http://www.w3.org/2000/svg';
  const s = (tag, attrs, ...kids) => {
    const el = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    kids.forEach((k) => el.append(k));
    return el;
  };

  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': 'Ticks per week' });
  for (const v of [0, top / 2, top]) {
    svg.append(s('line', { x1: padL, x2: W - padR, y1: y(v), y2: y(v), class: v ? 'gridline' : 'baseline' }));
    svg.append(s('text', { x: padL - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'axis' }, String(v)));
  }
  const every = Math.ceil(weeks.length / 5);
  weeks.forEach((w, i) => {
    if ((weeks.length - 1 - i) % every === 0) { // count from the latest week so it is always labelled
      svg.append(s('text', { x: x(i), y: H - 8, 'text-anchor': weeks.length > 1 && i === 0 ? 'start' : weeks.length > 1 && i === weeks.length - 1 ? 'end' : 'middle', class: 'axis' }, L.shortDate(w.week)));
    }
  });
  const pts = weeks.map((w, i) => x(i) + ',' + y(w.total)).join(' ');
  svg.append(s('polygon', { points: `${x(0)},${y(0)} ${pts} ${x(weeks.length - 1)},${y(0)}`, class: 'area' }));
  svg.append(s('polyline', { points: pts, class: 'line' }));
  if (weeks.length <= 26) weeks.forEach((w, i) => svg.append(s('circle', { cx: x(i), cy: y(w.total), r: 3.5, class: 'pt' })));
  const cross = s('line', { y1: padT, y2: H - padB, class: 'cross', visibility: 'hidden' });
  const mark = s('circle', { r: 5, class: 'pt active', visibility: 'hidden' });
  svg.append(cross, mark);

  const tip = h('div', { class: 'tip', hidden: true });
  const wrap = h('div', { class: 'chartwrap' }, svg, tip);
  const thisWeek = L.weekStart(t);
  const show = (e) => {
    const box = svg.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    let i = 0;
    weeks.forEach((_, j) => { if (Math.abs(x(j) - px) < Math.abs(x(i) - px)) i = j; });
    for (const el of [cross]) { el.setAttribute('x1', x(i)); el.setAttribute('x2', x(i)); el.setAttribute('visibility', 'visible'); }
    mark.setAttribute('cx', x(i));
    mark.setAttribute('cy', y(weeks[i].total));
    mark.setAttribute('visibility', 'visible');
    tip.hidden = false;
    tip.textContent = 'Week of ' + L.shortDate(weeks[i].week) + ': ' + plural(weeks[i].total, 'tick') + (weeks[i].week === thisWeek ? ' so far' : '');
    const left = (x(i) / W) * box.width;
    tip.style.left = Math.min(Math.max(left, 80), box.width - 80) + 'px';
  };
  svg.addEventListener('pointermove', show);
  svg.addEventListener('pointerdown', show);
  svg.addEventListener('pointerleave', () => {
    tip.hidden = true;
    cross.setAttribute('visibility', 'hidden');
    mark.setAttribute('visibility', 'hidden');
  });
  return wrap;
}

/* ---------- Settings ---------- */

function moveRoutine(index, dir) {
  const list = view.routines.slice();
  const j = index + dir;
  if (j < 0 || j >= list.length) return;
  [list[index], list[j]] = [list[j], list[index]];
  list.forEach((r, i) => {
    if (String(r.order) !== String(i + 1)) routineOp(r, { order: String(i + 1) });
  });
}

function SettingsView() {
  const n = state.outbox.length;
  const maxOrder = Math.max(0, ...view.allRoutines.map((r) => Number(r.order) || 0));
  const icons = L.showIcons(view);
  const missing = view.routines.filter((r) => !r.icon);
  const newIcon = h('input', { type: 'text', class: 'icon', placeholder: '🙂', 'aria-label': 'Icon' });
  const newName = h('input', { type: 'text', required: true, placeholder: 'New habit', 'aria-label': 'Name' });
  const syncLevel = state.lastError ? 'error' : n ? 'pending' : 'ok';

  return [
    TopBar('Settings'),

    h('section', null,
      h('h2', { class: 'section-label' }, 'Style'),
      h('div', { class: 'styles' }, STYLES.map((s) => h('button', {
        class: 'style-card' + (state.settings.style === s.id ? ' on' : ''),
        'data-style': s.id, 'aria-pressed': String(state.settings.style === s.id), onclick: () => setStyle(s.id),
      },
      h('span', { class: 'style-sample' }, 'Aa'),
      h('span', { class: 'style-name' }, s.name),
      h('span', { class: 'style-note' }, s.font),
      h('span', { class: 'style-swatch' })))),
      h('p', { class: 'muted small' }, 'Font and accent colour. Set per device.')),

    h('section', null,
      h('h2', { class: 'section-label' }, 'Habits'),
      h('ul', { class: 'rows' }, view.routines.map((r, i) => {
        const open = state.openHabit === r.id;
        return h('li', { class: 'habit-edit' + (open ? ' open' : '') },
          h('div', { class: 'plain-row' },
            h('span', { class: 'habit-name' }, label(r, icons)),
            h('button', { class: 'linklike accent', 'aria-expanded': String(open), onclick: () => { state.openHabit = open ? '' : r.id; render(true); } }, open ? 'Close' : 'Edit')),
          open && h('div', { class: 'editor' },
            h('div', { class: 'inline' },
              h('input', { type: 'text', class: 'icon', value: r.icon || '', 'aria-label': 'Icon for ' + r.name, onchange: (e) => routineOp(r, { icon: e.target.value.trim() }) }),
              h('input', { type: 'text', class: 'grow', value: r.name, 'aria-label': 'Name', onchange: (e) => e.target.value.trim() && routineOp(r, { name: e.target.value.trim() }) })),
            h('div', { class: 'buttons' },
              h('button', { class: 'btn ghost', onclick: () => moveRoutine(i, -1), disabled: i === 0, 'aria-label': 'Move ' + r.name + ' up' }, '↑ Up'),
              h('button', { class: 'btn ghost', onclick: () => moveRoutine(i, 1), disabled: i === view.routines.length - 1, 'aria-label': 'Move ' + r.name + ' down' }, '↓ Down'),
              h('button', { class: 'linklike danger', onclick: () => { state.openHabit = ''; routineOp(r, { archived: today() }); }, 'aria-label': 'Archive ' + r.name }, 'Archive'))));
      })),
      h('form', {
        class: 'inline add-habit',
        onsubmit: (e) => {
          e.preventDefault();
          if (!newName.value.trim()) return;
          routineOp({ id: L.newId() }, { name: newName.value.trim(), icon: newIcon.value.trim(), order: String(maxOrder + 1) });
        },
      }, newIcon, newName, h('button', { class: 'btn outline' }, '+ Add habit')),
      missing.length > 0 && view.routines.length > missing.length && h('p', { class: 'note' },
        'Icons are hidden because ' + plural(missing.length, 'habit') + ' ' + (missing.length === 1 ? 'has' : 'have') + ' none: ',
        missing.map((r) => r.name).join(', '), '. Give each an emoji (Edit, or the icon column in the Routines tab) and all icons show.'),
      view.archivedRoutines.length > 0 && h('details', { class: 'archived' },
        h('summary', null, plural(view.archivedRoutines.length, 'archived habit')),
        h('ul', { class: 'rows' }, view.archivedRoutines.map((r) => h('li', { class: 'plain-row' },
          h('span', null, r.name),
          h('button', { class: 'btn ghost', onclick: () => routineOp(r, { archived: '', order: String(maxOrder + 1) }) }, 'Restore')))))),

    h('section', null,
      h('h2', { class: 'section-label' }, 'Sync'),
      h('div', { class: 'status-line' },
        h('span', { class: 'dot', 'data-level': syncLevel }),
        h('div', null,
          h('div', null, isDemo() ? 'Demo mode, sample data on this device' : state.lastError ? 'Not synced' : 'Connected to your Ruthines Sheet'),
          h('div', { class: 'muted small' },
            state.lastSync ? 'Last synced ' + new Date(state.lastSync).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'Not synced yet',
            ', ', n ? plural(n, 'change') + ' waiting' : 'nothing waiting'),
          state.lastError && h('div', { class: 'msg small' }, state.lastError)),
        h('button', { class: 'btn outline', onclick: () => sync(), disabled: state.syncing }, state.syncing ? 'Syncing…' : 'Sync now'))),

    h('section', null,
      h('h2', { class: 'section-label' }, 'Day'),
      h('label', { class: 'plain-row' },
        h('span', null, 'Day starts at', h('span', { class: 'muted small block' }, 'Ticks before this hour count for the day before')),
        h('select', {
          onchange: (e) => {
            state.settings.dayStart = Number(e.target.value);
            S.save('settings', state.settings);
            render(true);
          },
        }, [0, 1, 2, 3, 4, 5, 6].map((hr) => h('option', { value: hr, selected: hr === state.settings.dayStart }, String(hr).padStart(2, '0') + ':00'))))),

    h('section', null,
      h('h2', { class: 'section-label' }, 'Install'),
      h('ul', { class: 'plain-list muted small' },
        h('li', null, 'iPhone: open in Safari, tap Share, then Add to Home Screen.'),
        h('li', null, 'Mac or PC in Chrome or Edge: the install icon at the right of the address bar.'),
        h('li', null, 'Mac in Safari: File, then Add to Dock.'))),

    h('section', null,
      h('h2', { class: 'section-label' }, 'This device'),
      !isDemo() && h('p', { class: 'muted small' }, 'Connected to ' + state.config.url.replace(/\/macros\/s\/(.{6}).*\/exec$/, '/macros/s/$1…/exec')),
      isDemo()
        ? h('button', { class: 'linklike danger', onclick: exitDemo }, 'Exit the demo')
        : h('button', {
          class: 'linklike danger',
          onclick: async () => {
            const warn = n ? plural(n, 'change') + ' on this device are not in the Sheet yet and will be lost. ' : '';
            if (!confirm(warn + 'Disconnect this device? The Sheet is not touched.')) return;
            Object.assign(state, { config: null, data: null, outbox: [], lastSync: '', lastError: '', ext: null });
            await Promise.all(['config', 'data', 'outbox', 'lastSync'].map((k) => S.save(k, undefined)));
            render(true);
          },
        }, 'Disconnect this device'),
      h('p', { class: 'muted small' }, 'Ruthines ' + VERSION)),
  ];
}

/* ---------- start ---------- */

async function start() {
  const [config, data, outbox, settings, lastSync] = await Promise.all(
    ['config', 'data', 'outbox', 'settings', 'lastSync'].map((k) => S.load(k)));
  Object.assign(state, {
    config: config || null,
    data: data || null,
    outbox: outbox || [],
    settings: { dayStart: 4, style: 'clay', ...(settings || {}) },
    lastSync: lastSync || '',
  });
  const params = new URLSearchParams(location.search);
  const styleParam = params.get('style');
  if (STYLES.some((s) => s.id === styleParam)) state.settings.style = styleParam;
  applyStyle();
  if ((params.has('demo') || self.RUTHINES_DEMO) && !state.config) await startDemo();
  render(true);
  if (state.config) sync();

  addEventListener('hashchange', () => render(true));
  addEventListener('online', () => sync());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      render(true); // the day may have rolled over
      sync();
    }
  });
  // Retry unsent changes every minute while the app is open.
  setInterval(() => {
    if (document.visibilityState === 'visible' && state.outbox.length && !state.syncing) sync();
  }, 60000);

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('./sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) return;
      const bar = h('button', { class: 'update btn primary', onclick: () => location.reload() }, 'A new version is ready. Tap to reload.');
      document.body.append(bar);
    });
  }
}

start();
