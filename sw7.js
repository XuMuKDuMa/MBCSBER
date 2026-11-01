// Service Worker для МВС отчёты — v5.3 (файл sw7.js: новое имя, чтобы оболочка APK не подсовывала старый sw.js из своего кэша)
// Главное отличие от v4: страница отдаётся ИЗ КЭША СРАЗУ, а свежая версия докачивается фоном.
// Раньше воркер ждал, пока из сети скачается весь HTML (до 3 с) — отсюда белый экран при включённом интернете.

const CACHE_NAME = 'mvs-reports-v5';   // v5: страница из кэша сразу + обновление в фоне
const LOG_CACHE = 'mvs-log';           // журнал работы воркера (читается в «Диагностике запуска»)
const TILE_CACHE = 'mvs-tiles-v1';     // плитки карты (последние MAX_TILES)
const LIB_CACHE = 'mvs-lib-v1';        // библиотека Leaflet (версия зафиксирована в адресе)
const MAX_TILES = 400;
const NETWORK_TIMEOUT = 3000;          // мс: для прочих локальных файлов (не страницы)
const APP_SHELL = [
  './',
  './index.html'
];
// Свои файлы Leaflet (кладём рядом с приложением в папку leaflet/). Если их там нет — ничего страшного, будет CDN.
const LEAFLET_LOCAL = ['./leaflet/leaflet.js', './leaflet/leaflet.css'];

// ── Журнал: последние 25 событий ──
async function swLog(ev) {
  try {
    ev.t = Date.now();
    const c = await caches.open(LOG_CACHE);
    let arr = [];
    const m = await c.match('/__swlog.json');
    if (m) arr = await m.json();
    arr.push(ev);
    while (arr.length > 25) arr.shift();
    await c.put('/__swlog.json', new Response(JSON.stringify(arr), { headers: { 'Content-Type': 'application/json' } }));
  } catch (e) { /* не критично */ }
}

function isCompleteHtml(txt) {
  return txt.length > 20000 && /<\/html>\s*$/i.test(txt.trim());
}

// ── Установка: кладём в кэш HTML приложения (в обход HTTP-кэша оболочки APK) ──
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(CACHE_NAME);
      for (const u of APP_SHELL) {
        try {
          const res = await fetch(new Request(u, { cache: 'reload' }));
          if (res && res.status === 200 && isCompleteHtml(await res.clone().text())) await cache.put(u, res);
        } catch (e) { /* не валим установку */ }
      }
      // Leaflet: кладём в кэш заранее, чтобы карта открывалась и без интернета. Не нашли файл — не страшно.
      for (const u of LEAFLET_LOCAL) {
        try {
          const res = await fetch(new Request(u, { cache: 'reload' }));
          const ct = (res.headers.get('content-type') || '');
          if (res && res.status === 200 && !/text\/html/i.test(ct)) await cache.put(u, res);
        } catch (e) { /* нет файла или сети */ }
      }
    } catch (e) {}
  })());
  self.skipWaiting();
});

// ── Активация: подчищаем старые версии кэша (журнал, карту и библиотеку оставляем) ──
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => ![CACHE_NAME, LOG_CACHE, TILE_CACHE, LIB_CACHE].includes(k)).map((k) => caches.delete(k))
      )
    ).then(() => swLog({ how: 'activate', v: CACHE_NAME }))
  );
  self.clients.claim();
});

// ── Эти домены по-прежнему всегда идут напрямую в сеть (геокодер, IP-сервисы, маршруты) ──
const NEVER_CACHE_HOSTS = [
  'nominatim.openstreetmap.org',
  'photon.komoot.io',
  'ipapi.co',
  'ipwho.is',
  'ipinfo.io',
  'country.is',
  'geojs.io',
  'api.ip.sb',
  'router.project-osrm.org'
];

function isTile(u) {
  return u.hostname === 'tile.openstreetmap.org' || /^[abc]\.tile\.openstreetmap\.org$/.test(u.hostname);
}
function isLeafletLib(u) {
  return (u.hostname === 'cdn.jsdelivr.net' && u.pathname.indexOf('/npm/leaflet@') === 0) ||
         (u.hostname === 'unpkg.com' && u.pathname.indexOf('/leaflet@') === 0);
}

// Кладём в кэш только нормальный ответ: код 200, а для HTML — целую страницу (с закрывающим </html>).
async function putIfValid(req, res) {
  try {
    if (!res || res.status !== 200) return;
    const ct = (res.headers && res.headers.get('content-type')) || '';
    if (/text\/html/i.test(ct) || req.mode === 'navigate') {
      const txt = await res.clone().text();
      if (!isCompleteHtml(txt)) return;
    }
    const cache = await caches.open(CACHE_NAME);
    await cache.put(req, res);
  } catch (e) { /* не критично */ }
}

