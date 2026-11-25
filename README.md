# Ruthines

A single-user habit and household chores tracker. It's an installable web app
(PWA) that works offline and syncs through a Google Sheet that you own.

- **App:** static files in this repo, served by any static host (Cloudflare Pages or GitHub Pages). There's no build step and no server.
- **Data:** your Google Sheet, through the Apps Script in [`apps-script/Code.gs`](apps-script/Code.gs).
- **This repo never holds data, the script URL or the key.** Each device is connected once
  on the Connect screen, and both values stay in that browser's storage.

## Screens

The bottom bar (a sidebar on a computer) has **Today**, **Week** and **Progress**. The gear opens Settings.

| Screen | What it does |
|---|---|
| Today | Today's habits as tick rows, plus chores that are overdue or due within 2 days, with Done and Undo. Arrows go back to earlier days. Ruth appears in a card when a habit reaches a 7, 30 or 100-day streak, or when every habit is ticked; × hides it for the day. |
| Week | Top: habits × Mon–Sun grid for catching up, with a weekly count per habit. On a phone about four days show and the rest scroll sideways; it opens on today. Tap a habit's name for its streak, last done and the last 30 days. Bottom: every chore as a list, worst first, with zone filters and Done/Undo. Tap a chore for its interval and recent dates. |
| Progress | Ticks per week, plus rate and streak per habit. CSV export of habits and chores, and a JSON backup. |
| Edit habits | Reached from **Edit** on Today or Week. Add, rename, set the emoji, reorder, archive and restore habits. |
| Edit chores | Reached from **Edit** next to Chores on Week. Add chores (with an optional last-done date), change name, zone and interval, archive and restore. |
| Settings | Sync status and Sync now, the day-start hour, install tips, and disconnecting this device. |

**Look.** Manrope with a teal accent, in light and dark following the system. Habit emoji show only when
*every* active habit has one; otherwise none show, and Edit habits names the habits still missing one.
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
ruth/                  Ruth's animated cards (WebP), each with a still frame for reduced motion
tools/build-demo.mjs   builds the one-page demo
style.css              plain styling, light and dark
sw.js                  service worker: keeps the app's files for offline use
manifest.webmanifest   install metadata and icons
apps-script/Code.gs    the Google Sheet backend
tests/                 unit tests and a headless-browser end-to-end test
```

## Make your own copy

About 15 minutes, with a Google account and a GitHub account. Nothing here costs money.

### 1. Copy the repo

- **Public copy:** click **Fork** on this repo. Use this if you'll host on GitHub Pages.
- **Private copy:** go to [github.com/new/import](https://github.com/new/import), paste this repo's URL and choose
  *Private*. A fork of a public repo can't be made private. Host a private copy on Cloudflare Pages (step 5).

The repo holds only the app's code. Your habits, the script URL and the key never go into it.

### 2. Create the Sheet

1. In Google Sheets, create a blank spreadsheet and name it, for example, *Ruthines*.
2. Don't share it with anyone. The script runs as you, so anyone with edit access to the Sheet could read or change
   the script and its key.

### 3. Add the script

1. In the Sheet, open **Extensions → Apps Script**.
2. Delete the sample code, paste the whole of [`apps-script/Code.gs`](apps-script/Code.gs) and click **Save**.
   Keep the first line, `/** @OnlyCurrentDoc */`. It limits the script to this one Sheet, so Google asks for access
   to *this spreadsheet only*, not to all your Drive files.
3. Pick `setup` in the function menu at the top and click **Run**.
4. Google asks you to authorise it. Choose your account. You'll see *Google hasn't verified this app*, because it's
   your own script, not a published one. Click **Advanced**, then **Go to … (unsafe)**, then **Allow**.
5. `setup` creates the tabs (Routines, Chores, Checkins, ChoreLog), adds four starter habits, schedules a monthly
   clean-up of very old ticks, and creates your key. The **Execution log** at the bottom shows
   `Your Ruthines key (keep it private): …`. Copy the key somewhere safe, such as a password manager.

You can edit any tab by hand later. The app picks the changes up on its next sync.

### 4. Deploy the script as a web app

1. Click **Deploy → New deployment**, then the gear next to *Select type*, then **Web app**.
2. Set **Execute as: Me** and **Who has access: Anyone**, then click **Deploy**.
3. Copy the **Web app URL**. It ends in `/exec`.

**Why "Anyone".** The app calls the script straight from your phone's browser, which can't sign in to Google on
the script's behalf. "Anyone" lets the request reach the script; the key is what lets it in. Without the right
key the script returns nothing, and after 10 wrong keys in a row it refuses every request for 15 minutes.
"Execute as: Me" is what lets the script read and write your Sheet.

**After you change `Code.gs` later:** use **Deploy → Manage deployments**, edit the deployment and choose
*New version*. That keeps the same URL, so devices don't need reconnecting.

### 5. Put the app online

The app is plain static files at the repo root. There's no build step, so any static host works.

**GitHub Pages** (public repo). On a free GitHub account, Pages works only for public repos.
1. In your repo, open **Settings → Pages**.
2. Set **Source** to *Deploy from a branch*, pick `main` and `/ (root)`, and click **Save**.
3. After a minute the app is at `https://<your-username>.github.io/<repo-name>/`.

**Cloudflare Pages** (public or private repo).
1. At dash.cloudflare.com open **Workers & Pages → Create → Pages → Import an existing Git repository**.
2. Connect GitHub, allow access to this repo only, and select it.
3. Set the production branch to `main`, Framework preset to **None**, leave the build command empty and set the
   output directory to `/`. Click **Save and Deploy**.
4. The app is at `https://<project>.pages.dev`. Each push to `main` redeploys it.

### 6. Connect each device

Open the app's URL, paste the Web app URL into **Script URL** and the key into **Key** on the Connect screen, and tap **Connect**. Do this
once per phone or computer. Both values stay in that browser's storage only.

### 7. Install it

- **iPhone:** open the URL in **Safari**, tap **Share**, then **Add to Home Screen**. Open it from the home screen
  and connect there: the installed app has its own storage, separate from Safari's.
- **Android, or Chrome/Edge on a computer:** the install icon at the right of the address bar, or **Install app**
  in the browser menu.
- **Mac, Safari:** **File → Add to Dock**.

### Security notes

- **Keep the Sheet unshared.** Sharing it shares the script and its key.
- **On GitHub Pages, keep Ruthines the only Pages site on your account.** Every project site on
  `<you>.github.io` shares one browser origin, so another site of yours there could read the key from browser
  storage. Cloudflare Pages gives each project its own `*.pages.dev` address, so this doesn't apply there.
- **Never put the script URL or key in the repo,** an issue or a chat.
- **To change the key** (if it leaks, or a device is lost): in Apps Script open **Project Settings → Script
  properties**, delete `SECRET`, then run `setup` again and copy the new key from the log. The URL stays the same.
  On each device, open Settings → **Disconnect this device**, then connect with the new key.
- If you lock yourself out with wrong keys, running `setup` again clears the lockout. It keeps the existing key.

### Updating the app

Bump `VERSION` in `sw.js` and in `app.js` with every change, so installed copies pick it up. The app then shows
*A new version is ready. Tap to reload.*

## Tests

```
node --test tests/logic.test.mjs tests/apps-script.test.mjs   # unit tests: app logic, and Code.gs on a fake Sheet
node tests/e2e.mjs                 # headless Chromium + the real Code.gs on a fake Sheet
```

The end-to-end test needs Playwright and python3. It covers connecting, ticking, chores, offline reload and later sync,
the Week grid and chore list, Edit chores, Edit habits, CSV export and disconnecting.
