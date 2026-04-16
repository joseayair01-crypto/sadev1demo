/**
 * ============================================================
 * ARCHIVO: js/carrito-global.js
 * DESCRIPCIÓN: Gestión del carrito de compra global
 * Sincroniza selecciones, totales y mantiene estado persistente
 * ÚLTIMA ACTUALIZACIÓN: 2025
 * ============================================================
 */

/**
 * 🛡️ FUNCIÓN DEFENSIVA: Leer desde storage de forma segura
 * Intenta usar window.safeTryGetItem si está disponible
 * Si no, usa localStorage directo como fallback
 */
function getItemSafeCarrito(key) {
    try {
        if (typeof window.safeTryGetItem === 'function') {
            return window.safeTryGetItem(key);
        } else {
            // Fallback: localStorage directo
            return localStorage.getItem(key);
        }
    } catch (error) {
        console.warn(`⚠️  [CARRITO] Error leyendo '${key}':`, error.message);
        // Última opción: ver si está en memoria
        if (window.StorageMemoryFallback && window.StorageMemoryFallback[key]) {
            return window.StorageMemoryFallback[key];
        }
        return null;
    }
}

/**
 * 🛡️ FUNCIÓN DEFENSIVA: Guardar en storage de forma segura
 * Intenta usar window.safeTrySetItem si está disponible
 * Si no, usa localStorage directo como fallback
 * NUNCA falla - siempre tiene un plan B
 */
function setItemSafeCarrito(key, value) {
    try {
        if (typeof window.safeTrySetItem === 'function') {
            return window.safeTrySetItem(key, value);
        } else {
            // Fallback: localStorage directo
            localStorage.setItem(key, value);
            return true;
        }
    } catch (error) {
        console.warn(`⚠️  [CARRITO] Error guardando '${key}':`, error.message);
        // Última opción: intentar en memoria
        if (!window.StorageMemoryFallback) window.StorageMemoryFallback = {};
        window.StorageMemoryFallback[key] = value;
        return false;
    }
}

/**
 * 🧹 Limpiar caché de oportunidades por boleto
 * Se llama cuando se vacía el carrito
 */

/* ============================================================ */
/* SECCIÓN 1: INICIALIZACIÓN DEL CARRITO                       */
// Todas las funciones de cálculo de precios están delegadas
// al módulo centralizado calculo-precios.js
// obtenerPrecioDinamico() y calcularDescuentoGlobal() se usan desde allí

// ⚡ CACHÉ del estado renderizado (evita re-renderizar si no cambió)
let cachedBoletosHash = null;
let cachedResumenHash = null;
let isCarritoModalOpen = false;
let carritoItemsDelegationBound = false;
const CARRITO_DEBUG_KEY = 'rifaplus_debug_carrito';

function debugCarrito() {
    let enabled = window.RIFAPLUS_DEBUG_CARRITO === true;

    if (!enabled) {
        try {
            enabled = localStorage.getItem(CARRITO_DEBUG_KEY) === 'true';
        } catch (error) {
            enabled = false;
        }
    }

    if (enabled && typeof console !== 'undefined' && typeof console.debug === 'function') {
        console.debug('[CARRITO]', ...arguments);
    }
}

function obtenerBoletosOrdenadosCarrito() {
    return obtenerBoletosSelecionados().slice().sort((a, b) => a - b);
}

function construirSnapshotBoletosCarrito(numerosOrdenados, oportunidadesHabilitadas) {
    return JSON.stringify({
        numeros: numerosOrdenados,
        oportunidades: Boolean(oportunidadesHabilitadas)
    });
}

function construirSnapshotResumenCarrito(calcTotal) {
    return JSON.stringify({
        cantidad: calcTotal.cantidadBoletos,
        subtotal: calcTotal.subtotal,
        descuento: calcTotal.descuentoMonto,
        total: calcTotal.totalFinal
    });
}

function debeRenderizarCarritoConSnapshot(carritoItems, snapshotBoletos) {
    return cachedBoletosHash !== snapshotBoletos || !carritoItems || carritoItems.children.length === 0;
}

function obtenerRefsResumenCarrito() {
    return {
        carritoResumen: document.getElementById('carritoResumen'),
        carritoResumenCantidad: document.getElementById('carritoResumenCantidad'),
        carritoResumenDescuento: document.getElementById('carritoResumenDescuento'),
        carritoResumenTotal: document.getElementById('carritoResumenTotal'),
        carritoResumenSubtotal: document.getElementById('carritoResumenSubtotal'),
        descuentoPromoLabel: document.getElementById('descuentoPromoLabel'),
        btnProcederCarrito: document.getElementById('btnProcederCarrito'),
        carritoFooter: document.getElementById('carritoFooter')
    };
}

function carritoModalEstaActivo() {
    const carritoModal = document.getElementById('carritoModal');
    return Boolean(carritoModal && carritoModal.classList.contains('active'));
}

function leerBoletosGuardadosCarrito() {
    try {
        const stored = getItemSafeCarrito('rifaplusSelectedNumbers');
        const parsed = stored ? JSON.parse(stored) : [];

        return Array.isArray(parsed)
            ? parsed.map(n => parseInt(n, 10)).filter(n => !Number.isNaN(n))
            : [];
    } catch (error) {
        return [];
    }
}

