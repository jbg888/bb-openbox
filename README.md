# Best Buy Open-Box deal finder

Scrapes Best Buy's open-box inventory for the categories, stores, and price floor in `config.json`,
figures out which units are physically in stock at your 11 pickup stores, and builds a static deals
page (`docs/index.html`) that GitHub Pages serves at **https://jbg888.github.io/bb-openbox/**.
**No AI tokens are used at runtime.**

The scraper runs on your own computer (Best Buy blocks the price lookup from cloud servers such as
GitHub Actions, so the `.github/workflows` are kept disabled). Each run pushes the results to GitHub,
which republishes the page.

```
bb-openbox/
  config.json          stores, zip, categories, $ floor, site defaults, git + browser settings
  scrape.js            runner: Chrome -> data/deals.json -> docs/index.html -> git push
  build.js             rebuild the page from data/deals.json (after editing the template)
  src/core.js          all the bestbuy.com logic; runs INSIDE a Chrome tab (see DISCOVERY.md)
  site/template.html   the deals page; scrape.js embeds the data into it
  docs/                published output (index.html + deals.json) — what GitHub Pages serves
  data/                deals.json (latest), seen.json (first/last seen per SKU), history.jsonl, probe.jsonl
  scripts/setup-tasks.ps1     registers the Windows scheduled tasks
  scripts/analyze-probe.js    after a few days: which hours new open-box SKUs show up
```

## One-time setup on Windows (~10 minutes)

1. Open **PowerShell** (Start → type "PowerShell") and install Node.js and Git:
   ```
   winget install OpenJS.NodeJS.LTS Git.Git
   ```
   Close PowerShell and open a new one so the tools are on the PATH.
2. Download the project from GitHub into a folder outside Google Drive:
   ```
   cd $HOME
   git clone https://github.com/jbg888/bb-openbox.git
   cd bb-openbox
   ```
3. Install the one dependency (it uses your installed Chrome, so no browser download):
   ```
   $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1"
   npm install
   ```
4. First run, with the Chrome window visible so you can watch it (~3 minutes):
   ```
   node scrape.js --headed
   ```
   At the end it prints `done: 5xx skus scanned, 4xx in stock nearby, ...` and then `pushed to GitHub`.
   The first push opens a browser window asking you to sign in to GitHub; after that it's remembered.
   A minute later https://jbg888.github.io/bb-openbox/ shows the real deals. A copy is also written to
   your Google Drive folder as `deals.html` (`outputCopyDir` in config.json).

   If a headless run ever comes back with 0 SKUs, set `"headless": false` in config.json; the Chrome
   window will just pop up during scheduled runs.

## Scheduling

Open PowerShell **as Administrator** (right-click → Run as administrator), then:
```
cd $HOME\bb-openbox
powershell -ExecutionPolicy Bypass -File scripts\setup-tasks.ps1
```
That registers two tasks under your user: a full scrape every 6 hours (00:00 / 06:00 / 12:00 / 18:00)
and an hourly listing-only probe at :30. Both are set to wake the laptop from sleep, but nothing runs if
it is shut down — check Task Scheduler → "BB OpenBox *" → Last Run Result if the page looks stale.

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
- `node scrape.js --no-push` — don't push to GitHub
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
