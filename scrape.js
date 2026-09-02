#!/usr/bin/env node
// scrape.js — Best Buy Open-Box deal scraper (Node + Playwright driving your installed Chrome).
//
//   node scrape.js            full run: scrape -> data/deals.json -> docs/index.html -> git push
//   node scrape.js --probe    listing-only fingerprint (fast, for learning when Best Buy updates)
//   node scrape.js --no-push  skip git push
//   node scrape.js --headed   show the browser window
//   node scrape.js --only "TV & Home Theater,Headphones"   subset of categories
//
// Zero LLM tokens are used at runtime. All logic that touches bestbuy.com lives in src/core.js
// and is executed inside a real Chrome tab so requests carry a normal browser fingerprint.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { chromium } = require('playwright');

const ROOT = __dirname;
const P = (...x) => path.join(ROOT, ...x);
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

const cfg = JSON.parse(fs.readFileSync(P('config.json'), 'utf8'));
if (opt('--only')) {
  const keep = new Set(opt('--only').split(',').map((s) => s.trim()));
  cfg.categories = Object.fromEntries(Object.entries(cfg.categories).filter(([k]) => keep.has(k)));
}
const CORE = fs.readFileSync(P('src', 'core.js'), 'utf8');
const log = (...m) => console.log(new Date().toISOString().slice(11, 19), ...m);

fs.mkdirSync(P('data'), { recursive: true });
fs.mkdirSync(P('docs'), { recursive: true });

// ---------------------------------------------------------------- browser
async function withPage(fn) {
  const profileDir = path.isAbsolute(cfg.browser.profileDir)
    ? cfg.browser.profileDir
    : path.join(os.homedir(), cfg.browser.profileDir);
  // On a cloud runner (GitHub Actions sets CI=true) use Playwright's bundled Chromium and an optional proxy.
  const onCI = !!process.env.CI;
  if (onCI) { cfg.concurrency = 10; cfg.delayMs = 10; }
  const proxy = process.env.PROXY_SERVER ? { server: process.env.PROXY_SERVER, username: process.env.PROXY_USER, password: process.env.PROXY_PASS } : undefined;
  const ctx = await chromium.launchPersistentContext(profileDir, {
    channel: onCI ? undefined : (cfg.browser.channel || 'chrome'),
    headless: flag('--headed') ? false : (onCI || cfg.browser.headless !== false),
    proxy,
    viewport: { width: 1366, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    args: ['--disable-blink-features=AutomationControlled'],
  });
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    page.setDefaultTimeout(60_000);
    await page.goto('https://www.bestbuy.com/site/searchpage.jsp?browsedCategory=pcmcat748300666861&id=pcat17071', { waitUntil: 'domcontentloaded' });
    // International splash page (only shows up on non-US IPs)
    const us = page.locator('a.us-link, a[href*="intl=us"], button:has-text("United States")').first();
    if (await us.isVisible({ timeout: 1500 }).catch(() => false)) { await us.click(); await page.waitForLoadState('domcontentloaded'); }
    if (!/bestbuy\.com/.test(page.url())) throw new Error('Not on bestbuy.com: ' + page.url());
    await page.exposeFunction('__bbLog', (m) => log('  ' + m));
    await page.evaluate(CORE);
    return await fn(page);
  } finally {
    await ctx.close();
  }
}

// ---------------------------------------------------------------- history helpers
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function applyHistory(items, ts) {
  const seenFile = P('data', 'seen.json');
  const seen = readJson(seenFile, {});
  for (const it of items) {
    const prev = seen[it.sku];
    if (!prev) {
      seen[it.sku] = { firstSeen: ts, lastSeen: ts, firstPrice: it.price, lastPrice: it.price, lowestPrice: it.price, condition: it.condition, name: it.name };
      it.isNew = true; it.firstSeen = ts; it.priceDrop = null;
    } else {
      it.isNew = false; it.firstSeen = prev.firstSeen;
      it.priceDrop = it.price < prev.lastPrice ? Math.round((prev.lastPrice - it.price) * 100) / 100 : null;
      prev.lastSeen = ts; prev.lastPrice = it.price; prev.condition = it.condition;
      prev.lowestPrice = Math.min(prev.lowestPrice ?? it.price, it.price);
    }
  }
  fs.writeFileSync(seenFile, JSON.stringify(seen, null, 1));
  // compact per-run line for later analysis of update timing
  const line = { ts, n: items.length, items: items.map((i) => [i.sku, i.price, i.condition[0], i.stores.map((s) => s.id).join('+')]) };
  fs.appendFileSync(P('data', 'history.jsonl'), JSON.stringify(line) + '\n');
}

