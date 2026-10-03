// The old app installed a service worker for push notifications that never worked.
// Browsers still have it registered, so this version removes itself.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
    event.waitUntil(self.registration.unregister());
});
