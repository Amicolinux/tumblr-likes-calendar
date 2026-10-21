/*
 * Tumblr Likes Calendar  —  v0.2.0
 * --------------------------------
 * Runs in the MAIN world (page context) so it can use window.tumblr.apiFetch,
 * the authenticated fetch helper Tumblr exposes to extensions. No API key,
 * no OAuth: it piggybacks on your logged-in session.
 *
 * Data flow:
 *   /v2/user/likes  ->  response.likedPosts[]  (full post objects)
 *   follow response.links.next.href until it runs out.
 *
 * What's new in 0.2.0:
 *   - Storage moved from localStorage to IndexedDB. We now keep, per liked
 *     post, its tags, image URLs, blog, permalink and summary — not just a
 *     per-day count. This is what makes tag search possible and lets future
 *     versions show thumbnails without another full re-scan.
 *   - Tag search: type a tag (or click one of your most-used tags) to list
 *     every like carrying it, newest first, each linking back to the post.
 *
 * The heatmap calendar itself works exactly as before: click a day to open
 * /likes?before=<end-of-that-day>.
 *
 * NOTE ON UPGRADING FROM 0.1.x: the old localStorage cache only held per-day
 * counts, with no tags. On first run of 0.2.0 the calendar still shows from
 * that old cache, but a one-time full "Refresh" is needed to populate tags
 * and images for search.
 */
