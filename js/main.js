// ============================================================ //
// ARCHIVO: main.js
// DESCRIPCIÓN: Inicializador global de funcionalidades del sitio
// AUTOR: RifaPlus
// ÚLTIMA ACTUALIZACIÓN: 1 de diciembre 2025
// ============================================================ //

/**
 * 🆕 VARIABLES GLOBALES: Inicialirar antes de cualquier carga asincrónica
 * Esto permite que las funciones que dependen de estas variables no fallen
 */
window.rifaplusOportunidadesDisponiblesReal = []; // DATOS FRESCOS DEL BACKEND
window.rifaplusBoletosDatosActualizados = false;  // Flag de sincronización
window.rifaplusOportunidadesLoaded = false;       // Flag de carga completada
window.rifaplusOportunidadesLoading = false;      // Flag de carga en progreso (previene race conditions)
window.rifaplusOportunidadesCargandoTimeout = null; // Timeout para resetear flag si se queda stuck
window.rifaplusOportunidadesStartTime = null;    // Timestamp de inicio de carga (para timeout en flujo-compra.js)

const RIFAPLUS_EVENT_OPTS = Object.freeze({
    passive: { passive: true },
    passiveOnce: { passive: true, once: true }
});

function esPaginaPublicaRifaPlus() {
    const pathname = String(window.location.pathname || '').toLowerCase();
    const filename = pathname.split('/').pop() || '';
    return !filename.startsWith('admin-') && !pathname.includes('/admin');
}

function asegurarModalSorteoFinalizadoDisponible() {
    if (!esPaginaPublicaRifaPlus()) {
        return Promise.resolve(null);
    }

    if (window.modalSorteoFinalizado) {
        return Promise.resolve(window.modalSorteoFinalizado);
    }

    if (window.__RIFAPLUS_MODAL_FINALIZADO_LOADING__) {
        return window.__RIFAPLUS_MODAL_FINALIZADO_LOADING__;
    }

    const scriptExistente = document.querySelector('script[src*="js/modal-sorteo-finalizado.js"]');
    if (scriptExistente) {
        window.__RIFAPLUS_MODAL_FINALIZADO_LOADING__ = new Promise((resolve) => {
            if (window.modalSorteoFinalizado) {
                resolve(window.modalSorteoFinalizado);
                return;
            }

            scriptExistente.addEventListener('load', () => resolve(window.modalSorteoFinalizado || null), { once: true });
            scriptExistente.addEventListener('error', () => resolve(null), { once: true });
        }).finally(() => {
            window.__RIFAPLUS_MODAL_FINALIZADO_LOADING__ = null;
        });

        return window.__RIFAPLUS_MODAL_FINALIZADO_LOADING__;
    }

    window.__RIFAPLUS_MODAL_FINALIZADO_LOADING__ = new Promise((resolve) => {
        const script = document.createElement('script');
        script.src = 'js/modal-sorteo-finalizado.js?v=20260408.1';
        script.defer = true;
        script.onload = () => resolve(window.modalSorteoFinalizado || null);
        script.onerror = () => {
            console.warn('⚠️ No se pudo cargar js/modal-sorteo-finalizado.js');
            resolve(null);
        };
        document.head.appendChild(script);
    }).finally(() => {
        window.__RIFAPLUS_MODAL_FINALIZADO_LOADING__ = null;
    });

    return window.__RIFAPLUS_MODAL_FINALIZADO_LOADING__;
}

function addPassiveListener(target, eventName, handler, extraOptions) {
    if (!target || typeof target.addEventListener !== 'function') {
        return;
    }

    const options = extraOptions
        ? { passive: true, ...extraOptions }
        : RIFAPLUS_EVENT_OPTS.passive;

    target.addEventListener(eventName, handler, options);
}

/**
 * 🔥 CRÍTICO: Cargar resumen público al iniciar index.html
 * Para sorteos grandes, evita bajar arrays completos innecesarios.
 */
(async function cargarBoletosEnIndexHtml() {
    try {
        const mostrarBarraProgreso = window.rifaplusConfig?.rifa?.publicacion?.progressBar !== false;
        const necesitaResumenPublico = !!document.querySelector('.progress-stats')
            || !!document.getElementById('boletos-vendidos')
            || !!document.getElementById('progress-fill');

        if (!necesitaResumenPublico || !mostrarBarraProgreso) {
            console.debug('[main] Resumen público omitido: la página no tiene barra de progreso');
            return;
        }

        const apiBase = (window.rifaplusConfig && window.rifaplusConfig.backend && window.rifaplusConfig.backend.apiBase) 
            ? window.rifaplusConfig.backend.apiBase 
            : 'http://localhost:3000';
        const endpoint = String(apiBase).replace(/\/+$/, '');
        
        console.debug('[main] Cargando boletos públicos para progreso bar...');
        
        // 🎯 CACHÉ OPTIMIZADO: Solo almacena resumen (50 bytes), no arrays (262 KB)
        const cacheKey = 'rifaplusBoletosCache';
        const cachedData = localStorage.getItem(cacheKey);
        
        if (cachedData && window.rifaplusBoletosLoaded) {
            try {
                const cached = JSON.parse(cachedData);
                const cacheAge = Date.now() - (cached.timestamp || 0);
                
                if (cacheAge < 300000) { // 5 minutos
                    // Caché de resumen NO contiene arrays, solo contadores
                    // Los arrays frescos se obtienen del backend
                    console.debug('[main] Resumen caché (edad: ' + Math.round(cacheAge/1000) + 's): ' + cached.apartados + ' apartados');
                    window.rifaplusBoletosLoaded = true;
                    
                    // DISPARA EVENTO para que countdown.js actualice la barra
                    window.dispatchEvent(new CustomEvent('boletosListos', { detail: { origen: 'cache' } }));
                    return; // Resumen listo
                }
            } catch (e) {
                console.warn('[main] Error parseando caché resumen:', e.message);
            }
        }
        
        // 🎯 FETCH LIVIANO: Usar stats para no descargar arrays completos en el index
        console.debug('[main] Fetch desde backend para resumen de boletos...');
        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
            controller.abort();
            console.warn('[main] ⏱️ Timeout alcanzado (10s) - Abortando fetch de resumen de boletos');
        }, 10000);

        try {
            const response = await fetch(`${endpoint}/api/public/boletos/stats`, {
                signal: controller.signal,
                cache: 'no-store',
                headers: { 'Accept': 'application/json' }
            });
            
            clearTimeout(timeoutId);
            
            if (!response.ok) {
                console.warn('[main] Error cargando resumen de boletos:', response.status);
                window.rifaplusSoldNumbers = [];
                window.rifaplusReservedNumbers = [];
                window.rifaplusBoletosLoaded = true;
                window.dispatchEvent(new CustomEvent('boletosListos', { detail: { origen: 'backend-error' } }));
                return;
            }
            
            const json = await response.json();
            const data = json.data || {};
            const vendidos = Number(data.vendidos) || 0;
            const apartados = Number(data.apartados) || 0;
            const disponibles = Number(data.disponibles) || 0;
            
            window.rifaplusSoldNumbers = [];
            window.rifaplusReservedNumbers = [];
            window.rifaplusBoletosLoaded = true;

            if (window.rifaplusConfig?.estado) {
                window.rifaplusConfig.estado.boletosVendidos = vendidos;
                window.rifaplusConfig.estado.boletosApartados = apartados;
                window.rifaplusConfig.estado.boletosDisponibles = disponibles;
            }
            
            // OPTIMIZADO: Guardar SOLO resumen (50 bytes) en lugar de arrays (262 KB)
            try {
                const totalBoletosActual = typeof window.rifaplusConfig?.obtenerTotalBoletos === 'function'
                    ? window.rifaplusConfig.obtenerTotalBoletos()
                    : Number(window.rifaplusConfig?.rifa?.totalBoletos || 0);
                const cacheData = JSON.stringify({
                    vendidos,
                    apartados,
                    disponibles: disponibles || Math.max(0, totalBoletosActual - vendidos - apartados),
                    timestamp: Date.now()
                });
                
                localStorage.setItem(cacheKey, cacheData);
                console.debug('[main] Cache resumen guardado (' + (cacheData.length / 1024).toFixed(2) + 'KB)');
            } catch (storageError) {
                console.debug('[main] Caché resumen no guardado, pero datos del backend frescos');
            }
            
            console.debug('[main] ✅ Resumen cargado:', { vendidos, apartados, disponibles });
            
            // 🔥 DISPARA EVENTO para que countdown.js actualice la barra
            window.dispatchEvent(new CustomEvent('boletosListos', { detail: { origen: 'backend', sold: vendidos, reserved: apartados } }));
        } catch (error) {
            clearTimeout(timeoutId);
            
            // Checa si fue un timeout (AbortError)
            const isTimeoutError = error.name === 'AbortError';
            const errorMsg = isTimeoutError 
                ? 'Timeout al cargar resumen de boletos (servidor lento)'
                : error.message || 'Error desconocido';
            
            console.warn('[main] Error fetch boletos:', errorMsg, { 
                isTimeout: isTimeoutError, 
                errorName: error.name 
            });
            
            window.rifaplusSoldNumbers = [];
            window.rifaplusReservedNumbers = [];
            window.rifaplusBoletosLoaded = true;
            window.dispatchEvent(new CustomEvent('boletosListos', { detail: { origen: 'error', message: errorMsg } }));
        }
    } catch (error) {
        console.error('[main] Error en cargarBoletosEnIndexHtml:', error);
    }
})();

