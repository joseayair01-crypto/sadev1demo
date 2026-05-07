/**
 * ============================================================
 * ARCHIVO: js/theme-dynamic.js
 * DESCRIPCIÓN: Inyección dinámica de logos y temas desde config
 * Se ejecuta después de config.js para actualizar todos los logos
 * automáticamente sin necesidad de hardcodear rutas
 * ============================================================
 */

(function aplicarLogoCacheadoTemprano() {
    let cachedLogo = window.__RIFAPLUS_CACHED_LOGO__ || '';

    if (!cachedLogo) {
        try {
            cachedLogo = localStorage.getItem('rifaplus_cached_logo') || '';
        } catch (error) {
            cachedLogo = '';
        }
    }

    const defaultLogo = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 240 96'%3E%3Crect width='240' height='96' rx='20' fill='%230b2235'/%3E%3Ctext x='120' y='58' font-size='34' text-anchor='middle' fill='%23ffffff' font-family='Arial,sans-serif'%3ESaDev%3C/text%3E%3C/svg%3E";

    if (!cachedLogo || cachedLogo === 'images/placeholder-logo.svg' || cachedLogo === defaultLogo) {
        return;
    }

    if (window.rifaplusConfig?.cliente) {
        const logoActual = window.rifaplusConfig.cliente.logo || window.rifaplusConfig.cliente.logotipo || '';
        if (!logoActual || logoActual === 'images/placeholder-logo.svg' || logoActual === defaultLogo) {
            window.rifaplusConfig.cliente.logo = cachedLogo;
            window.rifaplusConfig.cliente.logotipo = cachedLogo;
        }
    }

    const aplicarLogoCacheado = () => {
        try {
            const favicon = document.querySelector('link[rel="icon"]');
            if (favicon) favicon.href = cachedLogo;

            const appleTouchIcon = document.querySelector('link[rel="apple-touch-icon"]');
            if (appleTouchIcon) appleTouchIcon.href = cachedLogo;

            const preloadLogo = document.querySelector('link[rel="preload"][as="image"]');
            if (preloadLogo) preloadLogo.href = cachedLogo;

            const candidatos = document.querySelectorAll(
                'img[data-dynamic-logo="true"], img.dynamic-logo, img.footer-logo-img, img.carrito-logo'
            );

            candidatos.forEach((img) => {
                if (!img || img.getAttribute('data-dynamic-logo') === 'false') return;
                img.src = cachedLogo;
                img.setAttribute('data-dynamic-logo', 'true');
                if (!img.classList.contains('dynamic-logo')) {
                    img.classList.add('dynamic-logo');
                }
            });
        } catch (error) {
            console.warn('⚠️ Error aplicando logo cacheado tempranamente:', error?.message || error);
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', aplicarLogoCacheado, { once: true });
    } else {
        aplicarLogoCacheado();
    }
})();

function obtenerLogoCacheadoSeguro() {
    if (window.__RIFAPLUS_CACHED_LOGO__ && window.__RIFAPLUS_CACHED_LOGO__ !== 'images/placeholder-logo.svg') {
        return window.__RIFAPLUS_CACHED_LOGO__;
    }

    try {
        const cachedLogo = localStorage.getItem('rifaplus_cached_logo') || '';
        return cachedLogo && cachedLogo !== 'images/placeholder-logo.svg' ? cachedLogo : '';
    } catch (error) {
        return '';
    }
}

function resolverLogoPreferido(logoPath) {
    const logoNormalizado = String(logoPath || '').trim();
    const cachedLogo = obtenerLogoCacheadoSeguro();

    if (!logoNormalizado || logoNormalizado === 'images/placeholder-logo.svg') {
        return cachedLogo || 'images/placeholder-logo.svg';
    }

    return logoNormalizado;
}

function resolverLogoOptimizado(logoPath, profile = 'logo') {
    const imageDelivery = window.RifaPlusImageDelivery;
    const logoResuelto = resolverLogoPreferido(logoPath);
    return imageDelivery?.resolverUrlImagen(logoResuelto, profile) || logoResuelto;
}

const THEME_DYNAMIC_DEBUG = ['localhost', '127.0.0.1'].includes(window.location.hostname);
let themeDynamicApplyQueued = false;
let themeDynamicLastSignature = '';

function themeDynamicLog(...args) {
    if (THEME_DYNAMIC_DEBUG) {
        console.log(...args);
    }
}

function construirFirmaTema(config = {}) {
    const cliente = config.cliente || {};
    const rifa = config.rifa || {};
    const tema = config.tema || {};

    return JSON.stringify({
        logo: resolverLogoPreferido(cliente.logo || cliente.logotipo),
        clienteNombre: cliente.nombre || '',
        eslogan: cliente.eslogan || '',
        sorteoNombre: rifa.nombreSorteo || '',
        temaPersonalizado: tema.personalizado === true,
        colores: tema.colores || {}
    });
}

function solicitarAplicacionTemaDinamico(force = false) {
    if (themeDynamicApplyQueued) {
        return;
    }

    themeDynamicApplyQueued = true;
    requestAnimationFrame(() => {
        themeDynamicApplyQueued = false;
        applyDynamicTheme(force);
    });
}

(function initDynamicTheme() {
    const inicializar = () => solicitarAplicacionTemaDinamico(true);

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', inicializar, { once: true });
    } else {
        inicializar();
    }

    window.addEventListener('configSyncCompleto', () => solicitarAplicacionTemaDinamico(true));
    window.addEventListener('configuracionActualizada', () => solicitarAplicacionTemaDinamico(true));
})();