function restablecerEstadoVisualBoleto(numero) {
    const botonNumero = document.querySelector(`.numero-btn[data-numero="${numero}"]`);
    if (!botonNumero) {
        return;
    }

    botonNumero.classList.remove('selected', 'is-pending', 'is-processing');
    botonNumero.disabled = false;
    botonNumero.style.transform = 'scale(1)';
}

function configurarDelegacionItemsCarrito() {
    const carritoItems = document.getElementById('carritoItems');
    if (!carritoItems || carritoItemsDelegationBound) {
        return;
    }

    carritoItems.addEventListener('click', function(e) {
        const botonEliminar = e.target.closest('.carrito-item-trash-btn');
        if (!botonEliminar) {
            return;
        }

        e.stopPropagation();
        const numero = parseInt(botonEliminar.getAttribute('data-numero'), 10);
        removerBoletoSeleccionado(numero);
    });

    carritoItemsDelegationBound = true;
}

function aplicarEstadoVacioCarrito({ carritoVacio, carritoLista, carritoResumen, carritoFooter, btnProcederCarrito }) {
    carritoVacio.style.display = 'flex';
    carritoLista.style.display = 'none';
    if (carritoResumen) carritoResumen.style.display = 'none';
    if (carritoFooter) carritoFooter.style.display = 'none';

    const modalEl = document.querySelector('.modal-carrito');
    if (modalEl && !modalEl.classList.contains('empty-cart')) {
        modalEl.classList.add('empty-cart');
    }

    if (btnProcederCarrito) {
        btnProcederCarrito.disabled = true;
        btnProcederCarrito.textContent = 'Ir a Comprar';
    }
}

function aplicarEstadoConItemsCarrito({ carritoVacio, carritoLista, carritoResumen, carritoFooter, btnProcederCarrito }) {
    carritoVacio.style.display = 'none';
    carritoLista.style.display = 'block';

    const modalEl = document.querySelector('.modal-carrito');
    if (modalEl && modalEl.classList.contains('empty-cart')) {
        modalEl.classList.remove('empty-cart');
    }

    if (carritoResumen) {
        carritoResumen.style.display = 'flex';
        carritoResumen.style.visibility = 'visible';
        carritoResumen.style.opacity = '1';
    }

    if (carritoFooter) {
        carritoFooter.style.display = 'flex';
        carritoFooter.style.visibility = 'visible';
    }

    if (btnProcederCarrito) {
        btnProcederCarrito.disabled = false;
        btnProcederCarrito.textContent = 'Proceder al pago';
    }
}

function renderizarItemsCarrito(carritoItems, numerosOrdenados, oportunidadesHabilitadas) {
    const htmlParts = [];

    for (let i = 0; i < numerosOrdenados.length; i += 1) {
        const numero = numerosOrdenados[i];
        const numeroFormato = window.rifaplusConfig.formatearNumeroBoleto(numero);

        htmlParts.push(`<div class="carrito-item" data-numero="${numero}" data-index="${i}"><div class="carrito-item-numero"><div class="carrito-item-ticket-label"><span class="carrito-item-ticket-text">Boleto</span><span class="boleto-numero"><i class="fas fa-ticket-alt"></i> ${numeroFormato}</span></div></div><button class="carrito-item-trash-btn" data-numero="${numero}" aria-label="Eliminar boleto ${numero}" title="Eliminar boleto ${numero}"><i class="fas fa-trash carrito-item-trash" aria-hidden="true"></i></button></div>`);

        if (oportunidadesHabilitadas) {
            htmlParts.push(`<div class="carrito-item carrito-item-oportunidades-container" data-numero="${numero}" data-oportunidades="pending"><div class="carrito-item-numero carrito-item-numero--full"><span class="carrito-item-oportunidades-text"><i class="fas fa-spinner carrito-item-oportunidades-check carrito-item-oportunidades-check--loading"></i><strong>Oportunidades:</strong> <span class="carrito-item-oportunidades-status">cargando...</span></span></div></div>`);
        }
    }

    carritoItems.innerHTML = htmlParts.join('');
}

function actualizarResumenCarritoDOM(refs, calcTotal) {
    const resumenHash = construirSnapshotResumenCarrito(calcTotal);
    if (cachedResumenHash === resumenHash) {
        return;
    }

    cachedResumenHash = resumenHash;

    if (refs.carritoResumenCantidad) refs.carritoResumenCantidad.textContent = calcTotal.cantidadBoletos;
    if (refs.carritoResumenSubtotal) refs.carritoResumenSubtotal.textContent = `$${calcTotal.subtotal.toFixed(2)}`;
    if (refs.carritoResumenDescuento) refs.carritoResumenDescuento.textContent = `$${calcTotal.descuentoMonto.toFixed(2)}`;
    if (refs.carritoResumenTotal) refs.carritoResumenTotal.textContent = `$${calcTotal.totalFinal.toFixed(2)}`;
    if (refs.descuentoPromoLabel) {
        refs.descuentoPromoLabel.style.display = calcTotal.descuentoMonto > 0 ? 'inline-block' : 'none';
    }

    try {
        setItemSafeCarrito('rifaplus_total', JSON.stringify({
            subtotal: calcTotal.subtotal,
            descuento: calcTotal.descuentoMonto,
            totalFinal: calcTotal.totalFinal,
            precioUnitario: calcTotal.precioUnitario,
            cantidad: calcTotal.cantidadBoletos
        }));
    } catch (e) {
        // Silent fail.
    }
}

