# Best Buy Open-Box deal finder

Scrapes Best Buy's open-box inventory for the categories, stores, and price floor in `config.json`,
figures out which units are physically in stock at your 11 pickup stores, and builds a static deals
page (`docs/index.html`) that GitHub Pages serves. **No AI tokens are used at runtime.**

```
bb-openbox/
  config.json          stores, zip, categories, $ floor, site defaults, git + browser settings
  scrape.js            runner: Chrome -> data/deals.json -> docs/index.html -> git push
  build.js             rebuild the page from data/deals.json (after editing the template)
  src/core.js          all the bestbuy.com logic; runs INSIDE a Chrome tab (see DISCOVERY.md)
  site/template.html   the deals page; scrape.js embeds the data into it
  docs/                published output (index.html + deals.json) — this is what GitHub Pages serves
  data/                deals.json (latest), seen.json (first/last seen per SKU), history.jsonl, probe.jsonl
  scripts/setup-tasks.ps1     registers the Windows scheduled tasks
  scripts/analyze-probe.js    after a few days: which hours new open-box SKUs show up
```

## Option A — fully online, no computer needed (recommended to try first)

1. Create a **public** GitHub repository named `bb-openbox` (github.com → New repository).
2. On the repo page click **Add file → Upload files**, drag in everything inside this folder
   (including the hidden `.github` folder — on Windows, zip the folder first and upload the *contents*, or
   use GitHub Desktop). Commit.
3. **Settings → Pages → Source: Deploy from a branch → main / docs → Save.**
4. **Actions** tab → enable workflows → open **scrape** → **Run workflow**. Watch it; ~4 minutes.
   - Green: the page is live at `https://<your-username>.github.io/bb-openbox/` and refreshes every
     6 hours on its own. Done — skip Option B.
   - Red with `listing HTTP 403` / timeouts: Best Buy is blocking GitHub's datacenter IPs. Fix by adding
     a residential proxy (e.g. a $5–10/month plan from Webshare, IPRoyal, or Bright Data) as repository
     secrets `PROXY_SERVER` (like `http://host:port`), `PROXY_USER`, `PROXY_PASS`, then re-run.
     Or fall back to Option B.

Cost: GitHub Actions gives public repos unlimited free minutes; the probe + scrape use ~10 hours/month.

## Option B — on your own computer (Windows, ~15 minutes)

Fastest install: open PowerShell and run `winget install OpenJS.NodeJS.LTS Git.Git`, then continue at step 3.


1. **Node.js** — install the LTS release from https://nodejs.org (pick the *ARM64* Windows installer for
   the Surface). Check in a new terminal: `node -v`.
2. **Git** — install Git for Windows from https://git-scm.com (includes Git Credential Manager, which
   handles GitHub sign-in in the browser on first push).
3. **Put this folder outside Google Drive** — e.g. copy it to `C:\Users\jonat\bb-openbox`. Drive would
   otherwise try to sync `node_modules` and every git commit. The scraper copies the finished page back
   into the Drive folder for you (`outputCopyDir` in config.json), so you still get `deals.html` there.
4. In a terminal inside that folder:
   ```
   set PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
   npm install
   node scrape.js --headed --no-push
   ```
   `--headed` shows the Chrome window so you can watch the first run (it uses your installed Chrome, with
   its own separate profile stored in `%USERPROFILE%\.chrome-profile`). Expect ~3 minutes. When it says
   `done: 542 skus scanned, ... ` open `docs\index.html` in a browser.
   If a headless run ever gets blocked by Best Buy, set `"headless": false` in config.json; the window
   will just pop up during scheduled runs.

## GitHub Pages (the phone-friendly URL)

1. Create an empty **public** repository on GitHub named `bb-openbox` (public is what makes Pages free).
2. In the project folder:
   ```
   git init -b main
   git add .
   git commit -m "initial"
   git remote add origin https://github.com/<your-username>/bb-openbox.git
   git push -u origin main
   ```
   The first push opens a browser window to sign in to GitHub.
3. On GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: main, folder: /docs → Save.**
   A minute later the page is live at `https://<your-username>.github.io/bb-openbox/`.
4. From now on every `node scrape.js` commits `docs/` + `data/` and pushes; Pages redeploys automatically.
   Set `"push": false` in config.json to turn that off.

## Scheduling

Open PowerShell **as Administrator** in the project folder and run:
```
powershell -ExecutionPolicy Bypass -File scripts\setup-tasks.ps1
```
That registers two tasks under your user: a full scrape every 6 hours (00:00 / 06:00 / 12:00 / 18:00)
and an hourly listing-only probe at :30. Both are set to wake the laptop from sleep, but nothing runs if
it is shut down or the lid is closed with sleep disabled — check Task Scheduler → "BB OpenBox *" → Last Run Result.

To change the schedule later, edit the times in the script and re-run it, or use Task Scheduler directly.

## Finding out when Best Buy updates

The hourly probe appends one line per run to `data/probe.jsonl` with how many SKUs appeared/disappeared
since the previous probe. After 3–4 days run:
```
node scripts\analyze-probe.js
```
It prints a per-hour histogram of newly listed SKUs. If there is a clear spike (say 4–6 AM), move the
full scrape to just after it; if it's flat, every 6 hours is right and you can delete the probe task.

## Everyday use

- `node scrape.js` — full run (what the scheduler calls)
- `node scrape.js --probe` — listing-only fingerprint, ~10 s
- `node scrape.js --only "TV & Home Theater"` — one category, for quick checks
- `node build.js` — regenerate the page after editing `site/template.html`
- Edit `config.json` to change the price floor, categories, stores, or the page defaults
  (`defaultMinPct`, `defaultBaseline` = `"new"` or `"reg"`).

The page has: search, New-price vs Comp-Value toggle, minimum % off slider, minimum $ off, category,
store and condition filters, a "new since last run" switch, and click-to-sort columns. Items are tagged
NEW on the first run they appear and get a ↓ tag when their price drops between runs.

## When it breaks

Best Buy changes its site now and then. `DISCOVERY.md` documents exactly which three requests the
scraper depends on and what each response looks like, so a short Claude session can re-verify them.
`data/deals.json` → `meta.errors` lists per-SKU failures from the last run.