/**
 * Aplicar tema dinámico: logo, colores, etc.
 */
function applyDynamicTheme(force = false) {
    if (!window.rifaplusConfig || !window.rifaplusConfig.cliente) {
        return;
    }

    const config = window.rifaplusConfig;
    const signature = construirFirmaTema(config);

    if (!force && signature === themeDynamicLastSignature) {
        return;
    }

    themeDynamicLastSignature = signature;
    const cliente = config.cliente;
    const temaConfig = config.tema || {};
    const tema = construirTemaNormalizado(temaConfig);
    const temaPersonalizadoActivo = temaConfig.personalizado === true;

    themeDynamicLog('🎨 Aplicando tema dinámico desde config...');

    const logoCliente = resolverLogoPreferido(cliente.logo || cliente.logotipo);

    if (cliente && logoCliente && logoCliente !== 'images/placeholder-logo.svg') {
        cliente.logo = logoCliente;
        cliente.logotipo = logoCliente;
    }

    // 1. Actualizar favicon dinámicamente
    updateFavicon(logoCliente);

    // 2. Actualizar todos los logos en la página
    updateAllLogos(logoCliente);

    // 3. Actualizar CSS variables para colores
    if (temaPersonalizadoActivo) {
        updateCSSVariables(tema);
    } else {
        limpiarCSSVariablesTemaPublico();
        themeDynamicLog('🎨 [Theme-Dynamic] Tema personalizado inactivo; se conserva la apariencia pública base');
    }

    // 4. Actualizar título de página
    updatePageTitle(cliente, config.rifa);

    // 5. Actualizar contenido de la página (hero, subtítulos, footer)
    updatePageContent(cliente, config.rifa);

    themeDynamicLog('✅ Tema dinámico aplicado correctamente');
}

/**
 * Actualizar favicon dinámicamente
 * @param {String} logoPath - Ruta del logo desde config
 */