/**
 * 🎯 FUNCIÓN GLOBAL: Asegurar OportunidadesManager está cargado
 * Definida a nivel global para ser accesible desde cualquier función
 */
function asegurarOportunidadesManagerCargado() {
    // Si ya está cargado, no hacer nada
    if (window.oportunidadesManager) {
        debugCarrito('OportunidadesManager ya estaba cargado');
        return true;
    }
    
    // Verificar si oportunidades están habilitadas en config
    const oportunidadesEnabled = window.rifaplusConfig?.rifa?.oportunidades?.enabled;
    if (!oportunidadesEnabled) {
        debugCarrito('Oportunidades deshabilitadas; no hace falta cargar el manager');
        return true; // No necesario, pero no es error
    }
    
    // Verificar que la clase OportunidadesManager esté disponible
    if (typeof OportunidadesManager === 'undefined') {
        console.warn('[CARRITO] ⚠️  OportunidadesManager no está disponible (archivo no cargado)');
        return false;
    }
    
    // Crear instancia bajo demanda
    try {
        window.oportunidadesManager = new OportunidadesManager();
        debugCarrito('OportunidadesManager inicializado bajo demanda');
        return true;
    } catch (error) {
        console.error('[CARRITO] ❌ Error inicializando OportunidadesManager:', error);
        return false;
    }
}

function enlazarListenersOportunidadesCarrito(numerosOrdenados) {
    if (!window.oportunidadesManager) return;

    if (!window.__rifaplusCarritoOppHandlers) {
        window.__rifaplusCarritoOppHandlers = {};
    }

    if (window.__rifaplusCarritoOppHandlers.onComplete) {
        window.oportunidadesManager.off('onComplete', window.__rifaplusCarritoOppHandlers.onComplete);
    }

    if (window.__rifaplusCarritoOppHandlers.onError) {
        window.oportunidadesManager.off('onError', window.__rifaplusCarritoOppHandlers.onError);
    }

    window.__rifaplusCarritoOppHandlers.onComplete = () => {
        debugCarrito('Oportunidades listas; actualizando UI del carrito');

        if (typeof actualizarOportunidadesEnCarrito === 'function') {
            actualizarOportunidadesEnCarrito(numerosOrdenados);
        } else if (typeof window.actualizarOportunidadesEnCarrito === 'function') {
            window.actualizarOportunidadesEnCarrito(numerosOrdenados);
        } else {
            console.warn('[CARRITO] ⚠️ Función actualizarOportunidadesEnCarrito no disponible');
        }

        if (typeof window.sincronizarOportunidadesAlCarrito === 'function') {
            setTimeout(() => {
                window.sincronizarOportunidadesAlCarrito();
                debugCarrito('Oportunidades globales sincronizadas para otros modulos');
            }, 100);
        }
    };

    window.__rifaplusCarritoOppHandlers.onError = (error) => {
        console.warn('[CARRITO] ⚠️ Error cargando oportunidades (carrito continúa funcionando):', error);
    };

    window.oportunidadesManager.on('onComplete', window.__rifaplusCarritoOppHandlers.onComplete);
    window.oportunidadesManager.on('onError', window.__rifaplusCarritoOppHandlers.onError);
}

/**
 * Inicializa el carrito cuando el DOM está listo
 */
document.addEventListener('DOMContentLoaded', function() {
    inicializarCarritoGlobal();
});

/**
 * inicializarCarritoGlobal - Configura listeners y actualiza estado inicial
 * @returns {void}
 */
