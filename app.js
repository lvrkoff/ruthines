import * as L from './logic.js';
import * as S from './store.js';

export const VERSION = '1.0.0';

const state = {
  config: null, // { url, key } — stored only on this device
  data: null, // last data returned by the script
  outbox: [], // changes not yet confirmed by the script
  settings: { dayStart: 4 },
  lastSync: '',
  lastError: '',
  syncing: false,
  viewDate: null, // Today screen: day being viewed (null = today)
  weekDate: null, // Week screen: any day in the week being viewed
  progressRange: '12w',
  allData: null, // Progress "All": full history, fetched on demand
  allError: '',
  allLoading: false,
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
  app.replaceChildren(Nav(tab), h('main', null, screens[tab]()));
  renderStatus();
}

document.addEventListener('focusout', () => setTimeout(() => renderPending && render(), 0));

const TABS = [['today', 'Today'], ['week', 'Week'], ['chores', 'Chores'], ['progress', 'Progress'], ['settings', 'Settings']];

function currentTab() {
  const t = location.hash.slice(1);
  return TABS.some(([id]) => id === t) ? t : 'today';
}

function Nav(tab) {
  return h('header', null,
    h('nav', null, TABS.map(([id, label]) =>
      h('a', { href: '#' + id, 'aria-current': id === tab ? 'page' : null }, label))),
    h('button', { id: 'status', class: 'linklike', title: 'Sync now', onclick: () => sync() }),
  );
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
  const el = document.getElementById('status');
  if (!el) return;
  el.textContent = statusText();
  el.classList.toggle('warn', !!state.lastError || state.outbox.length > 0);
}

/* ---------- Connect ---------- */

function ConnectView() {
  const msg = h('p', { class: 'msg', role: 'status' });
  const url = h('input', { type: 'url', name: 'url', required: true, autocomplete: 'off', placeholder: 'https://script.google.com/macros/s/…/exec' });
  const key = h('input', { type: 'password', name: 'key', required: true, autocomplete: 'off' });
  const btn = h('button', { type: 'submit' }, 'Connect');
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
  h('label', null, 'Script URL', url),
  h('label', null, 'Key', key),
  btn, msg);

  return h('main', { class: 'connect' },
    h('h1', null, 'Ruthines'),
    h('p', null, 'Connect this device to your Ruthines Sheet once. Paste the Web app URL of your Apps Script and the key that setup() printed.'),
    h('p', { class: 'muted' }, 'Both are stored only on this device and sent only to your script.'),
    form);
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
  const doneCount = view.routines.filter((r) => L.isDone(view, d, r.id)).length;
  const chores = L.choresForToday(view, d);

  return h('div', null,
    h('div', { class: 'daynav' },
      h('button', { onclick: () => go(-1), 'aria-label': 'Previous day' }, '‹'),
      h('h1', null, d === t ? 'Today' : L.prettyDate(d)),
      h('button', { onclick: () => go(1), disabled: d >= t, 'aria-label': 'Next day' }, '›'),
      d !== t && h('button', { class: 'linklike', onclick: () => { state.viewDate = null; render(true); } }, 'Back to today'),
    ),
    d === t && h('p', { class: 'muted' }, L.prettyDate(d)),
    d < view.since && h('p', { class: 'muted' }, 'This day is older than the 90 days kept on this device, so earlier ticks may not show.'),
    h('div', { class: 'columns' },
      h('section', null,
        h('h2', null, 'Habits ', h('span', { class: 'muted' }, doneCount + '/' + view.routines.length)),
        view.routines.length
          ? h('ul', { class: 'habits' }, view.routines.map((r) =>
            h('li', null, h('label', { class: 'habit' },
              h('input', { type: 'checkbox', checked: L.isDone(view, d, r.id), onchange: () => toggleHabit(d, r.id) }),
              h('span', null, r.icon ? r.icon + ' ' : '', r.name)))))
          : h('p', { class: 'muted' }, 'No habits yet. Add them in Settings or the Routines tab of the Sheet.'),
      ),
      h('section', null,
        h('h2', null, 'Chores due'),
        chores.length
          ? h('ul', { class: 'chores' }, chores.map(({ chore, s }) => ChoreRow(chore, s, d)))
          : h('p', { class: 'muted' }, 'Nothing due in the next 2 days. ', h('a', { href: '#chores' }, 'All chores')),
      ),
    ),
  );
}