/**
 * ESTRUCTURA DE PROMOCIONES (PAQUETES FIJOS):
 * - Paquete 10: 10 boletos por $450 (ahorro de $50)
 * - Paquete 20: 20 boletos por $800 (ahorro de $200)
 * - Boletos sueltos: Resto a precio normal $50 c/u
 * 
 * EJEMPLOS DE CÁLCULO:
 * - 10 boletos = $450 (promo)
 * - 11 boletos = $450 (promo 10) + $50 (1 suelto) = $500
 * - 15 boletos = $450 (promo 10) + $250 (5 sueltos) = $700
 * - 20 boletos = $800 (promo)
 * - 21 boletos = $800 (promo 20) + $50 (1 suelto) = $850
 * - 30 boletos = $800 (promo 20) + $500 (10 sueltos) = $1300
 */

// ============================================================ //
// SECCIÓN 1: NORMALIZACIÓN DE CONFIGURACIÓN
// NOTA: config.js debe estar cargado ANTES que main.js
// Todas las variables se leen desde config.js
// ============================================================ //

/**
 * Normalizar la fecha del sorteo a timestamp (milisegundos)
 * Maneja diferentes formatos y zonas horarias
 * NOTA: Puede retornar sin hacer nada si la sincronización aún está en progreso
 */
(function normalizarFechaSorteo() {
    try {
        const timestampSorteo = window.rifaplusConfig?.obtenerTimestampSorteo?.();
        if (!timestampSorteo) {
            console.debug('⏳ fechaSorteo aún no sincronizada desde servidor');
            return;
        }

        const fechaParsada = new Date(timestampSorteo);
        window.rifaplusConfig.timestampSorteo = timestampSorteo;
        console.log('✓ Timestamp del sorteo calculado:', fechaParsada.toISOString(), '(', timestampSorteo, ')');
    } catch (error) {
        console.warn('⚠️ Error normalizando fecha del sorteo:', error);
    }
})();

// ============================================================
// SINCRONIZAR `sorteoActivo.fechaCierre` CON `rifa.fechaSorteo`
// Si el administrador actualizó la fecha en la sección `rifa`,
// forzamos que `sorteoActivo.fechaCierre` refleje la misma fecha
// para evitar inconsistencias entre countdown y modal.
// ============================================================
(function sincronizarSorteoActivoConRifa() {
    try {
        const rifaFecha = window.rifaplusConfig?.rifa?.fechaSorteo;
        const sorteo = window.rifaplusConfig?.sorteoActivo;
        const timestampRifa = window.rifaplusConfig?.obtenerTimestampSorteo?.();

        if (!rifaFecha || !sorteo || !timestampRifa) return;

        const fechaRifa = new Date(timestampRifa);

        const fechaSorteoActivo = new Date(sorteo.fechaCierre);
        const descriptorFechaCierre = Object.getOwnPropertyDescriptor(sorteo, 'fechaCierre')
            || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(sorteo) || {}, 'fechaCierre');
        const puedeAsignarFechaCierre = !descriptorFechaCierre || descriptorFechaCierre.writable || descriptorFechaCierre.set;

        // Si hay diferencia mayor a 1s o el valor actual no es válido, sincronizamos
        if (isNaN(fechaSorteoActivo.getTime()) || Math.abs(fechaSorteoActivo.getTime() - fechaRifa.getTime()) > 1000) {
            if (puedeAsignarFechaCierre) {
                sorteo.fechaCierre = fechaRifa.toISOString();
            }
            sorteo.fechaCierreFormato = window.rifaplusConfig?.obtenerFechaSorteoFormato?.() || window.rifaplusConfig?.rifa?.fechaSorteoFormato || fechaRifa.toLocaleString('es-MX');
            console.log('🔄 Sincronizado sorteoActivo desde rifa.fechaSorteo ->', sorteo.fechaCierre);
        }
    } catch (err) {
        console.warn('⚠️ Error sincronizando sorteoActivo con rifa:', err && err.message);
    }
})();

/**
 * Normalizar la configuración de la API
 * Evita inconsistencias en la URL entre módulos
 */
(function normalizarConfiguracionAPI() {
    try {
        let puntoFinal = String(window.rifaplusConfig.apiEndpoint || 'http://localhost:3000');
        
        // Remover slashes al final
        puntoFinal = puntoFinal.replace(/\/+$/, '');

        window.rifaplusConfig.apiEndpoint = puntoFinal;
        window.rifaplusConfig.baseAPI = puntoFinal.replace(/\/api$/, '');

        /**
         * Helper para construir URLs de API
         * @param {string} ruta - Ruta del endpoint (ej: '/ordenes')
         * @returns {string} URL completa del endpoint
         */
        window.rifaplusConfig.construirURLAPI = function(ruta) {
            if (!ruta) return puntoFinal;
            
            const rutaNormalizada = ruta.startsWith('/') ? ruta : '/' + ruta;
            
            // Evitar duplicar /api
            if (rutaNormalizada.startsWith('/api')) {
                return window.rifaplusConfig.baseAPI + rutaNormalizada;
            }
            
            return window.rifaplusConfig.apiEndpoint + rutaNormalizada;
        };
    } catch (error) {
        console.warn('⚠️ Error normalizando configuración API:', error);
    }
})();

// ============================================================ //
// SECCIÓN 3: UTILIDADES GLOBALES
// ============================================================ //

/**
 * Sistema de utilidades disponible globalmente
 * Proporciona funciones comunes reutilizables
 */