function inicializarCarritoGlobal() {
    const carritoNav = document.getElementById('carritoNav');
    const carritoModal = document.getElementById('carritoModal');
    configurarDelegacionItemsCarrito();
    
    // Actualizar el contador inmediatamente al cargar la página
    if (window.actualizarContadorCarritoGlobal) window.actualizarContadorCarritoGlobal();
    
    // 🔥 VERIFICAR SI HAY ORDEN ENVIADA Y LIMPIAR CARRITO
    if (getItemSafeCarrito('rifaplusOrdenEnviada') === 'true') {
        localStorage.removeItem('rifaplusSelectedNumbers');
        localStorage.removeItem('rifaplusOrdenEnviada');
        if (typeof selectedNumbersGlobal !== 'undefined' && selectedNumbersGlobal.clear) {
            selectedNumbersGlobal.clear();
        }
        if (window.actualizarContadorCarritoGlobal) window.actualizarContadorCarritoGlobal();
    }
    
    if (!carritoNav || !carritoModal) return;

    // Abrir carrito al hacer click en el icono
    carritoNav.addEventListener('click', function(e) {
        e.stopPropagation();
        
        // ⚡ OPTIMIZACIÓN: Si ya está abierto, solo mostrar sin re-renderizar
        if (carritoModal.classList.contains('active')) {
            return; // Ya está abierto, no hacer nada
        }
        
        // ⚡ Sincronizar carrito SOLO si la modal no está activa
        if (typeof selectedNumbersGlobal !== 'undefined') {
            const stored = getItemSafeCarrito('rifaplusSelectedNumbers');
            const storedArray = stored ? JSON.parse(stored).map(n => parseInt(n, 10)) : [];
            // Si hay diferencias, sincronizar (evitar loop innecesario)
            if (storedArray.length !== selectedNumbersGlobal.size) {
                selectedNumbersGlobal.clear();
                // ⭐ IMPORTANTE: Convertir a números al sincronizar
                storedArray.forEach(num => selectedNumbersGlobal.add(parseInt(num, 10)));
            }
        }
        
        carritoModal.classList.add('active');
        window.rifaplusModalScrollLock?.sync?.();
        isCarritoModalOpen = true;
        
        // 🎯 FIX SENIOR: Asegurar que OportunidadesManager esté cargado ANTES de renderizar
        // Esto permite que oportunidades carguen desde CUALQUIER página, no solo compra.html
        asegurarOportunidadesManagerCargado();
        
        // ⚡ RENDERIZAR SOLO SI CAMBIÓ (check hash rápido)
        const boletosActuales = obtenerBoletosOrdenadosCarrito();
        const hashActual = construirSnapshotBoletosCarrito(
            boletosActuales,
            window.rifaplusConfig?.rifa?.oportunidades?.enabled || false
        );
        
        if (debeRenderizarCarritoConSnapshot(document.getElementById('carritoItems'), hashActual)) {
            // ⚡ Usar requestAnimationFrame para no bloquear el thread
            requestAnimationFrame(() => {
                actualizarVistaCarritoGlobal();
                if (window.actualizarContadorCarritoGlobal) window.actualizarContadorCarritoGlobal();
            });
        } else {
            // Boletos no cambiaron, solo actualizar contador y mostrar
            if (window.actualizarContadorCarritoGlobal) window.actualizarContadorCarritoGlobal();
        }
    });

    // Cerrar carrito
    const closeCarrito = document.getElementById('closeCarrito');
    if (closeCarrito) {
        closeCarrito.addEventListener('click', cerrarCarritoGlobal);
    }

    carritoModal.addEventListener('click', function(e) {
        const actionButton = e.target.closest('#btnLimpiarCarrito, #btnProcederCarrito');
        if (actionButton) {
            if (actionButton.id === 'btnLimpiarCarrito') {
                handleLimpiarCarrito();
            } else {
                handleProcederAlPago();
            }
            return;
        }

        if (e.target === carritoModal) {
            cerrarCarritoGlobal();
        }
    });

    // Botón "Seguir comprando"
    const btnSeguirComprando = document.getElementById('btnSeguirComprando');
    if (btnSeguirComprando) {
        btnSeguirComprando.addEventListener('click', cerrarCarritoGlobal);
    }

    // Tecla Escape para cerrar
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && carritoModal && carritoModal.classList.contains('active')) {
            cerrarCarritoGlobal();
        }
    });

    // Botón "Ir a Comprar" (en carrito vacío) - redirigir a compra.html
    const btnIrAComprar = document.getElementById('btnIrAComprar');
    if (btnIrAComprar) {
        btnIrAComprar.addEventListener('click', function() {
            window.location.href = 'compra.html';
        });
    }
}

function cerrarCarritoGlobal() {
    const carritoModal = document.getElementById('carritoModal');
    if (carritoModal) {
        carritoModal.classList.remove('active');
        window.rifaplusModalScrollLock?.sync?.();
        isCarritoModalOpen = false;
    }
}

function obtenerPrecioDinamicoCarrito() {
    if (typeof obtenerPrecioDinamico === 'function') {
        return obtenerPrecioDinamico();
    }

    if (typeof obtenerPrecioBoleto === 'function') {
        return obtenerPrecioBoleto();
    }

    const cfg = window.rifaplusConfig || {};
    const ahora = new Date();
    const precioBase = Number(cfg?.rifa?.precioBoleto);
    const estaActiva = typeof window.rifaplusConfig?.esFechaPromocionActiva === 'function'
        ? window.rifaplusConfig.esFechaPromocionActiva
        : ((inicio, fin, ahoraActual) => {
            const inicioFecha = new Date(inicio);
            const finFecha = new Date(fin);
            return ahoraActual >= inicioFecha && ahoraActual <= finFecha;
        });

    const promo = cfg?.rifa?.promocionPorTiempo;
    if (promo && promo.enabled && promo.precioProvisional !== null && promo.precioProvisional !== undefined) {
        const precioPromo = Number(promo.precioProvisional);

        if (
            estaActiva(promo.fechaInicio, promo.fechaFin, ahora) &&
            !Number.isNaN(precioPromo) &&
            Number.isFinite(precioPromo) &&
            precioPromo >= 0
        ) {
            return precioPromo;
        }
    }

    return (!Number.isNaN(precioBase) && Number.isFinite(precioBase) && precioBase > 0)
        ? precioBase
        : 15;
}

