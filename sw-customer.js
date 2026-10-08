self.addEventListener('push', event => {
  let data = {};

  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = {
      title: 'FirstESIM',
      body: event.data ? event.data.text() : 'QR ـەکەت ئامادەیە'
    };
  }

  const title = data.title || 'FirstESIM';
  const options = {
    body: data.body || 'QR ـەکەت ئامادەیە 🔔',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: {
      url: data.url || 'https://firstesim.net/FirstESIM-App/',
      orderId: data.orderId || ''
    },
    tag: data.tag || 'firstesim-qr',
    renotify: true
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();

  const url =
    event.notification.data?.url ||
    'https://firstesim.net/FirstESIM-App/';

  event.waitUntil(
    clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    }).then(clientList => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }

      if (clients.openWindow) {
        return clients.openWindow(url);
      }
    })
  );
});
