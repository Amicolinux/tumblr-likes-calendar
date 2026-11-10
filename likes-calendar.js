/*
 * Tumblr Likes Calendar  —  v0.3.0
 * --------------------------------
 * Runs in the MAIN world (page context) so it can use window.tumblr.apiFetch,
 * the authenticated fetch helper Tumblr exposes to extensions. No API key,
 * no OAuth: it piggybacks on your logged-in session.
 *
 * What's new in 0.3.0:
 *   - "Blog seguiti" (followed blogs): a second tab that indexes the original
 *     image posts of the blogs you follow and lets you search them by tag,
 *     shown as a thumbnail grid. Data lives in its own IndexedDB store.
 *   - The scan is manual, selectable (all blogs or a chosen subset),
 *     incremental and RESUMABLE: it remembers where it stopped per blog, so
 *     closing the page and reopening it continues instead of restarting.
 *     Scope for 0.3.0: original posts only, with at least one image.
 *
 * Inherited from 0.2.0 (unchanged):
 *   - Likes heatmap calendar + tag search, backed by IndexedDB.
 *     /v2/user/likes -> response.likedPosts[], paginated via response.links.next.
 *
 * Data flow for followed blogs:
 *   /v2/user/following            -> response.blogs[] (+ response.totalBlogs)
 *   /v2/blog/{blog}/posts?npf=true -> response.posts[] (+ response.totalPosts),
 *                                     paginated via response.links.next.href
 */