window.utilidadesRifaPlus = {
    /**
     * Mostrar estado de carga
     * @param {HTMLElement} elemento - Elemento a marcar como cargando
     */
    mostrarCarga: function(elemento) {
        if (elemento) {
            elemento.classList.add('cargando');
        }
    },

    /**
     * Ocultar estado de carga
     * @param {HTMLElement} elemento - Elemento a dejar de marcar como cargando
     */
    ocultarCarga: function(elemento) {
        if (elemento) {
            elemento.classList.remove('cargando');
        }
    },

    /**
     * Mostrar mensaje de retroalimentación al usuario
     * @param {string} mensaje - Texto a mostrar
     * @param {string} tipo - Tipo: 'exito', 'error', 'advertencia'
     */
    mostrarRetroalimentacion: function(mensaje, tipo = 'exito') {
        const elemento = document.createElement('div');
        elemento.className = `retroalimentacion retroalimentacion--${tipo}`;
        elemento.textContent = mensaje;
        document.body.appendChild(elemento);

        setTimeout(() => {
            elemento.style.animation = 'desaparecerDerecha 0.2s forwards';
            setTimeout(() => elemento.remove(), 200);
        }, 3000);
    },

    /**
     * FUNCIÓN CRÍTICA: Calcula el precio con paquetes promocionales
     * Lee promociones dinámicamente desde config.js
     * 
     * ALGORITMO:
     * 1. Obtiene promociones de config.rifa.promociones (ordenadas por cantidad descendente)
     * 2. Aplica cada promoción de mayor a menor cantidad
     * 3. Boletos restantes se cobran a precio normal ($50)
     * 
     * @param {number} cantidad - Cantidad de boletos
     * @param {number} precioUnitario - Precio por boleto (default: $50)
     * @returns {object} Desglose completo del precio
     */
    calcularPrecioConDescuento: function(cantidad, precioUnitario = null) {
        if (typeof calcularTotalConPromociones === 'function') {
            const resultado = calcularTotalConPromociones(cantidad, precioUnitario);
            return {
                cantidadBoletos: resultado.cantidadBoletos,
                precioUnitario: resultado.precioUnitario,
                subtotal: resultado.subtotal,
                montoDescuento: resultado.descuentoMonto,
                porcentajeDescuento: resultado.descuentoPorcentaje,
                precioFinal: resultado.totalFinal
            };
        }

        if (!precioUnitario) {
            precioUnitario = window.rifaplusConfig?.obtenerPrecioBoleto?.()
                || Number(window.rifaplusConfig?.rifa?.precioBoleto || 0);
        }
        let precioTotal = 0;
        let montoDescuento = 0;
        let boletosRestantes = cantidad;

        // Obtener promociones de config.js y ordenarlas por cantidad (descendente)
        const promociones = (window.rifaplusConfig && window.rifaplusConfig.rifa && window.rifaplusConfig.rifa.promociones) 
            ? [...window.rifaplusConfig.rifa.promociones].sort((a, b) => b.cantidad - a.cantidad) 
            : [];

        // Aplicar cada promoción de mayor a menor cantidad
        for (const promo of promociones) {
            if (boletosRestantes >= promo.cantidad) {
                // Calcular cuántas promociones de este tipo caben
                const cantidadPromos = Math.floor(boletosRestantes / promo.cantidad);
                // Agregar precio de promociones aplicadas
                precioTotal += cantidadPromos * promo.precio;
                // Calcular descuento: precio normal vs precio promociónado
                montoDescuento += cantidadPromos * (promo.cantidad * precioUnitario - promo.precio);
                // Descontar boletos ya contabilizados
                boletosRestantes -= cantidadPromos * promo.cantidad;
            }
        }

        // Agregar boletos sueltos a precio normal
        precioTotal += boletosRestantes * precioUnitario;

        return {
            cantidadBoletos: cantidad,
            precioUnitario: precioUnitario,
            subtotal: cantidad * precioUnitario,
            montoDescuento: montoDescuento,
            porcentajeDescuento: montoDescuento > 0 
                ? ((montoDescuento / (cantidad * precioUnitario)) * 100).toFixed(2)
                : 0,
            precioFinal: precioTotal
        };
    },
    /**
     * Alias: calcularDescuento (para compatibilidad con otros módulos)
     */
    calcularDescuento: function(cantidad, precioUnitario = null) {
        if (!precioUnitario) {
            precioUnitario = window.rifaplusConfig?.obtenerPrecioBoleto?.()
                || Number(window.rifaplusConfig?.rifa?.precioBoleto || 0);
        }
        const resultado = this.calcularPrecioConDescuento(cantidad, precioUnitario);
        return {
            cantidadBoletos: resultado.cantidadBoletos,
            precioUnitario: resultado.precioUnitario,
            subtotal: resultado.subtotal,
            descuentoMonto: resultado.montoDescuento,
            descuentoPorcentaje: resultado.porcentajeDescuento,
            totalFinal: resultado.precioFinal
        };
    },

    /**
     * showFeedback - Mostrar mensaje de feedback al usuario
     * Alias compatible con compra.js
     * @param {string} mensaje - Mensaje a mostrar
     * @param {string} tipo - Tipo: 'info', 'success', 'warning', 'error'
     */
    showFeedback: function(mensaje, tipo = 'info') {
        // Mapear tipos de feedback
        const tipoMap = {
            'success': 'exito',
            'error': 'error',
            'warning': 'advertencia',
            'info': 'exito'
        };
        return this.mostrarRetroalimentacion(mensaje, tipoMap[tipo] || 'exito');
    }
};

// Alias para compatibilidad con código antiguo
window.rifaplusUtils = window.utilidadesRifaPlus;

// ============================================================ //
// SECCIÓN 4: INYECCIÓN DINÁMICA DE LOGO
// ============================================================ //

/**
 * inyectarLogoDinamico - Cambia dinámicamente el logo desde config.js
 * Actualiza todos los logos (clases con "logo" o "logo-image") con config.cliente.logo
 * Garantiza que la web sea 100% dinámica sin hardcodes
 */
function inyectarLogoDinamico() {
    try {
        const imageDelivery = window.RifaPlusImageDelivery;
        const logoConfigCrudo = window.rifaplusConfig?.cliente?.logo || window.rifaplusConfig?.cliente?.logotipo || "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 240 96'%3E%3Crect width='240' height='96' rx='20' fill='%230b2235'/%3E%3Ctext x='120' y='58' font-size='28' text-anchor='middle' fill='%23ffffff' font-family='Arial,sans-serif'%3ESorteo%3C/text%3E%3C/svg%3E";
        let logoConfig = logoConfigCrudo;

        try {
            const cachedLogo = localStorage.getItem('rifaplus_cached_logo') || '';
            if ((!logoConfig || logoConfig === 'images/placeholder-logo.svg') && cachedLogo && cachedLogo !== 'images/placeholder-logo.svg') {
                logoConfig = cachedLogo;
                if (window.rifaplusConfig?.cliente) {
                    window.rifaplusConfig.cliente.logo = cachedLogo;
                    window.rifaplusConfig.cliente.logotipo = cachedLogo;
                }
            }
        } catch (error) {
            // Continuar con logoConfig si localStorage no está disponible
        }

        try {
            localStorage.setItem('rifaplus_cached_logo', logoConfig);
            window.__RIFAPLUS_CACHED_LOGO__ = imageDelivery?.resolverUrlImagen(logoConfig, 'logo') || logoConfig;
        } catch (error) {
            console.warn('⚠️ No se pudo persistir el logo en localStorage:', error?.message || error);
        }
        
        // Estrategia 1: Buscar imágenes con clases que indiquen logo
        const logoSelectors = [
            'img.logo-image',           // Logo en header
            'img.admin-logo-img',       // Logo en admin
            'img.footer-logo-img',      // Logo en footer
            '.logo-circle img',         // Logo dentro de círculo
            '.admin-logo-container img', // Logo admin container
            'img[alt*="SORTEOS"]',      // Imágenes con SORTEOS en alt
            'img[alt*="logo"]'          // Imágenes con logo en alt
        ];
        
        logoSelectors.forEach(selector => {
            document.querySelectorAll(selector).forEach(img => {
                const oldSrc = img.dataset?.rifaplusOriginalSrc || img.getAttribute('src') || img.src || '';
                const normalizedOldSrc = String(oldSrc || '').trim();
                const normalizedLogo = String(logoConfig || '').trim();
                const optimizedLogo = imageDelivery?.resolverUrlImagen(logoConfig, 'logo') || logoConfig;

                if (!img.hasAttribute('fetchpriority')) {
                    img.setAttribute('fetchpriority', 'high');
                }
                if (!img.hasAttribute('decoding')) {
                    img.setAttribute('decoding', 'async');
                }

                if (normalizedOldSrc !== normalizedLogo) {
                    if (imageDelivery?.aplicarImagenOptimizada) {
                        imageDelivery.aplicarImagenOptimizada(img, {
                            originalUrl: logoConfig,
                            profile: 'logo',
                            widths: [160, 320, 480],
                            sizes: '(max-width: 768px) 160px, 320px',
                            fetchPriority: 'high',
                            decoding: 'async'
                        });
                    } else {
                        img.src = optimizedLogo;
                    }
                }

                img.onerror = function() {
                    console.warn(`Logo no encontrado: ${logoConfig}. Usando fallback inline.`);
                    this.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 240 96'%3E%3Crect width='240' height='96' rx='20' fill='%230b2235'/%3E%3Ctext x='120' y='58' font-size='28' text-anchor='middle' fill='%23ffffff' font-family='Arial,sans-serif'%3ESorteo%3C/text%3E%3C/svg%3E";
                };
            });
        });

        // Estrategia 2: Actualizar favicon si está en links
        document.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"]').forEach(link => {
            link.href = imageDelivery?.resolverUrlImagen(logoConfig, 'logoIcon') || logoConfig;
        });

        console.log('✅ Logo inyectado dinámicamente desde config');
    } catch (error) {
        console.warn('⚠️ Error inyectando logo:', error);
    }
}

// ============================================================ //
// SECCIÓN 4B: INICIALIZACIÓN DEL DOCUMENTO
// ============================================================ //

/**
 * Ejecutar cuando el DOM esté completamente cargado
 * Inicializa todos los módulos disponibles
 */