(function () {
  'use strict';

  if (window.__tumblrLikesCalendarLoaded) return;
  window.__tumblrLikesCalendarLoaded = true;

  const LEGACY_CACHE_KEY = 'tlc:cache:v1';  // v0.1.x localStorage key (per-day counts only)
  const DB_NAME = 'TumblrLikesCalendar';
  const DB_VERSION = 1;
  const STORE_POSTS = 'posts';
  const STORE_META = 'meta';
  const META_ID = 'summary';
  const PAGE_LIMIT = 50;          // likes per API page (Tumblr max for this endpoint)
  const PAGE_SLEEP_MS = 180;      // gentle pause between pages
  const TOP_TAGS_KEEP = 40;       // how many "most used" tags to remember for the chip cloud
  const SEARCH_RESULT_LIMIT = 300;// cap rendered search results (for DOM sanity)
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pad = (n) => String(n).padStart(2, '0');
  const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const normTag = (t) => String(t == null ? '' : t).trim().toLowerCase();

  // ---- IndexedDB layer ----------------------------------------------------
  let _dbPromise = null;
  function openDB() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_POSTS)) {
          const s = db.createObjectStore(STORE_POSTS, { keyPath: 'key' });
          s.createIndex('tags', 'tags', { multiEntry: true });
          s.createIndex('ts', 'ts', { unique: false });
          s.createIndex('blog', 'blog', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return _dbPromise;
  }

  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  function reqDone(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function getMeta() {
    const db = await openDB();
    const tx = db.transaction(STORE_META, 'readonly');
    const res = await reqDone(tx.objectStore(STORE_META).get(META_ID));
    return res || null;
  }

  // Replace the whole dataset in one go: clear posts, write all records, store meta.
  async function writeAll(records, meta) {
    const db = await openDB();
    const tx = db.transaction([STORE_POSTS, STORE_META], 'readwrite');
    const posts = tx.objectStore(STORE_POSTS);
    const metaStore = tx.objectStore(STORE_META);
    posts.clear();
    for (const r of records) posts.put(r);
    metaStore.put(meta);
    await txDone(tx);
  }

  // Exact-tag lookup via the multiEntry index; returns records sorted newest-first.
  async function postsByTag(tag) {
    const key = normTag(tag);
    if (!key) return [];
    const db = await openDB();
    const tx = db.transaction(STORE_POSTS, 'readonly');
    const idx = tx.objectStore(STORE_POSTS).index('tags');
    const out = await reqDone(idx.getAll(IDBKeyRange.only(key)));
    out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return out;
  }

  // Build the full distinct-tag list (cached) so we can offer "contains" suggestions.
  let _distinctTags = null;
  async function distinctTags() {
    if (_distinctTags) return _distinctTags;
    const db = await openDB();
    const tx = db.transaction(STORE_POSTS, 'readonly');
    const idx = tx.objectStore(STORE_POSTS).index('tags');
    const set = new Set();
    await new Promise((resolve, reject) => {
      const cur = idx.openKeyCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) { resolve(); return; }
        set.add(c.key);
        c.continue();
      };
      cur.onerror = () => reject(cur.error);
    });
    _distinctTags = Array.from(set).sort();
    return _distinctTags;
  }

  // ---- post parsing -------------------------------------------------------
  function pickImageFromMedia(media) {
    if (!Array.isArray(media) || !media.length) return null;
    // Prefer the widest variant; fall back to the first with a url.
    let best = null;
    for (const m of media) {
      if (!m || !m.url) continue;
      if (!best || (m.width || 0) > (best.width || 0)) best = m;
    }
    return best ? best.url : null;
  }

  function collectFromBlocks(blocks, urls) {
    if (!Array.isArray(blocks)) return;
    for (const b of blocks) {
      if (b && b.type === 'image') {
        const u = pickImageFromMedia(b.media);
        if (u) urls.add(u);
      }
    }
  }

  function extractImages(post) {
    const urls = new Set();
    // Legacy photo posts
    const photos = post.photos || post.photoset || null;
    if (Array.isArray(photos)) {
      for (const ph of photos) {
        if (!ph) continue;
        const os = ph.originalSize || ph.original_size;
        if (os && os.url) urls.add(os.url);
        else if (ph.url) urls.add(ph.url);
      }
    }
    // NPF content on the post itself
    collectFromBlocks(post.content, urls);
    // NPF content in the reblog trail
    if (Array.isArray(post.trail)) {
      for (const t of post.trail) if (t) collectFromBlocks(t.content, urls);
    }
    return Array.from(urls);
  }

  function extractTags(post) {
    const raw = Array.isArray(post.tags) ? post.tags : [];
    const seen = new Set();
    const norm = [];
    const display = [];
    for (const t of raw) {
      const n = normTag(t);
      if (!n || seen.has(n)) continue;
      seen.add(n);
      norm.push(n);
      display.push(String(t).trim());
    }
    return { norm, display };
  }

  function toRecord(post) {
    const ts = post.likedTimestamp ?? post.liked_timestamp;
    if (!ts) return null;
    const blog = post.blogName || post.blog_name || (post.blog && post.blog.name) || 'unknown';
    const id = post.id != null ? String(post.id)
             : (post.idString || post.id_string || '');
    const { norm, display } = extractTags(post);
    return {
      key: `${blog}:${id}`,
      blog,
      id,
      ts,
      tags: norm,                 // indexed (multiEntry)
      tagsRaw: display,           // for showing nicely
      images: extractImages(post),
      postUrl: post.postUrl || post.post_url || `https://${blog}.tumblr.com/post/${id}`,
      summary: (post.summary || '').slice(0, 200),
    };
  }

  // ---- styles -------------------------------------------------------------
  function injectStyles() {
    if (document.getElementById('tlc-styles')) return;
    const css = `
      #tlc-launcher {
        position: fixed; right: 20px; bottom: 20px; z-index: 2147483000;
        background: #001935; color: #fff; border: 1px solid #ffffff33;
        border-radius: 999px; padding: 10px 16px; font: 600 14px/1 system-ui, sans-serif;
        cursor: pointer; box-shadow: 0 4px 14px #0006;
      }
      #tlc-launcher:hover { background: #00294f; }
      #tlc-overlay {
        position: fixed; inset: 0; z-index: 2147483001; display: none;
        background: #0009; align-items: flex-start; justify-content: center;
        overflow: auto; padding: 40px 16px;
      }
      #tlc-overlay.tlc-open { display: flex; }
      #tlc-panel {
        background: #12181f; color: #e8ecf1; width: min(980px, 100%);
        border-radius: 14px; border: 1px solid #ffffff1f; padding: 20px 22px 26px;
        font: 14px/1.5 system-ui, sans-serif; box-shadow: 0 20px 60px #000a;
      }
      #tlc-panel h2 { margin: 0; font-size: 18px; font-weight: 700; }
      .tlc-head { display: flex; align-items: center; gap: 12px; margin-bottom: 6px; }
      .tlc-head .tlc-spacer { flex: 1; }
      .tlc-btn {
        background: #1f2a37; color: #e8ecf1; border: 1px solid #ffffff26;
        border-radius: 8px; padding: 7px 12px; font: 600 13px system-ui, sans-serif; cursor: pointer;
      }
      .tlc-btn:hover { background: #273240; }
      .tlc-btn[disabled] { opacity: .5; cursor: default; }
      .tlc-sub { color: #9fb0c3; margin: 2px 0 14px; }

      /* search bar */
      .tlc-search { display: flex; gap: 8px; align-items: center; margin: 2px 0 10px; }
      .tlc-search input {
        flex: 1; background: #0d1319; color: #e8ecf1; border: 1px solid #ffffff26;
        border-radius: 8px; padding: 8px 11px; font: 14px system-ui, sans-serif;
      }
      .tlc-search input::placeholder { color: #6b7e92; }
      .tlc-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 14px; }
      .tlc-chip {
        background: #182230; color: #bcd; border: 1px solid #ffffff1f; border-radius: 999px;
        padding: 3px 10px; font-size: 12px; cursor: pointer; white-space: nowrap;
      }
      .tlc-chip:hover { background: #22303f; color: #fff; }
      .tlc-chip .tlc-chip-n { color: #6f8197; margin-left: 5px; }
      .tlc-chips-label { color: #8ea0b5; font-size: 12px; margin: 0 0 6px; }

      /* search results */
      .tlc-results { margin-top: 4px; }
      .tlc-result {
        display: flex; gap: 12px; align-items: flex-start; padding: 10px 0;
        border-top: 1px solid #ffffff14;
      }
      .tlc-thumb {
        width: 72px; height: 72px; border-radius: 8px; object-fit: cover;
        background: #0d1319; flex: none; border: 1px solid #ffffff14;
      }
      .tlc-thumb.tlc-noimg { display: flex; align-items: center; justify-content: center;
        color: #4d6074; font-size: 22px; }
      .tlc-rmeta { min-width: 0; flex: 1; }
      .tlc-rtop { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
      .tlc-rblog { font-weight: 700; color: #e8ecf1; }
      .tlc-rdate { color: #8ea0b5; font-size: 12px; }
      .tlc-ropen { margin-left: auto; }
      .tlc-rsummary { color: #c3cedb; margin: 3px 0 5px; overflow: hidden;
        display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
      .tlc-rtags { display: flex; flex-wrap: wrap; gap: 5px; }
      .tlc-rtag { color: #7fb2ff; font-size: 12px; cursor: pointer; }
      .tlc-rtag:hover { text-decoration: underline; }
      .tlc-back { color: #7fb2ff; cursor: pointer; font-size: 13px; }
      .tlc-back:hover { text-decoration: underline; }
      .tlc-suggest { color: #9fb0c3; font-size: 13px; margin: 6px 0 2px; }

      /* calendar (unchanged) */
      .tlc-year { margin: 22px 0 6px; font-weight: 700; color: #cbd6e2; }
      .tlc-grid-wrap { overflow-x: auto; padding-bottom: 6px; }
      .tlc-months { display: grid; grid-auto-flow: column; grid-auto-columns: 13px;
        gap: 3px; margin: 0 0 4px 26px; color: #8ea0b5; font-size: 10px; height: 12px; }
      .tlc-row { display: flex; align-items: flex-start; }
      .tlc-dows { display: grid; grid-template-rows: repeat(7, 13px); gap: 3px;
        margin-right: 6px; font-size: 9px; color: #8ea0b5; width: 20px; }
      .tlc-dows span { height: 13px; line-height: 13px; }
      .tlc-grid { display: grid; grid-template-rows: repeat(7, 13px);
        grid-auto-flow: column; grid-auto-columns: 13px; gap: 3px; }
      .tlc-cell { width: 13px; height: 13px; border-radius: 3px; background: #1b2530; cursor: pointer; }
      .tlc-cell.l1 { background: #16351f; }
      .tlc-cell.l2 { background: #1f6b34; }
      .tlc-cell.l3 { background: #2ea043; }
      .tlc-cell.l4 { background: #57e06e; }
      .tlc-cell:hover { outline: 1px solid #fff8; }
      .tlc-legend { display: flex; align-items: center; gap: 6px; margin-top: 14px;
        color: #9fb0c3; font-size: 12px; }
      .tlc-legend .tlc-cell { cursor: default; }
      .tlc-empty { color: #9fb0c3; padding: 20px 0; }
      .tlc-err { color: #ff9a9a; padding: 12px 0; white-space: pre-wrap; }
      .tlc-progress { color: #9fb0c3; padding: 10px 0; }
    `;
    const style = document.createElement('style');
    style.id = 'tlc-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ---- data fetching ------------------------------------------------------
  async function waitForApi(timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (window.tumblr && typeof window.tumblr.apiFetch === 'function') return true;
      await sleep(200);
    }
    return false;
  }

  // Full scan: walks every like, builds per-post records + per-day counts +
  // a top-tags tally, then stores it all in IndexedDB.
  async function scanLikes(onProgress) {
    const records = [];
    const counts = Object.create(null);
    const tagFreq = Object.create(null);
    let total = 0, kept = 0, withImages = 0;
    let minTs = Infinity, maxTs = -Infinity;
    let resource = `/v2/user/likes?limit=${PAGE_LIMIT}`;

    while (resource) {
      const { response } = await window.tumblr.apiFetch(resource);
      const posts = (response && response.likedPosts) || [];
      for (const p of posts) {
        const rec = toRecord(p);
        if (!rec) continue;
        total += 1;
        kept += 1;
        if (rec.images.length) withImages += 1;
        const d = new Date(rec.ts * 1000);
        const key = dayKey(d);
        counts[key] = (counts[key] || 0) + 1;
        if (rec.ts < minTs) minTs = rec.ts;
        if (rec.ts > maxTs) maxTs = rec.ts;
        for (const t of rec.tags) tagFreq[t] = (tagFreq[t] || 0) + 1;
        records.push(rec);
      }
      if (onProgress) onProgress(total);
      resource = response && response.links && response.links.next && response.links.next.href;
      if (resource) await sleep(PAGE_SLEEP_MS);
    }

    const topTags = Object.keys(tagFreq)
      .sort((a, b) => tagFreq[b] - tagFreq[a])
      .slice(0, TOP_TAGS_KEEP)
      .map((t) => ({ tag: t, n: tagFreq[t] }));

    const meta = {
      id: META_ID,
      total: kept,
      withImages,
      distinctTags: Object.keys(tagFreq).length,
      counts,
      topTags,
      minTs: isFinite(minTs) ? minTs : null,
      maxTs: isFinite(maxTs) ? maxTs : null,
      cachedAt: Date.now(),
    };

    _distinctTags = null; // invalidate cached tag list
    await writeAll(records, meta);
    return meta;
  }

  // ---- legacy localStorage (for first-run display before a rescan) --------
  function loadLegacyCache() {
    try {
      const raw = localStorage.getItem(LEGACY_CACHE_KEY);
      if (!raw) return null;
      const c = JSON.parse(raw);
      if (!c || !c.counts) return null;
      return c; // {counts, total, minTs, maxTs, cachedAt}
    } catch { return null; }
  }
  function clearLegacyCache() {
    try { localStorage.removeItem(LEGACY_CACHE_KEY); } catch { /* ignore */ }
  }

  // ---- calendar rendering (unchanged behaviour) ---------------------------
  function levelFor(count, max) {
    if (!count) return 0;
    if (max <= 1) return 4;
    const r = count / max;
    if (r > 0.66) return 4;
    if (r > 0.33) return 3;
    if (r > 0.1) return 2;
    return 1;
  }

  function buildYear(year, counts, maxDaily, todayKey) {
    const wrap = document.createElement('div');

    const label = document.createElement('div');
    label.className = 'tlc-year';
    label.textContent = String(year);
    wrap.appendChild(label);

    const scroll = document.createElement('div');
    scroll.className = 'tlc-grid-wrap';

    const months = document.createElement('div');
    months.className = 'tlc-months';

    const row = document.createElement('div');
    row.className = 'tlc-row';

    const dows = document.createElement('div');
    dows.className = 'tlc-dows';
    for (let i = 0; i < 7; i++) {
      const s = document.createElement('span');
      s.textContent = (i === 1 || i === 3 || i === 5) ? DOW[i] : '';
      dows.appendChild(s);
    }

    const grid = document.createElement('div');
    grid.className = 'tlc-grid';

    const start = new Date(year, 0, 1);
    const end = new Date(year, 11, 31);
    const firstCol = 0;
    let lastMonthLabeled = -1;

    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const weekday = d.getDay();
      const dayOfYear = Math.floor((d - start) / 86400000);
      const col = Math.floor((dayOfYear + start.getDay()) / 7);

      const key = dayKey(d);
      const c = counts[key] || 0;
      const cell = document.createElement('div');
      cell.className = 'tlc-cell l' + levelFor(c, maxDaily);
      cell.style.gridRow = (weekday + 1);
      cell.style.gridColumn = (col + 1 - firstCol);
      cell.title = `${key} — ${c} likes`;
      if (key <= todayKey) {
        const endOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0);
        const before = Math.floor(endOfDay.getTime() / 1000);
        cell.addEventListener('click', () => {
          window.location.assign('/likes?before=' + before);
        });
      } else {
        cell.style.visibility = 'hidden';
      }
      grid.appendChild(cell);

      if (d.getDate() === 1 && d.getMonth() !== lastMonthLabeled) {
        lastMonthLabeled = d.getMonth();
        const m = document.createElement('div');
        m.textContent = MONTHS[d.getMonth()];
        m.style.gridColumn = (col + 1);
        months.appendChild(m);
      }
    }

    row.appendChild(dows);
    row.appendChild(grid);
    scroll.appendChild(months);
    scroll.appendChild(row);
    wrap.appendChild(scroll);
    return wrap;
  }

  function renderCalendar(container, data) {
    container.innerHTML = '';

    if (!data || !data.total || !data.counts) {
      const e = document.createElement('div');
      e.className = 'tlc-empty';
      e.textContent = 'No likes found (or not loaded yet). Press “Refresh”.';
      container.appendChild(e);
      return;
    }

    let maxDaily = 0;
    for (const k in data.counts) if (data.counts[k] > maxDaily) maxDaily = data.counts[k];

    const todayKey = dayKey(new Date());
    const minYear = new Date(data.minTs * 1000).getFullYear();
    const maxYear = new Date(data.maxTs * 1000).getFullYear();

    for (let y = maxYear; y >= minYear; y--) {
      container.appendChild(buildYear(y, data.counts, maxDaily, todayKey));
    }

    const legend = document.createElement('div');
    legend.className = 'tlc-legend';
    legend.appendChild(document.createTextNode('Less'));
    for (let l = 0; l <= 4; l++) {
      const c = document.createElement('div');
      c.className = 'tlc-cell l' + l;
      legend.appendChild(c);
    }
    legend.appendChild(document.createTextNode('More'));
    container.appendChild(legend);
  }

  // ---- search rendering ---------------------------------------------------
  function fmtDate(ts) {
    try { return new Date(ts * 1000).toLocaleDateString('en-US',
      { year: 'numeric', month: 'short', day: 'numeric' }); }
    catch { return ''; }
  }

  function renderResult(rec) {
    const row = document.createElement('div');
    row.className = 'tlc-result';

    if (rec.images && rec.images.length) {
      const img = document.createElement('img');
      img.className = 'tlc-thumb';
      img.loading = 'lazy';
      img.src = rec.images[0];
      img.alt = '';
      img.addEventListener('error', () => {
        const ph = document.createElement('div');
        ph.className = 'tlc-thumb tlc-noimg';
        ph.textContent = '\u{1F5BC}';
        img.replaceWith(ph);
      });
      row.appendChild(img);
    } else {
      const ph = document.createElement('div');
      ph.className = 'tlc-thumb tlc-noimg';
      ph.textContent = '\u{1F4C4}';
      row.appendChild(ph);
    }

    const meta = document.createElement('div');
    meta.className = 'tlc-rmeta';

    const top = document.createElement('div');
    top.className = 'tlc-rtop';
    const blog = document.createElement('span');
    blog.className = 'tlc-rblog';
    blog.textContent = rec.blog;
    const date = document.createElement('span');
    date.className = 'tlc-rdate';
    date.textContent = fmtDate(rec.ts);
    const open = document.createElement('a');
    open.className = 'tlc-btn tlc-ropen';
    open.textContent = 'Open';
    open.href = rec.postUrl;
    open.target = '_blank';
    open.rel = 'noopener';
    top.append(blog, date, open);
    meta.appendChild(top);

    if (rec.summary) {
      const sum = document.createElement('div');
      sum.className = 'tlc-rsummary';
      sum.textContent = rec.summary;
      meta.appendChild(sum);
    }

    const tagsWrap = document.createElement('div');
    tagsWrap.className = 'tlc-rtags';
    const show = (rec.tagsRaw && rec.tagsRaw.length) ? rec.tagsRaw : rec.tags;
    show.slice(0, 12).forEach((t, i) => {
      const el = document.createElement('span');
      el.className = 'tlc-rtag';
      el.textContent = '#' + t;
      el.addEventListener('click', () => doSearch(rec.tags[i] || t));
      tagsWrap.appendChild(el);
    });
    meta.appendChild(tagsWrap);

    row.appendChild(meta);
    return row;
  }

  async function doSearch(tag) {
    const q = normTag(tag);
    searchInput.value = tag;
    showingSearch = true;
    calBox.style.display = 'none';
    chipsBox.style.display = 'none';
    resultsBox.style.display = 'block';
    resultsBox.innerHTML = '';

    const bar = document.createElement('div');
    bar.className = 'tlc-search';
    const back = document.createElement('span');
    back.className = 'tlc-back';
    back.textContent = '← Back to calendar';
    back.addEventListener('click', showCalendar);
    bar.appendChild(back);
    resultsBox.appendChild(bar);

    if (!q) { showCalendar(); return; }

    const header = document.createElement('div');
    header.className = 'tlc-sub';
    resultsBox.appendChild(header);

    let matches = [];
    try {
      matches = await postsByTag(q);
    } catch (err) {
      header.className = 'tlc-err';
      header.textContent = 'Search error: ' + (err && err.message ? err.message : String(err));
      return;
    }

    header.textContent = matches.length
      ? `${matches.length} like${matches.length === 1 ? '' : 's'} tagged “${q}”`
      : `No likes tagged “${q}”`;

    // If nothing exact, offer "tags containing" suggestions.
    if (!matches.length) {
      try {
        const all = await distinctTags();
        const near = all.filter((t) => t.includes(q)).slice(0, 30);
        if (near.length) {
          const sug = document.createElement('div');
          sug.className = 'tlc-suggest';
          sug.textContent = 'Tags containing “' + q + '”:';
          resultsBox.appendChild(sug);
          const chips = document.createElement('div');
          chips.className = 'tlc-chips';
          near.forEach((t) => chips.appendChild(makeChip(t)));
          resultsBox.appendChild(chips);
        }
      } catch { /* ignore */ }
      return;
    }

    const list = document.createElement('div');
    list.className = 'tlc-results';
    const shown = matches.slice(0, SEARCH_RESULT_LIMIT);
    for (const rec of shown) list.appendChild(renderResult(rec));
    resultsBox.appendChild(list);

    if (matches.length > shown.length) {
      const more = document.createElement('div');
      more.className = 'tlc-sub';
      more.style.marginTop = '12px';
      more.textContent = `Showing the first ${shown.length} of ${matches.length}.`;
      resultsBox.appendChild(more);
    }
  }

  function makeChip(tag, n) {
    const chip = document.createElement('span');
    chip.className = 'tlc-chip';
    chip.textContent = '#' + tag;
    if (n != null) {
      const cnt = document.createElement('span');
      cnt.className = 'tlc-chip-n';
      cnt.textContent = n;
      chip.appendChild(cnt);
    }
    chip.addEventListener('click', () => doSearch(tag));
    return chip;
  }

  function renderTopTags(meta) {
    chipsBox.innerHTML = '';
    if (!meta || !meta.topTags || !meta.topTags.length) return;
    const label = document.createElement('div');
    label.className = 'tlc-chips-label';
    label.textContent = 'Your most-used tags:';
    chipsBox.appendChild(label);
    const cloud = document.createElement('div');
    cloud.className = 'tlc-chips';
    for (const { tag, n } of meta.topTags) cloud.appendChild(makeChip(tag, n));
    chipsBox.appendChild(cloud);
  }

  function showCalendar() {
    showingSearch = false;
    resultsBox.style.display = 'none';
    resultsBox.innerHTML = '';
    calBox.style.display = 'block';
    chipsBox.style.display = 'block';
  }

  // ---- panel / UI ---------------------------------------------------------
  let overlay, calBox, chipsBox, resultsBox, subEl, refreshBtn, searchInput;
  let showingSearch = false;
  let currentMeta = null;

  function buildPanel() {
    injectStyles();

    overlay = document.createElement('div');
    overlay.id = 'tlc-overlay';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closePanel(); });

    const panel = document.createElement('div');
    panel.id = 'tlc-panel';

    const head = document.createElement('div');
    head.className = 'tlc-head';
    const h2 = document.createElement('h2');
    h2.textContent = 'Your likes calendar';
    const spacer = document.createElement('div');
    spacer.className = 'tlc-spacer';
    refreshBtn = document.createElement('button');
    refreshBtn.className = 'tlc-btn';
    refreshBtn.textContent = 'Refresh';
    refreshBtn.addEventListener('click', runFetch);
    const closeBtn = document.createElement('button');
    closeBtn.className = 'tlc-btn';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', closePanel);
    head.append(h2, spacer, refreshBtn, closeBtn);

    subEl = document.createElement('div');
    subEl.className = 'tlc-sub';
    subEl.textContent = '';

    // search bar
    const search = document.createElement('div');
    search.className = 'tlc-search';
    searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.placeholder = 'Search your likes by tag…';
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); doSearch(searchInput.value); }
    });
    const searchBtn = document.createElement('button');
    searchBtn.className = 'tlc-btn';
    searchBtn.textContent = 'Search';
    searchBtn.addEventListener('click', () => doSearch(searchInput.value));
    search.append(searchInput, searchBtn);

    chipsBox = document.createElement('div');
    resultsBox = document.createElement('div');
    resultsBox.style.display = 'none';
    calBox = document.createElement('div');

    panel.append(head, subEl, search, chipsBox, resultsBox, calBox);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
  }

  async function openPanel() {
    if (!overlay) buildPanel();
    overlay.classList.add('tlc-open');
    showCalendar();

    let meta = null;
    try { meta = await getMeta(); } catch { /* ignore */ }
    currentMeta = meta;

    if (meta && meta.total) {
      subEl.textContent = describeMeta(meta);
      renderTopTags(meta);
      renderCalendar(calBox, meta);
      return;
    }

    // No IndexedDB data yet. Fall back to the old localStorage counts so the
    // calendar isn't empty right after upgrading, and nudge a rescan.
    const legacy = loadLegacyCache();
    if (legacy && legacy.total) {
      subEl.textContent = 'Upgraded to 0.2.0 — press “Refresh” once to enable tag search '
        + '(your old calendar is shown below in the meantime).';
      renderTopTags(null);
      renderCalendar(calBox, legacy);
    } else {
      subEl.textContent = 'First run: press “Refresh” to download your likes.';
      renderTopTags(null);
      renderCalendar(calBox, null);
    }
  }
  function closePanel() { if (overlay) overlay.classList.remove('tlc-open'); }

  function describeMeta(meta) {
    const when = new Date(meta.cachedAt).toLocaleString('en-US');
    const imgs = meta.withImages != null ? ` · ${meta.withImages} with images` : '';
    return `${meta.total} likes total${imgs} · updated ${when} · click a day, or search by tag`;
  }

  async function runFetch() {
    refreshBtn.disabled = true;
    showCalendar();
    chipsBox.innerHTML = '';
    calBox.innerHTML = '';
    const prog = document.createElement('div');
    prog.className = 'tlc-progress';
    prog.textContent = 'Waiting for the Tumblr API…';
    calBox.appendChild(prog);

    const ok = await waitForApi();
    if (!ok) {
      prog.className = 'tlc-err';
      prog.textContent = 'window.tumblr.apiFetch is not available. Make sure you are logged in to Tumblr and reload the page.';
      refreshBtn.disabled = false;
      return;
    }

    try {
      const meta = await scanLikes((n) => { prog.textContent = `Found ${n} likes…`; });
      clearLegacyCache();
      currentMeta = meta;
      subEl.textContent = describeMeta(meta);
      renderTopTags(meta);
      renderCalendar(calBox, meta);
    } catch (err) {
      prog.className = 'tlc-err';
      prog.textContent = 'Error while fetching likes:\n' + (err && err.message ? err.message : String(err));
    } finally {
      refreshBtn.disabled = false;
    }
  }

  // ---- launcher + SPA route handling -------------------------------------
  function onLikesPage() { return /^\/likes(\/|$)/.test(location.pathname); }

  function ensureLauncher() {
    injectStyles();
    let launcher = document.getElementById('tlc-launcher');
    if (onLikesPage()) {
      if (!launcher) {
        launcher = document.createElement('button');
        launcher.id = 'tlc-launcher';
        launcher.textContent = '📅 Likes calendar';
        launcher.addEventListener('click', openPanel);
        document.body.appendChild(launcher);
      }
    } else if (launcher) {
      launcher.remove();
      closePanel();
    }
  }

  function patchHistory() {
    const fire = () => window.dispatchEvent(new Event('tlc:locationchange'));
    for (const m of ['pushState', 'replaceState']) {
      const orig = history[m];
      history[m] = function () { const r = orig.apply(this, arguments); fire(); return r; };
    }
    window.addEventListener('popstate', fire);
    window.addEventListener('tlc:locationchange', ensureLauncher);
  }

  patchHistory();
  ensureLauncher();
})();
