(() => {
    const READY_STABLE_MS = 180;
    const MIN_VISIBLE_MS = 320;
    const SOFT_FALLBACK_MS = 1600;
    const MAX_WAIT_MS = 5200;
    const POLL_INTERVAL_MS = 120;
    const LEAVE_ANIMATION_MS = 320;
    const HTML_BOOT_CLASS = 'rifaplus-shell-boot';
    const PLACEHOLDER_LOGO = 'images/placeholder-logo.svg';
    const LOGO_PLACEHOLDER_DATA_PREFIX = 'data:image/svg+xml';
    const PAGE_READY_EVENT = 'rifaplus:page-ready';
    const SHELL_PENDING_SELECTOR = '[data-shell-critical="true"], [aria-busy="true"]:not(body):not(#rifaplusPublicShell), .is-loading';

    function cuandoDomEsteListo(callback) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', callback, { once: true });
            return;
        }

        callback();
    }

    function leerLogoCacheado() {
        const logoEnMemoria = String(window.__RIFAPLUS_CACHED_LOGO__ || '').trim();
        if (logoEnMemoria) {
            return logoEnMemoria;
        }

        try {
            return String(localStorage.getItem('rifaplus_cached_logo') || '').trim();
        } catch (error) {
            return '';
        }
    }

    function resolverLogoShell() {
        const imageDelivery = window.RifaPlusImageDelivery;
        const config = window.rifaplusConfig || {};
        const logoPreferido = config?.cliente?.logo || config?.cliente?.logotipo || '';
        const logoCacheado = leerLogoCacheado();

        const fallback = PLACEHOLDER_LOGO;
        const logo = String(logoPreferido || logoCacheado || fallback).trim() || fallback;
        return imageDelivery?.resolverUrlImagen(logo, 'logoPreload') || logo;
    }

    function leerConfigCacheada() {
        try {
            const raw = localStorage.getItem('rifaplus_config_actual_v2');
            return raw ? JSON.parse(raw) : {};
        } catch (error) {
            return {};
        }
    }

    function resolverEsloganShell(stage = 'default') {
        const configActual = window.rifaplusConfig || {};
        const configCacheada = leerConfigCacheada();
        const base = String(
            configActual?.cliente?.eslogan
            || configCacheada?.cliente?.eslogan
            || 'Preparando tu experiencia digital'
        ).trim();

        const stages = {
            'default': base,
            'sync': 'Sincronizando sorteo...',
            'assets': 'Cargando componentes...',
            'ready': 'Todo listo, entrando...'
        };
        return stages[stage] || base;
    }

    function tieneConfigMinima() {
        const config = window.rifaplusConfig || {};
        const cliente = config.cliente || {};
        const rifa = config.rifa || {};

        return Boolean(
            String(cliente.nombre || '').trim()
            || String(cliente.logo || cliente.logotipo || '').trim()
            || String(rifa.nombreSorteo || '').trim()
            || Number(rifa.precioBoleto) > 0
            || String(rifa.fechaSorteo || '').trim()
        );
    }

    function actualizarLogoShell() {
        const logo = document.getElementById('rifaplusShellLogo');
        if (!logo) return;

        const siguienteSrc = resolverLogoShell();
        if (siguienteSrc && logo.getAttribute('src') !== siguienteSrc) {
            logo.setAttribute('src', siguienteSrc);
        }
    }

    function actualizarEsloganShell(stage = 'default') {
        const copy = document.getElementById('rifaplusShellCopy');
        if (!copy) return;
        const nuevoTexto = resolverEsloganShell(stage);
        if (copy.textContent !== nuevoTexto) {
            copy.style.transition = 'opacity 0.2s ease';
            copy.style.opacity = 0;
            setTimeout(() => {
                copy.textContent = nuevoTexto;
                copy.style.opacity = 1;
            }, 200);
        }
    }

    function normalizarRutaLogo(valor) {
        const texto = String(valor || '').trim();
        if (!texto) return '';

        try {
            return new URL(texto, window.location.href).href;
        } catch (error) {
            return texto;
        }
    }

    function esLogoReal(url) {
        const logo = normalizarRutaLogo(url);
        return Boolean(logo)
            && !logo.includes(PLACEHOLDER_LOGO)
            && !logo.startsWith(LOGO_PLACEHOLDER_DATA_PREFIX);
    }

    function resolverLogoObjetivo() {
        return normalizarRutaLogo(resolverLogoShell());
    }

    function logoObjetivoVieneDeCacheReal() {
        const logoCacheado = leerLogoCacheado();
        const logoObjetivo = resolverLogoObjetivo();
        if (!esLogoReal(logoCacheado) || !logoObjetivo) {
            return false;
        }

        return normalizarRutaLogo(logoCacheado) === logoObjetivo;
    }

    function logoObjetivoEsReal() {
        return esLogoReal(resolverLogoObjetivo());
    }

    function obtenerLogoCabecera() {
        return document.querySelector('.logo-circle img.dynamic-logo, .logo-circle img[data-dynamic-logo="true"]');
    }

    function logoCabeceraListo() {
        const headerLogo = obtenerLogoCabecera();
        if (!headerLogo) {
            return !logoObjetivoEsReal();
        }

        const srcActual = normalizarRutaLogo(headerLogo.currentSrc || headerLogo.getAttribute('src'));
        const logoObjetivo = resolverLogoObjetivo();

        if (!logoObjetivoEsReal()) {
            return headerLogo.complete && headerLogo.naturalWidth > 0;
        }

        return Boolean(srcActual)
            && srcActual === logoObjetivo
            && headerLogo.complete
            && headerLogo.naturalWidth > 0;
    }

    function tieneEstructuraBase() {
        return Boolean(document.querySelector('header, main, .compra-hero, .hero, .mis-boletos-container, .sorteo-finalizado-page'));
    }

    function esElementoVisibleShell(elemento) {
        if (!elemento || elemento.hidden) {
            return false;
        }

        const style = window.getComputedStyle(elemento);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
            return false;
        }

        const rect = elemento.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    function esElementoRelevanteParaShell(elemento) {
        if (!elemento) {
            return false;
        }

        if (elemento.matches('[data-shell-critical="true"]')) {
            return true;
        }

        const rect = elemento.getBoundingClientRect();
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
        const margenSuperior = 120;
        const margenInferior = Math.round(viewportHeight * 0.15);

        return rect.bottom > -margenSuperior && rect.top < viewportHeight + margenInferior;
    }

    function debeIgnorarseParaShell(elemento) {
        if (!elemento) {
            return true;
        }

        if (elemento.closest('#boletosGridShell')) {
            return true;
        }

        if (elemento.id === 'loadingEstadoBoletos' || elemento.id === 'numerosGrid' || elemento.id === 'infiniteScrollSentinel') {
            return true;
        }

        return false;
    }

    function hayPendientesCriticos() {
        const candidatos = document.querySelectorAll(SHELL_PENDING_SELECTOR);

        return Array.from(candidatos).some((elemento) => {
            if (debeIgnorarseParaShell(elemento)) {
                return false;
            }

            return esElementoVisibleShell(elemento) && esElementoRelevanteParaShell(elemento);
        });
    }

    function aplicarBodyReady(body) {
        body.classList.remove('rifaplus-shell-loading', 'rifaplus-shell-active');
        body.classList.add('rifaplus-shell-ready');
        body.removeAttribute('aria-busy');
        document.documentElement.classList.remove(HTML_BOOT_CLASS);
    }

    function actualizarEstadoLogoHeader(body) {
        if (!body) return;

        if (logoCabeceraListo()) {
            body.classList.remove('rifaplus-logo-pending');
            body.classList.add('rifaplus-logo-ready');
            return;
        }

        body.classList.add('rifaplus-logo-pending');
        body.classList.remove('rifaplus-logo-ready');
    }

    function crearRegistroEvento(target, type, listener, options) {
        target.addEventListener(type, listener, options);
        return () => target.removeEventListener(type, listener, options);
    }

    function shellDebeIniciar(html, body) {
        return html.classList.contains(HTML_BOOT_CLASS) || body.classList.contains('rifaplus-shell-loading');
    }

    function activarShellEnBody(body) {
        body.classList.add('rifaplus-shell-loading', 'rifaplus-shell-active');
        body.setAttribute('aria-busy', 'true');
    }

    cuandoDomEsteListo(() => {
        const html = document.documentElement;
        const body = document.body;
        const overlay = document.getElementById('rifaplusPublicShell');

        if (!body || !overlay) {
            return;
        }

        if (!shellDebeIniciar(html, body)) {
            overlay.setAttribute('hidden', 'hidden');
            actualizarEstadoLogoHeader(body);
            return;
        }

        activarShellEnBody(body);
        overlay.removeAttribute('hidden');
        overlay.classList.add('is-visible');

        const estado = {
            inicio: performance.now(),
            cerrado: false,
            mostradoEn: performance.now() - MIN_VISIBLE_MS,
            pageReady: false,
            estableDesde: 0,
            configSincronizada: tieneConfigMinima(),
            ventanaCargada: document.readyState === 'complete',
            permitirFallbackLogo: false,
            intervalId: 0,
            softFallbackId: 0,
            forceCloseId: 0,
            cacheLogoRealDisponible: logoObjetivoVieneDeCacheReal()
        };
        const limpiadoresEventos = [];

        const limpiarTimers = () => {
            if (estado.intervalId) {
                window.clearInterval(estado.intervalId);
                estado.intervalId = 0;
            }
            if (estado.softFallbackId) {
                window.clearTimeout(estado.softFallbackId);
                estado.softFallbackId = 0;
            }
            if (estado.forceCloseId) {
                window.clearTimeout(estado.forceCloseId);
                estado.forceCloseId = 0;
            }
        };

        const limpiarEventos = () => {
            while (limpiadoresEventos.length) {
                const limpiar = limpiadoresEventos.pop();
                try {
                    limpiar();
                } catch (error) {
                    // Ignorar cleanup defensivo.
                }
            }
        };

        const inferirContenidoCriticoListo = ({ structureReady, busyPending, configReady, logoReady }) => {
            const puedeInferirse = structureReady
                && !busyPending
                && (configReady || estado.ventanaCargada)
                && (logoReady || estado.cacheLogoRealDisponible || estado.permitirFallbackLogo);

            if (!puedeInferirse) {
                estado.estableDesde = 0;
                return false;
            }

            if (!estado.estableDesde) {
                estado.estableDesde = performance.now();
            }

            return performance.now() - estado.estableDesde >= READY_STABLE_MS;
        };

        const obtenerReadiness = () => {
            const elapsed = performance.now() - estado.inicio;
            const configReady = tieneConfigMinima() || estado.configSincronizada;
            const structureReady = tieneEstructuraBase();
            const logoReady = logoCabeceraListo();
            const logoGateReady = logoReady || estado.cacheLogoRealDisponible || estado.permitirFallbackLogo;
            const busyPending = hayPendientesCriticos();
            const criticalContentReady = estado.pageReady || inferirContenidoCriticoListo({
                structureReady,
                busyPending,
                configReady,
                logoReady
            });
            const fallbackContentReady = criticalContentReady || (estado.ventanaCargada && structureReady && !busyPending);
            const canClose = (!busyPending && configReady && logoGateReady && criticalContentReady)
                || (!busyPending && elapsed >= SOFT_FALLBACK_MS && structureReady && fallbackContentReady && (criticalContentReady || configReady || logoGateReady))
                || elapsed >= MAX_WAIT_MS;

            return {
                canClose
            };
        };

        const cerrarShell = () => {
            if (estado.cerrado) return;
            estado.cerrado = true;
            limpiarTimers();
            limpiarEventos();
            actualizarLogoShell();
            actualizarEsloganShell('ready');

            const restante = Math.max(0, MIN_VISIBLE_MS - (performance.now() - estado.mostradoEn));
            window.setTimeout(() => {
                aplicarBodyReady(body);
                overlay.classList.remove('is-visible');
                overlay.classList.add('is-leaving');

                window.setTimeout(() => {
                    overlay.setAttribute('hidden', 'hidden');
                    overlay.classList.remove('is-leaving');
                }, LEAVE_ANIMATION_MS);
            }, restante);
        };

        const evaluar = () => {
            if (estado.cerrado) return true;

            const elapsed = performance.now() - estado.inicio;
            let currentStage = 'default';
            if (elapsed > 3500) currentStage = 'assets';
            else if (elapsed > 1500) currentStage = 'sync';

            actualizarLogoShell();
            actualizarEsloganShell(currentStage);
            actualizarEstadoLogoHeader(body);
            const readiness = obtenerReadiness();

            if (readiness.canClose) {
                cerrarShell();
                return true;
            }

            return false;
        };

        const onConfigSync = () => {
            estado.configSincronizada = true;
            estado.cacheLogoRealDisponible = logoObjetivoVieneDeCacheReal();
            evaluar();
        };

        const onWindowLoad = () => {
            estado.ventanaCargada = true;
            evaluar();
        };

        const onPageReady = () => {
            estado.pageReady = true;
            evaluar();
        };

        actualizarLogoShell();
        actualizarEsloganShell();
        actualizarEstadoLogoHeader(body);

        estado.softFallbackId = window.setTimeout(() => {
            estado.permitirFallbackLogo = true;
            evaluar();
        }, SOFT_FALLBACK_MS);

        estado.forceCloseId = window.setTimeout(() => {
            cerrarShell();
        }, MAX_WAIT_MS);

        estado.intervalId = window.setInterval(() => {
            evaluar();
        }, POLL_INTERVAL_MS);

        limpiadoresEventos.push(crearRegistroEvento(window, 'configSyncCompleto', onConfigSync, { once: true }));
        limpiadoresEventos.push(crearRegistroEvento(window, 'configuracionActualizada', onConfigSync));
        limpiadoresEventos.push(crearRegistroEvento(window, 'load', onWindowLoad, { once: true }));
        limpiadoresEventos.push(crearRegistroEvento(window, 'pageshow', evaluar, { once: true }));
        limpiadoresEventos.push(crearRegistroEvento(window, PAGE_READY_EVENT, onPageReady));

        const headerLogo = obtenerLogoCabecera();
        if (headerLogo) {
            const onHeaderLogoError = () => {
                estado.permitirFallbackLogo = true;
                headerLogo.setAttribute('src', PLACEHOLDER_LOGO);
                actualizarEstadoLogoHeader(body);
                evaluar();
            };

            limpiadoresEventos.push(crearRegistroEvento(headerLogo, 'load', evaluar));
            limpiadoresEventos.push(crearRegistroEvento(headerLogo, 'error', onHeaderLogoError));
        }

        const shellLogo = document.getElementById('rifaplusShellLogo');
        if (shellLogo) {
            const onShellLogoError = () => {
                estado.permitirFallbackLogo = true;
                shellLogo.setAttribute('src', PLACEHOLDER_LOGO);
                actualizarEstadoLogoHeader(body);
                evaluar();
            };

            limpiadoresEventos.push(crearRegistroEvento(shellLogo, 'load', evaluar));
            limpiadoresEventos.push(crearRegistroEvento(shellLogo, 'error', onShellLogoError));
        }

        evaluar();
    });
})();