document.addEventListener('DOMContentLoaded', async function() {
    console.log('🚀 Inicializando SaDev...');

    // 🎉 Inicializar modal de sorteo finalizado (SI aplica)
    await asegurarModalSorteoFinalizadoDisponible();
    if (window.modalSorteoFinalizado) {
        window.modalSorteoFinalizado.inicializar();
    }

    // ============================================================
    // MULTIRIFA: Mantener ?rifa=<slug> entre páginas públicas
    // - Reescribe links internos tipo "compra.html" → "compra.html?rifa=s8"
    // - Intercepta botones con onclick que navegan a .html
    // ============================================================
    (function parchearNavegacionMultirifa() {
        try {
            const anexar = window.rifaplusConfig?.anexarSlugRifaAUrl;
            const slug = window.rifaplusConfig?.obtenerSlugRifaActual?.();
            if (typeof anexar !== 'function' || !slug) {
                return;
            }

            const esDestinoInternoParaSlug = (href) => {
                const raw = String(href || '').trim();
                if (!raw) return false;
                if (raw.startsWith('#') || raw.startsWith('mailto:') || raw.startsWith('tel:')) return false;
                if (/^https?:\/\//i.test(raw)) {
                    try {
                        const u = new URL(raw);
                        if (u.origin !== window.location.origin) return false;
                        const path = String(u.pathname || '');
                        return /\.html$/i.test(path) || path === '/' || /^\/(compra|mis-boletos|cuentas-pago|ayuda)(\/)?$/i.test(path);
                    } catch (error) {
                        return false;
                    }
                }

                // Relativas / root-relative
                if (/\.html(\?|#|$)/i.test(raw)) return true;
                if (raw === '/' || raw === './' || raw === 'index.html' || raw === 'index.html#top') return true;
                if (/^\/(compra|mis-boletos|cuentas-pago|ayuda)(\/)?(\?|#|$)/i.test(raw)) return true;
                return false;
            };

            const parchearAnchors = (root = document) => {
                root.querySelectorAll?.('a[href]')?.forEach((a) => {
                    const href = a.getAttribute('href');
                    if (!esDestinoInternoParaSlug(href)) return;
                    const nuevoHref = anexar(href);
                    if (nuevoHref && nuevoHref !== href) {
                        a.setAttribute('href', nuevoHref);
                    }
                });
            };

            const parchearOnclicks = (root = document) => {
                root.querySelectorAll?.('[onclick]')?.forEach((el) => {
                    const raw = String(el.getAttribute('onclick') || '').trim();
                    if (!raw) return;

                    const match = raw.match(/location\.href\s*=\s*['"]([^'"]+)['"]/i);
                    if (!match) return;

                    const destino = String(match[1] || '').trim();
                    if (!esDestinoInternoParaSlug(destino)) return;

                    el.removeAttribute('onclick');
                    el.addEventListener('click', (evt) => {
                        evt.preventDefault();
                        window.location.href = anexar(destino);
                    });
                });
            };

            // 1) Parchear lo que ya existe en DOM
            parchearAnchors(document);
            parchearOnclicks(document);

            // 2) Delegación: asegurar que cualquier <a> interno mantenga el slug
            document.addEventListener('click', (evt) => {
                const anchor = evt.target?.closest?.('a[href]');
                if (!anchor) return;
                if (evt.defaultPrevented) return;
                if (evt.button !== 0) return;
                if (anchor.hasAttribute('download')) return;
                if (anchor.target && anchor.target !== '_self') return;
                if (evt.metaKey || evt.ctrlKey || evt.shiftKey || evt.altKey) return;

                const href = anchor.getAttribute('href');
                if (!esDestinoInternoParaSlug(href)) return;

                const nuevoHref = anexar(href);
                if (!nuevoHref || nuevoHref === href) return;

                evt.preventDefault();
                window.location.assign(nuevoHref);
            }, true);

            // 3) MutationObserver: parchar contenido agregado dinámicamente
            const observer = new MutationObserver((mutations) => {
                for (const m of mutations) {
                    for (const node of m.addedNodes || []) {
                        if (!node || node.nodeType !== 1) continue;
                        parchearAnchors(node);
                        parchearOnclicks(node);
                    }
                }
            });
            observer.observe(document.documentElement, { childList: true, subtree: true });
        } catch (error) {
            console.debug('ℹ️ parchearNavegacionMultirifa omitido:', error?.message || error);
        }
    })();

    // Inyectar logo dinámicamente desde config.js
    inyectarLogoDinamico();

    // Cada función verifica si sus elementos existen antes de ejecutarse
    // Esto permite cargar main.js en todas las páginas sin overhead

    inicializarCarrusel();       // Carrusel de imágenes
    inicializarCuentaRegresiva(); // Contador de tiempo del sorteo
    
    // Reiniciar countdown cuando se sincronice fecha desde servidor
    if (window.rifaplusConfig?.escucharEvento) {
        window.rifaplusConfig.escucharEvento('configuracionActualizada', (evento) => {
            console.log('🔄 Reinicializando countdown por sincronización...', evento);
            inicializarCuentaRegresiva();
        });
    }
    
    inicializarFAQ();             // Acordeón de ayuda
    inicializarScrollSuave();     // Scroll suave hacia secciones
    inicializarAnimacionesScroll();// Animaciones al hacer scroll
    inicializarNavegacion();      // Navegación activa
    inicializarMenuMovil();       // Menú responsivo móvil

    console.log('✅ SaDev inicializado correctamente');
});

// ============================================================ //
// SECCIÓN 5: CARRUSEL DE IMÁGENES
// ============================================================ //

/**
 * Inicializar carrusel con autoavance y controles
 * Genera dinámicamente los slides desde config.rifa.premios[0].imagenes
 */
function inicializarCarrusel() {
    const imageDelivery = window.RifaPlusImageDelivery;
    const carruselInner = document.querySelector('.carrusel-inner');

    if (!carruselInner) {
        return;
    }

    const imagenes = window.rifaplusConfig?.rifa?.premios?.[0]?.imagenes || [];

    if (imagenes.length === 0) {
        console.debug('⏳ No hay imágenes de premios aún (sincronizando desde servidor)');
        return;
    }

    const slidesNuevos = [];
    let primeraImagenNueva = null;

    imagenes.forEach((imagenPath, index) => {
        const slide = document.createElement('div');
        slide.className = `carrusel-item${index === 0 ? ' active' : ''}`;

        const img = document.createElement('img');
        img.alt = `Imagen ${index + 1} del premio`;
        if (imageDelivery?.aplicarImagenOptimizada) {
            imageDelivery.aplicarImagenOptimizada(img, {
                originalUrl: imagenPath,
                profile: index === 0 ? 'carouselPreload' : 'carousel',
                widths: [480, 768, 960, 1280, 1600],
                sizes: '(max-width: 768px) 100vw, min(92vw, 1200px)',
                loading: index === 0 ? 'eager' : 'lazy',
                fetchPriority: index === 0 ? 'high' : 'low',
                decoding: 'async'
            });
        } else {
            img.src = imagenPath;
            img.loading = index === 0 ? 'eager' : 'lazy';
            img.decoding = 'async';
        }

        if (index === 0) {
            primeraImagenNueva = img;
        }

        slide.appendChild(img);
        slidesNuevos.push(slide);
    });

    const montarCarrusel = () => {
        carruselInner.innerHTML = '';
        slidesNuevos.forEach((slide) => carruselInner.appendChild(slide));
        carruselInner.classList.remove('is-loading');
        carruselInner.setAttribute('data-rifaplus-mounted', 'true');

        const slides = carruselInner.querySelectorAll('.carrusel-item');
        const botonSiguiente = document.querySelector('.carrusel-next');
        const botonAnterior = document.querySelector('.carrusel-prev');

        if (slides.length === 0) {
            return;
        }

        let indexSlideActual = 0;
        const totalSlides = slides.length;
        let intervaloAutoavance;

        function mostrarSlide(indice) {
            slides.forEach((slide) => {
                slide.classList.remove('active');
                slide.style.opacity = '0';
            });

            slides[indice].classList.add('active');
            slides[indice].style.opacity = '1';
            indexSlideActual = indice;
        }

        function siguienteSlide() {
            const siguiente = (indexSlideActual + 1) % totalSlides;
            mostrarSlide(siguiente);
        }

        function slideAnterior() {
            const anterior = (indexSlideActual - 1 + totalSlides) % totalSlides;
            mostrarSlide(anterior);
        }

        if (botonSiguiente) {
            botonSiguiente.addEventListener('click', siguienteSlide);
        }

        if (botonAnterior) {
            botonAnterior.addEventListener('click', slideAnterior);
        }

        function iniciarAutoavance() {
            if (intervaloAutoavance || totalSlides <= 1 || document.hidden) {
                return;
            }

            intervaloAutoavance = setInterval(siguienteSlide, 10000);
        }

        function pausarAutoavance() {
            if (intervaloAutoavance) {
                clearInterval(intervaloAutoavance);
                intervaloAutoavance = null;
            }
        }

        const carrusel = document.querySelector('.carrusel');
        if (carrusel) {
            carrusel.addEventListener('mouseenter', pausarAutoavance);
            carrusel.addEventListener('mouseleave', iniciarAutoavance);
            addPassiveListener(carrusel, 'touchstart', pausarAutoavance);
            addPassiveListener(carrusel, 'touchend', () => {
                setTimeout(iniciarAutoavance, 3000);
            });
        }

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                iniciarAutoavance();
            } else {
                pausarAutoavance();
            }
        });

        iniciarAutoavance();
        mostrarSlide(0);

        window.addEventListener('pagehide', function() {
            pausarAutoavance();
        }, { capture: true });

        console.log('✓ Carrusel inicializado');
    };

    const tieneSlideCacheado = Boolean(carruselInner.querySelector('[data-rifaplus-cached-slide="true"]'));
    if (primeraImagenNueva && tieneSlideCacheado) {
        const montarUnaVez = () => {
            if (carruselInner.getAttribute('data-rifaplus-mounted') === 'true') return;
            montarCarrusel();
        };

        if (primeraImagenNueva.complete && primeraImagenNueva.naturalWidth > 0) {
            montarUnaVez();
            return;
        }

        primeraImagenNueva.addEventListener('load', montarUnaVez, { once: true });
        primeraImagenNueva.addEventListener('error', montarUnaVez, { once: true });
        window.setTimeout(montarUnaVez, 1800);
        return;
    }

    montarCarrusel();
}

// ============================================================ //
// SECCIÓN 6: CUENTA REGRESIVA DEL SORTEO
// ============================================================ //

/**
 * Mostrar cuenta regresiva del tiempo hasta el sorteo
 * Solo se ejecuta si existen los elementos de countdown
 * NOTA: Usa funciones centralizadas de config.js para obtener la fecha
 */
function inicializarCuentaRegresiva() {
    // Limpiar intervalo anterior para evitar duplicados
    if (window.intervaloConteoRegresivo) {
        clearInterval(window.intervaloConteoRegresivo);
        window.intervaloConteoRegresivo = null;
    }

    const contenedorCountdown = document.querySelector('.countdown-timer');
    if (!contenedorCountdown) {
        return;
    }

    if (!contenedorCountdown.dataset.originalMarkup) {
        contenedorCountdown.dataset.originalMarkup = contenedorCountdown.innerHTML;
    }

    function restaurarCountdownSiFueReemplazado() {
        if (contenedorCountdown.querySelector('.sorteo-terminado') && contenedorCountdown.dataset.originalMarkup) {
            contenedorCountdown.innerHTML = contenedorCountdown.dataset.originalMarkup;
        }
    }

    function obtenerElementosCountdown() {
        return {
            dias: document.getElementById('countdown-days'),
            horas: document.getElementById('countdown-hours'),
            minutos: document.getElementById('countdown-minutes'),
            segundos: document.getElementById('countdown-seconds')
        };
    }

    let {
        dias: elementoDias,
        horas: elementoHoras,
        minutos: elementoMinutos,
        segundos: elementoSegundos
    } = obtenerElementosCountdown();

    // Verificar que existen los elementos (silencioso si no existen - página sin countdown)
    if (!elementoDias || !elementoHoras || !elementoMinutos || !elementoSegundos) {
        return;
    }

    // Verificar que las funciones centralizadas existan
    if (!window.rifaplusConfig?.obtenerTimestampSorteo || !window.rifaplusConfig?.validarFechaSorteo) {
        console.error('❌ [Countdown] Funciones centralizadas de config no disponibles');
        return;
    }

    // Validar la fecha del sorteo
    const validacion = window.rifaplusConfig.validarFechaSorteo();
    if (!validacion.valida) {
        // Si está pendiente (sincronización en progreso), no lanzar error, simplemente esperar
        if (validacion.pendiente) {
            if (!contenedorCountdown.dataset.pendingConfigListener) {
                contenedorCountdown.dataset.pendingConfigListener = 'true';
                const reintentarCountdown = () => {
                    delete contenedorCountdown.dataset.pendingConfigListener;
                    inicializarCuentaRegresiva();
                };
                window.addEventListener('configSyncCompleto', reintentarCountdown, { once: true });
                window.addEventListener('configuracionActualizada', reintentarCountdown, { once: true });
            }
            return;
        }
        console.error('❌ [Countdown] Fecha del sorteo inválida:', validacion.mensaje);
        return;
    }

    console.log('✓ [Countdown] Fecha validada:', {
        fecha: window.rifaplusConfig.obtenerFechaSorteo(),
        formato: window.rifaplusConfig.obtenerFechaSorteoFormato(),
        diasRestantes: validacion.diasRestantes
    });

    /**
     * Actualizar el display de la cuenta regresiva
     * Obtiene el timestamp DINÁMICAMENTE cada vez (no lo cachea)
     * Esto permite que cambios en config.js se reflejen automáticamente
     */
    function actualizarCuentaRegresiva() {
        // Obtener timestamp dinámicamente cada segundo (nunca cached)
        const timestampObjetivo = window.rifaplusConfig.obtenerTimestampSorteo();
        if (!timestampObjetivo) {
            console.error('❌ [Countdown] No se pudo obtener timestamp');
            return;
        }

        const ahora = new Date().getTime();
        const diferencia = timestampObjetivo - ahora;

        if (diferencia > 0) {
            restaurarCountdownSiFueReemplazado();
            ({
                dias: elementoDias,
                horas: elementoHoras,
                minutos: elementoMinutos,
                segundos: elementoSegundos
            } = obtenerElementosCountdown());

            if (!elementoDias || !elementoHoras || !elementoMinutos || !elementoSegundos) {
                return;
            }

            // Calcular unidades de tiempo
            const dias = Math.floor(diferencia / (1000 * 60 * 60 * 24));
            const horas = Math.floor((diferencia % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
            const minutos = Math.floor((diferencia % (1000 * 60 * 60)) / (1000 * 60));
            const segundos = Math.floor((diferencia % (1000 * 60)) / 1000);

            // Actualizar display con formato de 2 dígitos
            elementoDias.textContent = String(dias).padStart(2, '0');
            elementoHoras.textContent = String(horas).padStart(2, '0');
            elementoMinutos.textContent = String(minutos).padStart(2, '0');
            elementoSegundos.textContent = String(segundos).padStart(2, '0');

            // Animar cuando quedan 3 días o menos
            const textoUrgencia = document.querySelector('.urgency-text');
            if (dias <= 3 && textoUrgencia) {
                textoUrgencia.style.animation = 'pulse 1s ease-in-out infinite';
            }
        } else {
            // El sorteo ya ocurrió
            elementoDias.textContent = '00';
            elementoHoras.textContent = '00';
            elementoMinutos.textContent = '00';
            elementoSegundos.textContent = '00';

            // Mostrar mensaje de sorteo completado
            if (contenedorCountdown && !contenedorCountdown.querySelector('.sorteo-terminado')) {
                contenedorCountdown.innerHTML = `
                    <div class="sorteo-terminado" style="
                        background: linear-gradient(135deg, var(--success) 0%, var(--success-dark) 100%);
                        color: white;
                        padding: 2rem;
                        border-radius: var(--radius-lg);
                        font-size: 1.5rem;
                        font-weight: 700;
                        text-align: center;
                    ">
                        🎉 ¡EL SORTEO HA TERMINADO!
                    </div>
                `;
            }
        }
    }

    // Actualizar inmediatamente y cada segundo
    actualizarCuentaRegresiva();
    window.intervaloConteoRegresivo = setInterval(actualizarCuentaRegresiva, 1000);
    console.log('✓ [Countdown] Cuenta regresiva inicializada - fecha de referencia: config.js rifa.fechaSorteo');
}

// ============================================================ //
// SECCIÓN 7: ACORDEÓN - AYUDA
// ============================================================ //

/**
 * Inicializar FAQ con comportamiento de acordeón
 * Solo se ejecuta si existen elementos .faq-item
 */
function inicializarFAQ() {
    const itemsFAQ = document.querySelectorAll('.faq-item');

    if (itemsFAQ.length === 0) {
        return;
    }

    itemsFAQ.forEach((item, indice) => {
        const pregunta = item.querySelector('.faq-pregunta');
        const respuesta = item.querySelector('.faq-respuesta');

        if (!pregunta || !respuesta) return;

        // Configurar altura inicial
        if (!item.classList.contains('activo')) {
            respuesta.style.maxHeight = '0';
            respuesta.style.overflow = 'hidden';
        }

        /**
         * Manejar click en pregunta
         */
        pregunta.addEventListener('click', () => {
            const estaActivo = item.classList.contains('activo');

            // Cerrar otros items del acordeón
            itemsFAQ.forEach(otroItem => {
                if (otroItem !== item) {
                    otroItem.classList.remove('activo');
                    const otraRespuesta = otroItem.querySelector('.faq-respuesta');
                    if (otraRespuesta) {
                        otraRespuesta.style.maxHeight = '0';
                    }
                }
            });

            // Alternar estado del item actual
            item.classList.toggle('activo');

            if (!estaActivo) {
                respuesta.style.maxHeight = respuesta.scrollHeight + 'px';
            } else {
                respuesta.style.maxHeight = '0';
            }
        });

        // Accesibilidad: manejo de teclado
        pregunta.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                pregunta.click();
            }
        });

        // Atributos ARIA para accesibilidad
        pregunta.setAttribute('tabindex', '0');
        pregunta.setAttribute('role', 'button');
        pregunta.setAttribute('aria-expanded', 'false');
        pregunta.setAttribute('aria-controls', `faq-respuesta-${indice}`);
        respuesta.id = `faq-respuesta-${indice}`;
    });

    console.log('✓ FAQ inicializado');
}