function actualizarVistaCarritoGlobal() {
    const selectedNumbers = obtenerBoletosSelecionados();
    const carritoItems = document.getElementById('carritoItems');
    const carritoVacio = document.getElementById('carritoVacio');
    
    // 🎯 CRÍTICO: Asegurar que OportunidadesManager esté listo ANTES de renderizar
    // Esto previene que oportunidades = null cuando el usuario abre el carrito desde otra página
    asegurarOportunidadesManagerCargado();
    
    // Agregar clase condicional si oportunidades está habilitado
    const oportunidadesHabilitadas = window.rifaplusConfig?.rifa?.oportunidades?.enabled || false;
    
    if (carritoItems) {
        if (oportunidadesHabilitadas) {
            carritoItems.classList.add('oportunidades-enabled');
        } else {
            carritoItems.classList.remove('oportunidades-enabled');
        }
    }
    const carritoLista = document.getElementById('carritoLista');
    let {
        carritoResumen,
        carritoResumenCantidad,
        carritoResumenDescuento,
        carritoResumenTotal,
        btnProcederCarrito,
        carritoFooter
    } = obtenerRefsResumenCarrito();

    if (!carritoItems || !carritoVacio || !carritoLista) return;

    if (selectedNumbers.length === 0) {
        carritoItems.innerHTML = '';
        cachedBoletosHash = construirSnapshotBoletosCarrito([], oportunidadesHabilitadas);
        cachedResumenHash = null;
        aplicarEstadoVacioCarrito({
            carritoVacio,
            carritoLista,
            carritoResumen,
            carritoFooter,
            btnProcederCarrito
        });
        return;
    }

    const numerosOrdenados = selectedNumbers.slice().sort((a, b) => a - b);
    const boletosHash = construirSnapshotBoletosCarrito(numerosOrdenados, oportunidadesHabilitadas);
    const necesitaRenderItems = debeRenderizarCarritoConSnapshot(carritoItems, boletosHash);

    if (!carritoFooter) {
        createCarritoFooter();
        ({
            carritoResumen,
            carritoResumenCantidad,
            carritoResumenDescuento,
            carritoResumenTotal,
            btnProcederCarrito,
            carritoFooter
        } = obtenerRefsResumenCarrito());
    }

    aplicarEstadoConItemsCarrito({
        carritoVacio,
        carritoLista,
        carritoResumen,
        carritoFooter,
        btnProcederCarrito
    });

    const precioUnitario = obtenerPrecioDinamicoCarrito();

    if (necesitaRenderItems) {
        renderizarItemsCarrito(carritoItems, numerosOrdenados, oportunidadesHabilitadas);
        cachedBoletosHash = boletosHash;

        if (oportunidadesHabilitadas && window.oportunidadesManager) {
            enlazarListenersOportunidadesCarrito(numerosOrdenados);
            window.oportunidadesManager.cargar(numerosOrdenados).catch(e => {
                console.error('[CARRITO] Error crítico:', e);
            });
        }
    }

    const calcTotal = calcularDescuentoGlobal(selectedNumbers.length, precioUnitario);
    actualizarResumenCarritoDOM({
        carritoResumen,
        carritoResumenCantidad,
        carritoResumenDescuento,
        carritoResumenTotal,
        carritoResumenSubtotal: document.getElementById('carritoResumenSubtotal'),
        descuentoPromoLabel: document.getElementById('descuentoPromoLabel')
    }, calcTotal);
}

/**
 * ⚡ MEGA OPTIMIZACIÓN: Renderizar en batches SIN calcular oportunidades
 * Con 1,000 números, esto es mucho más rápido
 * Las oportunidades se pueden calcular bajo demanda si el usuario scrollea abajo
 */
/**
 * ⭐ NOTA: La función renderizarRestoEnBatchesRapido fue reemplazada
 * por renderizarRestoConOportunidades que calcula oportunidades en background
 */


function invalidarCacheCarrito() {
    cachedBoletosHash = null;
    cachedResumenHash = null;
    // ⚡ No necesitamos limpiar caché de oportunidades
    // porque es DETERMINÍSTICO: mismo array de boletos = mismas oportunidades
}

function obtenerBoletosSelecionados() {
    // Si estamos en compra.html, usar el Set global
    if (typeof selectedNumbersGlobal !== 'undefined') {
        return Array.from(selectedNumbersGlobal).map(n => parseInt(n, 10));
    }

    return leerBoletosGuardadosCarrito();
}

// Creates the footer DOM and attaches required event listeners
function createCarritoFooter() {
    const modal = document.querySelector('.modal-carrito');
    if (!modal) return;
    
    // Check if footer already exists
    let carritoFooter = document.getElementById('carritoFooter');
    if (!carritoFooter) {
        const footerHtml = `
            <div class="modal-carrito-footer" id="carritoFooter">
                <div class="carrito-resumen" id="carritoResumen">
                    <div class="carrito-resumen-header">
                        <span class="carrito-resumen-title">Resumen de tu compra</span>
                    </div>
                    <div class="carrito-resumen-row">
                        <div class="carrito-resumen-item">
                            <span>Cantidad de boletos:</span>
                            <strong id="carritoResumenCantidad">0</strong>
                        </div>
                        <button class="btn btn-danger btn-sm" id="btnLimpiarCarrito" title="Eliminar todos los boletos" aria-label="Eliminar todos los boletos del carrito">
                            Limpiar carrito
                        </button>
                    </div>
                    <div class="carrito-resumen-item">
                        <span>Subtotal:</span>
                        <strong id="carritoResumenSubtotal">$0</strong>
                    </div>
                    <div class="carrito-resumen-item">
                        <span>Descuento:</span>
                        <div class="descuento-promo-wrap">
                            <strong id="carritoResumenDescuento">$0</strong>
                            <span id="descuentoPromoLabel" class="descuento-promo-label" style="display: none;">PROMO</span>
                        </div>
                    </div>
                    <div class="carrito-resumen-total">
                        <span>Total:</span>
                        <strong id="carritoResumenTotal">$0</strong>
                    </div>
                </div>
                <div class="carrito-acciones carrito-acciones-bottom">
                    <button class="btn btn-outline" id="btnSeguirComprando">Seguir comprando</button>
                    <button class="btn btn-primary btn-lg" id="btnProcederCarrito" disabled>Proceder al pago <span aria-hidden="true">→</span></button>
                </div>
            </div>
        `;
        modal.insertAdjacentHTML('beforeend', footerHtml);
    }

    // Attach event listeners for all controls
    const btnSeguir = document.getElementById('btnSeguirComprando');
    if (btnSeguir) {
        btnSeguir.removeEventListener('click', cerrarCarritoGlobal);
        btnSeguir.addEventListener('click', cerrarCarritoGlobal);
    }

    // Attach listener para botón "Limpiar carrito" - Ya se maneja por event delegation en modal
    // const btnLimpiar = document.getElementById('btnLimpiarCarrito');
    // if (btnLimpiar) {
    //     btnLimpiar.removeEventListener('click', handleLimpiarCarrito);
    //     btnLimpiar.addEventListener('click', handleLimpiarCarrito);
    // }
}