function updateFavicon(logoPath) {
    const logoResuelto = resolverLogoOptimizado(logoPath, 'logoIcon');
    if (!logoResuelto) {
        console.warn('⚠️  Logo no especificado en config');
        return;
    }

    // Buscar o crear link del favicon
    let favicon = document.querySelector('link[rel="icon"]');
    if (!favicon) {
        favicon = document.createElement('link');
        favicon.rel = 'icon';
        document.head.appendChild(favicon);
    }
    favicon.href = logoResuelto;

    // Actualizar apple-touch-icon
    let appleTouchIcon = document.querySelector('link[rel="apple-touch-icon"]');
    if (!appleTouchIcon) {
        appleTouchIcon = document.createElement('link');
        appleTouchIcon.rel = 'apple-touch-icon';
        document.head.appendChild(appleTouchIcon);
    }
    appleTouchIcon.href = logoResuelto;

    themeDynamicLog(`📱 Favicon actualizado: ${logoResuelto}`);
}

/**
 * Actualizar todos los logos en la página
 * Busca imágenes con clase o atributo especial y actualiza src
 * @param {String} logoPath - Ruta del logo
 */
function updateAllLogos(logoPath) {
    const imageDelivery = window.RifaPlusImageDelivery;
    const logoOriginal = resolverLogoPreferido(logoPath);
    const logoResuelto = resolverLogoOptimizado(logoPath, 'logo');
    if (!logoResuelto) return;

    try {
        localStorage.setItem('rifaplus_cached_logo', logoOriginal);
        window.__RIFAPLUS_CACHED_LOGO__ = logoResuelto;
    } catch (error) {
        if (THEME_DYNAMIC_DEBUG) {
            console.warn('⚠️ No se pudo guardar el logo en caché local:', error?.message || error);
        }
    }

    const aplicarLogosEnDom = () => {
        // Actualizar imágenes con clase "dynamic-logo"
        const dynamicLogos = document.querySelectorAll('img[data-dynamic-logo="true"], img.dynamic-logo');
        dynamicLogos.forEach(img => {
            const oldSrc = img.src;
            if (imageDelivery?.aplicarImagenOptimizada) {
                imageDelivery.aplicarImagenOptimizada(img, {
                    originalUrl: logoOriginal,
                    profile: 'logo',
                    widths: [160, 240, 320],
                    sizes: '(max-width: 768px) 160px, 280px',
                    fetchPriority: img.getAttribute('fetchpriority') || 'high',
                    decoding: img.getAttribute('decoding') || 'async',
                    loading: img.getAttribute('loading') || 'eager'
                });
            } else {
                img.src = logoResuelto;
            }
            themeDynamicLog(`🖼️  Logo actualizado: ${oldSrc} → ${logoResuelto}`);
        });

        // Fallback: si hay imágenes con src hardcodeado a logos antiguos, reemplazarlas
        const fallbackLogos = [
            'images/placeholder-logo.svg',
            'images/logo-anterior.png',
            'images/logo.webp'
        ];

        fallbackLogos.forEach(oldLogo => {
            const imgs = document.querySelectorAll(`img[src="${oldLogo}"]`);
            imgs.forEach(img => {
                if (img.getAttribute('data-dynamic-logo') !== 'false') { // Excluir si está marcado como estático
                    if (imageDelivery?.aplicarImagenOptimizada) {
                        imageDelivery.aplicarImagenOptimizada(img, {
                            originalUrl: logoOriginal,
                            profile: 'logo',
                            widths: [160, 240, 320],
                            sizes: '(max-width: 768px) 160px, 280px',
                            fetchPriority: img.getAttribute('fetchpriority') || 'high',
                            decoding: img.getAttribute('decoding') || 'async',
                            loading: img.getAttribute('loading') || 'eager'
                        });
                    } else {
                        img.src = logoResuelto;
                    }
                    img.setAttribute('data-dynamic-logo', 'true');
                    themeDynamicLog(`🖼️  Logo fallback actualizado: ${oldLogo} → ${logoResuelto}`);
                }
            });
        });

        // ✅ MEJORA PREMIUM: Actualizar también la imagen del loader-shell si sigue en pantalla
        const shellLogo = document.getElementById('rifaplusShellLogo');
        if (shellLogo) {
            shellLogo.src = logoResuelto;
            shellLogo.style.opacity = '1';
        }
    };

    // ✅ RENDIMIENTO CRÍTICO: Si el logo es una URL remota y no está cargado aún,
    // pre-cargarlo en memoria para evitar el parpadeo blanco ("blank space/empty circle")
    if (logoResuelto && !logoResuelto.startsWith('data:')) {
        const preloader = new Image();
        preloader.src = logoResuelto;
        if (preloader.complete) {
            aplicarLogosEnDom();
        } else {
            preloader.onload = aplicarLogosEnDom;
            preloader.onerror = aplicarLogosEnDom; // Fallback ante error de red
        }
    } else {
        aplicarLogosEnDom();
    }
}

