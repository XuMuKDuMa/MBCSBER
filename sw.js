// Service Worker для МВС отчёты — офлайн-кэш приложения
// Карта (Leaflet, геокодирование) требует интернет и намеренно НЕ кэшируется.

const CACHE_NAME = 'mvs-reports-v4';   // v4: автоперезагрузка при белом экране
const LOG_CACHE = 'mvs-log';           // журнал работы воркера (читается в «Диагностике запуска»)
const NETWORK_TIMEOUT = 3000;          // мс: дольше не ждём сеть при открытии приложения
const APP_SHELL = [
  './',
  './index.html'
];

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

// ── Установка: кладём в кэш сам HTML-файл приложения ──
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(APP_SHELL).catch(() => {
        // Если './' недоступен — не валим установку, закэшируем страницу при первом fetch.
      });
    })
  );
  self.skipWaiting();
});

// ── Активация: подчищаем старые версии кэша (журнал оставляем) ──
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME && k !== LOG_CACHE).map((k) => caches.delete(k))
      )
    ).then(() => swLog({ how: 'activate', v: CACHE_NAME }))
  );
  self.clients.claim();
});

// ── Список доменов, которые НЕ кэшируем принципиально (карта, геокодер, IP-сервисы) ──
const NEVER_CACHE_HOSTS = [
  'nominatim.openstreetmap.org',
  'photon.komoot.io',
  'tile.openstreetmap.org',
  'unpkg.com',
  'cdn.jsdelivr.net',
  'ipapi.co',
  'ipwho.is',
  'ipinfo.io',
  'country.is',
  'geojs.io',
  'api.ip.sb',
  'router.project-osrm.org'
];

function isCompleteHtml(txt) {
  return txt.length > 20000 && /<\/html>\s*$/i.test(txt.trim());
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
// Если пришло пустое или обрезанное (например, испорченная копия в кэше оболочки APK) —
// повторяем запрос с обходом всех кэшей.
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
  if (ok) { putIfValid(req, res.clone()); return { res, how: 'net', len }; }
  try {
    const u = new URL(req.url);
    u.searchParams.set('_sw', String(Date.now()));
    const res2 = await fetch(u.toString(), { cache: 'reload' });
    if (res2.status === 200) {
      const txt2 = await res2.clone().text();
      if (isCompleteHtml(txt2)) { putIfValid(req, res2.clone()); return { res: res2, how: 'net-retry', len: txt2.length, badLen: len }; }
    }
  } catch (e) { /* пойдём в кэш */ }
  return { res, how: 'bad', len, bad: true };
}

// ── Белый экран: страница загрузилась, но её скрипт так и не отозвался ──
// Страница при запуске шлёт воркеру сигнал «жива». Если за 6.5 с сигнала нет — экран белый:
// воркер сам перезагружает страницу (то же, что свайп-обновление), но не чаще раза в минуту.
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

function loadingPage() {
  return new Response(
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>' +
    '<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#101820;color:#fff;font-family:system-ui,sans-serif">' +
    '<div style="text-align:center"><div style="font-size:18px;font-weight:600">Загрузка…</div><div style="opacity:.6;font-size:13px;margin-top:6px">ждём сеть</div></div>' +
    '<script>setTimeout(function(){location.reload()},1500)</script></body></html>',
    { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Карта и внешние API — всегда напрямую в сеть, без кэша.
  if (NEVER_CACHE_HOSTS.some((h) => url.hostname.includes(h))) return;

  const log = (ev) => { try { event.waitUntil(swLog(ev)); } catch (e) { swLog(ev); } };

  // ── Страница приложения (навигация) ──
  if (req.mode === 'navigate') {
    const navP = fetchNav(req);
    event.waitUntil(navP.catch(() => {}));
    const _cid = event.resultingClientId || event.clientId;
    if (_cid) event.waitUntil(watchWhiteScreen(_cid));
    event.respondWith((async () => {
      const t0 = Date.now();
      let err = '';
      const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), NETWORK_TIMEOUT));
      const first = await Promise.race([navP.then((x) => x, (e) => { err = String((e && e.message) || e).slice(0, 40); return 'error'; }), timeout]);
      const r = (first && first !== 'timeout' && first !== 'error') ? first : null;
      if (r && !r.bad) { log({ how: r.how, len: r.len, badLen: r.badLen, ms: Date.now() - t0 }); return r.res; }

      // сеть тормозит / упала / ответ битый — берём копию ТОЛЬКО из актуального кэша
      const cache = await caches.open(CACHE_NAME);
      let cached = await cache.match(req);
      if (!cached) cached = await cache.match('./index.html');
      if (cached) { log({ how: r ? 'cache-after-bad' : (first === 'timeout' ? 'cache-timeout' : 'cache-error'), badLen: r ? r.len : undefined, err, ms: Date.now() - t0 }); return cached; }
      if (r && r.res) { log({ how: 'bad-no-cache', len: r.len, ms: Date.now() - t0 }); return r.res; }
      try { const late = await navP; log({ how: 'net-late:' + late.how, len: late.len, ms: Date.now() - t0 }); return late.res; }
      catch (e) { log({ how: 'loading-page', err: String((e && e.message) || e).slice(0, 40), ms: Date.now() - t0 }); return loadingPage(); }
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