// Separar handler para limpiar carrito
/**
 * Limpiar todo el carrito
 * Remueve todos los boletos seleccionados y sincroniza boletera
 */
function handleLimpiarCarrito() {
    if (confirm('¿Estás seguro de que deseas eliminar todos los boletos del carrito?')) {
        // Obtener todos los números antes de limpiar para actualizar boletera
        const numerosAEliminar = (typeof selectedNumbersGlobal !== 'undefined' && selectedNumbersGlobal) 
            ? Array.from(selectedNumbersGlobal) 
            : [];
        
        // Limpiar datos
        localStorage.removeItem('rifaplusSelectedNumbers');
        if (typeof selectedNumbersGlobal !== 'undefined' && selectedNumbersGlobal) {
            selectedNumbersGlobal.clear();
        }
        
        // Desmarcar todos los botones en la boletera (solo si existen)
        // Este código solo se ejecutará en compra.html donde existen los botones .numero-btn
        numerosAEliminar.forEach(numero => {
            if (typeof window.cancelarValidacionSeleccionPendienteCompra === 'function') {
                window.cancelarValidacionSeleccionPendienteCompra(numero);
            }
            restablecerEstadoVisualBoleto(numero);
        });
        
        // Actualizar todas las vistas
        actualizarVistaCarritoGlobal();
        if (window.actualizarContadorCarritoGlobal) window.actualizarContadorCarritoGlobal();
        if (window.actualizarResumenCompra) window.actualizarResumenCompra();
        
        rifaplusUtils.showFeedback('✅ Carrito limpiado correctamente', 'success');
    }
}

/**
 * Manejador para botón "Proceder al pago"
 * Abre el modal de contacto o inicia flujo en compra.html
 */
function handleProcederAlPago() {
    // Si ya estamos en compra.html, iniciar el flujo de pago
    if (window.location.pathname.includes('compra.html') || window.location.href.includes('compra.html')) {
        if (typeof iniciarFlujoPago === 'function') {
            iniciarFlujoPago();
        }
    } else {
        // Si estamos en otra página, marcar para iniciar flujo al llegar a compra.html
        setItemSafeCarrito('rifaplusIniciarFlujoPago', 'true');
        window.location.href = 'compra.html';
    }
}

/**
 * Remover un boleto seleccionado
 * Sincroniza: Set global, localStorage, boletera, carrito y resumen
 * También revierte cambios en resultados de búsqueda si están visibles
 */
function removerBoletoSeleccionado(numero) {
    // ⚡ OPTIMIZACIÓN: Hacer la remoción INSTANTÁNEA
    
    // Asegurar que numero es un integer
    numero = parseInt(numero, 10);
    const numeroComoTexto = String(numero);

    if (typeof window.cancelarValidacionSeleccionPendienteCompra === 'function') {
        window.cancelarValidacionSeleccionPendienteCompra(numero);
    }
    
    // 1. Remover del Set global - INMEDIATO
    if (typeof selectedNumbersGlobal !== 'undefined') {
        selectedNumbersGlobal.delete(numero);
        selectedNumbersGlobal.delete(numeroComoTexto);
    }
    
    // 2. Desmarcar en la boletera - INMEDIATO
    restablecerEstadoVisualBoleto(numero);
    
    // 3. Actualizar localStorage INMEDIATO (es rápido)
    let numbers = leerBoletosGuardadosCarrito();
    numbers = numbers.filter(n => Number(n) !== numero);
    setItemSafeCarrito('rifaplusSelectedNumbers', JSON.stringify(numbers));
    
    // 4. Actualizar resultados si está visible
    if (typeof restaurarNumeroDisponibleEnBusqueda === 'function') {
        restaurarNumeroDisponibleEnBusqueda(numero);
    }
    
    // 5. Invalidar caché
    invalidarCacheCarrito();
    
    // 6. 🧹 LIMPIAR OPORTUNIDADES DEL BOLETO (mantener sincronizado)
    if (window.rifaplusOportunidadesCarrito && typeof window.rifaplusOportunidadesCarrito === 'object') {
        delete window.rifaplusOportunidadesCarrito[String(numero)];
    }
    
    // 7. ⭐ RECALCULAR OPORTUNIDADES EN ORDEN (si existe)
    // Si hay una orden en proceso, actualizar sus oportunidades
    try {
        const ordenActualStr = localStorage.getItem('rifaplus_orden_actual');
        if (ordenActualStr) {
            const ordenTemp = JSON.parse(ordenActualStr);
            if (Array.isArray(ordenTemp.boletos)) {
                // Verificar que el boleto removido estaba en la orden
                const boletoEstabaEnOrden = ordenTemp.boletos.some(b => Number(b) === numero);
                if (boletoEstabaEnOrden) {
                    // Recalcular oportunidades: solo incluir las del boleto removido
                    if (Array.isArray(ordenTemp.boletosOcultos)) {
                        // Las oportunidades se recalculan en orden-formal.js.
                    }
                }
            }
        }
    } catch (e) {
        console.warn('[CARRITO] ⚠️ Error actualizando orden:', e.message);
    }
    
    // 8. ⭐ USAR DEBOUNCE AGRESIVO PARA ACTUALIZACIONES (mismo que en agregar)
    // Agrupa múltiples remociones rápidas en una actualización
    actualizarCarritoConDebounceAgresivo();
    
    rifaplusUtils.showFeedback(`✅ Boleto #${numero} removido del carrito`, 'success');
}

