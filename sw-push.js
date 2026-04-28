function normalizarPathnameCliente(url) {
    try {
        return new URL(url, self.location.origin).pathname || '/';
    } catch (error) {
        return '/';
    }
}

function esVistaMisBoletos(pathname) {
    return pathname === '/mis-boletos.html' || pathname === '/mis-boletos-restringido.html';
}

function debeSuprimirNotificacionVisible(clientsList = [], payload = {}) {
    const destinationPath = normalizarPathnameCliente(payload?.url || '/mis-boletos.html');

    return clientsList.some((client) => {
        if (client?.visibilityState !== 'visible') {
            return false;
        }

        const clientPath = normalizarPathnameCliente(client?.url || '/');

        // Solo suprimir la notificación del sistema cuando la vista visible
        // realmente puede reflejar el evento en la UI de la orden.
        return clientPath === destinationPath || esVistaMisBoletos(clientPath);
    });
}

self.addEventListener('push', (event) => {
    let payload = {};

    try {
        payload = event.data ? event.data.json() : {};
    } catch (error) {
        payload = {
            title: 'Notificación',
            body: event.data ? event.data.text() : 'Tienes una actualización nueva.'
        };
    }

    const title = payload.title || 'Actualización';
    const options = {
        body: payload.body || 'Tienes una actualización pendiente.',
        tag: payload.tag || 'rifaplus-push',
        requireInteraction: payload.requireInteraction === true,
        renotify: payload.renotify === true,
        silent: payload.silent === true ? true : false,
        icon: payload.icon || '/images/placeholder-logo.svg',
        badge: payload.badge || '/images/placeholder-logo.svg',
        data: {
            ...(payload.data || {}),
            url: payload.url || '/mis-boletos.html'
        }
    };

    event.waitUntil((async () => {
        const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const client of clientsList) {
            client.postMessage({
                type: 'rifaplus-push',
                payload
            });
        }

        const shouldSuppressNotification = debeSuprimirNotificacionVisible(clientsList, payload);
        if (!shouldSuppressNotification) {
            await self.registration.showNotification(title, options);
        }
    })());
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const destinationUrl = event.notification?.data?.url || '/mis-boletos.html';
    const destination = new URL(destinationUrl, self.location.origin).toString();

    event.waitUntil((async () => {
        const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const client of clientsList) {
            const clientUrl = client?.url ? new URL(client.url, self.location.origin).toString() : '';
            if ('focus' in client) {
                await client.focus();
                if ('navigate' in client) {
                    await client.navigate(destination);
                }
                if (clientUrl.includes('/mis-boletos.html')) {
                    return;
                }
            }
        }

        if (self.clients.openWindow) {
            await self.clients.openWindow(destination);
        }
    })());
});
