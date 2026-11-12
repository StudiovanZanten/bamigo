// BAMIGO service worker: alleen voor meldingen (geen offline-cache, zodat updates direct werken).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'BAMIGO', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'BAMIGO', {
    body: d.body || '', icon: '/icon-192.png', badge: '/icon-192.png', tag: d.tag || 'bamigo', data: { url: d.url || '/speel' },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/speel', self.location.origin).href;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = all.find(c => new URL(c.url).pathname === '/speel');
    if (open) { await open.focus(); open.postMessage({ type: 'open', url }); return; }
    await self.clients.openWindow(url);
  })());
});