// ============================================================ //
// SECCIÓN 8: SCROLL SUAVE HACIA SECCIONES
// ============================================================ //

/**
 * Implementar scroll suave para enlaces internos
 * Detecta enlaces con href="#seccion" y scroll smoothly
 */
function inicializarScrollSuave() {
    const enlaces = document.querySelectorAll('a[href^="#"]');
    const header = document.querySelector('.header');

    if (enlaces.length === 0) return;

    enlaces.forEach(enlace => {
        enlace.addEventListener('click', function(evento) {
            const href = this.getAttribute('href');

            // Ignorar enlaces vacíos
            if (href === '#' || href === '#0') return;

            const seccion = document.querySelector(href);
            if (!seccion) return;

            evento.preventDefault();

            // Calcular posición considerando header fijo
            const alturaHeader = header?.offsetHeight || 0;
            const posicionSeccion = Math.max(
                0,
                seccion.getBoundingClientRect().top + window.pageYOffset - alturaHeader - 20
            );

            // Scroll suave a la sección
            window.scrollTo({
                top: posicionSeccion,
                behavior: 'smooth'
            });

            // Actualizar URL sin recargar la página
            history.pushState(null, null, href);
        });
    });

    console.log('✓ Scroll suave inicializado');
}

// ============================================================ //
// SECCIÓN 9: ANIMACIONES AL HACER SCROLL
// ============================================================ //

