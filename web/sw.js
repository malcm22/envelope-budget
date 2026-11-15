// Service worker: shows purchase notifications and handles taps.
importScripts('config.js');
const CFG = self.BUDGET_CONFIG || {};
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: 'Budget', body: e.data && e.data.text() }; }
  const opts = { body: d.body || '', tag: d.t || undefined, renotify: !!d.t, data: d, icon: 'icons/icon-192.png', badge: 'icons/badge-96.png' };
  if (d.q) opts.actions = [{ action: 'q', title: d.q.n }, { action: 'open', title: 'Pick bucket…' }];
  e.waitUntil(self.registration.showNotification(d.title || 'Budget', opts));
});

self.addEventListener('notificationclick', e => {
  const d = e.notification.data || {};
  e.notification.close();
  if (e.action === 'q' && d.q) {
    e.waitUntil(fetch(CFG.supabaseUrl + '/functions/v1/quick', {
      method: 'POST', headers: { 'Content-Type': 'application/json', apikey: CFG.supabaseKey },
      body: JSON.stringify({ h: d.h, t: d.t, c: d.q.c, s: d.q.s })
    }).then(r => r.ok
      ? self.registration.showNotification('Put in ' + d.q.n + ' ✓', { body: d.title, tag: 'ok-' + d.t, icon: 'icons/icon-192.png', badge: 'icons/badge-96.png' })
      : openApp(d.t)).catch(() => openApp(d.t)));
    return;
  }
  e.waitUntil(openApp(d.t));
});

function openApp(t) {
  const url = new URL((t ? './?t=' + encodeURIComponent(t) : './') + '#activity', self.registration.scope).href;
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if ('focus' in c) { if (t) c.postMessage({ open: t }); return c.focus(); } }
    return self.clients.openWindow(url);
  });
}
