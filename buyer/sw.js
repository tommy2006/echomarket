// Service worker for phone / browser alerts ("your order was delivered").
// It only handles push messages and clicks on them; it does not cache anything.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
    let data = {};
    try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data && event.data.text() }; }
    event.waitUntil(self.registration.showNotification(data.title || 'Echo Market', {
        body: data.body || '',
        icon: '/echo_logo.png',
        badge: '/echo_logo.png',
        tag: data.tag || undefined,          // same tag = replaces instead of stacking
        data: { url: data.url || '/#orders' }
    }));
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    // Only ever open pages of this site.
    let url = '/';
    try {
        const u = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin);
        if (u.origin === self.location.origin) url = u.href;
    } catch { /* keep '/' */ }
    event.waitUntil((async () => {
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const w of windows) {
            if ('focus' in w) {
                try { await w.navigate(url); } catch { /* cross-origin or unsupported: just focus */ }
                return w.focus();
            }
        }
        return self.clients.openWindow(url);
    })());
});
