# Ruthines

A single-user habit and household chores tracker. It's an installable web app
(PWA) that works offline and syncs through a Google Sheet that you own.

- **App:** static files in this repo, served by any static host (Cloudflare Pages or GitHub Pages). There's no build step and no server.
- **Data:** your Google Sheet, through the Apps Script in [`apps-script/Code.gs`](apps-script/Code.gs).
- **This repo never holds data, the script URL or the key.** Each device is connected once
  on the Connect screen, and both values stay in that browser's storage.

## Screens

| Screen | What it does |
|---|---|
| Today | Today's habits as tick rows, plus chores that are overdue or due within 2 days. Arrows go back to earlier days. |
| Week | Habits × Mon–Sun grid for catching up. Opens on the current week. |
| Chores | Every chore grouped by zone, worst first, with the red/orange/yellow/grey status. Done, Undo, done on another date, add, edit, archive. |
| Progress | Ticks per week, plus rate and streak per habit. CSV export of habits and chores, and a JSON backup. |
| Settings | Sync status and Sync now. Add, rename, reorder and archive habits. Day-start hour, install tips, and disconnecting this device. |

**Look.** Manrope with a teal accent, in light and dark following the system. Habit emoji show only when
*every* active habit has one; otherwise none show, and Settings names the habits still missing one.
The logo is a teal sprout on white; `icons/icon.svg` is the source for the PNG icons.

**Demo.** Open the app with `?demo` (or tap *Try it with sample data* on the Connect screen) to use it with sample
habits and chores. Nothing is sent anywhere. `node tools/build-demo.mjs demo.html` builds the same demo as a single
self-contained page.

The day starts at 04:00, so a tick at 01:00 counts for the day before. You can change this per device in Settings.

## How sync works

1. A tap updates the screen at once and adds the change to an **outbox** on the device (IndexedDB).
2. About a second later the app POSTs the outbox to the script. The script applies it and returns the last 90 days
   of Checkins and ChoreLog, plus all Routines and Chores and each chore's latest log entry.
3. The app replaces its local copy with that response, so edits from other devices or made by hand in the Sheet show up.
4. When offline, the outbox waits. It's sent when the app opens, when you come back to it, when the connection
   returns, or every minute while unsent changes remain. The header shows `N unsent`.

Every call is a POST with the key inside the request body, so the key never appears in a URL, browser history or
Google's request logs. Opening the script URL in a browser (a GET) is only a health check: it shows
`{"ok":true,"app":"ruthines",…}` and returns no data. After 10 wrong keys in a row the script refuses every request
for 15 minutes; running `setup()` again in the script editor clears that.

Each tick carries the time it was made on the device, and the script keeps the newer edit. A chore is logged at most
once per day, and Undo removes only that day's entry. Progress' "All time" range fetches the full history on demand.

## Files

```
index.html             page shell
app.js                 screens and sync loop
logic.js               pure logic: dates, merging the outbox, chore status, streaks, CSV
store.js               IndexedDB storage and calls to the Apps Script
demo.js                sample data and an in-browser stand-in for the script (demo mode)
fonts/                 Manrope (SIL Open Font License 1.1)
tools/build-demo.mjs   builds the one-page demo
style.css              plain styling, light and dark
sw.js                  service worker: keeps the app's files for offline use
manifest.webmanifest   install metadata and icons
apps-script/Code.gs    the Google Sheet backend
tests/                 unit tests and a headless-browser end-to-end test
```

## Publishing

The app is plain static files at the repo root, with no build step, so any static host works.

**Cloudflare Pages (free, works with a private repo).** This is the recommended option.
1. Sign in at dash.cloudflare.com, open **Workers & Pages**, then **Create**, choose **Pages**, then **Import an existing Git repository**.
2. Connect GitHub, allow access to this repo only, and select it.
3. Set the production branch to `main`, Framework preset to **None**, leave the build command empty, and set the
   build output directory to `/`. Then click **Save and Deploy**.
4. The app is live at `https://<project>.pages.dev`. Each push to `main` redeploys it.

**GitHub Pages.** This is free for public repos; a private repo needs GitHub Pro. Go to Settings → Pages,
set Source to *Deploy from a branch*, choose `main` and `/ (root)`, then Save.

Whichever host you use, **bump `VERSION` in `sw.js`** (and in `app.js`) with every change, so installed copies
pick it up. The app shows *A new version is ready* when one arrives.

## Installing on each device

Open the Pages URL, then enter the script URL and key on the Connect screen.

- **iPhone:** Safari → Share → **Add to Home Screen**.
- **Mac or PC, Chrome or Edge:** the install icon at the right of the address bar.
- **Mac, Safari:** File → **Add to Dock**.

## Tests

```
node --test tests/logic.test.mjs tests/apps-script.test.mjs   # unit tests: app logic, and Code.gs on a fake Sheet
node tests/e2e.mjs                 # headless Chromium + the real Code.gs on a fake Sheet
```

The end-to-end test needs Playwright and python3. It covers connecting, ticking, chores, offline reload and later sync,
the week grid, adding chores, habit settings, CSV export and disconnecting.