/**
 * Agregar un boleto al carrito (sincroniza Set global y localStorage)
 * @param {number} numero - Número del boleto a agregar
 * @returns {boolean} - true si se agregó, false si ya estaba
 */
function agregarBoletoSelecionado(numero) {
    // Si estamos en compra.html, usar el Set global
    if (typeof selectedNumbersGlobal !== 'undefined') {
        if (selectedNumbersGlobal.has(numero)) {
            return false; // Ya está seleccionado
        }
        selectedNumbersGlobal.add(numero);
        sincronizarCarritoAlLocalStorage();
    } else {
        // En otras páginas, usar localStorage
        let stored = localStorage.getItem('rifaplusSelectedNumbers');
        let numbers = stored ? JSON.parse(stored).map(n => parseInt(n, 10)) : [];
        
        numero = parseInt(numero, 10);
        if (numbers.includes(numero)) {
            return false; // Ya está seleccionado
        }
        
        numbers.push(numero);
        setItemSafeCarrito('rifaplusSelectedNumbers', JSON.stringify(numbers));
    }
    
    // Actualizar todas las vistas
    if (window.actualizarContadorCarritoGlobal) window.actualizarContadorCarritoGlobal();
    if (isCarritoModalOpen && window.actualizarVistaCarritoGlobal) window.actualizarVistaCarritoGlobal();
    if (window.actualizarResumenCompra) window.actualizarResumenCompra();
    
    return true;
}

/**
 * 🚀 OPTIMIZACIÓN: Agregar múltiples boletos sin actualizar la vista cada vez
 * Perfecto para máquina de la suerte que agrega 50+ boletos
 * @param {number[]} numeros - Array de números a agregar
 * @returns {boolean} - true si agregó al menos uno
 */
function agregarMuchosBoletosAlCarrito(numeros) {
    if (!Array.isArray(numeros) || numeros.length === 0) return false;
    
    let agregados = 0;
    
    // ⚡ Agregar todos PRIMERO sin actualizar vistas
    if (typeof selectedNumbersGlobal !== 'undefined') {
        // Compra.html
        numeros.forEach(numero => {
            if (!selectedNumbersGlobal.has(numero)) {
                selectedNumbersGlobal.add(numero);
                agregados++;
            }
        });
        sincronizarCarritoAlLocalStorage();
    } else {
        // Otras páginas
        let stored = localStorage.getItem('rifaplusSelectedNumbers');
        let numbers = stored ? JSON.parse(stored) : [];
        const setNumbers = new Set(numbers);
        
        numeros.forEach(numero => {
            if (!setNumbers.has(numero)) {
                setNumbers.add(numero);
                agregados++;
            }
        });
        
        setItemSafeCarrito('rifaplusSelectedNumbers', JSON.stringify(Array.from(setNumbers)));
    }
    
    if (agregados === 0) return false;
    
    // ⚡ Actualizar UNA SOLA VEZ al final (no 50 veces)
    if (window.actualizarContadorCarritoGlobal) window.actualizarContadorCarritoGlobal();
    if (window.actualizarResumenCompra) window.actualizarResumenCompra();
    
    // No actualizar vista del carrito si no está abierto
    const carritoModal = document.getElementById('carritoModal');
    if (carritoModal && carritoModal.classList.contains('active')) {
        if (window.actualizarVistaCarritoGlobal) window.actualizarVistaCarritoGlobal();
    }
    
    return true;
}

