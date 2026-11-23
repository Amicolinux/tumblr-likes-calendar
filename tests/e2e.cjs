// End-to-end tests for Tumblr Likes Calendar.
//
//   npm i -D playwright && npx playwright install chromium
//   node tests/e2e.cjs
//
// Injects likes-calendar.js into the page's MAIN world, stubs
// window.tumblr.apiFetch and the /likes page, and checks the behaviours that
// are easy to regress (see CLAUDE.md "Trappole"):
//   A) day click shows only that local day's likes (no Tumblr navigation),
//      gallery virtualization (bounded DOM + recycling), tag & blog:name filter;
//   B) heatmap cells never collide across DST — Europe/Rome, America/New_York,
//      Asia/Tokyo (the Date.UTC day-count fix).
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const JS = fs.readFileSync(path.resolve(__dirname, '..', 'likes-calendar.js'), 'utf8');
const PAGE = 50;
const GIF = Buffer.from('47494638396101000100800000ffffff00000021f90401000000002c00000000010001000002024401003b', 'hex');

const results = [];
const ok = (c, m) => { results.push([!!c, m]); if (!c) console.error('FAIL: ' + m); };

function post(id, ts, blog, tags) {
  return { id, blogName: blog, likedTimestamp: ts, tags: tags || [],
    content: [{ type: 'image', media: [{ url: `https://img.example/${id}.jpg`, width: 500 }] }],
    summary: '', postUrl: `https://${blog}.tumblr.com/post/${id}` };
}

async function newCtx(browser, tz) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, timezoneId: tz });
  await ctx.route('**/www.tumblr.com/likes', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
  await ctx.route('**/img.example/**', (r) => r.fulfill({ status: 200, contentType: 'image/gif', body: GIF }));
  return ctx;
}

async function scan(page, posts) {
  await page.addInitScript(({ posts, PAGE }) => {
    window.tumblr = { apiFetch: async (res) => {
      const m = /offset=(\d+)/.exec(res); const o = m ? +m[1] : 0;
      const s = posts.slice(o, o + PAGE); const n = o + PAGE;
      return { response: { likedPosts: s, links: n < posts.length ? { next: { href: `/v2/user/likes?limit=${PAGE}&offset=${n}` } } : undefined } };
    } };
  }, { posts, PAGE });
  await page.goto('https://www.tumblr.com/likes');
  await page.addScriptTag({ content: JS });
  await page.click('#tlc-launcher');
  await page.click('button:has-text("Refresh likes")');
  await page.waitForFunction(() => { const s = document.querySelector('#tlc-panel .tlc-sub'); return s && /likes total/.test(s.textContent); }, { timeout: 20000 });
}