/**
 * Animar elementos cuando entran en el viewport
 * Usa Intersection Observer para eficiencia
 */
function inicializarAnimacionesScroll() {
    const elementosAnimados = document.querySelectorAll(
        '.precio-card, .info-item, .contacto-card'
    );

    if (elementosAnimados.length === 0) return;

    const observador = new IntersectionObserver((entradas) => {
        entradas.forEach(entrada => {
            if (entrada.isIntersecting) {
                entrada.target.classList.add('animate-in');
                observador.unobserve(entrada.target);
            }
        });
    }, {
        threshold: 0.1,
        rootMargin: '0px 0px -50px 0px'
    });

    elementosAnimados.forEach(elemento => {
        elemento.classList.add('will-animate');
        observador.observe(elemento);
    });

    console.log('✓ Animaciones de scroll inicializadas');
}

// ============================================================ //
// SECCIÓN 10: NAVEGACIÓN ACTIVA
// ============================================================ //

/**
 * Marcar el link de navegación activo según la sección visible
 * Solo para enlaces internos con href="#"
 */
function inicializarNavegacion() {
    const enlacesNav = document.querySelectorAll('.nav-link[href^="#"]');

    if (enlacesNav.length === 0) return;

    /**
     * Encontrar y marcar el link de navegación activo
     */
    function establecerLinkActivo() {
        const desdeArriba = window.scrollY + 100;
        let enlaceActivo = null;

        enlacesNav.forEach(enlace => {
            const seccion = document.querySelector(enlace.getAttribute('href'));
            if (!seccion) return;

            const tituloSeccion = seccion.offsetTop;
            const alturaSeccion = seccion.offsetHeight;

            // Verificar si estamos en esta sección
            if (desdeArriba >= tituloSeccion && desdeArriba < tituloSeccion + alturaSeccion) {
                enlaceActivo = enlace;
            }
        });

        // Solo actualizar si hay un cambio
        if (enlaceActivo && !enlaceActivo.classList.contains('activo')) {
            enlacesNav.forEach(e => e.classList.remove('activo'));
            enlaceActivo.classList.add('activo');
        }
    }

    /**
     * Throttle del evento scroll para mejor rendimiento
     */
    let framePendiente = 0;
    function scrollThrottle() {
        if (framePendiente) return;
        framePendiente = requestAnimationFrame(() => {
            framePendiente = 0;
            establecerLinkActivo();
        });
    }

    addPassiveListener(window, 'scroll', scrollThrottle);
    establecerLinkActivo(); // Ejecutar al cargar

    console.log('✓ Navegación activa inicializada');
}

// ============================================================ //
// SECCIÓN 11: MENÚ MÓVIL (RESPONSIVO)
// ============================================================ //

/**
 * Implementar menú móvil con overlay y animaciones
 * Solo se ejecuta si existen los elementos del menú
 */
function inicializarMenuMovil() {
    const botonHamburguesa = document.getElementById('hamburger');
    const menuOverlay = document.getElementById('overlayMenu');
    const botonCerrar = document.getElementById('overlayClose');
    const body = document.body;
    const html = document.documentElement;
    const mediaDesktop = window.matchMedia('(min-width: 769px)');
    let scrollTopBloqueado = 0;

    if (!botonHamburguesa || !menuOverlay) {
        return;
    }

    menuOverlay.setAttribute('aria-hidden', 'true');
    menuOverlay.setAttribute('inert', '');

    function bloquearScroll() {
        scrollTopBloqueado = window.scrollY || window.pageYOffset || 0;
        body.classList.add('mobile-menu-open');
        body.style.top = `-${scrollTopBloqueado}px`;
        html.style.scrollBehavior = 'auto';
    }

    function restaurarScroll() {
        if (!body.classList.contains('mobile-menu-open')) {
            return;
        }

        body.classList.remove('mobile-menu-open');
        body.style.top = '';
        window.scrollTo(0, scrollTopBloqueado);
        html.style.scrollBehavior = '';
    }

    /**
     * Abrir el menú móvil
     */
    function abrirOverlay() {
        menuOverlay.classList.add('show');
        menuOverlay.removeAttribute('inert');
        menuOverlay.setAttribute('aria-hidden', 'false');
        botonHamburguesa.setAttribute('aria-expanded', 'true');
        bloquearScroll();

        // Animar icono de hamburguesa a X
        const iconoInterno = botonHamburguesa.querySelector('.hamburger-inner');
        if (iconoInterno) {
            iconoInterno.style.transform = 'rotate(45deg)';
            iconoInterno.style.backgroundColor = 'var(--primary-light)';
        }

        const primerEnlace = menuOverlay.querySelector('.overlay-link');
        if (primerEnlace) {
            requestAnimationFrame(() => primerEnlace.focus());
        }
    }

    /**
     * Cerrar el menú móvil
     */
    function cerrarOverlay() {
        menuOverlay.classList.remove('show');
        menuOverlay.setAttribute('inert', '');
        menuOverlay.setAttribute('aria-hidden', 'true');
        botonHamburguesa.setAttribute('aria-expanded', 'false');
        restaurarScroll();

        // Animar icono de X a hamburguesa
        const iconoInterno = botonHamburguesa.querySelector('.hamburger-inner');
        if (iconoInterno) {
            iconoInterno.style.transform = 'rotate(0)';
            iconoInterno.style.backgroundColor = 'white';
        }
    }

    function sincronizarConViewport() {
        if (mediaDesktop.matches && menuOverlay.classList.contains('show')) {
            cerrarOverlay();
        }
    }

    // Click en botón hamburguesa
    botonHamburguesa.addEventListener('click', (e) => {
        e.stopPropagation();
        const estaAbierto = menuOverlay.classList.contains('show');
        estaAbierto ? cerrarOverlay() : abrirOverlay();
    });

    // Click en botón cerrar
    if (botonCerrar) {
        botonCerrar.addEventListener('click', cerrarOverlay);
    }

    // Cerrar con tecla Escape
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && menuOverlay.classList.contains('show')) {
            cerrarOverlay();
            botonHamburguesa.focus();
        }
    });

    // Cerrar al clickear fuera del menú
    menuOverlay.addEventListener('click', (e) => {
        if (e.target === menuOverlay) {
            cerrarOverlay();
        }
    });

    // Cerrar al clickear en un link del menú
    const enlacesOverlay = menuOverlay.querySelectorAll('.overlay-link');
    enlacesOverlay.forEach(enlace => {
        enlace.addEventListener('click', cerrarOverlay);
    });

    window.addEventListener('resize', sincronizarConViewport);
    window.addEventListener('orientationchange', sincronizarConViewport);

    const mediaListener = () => sincronizarConViewport();
    if (typeof mediaDesktop.addEventListener === 'function') {
        mediaDesktop.addEventListener('change', mediaListener);
    } else if (typeof mediaDesktop.addListener === 'function') {
        mediaDesktop.addListener(mediaListener);
    }
}

