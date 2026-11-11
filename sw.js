/* МВС отчёты — Service Worker. Страницы (index.html) берутся СНАЧАЛА С СЕРВЕРА,
   из кэша — только если нет сети. Поэтому новая версия с GitHub доходит до телефона сразу. */
const CACHE = 'mvs-cache-2026-11-11-C';
const CORE = ['./', './index.html', './manifest.webmanifest', './suggestions.min.css', './suggestions.min.js'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c =>
    Promise.all(CORE.map(u => c.add(new Request(u, { cache: 'reload' })).catch(() => {})))
  ));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if (k !== CACHE && k !== 'mvs-log') await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'skipWaiting') self.skipWaiting();
});

function keyOf(req) { const u = new URL(req.url); return new Request(u.origin + u.pathname); }

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req, { cache: 'no-store' });
    if (res && res.ok) cache.put(keyOf(req), res.clone());
    return res;
  } catch (err) {
    return (await cache.match(keyOf(req))) || (await cache.match('./index.html')) || (await cache.match('./')) ||
      new Response('Нет сети', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });
  const fresh = fetch(req).then(res => { if (res && res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
  return hit || (await fresh) || new Response('', { status: 504 });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.endsWith('/sw.js')) return;
  const isDoc = req.mode === 'navigate' || req.destination === 'document' ||
                url.pathname.endsWith('.html') || url.pathname.endsWith('/');
  e.respondWith(isDoc ? networkFirst(req) : staleWhileRevalidate(req));
});
