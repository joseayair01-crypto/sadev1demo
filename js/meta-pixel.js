(function inicializarMetaPixel(global) {
    const SCRIPT_ID = 'rifaplus-meta-pixel-script';
    const PAGE_TYPES = {
        compra: /\/compra(?:\.html)?$/i.test(global.location.pathname),
        index: /\/(?:index\.html)?$/i.test(global.location.pathname)
    };

    const state = {
        loaded: false,
        loading: false,
        loadPromise: null,
        currentPixelId: '',
        autoTracked: {
            pageView: false,
            viewContent: false
        },
        initializedPixels: new Set(),
        trackedEventKeys: new Set()
    };

    function debug() {
        if (!['localhost', '127.0.0.1'].includes(global.location.hostname)) {
            return;
        }

        if (typeof console !== 'undefined' && typeof console.debug === 'function') {
            console.debug('[MetaPixel]', ...arguments);
        }
    }

    function obtenerConfigPixel() {
        const config = global.rifaplusConfig?.marketing?.metaPixel;
        if (!config || typeof config !== 'object') {
            return {
                enabled: false,
                pixelId: ''
            };
        }

        return {
            enabled: config.enabled === true,
            pixelId: String(config.pixelId || '').replace(/[^\d]/g, '').trim(),
            trackPageView: config.trackPageView !== false,
            trackViewContent: config.trackViewContent !== false,
            trackAddToCart: config.trackAddToCart !== false,
            trackInitiateCheckout: config.trackInitiateCheckout !== false,
            trackPurchase: config.trackPurchase !== false
        };
    }

    function resetAutoTracking(reason = 'unknown') {
        state.autoTracked.pageView = false;
        state.autoTracked.viewContent = false;
        debug('Auto tracking reiniciado', reason);
    }

    function syncPixelState(config = obtenerConfigPixel()) {
        const nextPixelId = String(config?.pixelId || '').trim();

        if (!config.enabled || !nextPixelId) {
            if (state.currentPixelId) {
                resetAutoTracking('pixel-disabled');
            }
            state.currentPixelId = '';
            return config;
        }

        if (state.currentPixelId && state.currentPixelId !== nextPixelId) {
            resetAutoTracking('pixel-id-changed');
        }

        state.currentPixelId = nextPixelId;
        return config;
    }

    function puedeRastrear(tipo) {
        const config = obtenerConfigPixel();
        if (!config.enabled || !config.pixelId) return false;
        if (tipo === 'PageView') return config.trackPageView !== false;
        if (tipo === 'ViewContent') return config.trackViewContent !== false;
        if (tipo === 'AddToCart') return config.trackAddToCart !== false;
        if (tipo === 'InitiateCheckout') return config.trackInitiateCheckout !== false;
        if (tipo === 'Purchase') return config.trackPurchase !== false;
        return true;
    }

    function cargarScript() {
        if (global.fbq) {
            state.loaded = true;
            state.loading = false;
            state.loadPromise = Promise.resolve(global.fbq);
            return state.loadPromise;
        }

        if (state.loadPromise) {
            return state.loadPromise;
        }

        state.loading = true;
        state.loadPromise = new Promise((resolve, reject) => {
            const existingScript = global.document.getElementById(SCRIPT_ID);
            if (existingScript) {
                existingScript.addEventListener('load', () => {
                    state.loaded = true;
                    state.loading = false;
                    resolve(global.fbq);
                }, { once: true });
                existingScript.addEventListener('error', (error) => {
                    state.loaded = false;
                    state.loading = false;
                    state.loadPromise = null;
                    reject(error);
                }, { once: true });
                return;
            }

            (function(f, b, e, v, n, t, s) {
                if (f.fbq) {
                    resolve(f.fbq);
                    return;
                }

                n = f.fbq = function() {
                    if (n.callMethod) {
                        n.callMethod.apply(n, arguments);
                    } else {
                        n.queue.push(arguments);
                    }
                };
                if (!f._fbq) f._fbq = n;
                n.push = n;
                n.loaded = true;
                n.version = '2.0';
                n.queue = [];
                t = b.createElement(e);
                t.id = SCRIPT_ID;
                t.async = true;
                t.src = v;
                t.onload = function() {
                    state.loaded = true;
                    state.loading = false;
                    resolve(f.fbq);
                };
                t.onerror = function(error) {
                    state.loaded = false;
                    state.loading = false;
                    state.loadPromise = null;
                    reject(error);
                };
                s = b.getElementsByTagName(e)[0];
                s.parentNode.insertBefore(t, s);
            })(global, global.document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
        });

        return state.loadPromise;
    }

    function asegurarInitPixel() {
        const config = syncPixelState(obtenerConfigPixel());
        if (!config.enabled || !config.pixelId) {
            return false;
        }

        cargarScript();

        if (!global.fbq) {
            return false;
        }

        if (!state.initializedPixels.has(config.pixelId)) {
            global.fbq('init', config.pixelId);
            state.initializedPixels.add(config.pixelId);
            state.currentPixelId = config.pixelId;
            debug('Pixel inicializado', config.pixelId);
        }

        return true;
    }

    function obtenerContenidoActual() {
        const rifa = global.rifaplusConfig?.rifa || {};
        const precio = Number(global.rifaplusConfig?.obtenerPrecioBoleto?.() || rifa.precioBoleto || 0);

        return {
            content_name: String(rifa.nombreSorteo || rifa.edicionNombre || 'Sorteo').trim() || 'Sorteo',
            content_category: 'rifa',
            content_type: 'product',
            currency: 'MXN',
            value: Number.isFinite(precio) ? precio : 0,
            content_ids: [String(global.rifaplusConfig?.obtenerSlugRifaActual?.() || rifa.slug || rifa.nombreSorteo || 'rifa').trim() || 'rifa']
        };
    }

    function construirEventKey(eventName, payload = {}, options = {}) {
        const pixelId = String(state.currentPixelId || '').trim();
        if (!pixelId) {
            return '';
        }

        if (eventName === 'Purchase') {
            const orderId = payload.order_id || payload.orderId || payload.num_orden || payload.numero_orden;
            if (orderId) {
                return `${pixelId}:${eventName}:${String(orderId).trim()}`;
            }

            const eventId = options.eventID || options.eventId;
            if (eventId) {
                return `${pixelId}:${eventName}:${String(eventId).trim()}`;
            }
        }

        return '';
    }

    function track(eventName, payload = {}, options = {}) {
        if (!puedeRastrear(eventName)) {
            return false;
        }

        if (!asegurarInitPixel() || !global.fbq) {
            return false;
        }

        try {
            if (options && Object.keys(options).length > 0) {
                global.fbq('track', eventName, payload, options);
            } else {
                global.fbq('track', eventName, payload);
            }

            const eventKey = construirEventKey(eventName, payload, options);
            if (eventKey) {
                state.trackedEventKeys.add(eventKey);
            }

            debug('Evento enviado', eventName, payload, options);
            return true;
        } catch (error) {
            debug('No se pudo enviar evento', eventName, error?.message || error);
            return false;
        }
    }

    function trackPageView() {
        if (state.autoTracked.pageView) return false;
        const enviado = track('PageView');
        if (enviado) {
            state.autoTracked.pageView = true;
        }
        return enviado;
    }

    function trackViewContent(extra = {}) {
        if (state.autoTracked.viewContent && Object.keys(extra || {}).length === 0) {
            return false;
        }

        const payload = Object.assign({}, obtenerContenidoActual(), extra || {});
        const enviado = track('ViewContent', payload);
        if (enviado && Object.keys(extra || {}).length === 0) {
            state.autoTracked.viewContent = true;
        }
        return enviado;
    }

    function trackAddToCart(payload = {}) {
        const normalized = Object.assign({
            currency: 'MXN'
        }, payload || {});
        return track('AddToCart', normalized);
    }

    function trackInitiateCheckout(payload = {}) {
        const normalized = Object.assign({
            currency: 'MXN'
        }, payload || {});
        return track('InitiateCheckout', normalized);
    }

    function trackPurchase(payload = {}, options = {}) {
        const normalized = Object.assign({
            currency: 'MXN'
        }, payload || {});

        const eventKey = construirEventKey('Purchase', normalized, options);
        if (eventKey && state.trackedEventKeys.has(eventKey)) {
            debug('Purchase deduplicado', eventKey);
            return false;
        }

        return track('Purchase', normalized, options);
    }

    function autoTrackSegunPagina() {
        const config = obtenerConfigPixel();
        if (!config.enabled || !config.pixelId) {
            return;
        }

        if (config.trackPageView !== false) {
            trackPageView();
        }

        if (config.trackViewContent !== false && PAGE_TYPES.compra) {
            trackViewContent();
        }
    }

    function refrescar() {
        const config = syncPixelState(obtenerConfigPixel());
        if (!config.enabled || !config.pixelId) {
            debug('Pixel desactivado o sin ID');
            return;
        }

        asegurarInitPixel();
        autoTrackSegunPagina();
    }

    global.RifaPlusMetaPixel = {
        refresh: refrescar,
        track,
        trackPageView,
        trackViewContent,
        trackAddToCart,
        trackInitiateCheckout,
        trackPurchase,
        getConfig: obtenerConfigPixel
    };

    if (global.document.readyState === 'loading') {
        global.document.addEventListener('DOMContentLoaded', refrescar, { once: true });
    } else {
        refrescar();
    }

    global.addEventListener('configuracionActualizada', refrescar);
    global.addEventListener('configSyncCompleto', refrescar);
})(window);
