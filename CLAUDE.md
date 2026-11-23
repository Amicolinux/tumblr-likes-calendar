# CLAUDE.md — Tumblr Likes Calendar

Convenzioni e **trappole già incontrate** per questo repository: la sezione più
importante è "Trappole da NON reintrodurre", che evita di rifare bug noti.

## Cos'è

Estensione browser (**Firefox + Chrome**, Manifest V3) che, sopra i *like*
dell'utente su Tumblr, offre: un **calendario heatmap** stile GitHub (per data di
like), **ricerca per tag** e **per blog** (`blog:nome`), una **galleria**
virtualizzata delle immagini, e una scheda **"Blog seguiti"** che indicizza i
post-immagine originali dei blog seguiti (scan selettivo e riprendibile).
Un solo file JS, nessuna build necessaria per far girare l'estensione.

## Architettura

- **Content script in `world: "MAIN"`** (contesto pagina), su `*://www.tumblr.com/*`.
- **Nessuna API key / OAuth**: usa la sessione loggata via `window.tumblr.apiFetch`.
  Se l'utente non è loggato o Tumblr toglie `apiFetch`, mostra un messaggio — mai
  crashare.
- Tutto in **una IIFE** dentro `likes-calendar.js`; guardia anti-doppio-caricamento
  `window.__tumblrLikesCalendarLoaded`.
- UI iniettata: `#tlc-launcher`, pannello `#tlc-panel`, overlay `#tlc-overlay`,
  stili `#tlc-styles`; prefisso classi/id `tlc-`.

## Struttura file

```
manifest.json      # UNICO manifest (Firefox: ha browser_specific_settings.gecko)
likes-calendar.js  # tutta la logica (IIFE unica)
icons/             # 16/32/48/96/128
build.sh           # packaging -> dist/firefox.zip , dist/chrome.zip
tests/e2e.cjs      # test end-to-end (Playwright)
README.md  PRIVACY.md  LICENSE (GPLv3)   .github/ (FUNDING + ISSUE_TEMPLATE)
```

**Esiste un solo `manifest.json` (Firefox).** La versione Chrome si genera al
momento del packaging rimuovendo `browser_specific_settings`: **non creare un
secondo manifest nel repo.** `likes-calendar.js` e `icons/` restano identici tra
le due varianti.

## Build & pacchettizzazione

Per rilasciare una versione:

1. Bump **`version`** in `manifest.json` + aggiorna il commento "What's new" in
   testa a `likes-calendar.js`.
2. `./build.sh` → `dist/firefox.zip` e `dist/chrome.zip`.

Niente bundler, niente minificazione (AMO/Chrome vogliono sorgente leggibile).

## Modello dati (IndexedDB)

DB `TumblrLikesCalendar`, **`DB_VERSION = 2`**.

| Store       | keyPath | Indici                              | Contenuto                         |
|-------------|---------|-------------------------------------|-----------------------------------|
| `posts`     | `key`   | `tags` (multiEntry), `ts`, `blog`   | i like                            |
| `followed`  | `key`   | `tags` (multiEntry), `ts`, `blog`   | post dei blog seguiti             |
| `meta`      | `id`    | —                                   | riepiloghi (like + seguiti)       |
| `scanState` | `blog`  | —                                   | avanzamento scan per-blog (resume)|

- **`key` = `"blog:id"`** (dedup stabile). `ts` = *liked timestamp* (secondi).
- `tags` normalizzato lowercase per l'indice; `tagsRaw` conservato per la UI.
- **Cambi di schema** (nuovo store/indice): incrementa `DB_VERSION` + migrazione in
  `onupgradeneeded` (crea solo se `!contains`). Non rinominare `key`.

**Parsing NPF (scelta non ovvia):** immagini dai blocchi `content[]` di tipo
`image` (`media[].url`, larghezza maggiore) con fallback legacy
`photos[].original_size.url`; scarta reblog/non-immagine dove previsto. Gli
endpoint usati (`/v2/user/likes`, `/v2/user/following`, `/v2/blog/{blog}/posts`)
si leggono nel codice; tutti paginano con `response.links.next.href`.

## Trappole da NON reintrodurre (lezioni già pagate)

1. **Calendario e ora legale (DST).** Il giorno dell'anno si conta con
   `Date.UTC(y,m,d)` — **mai** `(d - start)/86400000` (ai cambi d'ora un giorno
   dura 23/25 h → celle disallineate/sovrapposte; la cella "19 ott" finiva su un
   altro giorno). Il giorno settimana viene da `d.getDay()`; deve valere sempre
   `weekday === (dayOfYear + startDay) % 7`.
2. **Bucket per giorno LOCALE.** `dayKey` e `postsByDay` usano la data locale.
   Heatmap, conteggi e vista-giorno devono restare coerenti sullo stesso fuso.
