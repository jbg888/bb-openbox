// core.js — Best Buy Open-Box scraper, browser-side.
// This file is injected into a bestbuy.com tab by scrape.js (Playwright) and runs there,
// so every request inherits the real browser fingerprint and cookies.
// It has NO Node dependencies and can be pasted into DevTools for debugging.
//
// Entry point:  await bbScrape(config, progressFn)  -> { meta, items }
// Probe only:   await bbProbe(config)               -> { ts, categories:{name:[sku...]} }

(function () {
  const COND = { 0: 'Fair', 1: 'Good', 2: 'Excellent', 3: 'Certified Excellent' };
  const FULFILL_COND = {
    OPEN_BOX_FAIR: 0, OPEN_BOX_GOOD: 1, OPEN_BOX_EXCELLENT: 2, OPEN_BOX_CERTIFIED_EXCELLENT: 3,
  };
  const PRICE_INPUT = 'input:{salesChannel:"LargeView", usePriceWithCart:true, useCabo:true, useSuco:true}';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function retry(fn, tries = 3, label = '') {
    let err;
    for (let i = 0; i < tries; i++) {
      try { return await fn(); } catch (e) { err = e; await sleep(800 * (i + 1)); }
    }
    throw new Error(`${label} failed after ${tries} tries: ${err && err.message}`);
  }

  // Run async tasks with bounded concurrency.
  async function pool(items, limit, worker, onDone) {
    const out = new Array(items.length);
    let i = 0, done = 0;
    async function run() {
      while (i < items.length) {
        const idx = i++;
        try { out[idx] = await worker(items[idx], idx); } catch (e) { out[idx] = { error: String(e && e.message || e) }; }
        done++; if (onDone) onDone(done, items.length);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
    return out;
  }

  // ---------- 1. Listing pages -> SKUs per category ----------
  function listingUrl(cfg, categoryFacet, page) {
    const parts = [
      ...allStores(cfg).map((s) => `storepickupstores_facet=Store Availability - In Store Pickup~${s}`),
      `category_facet=${categoryFacet}`,
      `currentprice_facet=Price~${cfg.minPrice} to Up`,
      'soldout_facet=Availability~Exclude Out of Stock Items',
    ];
    const qp = encodeURIComponent(parts.join('^'));
    const st = encodeURIComponent('pcmcat748300666861_categoryid$cat00000');
    return `/site/searchpage.jsp?browsedCategory=pcmcat748300666861&id=pcat17071&qp=${qp}&st=${st}&cp=${page}`;
  }

  async function fetchListing(url) {
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) throw new Error(`listing HTTP ${r.status}`);
    const html = await r.text();
    const skus = [...new Set([...html.matchAll(/data-product-id="(\d+)"/g)].map((m) => m[1]))];
    const pages = [...html.matchAll(/[?&;]cp=(\d+)/g)].map((m) => +m[1]);
    return { skus, maxPage: pages.length ? Math.max(...pages) : 1, bytes: html.length };
  }

  async function collectSkus(cfg, progress) {
    // returns [{sku, category}] in listing order, de-duplicated (first category wins)
    const seen = new Map();
    const perCategory = {};
    for (const [name, facet] of Object.entries(cfg.categories)) {
      const first = await retry(() => fetchListing(listingUrl(cfg, facet, 1)), 3, `listing ${name} p1`);
      let all = [...first.skus];
      if (first.maxPage > 1) {
        const rest = Array.from({ length: first.maxPage - 1 }, (_, k) => k + 2);
        const results = await pool(rest, 4, (p) => retry(() => fetchListing(listingUrl(cfg, facet, p)), 3, `listing ${name} p${p}`));
        for (const r of results) if (r && r.skus) all.push(...r.skus);
      }
      all = [...new Set(all)];
      perCategory[name] = all;
      for (const sku of all) if (!seen.has(sku)) seen.set(sku, name);
      progress && progress(`listing ${name}: ${all.length} skus over ${first.maxPage} page(s)`);
    }
    return { skus: [...seen].map(([sku, category]) => ({ sku, category })), perCategory };
  }

  // ---------- 2. Prices via GraphQL (batched) ----------
  function priceQuery(skus) {
    const parts = [];
    for (const s of skus) {
      parts.push(`n${s}: productBySkuId(skuId:"${s}") { skuId name { short } buyingOptions { type pdpUrl } price(${PRICE_INPUT}) { regularPrice customerPrice } }`);
      for (const c of [0, 1, 2, 3]) {
        parts.push(`s${s}_c${c}: productBySkuId(skuId:"${s}", openBoxCondition:${c}) { price(${PRICE_INPUT}) { openBoxPrice openBoxCondition } }`);
      }
    }
    return `query getProduct { ${parts.join(' ')} }`;
  }

  // Same identifying headers the real site sends with its price queries.
  const GQL_HEADERS = { 'accept': '*/*', 'content-type': 'application/json', 'x-client-id': 'plp-web', 'x-requested-for-operation-name': 'getProduct' };

  async function graphql(query) {
    // POST first; some networks get a bot-challenge on POST, so fall back to GET.
    const attempts = [
      () => fetch('/gateway/graphql', { method: 'POST', credentials: 'include', headers: GQL_HEADERS, body: JSON.stringify({ query, operationName: 'getProduct' }) }),
      () => fetch('/gateway/graphql?operationName=getProduct&query=' + encodeURIComponent(query), { credentials: 'include', headers: GQL_HEADERS }),
    ];
    let last = '';
    for (const a of attempts) {
      const r = await a();
      const txt = await r.text();
      let j = null;
      try { j = JSON.parse(txt); } catch (e) { /* not json */ }
      if (r.ok && j && j.data) return j;
      last = `HTTP ${r.status} ${txt.replace(/\s+/g, ' ').slice(0, 160)}`;
    }
    throw new Error('graphql ' + last);
  }

  async function fetchPrices(skus) {
    const j = await graphql(priceQuery(skus));
    const d = j.data || {};
    const out = {};
    for (const s of skus) {
      const n = d['n' + s];
      if (!n) { out[s] = { error: 'no product' }; continue; }
      const obPrices = {};
      for (const c of [0, 1, 2, 3]) {
        const p = d[`s${s}_c${c}`] && d[`s${s}_c${c}`].price;
        if (p && p.openBoxPrice != null) obPrices[c] = p.openBoxPrice;
      }
      const opts = {};
      for (const b of n.buyingOptions || []) opts[b.type] = b.pdpUrl;
      out[s] = {
        name: n.name && n.name.short,
        regularPrice: n.price && n.price.regularPrice,
        newPrice: n.price && n.price.customerPrice,
        urls: opts,
        obPrices,
      };
    }
    return out;
  }

  // ---------- 3. Store availability via fulfillment endpoint ----------
  // cfg.areas = [{ name, myStore, zip, stores:[ids] }]. Best Buy returns the ~27 stores nearest to `myStore`,
  // so each area needs its own call; results are merged per condition, de-duplicated by store id.
  function areasOf(cfg) {
    if (cfg.areas && cfg.areas.length) return cfg.areas;
    return [{ name: cfg.storeNames && cfg.storeNames[cfg.myStore] || cfg.myStore, myStore: cfg.myStore, zip: cfg.zip, stores: cfg.stores }];
  }
  function allStores(cfg) { return [...new Set(areasOf(cfg).flatMap((a) => a.stores.map(String)))]; }

  async function fetchAvailabilityArea(area, sku) {
    const v = {
      fulfillmentOptionsInput: {
        sku, condition: 'ANY',
        shipping: { destinationZipCode: area.zip },
        inStorePickup: { storeId: String(area.myStore), searchNearby: true, showNearbyLocations: true },
      },
    };
    const r = await fetch('/gateway/graphql/fulfillment?variables=' + encodeURIComponent(JSON.stringify(v)), { credentials: 'include' });
    if (!r.ok) throw new Error(`fulfillment HTTP ${r.status}`);
    const j = await r.json();
    const d = j.data && j.data.fulfillmentOptions && j.data.fulfillmentOptions.ispuDetails && j.data.fulfillmentOptions.ispuDetails[0];
    if (!d) return {};
    const wanted = new Set(area.stores.map(String));
    const locs = [
      { store: d.store, availability: d.ispuAvailability || [], distance: 0 },
      ...(d.nearbyLocations || []),
    ];
    // { condIndex: [{id, name, qty, distance, area}] } — only units physically in hand
    const byCond = {};
    for (const l of locs) {
      const st = l.store || {};
      if (!wanted.has(String(st.storeId))) continue;
      for (const a of l.availability || []) {
        const c = FULFILL_COND[a.condition];
        if (c === undefined) continue;
        const qty = a.quantity != null ? Number(a.quantity) : 0;
        if (!qty) continue;
        (byCond[c] = byCond[c] || []).push({ id: String(st.storeId), name: st.name, qty, distance: l.distance, area: area.name });
      }
    }
    return byCond;
  }

  async function fetchAvailability(cfg, sku) {
    const merged = {};
    for (const area of areasOf(cfg)) {
      const byCond = await fetchAvailabilityArea(area, sku);
      for (const [c, stores] of Object.entries(byCond)) {
        const list = (merged[c] = merged[c] || []);
        for (const s of stores) if (!list.some((x) => x.id === s.id)) list.push(s);
      }
    }
    return merged;
  }

  // ---------- 4. Assemble ----------
  function assemble(sku, category, price, avail, cfg) {
    if (!price || price.error) return null;
    const conditions = [];
    for (const c of [0, 1, 2, 3]) {
      const p = price.obPrices[c];
      const stores = avail[c] || [];
      if (p == null || !stores.length) continue;
      conditions.push({ code: c, condition: COND[c], price: p, stores: stores.sort((a, b) => a.distance - b.distance) });
    }
    if (!conditions.length) return null; // nothing in hand at the chosen stores
    conditions.sort((a, b) => a.price - b.price);
    const best = conditions[0];
    if (best.price < cfg.minPrice) return null;
    const newPrice = price.newPrice, reg = price.regularPrice;
    const pct = (base) => (base ? Math.round((1 - best.price / base) * 1000) / 10 : null);
    const obUrl = price.urls[best.condition] || price.urls['New'] || null;
    return {
      sku, category,
      name: price.name,
      newPrice, regularPrice: reg,
      price: best.price, condition: best.condition,
      stores: best.stores,
      saveVsNew: newPrice ? Math.round((newPrice - best.price) * 100) / 100 : null,
      pctVsNew: pct(newPrice),
      saveVsReg: reg ? Math.round((reg - best.price) * 100) / 100 : null,
      pctVsReg: pct(reg),
      url: obUrl && obUrl.startsWith('http') ? obUrl : (obUrl ? 'https://www.bestbuy.com' + obUrl : null),
      newUrl: price.urls['New'] || null,
      conditions, // all in-stock tiers
    };
  }

  async function bbScrape(cfg, progress) {
    const t0 = Date.now();
    const log = (m) => progress && progress(m);
    const { skus, perCategory } = await collectSkus(cfg, log);
    log(`total unique skus: ${skus.length}`);

    // prices in batches of 20 SKUs (=100 aliases per request)
    const batches = [];
    for (let i = 0; i < skus.length; i += 8) batches.push(skus.slice(i, i + 8).map((x) => x.sku));
    const priceMaps = await pool(batches, 3, (b) => retry(() => fetchPrices(b), 3, 'prices'), (d, n) => log(`prices ${d}/${n}`));
    const prices = Object.assign({}, ...priceMaps.filter((m) => m && !m.error));
    const priceErrors = priceMaps.filter((m) => m && m.error).map((m) => m.error);
    if (priceErrors.length) log(`price batches failed: ${priceErrors.length}/${batches.length} — ${priceErrors[0]}`);

    // availability, one call per sku
    const availList = await pool(skus, cfg.concurrency || 6, async ({ sku }) => {
      const a = await retry(() => fetchAvailability(cfg, sku), 3, `avail ${sku}`);
      await sleep(cfg.delayMs || 50);
      return a;
    }, (d, n) => (d % 25 === 0 || d === n) && log(`availability ${d}/${n}`));

    const items = [];
    const errors = priceErrors.map((e) => ({ stage: 'prices', error: e }));
    skus.forEach(({ sku, category }, i) => {
      const a = availList[i];
      if (!a || a.error) { errors.push({ sku, error: (a && a.error) || 'no availability' }); return; }
      if (!prices[sku] || prices[sku].error) { errors.push({ sku, error: 'no price' }); return; }
      const it = assemble(sku, category, prices[sku], a, cfg);
      if (it) items.push(it);
    });
    items.sort((a, b) => (b.saveVsNew || 0) - (a.saveVsNew || 0));
    return {
      meta: {
        ts: new Date().toISOString(), durationMs: Date.now() - t0,
        skusScanned: skus.length, itemsInStock: items.length,
        perCategory: Object.fromEntries(Object.entries(perCategory).map(([k, v]) => [k, v.length])),
        errors,
      },
      items,
    };
  }

  async function bbProbe(cfg) {
    const { perCategory } = await collectSkus(cfg);
    return { ts: new Date().toISOString(), categories: perCategory };
  }

  window.bbScrape = bbScrape;
  window.bbProbe = bbProbe;
  window.bbInternals = { collectSkus, fetchPrices, fetchAvailability, assemble, listingUrl, areasOf, allStores };
})();