// ============================================================ //
// SECCIÓN 12: MANEJO DE ERRORES GLOBAL
// ============================================================ //

/**
 * Capturar errores no manejados a nivel global
 * Útil para debugging en producción
 */
window.addEventListener('error', function(evento) {
    const target = evento?.target;
    const recurso = target && target !== window
        ? (target.currentSrc || target.src || target.href || target.id || target.tagName || 'desconocido')
        : '';

    if (evento?.error) {
        console.error('❌ Error no capturado:', evento.error);
        return;
    }

    if (evento?.message) {
        if (String(evento.message).includes('ResizeObserver loop completed with undelivered notifications')) {
            console.warn('⚠️ ResizeObserver reportó notificaciones pendientes; se reintentará en el siguiente frame');
            return;
        }

        console.error('❌ Error global detectado:', {
            mensaje: evento.message,
            archivo: evento.filename || 'desconocido',
            linea: evento.lineno || 0,
            columna: evento.colno || 0
        });
        return;
    }

    if (recurso) {
        console.error('❌ Error cargando recurso:', {
            etiqueta: target?.tagName?.toLowerCase?.() || 'desconocida',
            recurso
        });
        return;
    }

    console.error('❌ Error global sin detalle:', evento);
});

window.addEventListener('unhandledrejection', function(evento) {
    console.error('❌ Promesa rechazada sin manejar:', evento?.reason);
});

/**
 * Prevenir errores de consola si no existe
 * Evita que el script falle en navegadores sin console
 */
if (typeof console === "undefined" || typeof console.log === "undefined") {
    console = {};
    console.log = console.warn = console.error = function(){};
}

// ============================================================ //
// SECCIÓN 7: ESTADÍSTICAS DE BOLETOS (CONSOLIDADO DE countdown.js)
// ============================================================ //

/**
 * Actualiza los datos de boletos vendidos desde la API
 * @async
 */
function debeMostrarProgressBar() {
    return window.rifaplusConfig?.rifa?.publicacion?.progressBar !== false;
}

function debeMostrarProgressStats() {
    return window.rifaplusConfig?.rifa?.publicacion?.progressStats !== false;
}

function debeMostrarLogoVerificadoHeader() {
    return window.rifaplusConfig?.rifa?.publicacion?.logoVerificadoHeader !== false;
}

function aplicarVisibilidadLogoVerificadoHeader() {
    const badges = document.querySelectorAll('.logo-verified-badge');
    const mostrarBadge = debeMostrarLogoVerificadoHeader();
    if (typeof window.__RIFAPLUS_SET_LOGO_VERIFIED_VISIBILITY__ === 'function') {
        window.__RIFAPLUS_SET_LOGO_VERIFIED_VISIBILITY__(mostrarBadge);
    } else {
        document.documentElement.classList.toggle('rifaplus-logo-verified-off', !mostrarBadge);
    }

    if (!badges.length) return;

    badges.forEach((badge) => {
        badge.classList.toggle('is-hidden', !mostrarBadge);
        badge.setAttribute('aria-hidden', 'true');
    });
}

function aplicarVisibilidadProgressStats() {
    const progressContainer = document.querySelector('.countdown-progress');
    const progressStats = document.querySelector('.progress-stats');
    if (!progressContainer && !progressStats) return;

    const mostrarBarra = debeMostrarProgressBar();
    const mostrarStats = mostrarBarra && debeMostrarProgressStats();
    if (progressContainer) {
        progressContainer.style.display = mostrarBarra ? '' : 'none';
    }
    if (progressStats) {
        progressStats.style.display = mostrarStats ? '' : 'none';
    }
}

async function actualizarBarraProgreso() {
    try {
        const config = window.rifaplusConfig;
        if (!config || !config.backend) {
            console.warn('⚠️ Config no disponible');
            return;
        }

        aplicarVisibilidadProgressStats();
        if (!debeMostrarProgressBar()) {
            return;
        }
        
        // 🎯 PASO 1: Determinar total y rango de boletos a mostrar
        // Si oportunidades está habilitada, usar SOLO el rango visible
        // Si no, usar el totalBoletos configurado
        const oportunidadesConfig = config.rifa?.oportunidades;
        const totalBoletosConfiguracion = typeof config?.obtenerTotalBoletos === 'function'
            ? config.obtenerTotalBoletos()
            : (config.rifa?.totalBoletos || 0);
        
        let totalParaMostrar = totalBoletosConfiguracion;
        let rangoVisible = null;
        
        if (oportunidadesConfig && oportunidadesConfig.enabled && oportunidadesConfig.rango_visible) {
            rangoVisible = oportunidadesConfig.rango_visible;
            // El total a mostrar es el TAMAÑO del rango visible, no el config.totalBoletos
            totalParaMostrar = (rangoVisible.fin - rangoVisible.inicio) + 1;
            console.debug('[main] Oportunidades enabled, usando rango visible:', rangoVisible, 'Total:', totalParaMostrar);
        } else {
            console.debug('[main] Oportunidades disabled, usando totalBoletos:', totalParaMostrar);
        }

        if (!Number.isFinite(totalParaMostrar) || totalParaMostrar <= 0) {
            console.warn('⚠️ Total de boletos invalido para countdown-progress:', totalParaMostrar);
            return;
        }
        
        // 🎯 PASO 2: Obtener datos de boletos (PRIMERO en memoria, LUEGO backend)
        const sold = (window.rifaplusSoldNumbers && Array.isArray(window.rifaplusSoldNumbers)) ? window.rifaplusSoldNumbers : [];
        const reserved = (window.rifaplusReservedNumbers && Array.isArray(window.rifaplusReservedNumbers)) ? window.rifaplusReservedNumbers : [];
        
        // Si tenemos datos en memoria, usarlos
        if (window.rifaplusBoletosLoaded && (sold.length > 0 || reserved.length > 0)) {
            console.debug('[main] Usando datos en memoria (tiempo real)');
            actualizarInterfazProgreso(sold, reserved, totalParaMostrar, rangoVisible);
            return;
        }
        
        // 🎯 PASO 3: FALLBACK - Obtener del backend si no hay datos en memoria
        const apiBase = config.backend.apiBase;
        const url = `${apiBase}/api/public/ordenes-stats`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 segundos timeout
        
        try {
            const respuesta = await fetch(url, {
                signal: controller.signal,
                headers: { 'Accept': 'application/json' }
            });
            
            clearTimeout(timeoutId);
            
            if (!respuesta.ok) {
                console.warn('⚠️ Backend no respondió correctamente');
                actualizarInterfazProgreso([], [], totalParaMostrar, rangoVisible);
                return;
            }

            const datos = await respuesta.json();
            if (datos.success && datos.data) {
                const boletosVendidos = datos.data.total_boletos_vendidos || 0;
                console.debug('[main] Usando datos del backend:', { boletosVendidos });
                actualizarInterfazProgreso([], [], totalParaMostrar, rangoVisible, boletosVendidos);
            } else {
                console.warn('⚠️ Respuesta inválida del backend');
                actualizarInterfazProgreso([], [], totalParaMostrar, rangoVisible);
            }
        } catch (fetchError) {
            clearTimeout(timeoutId);
            if (fetchError.name === 'AbortError') {
                console.warn('⚠️ Timeout conectando a backend (URL:', url, ')');
            } else {
                console.warn('⚠️ No se puede conectar a backend:', apiBase);
            }
            actualizarInterfazProgreso([], [], totalParaMostrar, rangoVisible);
        }
    } catch (error) {
        console.warn('⚠️ Error en actualizarBarraProgreso:', error.message);
    }
}