function ChoreRow(chore, s, d) {
  const done = view.choreLog.has(chore.id + '|' + d);
  return h('li', { class: 'chore' },
    h('div', null,
      h('strong', null, chore.name),
      chore.zone && h('span', { class: 'muted' }, ' · ' + chore.zone),
      h('div', null, done ? h('span', { class: 'status done' }, 'done') : h('span', { class: 'status ' + s.level }, s.label)),
    ),
    done
      ? h('button', { onclick: () => choreUndo(chore.id, d) }, 'Undo')
      : h('button', { onclick: () => choreDone(chore.id, d) }, 'Done'),
  );
}

/* ---------- Week ---------- */

function WeekView() {
  const t = today();
  const ws = L.weekStart(state.weekDate || t);
  const days = L.dateRange(ws, L.addDays(ws, 6));
  const move = (n) => {
    const next = L.addDays(ws, 7 * n);
    state.weekDate = next > t ? null : next;
    render(true);
  };
  const isThisWeek = ws === L.weekStart(t);

  return h('div', null,
    h('div', { class: 'daynav' },
      h('button', { onclick: () => move(-1), 'aria-label': 'Previous week' }, '‹'),
      h('h1', null, isThisWeek ? 'This week' : 'Week of ' + L.shortDate(ws)),
      h('button', { onclick: () => move(1), disabled: isThisWeek, 'aria-label': 'Next week' }, '›'),
      !isThisWeek && h('button', { class: 'linklike', onclick: () => { state.weekDate = null; render(true); } }, 'This week'),
    ),
    days[6] < view.since && h('p', { class: 'muted' }, 'This week is older than the 90 days kept on this device, so earlier ticks may not show.'),
    h('div', { class: 'scroll' },
      h('table', { class: 'grid' },
        h('thead', null, h('tr', null,
          h('th', { class: 'name' }, 'Habit'),
          days.map((d) => h('th', { class: d === t ? 'today' : null }, L.weekdayName(d).slice(0, 2), h('br'), L.parseDate(d).getDate())),
          h('th', null, 'Done'))),
        h('tbody', null, view.routines.map((r) => {
          const n = days.filter((d) => L.isDone(view, d, r.id)).length;
          return h('tr', null,
            h('th', { class: 'name', scope: 'row' }, r.icon ? r.icon + ' ' : '', r.name),
            days.map((d) => h('td', { class: d === t ? 'today' : null },
              h('input', {
                type: 'checkbox', checked: L.isDone(view, d, r.id), disabled: d > t,
                'aria-label': r.name + ', ' + L.prettyDate(d), onchange: () => toggleHabit(d, r.id),
              }))),
            h('td', { class: 'num' }, n + '/7'));
        })),
        h('tfoot', null, h('tr', null,
          h('th', { class: 'name' }, 'Total'),
          days.map((d) => h('td', { class: 'num' }, d > t ? '' : view.routines.filter((r) => L.isDone(view, d, r.id)).length)),
          h('td', { class: 'num' }, days.reduce((sum, d) => sum + view.routines.filter((r) => L.isDone(view, d, r.id)).length, 0)))),
      ),
    ),
  );
}

/* ---------- Chores ---------- */

const LEVEL_TEXT = { overdue: 'Overdue', soon: 'Due within 2 days', week: 'Due within a week', fine: 'Fine' };