function calcularDescuentoGlobal(cantidad, precioUnitario = null) {
    // NOTA: Esta función ahora delega al módulo centralizado calculo-precios.js
    // Se mantiene aquí por compatibilidad, pero internamente usa calcularTotalConPromociones
    if (typeof calcularTotalConPromociones === 'function') {
        return calcularTotalConPromociones(cantidad, precioUnitario);
    }
    
    // Fallback si calculo-precios.js no está cargado (calcular con precio unitario base)
    precioUnitario = precioUnitario || window.rifaplusConfig?.obtenerPrecioBoleto?.() || Number(window.rifaplusConfig?.rifa?.precioBoleto || 0);
    const subtotal = cantidad * precioUnitario;
    return {
        cantidadBoletos: cantidad,
        precioUnitario: precioUnitario,
        subtotal: subtotal,
        descuentoMonto: 0,
        descuentoPorcentaje: 0,
        totalFinal: subtotal
    };
}

// Función para sincronizar carrito al seleccionar en compra.html
// ⚡ Debounce para sincronización a localStorage (evita escribir múltiples veces)
let sincronizarTimeout = null;

function sincronizarCarritoAlLocalStorage() {
    // ⚡ MEGA OPTIMIZACIÓN: Usar debounce para localStorage
    // Si se llama múltiples veces rápido, solo sincroniza UNA VEZ después de 100ms
    
    if (sincronizarTimeout) {
        clearTimeout(sincronizarTimeout);
    }
    
    sincronizarTimeout = setTimeout(() => {
        if (typeof selectedNumbersGlobal !== 'undefined') {
            try {
                const numbers = Array.from(selectedNumbersGlobal)
                    .map((n) => parseInt(n, 10))
                    .filter((n) => !Number.isNaN(n));
                setItemSafeCarrito('rifaplusSelectedNumbers', JSON.stringify(numbers));
            } catch (e) {
                console.warn('[CARRITO] Error sincronizando a localStorage:', e.message);
            }
        }
        sincronizarTimeout = null;
    }, 100);  // Espera 100ms antes de escribir
}

// Actualizar contador del carrito globalmente
var _ultimoContadorCarrito = -1; // ⚡ Caché para evitar DOM updates innecesarios

function actualizarContadorCarritoGlobal() {
    // 🔥 FUENTE ÚNICA DE VERDAD: selectedNumbersGlobal si está disponible (es más rápido)
    let cantidad = 0;
    if (typeof selectedNumbersGlobal !== 'undefined') {
        cantidad = selectedNumbersGlobal.size;
    } else {
        cantidad = leerBoletosGuardadosCarrito().length;
    }
    
    // ⚡ Solo actualizar DOM si el número cambió
    if (cantidad !== _ultimoContadorCarrito) {
        _ultimoContadorCarrito = cantidad;
        const carritoCount = document.querySelector('.carrito-count');
        if (carritoCount) {
            carritoCount.textContent = cantidad;
        }
    }
}

/**
 * ⚡ MEGA OPTIMIZACIÓN: Debounce ultra-agresivo para actualizaciones de carrito
 * Agrupa múltiples clicks en una sola actualización del DOM
 * Reduce lag de 5+ segundos a imperceptible
 */
let debounceCarritoTimeout = null;
let debounceCarritoTriggers = 0;

function actualizarCarritoConDebounceAgresivo() {
    debounceCarritoTriggers++;
    
    // Si ya hay un timeout, no hacer nada (agrupa el click actual)
    if (debounceCarritoTimeout) {
        return;
    }
    
    // Ejecutar actualización después de 50ms (agrupa clicks rápidos)
    debounceCarritoTimeout = setTimeout(() => {
        // ⭐ AQUÍ OCURREN TODAS LAS ACTUALIZACIONES DE UNA VEZ
        // Solo el contador es "barato", los demás se evitan si no es necesario
        actualizarContadorCarritoGlobal();
        
        // Actualizar carrito visual pero SOLO si está abierto (no bloquea si está cerrado)
        if (carritoModalEstaActivo()) {
            // Solo actualizar si carrito está visible
            actualizarVistaCarritoGlobal();
        }
        
        // Resumen: actualizar COUNT pero no lista completa
        if (typeof actualizarResumenCompraConDebounce === 'function') {
            actualizarResumenCompraConDebounce();
        }
        
        // Reset
        debounceCarritoTimeout = null;
        debounceCarritoTriggers = 0;
    }, 50); // 50ms es imperceptible para humano pero agrupa clicks rápidos
}

// Exportar funciones globalmente
window.actualizarCarritoConDebounceAgresivo = actualizarCarritoConDebounceAgresivo;
window.actualizarContadorCarritoGlobal = actualizarContadorCarritoGlobal;
window.actualizarVistaCarritoGlobal = actualizarVistaCarritoGlobal;
window.obtenerBoletosSelecionados = obtenerBoletosSelecionados;
window.agregarBoletoSelecionado = agregarBoletoSelecionado;
window.removerBoletoSeleccionado = removerBoletoSeleccionado;

/**
 * ⚙️ FUNCIONES REMOVIDAS (Sistema antiguo de asignación dinámica)
 * 
 * Las siguientes funciones fueron removidas porque con el nuevo sistema pre-asignado,
 * las oportunidades vienen de la BD via FK CASCADE y no necesitan cálculo en cliente:
 * 
 * ❌ REMOVIDA: calcularYLlenarOportunidades() - Calculaba oportunidades dinámicamente
 * ❌ REMOVIDA: mostrarOportunidadesDelCache() - Mostraba cache local de oportunidades
 * ❌ REMOVIDA: guardarOportunidadesBoleto() - No necesario con DB pre-assigned
 */