/**
 * Actualizar variables CSS con colores del tema
 * @param {Object} tema - Objeto de colores del tema
 */
function updateCSSVariables(tema) {
    if (!tema || typeof tema !== 'object') return;

    const esAdmin = /\/admin-[^/]+\.html$/i.test(window.location.pathname) || /^admin-[^/]+\.html$/i.test(window.location.pathname.split('/').pop() || '');
    if (esAdmin) {
        console.log('🎛️ [Theme-Dynamic] Colores dinámicos omitidos en admin para preservar tema fijo');
        return;
    }

    const root = document.documentElement;

    // Mapear colores del config a variables CSS
    const colorMap = {
        primary: '--primary',
        primaryDark: '--primary-dark',
        primaryLight: '--primary-light',
        secondary: '--secondary',
        success: '--success',
        danger: '--danger',
        textDark: '--text-dark',
        textLight: '--text-light',
        bgLight: '--bg-light',
        bgWhite: '--bg-white',
        borderColor: '--border-color'
    };

    Object.entries(colorMap).forEach(([configKey, cssVar]) => {
        if (tema[configKey]) {
            root.style.setProperty(cssVar, tema[configKey]);
            console.log(`🎨 CSS var ${cssVar} = ${tema[configKey]}`);
        }
    });

    const primaryRgb = hexToRgbSeguro(tema.primary || '#0b2238');
    root.style.setProperty('--primary-rgb', `${primaryRgb.r}, ${primaryRgb.g}, ${primaryRgb.b}`);
    const secondaryRgb = hexToRgbSeguro(tema.secondary || '#1fd1c2');
    root.style.setProperty('--secondary-rgb', `${secondaryRgb.r}, ${secondaryRgb.g}, ${secondaryRgb.b}`);
    [5, 8, 10, 12, 15, 18, 20, 25, 30, 35, 40].forEach((nivel) => {
        root.style.setProperty(`--primary-${String(nivel).padStart(2, '0')}`, `rgba(${primaryRgb.r}, ${primaryRgb.g}, ${primaryRgb.b}, ${nivel / 100})`);
    });

    const bgWhite = normalizarHexColorSeguro(tema.bgWhite || '#ffffff');
    const bgLight = normalizarHexColorSeguro(tema.bgLight || '#f4f8fb');
    const primary = normalizarHexColorSeguro(tema.primary || '#0b2238');
    const primaryDark = normalizarHexColorSeguro(tema.primaryDark || ajustarLuminosidadHex(primary, -0.22));
    const secondary = normalizarHexColorSeguro(tema.secondary || '#1fd1c2');
    const headerSolid = primary;

    root.style.setProperty('--surface-base', bgWhite);
    root.style.setProperty('--surface-soft', bgLight);
    root.style.setProperty('--surface-tint', mezclarColoresHex(primary, bgWhite, 0.9));
    root.style.setProperty('--surface-accent', mezclarColoresHex(secondary, bgWhite, 0.87));
    root.style.setProperty('--surface-header', headerSolid);
    root.style.setProperty('--card-bg', bgWhite);
    root.style.setProperty('--card-bg-soft', `linear-gradient(180deg, ${bgWhite}, ${bgLight})`);
    root.style.setProperty(
        '--section-bg-primary',
        `linear-gradient(180deg, ${mezclarColoresHex(primary, bgWhite, 0.08)} 0%, ${mezclarColoresHex(primary, bgWhite, 0.18)} 42%, ${mezclarColoresHex(primary, bgWhite, 0.34)} 100%)`
    );
    root.style.setProperty(
        '--section-bg-soft',
        `linear-gradient(180deg, ${bgWhite} 0%, ${mezclarColoresHex(primary, bgWhite, 0.92)} 100%)`
    );
    root.style.setProperty(
        '--section-bg-warm',
        `linear-gradient(180deg, ${mezclarColoresHex(primary, bgWhite, 0.93)} 0%, ${mezclarColoresHex(primary, bgWhite, 0.88)} 100%)`
    );
    root.style.setProperty('--header-bg', headerSolid);
    root.style.setProperty('--header-border', 'rgba(255, 255, 255, 0.14)');
    root.style.setProperty('--header-ink', asegurarContrasteTexto('#f8fbff', primary, 4.5));
    root.style.setProperty('--header-control-bg', 'rgba(255, 255, 255, 0.08)');
    root.style.setProperty('--header-control-border', 'rgba(255, 255, 255, 0.18)');
    root.style.setProperty('--header-hover-bg', 'rgba(255, 255, 255, 0.10)');
    root.style.setProperty('--header-hover-ink', '#ffffff');
    root.style.setProperty('--hero-tint-primary', `rgba(${primaryRgb.r}, ${primaryRgb.g}, ${primaryRgb.b}, 0.50)`);
    root.style.setProperty('--hero-tint-secondary', `rgba(${secondaryRgb.r}, ${secondaryRgb.g}, ${secondaryRgb.b}, 0.35)`);
    root.style.setProperty('--hero-cta-shadow', `0 12px 26px rgba(${primaryRgb.r}, ${primaryRgb.g}, ${primaryRgb.b}, 0.18)`);
    root.style.setProperty('--hero-cta-shadow-hover', `0 14px 30px rgba(${primaryRgb.r}, ${primaryRgb.g}, ${primaryRgb.b}, 0.22)`);
    root.style.setProperty('--price-badge-bg', '#161616');
    root.style.setProperty('--price-highlight-bg', mezclarColoresHex(secondary, bgWhite, 0.87));
    root.style.setProperty('--price-card-bg', 'linear-gradient(180deg, #191919 0%, #050505 100%)');
    root.style.setProperty('--price-card-border', 'rgba(255, 255, 255, 0.12)');
    root.style.setProperty('--price-card-shadow', '0 18px 36px rgba(0, 0, 0, 0.28)');
    root.style.setProperty('--price-card-shadow-hover', '0 24px 46px rgba(0, 0, 0, 0.38)');

    const priceMainColor = asegurarContrasteTexto('#ffffff', primaryDark, 4.5);
    const priceKickerBg = mezclarColoresHex(primary, bgWhite, 0.12);
    const priceOfferPanelBg = mezclarColoresHex(primary, bgWhite, 0.18);
    const priceVigenciaBg = mezclarColoresHex(primary, bgWhite, 0.92);
    const priceVigenciaText = asegurarContrasteTexto(primaryDark, priceVigenciaBg, 4.5);

    root.style.setProperty('--price-kicker-color', asegurarContrasteTexto('#eef6ff', primary, 3.6));
    root.style.setProperty('--price-title-color', priceMainColor);
    root.style.setProperty('--price-main-color', priceMainColor);
    root.style.setProperty('--price-caption-color', asegurarContrasteTexto('#e5eef6', primaryDark, 3.2));
    root.style.setProperty('--price-old-color', asegurarContrasteTexto('#f3f6fb', primary, 3.1));
    root.style.setProperty('--price-offer-panel-bg', priceOfferPanelBg);
    root.style.setProperty('--price-offer-panel-border', `rgba(${primaryRgb.r}, ${primaryRgb.g}, ${primaryRgb.b}, 0.20)`);
    root.style.setProperty('--price-offer-label-color', asegurarContrasteTexto('#f6fbff', priceOfferPanelBg, 4.0));
    root.style.setProperty('--price-offer-value-color', asegurarContrasteTexto('#ffffff', priceOfferPanelBg, 4.5));
    root.style.setProperty('--price-vigencia-bg', priceVigenciaBg);
    root.style.setProperty('--price-vigencia-border', 'rgba(0, 0, 0, 0.12)');
    root.style.setProperty('--price-vigencia-text', asegurarContrasteTexto('#1b1b1b', priceVigenciaBg, 4.5));
}