function ChoresView() {
  const t = today();
  const list = L.choresWithStatus(view, t);
  // Group by zone; zones ordered by their most urgent chore.
  const zones = new Map();
  for (const x of list) {
    const z = x.chore.zone || 'No zone';
    if (!zones.has(z)) zones.set(z, []);
    zones.get(z).push(x);
  }
  const zoneNames = [...new Set(view.allChores.map((c) => c.zone).filter(Boolean))].sort();
  const counts = { overdue: 0, soon: 0 };
  list.forEach(({ s }) => { if (s.level in counts && !s.doneToday) counts[s.level]++; });

  return h('div', null,
    h('h1', null, 'Chores'),
    list.length
      ? h('p', { class: 'muted' }, plural(counts.overdue, 'chore') + ' overdue, ' + counts.soon + ' due within 2 days.')
      : h('p', { class: 'muted' }, 'No chores yet. Add one below, or type them into the Chores tab of the Sheet.'),
    [...zones].map(([zone, items]) => h('section', null,
      h('h2', null, zone),
      h('ul', { class: 'chores' }, items.map(({ chore, s }) => ChoreCard(chore, s, t, zoneNames))))),
    AddChoreForm(zoneNames),
    view.archivedChores.length > 0 && h('details', null,
      h('summary', null, 'Archived chores (' + view.archivedChores.length + ')'),
      h('ul', { class: 'plain' }, view.archivedChores.map((c) => h('li', null, c.name + ' ',
        h('button', { onclick: () => choreOp(c, { archived: '' }) }, 'Restore'))))),
    h('datalist', { id: 'zones' }, zoneNames.map((z) => h('option', { value: z }))),
  );
}

function ChoreCard(chore, s, t) {
  const doneToday = view.choreLog.has(chore.id + '|' + t);
  const name = h('input', { type: 'text', value: chore.name, required: true });
  const zone = h('input', { type: 'text', value: chore.zone || '', list: 'zones' });
  const every = h('input', { type: 'number', min: 1, step: 1, value: chore.every_days || '', class: 'short' });
  const when = h('input', { type: 'date', max: t, value: L.addDays(t, -1) });
  const facts = [
    s.every ? 'every ' + plural(s.every, 'day') : 'no interval set',
    s.last ? 'last done ' + L.shortDate(s.last) : 'never done',
    s.next ? 'next ' + L.shortDate(s.next) : '',
  ].filter(Boolean).join(' · ');

  return h('li', { class: 'chore card' },
    h('div', { class: 'row' },
      h('div', null,
        h('strong', null, chore.name),
        h('div', null,
          doneToday ? h('span', { class: 'status done' }, 'done today') : h('span', { class: 'status ' + s.level, title: LEVEL_TEXT[s.level] }, s.label)),
        h('div', { class: 'muted small' }, facts)),
      doneToday
        ? h('button', { onclick: () => choreUndo(chore.id, t) }, 'Undo')
        : h('button', { onclick: () => choreDone(chore.id, t) }, 'Done'),
    ),
    h('details', null,
      h('summary', null, 'More'),
      h('form', {
        class: 'inline',
        onsubmit: (e) => {
          e.preventDefault();
          if (!when.value) return;
          choreDone(chore.id, when.value);
        },
      }, h('label', null, 'Done on ', when), h('button', null, 'Log')),
      h('form', {
        class: 'inline',
        onsubmit: (e) => {
          e.preventDefault();
          if (!name.value.trim()) return;
          choreOp(chore, { name: name.value.trim(), zone: zone.value.trim(), every_days: every.value });
        },
      },
      h('label', null, 'Name ', name),
      h('label', null, 'Zone ', zone),
      h('label', null, 'Every ', every, ' days'),
      h('button', null, 'Save')),
      h('button', { onclick: () => choreOp(chore, { archived: t }) }, 'Archive'),
    ),
  );
}