// Загрузка страницы приложения с проверкой целостности.
async function fetchNav(req) {
  const res = await fetch(req);
  // редирект (GitHub добавляет «/» в конце адреса) — отдаём как есть, браузер сам последует
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) return { res, how: 'redirect', len: 0 };
  let len = 0, ok = false;
  if (res.status === 200) {
    const txt = await res.clone().text();
    len = txt.length;
    ok = isCompleteHtml(txt);
  }
  if (ok) { await putIfValid(req, res.clone()); return { res, how: 'net', len }; }
  try {
    const u = new URL(req.url);
    u.searchParams.set('_sw', String(Date.now()));
    const res2 = await fetch(u.toString(), { cache: 'reload' });
    if (res2.status === 200) {
      const txt2 = await res2.clone().text();
      if (isCompleteHtml(txt2)) { await putIfValid(req, res2.clone()); return { res: res2, how: 'net-retry', len: txt2.length, badLen: len }; }
    }
  } catch (e) { /* пойдём в кэш */ }
  return { res, how: 'bad', len, bad: true };
}

// ── Белый экран: страница загрузилась, но её скрипт так и не отозвался ──
// Страница при запуске шлёт воркеру сигнал «жива». Если за 6.5 с сигнала нет — экран белый:
// воркер сам перезагружает страницу, но не чаще раза в минуту.
const _aliveClients = new Set();
let _lastWhiteReload = 0;
self.addEventListener('message', (event) => {
  const d = event.data;
  if (d && d.type === 'alive' && event.source && event.source.id) _aliveClients.add(event.source.id);
});
async function watchWhiteScreen(clientId) {
  await new Promise((r) => setTimeout(r, 6500));
  if (_aliveClients.has(clientId)) { _aliveClients.delete(clientId); return; }
  try {
    const c = await self.clients.get(clientId);
    if (!c) return;                                          // окно уже закрыли
    if (Date.now() - _lastWhiteReload < 60000) { await swLog({ how: 'white-skip-throttle' }); return; }
    _lastWhiteReload = Date.now();
    await swLog({ how: 'white-reload' });
    await c.navigate(c.url);
  } catch (e) {
    await swLog({ how: 'white-reload-failed', err: String((e && e.message) || e).slice(0, 40) });
    try { await self.registration.showNotification('Белый экран', { body: 'Потяни экран вниз, чтобы обновить', tag: 'mvs-white' }); } catch (e2) {}
  }
}