function limpiarCSSVariablesTemaPublico() {
    const root = document.documentElement;
    const variables = [
        '--primary',
        '--primary-dark',
        '--primary-light',
        '--secondary',
        '--success',
        '--danger',
        '--text-dark',
        '--text-light',
        '--bg-light',
        '--bg-white',
        '--border-color',
        '--primary-rgb',
        '--secondary-rgb',
        '--primary-05',
        '--primary-08',
        '--primary-10',
        '--primary-12',
        '--primary-15',
        '--primary-18',
        '--primary-20',
        '--primary-25',
        '--primary-30',
        '--primary-35',
        '--primary-40',
        '--surface-base',
        '--surface-soft',
        '--surface-tint',
        '--surface-accent',
        '--surface-header',
        '--card-bg',
        '--card-bg-soft',
        '--section-bg-primary',
        '--section-bg-soft',
        '--section-bg-warm',
        '--header-bg',
        '--header-border',
        '--header-ink',
        '--header-control-bg',
        '--header-control-border',
        '--header-hover-bg',
        '--header-hover-ink',
        '--hero-tint-primary',
        '--hero-tint-secondary',
        '--hero-cta-shadow',
        '--hero-cta-shadow-hover',
        '--price-badge-bg',
        '--price-highlight-bg',
        '--price-card-bg',
        '--price-card-border',
        '--price-card-shadow',
        '--price-card-shadow-hover',
        '--price-kicker-color',
        '--price-title-color',
        '--price-main-color',
        '--price-caption-color',
        '--price-old-color',
        '--price-offer-panel-bg',
        '--price-offer-panel-border',
        '--price-offer-label-color',
        '--price-offer-value-color',
        '--price-vigencia-bg',
        '--price-vigencia-border',
        '--price-vigencia-text'
    ];

    variables.forEach((variable) => root.style.removeProperty(variable));
}