function AddChoreForm() {
  const name = h('input', { type: 'text', required: true, placeholder: 'e.g. Clean the fridge' });
  const zone = h('input', { type: 'text', list: 'zones', placeholder: 'e.g. Kitchen' });
  const every = h('input', { type: 'number', min: 1, step: 1, required: true, class: 'short', value: 7 });
  const last = h('input', { type: 'date', max: today() });
  return h('details', { class: 'add' },
    h('summary', null, 'Add a chore'),
    h('form', {
      class: 'stack',
      onsubmit: (e) => {
        e.preventDefault();
        const id = L.newId();
        choreOp({ id }, { name: name.value.trim(), zone: zone.value.trim(), every_days: every.value });
        if (last.value) choreDone(id, last.value);
      },
    },
    h('label', null, 'Name ', name),
    h('label', null, 'Zone ', zone),
    h('label', null, 'Every ', every, ' days'),
    h('label', null, 'Last done (optional) ', last),
    h('button', null, 'Add chore')));
}

/* ---------- Progress ---------- */

const RANGES = { '4w': ['Last 4 weeks', 28], '12w': ['Last 12 weeks', 84], all: ['All time', 0] };

async function loadAll() {
  state.allLoading = true;
  state.allError = '';
  render(true);
  try {
    const res = await S.fetchData(state.config, '2000-01-01');
    state.allData = res.data;
  } catch (e) {
    state.allError = e.message;
  }
  state.allLoading = false;
  render(true);
}

function ProgressView() {
  const t = today();
  const range = state.progressRange;
  let pv = view;
  if (range === 'all') {
    if (!state.allData && !state.allLoading && !state.allError) setTimeout(loadAll, 0);
    if (state.allData) pv = L.buildView(state.allData, state.outbox);
  }
  const from = range === 'all' ? (L.earliestCheckin(pv) || t) : L.addDays(t, -(RANGES[range][1] - 1));
  const weeks = L.weeklyTotals(pv, from, t);
  const rows = pv.routines
    .map((r) => ({ r, rate: L.rate(pv, r.id, from, t), streak: L.streak(pv, r.id, t) }))
    .sort((a, b) => b.rate - a.rate || b.streak - a.streak);

  const download = (name, text, type) => {
    const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  };

  return h('div', null,
    h('h1', null, 'Progress'),
    h('label', null, 'Range ',
      h('select', {
        onchange: (e) => { state.progressRange = e.target.value; render(true); },
      }, Object.entries(RANGES).map(([k, [label]]) => h('option', { value: k, selected: k === range }, label)))),
    range === 'all' && state.allLoading && h('p', { class: 'muted' }, 'Loading full history…'),
    range === 'all' && state.allError && h('p', { class: 'msg' }, 'Could not load full history: ' + state.allError + ' ',
      h('button', { onclick: loadAll }, 'Retry')),
    h('section', null,
      h('h2', null, 'Ticks per week'),
      WeeklyChart(weeks, t),
      h('details', null, h('summary', null, 'Show as table'),
        h('table', { class: 'plain-table' },
          h('thead', null, h('tr', null, h('th', null, 'Week of'), h('th', null, 'Ticks'))),
          h('tbody', null, weeks.map((w) => h('tr', null, h('td', null, L.shortDate(w.week)), h('td', { class: 'num' }, w.total))))))),
    h('section', null,
      h('h2', null, 'By habit'),
      h('p', { class: 'muted small' }, 'Rate is days done out of days in the range. Streak is days in a row up to today, or up to yesterday if today isn\'t ticked yet.'),
      h('table', { class: 'plain-table habits-table' },
        h('thead', null, h('tr', null, h('th', null, 'Habit'), h('th', null, 'Rate'), h('th', null, 'Streak'))),
        h('tbody', null, rows.map(({ r, rate, streak }) => h('tr', null,
          h('td', null, h('details', null,
            h('summary', null, r.icon ? r.icon + ' ' : '', r.name),
            MiniCalendar(pv, r.id, t))),
          h('td', { class: 'num' }, Math.round(rate * 100) + '%'),
          h('td', { class: 'num' }, plural(streak, 'day'))))))),
    h('section', null,
      h('h2', null, 'Export'),
      h('p', { class: 'muted small' }, 'Uses the selected range. Pick "All time" for your full history.'),
      h('div', { class: 'buttons' },
        h('button', { onclick: () => download('ruthines-habits-' + t + '.csv', L.habitsCsv(pv, from, t), 'text/csv') }, 'Habits CSV'),
        h('button', { onclick: () => download('ruthines-chores-' + t + '.csv', L.choresCsv(pv), 'text/csv') }, 'Chores CSV'),
        h('button', { onclick: () => download('ruthines-backup-' + t + '.json', JSON.stringify(range === 'all' && state.allData ? state.allData : state.data, null, 2), 'application/json') }, 'Backup JSON'))),
  );
}

