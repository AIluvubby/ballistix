const CACHE = 'ballistix-v24';
const ASSETS = ['./index.html', './manifest.json'];

self.addEventListener('install', e => {
    e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
    self.skipWaiting();
});

self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
            .then(() => clients.claim())
    );
});

self.addEventListener('fetch', e => {
    const url = new URL(e.request.url);
    // JS и CSS всегда с сети — чтобы обновления применялись сразу
    if (url.pathname.endsWith('.js') || url.pathname.endsWith('.css')) {
        e.respondWith(fetch(e.request));
        return;
    }
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