function normalizarHexColorSeguro(valor, fallback = '#0b2238') {
    const limpio = String(valor || '').trim();
    const match = limpio.match(/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
    if (!match) return fallback;
    const hex = match[1];
    if (hex.length === 3) {
        return `#${hex.split('').map((char) => char + char).join('').toLowerCase()}`;
    }
    return `#${hex.toLowerCase()}`;
}

function hexToRgbSeguro(hex) {
    const normalizado = normalizarHexColorSeguro(hex);
    const valor = normalizado.slice(1);
    return {
        r: parseInt(valor.slice(0, 2), 16),
        g: parseInt(valor.slice(2, 4), 16),
        b: parseInt(valor.slice(4, 6), 16)
    };
}

function rgbToHexSeguro({ r, g, b }) {
    const toHex = (value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function mezclarColoresHex(colorA, colorB, porcentajeB = 0.5) {
    const a = hexToRgbSeguro(colorA);
    const b = hexToRgbSeguro(colorB);
    const ratio = Math.max(0, Math.min(1, porcentajeB));
    return rgbToHexSeguro({
        r: a.r + ((b.r - a.r) * ratio),
        g: a.g + ((b.g - a.g) * ratio),
        b: a.b + ((b.b - a.b) * ratio)
    });
}

function ajustarLuminosidadHex(color, factor = 0) {
    return factor >= 0
        ? mezclarColoresHex(color, '#ffffff', factor)
        : mezclarColoresHex(color, '#000000', Math.abs(factor));
}

function luminanciaRelativa(color) {
    const { r, g, b } = hexToRgbSeguro(color);
    const canal = (valor) => {
        const normalizado = valor / 255;
        return normalizado <= 0.03928
            ? normalizado / 12.92
            : ((normalizado + 0.055) / 1.055) ** 2.4;
    };
    return (0.2126 * canal(r)) + (0.7152 * canal(g)) + (0.0722 * canal(b));
}

function obtenerContraste(colorA, colorB) {
    const l1 = luminanciaRelativa(colorA);
    const l2 = luminanciaRelativa(colorB);
    const claro = Math.max(l1, l2);
    const oscuro = Math.min(l1, l2);
    return (claro + 0.05) / (oscuro + 0.05);
}

function asegurarContrasteTexto(textoPreferido, fondo, minimo = 4.5) {
    const preferido = normalizarHexColorSeguro(textoPreferido, '#0f172a');
    if (obtenerContraste(preferido, fondo) >= minimo) return preferido;

    const opcionOscura = '#0f172a';
    const opcionClara = '#ffffff';
    return obtenerContraste(opcionClara, fondo) > obtenerContraste(opcionOscura, fondo)
        ? opcionClara
        : opcionOscura;
}

function construirTemaNormalizado(temaRaw = {}) {
    const coloresRaw = temaRaw.colores || {};
    const colorPrimario = normalizarHexColorSeguro(
        temaRaw.colorPrimario || coloresRaw.colorPrimario || coloresRaw.primary,
        '#0b2238'
    );
    const colorAcento = normalizarHexColorSeguro(
        temaRaw.colorAcento || coloresRaw.colorAccento || coloresRaw.colorSecundario || coloresRaw.secondary,
        '#1fd1c2'
    );
    const colorFondo = normalizarHexColorSeguro(
        temaRaw.colorFondo || coloresRaw.colorFondo || coloresRaw.bgLight,
        '#f4f8fb'
    );
    const colorSuperficie = normalizarHexColorSeguro(
        temaRaw.colorSuperficie || coloresRaw.colorSuperficie || coloresRaw.bgWhite,
        '#ffffff'
    );
    const colorTexto = asegurarContrasteTexto(
        temaRaw.colorTexto || coloresRaw.colorTexto || coloresRaw.textDark || colorAcento,
        colorSuperficie
    );
    const colorTextoSecundario = asegurarContrasteTexto(
        coloresRaw.colorTextoSecundario || coloresRaw.textLight || mezclarColoresHex(colorTexto, colorSuperficie, 0.42),
        colorSuperficie,
        3.6
    );

    return {
        personalizado: temaRaw.personalizado === true,
        colorPrimario,
        colorAcento,
        colorFondo,
        colorSuperficie,
        colorTexto,
        primary: coloresRaw.primary || colorPrimario,
        primaryDark: coloresRaw.primaryDark || ajustarLuminosidadHex(colorPrimario, -0.22),
        primaryLight: coloresRaw.primaryLight || mezclarColoresHex(colorPrimario, colorSuperficie, 0.82),
        secondary: coloresRaw.secondary || colorAcento,
        success: coloresRaw.success || '#1aa772',
        danger: coloresRaw.danger || '#f3a64a',
        textDark: coloresRaw.textDark || colorTexto,
        textLight: coloresRaw.textLight || colorTextoSecundario,
        bgLight: coloresRaw.bgLight || colorFondo,
        bgWhite: coloresRaw.bgWhite || colorSuperficie,
        borderColor: coloresRaw.borderColor || mezclarColoresHex(colorTexto, colorSuperficie, 0.84)
    };
}

/**
 * Actualizar título de la página dinámicamente
 * @param {Object} cliente - Datos del cliente
 * @param {Object} rifa - Datos de la rifa
 */
function updatePageTitle(cliente, rifa) {
    const rutaActual = String(window.location.pathname || '').toLowerCase();
    const esRutaAdmin = /\/admin(?:-|\/|$)/.test(rutaActual);
    const marcaAdmin = String(cliente?.id || cliente?.nombre || cliente?.eslogan || 'SaDev')
        .replace(/^(aqui va|aquí va)/i, '')
        .replace(/^sorteos?\s+/i, '')
        .replace(/\s+-\s+admin$/i, '')
        .trim() || 'SaDev';

    const tituloResuelto = esRutaAdmin
        ? `Panel Admin - ${marcaAdmin}`
        : typeof window.rifaplusResolverTituloPagina === 'function'
            ? window.rifaplusResolverTituloPagina(window.rifaplusConfig || { cliente, rifa })
            : (rifa && rifa.nombreSorteo)
                ? rifa.nombreSorteo
                : (cliente && cliente.nombre) || document.title;

    if (tituloResuelto) {
        document.title = tituloResuelto;
    }

    // Actualizar meta description usando la descripción del sorteo si existe
    const metaDesc = document.querySelector('meta[name="description"]');
    if (metaDesc) {
        if (rifa && rifa.descripcion) {
            metaDesc.content = rifa.descripcion;
        } else if (cliente && cliente.nombre) {
            metaDesc.content = `${cliente.nombre} - Rifas 100% Transparentes`;
        }
    }

    console.log('📄 Título actualizado:', document.title);
}

/**
 * Actualizar contenido visible en la página: hero, subtítulos y footer
 */
function updatePageContent(cliente, rifa) {
    try {
        // Hero
        const heroTitle = document.getElementById('heroTitle');
        const heroHighlight = document.getElementById('heroHighlight');
        const heroDescription = document.getElementById('heroDescription');
        if (heroTitle && rifa && rifa.nombreSorteo) {
            // Usar exactamente el título definido en config (sin prefijos)
            heroTitle.innerHTML = `<span class="highlight" id="heroHighlight">${rifa.nombreSorteo}</span>`;
        } else if (heroHighlight && rifa && rifa.nombreSorteo) {
            heroHighlight.textContent = rifa.nombreSorteo;
        }
        if (heroDescription && rifa && rifa.descripcion) {
            heroDescription.textContent = rifa.descripcion;
        }

        // Countdown subtitle
        const countdownSubtitle = document.getElementById('countdownSubtitle');
        if (countdownSubtitle && rifa && rifa.descripcion) {
            countdownSubtitle.innerHTML = `La cuenta regresiva para el sorteo: ${rifa.nombreSorteo} ya está en marcha. <strong>Asegura tu participación antes del cierre del sorteo.</strong>`;
        }

        // Footer nombre y copyright
        const footerNombre = document.getElementById('footerNombre');
        if (footerNombre && cliente && cliente.nombre) {
            footerNombre.textContent = cliente.nombre;
        }
        const footerCopyright = document.getElementById('footerCopyright');
        if (footerCopyright && cliente && cliente.nombre) {
            const year = (new Date()).getFullYear();
            footerCopyright.innerHTML = `&copy; ${year} <strong>${cliente.nombre}</strong>. Todos los derechos reservados.`;
        }

    } catch (err) {
        console.warn('⚠️ Error actualizando contenido de la página:', err && err.message);
    }
}

// Exportar funciones para uso manual si es necesario
window.applyDynamicTheme = applyDynamicTheme;
window.updateAllLogos = updateAllLogos;
window.updateCSSVariables = updateCSSVariables;