/** Last 5 weeks of one habit, Monday-first, as a small grid. */
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
  if (!weeks.length) return h('p', { class: 'muted' }, 'No data yet.');
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
    svg.append(s('line', { x1: padL, x2: W - padR, y1: y(v), y2: y(v), class: 'gridline' }));
    svg.append(s('text', { x: padL - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'axis' }, String(v)));
  }
  const every = Math.ceil(weeks.length / 5);
  weeks.forEach((w, i) => {
    if (i % every === 0 || i === weeks.length - 1) {
      svg.append(s('text', { x: x(i), y: H - 8, 'text-anchor': 'middle', class: 'axis' }, L.shortDate(w.week)));
    }
  });
  svg.append(s('polyline', { points: weeks.map((w, i) => x(i) + ',' + y(w.total)).join(' '), class: 'line' }));
  weeks.forEach((w, i) => svg.append(s('circle', { cx: x(i), cy: y(w.total), r: 4, class: 'dot' })));
  const cross = s('line', { y1: padT, y2: H - padB, class: 'cross', visibility: 'hidden' });
  svg.append(cross);

  const tip = h('div', { class: 'tip', hidden: true });
  const wrap = h('div', { class: 'chartwrap' }, svg, tip);
  const thisWeek = L.weekStart(t);
  const show = (e) => {
    const box = svg.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    let i = 0;
    weeks.forEach((_, j) => { if (Math.abs(x(j) - px) < Math.abs(x(i) - px)) i = j; });
    cross.setAttribute('x1', x(i));
    cross.setAttribute('x2', x(i));
    cross.setAttribute('visibility', 'visible');
    tip.hidden = false;
    tip.textContent = 'Week of ' + L.shortDate(weeks[i].week) + ': ' + plural(weeks[i].total, 'tick') + (weeks[i].week === thisWeek ? ' so far' : '');
    const left = (x(i) / W) * box.width;
    tip.style.left = Math.min(Math.max(left, 70), box.width - 70) + 'px';
  };
  svg.addEventListener('pointermove', show);
  svg.addEventListener('pointerdown', show);
  svg.addEventListener('pointerleave', () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); });
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
  const newIcon = h('input', { type: 'text', class: 'icon', placeholder: '🙂', 'aria-label': 'Icon' });
  const newName = h('input', { type: 'text', required: true, placeholder: 'New habit', 'aria-label': 'Name' });

  return h('div', null,
    h('h1', null, 'Settings'),

    h('section', null,
      h('h2', null, 'Sync'),
      h('p', null,
        n ? plural(n, 'change') + ' not yet in the Sheet. ' : 'Every change is in the Sheet. ',
        state.lastSync ? 'Last synced ' + new Date(state.lastSync).toLocaleString() + '.' : ''),
      state.lastError && h('p', { class: 'msg' }, 'Last attempt failed: ' + state.lastError),
      h('button', { onclick: () => sync(), disabled: state.syncing }, state.syncing ? 'Syncing…' : 'Sync now')),

    h('section', null,
      h('h2', null, 'Habits'),
      h('p', { class: 'muted small' }, 'Changes save when you leave a field. You can also edit the Routines tab in the Sheet.'),
      h('ul', { class: 'plain edit-list' }, view.routines.map((r, i) => h('li', null,
        h('input', { type: 'text', class: 'icon', value: r.icon || '', 'aria-label': 'Icon for ' + r.name, onchange: (e) => routineOp(r, { icon: e.target.value.trim() }) }),
        h('input', { type: 'text', value: r.name, 'aria-label': 'Name', onchange: (e) => e.target.value.trim() && routineOp(r, { name: e.target.value.trim() }) }),
        h('button', { onclick: () => moveRoutine(i, -1), disabled: i === 0, 'aria-label': 'Move ' + r.name + ' up' }, '↑'),
        h('button', { onclick: () => moveRoutine(i, 1), disabled: i === view.routines.length - 1, 'aria-label': 'Move ' + r.name + ' down' }, '↓'),
        h('button', { onclick: () => routineOp(r, { archived: today() }), 'aria-label': 'Archive ' + r.name }, 'Archive')))),
      h('form', {
        class: 'inline',
        onsubmit: (e) => {
          e.preventDefault();
          if (!newName.value.trim()) return;
          routineOp({ id: L.newId() }, { name: newName.value.trim(), icon: newIcon.value.trim(), order: String(maxOrder + 1) });
        },
      }, newIcon, newName, h('button', null, 'Add habit')),
      view.archivedRoutines.length > 0 && h('details', null,
        h('summary', null, 'Archived habits (' + view.archivedRoutines.length + ')'),
        h('ul', { class: 'plain' }, view.archivedRoutines.map((r) => h('li', null, (r.icon ? r.icon + ' ' : '') + r.name + ' ',
          h('button', { onclick: () => routineOp(r, { archived: '', order: String(maxOrder + 1) }) }, 'Restore')))))),

    h('section', null,
      h('h2', null, 'Day starts at'),
      h('p', { class: 'muted small' }, 'Ticks made before this hour count for the previous day. Set per device.'),
      h('select', {
        onchange: (e) => {
          state.settings.dayStart = Number(e.target.value);
          S.save('settings', state.settings);
          render(true);
        },
      }, [0, 1, 2, 3, 4, 5, 6].map((hr) => h('option', { value: hr, selected: hr === state.settings.dayStart }, String(hr).padStart(2, '0') + ':00')))),

    h('section', null,
      h('h2', null, 'Install'),
      h('ul', null,
        h('li', null, 'iPhone: open in Safari, tap Share, then Add to Home Screen.'),
        h('li', null, 'Mac or PC in Chrome or Edge: click the install icon at the right of the address bar.'),
        h('li', null, 'Mac in Safari: File, then Add to Dock.'))),

    h('section', null,
      h('h2', null, 'This device'),
      h('p', { class: 'muted small' }, 'Connected to ' + state.config.url.replace(/\/macros\/s\/(.{6}).*\/exec$/, '/macros/s/$1…/exec')),
      h('button', {
        onclick: async () => {
          const warn = n ? plural(n, 'change') + ' on this device are not in the Sheet yet and will be lost. ' : '';
          if (!confirm(warn + 'Disconnect this device? The Sheet is not touched.')) return;
          Object.assign(state, { config: null, data: null, outbox: [], lastSync: '', lastError: '', allData: null });
          await Promise.all(['config', 'data', 'outbox', 'lastSync'].map((k) => S.save(k, undefined)));
          render(true);
        },
      }, 'Disconnect this device'),
      h('p', { class: 'muted small' }, 'Ruthines ' + VERSION)),
  );
}

/* ---------- start ---------- */

async function start() {
  const [config, data, outbox, settings, lastSync] = await Promise.all(
    ['config', 'data', 'outbox', 'settings', 'lastSync'].map((k) => S.load(k)));
  Object.assign(state, {
    config: config || null,
    data: data || null,
    outbox: outbox || [],
    settings: { dayStart: 4, ...(settings || {}) },
    lastSync: lastSync || '',
  });
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
      const bar = h('button', { class: 'update', onclick: () => location.reload() }, 'A new version is ready. Tap to reload.');
      document.body.append(bar);
    });
  }
}

start();