3. **Non "saltare a una data" via URL Tumblr.** Né `/likes?before=<ts>` né
   `/likes?after=<ts>` si fissano su un giorno: Tumblr impagina dal più recente
   in giù e, finito il caricamento, la sua app reimpagina → arrivi a un giorno
   successivo (collaudo 0.4.1: `?after=` del 19 ott → mostrato il 24 ott). Il
   clic sul giorno mostra i like **nel pannello** (da IndexedDB). Niente
   `location.assign`/`location.href`/`window.open` né link `<a>` verso
   `/likes?before=` o `/likes?after=` (lo verifica `tests/e2e.cjs`).
4. **~11k like: niente cursori riga-per-riga.** `openCursor`/`openKeyCursor` con
   `continue()` sparano decine di migliaia di eventi e **congelano il tab**. Usa
   **`getAll()` / `getAllKeys()`** (un round-trip) e itera in memoria.
5. **URL esterni: filtra ma accetta i protocol-relative.** Prima di `img.src`/
   `href`, valida con `/^(https?:)?\/\//i`: blocca `javascript:`/`data:` ma
   **accetta `//host/...`** (una regex più stretta scarterebbe URL Tumblr con `//`).
6. **Nomi blog case-sensitive.** L'indice `blog` distingue maiuscole/minuscole
   (la UI avvisa). Non normalizzare i nomi blog a lowercase (romperesti `key`).
7. **Galleria virtualizzata.** Disegna **solo le righe visibili** (windowing +
   pool + overscan, scroll su `requestAnimationFrame`) su una proiezione *slim*
   `{img, blog, ts, url}`. Non renderizzare migliaia di `<img>` insieme. Le liste
   tag/blog/giorno invece hanno cap `SEARCH_RESULT_LIMIT = 300` (non virtualizzate).
8. **`writeAll`.** Fa `clear()` + `put` di tutti i record in una transazione: se
   interrotta perdi i like fino al prossimo scan riuscito. Toccala con cautela
   (eventuale scrittura a blocchi).
9. **Scan API resiliente.** Le pagine dello scan passano da `apiGet` (retry +
   backoff), non da `apiFetch` diretto (un 429 aborterebbe tutto). `apiGet` **non**
   deve ritentare 401/403 (sessione scaduta).

## Convenzioni di codice

- Vanilla JS, zero dipendenze a runtime, un solo file. Niente framework/build step.
- UI con `createElement` + `textContent` (mai `innerHTML` con dati Tumblr). Link
  esterni: `target="_blank"` + `rel="noopener"`.
- **Parità Firefox/Chrome:** modifica il JS una volta; differisce solo il manifest
  (gestito da `build.sh`).
- Permessi minimi: `content_scripts` su `*://www.tumblr.com/*`, nessun permesso
  extra, `data_collection_permissions: none`. Niente permessi senza motivo reale.

## Test

```
npm i -D playwright && npx playwright install chromium   # una tantum
npm test                                   # = node tests/e2e.cjs
TLC_TODAY=2027-01-10 npm test              # simula un altro "oggi"
```

Inietta il file nel world MAIN, stubba `window.tumblr.apiFetch` (like, e
opzionalmente following + post dei blog) e la pagina `/likes`. Gruppi:

- **A** clic sul giorno (solo quel giorno, nessuna navigazione), galleria virtualizzata, filtri tag/`blog:`.
- **B** nessuna collisione di celle su Rome/New_York/Tokyo (DST).
- **C** 15k like: galleria e suggerimenti tag senza `IDBCursor.continue` (trappola #4).
- **D** URL `javascript:`/`data:` mai in `href`/`src`, `//host` accettati, nomi blog non validi senza link (trappola #5).
- **E** ricerche rapide in sequenza (giorno/blog/tag, scheda seguiti, Count posts): solo l'ultima mostra risultati.
- **F** filtri galleria rapidi in sequenza: nota e griglia del filtro più recente.
- **G** pulsanti Heatmap/Gallery, `blog:` senza nome, clic su tag mostrato.

Helper: `installSlowGetAll(page)` rende lenta la prossima `getAll()` (gare
deterministiche); `TLC_TODAY` fissa la data. Sintassi: `node --check likes-calendar.js`.

## Versioni / roadmap

- Repo pubblico `github.com/Amicolinux/tumblr-likes-calendar` (org Amicolinux,
  commit da `daltanious78`), GPLv3; su Firefox AMO + Chrome Web Store.
- Questo file descrive la **0.4.1**: committalo **insieme** alla 0.4.1, non prima
  (il repo pubblico è alla 0.3.0).
- La **roadmap delle feature è privata**: non annunciarla nei post pubblici.