function loadingPage(reason) {
  // Показываем сразу, пока настоящая страница докачивается. Цвет — по теме приложения (как в самой странице),
  // чтобы не было белой вспышки. Как только страница легла в кэш — перезагружаемся, и воркер отдаёт её мгновенно.
  const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
    '<style>html,body{margin:0;height:100%}body{display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,sans-serif;background:#e6f6ec;color:#1d4a30}' +
    'body.d{background:#101820;color:#fff}.s{text-align:center}.t{font-size:18px;font-weight:600}.n{opacity:.6;font-size:13px;margin-top:6px}' +
    '.r{width:34px;height:34px;margin:0 auto 14px;border-radius:50%;border:3px solid currentColor;border-top-color:transparent;opacity:.7;animation:r 1s linear infinite}@keyframes r{to{transform:rotate(360deg)}}</style></head>' +
    '<body><div class="s"><div class="r"></div><div class="t">Загрузка…</div><div class="n" id="n">' + (reason === 'error' ? 'нет соединения' : 'ждём сеть') + '</div></div>' +
    '<script>try{if(localStorage.getItem("mvs_theme")==="dark")document.body.className="d"}catch(e){}' +
    '(function p(){caches.match(location.href,{ignoreSearch:true}).then(function(m){if(m){location.reload()}else{setTimeout(p,500)}},function(){setTimeout(p,1000)})})();' +
    'setTimeout(function(){var n=document.getElementById("n");if(n)n.textContent="всё ещё грузится… проверь интернет"},12000)</script></body></html>';
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// Кэш-сначала для плиток и библиотеки карты. Запрашиваем в режиме CORS, чтобы ответ был «настоящим»
// (не opaque) и занимал в хранилище столько, сколько весит на самом деле.
async function trimCache(cache, max) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}
async function cacheFirstCors(event, req, cacheName, max) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req.url);
  if (hit) return hit;
  try {
    const init = { mode: 'cors', credentials: 'omit' };
    if (req.referrer && req.referrer !== 'about:client') init.referrer = req.referrer;
    const res = await fetch(req.url, init);
    if (res && res.status === 200) {
      event.waitUntil((async () => { try { await cache.put(req.url, res.clone()); if (max) await trimCache(cache, max); } catch (e) {} })());
    }
    return res;
  } catch (e) {
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

// Фоновое обновление: сообщаем странице, если на сервере версия новее
async function notifyUpdated() {
  try {
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    cs.forEach((c) => c.postMessage({ type: 'updated' }));
  } catch (e) {}
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Карта: плитки и библиотека — из кэша, если есть
  if (isTile(url)) { event.respondWith(cacheFirstCors(event, req, TILE_CACHE, MAX_TILES)); return; }
  if (isLeafletLib(url)) { event.respondWith(cacheFirstCors(event, req, LIB_CACHE, 0)); return; }

  // Свои файлы Leaflet: кэш сначала, при промахе — сеть (и кладём в кэш, если это не страница-заглушка)
  if (url.origin === self.location.origin && /\/leaflet\/[^/]+\.(js|css)$/.test(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      try {
        const res = await fetch(req);
        const ct = (res.headers.get('content-type') || '');
        if (res.status === 200 && !/text\/html/i.test(ct)) event.waitUntil(cache.put(req, res.clone()).catch(() => {}));
        return res;
      } catch (e) { return new Response('', { status: 504, statusText: 'Offline' }); }
    })());
    return;
  }

  // Геокодер и внешние API — всегда напрямую в сеть, без кэша.
  if (NEVER_CACHE_HOSTS.some((h) => url.hostname.includes(h))) return;

  const log = (ev) => { try { event.waitUntil(swLog(ev)); } catch (e) { swLog(ev); } };

  // ── Страница приложения (навигация): КЭШ СРАЗУ, свежая версия — в фоне ──
  if (req.mode === 'navigate') {
    const _cid = event.resultingClientId || event.clientId;
    if (_cid) event.waitUntil(watchWhiteScreen(_cid));
    event.respondWith((async () => {
      const t0 = Date.now();
      const cache = await caches.open(CACHE_NAME);
      let cached = await cache.match(req, { ignoreSearch: true });
      if (!cached) cached = await cache.match('./index.html');
      if (!cached) cached = await cache.match('./');
      const cachedForCompare = cached ? cached.clone() : null;   // копия для сравнения версий (оригинал уйдёт странице)

      // запрос в сеть идёт всегда: либо для обновления кэша, либо (первый запуск) как основной ответ
      const navP = fetchNav(req);
      event.waitUntil((async () => {
        try {
          const r = await navP;
          if (r && !r.bad && r.how !== 'redirect' && cachedForCompare) {
            const oldTag = cachedForCompare.headers.get('etag'), newTag = r.res.headers.get('etag');
            let changed;
            if (oldTag && newTag) changed = oldTag !== newTag;
            else changed = (await cachedForCompare.text()).length !== r.len;
            if (changed) { await swLog({ how: 'update-ready', len: r.len }); notifyUpdated(); }
          }
        } catch (e) { /* офлайн — обновимся в следующий раз */ }
      })());

      if (cached) { log({ how: 'cache-first', ms: Date.now() - t0 }); return cached; }

      // ── Кэша нет (первый запуск или Android его удалил) ──
      // Быстрая сеть (до 0,8 с) — отдаём страницу сразу. Медленная — показываем «Загрузка…», а страница докачается в фоне.
      let err = '';
      const quick = new Promise((resolve) => setTimeout(() => resolve('slow'), 800));
      const first = await Promise.race([navP.then((x) => x, (e) => { err = String((e && e.message) || e).slice(0, 40); return 'error'; }), quick]);
      if (first && first !== 'slow' && first !== 'error') {
        log({ how: first.bad ? 'bad-no-cache' : first.how, len: first.len, ms: Date.now() - t0 });
        return first.res;
      }
      log({ how: 'loading-page', why: first === 'error' ? 'error' : 'slow', err, ms: Date.now() - t0 });
      return loadingPage(first === 'error' ? 'error' : 'slow');
    })());
    return;
  }

  // ── Прочие локальные ресурсы: сеть сначала, но не дольше NETWORK_TIMEOUT ──
  const netPromise = fetch(req).then((res) => {
    putIfValid(req, res.clone());
    return res;
  });
  event.waitUntil(netPromise.catch(() => {}));
  event.respondWith((async () => {
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), NETWORK_TIMEOUT));
    const first = await Promise.race([netPromise.catch(() => null), timeout]);
    if (first) return first;
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);
    if (cached) return cached;
    try { return await netPromise; }
    catch (e) { return new Response('', { status: 504, statusText: 'Offline' }); }
  })());
});

// Тап по уведомлению открывает приложение
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ('focus' in c) return c.focus(); }
      return self.clients.openWindow('./');
    })
  );
});