(function () {
  'use strict';

  if (window.__tumblrLikesCalendarLoaded) return;
  window.__tumblrLikesCalendarLoaded = true;

  const LEGACY_CACHE_KEY = 'tlc:cache:v1';  // v0.1.x localStorage key (per-day counts only)
  const DB_NAME = 'TumblrLikesCalendar';
  const DB_VERSION = 2;                 // bumped for the followed-blogs stores
  const STORE_POSTS = 'posts';          // likes
  const STORE_META = 'meta';            // likes summary + followed summary
  const STORE_FOLLOWED = 'followed';    // posts from blogs you follow
  const STORE_SCAN = 'scanState';       // per-blog scan progress (resumable)
  const META_ID = 'summary';            // likes meta id
  const FOLLOW_META_ID = 'followSummary';
  const PAGE_LIMIT = 50;                // likes per API page
  const BLOG_PAGE_LIMIT = 20;           // posts per API page for a followed blog
  const PAGE_SLEEP_MS = 180;            // gentle pause between like pages
  const BLOG_PAGE_SLEEP_MS = 260;       // gentle pause between blog pages (be polite)
  const FOLLOW_PAGE_SLEEP_MS = 160;     // pause between following-list pages
  const TOP_TAGS_KEEP = 40;
  const SEARCH_RESULT_LIMIT = 300;
  const FOLLOWED_RESULT_LIMIT = 400;    // cap rendered thumbnails
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
      req.onupgradeneeded = () => {
        const db = req.result;
        // Likes store (v1)
        if (!db.objectStoreNames.contains(STORE_POSTS)) {
          const s = db.createObjectStore(STORE_POSTS, { keyPath: 'key' });
          s.createIndex('tags', 'tags', { multiEntry: true });
          s.createIndex('ts', 'ts', { unique: false });
          s.createIndex('blog', 'blog', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: 'id' });
        }
        // Followed-blogs posts (v2)
        if (!db.objectStoreNames.contains(STORE_FOLLOWED)) {
          const f = db.createObjectStore(STORE_FOLLOWED, { keyPath: 'key' });
          f.createIndex('tags', 'tags', { multiEntry: true });
          f.createIndex('ts', 'ts', { unique: false });
          f.createIndex('blog', 'blog', { unique: false });
        }
        // Per-blog scan progress (v2)
        if (!db.objectStoreNames.contains(STORE_SCAN)) {
          db.createObjectStore(STORE_SCAN, { keyPath: 'blog' });
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

  // ---- likes storage (unchanged) -----------------------------------------
  async function getMeta() {
    const db = await openDB();
    const tx = db.transaction(STORE_META, 'readonly');
    const res = await reqDone(tx.objectStore(STORE_META).get(META_ID));
    return res || null;
  }

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

  // ---- followed-blogs storage --------------------------------------------
  async function getFollowMeta() {
    const db = await openDB();
    const tx = db.transaction(STORE_META, 'readonly');
    const res = await reqDone(tx.objectStore(STORE_META).get(FOLLOW_META_ID));
    return res || null;
  }
  async function setFollowMeta(meta) {
    const db = await openDB();
    const tx = db.transaction(STORE_META, 'readwrite');
    tx.objectStore(STORE_META).put({ ...meta, id: FOLLOW_META_ID });
    await txDone(tx);
  }

  async function putFollowed(records) {
    if (!records.length) return;
    const db = await openDB();
    const tx = db.transaction(STORE_FOLLOWED, 'readwrite');
    const s = tx.objectStore(STORE_FOLLOWED);
    for (const r of records) s.put(r);
    await txDone(tx);
  }

  async function countFollowed() {
    const db = await openDB();
    const tx = db.transaction(STORE_FOLLOWED, 'readonly');
    return reqDone(tx.objectStore(STORE_FOLLOWED).count());
  }

  let _distinctFollowedTags = null;
  async function distinctFollowedTags() {
    if (_distinctFollowedTags) return _distinctFollowedTags;
    const db = await openDB();
    const tx = db.transaction(STORE_FOLLOWED, 'readonly');
    const idx = tx.objectStore(STORE_FOLLOWED).index('tags');
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
    _distinctFollowedTags = Array.from(set).sort();
    return _distinctFollowedTags;
  }

  async function followedByTag(tag) {
    const key = normTag(tag);
    if (!key) return [];
    const db = await openDB();
    const tx = db.transaction(STORE_FOLLOWED, 'readonly');
    const idx = tx.objectStore(STORE_FOLLOWED).index('tags');
    const out = await reqDone(idx.getAll(IDBKeyRange.only(key)));
    out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return out;
  }

  async function getScanState(blog) {
    const db = await openDB();
    const tx = db.transaction(STORE_SCAN, 'readonly');
    const res = await reqDone(tx.objectStore(STORE_SCAN).get(blog));
    return res || null;
  }
  async function setScanState(state) {
    const db = await openDB();
    const tx = db.transaction(STORE_SCAN, 'readwrite');
    tx.objectStore(STORE_SCAN).put(state);
    await txDone(tx);
  }
  async function getAllScanState() {
    const db = await openDB();
    const tx = db.transaction(STORE_SCAN, 'readonly');
    const res = await reqDone(tx.objectStore(STORE_SCAN).getAll());
    return res || [];
  }

  // ---- post parsing (shared) ---------------------------------------------
  function pickImageFromMedia(media) {
    if (!Array.isArray(media) || !media.length) return null;
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
    const photos = post.photos || post.photoset || null;
    if (Array.isArray(photos)) {
      for (const ph of photos) {
        if (!ph) continue;
        const os = ph.originalSize || ph.original_size;
        if (os && os.url) urls.add(os.url);
        else if (ph.url) urls.add(ph.url);
      }
    }
    collectFromBlocks(post.content, urls);
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

  // Likes record (keyed off likedTimestamp)
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
      tags: norm,
      tagsRaw: display,
      images: extractImages(post),
      postUrl: post.postUrl || post.post_url || `https://${blog}.tumblr.com/post/${id}`,
      summary: (post.summary || '').slice(0, 200),
    };
  }

  // Is this post a reblog (rather than an original of `blogName`)?
  function isReblog(post, blogName) {
    if (post.rebloggedRootId || post.reblogged_root_id ||
        post.rebloggedFromId || post.reblogged_from_id) return true;
    const trail = Array.isArray(post.trail) ? post.trail : [];
    for (const t of trail) {
      const n = t && t.blog && (t.blog.name || t.blogName);
      if (n && n !== blogName) return true;
    }
    return false;
  }

  // Followed-blog record (keyed off the post's own timestamp)
  function toFollowedRecord(post, blogName) {
    let ts = post.timestamp ?? post.ts ?? null;
    if (ts == null && post.date) {
      const parsed = Date.parse(post.date);
      if (!isNaN(parsed)) ts = Math.floor(parsed / 1000);
    }
    const id = post.id != null ? String(post.id)
             : (post.idString || post.id_string || '');
    if (!id) return null;
    const blog = blogName || post.blogName || post.blog_name || (post.blog && post.blog.name) || 'unknown';
    const { norm, display } = extractTags(post);
    const images = extractImages(post);
    return {
      key: `${blog}:${id}`,
      blog,
      id,
      ts: ts || 0,
      tags: norm,
      tagsRaw: display,
      images,
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
      .tlc-head { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
      .tlc-head .tlc-spacer { flex: 1; }
      .tlc-btn {
        background: #1f2a37; color: #e8ecf1; border: 1px solid #ffffff26;
        border-radius: 8px; padding: 7px 12px; font: 600 13px system-ui, sans-serif; cursor: pointer;
      }
      .tlc-btn:hover { background: #273240; }
      .tlc-btn[disabled] { opacity: .5; cursor: default; }
      .tlc-btn.tlc-primary { background: #1f6b34; border-color: #2ea04366; }
      .tlc-btn.tlc-primary:hover { background: #24823f; }
      .tlc-sub { color: #9fb0c3; margin: 2px 0 14px; }

      /* tabs */
      .tlc-tabs { display: flex; gap: 6px; margin: 0 0 14px; border-bottom: 1px solid #ffffff14; }
      .tlc-tab {
        background: none; border: none; color: #9fb0c3; cursor: pointer;
        padding: 8px 12px; font: 600 14px system-ui, sans-serif;
        border-bottom: 2px solid transparent; margin-bottom: -1px;
      }
      .tlc-tab:hover { color: #e8ecf1; }
      .tlc-tab.tlc-active { color: #fff; border-bottom-color: #2ea043; }

      .tlc-controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 0 0 10px; }

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

      /* search results (likes list) */
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

      /* image grid (followed search) */
      .tlc-grid-imgs { display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr));
        gap: 8px; margin-top: 6px; }
      .tlc-gi { position: relative; display: block; aspect-ratio: 1 / 1; border-radius: 8px;
        overflow: hidden; background: #0d1319; border: 1px solid #ffffff14; }
      .tlc-gi img { width: 100%; height: 100%; object-fit: cover; display: block; }
      .tlc-gi .tlc-gi-blog { position: absolute; left: 0; right: 0; bottom: 0;
        background: linear-gradient(transparent, #000c); color: #fff; font-size: 11px;
        padding: 14px 6px 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .tlc-gi:hover { outline: 2px solid #2ea043; }

      /* blog list */
      .tlc-bloglist { margin-top: 6px; max-height: 420px; overflow: auto;
        border: 1px solid #ffffff14; border-radius: 8px; }
      .tlc-brow { display: flex; align-items: center; gap: 10px; padding: 7px 12px;
        border-top: 1px solid #ffffff10; }
      .tlc-brow:first-child { border-top: none; }
      .tlc-brow input[type=checkbox] { width: 16px; height: 16px; flex: none; }
      .tlc-bname { font-weight: 600; color: #e8ecf1; overflow: hidden; text-overflow: ellipsis;
        white-space: nowrap; flex: 1; min-width: 0; }
      .tlc-bstat { color: #8ea0b5; font-size: 12px; flex: none; }
      .tlc-bstat.tlc-done { color: #57e06e; }
      .tlc-blist-head { display: flex; align-items: center; gap: 10px; padding: 7px 12px;
        background: #0d1319; border-top-left-radius: 8px; border-top-right-radius: 8px;
        color: #9fb0c3; font-size: 12px; position: sticky; top: 0; }

      /* post-count table */
      .tlc-tablewrap { max-height: 440px; overflow: auto; border: 1px solid #ffffff14;
        border-radius: 8px; margin-top: 6px; }
      .tlc-table { width: 100%; border-collapse: collapse; font-size: 13px; }
      .tlc-table th { text-align: left; color: #9fb0c3; font-weight: 600; padding: 7px 10px;
        border-bottom: 1px solid #ffffff20; position: sticky; top: 0; background: #0d1319; }
      .tlc-table td { padding: 6px 10px; border-bottom: 1px solid #ffffff10; }
      .tlc-table tr:last-child td { border-bottom: none; }
      .tlc-table a { color: #7fb2ff; text-decoration: none; }
      .tlc-table a:hover { text-decoration: underline; }
      .tlc-num { text-align: right; font-variant-numeric: tabular-nums; }
      .tlc-sortable { cursor: pointer; user-select: none; }
      .tlc-sortable:hover { color: #e8ecf1; }

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
      .tlc-progress { color: #9fb0c3; padding: 10px 0; white-space: pre-wrap; }
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

  // apiFetch with simple exponential backoff (handles transient errors / 429-ish).
  async function apiGet(resource, tries = 4) {
    let delay = 900;
    for (let a = 0; a < tries; a++) {
      try {
        return await window.tumblr.apiFetch(resource);
      } catch (err) {
        if (a === tries - 1) throw err;
        await sleep(delay);
        delay *= 2;
      }
    }
  }

  // Likes full scan (unchanged behaviour).
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

    _distinctTags = null;
    await writeAll(records, meta);
    return meta;
  }

  // ---- followed blogs: fetching ------------------------------------------
  async function fetchFollowing(onProgress) {
    const blogs = [];
    const seen = new Set();
    let resource = `/v2/user/following?limit=20`;
    let total = null;
    while (resource) {
      const { response } = await apiGet(resource);
      if (response && response.totalBlogs != null) total = response.totalBlogs;
      const bs = (response && response.blogs) || [];
      for (const b of bs) {
        if (!b || !b.name || seen.has(b.name)) continue;
        seen.add(b.name);
        blogs.push({ name: b.name, title: b.title || b.name, url: b.url || '' });
      }
      if (onProgress) onProgress(blogs.length, total);
      resource = response && response.links && response.links.next && response.links.next.href;
      if (resource) await sleep(FOLLOW_PAGE_SLEEP_MS);
    }
    return blogs;
  }

  // Scan one blog's original image posts, resuming from saved state.
  // onPage({ blog, fetched, totalPosts, stored }) is called after each page.
  async function scanBlog(blog, onPage) {
    const name = blog.name;
    let state = await getScanState(name);
    let resource = (state && state.nextHref) ||
      `/v2/blog/${encodeURIComponent(name)}/posts?npf=true&limit=${BLOG_PAGE_LIMIT}`;
    let fetched = (state && state.fetched) || 0;
    let stored = (state && state.stored) || 0;
    let totalPosts = (state && state.totalPosts) || null;

    while (resource) {
      if (scanStopRequested) break;
      const { response } = await apiGet(resource);
      const posts = (response && response.posts) || [];
      if (response && response.totalPosts != null) totalPosts = response.totalPosts;

      const batch = [];
      for (const p of posts) {
        if (isReblog(p, name)) continue;        // originals only (0.3 scope)
        const rec = toFollowedRecord(p, name);
        if (!rec || !rec.images.length) continue; // images only (0.3 scope)
        batch.push(rec);
      }
      if (batch.length) { await putFollowed(batch); stored += batch.length; }
      fetched += posts.length;

      const next = response && response.links && response.links.next && response.links.next.href;
      await setScanState({
        blog: name, title: blog.title || name,
        nextHref: next || null, done: !next,
        fetched, stored, totalPosts, updatedAt: Date.now(),
      });
      if (onPage) onPage({ blog: name, fetched, totalPosts, stored });

      resource = next;
      if (resource) await sleep(BLOG_PAGE_SLEEP_MS);
    }
    _distinctFollowedTags = null; // invalidate suggestion cache
    return { done: !resource };
  }

  async function requestPersistentStorage() {
    try {
      if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
    } catch { /* ignore */ }
  }

  // ---- legacy localStorage (likes, first-run display) ---------------------
  function loadLegacyCache() {
    try {
      const raw = localStorage.getItem(LEGACY_CACHE_KEY);
      if (!raw) return null;
      const c = JSON.parse(raw);
      if (!c || !c.counts) return null;
      return c;
    } catch { return null; }
  }
  function clearLegacyCache() {
    try { localStorage.removeItem(LEGACY_CACHE_KEY); } catch { /* ignore */ }
  }

  // ---- calendar rendering (unchanged) ------------------------------------
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
        cell.addEventListener('click', () => { window.location.assign('/likes?before=' + before); });
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

  // ---- likes search rendering (unchanged) --------------------------------
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

  // ---- followed-blogs UI --------------------------------------------------
  function makeFollowedChip(tag) {
    const chip = document.createElement('span');
    chip.className = 'tlc-chip';
    chip.textContent = '#' + tag;
    chip.addEventListener('click', () => doFollowedSearch(tag));
    return chip;
  }

  function renderFollowedResults(matches) {
    const grid = document.createElement('div');
    grid.className = 'tlc-grid-imgs';
    const shown = matches.slice(0, FOLLOWED_RESULT_LIMIT);
    for (const rec of shown) {
      const a = document.createElement('a');
      a.className = 'tlc-gi';
      a.href = rec.postUrl;
      a.target = '_blank';
      a.rel = 'noopener';
      a.title = rec.blog + (rec.ts ? ' — ' + fmtDate(rec.ts) : '');
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = rec.images[0];
      img.alt = '';
      img.addEventListener('error', () => { a.style.display = 'none'; });
      const cap = document.createElement('span');
      cap.className = 'tlc-gi-blog';
      cap.textContent = rec.blog;
      a.append(img, cap);
      grid.appendChild(a);
    }
    return { grid, shownCount: shown.length };
  }

  async function doFollowedSearch(tag) {
    const q = normTag(tag);
    fSearchInput.value = tag;
    fBlogListBox.style.display = 'none';
    fResultsBox.style.display = 'block';
    fResultsBox.innerHTML = '';

    const bar = document.createElement('div');
    bar.className = 'tlc-search';
    const back = document.createElement('span');
    back.className = 'tlc-back';
    back.textContent = '← Back to blog list';
    back.addEventListener('click', showFollowedList);
    bar.appendChild(back);
    fResultsBox.appendChild(bar);

    if (!q) { showFollowedList(); return; }

    const header = document.createElement('div');
    header.className = 'tlc-sub';
    fResultsBox.appendChild(header);

    let matches = [];
    try {
      matches = await followedByTag(q);
    } catch (err) {
      header.className = 'tlc-err';
      header.textContent = 'Search error: ' + (err && err.message ? err.message : String(err));
      return;
    }

    header.textContent = matches.length
      ? `${matches.length} post${matches.length === 1 ? '' : 's'} tagged “${q}”`
      : `No followed-blog posts tagged “${q}”`;

    if (!matches.length) {
      try {
        const all = await distinctFollowedTags();
        const near = all.filter((t) => t.includes(q)).slice(0, 30);
        if (near.length) {
          const sug = document.createElement('div');
          sug.className = 'tlc-suggest';
          sug.textContent = 'Tags containing “' + q + '”:';
          fResultsBox.appendChild(sug);
          const chips = document.createElement('div');
          chips.className = 'tlc-chips';
          near.forEach((t) => chips.appendChild(makeFollowedChip(t)));
          fResultsBox.appendChild(chips);
        } else {
          const hint = document.createElement('div');
          hint.className = 'tlc-sub';
          hint.textContent = 'Nothing indexed yet for this tag. Download some blogs first (below), then search.';
          fResultsBox.appendChild(hint);
        }
      } catch { /* ignore */ }
      return;
    }

    const { grid, shownCount } = renderFollowedResults(matches);
    fResultsBox.appendChild(grid);
    if (matches.length > shownCount) {
      const more = document.createElement('div');
      more.className = 'tlc-sub';
      more.style.marginTop = '12px';
      more.textContent = `Showing the first ${shownCount} of ${matches.length}.`;
      fResultsBox.appendChild(more);
    }
  }

  function showFollowedList() {
    fResultsBox.style.display = 'none';
    fResultsBox.innerHTML = '';
    fBlogListBox.style.display = 'block';
  }

  async function refreshFollowStatus() {
    let n = 0;
    try { n = await countFollowed(); } catch { /* ignore */ }
    let scanned = 0;
    try {
      const states = await getAllScanState();
      scanned = states.filter((s) => s.fetched > 0).length;
    } catch { /* ignore */ }
    let size = '';
    try {
      const est = await navigator.storage.estimate();
      if (est && est.usage) size = ` · ~${(est.usage / 1048576).toFixed(0)} MB used`;
    } catch { /* ignore */ }
    const followedCount = followBlogs.length ? followBlogs.length : '—';
    fSub.textContent = `${followedCount} followed blogs · ${n} posts indexed`
      + (scanned ? ` from ${scanned} blog${scanned === 1 ? '' : 's'}` : '') + size;
  }

  async function renderBlogList() {
    let states = [];
    try { states = await getAllScanState(); } catch { /* ignore */ }
    const byName = Object.create(null);
    for (const s of states) byName[s.blog] = s;

    fBlogListBox.innerHTML = '';

    if (!followBlogs.length) {
      const hint = document.createElement('div');
      hint.className = 'tlc-empty';
      hint.textContent = 'Press “Load following” to list the blogs you follow, then download the ones you want.';
      fBlogListBox.appendChild(hint);
      return;
    }

    const head = document.createElement('div');
    head.className = 'tlc-blist-head';
    const selAll = document.createElement('input');
    selAll.type = 'checkbox';
    selAll.addEventListener('change', () => {
      fBlogListBox.querySelectorAll('input.tlc-bcheck').forEach((c) => { c.checked = selAll.checked; });
    });
    const headLabel = document.createElement('span');
    headLabel.style.flex = '1';
    headLabel.textContent = `${followBlogs.length} blogs — tick the ones to download, or use “Download all”.`;
    head.append(selAll, headLabel);
    fBlogListBox.appendChild(head);

    for (const b of followBlogs) {
      const row = document.createElement('div');
      row.className = 'tlc-brow';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'tlc-bcheck';
      cb.value = b.name;
      const name = document.createElement('span');
      name.className = 'tlc-bname';
      name.textContent = b.name;
      const stat = document.createElement('span');
      stat.className = 'tlc-bstat';
      const st = byName[b.name];
      if (st) {
        const tot = st.totalPosts != null ? ('/' + st.totalPosts) : '';
        stat.textContent = `${st.stored || 0} imgs · ${st.fetched || 0}${tot} scanned`;
        if (st.done) { stat.textContent += ' ✓'; stat.classList.add('tlc-done'); }
      } else {
        stat.textContent = 'not downloaded';
      }
      row.append(cb, name, stat);
      fBlogListBox.appendChild(row);
    }
  }

  function selectedBlogNames() {
    const out = [];
    fBlogListBox.querySelectorAll('input.tlc-bcheck:checked').forEach((c) => out.push(c.value));
    return out;
  }

  function setScanButtonsState() {
    const hasBlogs = followBlogs.length > 0;
    fLoadBtn.disabled = scanRunning;
    fCountBtn.disabled = scanRunning;
    fScanAllBtn.disabled = scanRunning || !hasBlogs;
    fScanSelBtn.disabled = scanRunning || !hasBlogs;
    fStopBtn.disabled = !scanRunning;
  }

  async function loadFollowing() {
    fProgress.textContent = 'Loading the list of blogs you follow…';
    try {
      followBlogs = await fetchFollowing((n, total) => {
        fProgress.textContent = `Found ${n}${total ? '/' + total : ''} followed blogs…`;
      });
      followLoaded = true;
      fProgress.textContent = `${followBlogs.length} followed blogs.`;
    } catch (err) {
      fProgress.className = 'tlc-err';
      fProgress.textContent = 'Could not load your following list: ' + (err && err.message ? err.message : String(err));
      return;
    }
    await renderBlogList();
    await refreshFollowStatus();
    setScanButtonsState();
  }

  async function runScan(names) {
    if (scanRunning) return;
    scanRunning = true;
    scanStopRequested = false;
    setScanButtonsState();
    fProgress.className = 'tlc-progress';
    await requestPersistentStorage();

    const list = (names && names.length) ? names : followBlogs.map((b) => b.name);
    const total = list.length;
    let i = 0;
    for (const name of list) {
      if (scanStopRequested) break;
      i += 1;
      const blog = followBlogs.find((b) => b.name === name) || { name, title: name };
      fProgress.textContent = `Blog ${i}/${total}: ${name}…`;
      try {
        await scanBlog(blog, (p) => {
          const tot = p.totalPosts != null ? ('/' + p.totalPosts) : '';
          fProgress.textContent = `Blog ${i}/${total}: ${name} — ${p.fetched}${tot} scanned, ${p.stored} images kept`;
        });
      } catch (err) {
        fProgress.textContent = `Error on ${name}: ${err && err.message ? err.message : String(err)} — moving on…`;
        await sleep(1200);
      }
      await renderBlogList();
      await refreshFollowStatus();
    }

    scanRunning = false;
    fProgress.textContent = scanStopRequested
      ? 'Scan stopped. It will resume where it left off next time.'
      : 'Scan complete.';
    setScanButtonsState();
    await refreshFollowStatus();
  }

  // Count total posts per followed blog (one light call each, reads totalPosts)
  // without downloading them. Lets you size up a scan before launching it.
  async function countPostsPerBlog() {
    if (scanRunning) return;
    if (!followBlogs.length) {
      await loadFollowing();
      if (!followBlogs.length) return;
    }
    scanRunning = true;
    scanStopRequested = false;
    setScanButtonsState();
    fBlogListBox.style.display = 'none';
    fResultsBox.style.display = 'block';
    fResultsBox.innerHTML = '';
    fProgress.className = 'tlc-progress';

    const rows = [];
    const total = followBlogs.length;
    let i = 0;
    for (const b of followBlogs) {
      if (scanStopRequested) break;
      i += 1;
      fProgress.textContent = `Counting ${i}/${total}: ${b.name}…`;
      try {
        const { response } = await apiGet(`/v2/blog/${encodeURIComponent(b.name)}/posts?limit=1`);
        const n = response ? (response.totalPosts ?? response.total_posts) : null;
        rows.push({ blog: b.name, posts: (n == null ? null : n) });
      } catch {
        rows.push({ blog: b.name, posts: null });
      }
      await sleep(150);
    }

    scanRunning = false;
    setScanButtonsState();
    fProgress.textContent = scanStopRequested
      ? `Count stopped (${rows.length}/${total} blogs).`
      : 'Count complete.';
    renderCountTable(rows);
  }

  function renderCountTable(rows) {
    fResultsBox.innerHTML = '';

    const bar = document.createElement('div');
    bar.className = 'tlc-search';
    const back = document.createElement('span');
    back.className = 'tlc-back';
    back.textContent = '← Back to blog list';
    back.addEventListener('click', showFollowedList);
    bar.appendChild(back);
    fResultsBox.appendChild(bar);

    let sortKey = 'posts', sortDir = -1;

    const wrap = document.createElement('div');
    wrap.className = 'tlc-tablewrap';
    const table = document.createElement('table');
    table.className = 'tlc-table';

    const thead = document.createElement('thead');
    const htr = document.createElement('tr');
    const h0 = document.createElement('th');
    h0.textContent = '#';
    const h1 = document.createElement('th');
    h1.textContent = 'Blog';
    h1.className = 'tlc-sortable';
    h1.addEventListener('click', () => { sortDir = (sortKey === 'blog') ? -sortDir : 1; sortKey = 'blog'; draw(); });
    const h2 = document.createElement('th');
    h2.textContent = 'Posts';
    h2.className = 'tlc-sortable tlc-num';
    h2.addEventListener('click', () => { sortDir = (sortKey === 'posts') ? -sortDir : -1; sortKey = 'posts'; draw(); });
    htr.append(h0, h1, h2);
    thead.appendChild(htr);

    const tbody = document.createElement('tbody');
    table.append(thead, tbody);
    wrap.appendChild(table);
    fResultsBox.appendChild(wrap);

    function draw() {
      const sorted = rows.slice().sort((a, b) => {
        if (sortKey === 'blog') return sortDir * a.blog.localeCompare(b.blog);
        return sortDir * ((a.posts || 0) - (b.posts || 0));
      });
      tbody.innerHTML = '';
      sorted.forEach((r, idx) => {
        const tr = document.createElement('tr');
        const td0 = document.createElement('td');
        td0.textContent = String(idx + 1);
        const td1 = document.createElement('td');
        const a = document.createElement('a');
        a.href = 'https://' + r.blog + '.tumblr.com';
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = r.blog;
        td1.appendChild(a);
        const td2 = document.createElement('td');
        td2.className = 'tlc-num';
        td2.textContent = (r.posts == null) ? '—' : r.posts.toLocaleString();
        tr.append(td0, td1, td2);
        tbody.appendChild(tr);
      });
    }
    draw();

    const totalPosts = rows.reduce((s, r) => s + (r.posts || 0), 0);
    const missing = rows.filter((r) => r.posts == null).length;
    const foot = document.createElement('div');
    foot.className = 'tlc-sub';
    foot.style.marginTop = '10px';
    foot.textContent =
      `Total: ${totalPosts.toLocaleString()} posts across ${rows.length} blogs`
      + (missing ? ` (${missing} unavailable)` : '')
      + ' — all post types. Rough DB ceiling ≈ '
      + `${(totalPosts / 1024).toFixed(1)} MB; the real size will be smaller (images-only).`;
    fResultsBox.appendChild(foot);
  }

  // ---- panel / UI ---------------------------------------------------------
  let overlay, panelTitle;
  // calendar view elements
  let calBox, chipsBox, resultsBox, subEl, refreshBtn, searchInput, calRoot;
  // followed view elements
  let followedRoot, fSub, fProgress, fSearchInput, fResultsBox, fBlogListBox,
      fLoadBtn, fCountBtn, fScanAllBtn, fScanSelBtn, fStopBtn;
  let tabCalBtn, tabFollowBtn;

  let showingSearch = false;
  let currentMeta = null;
  let viewMode = 'calendar';
  // followed state
  let followBlogs = [];
  let followLoaded = false;
  let scanRunning = false;
  let scanStopRequested = false;

  function showView(mode) {
    viewMode = mode;
    const cal = mode === 'calendar';
    calRoot.style.display = cal ? 'block' : 'none';
    followedRoot.style.display = cal ? 'none' : 'block';
    tabCalBtn.classList.toggle('tlc-active', cal);
    tabFollowBtn.classList.toggle('tlc-active', !cal);
    panelTitle.textContent = cal ? 'Your likes calendar' : 'Followed blogs';
    if (!cal && !followLoaded && !scanRunning) {
      // auto-load the (cheap) following list the first time
      loadFollowing();
    }
  }

  function buildCalendarView() {
    calRoot = document.createElement('div');

    const controls = document.createElement('div');
    controls.className = 'tlc-controls';
    refreshBtn = document.createElement('button');
    refreshBtn.className = 'tlc-btn';
    refreshBtn.textContent = 'Refresh likes';
    refreshBtn.addEventListener('click', runFetch);
    controls.appendChild(refreshBtn);
    subEl = document.createElement('div');
    subEl.className = 'tlc-sub';
    subEl.style.margin = '0';
    controls.appendChild(subEl);

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

    calRoot.append(controls, search, chipsBox, resultsBox, calBox);
    return calRoot;
  }

  function buildFollowedView() {
    followedRoot = document.createElement('div');
    followedRoot.style.display = 'none';

    fSub = document.createElement('div');
    fSub.className = 'tlc-sub';
    fSub.style.margin = '0 0 8px';

    const controls = document.createElement('div');
    controls.className = 'tlc-controls';
    fLoadBtn = document.createElement('button');
    fLoadBtn.className = 'tlc-btn';
    fLoadBtn.textContent = 'Load following';
    fLoadBtn.addEventListener('click', loadFollowing);
    fCountBtn = document.createElement('button');
    fCountBtn.className = 'tlc-btn';
    fCountBtn.textContent = 'Count posts';
    fCountBtn.title = 'Count how many posts each followed blog has, before downloading';
    fCountBtn.addEventListener('click', countPostsPerBlog);
    fScanAllBtn = document.createElement('button');
    fScanAllBtn.className = 'tlc-btn tlc-primary';
    fScanAllBtn.textContent = 'Download all';
    fScanAllBtn.addEventListener('click', () => runScan(null));
    fScanSelBtn = document.createElement('button');
    fScanSelBtn.className = 'tlc-btn';
    fScanSelBtn.textContent = 'Download selected';
    fScanSelBtn.addEventListener('click', () => {
      const sel = selectedBlogNames();
      if (!sel.length) { fProgress.textContent = 'Tick at least one blog first.'; return; }
      runScan(sel);
    });
    fStopBtn = document.createElement('button');
    fStopBtn.className = 'tlc-btn';
    fStopBtn.textContent = 'Stop';
    fStopBtn.addEventListener('click', () => { scanStopRequested = true; fProgress.textContent = 'Stopping…'; });
    controls.append(fLoadBtn, fCountBtn, fScanAllBtn, fScanSelBtn, fStopBtn);

    fProgress = document.createElement('div');
    fProgress.className = 'tlc-progress';

    const search = document.createElement('div');
    search.className = 'tlc-search';
    fSearchInput = document.createElement('input');
    fSearchInput.type = 'search';
    fSearchInput.placeholder = 'Search downloaded posts by tag…';
    fSearchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); doFollowedSearch(fSearchInput.value); }
    });
    const searchBtn = document.createElement('button');
    searchBtn.className = 'tlc-btn';
    searchBtn.textContent = 'Search';
    searchBtn.addEventListener('click', () => doFollowedSearch(fSearchInput.value));
    search.append(fSearchInput, searchBtn);

    fResultsBox = document.createElement('div');
    fResultsBox.style.display = 'none';
    fBlogListBox = document.createElement('div');
    fBlogListBox.className = 'tlc-bloglist';

    followedRoot.append(fSub, controls, fProgress, search, fResultsBox, fBlogListBox);
    return followedRoot;
  }

  function buildPanel() {
    injectStyles();

    overlay = document.createElement('div');
    overlay.id = 'tlc-overlay';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closePanel(); });

    const panel = document.createElement('div');
    panel.id = 'tlc-panel';

    const head = document.createElement('div');
    head.className = 'tlc-head';
    panelTitle = document.createElement('h2');
    panelTitle.textContent = 'Your likes calendar';
    const spacer = document.createElement('div');
    spacer.className = 'tlc-spacer';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'tlc-btn';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', closePanel);
    head.append(panelTitle, spacer, closeBtn);

    const tabs = document.createElement('div');
    tabs.className = 'tlc-tabs';
    tabCalBtn = document.createElement('button');
    tabCalBtn.className = 'tlc-tab tlc-active';
    tabCalBtn.textContent = '📅 Calendar';
    tabCalBtn.addEventListener('click', () => showView('calendar'));
    tabFollowBtn = document.createElement('button');
    tabFollowBtn.className = 'tlc-tab';
    tabFollowBtn.textContent = '👥 Followed blogs';
    tabFollowBtn.addEventListener('click', () => showView('followed'));
    tabs.append(tabCalBtn, tabFollowBtn);

    const calView = buildCalendarView();
    const followView = buildFollowedView();

    panel.append(head, tabs, calView, followView);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
  }

  async function openPanel() {
    if (!overlay) buildPanel();
    overlay.classList.add('tlc-open');
    showView('calendar');
    showCalendar();

    let meta = null;
    try { meta = await getMeta(); } catch { /* ignore */ }
    currentMeta = meta;

    if (meta && meta.total) {
      subEl.textContent = describeMeta(meta);
      renderTopTags(meta);
      renderCalendar(calBox, meta);
    } else {
      const legacy = loadLegacyCache();
      if (legacy && legacy.total) {
        subEl.textContent = 'Upgraded — press “Refresh likes” once to enable tag search '
          + '(your old calendar is shown below in the meantime).';
        renderTopTags(null);
        renderCalendar(calBox, legacy);
      } else {
        subEl.textContent = 'First run: press “Refresh likes” to download your likes.';
        renderTopTags(null);
        renderCalendar(calBox, null);
      }
    }

    // Prime the followed status line (cheap counts) without loading the list.
    try { await refreshFollowStatus(); } catch { /* ignore */ }
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