// ---- A) functional ----------------------------------------------------------
async function functional(browser) {
  const at = (y, m, d, h) => Math.floor(Date.UTC(y, m - 1, d, h, 0, 0) / 1000);
  const posts = [];
  // 500 image likes spread BEFORE Sep 2026 (so Oct 2026 holds only the ones below).
  for (let i = 0; i < 500; i++) {
    posts.push(post(1000 + i, at(2026, 8, 31, 12) - i * 2 * 86400, ['alpha', 'beta', 'gamma'][i % 3], i % 2 === 0 ? ['anime'] : ['art']));
  }
  // target day: 3 on Oct 19 2026, 2 on Oct 24 2026 (mid-day Rome).
  posts.unshift(post(9024, at(2026, 10, 24, 15), 'blog24a'), post(9025, at(2026, 10, 24, 11), 'blog24b'));
  posts.unshift(post(9019, at(2026, 10, 19, 20), 'blog19a'), post(9018, at(2026, 10, 19, 14), 'blog19b'), post(9017, at(2026, 10, 19, 11), 'blog19c'));

  const ctx = await newCtx(browser, 'Europe/Rome');
  let navigated = null;
  await ctx.route('**/www.tumblr.com/likes?*', (r) => { navigated = r.request().url(); return r.fulfill({ contentType: 'text/html', body: 'x' }); });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

  await scan(page, posts);

  // --- day click ---
  const clicked = await page.evaluate(() => {
    const c = [...document.querySelectorAll('#tlc-panel .tlc-grid .tlc-cell')].find((x) => /2026-10-19/.test(x.title || ''));
    if (!c) return false; c.click(); return true;
  });
  ok(clicked, 'A: clicked the Oct 19 2026 cell');
  await page.waitForSelector('#tlc-panel .tlc-results .tlc-rdate', { timeout: 6000 });
  const day = await page.evaluate(() => ({
    dates: [...document.querySelectorAll('#tlc-panel .tlc-results .tlc-rdate')].map((x) => x.textContent),
  }));
  ok(day.dates.length === 3, `A: 3 results for Oct 19 (got ${day.dates.length})`);
  ok(day.dates.every((d) => d === 'Oct 19, 2026'), `A: every result is Oct 19 (got ${JSON.stringify(day.dates)})`);
  ok(navigated === null, `A: no Tumblr navigation on day click (${navigated})`);

  // --- gallery virtualization ---
  await page.evaluate(() => { const b = [...document.querySelectorAll('#tlc-panel .tlc-back')][0]; if (b) b.click(); });
  await page.click('button:has-text("Gallery")');
  await page.waitForFunction(() => document.querySelectorAll('.tlc-gi-abs').length > 0, { timeout: 8000 });
  await page.waitForTimeout(150);
  const g1 = await page.evaluate(() => {
    const sc = document.querySelector('.tlc-gallery-scroller');
    const cells = [...document.querySelectorAll('.tlc-gi-abs')];
    return { cells: cells.length, spacerH: document.querySelector('.tlc-gallery-spacer').offsetHeight, viewH: sc.clientHeight, tops: cells.map((c) => c.style.top) };
  });
  ok(g1.cells > 0 && g1.cells < 150, `A: gallery DOM bounded, not all 505 (got ${g1.cells})`);
  ok(g1.spacerH > g1.viewH * 2, `A: spacer scrollable (spacer=${g1.spacerH}, view=${g1.viewH})`);
  const before = new Set(g1.tops);
  await page.evaluate(() => { const sc = document.querySelector('.tlc-gallery-scroller'); sc.scrollTop = 4000; sc.dispatchEvent(new Event('scroll')); });
  await page.waitForTimeout(150);
  const g2 = await page.evaluate(() => [...document.querySelectorAll('.tlc-gi-abs')].map((c) => c.style.top));
  ok(g2.some((t) => !before.has(t)), 'A: gallery recycles rows on scroll');

  // --- filters ---
  await page.fill('.tlc-gallery-bar input', 'anime');
  await page.click('.tlc-gallery-bar button:has-text("Filter")');
  await page.waitForFunction(() => /matching .anime/.test(document.getElementById('tlc-gallery-note').textContent), { timeout: 5000 });
  const tagNote = await page.evaluate(() => document.getElementById('tlc-gallery-note').textContent);
  ok(/250 liked images matching/.test(tagNote), `A: tag filter count (got "${tagNote}")`);

  await page.fill('.tlc-gallery-bar input', 'blog:blog19a');
  await page.click('.tlc-gallery-bar button:has-text("Filter")');
  await page.waitForFunction(() => /matching .blog:blog19a/.test(document.getElementById('tlc-gallery-note').textContent), { timeout: 5000 });
  const blogNote = await page.evaluate(() => document.getElementById('tlc-gallery-note').textContent);
  ok(/1 liked image matching/.test(blogNote), `A: blog filter count (got "${blogNote}")`);

  ok(errs.length === 0, 'A: no console/page errors (' + JSON.stringify(errs.slice(0, 2)) + ')');
  await ctx.close();
}

// ---- B) DST: no cell collisions across timezones ----------------------------
async function dst(browser) {
  const days = 365;
  const posts = [];
  const start = Date.UTC(2025, 0, 1, 11, 0, 0);
  for (let i = 0; i < days; i++) posts.push(post(i, Math.floor(start / 1000) + i * 86400, 'b', []));
  for (const tz of ['Europe/Rome', 'America/New_York', 'Asia/Tokyo']) {
    const ctx = await newCtx(browser, tz);
    const page = await ctx.newPage();
    await scan(page, posts);
    const r = await page.evaluate(() => {
      const cells = [...document.querySelectorAll('#tlc-panel .tlc-grid .tlc-cell')];
      const slots = {}; let n = 0;
      for (const c of cells) { if (!/(\d{4}-\d{2}-\d{2})/.test(c.title || '')) continue; n++; const s = c.style.gridRow + '|' + c.style.gridColumn; slots[s] = (slots[s] || 0) + 1; }
      return { n, coll: Object.values(slots).filter((v) => v > 1).length };
    });
    ok(r.coll === 0, `B: ${tz} — ${r.n} cells, ${r.coll} collisions`);
    await ctx.close();
  }
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    await functional(browser);
    await dst(browser);
  } finally {
    await browser.close();
  }
  const passed = results.filter((r) => r[0]).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  for (const [o, m] of results) console.log(`  ${o ? 'PASS' : 'FAIL'}  ${m}`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
