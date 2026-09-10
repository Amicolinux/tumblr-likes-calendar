/*
 * Tumblr Likes Calendar
 * ---------------------
 * Runs in the MAIN world (page context) so it can use window.tumblr.apiFetch,
 * the authenticated fetch helper Tumblr exposes to extensions. No API key,
 * no OAuth: it piggybacks on your logged-in session.
 *
 * Data flow:
 *   /v2/user/likes  ->  response.likedPosts[].likedTimestamp (Unix seconds)
 *   follow response.links.next.href until it runs out.
 * We bucket those timestamps per day and draw a GitHub-style heatmap.
 * Clicking a day navigates to /likes?before=<end-of-that-day> so the list
 * opens at that date.
 */
(function () {
  'use strict';

  if (window.__tumblrLikesCalendarLoaded) return;
  window.__tumblrLikesCalendarLoaded = true;

  const CACHE_KEY = 'tlc:cache:v1';
  const PAGE_LIMIT = 50;          // likes per API page (Tumblr max for this endpoint)
  const PAGE_SLEEP_MS = 180;      // gentle pause between pages
  const DOW = ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'];
  const MONTHS = ['Gen', 'Feb', 'Mar', 'Apr', 'Mag', 'Giu', 'Lug', 'Ago', 'Set', 'Ott', 'Nov', 'Dic'];

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pad = (n) => String(n).padStart(2, '0');
  const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

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
      .tlc-sub { color: #9fb0c3; margin: 2px 0 16px; }
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

  async function gatherLikes(onProgress) {
    const counts = Object.create(null);
    let total = 0;
    let minTs = Infinity;
    let maxTs = -Infinity;
    let resource = `/v2/user/likes?limit=${PAGE_LIMIT}`;

    while (resource) {
      const { response } = await window.tumblr.apiFetch(resource);
      const posts = (response && response.likedPosts) || [];
      for (const p of posts) {
        const ts = p.likedTimestamp ?? p.liked_timestamp;
        if (!ts) continue;
        const d = new Date(ts * 1000);
        const key = dayKey(d);
        counts[key] = (counts[key] || 0) + 1;
        total += 1;
        if (ts < minTs) minTs = ts;
        if (ts > maxTs) maxTs = ts;
      }
      if (onProgress) onProgress(total);
      resource = response && response.links && response.links.next && response.links.next.href;
      if (resource) await sleep(PAGE_SLEEP_MS);
    }

    return {
      counts,
      total,
      minTs: isFinite(minTs) ? minTs : null,
      maxTs: isFinite(maxTs) ? maxTs : null,
      cachedAt: Date.now(),
    };
  }

  function loadCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY)); } catch { return null; }
  }
  function saveCache(data) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch { /* ignore quota */ }
  }

  // ---- rendering ----------------------------------------------------------
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

    // month labels
    const months = document.createElement('div');
    months.className = 'tlc-months';

    const row = document.createElement('div');
    row.className = 'tlc-row';

    const dows = document.createElement('div');
    dows.className = 'tlc-dows';
    // show Mon/Wed/Fri to reduce clutter
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
      const weekday = d.getDay();               // 0..6 (Sun..Sat)
      const dayOfYear = Math.floor((d - start) / 86400000);
      const col = Math.floor((dayOfYear + start.getDay()) / 7);

      const key = dayKey(d);
      const c = counts[key] || 0;
      const cell = document.createElement('div');
      cell.className = 'tlc-cell l' + levelFor(c, maxDaily);
      cell.style.gridRow = (weekday + 1);
      cell.style.gridColumn = (col + 1 - firstCol);
      cell.title = `${key} \u2014 ${c} like`;
      if (key <= todayKey) {
        cell.addEventListener('click', () => {
          const endOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0);
          const before = Math.floor(endOfDay.getTime() / 1000);
          window.location.assign('/likes?before=' + before);
        });
      } else {
        cell.style.visibility = 'hidden';
      }
      grid.appendChild(cell);

      // month label at the first day of each month
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

    if (!data || !data.total) {
      const e = document.createElement('div');
      e.className = 'tlc-empty';
      e.textContent = 'Nessun like trovato (o non ancora caricati). Premi \u201cAggiorna\u201d.';
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
    legend.appendChild(document.createTextNode('Meno'));
    for (let l = 0; l <= 4; l++) {
      const c = document.createElement('div');
      c.className = 'tlc-cell l' + l;
      legend.appendChild(c);
    }
    legend.appendChild(document.createTextNode('Pi\u00f9'));
    container.appendChild(legend);
  }

  // ---- panel / UI ---------------------------------------------------------
  let overlay, calBox, subEl, refreshBtn;

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
    h2.textContent = 'Calendario dei tuoi like';
    const spacer = document.createElement('div');
    spacer.className = 'tlc-spacer';
    refreshBtn = document.createElement('button');
    refreshBtn.className = 'tlc-btn';
    refreshBtn.textContent = 'Aggiorna';
    refreshBtn.addEventListener('click', runFetch);
    const closeBtn = document.createElement('button');
    closeBtn.className = 'tlc-btn';
    closeBtn.textContent = 'Chiudi';
    closeBtn.addEventListener('click', closePanel);
    head.append(h2, spacer, refreshBtn, closeBtn);

    subEl = document.createElement('div');
    subEl.className = 'tlc-sub';
    subEl.textContent = '';

    calBox = document.createElement('div');

    panel.append(head, subEl, calBox);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
  }

  function openPanel() {
    if (!overlay) buildPanel();
    overlay.classList.add('tlc-open');
    const cache = loadCache();
    if (cache) {
      subEl.textContent = describeCache(cache);
      renderCalendar(calBox, cache);
    } else {
      subEl.textContent = 'Primo avvio: premi \u201cAggiorna\u201d per scaricare i tuoi like.';
      renderCalendar(calBox, null);
    }
  }
  function closePanel() { if (overlay) overlay.classList.remove('tlc-open'); }

  function describeCache(cache) {
    const when = new Date(cache.cachedAt).toLocaleString('it-IT');
    return `${cache.total} like totali \u00b7 dati aggiornati al ${when} \u00b7 clicca un giorno per aprire i like di quella data`;
  }

  async function runFetch() {
    refreshBtn.disabled = true;
    calBox.innerHTML = '';
    const prog = document.createElement('div');
    prog.className = 'tlc-progress';
    prog.textContent = 'Attendo l\u2019API di Tumblr\u2026';
    calBox.appendChild(prog);

    const ok = await waitForApi();
    if (!ok) {
      prog.className = 'tlc-err';
      prog.textContent = 'window.tumblr.apiFetch non disponibile. Assicurati di essere loggato su Tumblr e ricarica la pagina.';
      refreshBtn.disabled = false;
      return;
    }

    try {
      const data = await gatherLikes((n) => { prog.textContent = `Trovati ${n} like\u2026`; });
      saveCache(data);
      subEl.textContent = describeCache(data);
      renderCalendar(calBox, data);
    } catch (err) {
      prog.className = 'tlc-err';
      prog.textContent = 'Errore durante il recupero dei like:\n' + (err && err.message ? err.message : String(err));
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
        launcher.textContent = '\uD83D\uDCC5 Calendario like';
        launcher.addEventListener('click', openPanel);
        document.body.appendChild(launcher);
      }
    } else if (launcher) {
      launcher.remove();
      closePanel();
    }
  }

  // Tumblr is a single-page app: watch for soft navigations.
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