// ---------------------------------------------------------------- site
function buildSite(payload) {
  const tpl = fs.readFileSync(P('site', 'template.html'), 'utf8');
  const json = JSON.stringify(payload).replace(/<\//g, '<\\/');
  const html = tpl.replace('/*__DATA__*/null', json);
  fs.writeFileSync(P('docs', 'index.html'), html);
  fs.writeFileSync(P('docs', 'deals.json'), JSON.stringify(payload));
  if (cfg.outputCopyDir) {
    try {
      fs.mkdirSync(cfg.outputCopyDir, { recursive: true });
      fs.copyFileSync(P('docs', 'index.html'), path.join(cfg.outputCopyDir, 'deals.html'));
      fs.copyFileSync(P('docs', 'deals.json'), path.join(cfg.outputCopyDir, 'deals.json'));
    } catch (e) { log('copy to outputCopyDir failed:', e.message); }
  }
}

function gitPush(ts) {
  if (!cfg.git || !cfg.git.push || flag('--no-push')) return;
  if (!fs.existsSync(P('.git'))) { log('no .git directory — skipping push (see README)'); return; }
  const run = (c) => execSync(c, { cwd: ROOT, stdio: 'pipe' }).toString().trim();
  try {
    run('git add docs data');
    const status = run('git status --porcelain docs data');
    if (!status) { log('nothing changed — no commit'); return; }
    run(`git commit -q -m "deals ${ts}"`);
    run(`git push -q ${cfg.git.remote || 'origin'} HEAD:${cfg.git.branch || 'main'}`);
    log('pushed to GitHub');
  } catch (e) {
    log('git push failed:', (e.stderr || e.stdout || e.message).toString().slice(0, 400));
  }
}

// ---------------------------------------------------------------- modes
async function fullRun() {
  const t0 = Date.now();
  const result = await withPage((page) => page.evaluate((c) => window.bbScrape(c, (m) => window.__bbLog(m)), cfg));
  const ts = result.meta.ts;
  applyHistory(result.items, ts);
  const payload = {
    meta: { ...result.meta, stores: cfg.stores, storeNames: cfg.storeNames, minPrice: cfg.minPrice, zip: cfg.zip, categories: Object.keys(cfg.categories), site: cfg.site },
    items: result.items,
  };
  fs.writeFileSync(P('data', 'deals.json'), JSON.stringify(payload, null, 1));
  buildSite(payload);
  const newCount = result.items.filter((i) => i.isNew).length;
  const hot = result.items.filter((i) => (i.pctVsNew || 0) >= (cfg.site.defaultMinPct || 50)).length;
  log(`done: ${result.meta.skusScanned} skus scanned, ${result.items.length} in stock nearby, ${newCount} new since last run, ${hot} at >=${cfg.site.defaultMinPct}% off new, ${result.meta.errors.length} errors, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  gitPush(ts);
}

async function probeRun() {
  const res = await withPage((page) => page.evaluate((c) => window.bbProbe(c), cfg));
  const lastFile = P('data', 'probe-last.json');
  const last = readJson(lastFile, { categories: {} });
  const added = {}, removed = {}, counts = {};
  for (const [cat, skus] of Object.entries(res.categories)) {
    const prev = new Set(last.categories[cat] || []);
    const cur = new Set(skus);
    counts[cat] = skus.length;
    added[cat] = skus.filter((s) => !prev.has(s));
    removed[cat] = [...prev].filter((s) => !cur.has(s));
  }
  const totalAdded = Object.values(added).reduce((a, b) => a + b.length, 0);
  const totalRemoved = Object.values(removed).reduce((a, b) => a + b.length, 0);
  fs.appendFileSync(P('data', 'probe.jsonl'), JSON.stringify({ ts: res.ts, counts, added: totalAdded, removed: totalRemoved, addedSkus: [].concat(...Object.values(added)) }) + '\n');
  fs.writeFileSync(lastFile, JSON.stringify(res));
  log(`probe: ${Object.values(counts).reduce((a, b) => a + b, 0)} skus, +${totalAdded} / -${totalRemoved} vs last probe`);
}

(flag('--probe') ? probeRun() : fullRun()).catch((e) => { console.error('FAILED:', e); process.exit(1); });
