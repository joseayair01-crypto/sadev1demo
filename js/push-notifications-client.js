(function() {
    const LOCAL_KEY_PREFIX = 'rifaplus_push_order_';
    let configCache = null;
    let initPromise = null;
    let swMessageHooked = false;

    function obtenerApiBase() {
        return window.rifaplusConfig?.backend?.apiBase
            || window.rifaplusConfig?.obtenerApiBase?.()
            || window.location.origin;
    }

    function esContextoSeguroPush() {
        return window.isSecureContext
            || window.location.hostname === 'localhost'
            || window.location.hostname === '127.0.0.1';
    }

    function navegadorSoportaPush() {
        return 'serviceWorker' in navigator
            && 'PushManager' in window
            && 'Notification' in window;
    }

    function base64ToUint8Array(base64String) {
        const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
        const normalized = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
        const rawData = window.atob(normalized);
        return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
    }

    function uint8ArraysIguales(a, b) {
        if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) {
            return false;
        }

        for (let index = 0; index < a.length; index += 1) {
            if (a[index] !== b[index]) {
                return false;
            }
        }

        return true;
    }

    function normalizarApplicationServerKey(rawKey) {
        if (!rawKey) {
            return null;
        }

        if (rawKey instanceof Uint8Array) {
            return rawKey;
        }

        if (rawKey instanceof ArrayBuffer) {
            return new Uint8Array(rawKey);
        }

        if (ArrayBuffer.isView(rawKey)) {
            return new Uint8Array(rawKey.buffer, rawKey.byteOffset, rawKey.byteLength);
        }

        return null;
    }

    function subscriptionCoincideConClaveVapid(subscription, publicKey) {
        if (!subscription || !publicKey) {
            return true;
        }

        const keyActual = normalizarApplicationServerKey(subscription.options?.applicationServerKey);
        if (!keyActual) {
            return true;
        }

        return uint8ArraysIguales(keyActual, base64ToUint8Array(publicKey));
    }

    async function fetchPushConfig() {
        if (configCache) {
            return configCache;
        }

        const response = await fetch(`${obtenerApiBase()}/api/public/push/config`, {
            cache: 'no-store'
        });
        const data = await response.json();
        configCache = {
            enabled: data?.success === true && data?.enabled === true,
            publicKey: data?.publicKey || null
        };
        return configCache;
    }

    function guardarMarcaLocal(orderId, active) {
        try {
            localStorage.setItem(`${LOCAL_KEY_PREFIX}${String(orderId || '').trim().toUpperCase()}`, active ? '1' : '0');
        } catch (error) {
            // No bloquear UX si localStorage falla.
        }
    }

    function leerMarcaLocal(orderId) {
        try {
            return localStorage.getItem(`${LOCAL_KEY_PREFIX}${String(orderId || '').trim().toUpperCase()}`) === '1';
        } catch (error) {
            return false;
        }
    }

    function despacharEventoPush(payload) {
        document.dispatchEvent(new CustomEvent('rifaplus:push-message', {
            detail: payload
        }));
    }

    function hookMensajesServiceWorker() {
        if (swMessageHooked || !('serviceWorker' in navigator)) {
            return;
        }

        navigator.serviceWorker.addEventListener('message', (event) => {
            if (event?.data?.type === 'rifaplus-push') {
                despacharEventoPush(event.data.payload || {});
            }
        });
        swMessageHooked = true;
    }

    async function init() {
        if (initPromise) {
            return initPromise;
        }

        initPromise = (async () => {
            const config = await fetchPushConfig();

            if (!config.enabled || !navegadorSoportaPush() || !esContextoSeguroPush()) {
                hookMensajesServiceWorker();
                return {
                    ready: false,
                    enabled: config.enabled,
                    supported: navegadorSoportaPush(),
                    secureContext: esContextoSeguroPush()
                };
            }

            try {
                const registration = await navigator.serviceWorker.register('/sw-push.js', {
                    scope: '/'
                });
                hookMensajesServiceWorker();

                return {
                    ready: true,
                    enabled: true,
                    supported: true,
                    secureContext: true,
                    registration
                };
            } catch (swError) {
                return { ready: false, error: swError.message };
            }
        })();

        return initPromise;
    }

    async function obtenerRegistration() {
        const state = await init();
        if (!state.ready) {
            throw new Error('PUSH_NOT_AVAILABLE');
        }

        return state.registration || navigator.serviceWorker.ready;
    }

    async function obtenerSuscripcionActual() {
        const registration = await obtenerRegistration();
        return registration.pushManager.getSubscription();
    }

    async function sincronizarEstadoLocalOrden(orderId) {
        const orderKey = String(orderId || '').trim().toUpperCase();
        const permission = typeof Notification !== 'undefined' ? Notification.permission : 'unsupported';

        if (!orderKey) {
            return {
                active: false,
                permission,
                browserSubscription: false
            };
        }

        if (!navegadorSoportaPush() || !esContextoSeguroPush() || permission === 'denied') {
            guardarMarcaLocal(orderKey, false);
            return {
                active: false,
                permission,
                browserSubscription: false
            };
        }

        try {
            const subscription = await obtenerSuscripcionActual();
            if (!subscription) {
                guardarMarcaLocal(orderKey, false);
                return {
                    active: false,
                    permission,
                    browserSubscription: false
                };
            }
        } catch (error) {
            guardarMarcaLocal(orderKey, false);
            return {
                active: false,
                permission,
                browserSubscription: false
            };
        }

        return {
            active: leerMarcaLocal(orderKey),
            permission,
            browserSubscription: true
        };
    }

    async function suscribirseOrden(order) {
        const pushMeta = order?.push_notificaciones || {};
        if (!pushMeta.enabled || !pushMeta.canSubscribe || !pushMeta.token) {
            throw new Error('PUSH_NOT_ALLOWED_FOR_ORDER');
        }

        const state = await init();
        if (!state.ready) {
            if (!state.enabled) throw new Error('PUSH_NOT_CONFIGURED');
            if (!state.supported) throw new Error('PUSH_NOT_SUPPORTED');
            if (!state.secureContext) throw new Error('PUSH_REQUIRES_HTTPS');
        }

        if (Notification.permission === 'denied') {
            throw new Error('PUSH_PERMISSION_DENIED');
        }

        if (Notification.permission !== 'granted') {
            const permission = await Notification.requestPermission();
            if (permission !== 'granted') {
                throw new Error(permission === 'denied' ? 'PUSH_PERMISSION_DENIED' : 'PUSH_PERMISSION_DISMISSED');
            }
        }

        const config = await fetchPushConfig();
        const registration = await obtenerRegistration();
        let subscription = await registration.pushManager.getSubscription();
        if (subscription && !subscriptionCoincideConClaveVapid(subscription, config.publicKey)) {
            await subscription.unsubscribe().catch(() => {});
            subscription = null;
        }

        if (!subscription) {
            subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: base64ToUint8Array(config.publicKey)
            });
        }

        const response = await fetch(`${obtenerApiBase()}/api/public/push/subscribe`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                numero_orden: order.numero_orden || order.id,
                token: pushMeta.token,
                subscription: subscription.toJSON(),
                permission: Notification.permission
            })
        });

        const data = await response.json();
        if (!response.ok || data?.success !== true) {
            throw new Error(data?.message || 'PUSH_SUBSCRIBE_FAILED');
        }

        guardarMarcaLocal(order.numero_orden || order.id, true);
        return data;
    }

    async function desuscribirseOrden(order) {
        const pushMeta = order?.push_notificaciones || {};
        if (!pushMeta.token) {
            throw new Error('PUSH_MISSING_TOKEN');
        }

        const subscription = await obtenerSuscripcionActual();
        if (!subscription) {
            guardarMarcaLocal(order.numero_orden || order.id, false);
            return { success: true, updated: 0 };
        }

        const response = await fetch(`${obtenerApiBase()}/api/public/push/unsubscribe`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                numero_orden: order.numero_orden || order.id,
                token: pushMeta.token,
                subscription: subscription.toJSON()
            })
        });

        const data = await response.json();
        if (!response.ok || data?.success !== true) {
            throw new Error(data?.message || 'PUSH_UNSUBSCRIBE_FAILED');
        }

        guardarMarcaLocal(order.numero_orden || order.id, false);
        return data;
    }

    function obtenerEstadoLocal(orderId) {
        return {
            active: leerMarcaLocal(orderId),
            permission: typeof Notification !== 'undefined' ? Notification.permission : 'unsupported'
        };
    }

    window.RifaPlusPushClient = {
        init,
        suscribirseOrden,
        desuscribirseOrden,
        obtenerEstadoLocal,
        sincronizarEstadoLocalOrden,
        navegadorSoportaPush,
        esContextoSeguroPush
    };
})();