/**
 * actualizarInterfazProgreso - Actualiza elementos UI con datos de boletos
 * 🎯 LÓGICA CORRECTA:
 * - Si oportunidades ESTÁ ENABLED: Mostrar solo boletos del rango visible
 *   * Vendidos: Contar solo boletos vendidos/reservados en el rango visible
 *   * Total: Tamaño del rango visible (ya ajustado en actualizarBarraProgreso)
 * 
 * - Si oportunidades NO ESTÁ: Mostrar todos los boletos
 *   * Vendidos: Todos los vendidos (sin filtrar)
 *   * Total: totalParaMostrar (que es totalBoletos)
 * 
 * @param {Array} sold - Array de boletos vendidos
 * @param {Array} reserved - Array de boletos reservados
 * @param {number} totalParaMostrar - Total de boletos a considerar
 * @param {Object|null} rangoVisible - Rango visible si oportunidades está enabled
 * @param {number} backendVendidos - (Opcional) Total de vendidos del backend (fallback)
 */
function actualizarInterfazProgreso(sold = [], reserved = [], totalParaMostrar = 10000, rangoVisible = null, backendVendidos = null) {
    // 🎯 CALCULAR BOLETOS VENDIDOS SEGÚN MODALIDAD
    // ⭐ IMPORTANTE: Contar SOLO boletos vendidos (sold), no apartados/reservados
    // Los reservados son boletos temporales sin pago confirmado
    let boletosVendidosParaMostrar = 0;
    
    if (rangoVisible && rangoVisible.inicio !== undefined && rangoVisible.fin !== undefined) {
        // 🎯 MODO OPORTUNIDADES: Contar solo boletos VENDIDOS del rango visible
        // NO incluir reservados (apartados sin pago)
        sold.forEach(num => {
            const n = Number(num);
            if (n >= rangoVisible.inicio && n <= rangoVisible.fin) {
                boletosVendidosParaMostrar++;
            }
        });
        
        console.debug('[main] MODO OPORTUNIDADES - Rango visible:', rangoVisible, 'Vendidos en rango:', boletosVendidosParaMostrar, 'Total sold:', sold.length, 'Total reserved:', reserved.length);
    } else if (backendVendidos !== null) {
        // FALLBACK: Si solo tenemos data del backend
        boletosVendidosParaMostrar = backendVendidos;
        console.debug('[main] FALLBACK BACKEND - Vendidos:', boletosVendidosParaMostrar);
    } else {
        // 🎯 MODO NORMAL (sin oportunidades): Contar SOLO los vendidos
        boletosVendidosParaMostrar = sold.length;
        console.debug('[main] MODO NORMAL - Total vendidos:', boletosVendidosParaMostrar, 'Total reserved:', reserved.length);
    }
    
    // 🎯 CALCULAR DISPONIBLES Y PORCENTAJE
    const boletosRestantes = totalParaMostrar - boletosVendidosParaMostrar;
    const porcentaje = totalParaMostrar > 0 ? Math.round((boletosVendidosParaMostrar / totalParaMostrar) * 100) : 0;

    console.debug('[main] RESULTADO FINAL:', {
        boletosVendidos: boletosVendidosParaMostrar,
        boletosRestantes,
        totalParaMostrar,
        porcentaje
    });

    const elemVendidos = document.getElementById('boletos-vendidos');
    const elemRestantes = document.getElementById('boletos-restantes');
    const elemPorcentaje = document.getElementById('porcentaje-vendido');
    const elemProgressFill = document.getElementById('progress-fill');

    if (elemVendidos) elemVendidos.textContent = boletosVendidosParaMostrar.toLocaleString();
    if (elemRestantes) elemRestantes.textContent = boletosRestantes.toLocaleString();
    if (elemPorcentaje) elemPorcentaje.textContent = `${porcentaje}%`;

    if (elemProgressFill) {
        elemProgressFill.style.width = `${porcentaje}%`;
        // Usar color primario (azul) de la paleta consistente
        elemProgressFill.style.background = 'linear-gradient(90deg, #0F3A7D 0%, #1B5FB8 100%)';
    }

    const urgencyText = document.querySelector('.urgency-text');
    const countdownCard = document.querySelector('.countdown-card');
    
    if (urgencyText) {
        let mensaje = '';
        if (porcentaje < 50) {
            mensaje = '💡 ¡No pierdas esta oportunidad! Aún hay muchos boletos disponibles - Participa ahora';
        } else if (porcentaje < 75) {
            mensaje = '⚠️ ¡SE AGOTAN LOS BOLETOS! Más del 50% ya vendido - ¡Asegura tu boleto ahora!';
        } else {
            mensaje = '🔥 ¡ÚLTIMAS OPORTUNIDADES! Más del 75% vendido - ¡Solo quedan ' + (100 - porcentaje) + '% disponibles!';
        }
        urgencyText.textContent = mensaje;
        
        if (countdownCard) {
            if (porcentaje >= 75) {
                countdownCard.classList.add('urgent-pulse');
            } else {
                countdownCard.classList.remove('urgent-pulse');
            }
        }
    }
}

/**
 * Actualiza el total de boletos en la interfaz
 */
function actualizarTotalBoletosEnUI() {
    const totalBoletos = window.rifaplusConfig?.obtenerTotalBoletos?.() || 10000;
    const elem = document.getElementById('total-boletos-info');
    if (elem) {
        elem.textContent = totalBoletos.toLocaleString();
    }
}

window.addEventListener('configSyncCompleto', aplicarVisibilidadLogoVerificadoHeader);
window.addEventListener('configuracionActualizada', aplicarVisibilidadLogoVerificadoHeader);
window.addEventListener('configSyncCompleto', aplicarVisibilidadProgressStats);
window.addEventListener('configuracionActualizada', aplicarVisibilidadProgressStats);

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', aplicarVisibilidadLogoVerificadoHeader, { once: true });
} else {
    aplicarVisibilidadLogoVerificadoHeader();
}

/**
 * Inicializa completamente el countdown y progreso
 */
(function initializeCountdownConsolidated() {
    let intervalId = null;
    let ultimaActualizacionProgreso = 0; // Cooldown para evitar 429
    let sincronizacionInicialCompletada = false;

    async function asegurarConfigRealParaCountdown() {
        if (sincronizacionInicialCompletada) return;
        sincronizacionInicialCompletada = true;

        if (window.rifaplusConfig?.sincronizarConfigDelBackend) {
            try {
                await window.rifaplusConfig.sincronizarConfigDelBackend({ force: true });
            } catch (error) {
                console.warn('⚠️ No se pudo sincronizar config antes de renderizar countdown-progress:', error.message);
            }
        }
    }
    
    async function setupCountdown() {
        await asegurarConfigRealParaCountdown();

        if (document.getElementById('countdown-days') || document.getElementById('boletos-vendidos')) {
            actualizarTotalBoletosEnUI();
            
            // OPTIMIZACIÓN: Solo actualizar barra de progreso si no se actualizó hace poco
            const ahora = Date.now();
            if (ahora - ultimaActualizacionProgreso > 60000) { // Mínimo 60 segundos entre actualizaciones
                actualizarBarraProgreso();
                ultimaActualizacionProgreso = ahora;
            }
            
            // Actualizar cada 5 minutos (300000 ms) para reducir API calls
            intervalId = setInterval(() => {
                actualizarBarraProgreso();
                ultimaActualizacionProgreso = Date.now();
            }, 300000);
        }
    }
    
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setupCountdown);
    } else {
        setupCountdown();
    }

    if (window.rifaplusConfig?.escucharEvento) {
        window.rifaplusConfig.escucharEvento('configuracionActualizada', () => {
            actualizarTotalBoletosEnUI();
            actualizarBarraProgreso();
        });
    }
    
    // OPTIMIZACIÓN: Cleanup - detener polling cuando usuario abandona la página
    window.addEventListener('pagehide', function() {
        if (intervalId) {
            clearInterval(intervalId);
            intervalId = null;
        }
    }, true);
})();

console.log('✅ main.js completamente cargado con countdown consolidado');
