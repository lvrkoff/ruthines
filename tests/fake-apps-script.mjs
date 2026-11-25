// Runs the real apps-script/Code.gs in Node against an in-memory fake Sheet,
// so tests exercise the same backend the app talks to in production.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

class FakeSheet {
  constructor(name) { this.name = name; this.rows = []; this.maxRows = 1000; }
  getName() { return this.name; }
  getLastRow() {
    for (let i = this.rows.length - 1; i >= 0; i--) if (this.rows[i] && this.rows[i].some((c) => c !== '')) return i + 1;
    return 0;
  }
  getMaxRows() { return this.maxRows; }
  insertRowsAfter(_after, n) { this.maxRows += n; }
  deleteRow(r) { this.rows.splice(r - 1, 1); }
  setFrozenRows() {}
  hideColumns() {}
  cell(r, c) { return ((this.rows[r - 1] || [])[c - 1]) ?? ''; }
  set(r, c, v) { while (this.rows.length < r) this.rows.push([]); this.rows[r - 1][c - 1] = v == null ? '' : String(v); }
  width() { return Math.max(0, ...this.rows.map((r) => r.length)); }
  getDataRange() { return this.getRange(1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.width())); }
  getRange(r, c, nr = 1, nc = 1) {
    const sh = this;
    const range = {
      getRow: () => r,
      setNumberFormat: () => range,
      setFontWeight: () => range,
      clearContent: () => { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) sh.set(r + i, c + j, ''); return range; },
      setValues: (vals) => { vals.forEach((row, i) => row.forEach((v, j) => sh.set(r + i, c + j, v))); return range; },
      getDisplayValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => sh.cell(r + i, c + j))),
      getDisplayValue: () => sh.cell(r, c),
      createTextFinder: (text) => ({
        matchEntireCell: () => ({
          findNext: () => {
            for (let i = 0; i < nr; i++) if (sh.cell(r + i, c) === text) return { getRow: () => r + i };
            return null;
          },
        }),
      }),
    };
    return range;
  }
}

export function createBackend({ tz = 'UTC' } = {}) {
  const sheets = new Map();
  const props = new Map();
  const ss = {
    getSheetByName: (n) => sheets.get(n) || null,
    insertSheet: (n) => { const s = new FakeSheet(n); sheets.set(n, s); return s; },
    getSheets: () => [...sheets.values()],
    getSpreadsheetTimeZone: () => tz,
  };
  const ctx = {
    SpreadsheetApp: { getActive: () => ss },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props.get(k) ?? null, setProperty: (k, v) => props.set(k, v), deleteProperty: (k) => props.delete(k) }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (text) => ({ text, setMimeType() { return this; } }),
    },
    ScriptApp: {
      getProjectTriggers: () => [],
      newTrigger: () => ({ timeBased: () => ({ onMonthDay: () => ({ atHour: () => ({ create() {} }) }) }) }),
    },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      formatDate: (d) => d.toISOString().slice(0, 10),
    },
    Logger: { log() {} },
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(here, '..', 'apps-script', 'Code.gs'), 'utf8'), ctx);
  ctx.setup();
  const key = props.get('SECRET');
  return {
    key,
    sheets,
    props,
    setup: () => ctx.setup(),
    get: (params) => JSON.parse(ctx.doGet({ parameter: params }).text),
    post: (body) => JSON.parse(ctx.doPost({ postData: { contents: body } }).text),
    addChore: (name, zone, every) => {
      const sh = sheets.get('Chores');
      const r = sh.getLastRow() + 1;
      [ '', name, zone, String(every), '' ].forEach((v, j) => sh.set(r, j + 1, v));
    },
  };
}
