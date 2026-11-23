// End-to-end tests for Tumblr Likes Calendar.
//
//   npm i -D playwright && npx playwright install chromium
//   node tests/e2e.cjs
//   TLC_TODAY=2027-01-10 node tests/e2e.cjs   # simulate another "today"
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
// "Today" for the test: real date, or TLC_TODAY (YYYY-MM-DD, taken at 12:00 UTC)
// to check that the relative dates keep working e.g. at the start of a year.
const NOW = process.env.TLC_TODAY ? new Date(process.env.TLC_TODAY + 'T12:00:00Z') : new Date();
if (isNaN(NOW)) throw new Error('Invalid TLC_TODAY: ' + process.env.TLC_TODAY);
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
  // Same "today" inside the page (Date only; timers keep running).
  if (process.env.TLC_TODAY) await ctx.clock.setFixedTime(NOW);
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
  // All dates are relative to today, so the test keeps working in any year.
  // Target days are UTC calendar days; likes sit at 11–20 UTC, i.e. the same
  // local day in Europe/Rome (UTC+1/+2) all year round.
  const DAY = 86400;
  const todayUtc = NOW;
  const dayStart = (offsetDays) => Math.floor(Date.UTC(todayUtc.getUTCFullYear(), todayUtc.getUTCMonth(), todayUtc.getUTCDate() - offsetDays) / 1000);
  const T1 = dayStart(30);           // "Oct 19" of the original test: 3 likes
  const T2 = dayStart(25);           // "Oct 24": 2 likes
  const BG = dayStart(40);           // background likes end here (before T1)
  const iso = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);
  const T1_KEY = iso(T1);
  const T1_LABEL = new Date((T1 + 12 * 3600) * 1000).toLocaleDateString('en-US', { timeZone: 'Europe/Rome', year: 'numeric', month: 'short', day: 'numeric' });
  const posts = [];
  // 500 image likes spread every 2 days BEFORE BG (so T1/T2 hold only the ones below).
  for (let i = 0; i < 500; i++) {
    posts.push(post(1000 + i, BG + 12 * 3600 - i * 2 * DAY, ['alpha', 'beta', 'gamma'][i % 3], i % 2 === 0 ? ['anime'] : ['art']));
  }
  // target days: 3 likes on T1, 2 on T2 (mid-day Rome).
  posts.unshift(post(9024, T2 + 15 * 3600, 'blog24a'), post(9025, T2 + 11 * 3600, 'blog24b'));
  posts.unshift(post(9019, T1 + 20 * 3600, 'blog19a'), post(9018, T1 + 14 * 3600, 'blog19b'), post(9017, T1 + 11 * 3600, 'blog19c'));

  const ctx = await newCtx(browser, 'Europe/Rome');
  let navigated = null;
  await ctx.route('**/www.tumblr.com/likes?*', (r) => { navigated = r.request().url(); return r.fulfill({ contentType: 'text/html', body: 'x' }); });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

  await scan(page, posts);

  // --- day click ---
  const clicked = await page.evaluate((key) => {
    const c = [...document.querySelectorAll('#tlc-panel .tlc-grid .tlc-cell')].find((x) => (x.title || '').startsWith(key + ' '));
    if (!c) return false; c.click(); return true;
  }, T1_KEY);
  ok(clicked, `A: clicked the ${T1_KEY} cell`);
  await page.waitForSelector('#tlc-panel .tlc-results .tlc-rdate', { timeout: 6000 });
  const day = await page.evaluate(() => ({
    dates: [...document.querySelectorAll('#tlc-panel .tlc-results .tlc-rdate')].map((x) => x.textContent),
  }));
  ok(day.dates.length === 3, `A: 3 results for ${T1_LABEL} (got ${day.dates.length})`);
  ok(day.dates.every((d) => d === T1_LABEL), `A: every result is ${T1_LABEL} (got ${JSON.stringify(day.dates)})`);
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
  // The whole previous calendar year (relative to today): always in the past,
  // and it always contains both the March and the October/November DST changes.
  const year = NOW.getFullYear() - 1;
  const start = Date.UTC(year, 0, 1, 11, 0, 0);
  const days = Math.round((Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86400000);
  const posts = [];
  for (let i = 0; i < days; i++) posts.push(post(i, Math.floor(start / 1000) + i * 86400, 'b', []));
  // Expected DST transitions inside the period (Tokyo has none).
  const expectedTransitions = { 'Europe/Rome': 2, 'America/New_York': 2, 'Asia/Tokyo': 0 };
  for (const tz of Object.keys(expectedTransitions)) {
    const ctx = await newCtx(browser, tz);
    const page = await ctx.newPage();
    await scan(page, posts);
    const r = await page.evaluate((year) => {
      // Months in which the local UTC offset changes during `year`.
      const changes = [];
      for (let d = new Date(year, 0, 1); d.getFullYear() === year; d.setDate(d.getDate() + 1)) {
        const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
        if (next.getTimezoneOffset() !== d.getTimezoneOffset()) changes.push(d.getMonth() + 1);
      }
      const cells = [...document.querySelectorAll('#tlc-panel .tlc-grid .tlc-cell')];
      const slots = {}; let n = 0;
      for (const c of cells) { if (!/(\d{4}-\d{2}-\d{2})/.test(c.title || '')) continue; n++; const s = c.style.gridRow + '|' + c.style.gridColumn; slots[s] = (slots[s] || 0) + 1; }
      return { n, coll: Object.values(slots).filter((v) => v > 1).length, changes };
    }, year);
    const want = expectedTransitions[tz];
    const hasMarch = r.changes.includes(3), hasAutumn = r.changes.some((m) => m === 10 || m === 11);
    ok(r.changes.length === want && (want === 0 || (hasMarch && hasAutumn)),
      `B: ${tz} — period ${year} covers ${want} DST change(s) (months ${JSON.stringify(r.changes)})`);
    ok(r.n >= 300, `B: ${tz} — at least 300 cells checked (got ${r.n})`);
    ok(r.coll === 0, `B: ${tz} — ${r.n} cells, ${r.coll} collisions`);
    await ctx.close();
  }
}

(async () => {
  console.log(`Simulated today: ${NOW.toISOString().slice(0, 10)}${process.env.TLC_TODAY ? ' (TLC_TODAY)' : ''}`);
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
