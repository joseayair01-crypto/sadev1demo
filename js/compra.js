/**
 * ============================================================
 * ARCHIVO: js/compra.js
 * DESCRIPCIÓN: Lógica de compra y selección de boletos
 * Gestiona la interfaz de compra, máquina de suerte,
 * selección de números y sincronización con el carrito
 * ÚLTIMA ACTUALIZACIÓN: 2025
 * ============================================================
 */

/* ============================================================ */
/* SECCIÓN 1: CONFIGURACIÓN GLOBAL Y VARIABLES DE ESTADO         */
/* ============================================================ */

function debugCompraHabilitado() {
    const debugGlobal = window.RIFAPLUS_DEBUG || window.rifaplusDebug;
    return debugGlobal === true || Boolean(debugGlobal?.compra);
}

function logCompraDebug(...args) {
    if (debugCompraHabilitado()) {
        console.log(...args);
    }
}

// Función para obtener precio dinámico desde config (robusta)
// ✅ ACTUALIZADO: Verifica promoción por tiempo
function obtenerPrecioDinamico() {
    const cfg = window.rifaplusConfig || {};
    const ahora = new Date();
    const estaActiva = typeof window.rifaplusConfig?.esFechaPromocionActiva === 'function'
        ? window.rifaplusConfig.esFechaPromocionActiva
        : ((inicio, fin, ahoraActual) => {
            const inicioFecha = new Date(inicio);
            const finFecha = new Date(fin);
            return ahoraActual >= inicioFecha && ahoraActual <= finFecha;
        });
    
    // Verificar si hay promoción por tiempo activa
    const promo = cfg.rifa?.promocionPorTiempo;
    if (promo && promo.enabled && promo.precioProvisional !== null && promo.precioProvisional !== undefined) {
        // Si estamos dentro del rango permitido, usar precio provisional
        if (estaActiva(promo.fechaInicio, promo.fechaFin, ahora)) {
            const precioProvisional = Number(promo.precioProvisional);
            if (!Number.isNaN(precioProvisional) && isFinite(precioProvisional) && precioProvisional >= 0) {
                logCompraDebug(`[compra] Promocion activa con precio provisional: $${precioProvisional.toFixed(2)}`);
                return precioProvisional;
            }
        }
    }
    
    // Si no hay promoción activa, usar precio normal
    const price = Number(cfg && cfg.rifa && cfg.rifa.precioBoleto);
    return (!Number.isNaN(price) && isFinite(price) && price > 0) ? price : 0;
}

// Almacenar selecciones globales (persiste al cambiar rangos)
var selectedNumbersGlobal = new Set();

// Guardar estado del filtro de disponibles (persiste al cambiar rangos)
var filtroDisponiblesActivo = true;
var resumenPersistidoSnapshot = '';
var rangoInitSuscrito = false;
var validacionesSeleccionPendientes = new Map();
var secuenciaValidacionSeleccion = 0;
var refrescoEstadoBoletosTimeoutId = 0;
var refrescoEstadoBoletosUltimoMotivo = '';
var observerEstadoBoletosVisibles = null;
var actualizacionEstadoGridFrameId = 0;
var actualizacionEstadoGridVersion = 0;
var loadingGridHideTimeoutId = 0;
var loadingGridShowTimeoutId = 0;
var loadingGridVisibleSince = 0;

// Inicializar arrays de boletos vendidos/apartados (se llenan después desde API)
if (!window.rifaplusSoldNumbers) window.rifaplusSoldNumbers = [];
if (!window.rifaplusReservedNumbers) window.rifaplusReservedNumbers = [];

// 🚀 INICIALIZAR MAQUINA COMO HABILITADA DESDE EL PRINCIPIO
// Permite que funcione incluso si el backend es lento o falla
window.rifaplusBoletosLoaded = true;

/* ============================================================ */
/* INFINITE SCROLL STATE */
/* ============================================================ */
var infiniteScrollState = {
    rangoActual: { inicio: 0, fin: 99 },
    boletosCargados: 0,
    cursorNumero: 0,
    modoDisponibles: false,
    BOLETOS_POR_CARGA: 500,  // ⭐ OPTIMIZACIÓN: Reducido de 1000 a 500 para mejor performance
    isLoading: false,
    hasMore: true,
    observer: null,
    lastRenderTime: 0,  // ⭐ Para debounce
    renderDebounceMs: 300,  // ⭐ Debounce render calls
    renderRequestId: 0
};

var rifaplusEstadoRangoActual = {
    inicio: null,
    fin: null,
    cargado: false,
    requestId: 0,
    endpoint: '',
    pendingKey: '',
    pendingPromise: null
};

function obtenerApiBaseCompra() {
    let endpoint = (window.rifaplusConfig && window.rifaplusConfig.backend && window.rifaplusConfig.backend.apiBase)
        ? window.rifaplusConfig.backend.apiBase
        : 'http://localhost:3000';
    return String(endpoint).replace(/\/+$/, '');
}

function obtenerRangoVisibleInicial() {
    const totalTickets = window.rifaplusConfig?.rifa?.totalBoletos || 100;
    const oportunidadesConfig = window.rifaplusConfig?.rifa?.oportunidades;

    if (oportunidadesConfig && oportunidadesConfig.enabled && oportunidadesConfig.rango_visible) {
        const inicioVisible = parseInt(oportunidadesConfig.rango_visible.inicio, 10);
        const finVisible = parseInt(oportunidadesConfig.rango_visible.fin, 10);
        return {
            inicio: Number.isInteger(inicioVisible) ? inicioVisible : 0,
            fin: Number.isInteger(finVisible) ? finVisible : Math.max(0, totalTickets - 1)
        };
    }

    return {
        inicio: 0,
        fin: Math.max(0, totalTickets - 1)
    };
}

function obtenerClaveEstadoRango(endpoint, inicio, fin) {
    return `${String(endpoint || '').replace(/\/+$/, '')}::${inicio}-${fin}`;
}

function obtenerEstadoLocalBoletos() {
    const sold = Array.isArray(window.rifaplusSoldNumbers) ? window.rifaplusSoldNumbers : [];
    const reserved = Array.isArray(window.rifaplusReservedNumbers) ? window.rifaplusReservedNumbers : [];

    return {
        sold,
        reserved,
        soldSet: new Set(sold),
        reservedSet: new Set(reserved)
    };
}

function numeroEnRangoActual(numero) {
    const rango = infiniteScrollState.rangoActual || {};
    return Number.isInteger(numero) &&
        Number.isInteger(rango.inicio) &&
        Number.isInteger(rango.fin) &&
        numero >= rango.inicio &&
        numero <= rango.fin;
}

function normalizarRangoNumerico(inicio, fin) {
    let inicioNormalizado = parseInt(inicio, 10);
    let finNormalizado = parseInt(fin, 10);

    if (!Number.isInteger(inicioNormalizado)) {
        inicioNormalizado = 0;
    }

    if (!Number.isInteger(finNormalizado)) {
        finNormalizado = inicioNormalizado + 99;
    }

    if (inicioNormalizado > finNormalizado) {
        const temporal = inicioNormalizado;
        inicioNormalizado = finNormalizado;
        finNormalizado = temporal;
    }

    return {
        inicio: inicioNormalizado,
        fin: finNormalizado
    };
}

function estaVistaBusquedaActiva() {
    const sentinel = document.getElementById('infiniteScrollSentinel');
    const toolbarBusquedaVisible = document.getElementById('busquedaGridToolbar')?.classList.contains('is-visible');
    return (sentinel && sentinel.style.display === 'none') || toolbarBusquedaVisible === true;
}

function mostrarEstadoCargaGrid(activo) {
    const loadingEl = document.getElementById('loadingEstadoBoletos');
    const gridEl = document.getElementById('numerosGrid');
    const shellEl = document.getElementById('boletosGridShell');
    const SHOW_DELAY_MS = 140;
    const MIN_VISIBLE_MS = 220;

    function aplicarEstadoVisible() {
        if (!loadingEl) {
            return;
        }

        if (loadingGridShowTimeoutId) {
            clearTimeout(loadingGridShowTimeoutId);
            loadingGridShowTimeoutId = 0;
        }

        loadingEl.hidden = false;
        loadingEl.classList.add('is-visible');
        loadingGridVisibleSince = Date.now();
    }

    if (loadingEl) {
        if (loadingGridHideTimeoutId) {
            clearTimeout(loadingGridHideTimeoutId);
            loadingGridHideTimeoutId = 0;
        }

        if (activo) {
            if (!loadingEl.classList.contains('is-visible') && !loadingGridShowTimeoutId) {
                loadingGridShowTimeoutId = setTimeout(() => {
                    aplicarEstadoVisible();
                }, SHOW_DELAY_MS);
            } else if (loadingEl.classList.contains('is-visible')) {
                loadingEl.hidden = false;
            }
        } else {
            if (loadingGridShowTimeoutId) {
                clearTimeout(loadingGridShowTimeoutId);
                loadingGridShowTimeoutId = 0;
            }

            const tiempoVisible = loadingGridVisibleSince ? (Date.now() - loadingGridVisibleSince) : MIN_VISIBLE_MS;
            const esperaRestante = Math.max(0, MIN_VISIBLE_MS - tiempoVisible);
            loadingEl.classList.remove('is-visible');
            loadingGridHideTimeoutId = setTimeout(() => {
                loadingEl.hidden = true;
                loadingGridVisibleSince = 0;
                loadingGridHideTimeoutId = 0;
            }, esperaRestante);
        }
    }

    if (shellEl) {
        shellEl.classList.toggle('is-loading', activo);
        shellEl.setAttribute('aria-busy', activo ? 'true' : 'false');
    }

    if (!gridEl) {
        return;
    }

    if (activo) {
        gridEl.style.opacity = '0.45';
        gridEl.setAttribute('data-loading', 'true');
        gridEl.style.pointerEvents = 'none';
        return;
    }

    gridEl.style.opacity = '1';
    gridEl.removeAttribute('data-loading');
    if (!infiniteScrollState.isLoading) {
        gridEl.style.pointerEvents = 'auto';
    }
}

function esperarSiguienteFrame() {
    return new Promise((resolve) => requestAnimationFrame(resolve));
}

function construirMarkupBotonGrid(numero, soldSet, reservedSet, opciones = {}) {
    const mostrarSoloDisponibles = opciones.mostrarSoloDisponibles === true;
    const estaVendido = soldSet.has(numero);
    const estaApartado = !estaVendido && reservedSet.has(numero);

    if (mostrarSoloDisponibles && (estaVendido || estaApartado)) {
        return '';
    }

    let classes = 'numero-btn';
    let disabled = false;
    let title = '';

    if (estaVendido) {
        classes += ' sold';
        disabled = true;
        title = 'Vendido';
    } else if (estaApartado) {
        classes += ' reserved';
        disabled = true;
        title = 'Apartado';
    }

    if (typeof selectedNumbersGlobal !== 'undefined' && selectedNumbersGlobal.has(numero)) {
        classes += ' selected';
        title = title || 'Seleccionado';
    }

    const numeroFormateado = window.rifaplusConfig?.formatearNumeroBoleto
        ? window.rifaplusConfig.formatearNumeroBoleto(numero)
        : String(numero).padStart(6, '0');

    return `<button class="${classes}" data-numero="${numero}" ${disabled ? 'disabled' : ''} ${title ? `title="${title}"` : ''}>${numeroFormateado}</button>`;
}

function formatearCantidadInventario(valor) {
    const numero = Number(valor);
    return Number.isFinite(numero) && numero >= 0
        ? numero.toLocaleString('es-MX')
        : '0';
}

function obtenerResumenInventarioBoletos() {
    const estado = window.rifaplusConfig?.estado || {};
    const vendidos = Number(estado.boletosVendidos);
    const apartados = Number(estado.boletosApartados);
    const disponibles = Number(estado.boletosDisponibles);
    const totalConfig = Number(window.rifaplusConfig?.rifa?.totalBoletos);
    const valoresValidos = [vendidos, apartados, disponibles].every((valor) => Number.isFinite(valor) && valor >= 0);

    if (!valoresValidos) {
        return {
            vendidos: null,
            apartados: null,
            disponibles: null,
            total: Number.isFinite(totalConfig) && totalConfig > 0 ? totalConfig : null
        };
    }

    return {
        vendidos,
        apartados,
        disponibles,
        total: Number.isFinite(totalConfig) && totalConfig > 0
            ? totalConfig
            : vendidos + apartados + disponibles
    };
}

function construirAvisoInventarioSinDisponibles() {
    const resumen = obtenerResumenInventarioBoletos();
    if (resumen.disponibles !== 0) {
        return '';
    }

    if (resumen.apartados > 0) {
        return `
            <div class="boletos-inventory-notice-card" data-variant="hold">
                <div class="boletos-inventory-notice-icon" aria-hidden="true"><i class="fas fa-hourglass-half"></i></div>
                <div class="boletos-inventory-notice-body">
                    <h4>No hay boletos disponibles por el momento</h4>
                    <p>En este instante todos los boletos están apartados en órdenes en proceso. Si algunas compras no se completan, parte de esa disponibilidad podría liberarse nuevamente en unos minutos.</p>
                    <div class="boletos-inventory-notice-meta">
                        <span class="boletos-inventory-notice-pill">${formatearCantidadInventario(resumen.apartados)} apartados temporalmente</span>
                    </div>
                    <div class="boletos-inventory-notice-actions">
                        <button type="button" class="boletos-inventory-notice-btn" data-action="refresh-availability">
                            <i class="fas fa-rotate-right" aria-hidden="true"></i>
                            <span>Actualizar disponibilidad</span>
                        </button>
                    </div>
                </div>
            </div>
        `;
    }

    return `
        <div class="boletos-inventory-notice-card" data-variant="soldout">
            <div class="boletos-inventory-notice-icon" aria-hidden="true"><i class="fas fa-check-circle"></i></div>
            <div class="boletos-inventory-notice-body">
                <h4>Boletos agotados</h4>
                <p>Todos los boletos de esta rifa ya fueron vendidos. Gracias por tu preferencia y por acompañarnos en esta dinámica.</p>
                <div class="boletos-inventory-notice-meta">
                    <span class="boletos-inventory-notice-pill">${formatearCantidadInventario(resumen.vendidos || resumen.total)} boletos colocados</span>
                </div>
            </div>
        </div>
    `;
}

function actualizarAvisoInventarioBoletos() {
    const notice = document.getElementById('boletosInventoryNotice');
    if (!notice) {
        return;
    }

    const markup = construirAvisoInventarioSinDisponibles();
    if (!markup) {
        notice.innerHTML = '';
        notice.hidden = true;
        return;
    }

    notice.innerHTML = markup;
    notice.hidden = false;
}

function actualizarMensajeGridSinDisponibles() {
    const grid = document.getElementById('numerosGrid');
    if (!grid) {
        return;
    }

    actualizarAvisoInventarioBoletos();

    const mensajeActual = grid.querySelector('[data-grid-empty-disponibles="true"]');
    const resumen = obtenerResumenInventarioBoletos();
    const hayBotonesVisibles = Array.from(grid.querySelectorAll('button[data-numero]')).some((boton) => !boton.classList.contains('filtrado'));
    const debeMostrarMensaje = filtroDisponiblesActivo &&
        !estaVistaBusquedaActiva() &&
        resumen.disponibles !== 0 &&
        !hayBotonesVisibles &&
        !infiniteScrollState.hasMore &&
        !infiniteScrollState.isLoading;

    if (!debeMostrarMensaje) {
        if (mensajeActual) {
            mensajeActual.remove();
        }
        return;
    }

    if (mensajeActual) {
        return;
    }

    grid.innerHTML = `
        <div class="resultados-vacio resultados-vacio--grid" data-grid-empty-disponibles="true">
            No hay boletos disponibles en este rango por ahora.
        </div>
    `;
}

async function verificarBoletosEnServidor(numeros) {
    const endpoint = obtenerApiBaseCompra();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);
    let respuesta;

    try {
        const headers = {
            'Content-Type': 'application/json'
        };
        const currentParams = new URLSearchParams(window.location.search);
        const activeSlug = currentParams.get('rifa') || currentParams.get('slug') || window.rifaplusConfig?.rifa?.slug;
        if (activeSlug) {
            headers['x-rifaplus-rifa-slug'] = activeSlug;
        }

        respuesta = await fetch(`${endpoint}/api/boletos/verificar`, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({ numeros }),
            signal: controller.signal
        });
    } catch (error) {
        if (error?.name === 'AbortError') {
            throw new Error('La validacion del boleto tardo demasiado');
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }

    if (!respuesta.ok) {
        throw new Error(`No se pudo verificar disponibilidad (${respuesta.status})`);
    }

    const json = await respuesta.json();
    if (!json?.success) {
        throw new Error(json?.message || 'No se pudo verificar disponibilidad');
    }

    return json;
}

async function verificarEstadoBoletoEnServidor(numero) {
    const resultado = await verificarBoletosEnServidor([numero]);
    const conflictos = Array.isArray(resultado.conflictos) ? resultado.conflictos : [];
    const conflicto = conflictos.find(item => Number(item?.numero) === Number(numero));

    if (conflicto) {
        return {
            vendido: conflicto.estado === 'vendido',
            apartado: conflicto.estado === 'apartado'
        };
    }

    return {
        vendido: false,
        apartado: false
    };
}

function sincronizarSeleccionCompraEnStorage() {
    try {
        const numeros = Array.from(selectedNumbersGlobal || []).map((n) => parseInt(n, 10));
        if (typeof window.safeTrySetItem === 'function') {
            window.safeTrySetItem('rifaplusSelectedNumbers', JSON.stringify(numeros));
        } else {
            localStorage.setItem('rifaplusSelectedNumbers', JSON.stringify(numeros));
        }
    } catch (error) {
        console.warn('No se pudo sincronizar la seleccion local:', error?.message || error);
    }
}

function programarActualizacionSeleccionCompra() {
    if (typeof invalidarCacheCarrito === 'function') {
        invalidarCacheCarrito();
    }

    if (typeof actualizarCarritoConDebounceAgresivo === 'function') {
        actualizarCarritoConDebounceAgresivo();
        return;
    }

    if (typeof actualizarResumenCompraConDebounce === 'function') {
        actualizarResumenCompraConDebounce();
    }
    if (window.actualizarVistaCarritoGlobal) {
        window.actualizarVistaCarritoGlobal();
    }
    if (window.actualizarContadorCarritoGlobal) {
        window.actualizarContadorCarritoGlobal();
    }
}

function registrarValidacionSeleccionPendiente(numero) {
    const token = ++secuenciaValidacionSeleccion;
    validacionesSeleccionPendientes.set(Number(numero), token);
    actualizarEstadoBtnComprar();
    return token;
}

function esValidacionSeleccionPendiente(numero, token) {
    return validacionesSeleccionPendientes.get(Number(numero)) === token;
}

function limpiarValidacionSeleccionPendiente(numero, token = null) {
    const numeroNormalizado = Number(numero);
    if (token === null || validacionesSeleccionPendientes.get(numeroNormalizado) === token) {
        validacionesSeleccionPendientes.delete(numeroNormalizado);
        actualizarEstadoBtnComprar();
    }
}

function cancelarValidacionSeleccionPendienteCompra(numero) {
    limpiarValidacionSeleccionPendiente(numero);
}

window.cancelarValidacionSeleccionPendienteCompra = cancelarValidacionSeleccionPendienteCompra;

function solicitarRefrescoEstadoBoletosActual(opciones = {}) {
    const {
        delayMs = 90,
        motivo = 'sincronizacion',
        fullRefresh = true
    } = opciones;

    if (refrescoEstadoBoletosTimeoutId) {
        clearTimeout(refrescoEstadoBoletosTimeoutId);
    }

    refrescoEstadoBoletosUltimoMotivo = motivo;
    refrescoEstadoBoletosTimeoutId = setTimeout(() => {
        refrescoEstadoBoletosTimeoutId = 0;

        if (fullRefresh && typeof cargarBoletosPublicos === 'function') {
            cargarBoletosPublicos().catch((error) => {
                console.warn(`No se pudo refrescar el estado de boletos (${refrescoEstadoBoletosUltimoMotivo}):`, error?.message || error);
            });
            return;
        }

        const rangoActual = infiniteScrollState.rangoActual || obtenerRangoVisibleInicial();
        const endpoint = obtenerApiBaseCompra();
        cargarDatosCompletosEnBackground(endpoint, rangoActual, {
            force: true,
            reason: refrescoEstadoBoletosUltimoMotivo
        }).catch((error) => {
            console.warn(`No se pudo refrescar el rango visible (${refrescoEstadoBoletosUltimoMotivo}):`, error?.message || error);
        });
    }, Math.max(0, Number(delayMs) || 0));
}

window.solicitarRefrescoEstadoBoletosActual = solicitarRefrescoEstadoBoletosActual;

function marcarNumeroComoSeleccionadoEnBusqueda(numero) {
    const resultadoItem = document.querySelector(`.resultado-item:has([data-numero="${numero}"])`);
    if (resultadoItem) {
        const statusSpan = resultadoItem.querySelector('strong');
        if (statusSpan) {
            statusSpan.textContent = '✔️ Ya seleccionado';
            statusSpan.style.color = 'var(--primary)';
        }

        const btnLoQuiero = resultadoItem.querySelector('.btn-lo-quiero');
        if (btnLoQuiero) {
            btnLoQuiero.style.display = 'none';
        }
    }

    document.querySelectorAll(`.busqueda-grid-btn[data-numero="${numero}"]`).forEach((btnResultado) => {
        btnResultado.classList.remove('sold', 'reserved');
        btnResultado.classList.add('selected');
        btnResultado.disabled = false;
        btnResultado.title = 'Ya seleccionado';
    });
}

function restaurarNumeroDisponibleEnBusqueda(numero) {
    const resultadoItem = document.querySelector(`.resultado-item:has([data-numero="${numero}"])`);
    if (resultadoItem) {
        const statusSpan = resultadoItem.querySelector('strong');
        if (statusSpan) {
            statusSpan.textContent = '✅ Disponible';
            statusSpan.style.color = 'var(--success)';
        }

        const btnLoQuiero = resultadoItem.querySelector('.btn-lo-quiero');
        if (btnLoQuiero) {
            btnLoQuiero.style.display = '';
        }
    }

    document.querySelectorAll(`.busqueda-grid-btn[data-numero="${numero}"]`).forEach((btnResultado) => {
        btnResultado.classList.remove('sold', 'reserved', 'selected');
        btnResultado.disabled = false;
        btnResultado.title = 'Disponible';
    });
}

function marcarConflictoLocalBoleto(numero, estadoServidor) {
    const numeroNormalizado = Number(numero);
    const sold = Array.isArray(window.rifaplusSoldNumbers) ? window.rifaplusSoldNumbers : [];
    const reserved = Array.isArray(window.rifaplusReservedNumbers) ? window.rifaplusReservedNumbers : [];

    window.rifaplusSoldNumbers = sold.filter((item) => Number(item) !== numeroNormalizado);
    window.rifaplusReservedNumbers = reserved.filter((item) => Number(item) !== numeroNormalizado);

    if (estadoServidor?.vendido) {
        window.rifaplusSoldNumbers.push(numeroNormalizado);
    } else if (estadoServidor?.apartado) {
        window.rifaplusReservedNumbers.push(numeroNormalizado);
    }
}

function aplicarEstadoNoDisponibleEnBusqueda(numero, estadoServidor) {
    const tituloEstado = estadoServidor?.vendido ? 'Vendido' : 'Apartado';
    const textoEstado = estadoServidor?.vendido ? '❌ Vendido' : '⏳ Apartado';
    const colorEstado = estadoServidor?.vendido ? 'var(--danger)' : 'var(--warning)';
    const claseEstado = estadoServidor?.vendido ? 'sold' : 'reserved';

    const resultadoItem = document.querySelector(`.resultado-item:has([data-numero="${numero}"])`);
    if (resultadoItem) {
        const statusSpan = resultadoItem.querySelector('strong');
        if (statusSpan) {
            statusSpan.textContent = textoEstado;
            statusSpan.style.color = colorEstado;
        }

        const btnLoQuiero = resultadoItem.querySelector('.btn-lo-quiero');
        if (btnLoQuiero) {
            btnLoQuiero.style.display = 'none';
        }

        resultadoItem.setAttribute('data-estado', tituloEstado.toLowerCase());
    }

    document.querySelectorAll(`.busqueda-grid-btn[data-numero="${numero}"]`).forEach((btnResultado) => {
        btnResultado.classList.remove('selected');
        btnResultado.classList.add(claseEstado);
        btnResultado.disabled = false;
        btnResultado.title = tituloEstado;
    });
}

function marcarBoletoComoSeleccionadoEnGrid(numero, opciones = {}) {
    const { enfatizar = true } = opciones;
    const botonEnGrid = obtenerBotonNumeroEnGrid(numero);

    if (!botonEnGrid) {
        return null;
    }

    botonEnGrid.classList.remove('sold', 'reserved');
    botonEnGrid.classList.add('selected');

    if (enfatizar) {
        enfatizarNumeroSeleccionado(botonEnGrid);
    }

    return botonEnGrid;
}

function obtenerBotonNumeroEnGrid(numero) {
    const numerosGrid = document.getElementById('numerosGrid');
    if (!numerosGrid) {
        return null;
    }

    return numerosGrid.querySelector(`button[data-numero="${numero}"]`);
}

function obtenerTamanoChunkActualizacionGrid() {
    const memoria = Number(navigator.deviceMemory || 0);
    const esMovil = window.matchMedia && window.matchMedia('(max-width: 768px)').matches;

    if (esMovil && memoria > 0 && memoria <= 4) {
        return 70;
    }

    if (esMovil) {
        return 110;
    }

    if (memoria > 0 && memoria <= 4) {
        return 120;
    }

    return 180;
}

function aplicarEstadoVisualABoton(boton, soldSet, reservedSet) {
    if (!boton || boton.nodeType !== 1) {
        return;
    }

    const numero = parseInt(boton.getAttribute('data-numero'), 10);
    if (!Number.isInteger(numero)) {
        return;
    }

    const estabaVendido = boton.classList.contains('sold');
    const estabaApartado = boton.classList.contains('reserved');
    const estaVendido = soldSet.has(numero);
    const estaApartado = !estaVendido && reservedSet.has(numero);
    const estaPendiente = boton.classList.contains('is-pending') || boton.classList.contains('is-processing');

    if (estabaVendido !== estaVendido) {
        boton.classList.toggle('sold', estaVendido);
    }

    if (estabaApartado !== estaApartado) {
        boton.classList.toggle('reserved', estaApartado);
    }

    const debeDeshabilitarse = estaVendido || estaApartado || estaPendiente;
    if (boton.disabled !== debeDeshabilitarse) {
        boton.disabled = debeDeshabilitarse;
    }

    const tituloObjetivo = estaVendido
        ? 'Vendido'
        : estaApartado
            ? 'Apartado'
            : boton.classList.contains('selected')
                ? 'Seleccionado'
                : '';

    if ((boton.getAttribute('title') || '') !== tituloObjetivo) {
        if (tituloObjetivo) {
            boton.setAttribute('title', tituloObjetivo);
        } else {
            boton.removeAttribute('title');
        }
    }
}

function limpiarEstadoInteractivoBoleto(boton) {
    if (!boton || boton.nodeType !== 1) {
        return;
    }

    boton.classList.remove('selected', 'is-pending', 'is-processing');
    boton.disabled = false;
    boton.style.transform = 'scale(1)';
}

function removerSeleccionLocal(numero) {
    const numeroNormalizado = Number(numero);
    if (!selectedNumbersGlobal.has(numeroNormalizado)) {
        return false;
    }

    selectedNumbersGlobal.delete(numeroNormalizado);
    sincronizarSeleccionCompraEnStorage();
    programarActualizacionSeleccionCompra();
    return true;
}

function agregarSeleccionLocal(numero) {
    const numeroNormalizado = Number(numero);
    if (selectedNumbersGlobal.has(numeroNormalizado)) {
        return false;
    }

    selectedNumbersGlobal.add(numeroNormalizado);
    sincronizarSeleccionCompraEnStorage();
    programarActualizacionSeleccionCompra();
    return true;
}

async function validarSeleccionOptimista(numero, boton, token) {
    try {
        const estadoServidor = await verificarEstadoBoletoEnServidor(numero);

        if (!esValidacionSeleccionPendiente(numero, token)) {
            return;
        }

        if (!selectedNumbersGlobal.has(numero)) {
            limpiarValidacionSeleccionPendiente(numero, token);
            limpiarEstadoInteractivoBoleto(boton);
            return;
        }

        if (estadoServidor.vendido || estadoServidor.apartado) {
            limpiarValidacionSeleccionPendiente(numero, token);
            removerSeleccionLocal(numero);
            marcarConflictoLocalBoleto(numero, estadoServidor);
            aplicarEstadoNoDisponibleEnBusqueda(numero, estadoServidor);

            const botonGrid = (boton && boton.isConnected ? boton : obtenerBotonNumeroEnGrid(numero));
            if (botonGrid) {
                limpiarEstadoInteractivoBoleto(botonGrid);
                botonGrid.classList.add(estadoServidor.vendido ? 'sold' : 'reserved');
                botonGrid.setAttribute('title', estadoServidor.vendido ? 'Vendido' : 'Apartado');
                botonGrid.disabled = true;
            }

            rifaplusUtils.showFeedback(
                estadoServidor.vendido
                    ? `❌ Boleto #${numero} ya se vendio en otro momento`
                    : `⏳ Boleto #${numero} acaba de quedar apartado`,
                estadoServidor.vendido ? 'error' : 'warning'
            );
            return;
        }

        limpiarValidacionSeleccionPendiente(numero, token);

        if (boton && boton.isConnected) {
            boton.classList.remove('is-pending', 'is-processing');
            boton.disabled = false;
            boton.setAttribute('title', 'Seleccionado');
        }

        animarAgregarAlCarrito(null, numero, false);
    } catch (error) {
        if (!esValidacionSeleccionPendiente(numero, token)) {
            return;
        }

        limpiarValidacionSeleccionPendiente(numero, token);

        if (!selectedNumbersGlobal.has(numero)) {
            limpiarEstadoInteractivoBoleto(boton);
            return;
        }

        removerSeleccionLocal(numero);
        restaurarNumeroDisponibleEnBusqueda(numero);
        limpiarEstadoInteractivoBoleto(boton);

        rifaplusUtils.showFeedback('⚠️ No se pudo validar el boleto en este momento. Intenta de nuevo.', 'warning');
    }
}

async function generarNumerosVerificadosEnServidor(cantidad) {
    const endpoint = obtenerApiBaseCompra();
    const seleccionadosActuales = Array.from(selectedNumbersGlobal || []);
    const excludeNumbers = Array.from(new Set(seleccionadosActuales));

    const headers = {
        'Content-Type': 'application/json'
    };
    const currentParams = new URLSearchParams(window.location.search);
    const activeSlug = currentParams.get('rifa') || currentParams.get('slug') || window.rifaplusConfig?.rifa?.slug;
    if (activeSlug) {
        headers['x-rifaplus-rifa-slug'] = activeSlug;
    }

    const respuesta = await fetch(`${endpoint}/api/boletos/disponibles-aleatorios`, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({
            cantidad,
            excludeNumbers
        })
    });

    if (!respuesta.ok) {
        let mensajeError = `No se pudieron generar boletos aleatorios (${respuesta.status})`;

        try {
            const errorJson = await respuesta.json();
            if (errorJson?.message) {
                mensajeError = errorJson.message;
            }
        } catch (error) {
            // Ignorar parseo fallido y usar mensaje por defecto
        }

        throw new Error(mensajeError);
    }

    const json = await respuesta.json();
    if (!json?.success) {
        throw new Error(json?.message || 'No se pudieron generar boletos aleatorios');
    }

    const boletos = Array.isArray(json.boletos) ? json.boletos : [];
    return boletos
        .map((numero) => Number(numero))
        .filter((numero) => Number.isInteger(numero) && !excludeNumbers.includes(numero));
}

async function cargarEstadoRangoVisibleEnBackground(endpoint, inicio, fin, opciones = {}) {
    const { force = false, reason = 'normal' } = opciones;
    const rangoInicio = parseInt(inicio, 10);
    const rangoFin = parseInt(fin, 10);
    const claveRango = obtenerClaveEstadoRango(endpoint, rangoInicio, rangoFin);

    if (!Number.isInteger(rangoInicio) || !Number.isInteger(rangoFin)) {
        return false;
    }

    if (
        !force &&
        rifaplusEstadoRangoActual.cargado &&
        rifaplusEstadoRangoActual.inicio === rangoInicio &&
        rifaplusEstadoRangoActual.fin === rangoFin &&
        rifaplusEstadoRangoActual.endpoint === endpoint
    ) {
        return true;
    }

    if (rifaplusEstadoRangoActual.pendingPromise && rifaplusEstadoRangoActual.pendingKey === claveRango) {
        logCompraDebug(`[compra] Reutilizando carga en curso para rango ${rangoInicio}-${rangoFin} (${reason})`);
        return rifaplusEstadoRangoActual.pendingPromise;
    }

    const requestId = ++rifaplusEstadoRangoActual.requestId;
    rifaplusEstadoRangoActual.inicio = rangoInicio;
    rifaplusEstadoRangoActual.fin = rangoFin;
    rifaplusEstadoRangoActual.endpoint = endpoint;
    rifaplusEstadoRangoActual.cargado = false;
    rifaplusEstadoRangoActual.pendingKey = claveRango;

    const pendingPromise = (async () => {
        try {
            logCompraDebug(`[compra] Refrescando rango ${rangoInicio}-${rangoFin} (${reason})`);

            const fetchUrl = new URL(`${endpoint}/api/public/boletos`);
            fetchUrl.searchParams.set('inicio', rangoInicio);
            fetchUrl.searchParams.set('fin', rangoFin);
            
            const currentParams = new URLSearchParams(window.location.search);
            const activeSlug = currentParams.get('rifa') || currentParams.get('slug') || window.rifaplusConfig?.rifa?.slug;
            if (activeSlug) {
                fetchUrl.searchParams.set('rifa', activeSlug);
            }

            const respuesta = await fetch(fetchUrl.toString(), {
                cache: 'no-store',
                priority: 'low'
            });

            if (!respuesta.ok) {
                throw new Error(`Rango ${rangoInicio}-${rangoFin}: ${respuesta.status}`);
            }

            const json = await respuesta.json();
            const sold = Array.isArray(json?.data?.sold) ? json.data.sold : [];
            const reserved = Array.isArray(json?.data?.reserved) ? json.data.reserved : [];

            if (requestId !== rifaplusEstadoRangoActual.requestId) {
                return rifaplusEstadoRangoActual.cargado &&
                    rifaplusEstadoRangoActual.inicio === rangoInicio &&
                    rifaplusEstadoRangoActual.fin === rangoFin &&
                    rifaplusEstadoRangoActual.endpoint === endpoint;
            }

            procesarBoletosEnBackground(sold, reserved);
            rifaplusEstadoRangoActual.cargado = true;
            return true;
        } catch (error) {
            console.warn(`⚠️ Error cargando rango ${rangoInicio}-${rangoFin} (${reason}):`, error.message);

            if (requestId !== rifaplusEstadoRangoActual.requestId) {
                return rifaplusEstadoRangoActual.cargado &&
                    rifaplusEstadoRangoActual.inicio === rangoInicio &&
                    rifaplusEstadoRangoActual.fin === rangoFin &&
                    rifaplusEstadoRangoActual.endpoint === endpoint;
            }

            // Evitar bajar la lista completa cuando falla un rango individual.
            // Dejamos que el backoff normal reprograme la carga y preservamos la UX
            // con stats/resumen mientras el endpoint vuelve a responder.
            rifaplusEstadoRangoActual.cargado = false;
            return false;
        } finally {
            if (rifaplusEstadoRangoActual.pendingPromise === pendingPromise) {
                rifaplusEstadoRangoActual.pendingPromise = null;
                rifaplusEstadoRangoActual.pendingKey = '';
            }
        }
    })();

    rifaplusEstadoRangoActual.pendingPromise = pendingPromise;
    return pendingPromise;
}

// Fallback defensivo para utilidades (evitar crash si main.js no se cargó correctamente)
if (!window.rifaplusUtils) {
    window.rifaplusUtils = {
        /**
         * Mostrar feedback visual al usuario
         * @param {string} mensaje - Mensaje a mostrar
         * @param {string} tipo - Tipo de feedback (info, success, warning, error)
         */
        showFeedback: function(mensaje, tipo = 'info') {
            logCompraDebug('[rifaplusUtils.showFeedback]', tipo, mensaje);
        },
        /**
         * Calcula el total con descuentos sincronizados
         * @param {number} cantidad - Cantidad de boletos
         * @param {number} precioUnitario - Precio por unidad (opcional)
         * @returns {Object} Datos de cálculo (subtotal, descuento, total)
         */
        calcularDescuento: function(cantidad, precioUnitario = null) {
            return calcularTotalConPromociones(cantidad, precioUnitario);
        },
        /**
         * Alias para mostrarFeedback (compatibilidad)
         */
        mostrarFeedback: function(mensaje, tipo = 'info') {
            return this.showFeedback(mensaje, tipo);
        }
    };
}

/* ============================================================ */
/* SECCIÓN 2: SINCRONIZACIÓN DE PESTAÑA Y EVENTOS GLOBALES       */
/* ============================================================ */

// Flag para evitar múltiples calls cuando usuario vuelve a pestaña
var visibilityCheckExecuting = false;

/**
 * Detectar cuando el usuario vuelve a la pestaña
 * Refrescar boletos disponibles para mantener estado sincronizado
 * OPTIMIZACIÓN: Usar flag para evitar solapamientos de calls
 */
document.addEventListener('visibilitychange', function() {
    if (!document.hidden && typeof cargarBoletosPublicos === 'function' && !visibilityCheckExecuting) {
        visibilityCheckExecuting = true;
        cargarBoletosPublicos().catch(e => console.warn('Error al refrescar boletos:', e)).finally(() => {
            visibilityCheckExecuting = false;
        });
    }
});

/**
 * Cleanup: Limpiar timers y listeners cuando se abandona la página
 * Previene memory leaks y API calls innecesarias
 */
window.addEventListener('pagehide', function() {
    if (window.rifaplusFetchTimeoutId) {
        clearTimeout(window.rifaplusFetchTimeoutId);
        window.rifaplusFetchTimeoutId = null;
    }
}, true);

/**
 * Inicialización cuando DOM está listo
 */
document.addEventListener('DOMContentLoaded', function() {
    inicializarSistemaCompra();
    // Carrito será inicializado por carrito-global.js
    
    // Actualizar resumen poco después de cargar la página
    setTimeout(actualizarResumenCompra, 100);
    
    // ✅ LISTENER: Si la configuración se sincroniza desde el backend, reinicializar rangos
    window.addEventListener('configuracionActualizada', function() {
        inicializarRangoDefault();
    });
});


/* ============================================================ */
/* SECCIÓN 3: INICIALIZACIÓN DEL SISTEMA DE COMPRA                */
/* ============================================================ */

// OPTIMIZACIÓN: Debounce para actualizarResumenCompra (evita renders excesivos)
var resumenDebounceTimer = null;
function actualizarResumenCompraConDebounce() {
    // Cancelar el timer anterior si existe
    if (resumenDebounceTimer) clearTimeout(resumenDebounceTimer);
    // Programar actualización con pequeño delay (agrupa múltiples cambios rápidos)
    resumenDebounceTimer = setTimeout(actualizarResumenCompra, 50);
}

/**
 * Inicializar sistema completo de compra
 * Carga boletos, configura grid, máquina de suerte
 */
async function inicializarSistemaCompra() {
    
    // ⚠️ Inicializar flag de sincronización
    window.rifaplusBoletosDatosActualizados = false; // Empezar como FALSE para no permitir generación hasta que esté REALMENTE listo
    
    const grilla = document.getElementById('numerosGrid');
    if (!grilla) {
        console.error('❌ ERROR CRÍTICO: No se encontró el elemento numerosGrid');
        return;
    }
    
    // Sincronizar selectedNumbersGlobal con localStorage al cargar la página
    const guardado = localStorage.getItem('rifaplusSelectedNumbers');
    if (guardado) {
        try {
            const arrayGuardado = JSON.parse(guardado);
            selectedNumbersGlobal.clear();
            arrayGuardado
                .map(num => parseInt(num, 10))
                .filter(num => !Number.isNaN(num))
                .forEach(num => selectedNumbersGlobal.add(num));
            // Actualizar el contador inmediatamente después de sincronizar
            if (window.actualizarContadorCarritoGlobal) {
                window.actualizarContadorCarritoGlobal();
            }
        } catch (error) {
            console.error('Error al sincronizar boletos desde localStorage:', error);
        }
    }
    
    // ⭐ IMPORTANTE: Restaurar estado del filtro desde localStorage
    // Nuevo comportamiento:
    // - Por defecto: solo disponibles (filtro activo)
    // - Toggle activo: mostrar todos (filtro inactivo)
    const mostrarTodosGuardado = localStorage.getItem('rifaplusMostrarTodosBoletos');
    const filtroGuardadoLegacy = localStorage.getItem('rifaplusFiltroDisponibles');
    if (mostrarTodosGuardado !== null || filtroGuardadoLegacy !== null) {
        try {
            if (mostrarTodosGuardado !== null) {
                const mostrarTodos = JSON.parse(mostrarTodosGuardado) === true;
                filtroDisponiblesActivo = !mostrarTodos;
            } else {
                // Compatibilidad con estado guardado anterior.
                filtroDisponiblesActivo = JSON.parse(filtroGuardadoLegacy) === true;
            }
            // Sincronizar checkbox con estado guardado (checked = mostrar todos)
            const checkboxFiltro = document.getElementById('filtroDisponibles');
            if (checkboxFiltro) {
                checkboxFiltro.checked = !filtroDisponiblesActivo;
            }
        } catch (error) {
            console.error('Error al restaurar estado del filtro:', error);
        }
    }
    
    if (!inicializarRangoDefault()) {
        solicitarInicializacionRangoCuandoConfigEsteLista();
    }
    configurarEventListeners();
    
    // ⚡ OPTIMIZACIÓN: NO esperar cargarBoletosPublicos() completo
    // Stage 1 (/stats) es ultra-rápido (< 50ms) y actualiza availability-note instantáneamente
    // Stage 2 (/api/public/boletos) es lento y se ejecuta en background sin bloquear
    // Solo la carga INICIAL necesita esperar un poco para los datos, luego lo demás sigue en background
    startCargarBoletosPublicosConIntentos();
    
    // Inicializar la máquina de suerte (no necesita esperar todo)
    inicializarMaquinaSuerteMejorada();
    
    // La función `cargarBoletosPublicos` se encarga ahora de programar su siguiente ejecución
    // usando setTimeout + backoff para evitar solapamientos que causan 429.
}

/* ============================================================ */
/* SECCIÓN 3.4: INICIO NO-BLOQUEANTE DE CARGA DE BOLETOS         */
/* ============================================================ */

/**
 * Inicia cargarBoletosPublicos() SIN esperar
 * Stage 1 (/stats) se ejecuta en paralelo y actualiza availability-note instantáneamente
 * Stage 2 (background) continúa sin bloquear
 */
function startCargarBoletosPublicosConIntentos() {
    try {
        logCompraDebug('[compra] Iniciando carga de boletos');
        cargarBoletosPublicos().catch(e => {
            console.warn('❌ Error crítico en carga inicial de boletos:', e.message);
        });
    } catch (err) {
        console.error('❌ Error en startCargarBoletosPublicosConIntentos:', err);
    }
    
    // 🗑️  Removido: cargarOportunidadesDisponiblesDelBackend() - sistema antiguo reemplazado
    // Ahora se usa asignación pre-determinada en backend según el multiplicador configurado
}

window.addEventListener('boletosListos', function() {
    if (typeof actualizarEstadoBotonGenerar === 'function') {
        actualizarEstadoBotonGenerar();
    }
    if (typeof actualizarNotaDisponibilidad === 'function') {
        actualizarNotaDisponibilidad();
    }
});

/* ============================================================ */
/* SECCIÓN 3.5: ACTUALIZACIÓN PERIÓDICA - DETECTAR ÓRDENES CANCELADAS */
/* ============================================================ */

/**
 * Inicia timer para actualizar boletos cada 15 segundos
 * Detecta cuándo órdenes han sido canceladas por expiración
 * y libera los boletos en el grid
 * 
 * OPTIMIZACIÓN: Solo recarga /boletos si /stats muestra cambio de disponibles
 */



/* ============================================================ */
/* SECCIÓN 4: CARGA DE BOLETOS DESDE API PÚBLICA                 */
/* ============================================================ */

/**
 * Fetch de boletos vendidos/apartados desde backend público
 * OPTIMIZADO: 2-STAGE LOADING
 * Stage 1: Ultra-rápido /api/public/boletos/stats (< 50ms) - muestra conteo
 * Stage 2: Background /api/public/boletos - carga grid sin bloquear
 * 
 * Sincroniza disponibilidad en tiempo real
 */
/**
 * Wrapper para /stats con caché local agresivo
 * Reduce llamadas innecesarias al backend
 */


/**
 * Fetch de boletos vendidos/apartados desde backend público
 * OPTIMIZADO: 2-STAGE LOADING
 * Stage 1: Ultra-rápido /api/public/boletos/stats (< 50ms) - muestra conteo
 * Stage 2: Background /api/public/boletos - carga grid sin bloquear
 * 
 * Sincroniza disponibilidad en tiempo real
 */
async function cargarBoletosPublicos() {
    try {
        const endpoint = obtenerApiBaseCompra();
        
        // ⚡ STAGE 1: Timing para medir velocidad
        const stageStartTime = performance.now();
        
        // ⚠️ MARCAR DATOS COMO OBSOLETOS al iniciar la carga
        // Esto previene que calcularYLlenarOportunidades use datos viejos
        window.rifaplusBoletosDatosActualizados = false;
        
        try {
            const statsUrl = new URL(`${endpoint}/api/public/boletos/stats`);
            const currentParams = new URLSearchParams(window.location.search);
            const activeSlug = currentParams.get('rifa') || currentParams.get('slug') || window.rifaplusConfig?.rifa?.slug;
            if (activeSlug) {
                statsUrl.searchParams.set('rifa', activeSlug);
            }
            
            const statsResponse = await fetch(statsUrl.toString(), {
                cache: 'no-store'
            });
            
            const stageElapsed = Math.round(performance.now() - stageStartTime);
            
            if (statsResponse.ok) {
                const statsJson = await statsResponse.json();
                const data = statsJson.data || statsJson;
                logCompraDebug(`[compra] /stats respondio en ${stageElapsed}ms`);
                
                if (data) {
                    // Actualizar estado global primero para que el botón use datos frescos
                    if (window.rifaplusConfig && window.rifaplusConfig.estado) {
                        window.rifaplusConfig.estado.boletosVendidos = data.vendidos;
                        window.rifaplusConfig.estado.boletosApartados = data.apartados;
                        window.rifaplusConfig.estado.boletosDisponibles = data.disponibles;
                    }

                    // ⭐ OPTIMIZACIÓN CRÍTICA: Mostrar disponibilidad INMEDIATAMENTE desde /stats (< 50ms)
                    // No esperar por cálculo de rango - eso se hace en background en Stage 2
                    actualizarNotaDisponibilidad();
                    
                    if (typeof actualizarEstadoBotonGenerar === 'function') {
                        actualizarEstadoBotonGenerar();
                    }
                    actualizarAvisoInventarioBoletos();
                }
            }
        } catch (error) {
            console.error('❌ Error cargando stats (mostrar en UI):', error.message, error.stack);
            // Mostrar error al usuario
            aplicarEstadoNotaDisponibilidad('❌ Error cargando disponibilidad: ' + (error.message || 'desconocido'), 'error', {
                color: 'red'
            });
            
            // ⚠️ IMPORTANTE: Marcar como cargado INCLUSO con error
            // Sino, se queda bloqueado esperando forever
            window.rifaplusBoletosLoaded = true;
        }
        
        // 🔄 STAGE 2: BACKGROUND - Cargar datos completos SIN BLOQUEAR
        // Si es la primera carga, mostrar loading con la rutina unificada.
        if (!window.rifaplusBoletosLoaded) {
            mostrarEstadoCargaGrid(true);
            
            // ⭐ BLOQUEAR AGREGAR AL CARRITO DURANTE LA CARGA
            window.rifaplusBoletosLoading = true;
            if (typeof controlarEstadoBotonesLoQuiero === 'function') {
                controlarEstadoBotonesLoQuiero();
            }
        }
        
        // Cargar solo el rango visible en background
        const rangoInicial = infiniteScrollState.rangoActual || obtenerRangoVisibleInicial();
        cargarDatosCompletosEnBackground(endpoint, rangoInicial, {
            force: true,
            reason: 'carga-publica'
        });
        
        return true;
        
    } catch (error) {
        console.error('❌ Error en cargarBoletosPublicos:', error);
        window.rifaplusBoletosLoaded = true; // Marcar cargado incluso si falla
        return false;
    }
}

/**
 * Helper: Carga datos completos en background sin bloquear UI
 * Esta función se ejecuta de forma asincrónica, puede tomar tiempo
 */
async function cargarDatosCompletosEnBackground(endpoint, rango = null, opciones = {}) {
    try {
        const rangoObjetivo = rango || infiniteScrollState.rangoActual || obtenerRangoVisibleInicial();
        const { force = false, reason = 'background' } = opciones;
        logCompraDebug(`[compra] Cargando rango en background ${rangoObjetivo.inicio}-${rangoObjetivo.fin} (${reason})`);

        const exito = await cargarEstadoRangoVisibleEnBackground(
            endpoint,
            rangoObjetivo.inicio,
            rangoObjetivo.fin,
            { force, reason }
        );

        if (exito) {
            // Indicar que los datos de disponibilidad ya se cargaron
            window.rifaplusBoletosLoaded = true;
            window.rifaplusBoletosLoading = false;  // ⭐ DESBLOQUEAR CARRITO
            // reset backoff to default
            window.rifaplusFetchBackoffMs = 10000;
            
            // ⭐ DESBLOQUEAR BOTONES "Lo quiero"
            if (typeof controlarEstadoBotonesLoQuiero === 'function') {
                controlarEstadoBotonesLoQuiero();
            }
            
            // ⭐ OCULTAR LOADING INDICATOR con la misma rutina usada por el grid
            mostrarEstadoCargaGrid(false);

            const { sold, reserved } = obtenerEstadoLocalBoletos();
            logCompraDebug(`[compra] Estado de rango cargado: ${sold.length} vendidos, ${reserved.length} apartados`);

            // ⭐ OPTIMIZACIÓN: En lugar de re-renderizar TODO el grid (que reinicia scroll),
            // solo actualizar los botones visibles con su nuevo estado
            actualizarEstadoBoletosVisibles();
            if (typeof actualizarEstadoBotonGenerar === 'function') {
                actualizarEstadoBotonGenerar();
            }
            if (typeof actualizarNotaDisponibilidad === 'function') {
                actualizarNotaDisponibilidad();
            }
            actualizarAvisoInventarioBoletos();
            
            // 🔌 WEBSOCKET ACTIVO: El polling manual ya no es necesario
            // Socket.io emitirá boletosActualizados en tiempo real desde el servidor
            // Cuando haya cambios, ejecutaremos actualizarEstadoBoletosVisibles() automáticamente
            // Si WebSocket falla o se desconecta, socket-handler.js activa fallback a polling
            // DEV NOTE: Mantener este línea comentada para debugging/fallback manual en desarrollo
            // window.rifaplusFetchTimeoutId = setTimeout(cargarBoletosPublicos, 300000); // 5 minutos (DESHABILITADO - WebSocket maneja actualizaciones)
            return true;
        }
        // If data not in expected shape, treat as fail and try later
        if (!Number.isFinite(obtenerDisponiblesGlobalesMaquina())) {
            window.rifaplusBoletosLoaded = false;
        }
        window.rifaplusBoletosLoading = false;
        window.rifaplusFetchBackoffMs = Math.min((window.rifaplusFetchBackoffMs || 30000) * 2, 300000);
        if (window.rifaplusFetchTimeoutId) clearTimeout(window.rifaplusFetchTimeoutId);
        window.rifaplusFetchTimeoutId = setTimeout(cargarBoletosPublicos, window.rifaplusFetchBackoffMs);
        if (typeof actualizarEstadoBotonGenerar === 'function') actualizarEstadoBotonGenerar();
        // ⭐ OPTIMIZACIÓN: No actualizar availabilityNote aquí - el Web Worker lo hace
        return false;
    } catch (e) {
        // Network or unexpected error — increase backoff and retry later
        console.warn('cargarBoletosPublicos error', e && e.message ? e.message : e);
        if (!Number.isFinite(obtenerDisponiblesGlobalesMaquina())) {
            window.rifaplusBoletosLoaded = false;
        }
        window.rifaplusBoletosLoading = false;
        window.rifaplusFetchBackoffMs = Math.min((window.rifaplusFetchBackoffMs || 30000) * 2, 300000);
        if (window.rifaplusFetchTimeoutId) clearTimeout(window.rifaplusFetchTimeoutId);
        window.rifaplusFetchTimeoutId = setTimeout(cargarBoletosPublicos, window.rifaplusFetchBackoffMs);
        if (typeof actualizarEstadoBotonGenerar === 'function') actualizarEstadoBotonGenerar();
        // ⭐ OPTIMIZACIÓN: No actualizar availabilityNote aquí - el Web Worker lo hace
        return false;
    }
}

/**
 * ⭐ OPTIMIZACIÓN: Actualizar SOLO los boletos visibles sin limpiar el grid
 * Esto evita que se reinicie el scroll cuando se actualiza el estado de boletos
 * OPTIMIZADO: IntersectionObserver con fallback para Safari (no tiene requestIdleCallback)
 */
function actualizarEstadoBoletosVisibles() {
    const grid = document.getElementById('numerosGrid');
    if (!grid) {
        return;
    }

    if (observerEstadoBoletosVisibles) {
        observerEstadoBoletosVisibles.disconnect();
        observerEstadoBoletosVisibles = null;
    }

    if (actualizacionEstadoGridFrameId) {
        cancelAnimationFrame(actualizacionEstadoGridFrameId);
        actualizacionEstadoGridFrameId = 0;
    }

    const { soldSet, reservedSet } = obtenerEstadoLocalBoletos();
    const botones = Array.from(grid.querySelectorAll('button[data-numero]'));
    const versionActual = ++actualizacionEstadoGridVersion;
    const chunkSize = obtenerTamanoChunkActualizacionGrid();
    let indice = 0;

    const pintarSiguienteChunk = () => {
        if (versionActual !== actualizacionEstadoGridVersion) {
            return;
        }

        const limite = Math.min(indice + chunkSize, botones.length);
        for (; indice < limite; indice += 1) {
            aplicarEstadoVisualABoton(botones[indice], soldSet, reservedSet);
        }

        if (indice < botones.length) {
            actualizacionEstadoGridFrameId = requestAnimationFrame(pintarSiguienteChunk);
            return;
        }

        actualizacionEstadoGridFrameId = 0;
        if (filtroDisponiblesActivo) {
            requestAnimationFrame(() => {
                if (versionActual === actualizacionEstadoGridVersion) {
                    aplicarFiltroDisponibles(true);
                }
            });
        }
    };

    actualizacionEstadoGridFrameId = requestAnimationFrame(pintarSiguienteChunk);
}

function inicializarMaquinaSuerteMejorada() {
    const btnGenerar = document.getElementById('btnGenerarNumeros');
    const btnDisminuir = document.getElementById('disminuirCantidad');
    const btnAumentar = document.getElementById('aumentarCantidad');
    const inputCantidad = document.getElementById('cantidadNumeros');
    const btnRepetir = document.getElementById('btnRepetir');
    const btnAgregarSuerte = document.getElementById('btnAgregarSuerte');
    const quickPickContainer = document.getElementById('maquinaQuickPicks');

    actualizarLimiteMaquinaSuerteUI();

    const sincronizarQuickPicksMaquina = function() {
        const quickPickButtons = Array.from(document.querySelectorAll('.maquina-quick-pick'));
        if (!quickPickButtons.length || !inputCantidad) return;

        const cantidadActual = normalizarCantidadMaquinaSuerte(inputCantidad.value);
        const maxTickets = obtenerMaximoPermitidoMaquinaSuerte();

        quickPickButtons.forEach((button) => {
            const cantidad = parseInt(button.dataset.quickCantidad, 10);
            const deshabilitado = !Number.isInteger(cantidad) || cantidad > maxTickets;

            button.classList.toggle('is-disabled', deshabilitado);
            button.disabled = deshabilitado;
            button.classList.toggle('is-active', !deshabilitado && cantidad === cantidadActual && cantidadActual > 0);
        });
    };

    const aplicarCantidadMaquina = function(valor) {
        if (!inputCantidad) return;

        inputCantidad.value = String(normalizarCantidadMaquinaSuerte(valor));
        actualizarTotalMaquina();
        actualizarEstadoBotonGenerar();
        sincronizarQuickPicksMaquina();
    };
    
    // Helper: activar/desactivar botón generar según cantidad
    // Nota: la función `actualizarEstadoBotonGenerar` se define a nivel global
    // (fuera de esta función) para que pueda ser invocada desde
    // `generarNumerosAleatoriosMejorado` y otros contextos.

    // Configurar controles de cantidad
    if (btnDisminuir && btnAumentar && inputCantidad) {
        const decrementarCantidad = function() {
            let cantidad = parseInt(inputCantidad.value, 10);
            if (isNaN(cantidad)) cantidad = 0;
            if (cantidad > 0) {
                aplicarCantidadMaquina(cantidad - 1);
            }
        };
        
        const incrementarCantidad = function() {
            let cantidad = parseInt(inputCantidad.value, 10);
            if (isNaN(cantidad)) cantidad = 0;
            const maxTickets = obtenerMaximoPermitidoMaquinaSuerte();
            if (cantidad < maxTickets) {
                aplicarCantidadMaquina(cantidad + 1);
            }
        };

        const registrarTapRapido = function(boton, handler) {
            let ultimoTouch = 0;

            if (window.PointerEvent) {
                boton.addEventListener('pointerup', function(e) {
                    if (e.pointerType === 'touch' || e.pointerType === 'pen') {
                        ultimoTouch = Date.now();
                        handler();
                    }
                });
            } else {
                boton.addEventListener('touchend', function() {
                    ultimoTouch = Date.now();
                    handler();
                }, { passive: true });
            }

            boton.addEventListener('click', function(e) {
                if (Date.now() - ultimoTouch < 500) {
                    e.preventDefault();
                    return;
                }
                handler();
            });
        };

        registrarTapRapido(btnDisminuir, decrementarCantidad);
        registrarTapRapido(btnAumentar, incrementarCantidad);

        if (quickPickContainer && quickPickContainer.dataset.quickPicksReady !== 'true') {
            quickPickContainer.addEventListener('click', function(event) {
                const button = event.target.closest('.maquina-quick-pick');
                if (!button || button.disabled) return;
                aplicarCantidadMaquina(button.dataset.quickCantidad);
            });
            quickPickContainer.dataset.quickPicksReady = 'true';
        }
        
        inputCantidad.addEventListener('change', function() {
            aplicarCantidadMaquina(this.value);
        });

        // Input sanitization: allow only integers, clamp range, update total and button state live
        inputCantidad.addEventListener('input', function() {
            let raw = this.value;
            // Convert to integer, stripping non-digit characters
            let parsed = parseInt(raw, 10);
            if (isNaN(parsed) || parsed < 0) parsed = 0;
            const maxTickets = obtenerMaximoPermitidoMaquinaSuerte();
            if (parsed > maxTickets) parsed = maxTickets;
            if (String(parsed) !== raw) {
                // Update only if different to avoid cursor jump in some browsers
                this.value = parsed;
            }
            actualizarTotalMaquina();
            actualizarEstadoBotonGenerar();
            sincronizarQuickPicksMaquina();
        });
        
        // Limpiar el 0 cuando el usuario hace focus en el input
        inputCantidad.addEventListener('focus', function() {
            if (this.value === '0') {
                this.value = '';
            }
        });
        
        // Restaurar el 0 si sale vacío
        inputCantidad.addEventListener('blur', function() {
            if (this.value === '' || parseInt(this.value) === 0) {
                this.value = '0';
                actualizarTotalMaquina();
                actualizarEstadoBotonGenerar();
                sincronizarQuickPicksMaquina();
            }
        });
    }
    
    // Configurar botón generar
    if (btnGenerar) {
        btnGenerar.addEventListener('click', generarNumerosAleatoriosMejorado);
        // Inicialmente deshabilitar si datos no listos
        if (!window.rifaplusBoletosLoaded) {
            btnGenerar.disabled = true;
            // crear indicador visual si no existe
            if (!btnGenerar.dataset.origText) btnGenerar.dataset.origText = btnGenerar.textContent || 'Generar';
        }
    }
    
    // Configurar botón repetir
    if (btnRepetir) {
        btnRepetir.addEventListener('click', generarNumerosAleatoriosMejorado);
    }
    
    // Configurar botón agregar suerte
    if (btnAgregarSuerte) {
        btnAgregarSuerte.addEventListener('click', agregarNumerosSuerteAlCarrito);
    }
    
    // Inicializar total y estado del botón
    actualizarTotalMaquina();
    actualizarEstadoBotonGenerar();
    sincronizarQuickPicksMaquina();
    // Actualizar nota de disponibilidad inicialmente
    if (typeof actualizarNotaDisponibilidad === 'function') actualizarNotaDisponibilidad();

    if (!inicializarMaquinaSuerteMejorada._listenerRegistrado) {
        // ✅ CRÍTICO: Re-sincronizar máquina cuando cambia la rifa
        window.addEventListener('configuracionActualizada', () => {
            logCompraDebug('[Máquina] Configuración actualizada, re-validando...');
            actualizarLimiteMaquinaSuerteUI();
            actualizarEstadoBotonGenerar();
            actualizarNotaDisponibilidad();
        });
        
        window.addEventListener('configSyncCompleto', () => {
            logCompraDebug('[Máquina] Sync completo, actualizando UI...');
            actualizarLimiteMaquinaSuerteUI();
            actualizarEstadoBotonGenerar();
            actualizarNotaDisponibilidad();
        });
        
        // ✅ CRÍTICO: Escuchar cambios de rifa (para multirifa)
        if (window.rifaplusConfig?.escucharEvento) {
            window.rifaplusConfig.escucharEvento('rifaCambiada', () => {
                console.log('[Máquina] 🔄 Rifa cambiada, re-sincronizando...');
                // Forzar re-validación de disponibles
                actualizarEstadoBotonGenerar();
                actualizarNotaDisponibilidad();
            });
        }
        
        inicializarMaquinaSuerteMejorada._listenerRegistrado = true;
    }
}

/**
 * Obtener el universo total de boletos para la máquina de la suerte
 * ✅ CRÍTICO: Siempre lee el totalBoletos de la rifa ACTUAL seleccionada
 * 
 * ESTRATEGIA (en orden de prioridad):
 * 1. Leer desde window.rifaplusConfig.rifa.totalBoletos (configuración de rifa actual)
 * 2. Fallback a window.rifaplusConfig.estado.totalBoletos (estado sincronizado)
 * 3. Fallback a caché local de la rifa actual
 * 4. Retornar 0 si no se pudo determinar (previene errores)
 * 
 * @returns {number} Total de boletos de la rifa ACTUAL (nunca de otras rifas)
 */
function obtenerUniversoMaquinaSuerteCompra() {
    try {
        const configRifa = window.rifaplusConfig?.rifa || {};
        const estadoRifa = window.rifaplusConfig?.estado || {};
        
        // ✅ PASO 1: Leer desde configuración de rifa ACTUAL
        const totalConfig = Number(configRifa.totalBoletos);
        if (Number.isFinite(totalConfig) && totalConfig > 0) {
            logCompraDebug(`[Máquina] TotalBoletos (config): ${totalConfig}`);
            return totalConfig;
        }
        
        // ✅ PASO 2: Fallback a estado sincronizado
        const totalEstado = Number(estadoRifa.totalBoletos);
        if (Number.isFinite(totalEstado) && totalEstado > 0) {
            logCompraDebug(`[Máquina] TotalBoletos (estado): ${totalEstado}`);
            return totalEstado;
        }
        
        // ✅ PASO 3: Fallback a caché local de la rifa actual
        const rifaSlug = window.rifaplusConfig?.obtenerSlugRifaActual?.() || 'default';
        const cacheKey = `rifaplus:${rifaSlug}:totalBoletos`;
        const cacheLocal = localStorage.getItem(cacheKey);
        
        if (cacheLocal) {
            try {
                const cached = JSON.parse(cacheLocal);
                const cacheAge = Date.now() - (cached.timestamp || 0);
                
                if (cacheAge < 3600000) { // Menos de 1 hora
                    const totalCache = Number(cached.totalBoletos);
                    if (Number.isFinite(totalCache) && totalCache > 0) {
                        logCompraDebug(`[Máquina] TotalBoletos (caché): ${totalCache}`);
                        return totalCache;
                    }
                }
            } catch (e) {
                // Ignorar errores de caché
            }
        }
        
        // ❌ No se pudo determinar - retornar 0 (previene errores)
        console.warn('[Máquina] No se pudo determinar totalBoletos, usando 0');
        return 0;
        
    } catch (error) {
        console.error('[Máquina] Error obteniendo totalBoletos:', error);
        return 0;
    }
}

const MAQUINA_SUERTE_MAXIMA_SOLICITUD = 5000;
const MAQUINA_SUERTE_QUICK_PICKS_MAXIMO = 12;
const MAQUINA_SUERTE_QUICK_PICKS_DEFAULT = Object.freeze([10, 20, 50, 100]);

function obtenerLimiteConfiguradoMaquinaSuerte() {
    const limite = Number(window.rifaplusConfig?.rifa?.maquinaSuerte?.limiteBoletos);
    const limiteNormalizado = Number.isFinite(limite) && limite > 0 ? Math.floor(limite) : 500;
    return Math.min(limiteNormalizado, MAQUINA_SUERTE_MAXIMA_SOLICITUD);
}

function obtenerMaximoPermitidoMaquinaSuerte() {
    const limiteConfigurado = obtenerLimiteConfiguradoMaquinaSuerte();
    const universoTotal = obtenerUniversoMaquinaSuerteCompra();
    if (universoTotal <= 0) return limiteConfigurado;
    return Math.min(limiteConfigurado, universoTotal);
}

function normalizarCantidadMaquinaSuerte(valor, permitirCero = true) {
    let cantidad = parseInt(valor, 10);
    if (isNaN(cantidad) || cantidad < 0) cantidad = 0;
    const maximo = obtenerMaximoPermitidoMaquinaSuerte();
    if (cantidad > maximo) cantidad = maximo;
    if (!permitirCero && cantidad < 1) cantidad = 1;
    return cantidad;
}

function normalizarQuickPicksMaquinaSuerte(valor, opciones = {}) {
    const fallbackBase = opciones.fallback ?? MAQUINA_SUERTE_QUICK_PICKS_DEFAULT;
    const permitirVacio = opciones.permitirVacio === true;
    const limiteMaximo = Number.isFinite(Number(opciones.limiteMaximo)) && Number(opciones.limiteMaximo) > 0
        ? Math.min(Math.floor(Number(opciones.limiteMaximo)), MAQUINA_SUERTE_MAXIMA_SOLICITUD)
        : obtenerMaximoPermitidoMaquinaSuerte();

    const normalizarLista = (entrada) => {
        let candidatos = [];

        if (Array.isArray(entrada)) {
            candidatos = entrada;
        } else if (typeof entrada === 'string') {
            candidatos = entrada.split(',');
        } else if (typeof entrada === 'number') {
            candidatos = [entrada];
        } else if (entrada != null) {
            candidatos = [entrada];
        }

        return Array.from(new Set(
            candidatos
                .map((item) => Number.parseInt(String(item).trim(), 10))
                .filter((numero) => Number.isInteger(numero) && numero > 0 && numero <= limiteMaximo)
        ))
            .sort((a, b) => a - b)
            .slice(0, MAQUINA_SUERTE_QUICK_PICKS_MAXIMO);
    };

    const quickPicks = normalizarLista(valor);
    const entradaFueProvista = valor !== undefined && valor !== null;
    if (quickPicks.length > 0) {
        return quickPicks;
    }
    if (permitirVacio && entradaFueProvista) {
        return [];
    }

    const fallbackNormalizado = normalizarLista(fallbackBase);
    if (fallbackNormalizado.length > 0) {
        return fallbackNormalizado;
    }

    return [Math.max(1, limiteMaximo)];
}

function obtenerQuickPicksMaquinaSuerte() {
    return normalizarQuickPicksMaquinaSuerte(
        window.rifaplusConfig?.rifa?.maquinaSuerte?.quickPicks,
        {
            limiteMaximo: obtenerMaximoPermitidoMaquinaSuerte(),
            permitirVacio: true
        }
    );
}

function renderizarQuickPicksMaquinaSuerte() {
    const contenedor = document.getElementById('maquinaQuickPicks');
    if (!contenedor) return [];

    const quickPicks = obtenerQuickPicksMaquinaSuerte();
    if (!quickPicks.length) {
        contenedor.hidden = true;
        contenedor.innerHTML = '';
        return [];
    }

    const markup = quickPicks.map((cantidad) =>
        `<button type="button" class="maquina-quick-pick" data-quick-cantidad="${cantidad}">${cantidad}</button>`
    ).join('');

    if (contenedor.innerHTML !== markup) {
        contenedor.innerHTML = markup;
    }
    contenedor.hidden = false;

    return Array.from(contenedor.querySelectorAll('.maquina-quick-pick'));
}

function actualizarLimiteMaquinaSuerteUI() {
    const inputCantidad = document.getElementById('cantidadNumeros');
    const hint = document.getElementById('maquinaLimiteHint');
    const quickPickButtons = renderizarQuickPicksMaquinaSuerte();
    const maximo = obtenerMaximoPermitidoMaquinaSuerte();
    const cantidadActual = inputCantidad ? normalizarCantidadMaquinaSuerte(inputCantidad.value) : 0;

    if (inputCantidad) {
        inputCantidad.max = String(maximo);
        inputCantidad.placeholder = maximo > 0 ? `0 - ${maximo}` : '0';
        inputCantidad.value = String(cantidadActual);
    }

    quickPickButtons.forEach((button) => {
        const cantidad = parseInt(button.dataset.quickCantidad, 10);
        const deshabilitado = !Number.isInteger(cantidad) || cantidad > maximo;
        button.classList.toggle('is-disabled', deshabilitado);
        button.disabled = deshabilitado;
        button.classList.toggle('is-active', !deshabilitado && cantidad === cantidadActual && cantidadActual > 0);
    });

    if (hint) {
        hint.textContent = `Puedes generar hasta ${maximo} boletos por ronda.`;
    }

    actualizarTotalMaquina();
    actualizarEstadoBotonGenerar();
    actualizarNotaDisponibilidad();
}

function actualizarTotalMaquina() {
    const inputCantidad = document.getElementById('cantidadNumeros');
    const totalDisplay = document.getElementById('totalMaquina');
    
    if (!inputCantidad || !totalDisplay) return;
    
    let cantidad = parseInt(inputCantidad.value, 10);
    if (isNaN(cantidad) || cantidad < 0) cantidad = 0;
    const precioUnitario = obtenerPrecioDinamico();
    const total = cantidad * precioUnitario;
    
    // Máquina: actualizar totales (sin logs de depuración)
    totalDisplay.textContent = `$${total.toFixed(2)}`;
}

/**
 * Obtener disponibilidad de boletos para la máquina de la suerte
 * ✅ CRÍTICO: Siempre lee de la rifa ACTUAL seleccionada, NUNCA de caché de otras rifas
 * 
 * ESTRATEGIA (en orden de prioridad):
 * 1. Si hay datos frescos en window.rifaplusConfig (menos de 30 segundos), usarlos
 * 2. Si no, forzar re-sincronización desde backend
 * 3. Calcular desde totalBoletos - vendidos - apartados como fallback
 * 
 * @returns {number|null} Cantidad de boletos disponibles o null si no se pudo determinar
 */
function obtenerDisponiblesGlobalesMaquina() {
    try {
        // ✅ PASO 1: Verificar si tenemos datos FRESCOS de la rifa actual
        const estadoRifa = window.rifaplusConfig?.estado || {};
        const configRifa = window.rifaplusConfig?.rifa || {};
        
        // Verificar frescura de los datos (timestamp de última sincronización)
        const ultimaSincronizacion = window.rifaplusConfig?.ultimaSincronizacion || 0;
        const ahora = Date.now();
        const edadDatos = ahora - ultimaSincronizacion;
        const datosFrescos = edadDatos < 30000; // Menos de 30 segundos
        
        // Intentar obtener desde boletosDisponibles (sincronizado desde backend)
        const disponiblesDirectos = Number(estadoRifa.boletosDisponibles);
        
        if (datosFrescos && Number.isFinite(disponiblesDirectos) && disponiblesDirectos >= 0) {
            // ✅ Datos frescos y válidos - usar directamente
            logCompraDebug(`[Máquina] Disponibles (datos frescos): ${disponiblesDirectos}`);
            return disponiblesDirectos;
        }
        
        // ✅ PASO 2: Calcular desde totalBoletos - vendidos - apartados
        const totalBoletos = Number(configRifa.totalBoletos) || Number(estadoRifa.totalBoletos) || 0;
        const vendidos = Number(estadoRifa.boletosVendidos) || 0;
        const apartados = Number(estadoRifa.boletosApartados) || 0;
        
        if (totalBoletos > 0) {
            const disponiblesCalculados = Math.max(0, totalBoletos - vendidos - apartados);
            logCompraDebug(`[Máquina] Disponibles (calculados): ${disponiblesCalculados} (total=${totalBoletos}, vendidos=${vendidos}, apartados=${apartados})`);
            return disponiblesCalculados;
        }
        
        // ✅ PASO 3: Fallback extremo - intentar desde localStorage
        const cacheLocal = localStorage.getItem('rifaplusBoletosCache');
        if (cacheLocal) {
            try {
                const cached = JSON.parse(cacheLocal);
                const cacheAge = Date.now() - (cached.timestamp || 0);
                
                if (cacheAge < 300000) { // Menos de 5 minutos
                    const disponiblesCache = Number(cached.disponibles);
                    if (Number.isFinite(disponiblesCache) && disponiblesCache >= 0) {
                        logCompraDebug(`[Máquina] Disponibles (caché local): ${disponiblesCache}`);
                        return disponiblesCache;
                    }
                }
            } catch (e) {
                // Ignorar errores de caché local
            }
        }
        
        // ❌ No se pudo determinar disponibilidad
        logCompraDebug(`[Máquina] No se pudo determinar disponibilidad (edadDatos=${edadDatos}ms, totalBoletos=${totalBoletos})`);
        return null;
        
    } catch (error) {
        console.error('[Máquina] Error obteniendo disponibles:', error);
        return null;
    }
}

function maquinaSuerteDebeMostrarNotaDisponibilidad() {
    return window.rifaplusConfig?.rifa?.maquinaSuerte?.mostrarNotaDisponibilidad !== false;
}

function aplicarEstadoNotaDisponibilidad(texto, estado = 'ready', opciones = {}) {
    const note = document.getElementById('availabilityNote');
    if (!note) return;

    if (!maquinaSuerteDebeMostrarNotaDisponibilidad()) {
        note.textContent = '';
        note.style.display = 'none';
        note.style.visibility = 'hidden';
        note.style.opacity = '0';
        note.style.color = '';
        note.dataset.state = 'hidden';
        return;
    }

    note.textContent = texto;
    note.style.display = 'inline-flex';
    note.style.visibility = 'visible';
    note.style.opacity = '1';
    note.style.color = opciones.color || '';
    note.dataset.state = estado;
}

function actualizarEstadoVisualBotonGenerar(estado, contexto = {}) {
    const btnGenerar = document.getElementById('btnGenerarNumeros');
    if (!btnGenerar) return;

    const maximo = Number(contexto.maximo) || obtenerMaximoPermitidoMaquinaSuerte();
    const textos = {
        idle: 'GENERAR NÚMEROS',
        empty: 'INGRESA UNA CANTIDAD',
        loading: 'CARGANDO DISPONIBILIDAD...',
        limit: `MÁXIMO ${maximo} BOLETOS`,
        insufficient: 'NO HAY SUFICIENTES BOLETOS',
        generating: '⏳ GENERANDO...'
    };

    const label = textos[estado] || textos.idle;
    btnGenerar.textContent = label;
    btnGenerar.dataset.state = estado;
    btnGenerar.setAttribute('aria-busy', estado === 'loading' || estado === 'generating' ? 'true' : 'false');
    btnGenerar.classList.toggle('is-pending', estado === 'loading');
    btnGenerar.classList.toggle('is-insufficient', estado === 'insufficient');
}

// Función global para activar/desactivar el botón 'Generar' según cantidad y disponibilidad
function actualizarEstadoBotonGenerar() {
    const btnGenerar = document.getElementById('btnGenerarNumeros');
    const inputCantidad = document.getElementById('cantidadNumeros');
    if (!btnGenerar || !inputCantidad) return;
    
    let val = parseInt(inputCantidad.value, 10);
    if (isNaN(val) || val < 1) {
        btnGenerar.disabled = true;
        actualizarEstadoVisualBotonGenerar('empty');
        return;
    }

    const maximoPermitido = obtenerMaximoPermitidoMaquinaSuerte();
    if (val > maximoPermitido) {
        btnGenerar.disabled = true;
        actualizarEstadoVisualBotonGenerar('limit', { maximo: maximoPermitido });
        return;
    }

    const disponiblesConfirmados = obtenerDisponiblesGlobalesMaquina();
    const tieneDisponibilidadConfirmada = Number.isFinite(disponiblesConfirmados);
    const loaded = !!window.rifaplusBoletosLoaded;

    if (!tieneDisponibilidadConfirmada) {
        btnGenerar.disabled = true;
        actualizarEstadoVisualBotonGenerar('loading');
        logCompraDebug(`[compra] Boton generar deshabilitado (cantidad=${val}, disponibles=pendiente, loaded=${loaded})`);
        return;
    }

    const puedeGenerar = disponiblesConfirmados >= val;
    btnGenerar.disabled = !puedeGenerar;

    if (!puedeGenerar) {
        actualizarEstadoVisualBotonGenerar('insufficient');
    } else {
        actualizarEstadoVisualBotonGenerar('idle');
    }

    logCompraDebug(`[compra] Boton generar ${btnGenerar.disabled ? 'deshabilitado' : 'habilitado'} (cantidad=${val}, disponibles=${tieneDisponibilidadConfirmada ? disponiblesConfirmados : 'desconocido'}, loaded=${loaded})`);
}

// Mostrar nota de disponibilidad bajo el botón Generar
function actualizarNotaDisponibilidad() {
    if (!maquinaSuerteDebeMostrarNotaDisponibilidad()) {
        aplicarEstadoNotaDisponibilidad('', 'hidden');
        return;
    }

    const note = document.getElementById('availabilityNote');
    if (!note) return;

    const disponiblesGlobales = obtenerDisponiblesGlobalesMaquina();
    if (Number.isFinite(disponiblesGlobales) && disponiblesGlobales >= 0) {
        const resumen = obtenerResumenInventarioBoletos();
        if (disponiblesGlobales === 0 && resumen.apartados > 0) {
            aplicarEstadoNotaDisponibilidad('Por ahora no hay disponibles; hay boletos apartados en proceso.', 'warning');
            return;
        }

        if (disponiblesGlobales === 0) {
            aplicarEstadoNotaDisponibilidad('Boletos agotados. Gracias por tu preferencia.', 'soldout');
            return;
        }

        aplicarEstadoNotaDisponibilidad(`${disponiblesGlobales} boletos disponibles`, 'ready');
        return;
    }
    
    if (note.textContent && note.textContent.includes('boletos disponibles') && !note.textContent.includes('Cargando')) {
        // Ya tenemos un valor, no cambiar
        return;
    }
    
    aplicarEstadoNotaDisponibilidad('Estamos validando disponibilidad para la máquina...', 'loading');
}

async function generarNumerosAleatoriosMejorado() {
    const inputCantidad = document.getElementById('cantidadNumeros');
    const numerosSuerte = document.getElementById('numerosSuerte');
    const resultado = document.getElementById('maquinaResultado');
    const btnGenerar = document.getElementById('btnGenerarNumeros');

    if (!inputCantidad || !numerosSuerte || !resultado) {
        console.error('❌ Elementos de máquina de la suerte no encontrados');
        rifaplusUtils.showFeedback('⚠️ Error: No se encontraron los elementos de la máquina', 'error');
        return;
    }

    const cantidad = parseInt(inputCantidad.value, 10);
    const maximoPermitido = obtenerMaximoPermitidoMaquinaSuerte();
    if (isNaN(cantidad) || cantidad < 1) {
        rifaplusUtils.showFeedback('⚠️ Selecciona al menos 1 número para generar.', 'warning');
        return;
    }
    if (cantidad > maximoPermitido) {
        inputCantidad.value = String(maximoPermitido);
        actualizarTotalMaquina();
        actualizarEstadoBotonGenerar();
        rifaplusUtils.showFeedback(`⚠️ La máquina de la suerte permite generar hasta ${maximoPermitido} boletos por intento.`, 'warning');
        return;
    }

    // Mostrar estado de carga
    if (btnGenerar) {
        btnGenerar.disabled = true;
        actualizarEstadoVisualBotonGenerar('generating');
    }

    try {
        // Validar disponibilidad antes de generar
        const disponiblesGlobales = Number(window.rifaplusConfig?.estado?.boletosDisponibles);
        if (Number.isFinite(disponiblesGlobales) && disponiblesGlobales >= 0 && disponiblesGlobales < cantidad) {
            rifaplusUtils.showFeedback(`⚠️ Solo hay ${disponiblesGlobales} boletos disponibles. No puedes generar ${cantidad} números.`, 'warning');
            return;
        }

        const numerosGenerados = await generarNumerosVerificadosEnServidor(cantidad);

        if (numerosGenerados.length < cantidad) {
            await cargarBoletosPublicos();
            rifaplusUtils.showFeedback(`⚠️ Solo se pudieron obtener ${numerosGenerados.length} de ${cantidad} boletos disponibles en este momento. Intenta de nuevo.`, 'warning');
            return;
        }

        // Renderizar números
        numerosSuerte.innerHTML = '';
        const fragment = document.createDocumentFragment();

        numerosGenerados.forEach(numero => {
            const chip = document.createElement('div');
            chip.className = 'numero-chip';
            // Mostrar formateado (con ceros a la izquierda)
            const numeroFormateado = window.rifaplusConfig.formatearNumeroBoleto(numero);
            chip.textContent = numeroFormateado;
            chip.setAttribute('data-numero', numero);
            fragment.appendChild(chip);
        });

        numerosSuerte.appendChild(fragment);
        numerosSuerte.setAttribute('data-numeros', numerosGenerados.join(','));

        // Mostrar resultado
        resultado.style.display = 'block';
        resultado.style.visibility = 'visible';
        resultado.style.opacity = '1';
        resultado.style.transition = 'opacity 300ms ease-out, visibility 300ms ease-out';
        logCompraDebug('[compra] Numeros generados por maquina:', numerosGenerados);

        // Scroll suave hacia la sección de resultados (corto)
        setTimeout(() => {
            resultado.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 100);

        // Efecto visual de aparición optimizado
        const chips = numerosSuerte.querySelectorAll('.numero-chip');

        // Para muchos boletos (>100), usar CSS animation en lugar de JavaScript
        if (cantidad > 100) {
            // Agregar clase que activa animación CSS en masa (sin cascadas)
            requestAnimationFrame(() => {
                chips.forEach(chip => {
                    chip.classList.add('fast-appear');
                });
            });
        } else {
            // Para cantidades pequeñas, usar cascada para efecto visual mejor
            chips.forEach((chip, index) => {
                chip.style.opacity = '0';
                chip.style.transform = 'scale(0.5)';

                // Reducir delay: máximo 500ms total (no 50 segundos)
                const delay = Math.min(index * 30, 500);
                setTimeout(() => {
                    chip.style.transition = 'all var(--transition-fast)';
                    chip.style.opacity = '1';
                    chip.style.transform = 'scale(1)';
                }, delay);
            });
        }

        rifaplusUtils.showFeedback(`🎲 ${numerosGenerados.length} números generados correctamente`, 'success');
        return numerosGenerados;

    } catch (error) {
        console.error('❌ Error al generar números:', error);
        rifaplusUtils.showFeedback(`❌ Error: ${error.message}`, 'error');
    } finally {
        // Restaurar botón
        if (btnGenerar) {
            if (typeof actualizarEstadoBotonGenerar === 'function') {
                actualizarEstadoBotonGenerar();
            }
        }
    }
}

function obtenerNumerosDisponibles() {
    // Obtener total de boletos DIRECTAMENTE de config.js
    const totalTickets = window.rifaplusConfig.rifa.totalBoletos;
    
    // Obtener rango visible (si oportunidades está habilitada)
    const oportunidadesConfig = window.rifaplusConfig.rifa.oportunidades;
    let rangoVisible = { inicio: 0, fin: totalTickets - 1 };
    
    if (oportunidadesConfig && oportunidadesConfig.enabled && oportunidadesConfig.rango_visible) {
        rangoVisible = oportunidadesConfig.rango_visible;
    }
    
    // Obtener arrays de boletos vendidos/apartados del servidor
    const { sold, reserved } = obtenerEstadoLocalBoletos();
    
    // ⏳ REQUISITO PRINCIPAL: SIEMPRE esperar a que el servidor envíe datos reales
    // Si arrays están vacíos, significa que Stage 2 aun no terminó o falló
    // NO generar números sin validation real del servidor
    if (sold.length === 0 && reserved.length === 0 && !rifaplusEstadoRangoActual.cargado) {
        logCompraDebug('[compra] Esperando datos del servidor para numeros disponibles');
        return []; // Retornar vacío hasta tener datos reales
    }
    
    // Crear un conjunto de todos los números VISIBLES (rango_visible.inicio a rango_visible.fin)
    const todosLosNumeros = new Set();
    for (let i = rangoVisible.inicio; i <= rangoVisible.fin; i++) {
        todosLosNumeros.add(i);
    }
    
    // Eliminar números que están vendidos/apartados (datos reales del servidor)
    sold.forEach(n => {
        const nn = Number(n);
        if (!Number.isNaN(nn)) todosLosNumeros.delete(nn);
    });
    reserved.forEach(n => {
        const nn = Number(n);
        if (!Number.isNaN(nn)) todosLosNumeros.delete(nn);
    });
    
    // Eliminar números ya seleccionados en el carrito de esta sesión
    selectedNumbersGlobal.forEach(num => todosLosNumeros.delete(num));
    
    // Convertir Set a Array y retornar
    return Array.from(todosLosNumeros);
}

function agregarNumerosSuerteAlCarrito() {
    const numerosSuerte = document.getElementById('numerosSuerte');
    const numerosStr = numerosSuerte.getAttribute('data-numeros');
    
    if (!numerosStr) {
        rifaplusUtils.showFeedback('⚠️ Primero genera algunos números con la máquina de la suerte', 'warning');
        return;
    }
    
    const numeros = numerosStr.split(',').map(num => parseInt(num.trim(), 10)).filter(n => !isNaN(n));
    let agregados = 0;
    
    // OPTIMIZACIÓN: Agregar todos los boletos al estado interno sin actualizar UI cada vez
    const { sold, reserved } = obtenerEstadoLocalBoletos();
    const selectedNumbers = obtenerBoletosSelecionados();
    let stored = JSON.parse(localStorage.getItem('rifaplusSelectedNumbers') || '[]');
    
    const boletos_para_agregar = [];
    
    // Validar y coleccionar todos los boletos válidos
    numeros.forEach((numero) => {
        if (!sold.includes(numero) && !reserved.includes(numero) && !selectedNumbers.includes(numero)) {
            boletos_para_agregar.push(numero);
        }
    });
    
    // Agregar todos al estado de una sola vez
    boletos_para_agregar.forEach((numero) => {
        if (typeof selectedNumbersGlobal !== 'undefined') {
            selectedNumbersGlobal.add(numero);
        }
        if (!stored.includes(numero)) {
            stored.push(numero);
        }
        agregados++;
    });
    
    // Guardar localStorage UNA SOLA VEZ
    if (agregados > 0) {
        localStorage.setItem('rifaplusSelectedNumbers', JSON.stringify(stored));
    }
    
    // Marcar botones en la grilla
    boletos_para_agregar.forEach((numero, index) => {
        const botonNumero = document.querySelector(`.numero-btn[data-numero="${numero}"]`);
        if (botonNumero && !botonNumero.classList.contains('selected')) {
            botonNumero.classList.add('selected');
        }
        if (botonNumero) {
            setTimeout(() => {
                enfatizarNumeroSeleccionado(botonNumero);
            }, Math.min(280, index * 55));
        }
    });
    
    // Calcular el tiempo máximo de animaciones
    let tiempoMaximoAnimacion = 0;
    
    // Animaciones según cantidad
    boletos_para_agregar.forEach((numero, index) => {
        if (numeros.length <= 5) {
            // Pocos boletos: animar todos con cascada
            tiempoMaximoAnimacion = Math.max(tiempoMaximoAnimacion, index * 150 + 600);
            setTimeout(() => {
                animarAgregarAlCarrito(null, numero, false);
            }, index * 150);
        } else if (numeros.length <= 50) {
            // Cantidad media: animar cada 5 boletos
            if (index % 5 === 0) {
                tiempoMaximoAnimacion = Math.max(tiempoMaximoAnimacion, 600);
                animarAgregarAlCarrito(null, numero, false);
            }
        }
        // Para >50, no animar individuales - solo una animación final
    });
    
    // Mostrar resultado solo si se agregaron números
    if (agregados > 0) {
        // Actualizar UI UNA SOLA VEZ (antes lo hacía múltiples veces)
        actualizarResumenCompraConDebounce();
        actualizarVistaCarritoGlobal();
        actualizarContadorCarritoGlobal();
        
        // Si son muchos boletos, animar carrito una sola vez
        let delayFinal = tiempoMaximoAnimacion;
        if (numeros.length > 50) {
            setTimeout(() => {
                animarAgregarAlCarrito(null, 0, false);
            }, 50);
            delayFinal = Math.max(tiempoMaximoAnimacion, 600);
        }
        
        // 🎯 IMPORTANTE: Ocultar la máquina de suerte DESPUÉS de que terminen las animaciones
        // Esto asegura que los elementos origen de las animaciones sigan siendo accesibles
        setTimeout(() => {
            const resultado = document.getElementById('maquinaResultado');
            if (resultado) {
                resultado.style.opacity = '0';
                resultado.style.visibility = 'hidden';
                resultado.style.transition = 'opacity 220ms ease-out, visibility 220ms ease-out';
                setTimeout(() => {
                    resultado.style.display = 'none';
                }, 220);
            }
            rifaplusUtils.showFeedback(`✅ Se agregaron ${agregados} boletos al carrito`, 'success');
        }, delayFinal + 100);
    } else {
        rifaplusUtils.showFeedback('⚠️ No se pudieron agregar los números. Puede que ya estén seleccionados o no estén disponibles.', 'warning');
    }
}

/**
 * actualizarEstadoBtnComprar - Actualiza estado visual del botón según carga de oportunidades
 * Se llama desde cargarOportunidadesDelCarrito() para deshabilitar/habilitar botón
 * @returns {void}
 */
function actualizarEstadoBtnComprar() {
    const btnComprar = document.getElementById('btnComprar');
    if (!btnComprar) return;
    
    const estadoCarga = window.rifaplusOportunidadesEstadoCarga;
    const estaCargando = estadoCarga?.iniciado && !estadoCarga?.completado;
    const cantidadSeleccionada = selectedNumbersGlobal.size;
    const hayValidacionesPendientes = validacionesSeleccionPendientes.size > 0;
    
    if (estaCargando) {
        // Deshabilitar botón mientras se cargan oportunidades
        btnComprar.disabled = true;
        btnComprar.classList.add('disabled');
        const progreso = estadoCarga.cargadas || 0;
        const total = estadoCarga.total || 0;
        const porcentaje = total > 0 ? Math.round((progreso / total) * 100) : 0;
        btnComprar.textContent = `⏳ Cargando... (${porcentaje}%)`;
        btnComprar.title = `Cargando oportunidades: ${progreso}/${total}`;
    } else {
        // Rehabilitar botón cuando termina la carga
        btnComprar.disabled = cantidadSeleccionada === 0 || hayValidacionesPendientes;
        btnComprar.classList.toggle('disabled', btnComprar.disabled);
        btnComprar.textContent = 'Confirmar compra';
        btnComprar.title = hayValidacionesPendientes
            ? 'Esperando la validacion final de tus boletos seleccionados'
            : 'Hacer compra';
    }
}

function configurarEventListeners() {
    const grid = document.getElementById('numerosGrid');
    const btnLimpiar = document.getElementById('btnLimpiar');
    const btnComprar = document.getElementById('btnComprar');
    const btnProbarMaquina = document.getElementById('btnProbarMaquina');

    // 1. CLICKS EN NÚMEROS
    if (grid) {
        grid.addEventListener('click', function(e) {
            if (e.target.classList.contains('numero-btn')) {
                manejarClickNumero(e.target);
            }
        });
    }
    
    // 2. BOTONES DE RANGO - Se configuran dinámicamente en generarBotonesRango()
    
    // 3. BOTÓN LIMPIAR ✅ MEJORADO: Usar delegación si no existe aún
    if (btnLimpiar) {
        btnLimpiar.addEventListener('click', limpiarSeleccion);
    } else {
        // Fallback: Usar delegación de eventos para cuando el botón se agregue dinámicamente
        document.addEventListener('click', function(e) {
            if (e.target.id === 'btnLimpiar') {
                limpiarSeleccion();
            }
        });
    }
    
    // 4. BOTÓN COMPRAR ✅ MEJORADO: Usar delegación si no existe aún
    if (btnComprar) {
        btnComprar.addEventListener('click', function() {
            const seleccionados = selectedNumbersGlobal.size;
            if (seleccionados > 0) {
                iniciarFlujoPago();
            } else {
                rifaplusUtils.showFeedback('⚠️ Primero selecciona al menos un boleto', 'warning');
            }
        });
    } else {
        // Fallback: Usar delegación de eventos para cuando el botón se agregue dinámicamente
        document.addEventListener('click', function(e) {
            if (e.target.id === 'btnComprar') {
                const seleccionados = selectedNumbersGlobal.size;
                if (seleccionados > 0) {
                    iniciarFlujoPago();
                } else {
                    rifaplusUtils.showFeedback('⚠️ Primero selecciona al menos un boleto', 'warning');
                }
            }
        });
    }

    // 5. BOTÓN PROBAR MÁQUINA - Scroll suave con offset para mostrar el título
    if (btnProbarMaquina) {
        btnProbarMaquina.addEventListener('click', function(e) {
            e.preventDefault();
            scrollSuaveCompraA('maquinaCard', -80);
        });
    }

    // Scroll con offset para "Seleccionar Boletos"
    const btnSeleccionarBoletos = document.querySelector('.compra-hero-cta .btn[href="#numerosGrid"]');
    if (btnSeleccionarBoletos) {
        btnSeleccionarBoletos.addEventListener('click', function(e) {
            e.preventDefault();
            scrollSuaveCompraA('.seleccion-section .section-title', -40) ||
                scrollSuaveCompraA('numerosGrid', -80);
        });
    }

    // 6. FILTRO DE BOLETOS - Mostrar solo disponibles
    const filtroDisponibles = document.getElementById('filtroDisponibles');
    if (filtroDisponibles) {
        filtroDisponibles.addEventListener('change', function() {
            const mostrarTodos = this.checked === true;
            aplicarFiltroDisponibles(!mostrarTodos, {
                refrescarGridPrincipal: true,
                preservarScroll: true
            });
        });
    }

    // 7. BÚSQUEDA DE BOLETOS
    configurarBuscadorBoletos();

    document.addEventListener('click', async function(e) {
        const refreshBtn = e.target.closest('[data-action="refresh-availability"]');
        if (!refreshBtn) {
            return;
        }

        e.preventDefault();

        if (refreshBtn.disabled) {
            return;
        }

        const label = refreshBtn.querySelector('span');
        const textoOriginal = label ? label.textContent : '';
        refreshBtn.disabled = true;
        if (label) {
            label.textContent = 'Actualizando...';
        }

        try {
            await cargarBoletosPublicos();

            if (!estaVistaBusquedaActiva()) {
                const rangoActual = infiniteScrollState.rangoActual || obtenerRangoVisibleInicial();
                const container = document.querySelector('.boletos-container-scrolleable');
                const scrollTopActual = container ? container.scrollTop : null;
                await renderRange(rangoActual.inicio, rangoActual.fin, {
                    reason: 'refresh-no-disponibles',
                    preservarScroll: true,
                    restoreScrollTop: scrollTopActual
                });
            } else {
                actualizarMensajeGridSinDisponibles();
            }
        } catch (error) {
            console.error('❌ Error actualizando disponibilidad desde aviso contextual:', error);
            if (window.rifaplusUtils?.showFeedback) {
                window.rifaplusUtils.showFeedback('No pudimos actualizar la disponibilidad en este momento.', 'warning');
            }
        } finally {
            refreshBtn.disabled = false;
            if (label) {
                label.textContent = textoOriginal || 'Actualizar disponibilidad';
            }
        }
    });
}

function scrollSuaveCompraA(target, offset) {
    const elemento = typeof target === 'string'
        ? document.querySelector(target) || document.getElementById(target)
        : target;

    if (!elemento) {
        return false;
    }

    const y = elemento.getBoundingClientRect().top + window.pageYOffset + offset;
    window.scrollTo({ top: y, behavior: 'smooth' });
    return true;
}

/**
 * FLUJO DE SELECCIÓN DE BOLETOS
 * =============================
 * 1. Click en boletera -> manejarClickNumero (agregar o remover)
 * 2. Búsqueda o máquina -> agregarBoletoDirectoCarrito (valida y agrega)
 * 3. Eliminar de carrito -> removerBoletoSeleccionado (quita de todo)
 * 4. Eliminar del resumen -> removerBoletoSeleccionado (quita de todo)
 * 5. Limpiar todo -> handleLimpiarCarrito (limpia carrito) o limpiarSeleccion (limpia selección)
 */

function manejarClickNumero(boton) {
    if (boton.classList.contains('is-processing')) {
        return;
    }

    const numero = parseInt(boton.getAttribute('data-numero'), 10);
    
    if (boton.classList.contains('selected')) {
        // DESELECCIONAR: quitar de Set, localStorage y actualizar vistas
        // ⚡ Versión defensiva - usa función si está disponible, sino usa API global
        if (typeof removerBoletoSeleccionado === 'function') {
            removerBoletoSeleccionado(numero);
        } else if (typeof window.removerBoletoSeleccionado === 'function') {
            window.removerBoletoSeleccionado(numero);
        } else {
            console.error('❌ Function removerBoletoSeleccionado not available');
        }
    } else {
        const { soldSet, reservedSet } = obtenerEstadoLocalBoletos();
        if (soldSet.has(numero) || boton.classList.contains('sold')) {
            rifaplusUtils.showFeedback(`❌ Boleto #${numero} está vendido`, 'error');
            return;
        }

        if (reservedSet.has(numero) || boton.classList.contains('reserved')) {
            rifaplusUtils.showFeedback(`⏳ Boleto #${numero} está apartado`, 'warning');
            return;
        }

        if (selectedNumbersGlobal.has(numero)) {
            boton.classList.add('selected');
            return;
        }

        // SELECCIONAR: respuesta inmediata + validación en segundo plano
        boton.classList.add('is-processing');
        boton.classList.add('is-pending');
        boton.disabled = true;

        if (!agregarSeleccionLocal(numero)) {
            limpiarEstadoInteractivoBoleto(boton);
            return;
        }

        boton.classList.add('selected');
        boton.setAttribute('title', 'Seleccionado');
        boton.disabled = true;
        marcarNumeroComoSeleccionadoEnBusqueda(numero);
        enfatizarNumeroSeleccionado(boton);

        const token = registrarValidacionSeleccionPendiente(numero);
        void validarSeleccionOptimista(numero, boton, token);
    }
}

function limpiarSeleccion() {
    if (selectedNumbersGlobal.size === 0) {
        rifaplusUtils.showFeedback('No tienes números seleccionados', 'warning');
        return;
    }
    
    if (confirm(`¿Estás seguro de que quieres limpiar la selección de ${selectedNumbersGlobal.size} número(s)?`)) {
        // Remover clase 'selected' de todos los botones de la boletera
        const seleccionados = document.querySelectorAll('.numero-btn.selected');
        seleccionados.forEach(boton => {
            limpiarEstadoInteractivoBoleto(boton);
        });
        
        // Limpiar datos
        selectedNumbersGlobal.clear();
        localStorage.removeItem('rifaplusSelectedNumbers');
        validacionesSeleccionPendientes.clear();
        actualizarEstadoBtnComprar();
        
        // Actualizar todas las vistas (usar debounce para resumen)
        actualizarResumenCompraConDebounce();
        actualizarVistaCarritoGlobal();
        actualizarContadorCarritoGlobal();
        
        // Cerrar carrito modal si está abierto
        const carritoModal = document.getElementById('carritoModal');
        if (carritoModal && carritoModal.classList.contains('active')) {
            carritoModal.classList.remove('active');
        }
        
        rifaplusUtils.showFeedback('Selección limpiada correctamente', 'success');
    }
}

function actualizarResumenCompra() {
    const cantidadBoletos = document.getElementById('cantidadBoletos');
    const numerosSeleccionados = document.getElementById('numerosSeleccionados');
    const descuentoAplicado = document.getElementById('descuentoAplicado');
    const totalPagar = document.getElementById('totalPagar');
    const btnComprar = document.getElementById('btnComprar');
    const btnLimpiar = document.getElementById('btnLimpiar');
    
    if (!cantidadBoletos) return;
    
    // Usar Set global en lugar de contar botones visibles
    const cantidad = selectedNumbersGlobal.size;

    cantidadBoletos.textContent = cantidad;
    
    if (numerosSeleccionados) {
        if (cantidad > 0) {
            // Ordenar números seleccionados para visualización
            const numerosOrdenados = Array.from(selectedNumbersGlobal).sort((a, b) => a - b);
            
            // ✅ NOTA: Las oportunidades ya NO se calculan en cliente
            // Con el nuevo sistema pre-asignado:
            // - Las oportunidades vienen de la BD en POST /api/ordenes
            // - Se actualizan automáticamente via FK CASCADE
            // - El cliente solo las recupera en GET /api/oportunidades/{numero_orden} si necesita mostrarlas
            // No hay necesidad de calcular nada aquí
            
            let oportunidadesPorBoleto = {};
            
            // Obtener total de boletos para calcular el padding dinámico
            const totalTickets = window.rifaplusConfig.rifa.totalBoletos;
            const digitosMaximos = String(totalTickets - 1).length;
            
            // Renderizar boletos SIN oportunidades
            numerosSeleccionados.innerHTML = `
                <div class="lista-numeros">
                    ${numerosOrdenados.map(num => {
                        const numeroFormateado = num.toString().padStart(digitosMaximos, '0');
                        return `
                        <div class="numero-chip-container" data-numero="${num}">
                            <span class="numero-chip" data-numero="${num}">
                                ${numeroFormateado}
                                <button class="numero-chip-delete" data-numero="${num}" aria-label="Eliminar boleto ${numeroFormateado}" title="Eliminar boleto ${numeroFormateado}">
                                    ×
                                </button>
                            </span>
                        </div>
                    `;
                    }).join('')}
                </div>
            `;
            
            // Agregar event listeners a los botones de eliminar en el resumen
            numerosSeleccionados.querySelectorAll('.numero-chip-delete').forEach(btn => {
                btn.addEventListener('click', function(e) {
                    e.stopPropagation();
                    const numero = parseInt(this.getAttribute('data-numero'), 10);
                    removerBoletoSeleccionado(numero);
                });
            });
        } else {
            numerosSeleccionados.innerHTML = '<p class="sin-seleccion">Aún no has seleccionado ningún boleto</p>';
        }
    }
    
    const precioUnitario = obtenerPrecioDinamico();
    
    // Usar función centralizada para calcular descuentos
    const calculoDescuento = window.rifaplusUtils.calcularDescuento(cantidad, precioUnitario);
    
    const total = calculoDescuento.totalFinal;
    const descuento = calculoDescuento.descuentoMonto;
    
    if (descuentoAplicado) {
        descuentoAplicado.textContent = `$${descuento.toFixed(2)}`;
    }
    
    if (totalPagar) {
        totalPagar.textContent = `$${total.toFixed(2)}`;
    }
    
    if (btnComprar) {
        actualizarEstadoBtnComprar();
    }
    
    // Desactivar/activar botón de limpiar según haya boletos
    if (btnLimpiar) {
        btnLimpiar.disabled = cantidad === 0;
    }
    
    // Guardar totales actualizados en localStorage para consistencia
    try {
        const resumenSerializado = JSON.stringify({
            subtotal: calculoDescuento.subtotal,
            descuento: calculoDescuento.descuentoMonto,
            totalFinal: calculoDescuento.totalFinal,
            precioUnitario: calculoDescuento.precioUnitario,
            cantidad: calculoDescuento.cantidadBoletos,
            combo: calculoDescuento.combo || null
        });

        if (resumenPersistidoSnapshot !== resumenSerializado) {
            localStorage.setItem('rifaplus_total', resumenSerializado);
            resumenPersistidoSnapshot = resumenSerializado;
        }
    } catch (e) {
        console.warn('No se pudo guardar rifaplus_total en localStorage', e);
    }

    // Resumen actualizado
}

function generarBotonesRango() {
    const rangoBoxes = document.getElementById('rangoBoxes');
    const instruccionRango = document.querySelector('.instruccion-rango');
    
    if (!rangoBoxes) {
        console.error('❌ ERROR: No se encontró elemento rangoBoxes');
        return false;
    }
    
    // Limpiar botones previos
    rangoBoxes.innerHTML = '';
    
    // SOLO usar rangos de config.js (sin fallback)
    const rangos = (window.rifaplusConfig?.rifa?.rangos || []).filter(rango =>
        Number.isInteger(parseInt(rango?.inicio, 10)) &&
        Number.isInteger(parseInt(rango?.fin, 10))
    );
    
    if (rangos.length === 0) {
        console.warn('⏳ Rangos no disponibles todavía (sincronización en progreso...)');
        return false;  // Retornar FALSE indica que no se pudo generar
    }

    const mostrarSelectorRangos = rangos.length > 1;
    rangoBoxes.style.display = mostrarSelectorRangos ? 'flex' : 'none';
    if (instruccionRango) {
        instruccionRango.style.display = mostrarSelectorRangos ? 'block' : 'none';
    }

    if (!mostrarSelectorRangos) {
        logCompraDebug('[compra] Solo hay un rango configurado; se oculta el selector');
        return true;
    }
    
    let esActivo = true;
    for (const rango of rangos) {
        const btn = document.createElement('button');
        btn.className = 'rango-btn';
        if (esActivo) {
            btn.classList.add('active');
            esActivo = false;
        }
        btn.setAttribute('data-inicio', rango.inicio);
        btn.setAttribute('data-fin', rango.fin);
        btn.textContent = rango.nombre || `${rango.inicio}-${rango.fin}`;
        
        btn.addEventListener('click', function() {
            manejarCambioRango(this);
        });
        
        rangoBoxes.appendChild(btn);
    }
    
    logCompraDebug(`[compra] Botones de rango generados: ${rangos.length}`);
    return true;  // Éxito
}

function solicitarInicializacionRangoCuandoConfigEsteLista() {
    if (rangoInitSuscrito) {
        return;
    }

    rangoInitSuscrito = true;

    const reintentar = () => {
        if (!inicializarRangoDefault()) {
            return;
        }

        rangoInitSuscrito = false;
        window.removeEventListener('configSyncCompleto', reintentar);
        window.removeEventListener('configuracionActualizada', reintentar);
    };

    window.addEventListener('configSyncCompleto', reintentar);
    window.addEventListener('configuracionActualizada', reintentar);
}

function inicializarRangoDefault() {
    // Generar botones de rango desde config.js
    const exitoGen = generarBotonesRango();
    
    if (!exitoGen) {
        return false;
    }
    
    // Usar SIEMPRE el primer rango de config.js
    const primerRango = (window.rifaplusConfig?.rifa?.rangos || []).find(rango =>
        Number.isInteger(parseInt(rango?.inicio, 10)) &&
        Number.isInteger(parseInt(rango?.fin, 10))
    );
    
    if (!primerRango) {
        console.warn('⏳ Primer rango no disponible todavía...');
        return false;
    }
    
    const rangoBtns = document.querySelectorAll('.rango-btn');
    if (rangoBtns.length > 0) {
        rangoBtns.forEach(btn => btn.classList.remove('active'));
        rangoBtns[0].classList.add('active');
    }

    void renderRange(primerRango.inicio, primerRango.fin, {
        reason: 'rango-inicial'
    });
    return true;
}

async function renderRange(inicio, fin, opciones = {}) {
    const grid = document.getElementById('numerosGrid');
    if (!grid) return;

    const { reason = 'cambio-rango', preservarScroll = false } = opciones;
    const restoreScrollTop = Number.isFinite(opciones.restoreScrollTop) ? opciones.restoreScrollTop : null;
    const rangoNormalizado = normalizarRangoNumerico(inicio, fin);
    const endpoint = obtenerApiBaseCompra();
    const container = document.querySelector('.boletos-container-scrolleable');
    const renderRequestId = ++infiniteScrollState.renderRequestId;
    const estadoYaDisponible = rifaplusEstadoRangoActual.cargado &&
        rifaplusEstadoRangoActual.inicio === rangoNormalizado.inicio &&
        rifaplusEstadoRangoActual.fin === rangoNormalizado.fin &&
        rifaplusEstadoRangoActual.endpoint === endpoint;

    infiniteScrollState.lastRenderTime = Date.now();
    infiniteScrollState.rangoActual = { ...rangoNormalizado };
    infiniteScrollState.boletosCargados = 0;
    infiniteScrollState.cursorNumero = rangoNormalizado.inicio;
    infiniteScrollState.modoDisponibles = filtroDisponiblesActivo && !estaVistaBusquedaActiva();
    infiniteScrollState.hasMore = true;
    infiniteScrollState.isLoading = false;

    if (infiniteScrollState.observer) {
        infiniteScrollState.observer.disconnect();
        infiniteScrollState.observer = null;
    }

    grid.innerHTML = '';
    grid.style.pointerEvents = 'none';
    grid.style.opacity = '1';

    if (!estadoYaDisponible) {
        mostrarEstadoCargaGrid(true);
    }

    try {
        const exito = await cargarEstadoRangoVisibleEnBackground(
            endpoint,
            rangoNormalizado.inicio,
            rangoNormalizado.fin,
            { reason }
        );

        if (renderRequestId !== infiniteScrollState.renderRequestId) {
            return;
        }

        if (!exito && !estadoYaDisponible) {
            infiniteScrollState.hasMore = false;
            grid.innerHTML = `
                <div class="resultados-vacio resultados-vacio--grid" data-grid-empty-error="true">
                    No pudimos cargar la disponibilidad de este rango. Intenta nuevamente en unos segundos.
                </div>
            `;
            return;
        }

        await cargarSiguienteBloqueVisible({ requestId: renderRequestId });

        setupInfiniteScrollObserver(renderRequestId);
        actualizarMensajeGridSinDisponibles();

        if (container) {
            if (Number.isFinite(restoreScrollTop) && preservarScroll) {
                container.scrollTop = restoreScrollTop;
            } else if (!preservarScroll && reason !== 'cambio-rango') {
                container.scrollTop = 0;
            }
        }
    } catch (error) {
        if (renderRequestId !== infiniteScrollState.renderRequestId) {
            return;
        }

        infiniteScrollState.hasMore = false;
        grid.innerHTML = `
            <div class="resultados-vacio resultados-vacio--grid" data-grid-empty-error="true">
                No pudimos preparar este rango en este momento.
            </div>
        `;
        console.error('❌ Error renderizando rango:', error);
    } finally {
        if (renderRequestId === infiniteScrollState.renderRequestId) {
            mostrarEstadoCargaGrid(false);
            actualizarMensajeGridSinDisponibles();
        }
    }
}

function infiniteScrollLoadMore(opciones = {}) {
    const grid = document.getElementById('numerosGrid');
    const requestId = Number.isInteger(opciones.requestId) ? opciones.requestId : infiniteScrollState.renderRequestId;
    if (!grid || requestId !== infiniteScrollState.renderRequestId || infiniteScrollState.isLoading || !infiniteScrollState.hasMore) return false;

    infiniteScrollState.isLoading = true;
    grid.style.pointerEvents = 'none';

    const { inicio, fin } = infiniteScrollState.rangoActual;
    const mostrarSoloDisponibles = infiniteScrollState.modoDisponibles === true;
    let cursor = Number.isInteger(infiniteScrollState.cursorNumero) ? infiniteScrollState.cursorNumero : inicio;

    if (cursor > fin) {
        infiniteScrollState.hasMore = false;
        infiniteScrollState.isLoading = false;
        grid.style.pointerEvents = 'auto';
        actualizarMensajeGridSinDisponibles();
        return false;
    }

    const { soldSet, reservedSet } = obtenerEstadoLocalBoletos();
    const htmlParts = [];
    const maxRevision = mostrarSoloDisponibles
        ? Math.max(infiniteScrollState.BOLETOS_POR_CARGA * 10, 5000)
        : infiniteScrollState.BOLETOS_POR_CARGA;
    let revisados = 0;

    while (cursor <= fin && htmlParts.length < infiniteScrollState.BOLETOS_POR_CARGA && revisados < maxRevision) {
        const markup = construirMarkupBotonGrid(cursor, soldSet, reservedSet, {
            mostrarSoloDisponibles
        });

        if (markup) {
            htmlParts.push(markup);
        }

        cursor += 1;
        revisados += 1;
    }

    if (htmlParts.length > 0) {
        grid.insertAdjacentHTML('beforeend', htmlParts.join(''));
    }

    infiniteScrollState.cursorNumero = cursor;
    infiniteScrollState.boletosCargados += htmlParts.length;
    infiniteScrollState.hasMore = cursor <= fin;
    infiniteScrollState.isLoading = false;
    grid.style.pointerEvents = 'auto';

    if (filtroDisponiblesActivo && !mostrarSoloDisponibles) {
        aplicarFiltroDisponibles(true, { persistir: false });
    }

    actualizarMensajeGridSinDisponibles();
    return htmlParts.length > 0;
}

async function cargarSiguienteBloqueVisible(opciones = {}) {
    const requestId = Number.isInteger(opciones.requestId) ? opciones.requestId : infiniteScrollState.renderRequestId;
    let huboRender = infiniteScrollLoadMore({ requestId });

    while (requestId === infiniteScrollState.renderRequestId && infiniteScrollState.modoDisponibles && !huboRender && infiniteScrollState.hasMore) {
        await esperarSiguienteFrame();
        huboRender = infiniteScrollLoadMore({ requestId });
    }

    return huboRender;
}

function setupInfiniteScrollObserver(renderRequestId = infiniteScrollState.renderRequestId) {
    // Limpiar observer anterior si existe
    if (infiniteScrollState.observer) {
        infiniteScrollState.observer.disconnect();
    }
    
    const sentinel = document.getElementById('infiniteScrollSentinel');
    if (!sentinel) return;
    
    // Crear observer para detectar cuando el usuario llega al final
    infiniteScrollState.observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting && infiniteScrollState.hasMore && !infiniteScrollState.isLoading) {
                void cargarSiguienteBloqueVisible({ requestId: renderRequestId });
            }
        });
    }, {
        root: document.getElementById('numerosGrid').parentElement,
        rootMargin: '100px',  // Cargar 100px antes de llegar al final
        threshold: 0.01
    });
    
    infiniteScrollState.observer.observe(sentinel);
}

function manejarCambioRango(boton) {
    // OPTIMIZACIÓN: Usar requestAnimationFrame para agrupar cambios
    requestAnimationFrame(() => {
        // Actualizar clase activa
        document.querySelectorAll('.rango-btn').forEach(btn => {
            btn.classList.remove('active');
        });
        boton.classList.add('active');
        
        const inicio = parseInt(boton.getAttribute('data-inicio'));
        const fin = parseInt(boton.getAttribute('data-fin'));
        
        // Renderizar nuevo rango
        void renderRange(inicio, fin, {
            reason: 'cambio-rango'
        });
        
        // Scroll suave al inicio del nuevo rango
        setTimeout(() => {
            const container = document.querySelector('.boletos-container-scrolleable');
            if (container) {
                container.scrollTop = 0;
            }
        }, 50);
        
        // Batch updates - usar setTimeout para agrupar las actualizaciones de UI
        setTimeout(() => {
            // Después de renderizar, actualizar contador
            if (window.actualizarContadorCarritoGlobal) {
                window.actualizarContadorCarritoGlobal();
            }
            
            // Usar debounce para evitar re-renders innecesarios
            if (typeof actualizarResumenCompraConDebounce === 'function') {
                actualizarResumenCompraConDebounce();
            }
        }, 0);
    });
}

// ===== BÚSQUEDA DE BOLETOS =====

/**
 * Obtener boletos seleccionados - Ya se encuentra en carrito-global.js
 * Se accede como: window.obtenerBoletosSelecionados() o obtenerBoletosSelecionados()
 */

function configurarBuscadorBoletos() {
    const inputBusqueda = document.getElementById('busquedaBoleto');
    const inputBusquedaFin = document.getElementById('busquedaBoletoFin');
    const btnBuscar = document.getElementById('btnBuscarBoleto');
    const selectModo = document.getElementById('busquedaModo');
    const checkboxFiltroDisponibles = document.getElementById('filtroDisponibles');
    const toolbarAvanzada = document.getElementById('busquedaToolbarAvanzada');
    const labelPrincipal = document.getElementById('busquedaLabelPrincipal');
    const helperText = document.getElementById('busquedaHelperText');
    const wrapperPrincipal = document.getElementById('busquedaWrapperPrincipal');
    const feedbackEl = document.getElementById('busquedaFeedback');
    const resultadosDiv = document.getElementById('busquedaResultados');
    const rangoInicio = document.getElementById('rangoInicio');
    const rangoTotal = document.getElementById('rangoTotal');
    const rangoBoxes = document.getElementById('rangoBoxes');
    const instruccionRango = document.querySelector('.instruccion-rango');
    const boletosContainer = document.querySelector('.boletos-container-scrolleable');
    const numerosGrid = document.getElementById('numerosGrid');
    const busquedaGridToolbar = document.getElementById('busquedaGridToolbar');
    const busquedaLoadMoreFooter = document.getElementById('busquedaLoadMoreFooter');
    const LIMITE_RESULTADOS_BUSQUEDA = 1000;
    const MAX_RESULTADOS_BUSQUEDA_AMPLIA = 5000;

    if (!inputBusqueda || !btnBuscar) return;

    const modoMeta = {
        exacto: {
            label: 'Buscar boleto por número:',
            placeholder: 'Ej. 42',
            help: 'Escribe un número exacto para ir directo a ese boleto.'
        },
        empieza: {
            label: 'Buscar boletos que empiezan con:',
            placeholder: 'Ej. 12',
            help: 'Encuentra boletos cuyo número comienza con esos dígitos.'
        },
        termina: {
            label: 'Buscar boletos que terminan con:',
            placeholder: 'Ej. 77',
            help: 'Útil para quienes prefieren cierta terminación.'
        },
        contiene: {
            label: 'Buscar boletos que contienen:',
            placeholder: 'Ej. 25',
            help: 'Busca boletos que tengan esa secuencia en cualquier parte.'
        },
        rango: {
            label: 'Buscar boletos dentro de un rango:',
            placeholder: 'Desde',
            help: 'Define un inicio y un fin para ver boletos en ese tramo.'
        }
    };
    const estadoBusqueda = {
        requestId: 0,
        abortController: null
    };
    const estadoBusquedaGrid = {
        activa: false,
        cargandoMas: false,
        params: null,
        meta: null,
        ultimoOffset: 0,
        hayMas: false,
        totalMostrados: 0
    };

    function crearErrorBusquedaCancelada() {
        const error = new Error('Busqueda cancelada');
        error.name = 'AbortError';
        return error;
    }

    function esBusquedaCancelada(error) {
        return error?.name === 'AbortError';
    }

    function cancelarBusquedaActiva() {
        if (estadoBusqueda.abortController) {
            estadoBusqueda.abortController.abort();
            estadoBusqueda.abortController = null;
        }
    }

    function asegurarBusquedaVigente(requestId) {
        if (requestId !== estadoBusqueda.requestId) {
            throw crearErrorBusquedaCancelada();
        }
    }

    function establecerEstadoBuscando(activo) {
        if (!btnBuscar) return;
        btnBuscar.disabled = activo;
        btnBuscar.classList.toggle('is-loading', activo);
        btnBuscar.textContent = activo ? 'Buscando...' : 'Buscar';
    }

    function esperar(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function esperarSiguientePintado() {
        return new Promise((resolve) => {
            requestAnimationFrame(() => {
                requestAnimationFrame(resolve);
            });
        });
    }

    function elementoEstaVisibleEnViewport(elemento, opciones = {}) {
        if (!elemento || typeof elemento.getBoundingClientRect !== 'function') {
            return false;
        }

        const {
            topOffset = 140,
            bottomOffset = 96
        } = opciones;
        const rect = elemento.getBoundingClientRect();
        const viewportTop = topOffset;
        const viewportBottom = window.innerHeight - bottomOffset;

        return rect.top >= viewportTop && rect.bottom <= viewportBottom;
    }

    function scrollCompraSiHaceFalta(target, offset = -120, opciones = {}) {
        const elemento = typeof target === 'string'
            ? document.querySelector(target) || document.getElementById(target)
            : target;

        if (!elemento) {
            return false;
        }

        if (!opciones.forzar && elementoEstaVisibleEnViewport(elemento, opciones)) {
            return false;
        }

        return scrollSuaveCompraA(elemento, offset);
    }

    function obtenerPrimerResultadoBusquedaSimple() {
        if (!resultadosDiv) {
            return null;
        }

        return resultadosDiv.querySelector('.resultado-item, .resultados-vacio');
    }

    async function enfocarResultadoBusquedaSimple(numero) {
        await esperarSiguientePintado();

        const resultadoItem = obtenerPrimerResultadoBusquedaSimple();
        if (resultadoItem) {
            const rect = resultadoItem.getBoundingClientRect();
            const centroViewport = window.innerHeight / 2;
            const centroResultado = rect.top + (rect.height / 2);
            const distanciaAlCentro = Math.abs(centroResultado - centroViewport);

            if (distanciaAlCentro > 56) {
                const topObjetivo = window.pageYOffset + rect.top - Math.max(0, centroViewport - (rect.height / 2));
                window.scrollTo({
                    top: Math.max(0, topObjetivo),
                    behavior: 'smooth'
                });
            }
            return;
        }

        const botonEnGrid = obtenerBotonNumeroEnGrid(numero);
        if (botonEnGrid) {
            if (!elementoEstaVisibleEnViewport(botonEnGrid, {
                topOffset: 140,
                bottomOffset: 140
            })) {
                botonEnGrid.scrollIntoView({
                    behavior: 'smooth',
                    block: 'center',
                    inline: 'nearest'
                });
            }

            enfatizarNumeroSeleccionado(botonEnGrid);
            return;
        }

        scrollCompraSiHaceFalta('.busqueda-boletos-card', -110);
    }

    async function enfocarResultadosBusquedaGrid() {
        await esperarSiguientePintado();

        if (boletosContainer && boletosContainer.scrollTop > 0) {
            boletosContainer.scrollTo({
                top: 0,
                behavior: 'smooth'
            });
        }

        const objetivo = busquedaGridToolbar?.classList.contains('is-visible')
            ? busquedaGridToolbar
            : numerosGrid;

        scrollCompraSiHaceFalta(objetivo, -110);
    }

    function obtenerConfiguracionBusquedaBoletos() {
        return window.rifaplusConfig?.rifa?.busquedaBoletos || {};
    }

    function busquedaAvanzadaHabilitada() {
        if (!selectModo) return false;
        return obtenerConfiguracionBusquedaBoletos().modoAvanzado === true;
    }

    function obtenerRangoBusquedaActual() {
        const totalBoletos = Number(window.rifaplusConfig?.rifa?.totalBoletos) || 0;
        const fin = totalBoletos > 0 ? totalBoletos - 1 : 0;

        return {
            inicio: 0,
            fin: Number.isFinite(fin) && fin >= 0 ? fin : 0
        };
    }

    function actualizarRangoBusquedaEnUI() {
        const rango = obtenerRangoBusquedaActual();

        if (rangoInicio) rangoInicio.textContent = rango.inicio.toLocaleString();
        if (rangoTotal) rangoTotal.textContent = rango.fin.toLocaleString();

        if (!busquedaAvanzadaHabilitada()) {
            inputBusqueda.placeholder = modoMeta.exacto.placeholder;
        }
    }

    function limpiarFeedbackBusqueda() {
        if (!feedbackEl) return;
        feedbackEl.textContent = '';
        feedbackEl.classList.remove('is-visible', 'is-warning', 'is-info');
    }

    function mostrarFeedbackBusqueda(mensaje, tipo = 'info') {
        if (!feedbackEl) return;
        feedbackEl.textContent = mensaje;
        feedbackEl.classList.remove('is-warning', 'is-info');
        feedbackEl.classList.add('is-visible', `is-${tipo}`);
    }

    function normalizarValorNumericoEntrada(valor) {
        return String(valor || '').replace(/\D+/g, '');
    }

    function obtenerResultadosListActual() {
        return document.getElementById('resultadosList');
    }

    function asegurarMarkupResultadosLista() {
        if (!resultadosDiv) return null;

        let lista = obtenerResultadosListActual();
        if (lista) return lista;

        resultadosDiv.classList.remove('busqueda-resultados--grid');
        resultadosDiv.innerHTML = `
            <div class="resultados-header">
                <strong>Resultados encontrados:</strong>
            </div>
            <div class="resultados-list" id="resultadosList"></div>
        `;

        return obtenerResultadosListActual();
    }

    function limpiarResultadosBusqueda() {
        const lista = obtenerResultadosListActual();
        if (lista) lista.innerHTML = '';
        if (resultadosDiv) {
            resultadosDiv.style.display = 'none';
            resultadosDiv.classList.remove('busqueda-resultados--grid');
        }
    }

    function limpiarToolbarBusquedaGrid() {
        if (!busquedaGridToolbar) return;
        busquedaGridToolbar.innerHTML = '';
        busquedaGridToolbar.style.display = 'none';
        busquedaGridToolbar.classList.remove('is-visible');
    }

    function resetearEstadoBusquedaGrid() {
        estadoBusquedaGrid.activa = false;
        estadoBusquedaGrid.cargandoMas = false;
        estadoBusquedaGrid.params = null;
        estadoBusquedaGrid.meta = null;
        estadoBusquedaGrid.ultimoOffset = 0;
        estadoBusquedaGrid.hayMas = false;
        estadoBusquedaGrid.totalMostrados = 0;
    }

    function limpiarFooterBusquedaGrid() {
        if (!busquedaLoadMoreFooter) return;
        busquedaLoadMoreFooter.innerHTML = '';
        busquedaLoadMoreFooter.hidden = true;
    }

    function actualizarFooterBusquedaGrid() {
        if (!busquedaLoadMoreFooter) return;

        if (!estadoBusquedaGrid.activa || !estadoBusquedaGrid.hayMas) {
            limpiarFooterBusquedaGrid();
            return;
        }

        const totalMostrados = estadoBusquedaGrid.totalMostrados.toLocaleString();
        busquedaLoadMoreFooter.hidden = false;
        busquedaLoadMoreFooter.innerHTML = `
            <div class="busqueda-load-more-card">
                <div class="busqueda-load-more-copy">
                    <strong>Mostrando ${totalMostrados} resultados</strong>
                    <span>Hay más coincidencias disponibles. Puedes cargar el siguiente bloque sin salir de la búsqueda.</span>
                </div>
                <button type="button" class="btn btn-secondary busqueda-load-more-btn" data-busqueda-load-more ${estadoBusquedaGrid.cargandoMas ? 'disabled' : ''}>
                    ${estadoBusquedaGrid.cargandoMas ? 'Cargando...' : 'Cargar más'}
                </button>
            </div>
        `;

        const btnLoadMore = busquedaLoadMoreFooter.querySelector('[data-busqueda-load-more]');
        if (btnLoadMore) {
            btnLoadMore.addEventListener('click', cargarMasResultadosBusquedaGrid);
        }
    }

    function restaurarVistaPrincipalBoletos() {
        const rangosConfigurados = (window.rifaplusConfig?.rifa?.rangos || []).filter((rango) =>
            Number.isInteger(parseInt(rango?.inicio, 10)) &&
            Number.isInteger(parseInt(rango?.fin, 10))
        );
        const mostrarSelectorRangos = rangosConfigurados.length > 1;

        if (rangoBoxes) rangoBoxes.style.display = mostrarSelectorRangos ? 'flex' : 'none';
        if (instruccionRango) instruccionRango.style.display = mostrarSelectorRangos ? 'block' : 'none';
        if (boletosContainer) boletosContainer.style.display = '';
        limpiarToolbarBusquedaGrid();
        limpiarFooterBusquedaGrid();

        const sentinel = document.getElementById('infiniteScrollSentinel');
        if (sentinel) sentinel.style.display = '';
    }

    function activarVistaResultadosBusqueda() {
        if (rangoBoxes) rangoBoxes.style.display = 'none';
        if (instruccionRango) instruccionRango.style.display = 'none';
        if (boletosContainer) boletosContainer.style.display = '';
    }

    function mostrarToolbarBusquedaGrid(resumen, detalle = '') {
        if (!busquedaGridToolbar) return;

        busquedaGridToolbar.innerHTML = `
            <div class="busqueda-grid-toolbar-copy">
                <strong>${resumen}</strong>
                <span>${detalle}</span>
            </div>
            <button type="button" class="btn btn-secondary" data-busqueda-reset-grid>Ver boletera completa</button>
        `;
        busquedaGridToolbar.style.display = 'flex';
        busquedaGridToolbar.classList.add('is-visible');

        const btnReset = busquedaGridToolbar.querySelector('[data-busqueda-reset-grid]');
        if (btnReset) {
            btnReset.addEventListener('click', function() {
                restaurarBoleteraDespuesDeBusqueda();
            });
        }
    }

    function restaurarBoleteraDespuesDeBusqueda() {
        cancelarBusquedaActiva();
        establecerEstadoBuscando(false);
        limpiarResultadosBusqueda();
        limpiarToolbarBusquedaGrid();
        limpiarFooterBusquedaGrid();
        limpiarFeedbackBusqueda();
        resetearEstadoBusquedaGrid();

        if (inputBusqueda) inputBusqueda.value = '';
        if (inputBusquedaFin) inputBusquedaFin.value = '';

        infiniteScrollState.lastRenderTime = 0;
        restaurarVistaPrincipalBoletos();

        const botonActivo = document.querySelector('.rango-btn.active');
        if (botonActivo) {
            manejarCambioRango(botonActivo);
        } else {
            inicializarRangoDefault();
        }
    }

    function restaurarGridPrincipalSiHaceFalta() {
        const sentinel = document.getElementById('infiniteScrollSentinel');
        const gridEnModoBusqueda = (sentinel && sentinel.style.display === 'none')
            || busquedaGridToolbar?.classList.contains('is-visible');

        if (!gridEnModoBusqueda) return;

        infiniteScrollState.lastRenderTime = 0;
        restaurarBoleteraDespuesDeBusqueda();
    }

    function formatearNumeroBusqueda(numero) {
        if (window.rifaplusConfig?.formatearNumeroBoleto) {
            return window.rifaplusConfig.formatearNumeroBoleto(numero);
        }
        return String(numero).padStart(6, '0');
    }

    function construirTarjetaResultadoBusqueda(item, selectedNumbers) {
        const numero = Number(item?.numero);
        let classes = 'numero-btn';
        let disabled = false;
        let title = '';

        if (item?.estado === 'vendido') {
            classes += ' sold';
            disabled = true;
            title = 'Vendido';
        } else if (item?.estado === 'apartado') {
            classes += ' reserved';
            disabled = true;
            title = 'Apartado';
        } else if (selectedNumbers.includes(numero)) {
            classes += ' selected';
            title = 'Ya seleccionado';
        }

        return `
            <button
                class="${classes} busqueda-grid-btn"
                data-numero="${numero}"
                ${disabled ? 'disabled' : ''}
                ${title ? `title="${title}"` : ''}
            >
                ${formatearNumeroBusqueda(numero)}
            </button>
        `;
    }

    async function buscarTodosLosBoletosEnServidor(params, requestId, signal, offsetBase = 0) {
        const items = [];
        let offset = offsetBase;
        let paginas = 0;
        const MAX_PAGINAS_BUSQUEDA = 200;
        let truncado = false;
        let motivoTruncado = '';

        while (true) {
            asegurarBusquedaVigente(requestId);
            if (paginas >= MAX_PAGINAS_BUSQUEDA) {
                truncado = true;
                motivoTruncado = 'paginas';
                break;
            }

            const data = await buscarBoletosEnServidor({
                ...params,
                limite: LIMITE_RESULTADOS_BUSQUEDA,
                offset
            }, { signal });

            const batch = Array.isArray(data.items) ? data.items : [];
            if (batch.length > 0) {
                const espacioDisponible = Math.max(0, MAX_RESULTADOS_BUSQUEDA_AMPLIA - items.length);
                if (espacioDisponible > 0) {
                    items.push(...batch.slice(0, espacioDisponible));
                }

                if (batch.length > espacioDisponible) {
                    truncado = true;
                    motivoTruncado = 'limite_resultados';
                    break;
                }
            }

            if (batch.length < LIMITE_RESULTADOS_BUSQUEDA) {
                return {
                    ...data,
                    items,
                    truncado,
                    hayMas: false,
                    siguienteOffset: offsetBase + items.length
                };
            }

            offset += batch.length;
            paginas += 1;
        }

        return {
            items,
            truncado: true,
            motivoTruncado,
            hayMas: true,
            siguienteOffset: offsetBase + items.length
        };
    }

    async function renderizarBotonesBusquedaEnGrid(items, selectedNumbers, requestId, append = false) {
        if (!numerosGrid) return;

        if (!append) {
            numerosGrid.innerHTML = '';
        }
        const CHUNK_SIZE = 250;

        for (let indice = 0; indice < items.length; indice += CHUNK_SIZE) {
            asegurarBusquedaVigente(requestId);

            const segmento = items.slice(indice, indice + CHUNK_SIZE);
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = segmento.map((item) => construirTarjetaResultadoBusqueda(item, selectedNumbers)).join('');

            while (tempDiv.firstChild) {
                numerosGrid.appendChild(tempDiv.firstChild);
            }

            if (indice + CHUNK_SIZE < items.length) {
                await new Promise((resolve) => requestAnimationFrame(resolve));
            }
        }
    }

    async function renderizarResultadosBusquedaEnGrid(items, metaBusqueda = {}, requestId, opciones = {}) {
        if (!numerosGrid) return;

        const append = opciones.append === true;
        const selectedNumbers = obtenerBoletosSelecionados();
        activarVistaResultadosBusqueda();
        limpiarResultadosBusqueda();

        if (!append && infiniteScrollState.observer) {
            infiniteScrollState.observer.disconnect();
        }

        const sentinel = document.getElementById('infiniteScrollSentinel');
        if (sentinel) sentinel.style.display = 'none';

        if (!Array.isArray(items) || items.length === 0) {
            if (!append) {
                numerosGrid.innerHTML = `<div class="resultados-vacio resultados-vacio--grid">${construirMensajeSinResultados(metaBusqueda.modo, metaBusqueda.availableOnly)}</div>`;
                mostrarToolbarBusquedaGrid(
                    'Resultados de búsqueda',
                    construirMensajeSinResultados(metaBusqueda.modo, metaBusqueda.availableOnly)
                );
            }
            return;
        }

        numerosGrid.style.pointerEvents = 'none';
        numerosGrid.style.opacity = '1';
        await renderizarBotonesBusquedaEnGrid(items, selectedNumbers, requestId, append);
        asegurarBusquedaVigente(requestId);
        numerosGrid.style.pointerEvents = 'auto';

        const totalMostrados = Number(metaBusqueda.totalMostrados || items.length);
        const resumen = `${totalMostrados.toLocaleString()} boleto${totalMostrados === 1 ? '' : 's'} encontrado${totalMostrados === 1 ? '' : 's'}`;
        const detalle = metaBusqueda.textoBusqueda
            ? `Filtro "${metaBusqueda.textoBusqueda}" en modo "${metaBusqueda.labelModo || metaBusqueda.modo}".`
            : 'Resultados cargados en la boletera.';
        mostrarToolbarBusquedaGrid(resumen, detalle);
        actualizarFooterBusquedaGrid();
    }

    async function cargarMasResultadosBusquedaGrid() {
        if (!estadoBusquedaGrid.activa || estadoBusquedaGrid.cargandoMas || !estadoBusquedaGrid.hayMas) {
            return;
        }

        estadoBusquedaGrid.cargandoMas = true;
        actualizarFooterBusquedaGrid();

        const requestId = estadoBusqueda.requestId + 1;
        cancelarBusquedaActiva();
        estadoBusqueda.requestId = requestId;
        estadoBusqueda.abortController = new AbortController();

        try {
            const signal = estadoBusqueda.abortController.signal;
            const data = await buscarTodosLosBoletosEnServidor(
                estadoBusquedaGrid.params,
                requestId,
                signal,
                estadoBusquedaGrid.ultimoOffset
            );

            asegurarBusquedaVigente(requestId);
            estadoBusquedaGrid.ultimoOffset = data.siguienteOffset || estadoBusquedaGrid.ultimoOffset;
            estadoBusquedaGrid.hayMas = data.hayMas === true;
            estadoBusquedaGrid.totalMostrados += Array.isArray(data.items) ? data.items.length : 0;

            await renderizarResultadosBusqueda(data.items || [], {
                ...estadoBusquedaGrid.meta,
                totalMostrados: estadoBusquedaGrid.totalMostrados,
                requestId
            }, {
                append: true
            });

            asegurarBusquedaVigente(requestId);

            if (data.truncado) {
                mostrarFeedbackBusqueda(`Se agregaron ${Array.isArray(data.items) ? data.items.length.toLocaleString() : '0'} resultados más. Puedes seguir cargando más si lo necesitas.`, 'info');
            } else {
                limpiarFeedbackBusqueda();
            }
        } catch (error) {
            if (!esBusquedaCancelada(error)) {
                console.warn('⚠️ Error cargando más resultados de búsqueda:', error.message);
                mostrarFeedbackBusqueda('No se pudieron cargar más resultados en este momento.', 'warning');
            }
        } finally {
            if (requestId === estadoBusqueda.requestId) {
                estadoBusqueda.abortController = null;
            }
            estadoBusquedaGrid.cargandoMas = false;
            actualizarFooterBusquedaGrid();
        }
    }

    function obtenerModoBusquedaActual() {
        const modoSeleccionado = String(selectModo?.value || 'exacto').trim().toLowerCase();
        const modosValidos = new Set(['exacto', 'empieza', 'termina', 'contiene', 'rango']);
        return modosValidos.has(modoSeleccionado) ? modoSeleccionado : 'exacto';
    }

    function aplicarModoBusquedaEnUI() {
        const modoAvanzado = busquedaAvanzadaHabilitada();
        const modo = obtenerModoBusquedaActual();
        const meta = modoMeta[modo] || modoMeta.exacto;
        const esRango = modo === 'rango';

        if (toolbarAvanzada) {
            toolbarAvanzada.hidden = !modoAvanzado;
        }

        if (labelPrincipal) {
            labelPrincipal.textContent = modoAvanzado ? meta.label : modoMeta.exacto.label;
        }

        if (helperText) {
            helperText.textContent = modoAvanzado ? meta.help : modoMeta.exacto.help;
        }

        inputBusqueda.placeholder = meta.placeholder;
        if (inputBusquedaFin) {
            inputBusquedaFin.hidden = !esRango;
            inputBusquedaFin.value = esRango ? inputBusquedaFin.value : '';
        }

        if (wrapperPrincipal) {
            wrapperPrincipal.classList.toggle('busqueda-wrapper--rango', esRango);
        }

        if (!modoAvanzado && selectModo) {
            selectModo.value = 'exacto';
        }

        limpiarFeedbackBusqueda();
        limpiarResultadosBusqueda();
        restaurarVistaPrincipalBoletos();
        restaurarGridPrincipalSiHaceFalta();
    }

    async function buscarBoletosEnServidor(params, opciones = {}) {
        const endpoint = obtenerApiBaseCompra();
        const searchParams = new URLSearchParams();
        Object.entries(params).forEach(([clave, valor]) => {
            if (valor !== undefined && valor !== null && valor !== '') {
                searchParams.set(clave, String(valor));
            }
        });
        const activeSlug = currentParams.get('rifa') || currentParams.get('slug') || window.rifaplusConfig?.rifa?.slug;
        if (activeSlug && !searchParams.has('rifa')) {
            searchParams.set('rifa', activeSlug);
        }
        const url = `${endpoint}/api/public/boletos/busqueda?${searchParams.toString()}`;
        const maxIntentos = opciones.maxIntentos && Number.isInteger(opciones.maxIntentos)
            ? Math.max(1, opciones.maxIntentos)
            : 2;
        let ultimoError = null;

        for (let intento = 1; intento <= maxIntentos; intento += 1) {
            if (opciones.signal?.aborted) {
                throw crearErrorBusquedaCancelada();
            }

            try {
                const respuesta = await fetch(url, {
                    method: 'GET',
                    signal: opciones.signal,
                    headers: {
                        'Content-Type': 'application/json'
                    }
                });

                const json = await respuesta.json().catch(() => ({}));
                if (!respuesta.ok || !json?.success) {
                    const error = new Error(json?.message || `No se pudo realizar la búsqueda (${respuesta.status})`);
                    error.status = respuesta.status;
                    throw error;
                }

                return json.data || {};
            } catch (error) {
                if (esBusquedaCancelada(error)) {
                    throw error;
                }

                ultimoError = error;
                const status = Number(error?.status || 0);
                const esErrorTransitorio = status === 429 || status >= 500 || status === 0;
                const puedeReintentar = intento < maxIntentos && esErrorTransitorio;

                if (!puedeReintentar) {
                    throw error;
                }

                await esperar(250 * intento);
            }
        }

        throw ultimoError || new Error('No se pudo completar la búsqueda.');
    }

    async function buscarExactoConFallbackLocal(numero, availableOnly) {
        const selectedNumbers = obtenerBoletosSelecionados();
        let estaVendido = false;
        let estaApartado = false;

        if (numeroEnRangoActual(numero) && rifaplusEstadoRangoActual.cargado) {
            const { soldSet, reservedSet } = obtenerEstadoLocalBoletos();
            estaVendido = soldSet.has(numero);
            estaApartado = reservedSet.has(numero);
        } else {
            const estadoServidor = await verificarEstadoBoletoEnServidor(numero);
            estaVendido = estadoServidor.vendido;
            estaApartado = estadoServidor.apartado;
        }

        let estado = 'disponible';
        if (estaVendido) estado = 'vendido';
        if (estaApartado) estado = 'apartado';

        const items = availableOnly && estado !== 'disponible'
            ? []
            : [{ numero, estado, seleccionado: selectedNumbers.includes(numero) }];

        return {
            items,
            truncado: false
        };
    }

    function construirMensajeSinResultados(modo, availableOnly) {
        if (modo === 'exacto') {
            return availableOnly
                ? 'Ese boleto existe, pero ahora mismo no está disponible.'
                : 'No encontramos ese boleto dentro del universo activo.';
        }

        if (modo === 'rango') {
            return availableOnly
                ? 'No encontramos boletos disponibles dentro de ese rango.'
                : 'No encontramos boletos en ese rango.';
        }

        return availableOnly
            ? 'No hubo coincidencias disponibles con ese filtro.'
            : 'No encontramos coincidencias con esa búsqueda.';
    }

    function obtenerEstadoVisualResultado(item, selectedNumbers) {
        const numero = Number(item?.numero);
        const estadoServidor = item?.estado || 'disponible';
        const yaSeleccionado = selectedNumbers.includes(numero);

        if (estadoServidor === 'vendido') {
            return {
                numero,
                statusText: '❌ Vendido',
                statusClass: 'vendido',
                actionButton: ''
            };
        }

        if (estadoServidor === 'apartado') {
            return {
                numero,
                statusText: '⏳ Apartado',
                statusClass: 'apartado',
                actionButton: ''
            };
        }

        if (yaSeleccionado) {
            return {
                numero,
                statusText: '✔️ Ya seleccionado',
                statusClass: 'seleccionado',
                actionButton: ''
            };
        }

        return {
            numero,
            statusText: '✅ Disponible',
            statusClass: 'disponible',
            actionButton: `<button class="btn btn-lo-quiero" data-numero="${numero}">Lo quiero</button>`
        };
    }

    function renderizarResultadosBusqueda(items, metaBusqueda = {}, opciones = {}) {
        if (metaBusqueda.modo && metaBusqueda.modo !== 'exacto') {
            return renderizarResultadosBusquedaEnGrid(items, metaBusqueda, metaBusqueda.requestId, opciones);
        }

        const resultadosList = asegurarMarkupResultadosLista();
        if (!resultadosDiv || !resultadosList) return;

        restaurarVistaPrincipalBoletos();
        limpiarToolbarBusquedaGrid();
        resultadosDiv.classList.remove('busqueda-resultados--grid');

        const selectedNumbers = obtenerBoletosSelecionados();
        resultadosList.innerHTML = '';

        if (!Array.isArray(items) || items.length === 0) {
            resultadosList.innerHTML = `<div class="resultados-vacio">${construirMensajeSinResultados(metaBusqueda.modo, metaBusqueda.availableOnly)}</div>`;
            resultadosDiv.style.display = 'block';
            return;
        }

        items.forEach((item) => {
            const { numero, statusText, statusClass, actionButton } = obtenerEstadoVisualResultado(item, selectedNumbers);
            const resultadoHtml = `
                <div class="resultado-item resultado-item--${statusClass}">
                    <div class="resultado-copy">
                        <span class="resultado-numero">Boleto #${numero}</span>
                        <span class="resultado-estado">Estado: <strong class="resultado-badge resultado-badge--${statusClass}">${statusText}</strong></span>
                    </div>
                    ${actionButton}
                </div>
            `;
            resultadosList.insertAdjacentHTML('beforeend', resultadoHtml);
        });

        resultadosList.querySelectorAll('.btn-lo-quiero').forEach((btnLoQuiero) => {
            btnLoQuiero.addEventListener('click', async function() {
                const numero = parseInt(this.getAttribute('data-numero'), 10);
                const seAgrego = await agregarBoletoDirectoCarrito(numero);
                if (seAgrego) {
                    animarAgregarAlCarrito(this, numero, true);
                }
            });
        });

        resultadosDiv.style.display = 'block';
    }

    actualizarRangoBusquedaEnUI();
    aplicarModoBusquedaEnUI();

    // Ejecutar búsqueda al hacer click en botón
    btnBuscar.addEventListener('click', ejecutarBusqueda);

    // Ejecutar búsqueda al presionar Enter
    [inputBusqueda, inputBusquedaFin].forEach((input) => {
        if (!input) return;
        input.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                ejecutarBusqueda();
            }
        });
        input.addEventListener('input', function() {
            const valorNormalizado = normalizarValorNumericoEntrada(this.value);
            if (this.value !== valorNormalizado) {
                this.value = valorNormalizado;
            }
        });
    });

    inputBusqueda.addEventListener('input', function() {
        const valor = this.value.trim();
        const rango = obtenerRangoBusquedaActual();
        const modo = obtenerModoBusquedaActual();

        if (!valor) {
            limpiarFeedbackBusqueda();
            return;
        }

        const numero = parseInt(valor, 10);
        if (modo === 'exacto' && !Number.isNaN(numero) && (numero < rango.inicio || numero > rango.fin)) {
            mostrarFeedbackBusqueda(`Ese boleto no se puede buscar. El rango disponible actualmente va de ${rango.inicio.toLocaleString()} a ${rango.fin.toLocaleString()}.`, 'warning');
        } else {
            limpiarFeedbackBusqueda();
        }
    });

    if (selectModo) {
        selectModo.addEventListener('change', aplicarModoBusquedaEnUI);
    }

    async function ejecutarBusqueda() {
        const rango = obtenerRangoBusquedaActual();
        const modo = obtenerModoBusquedaActual();
        const valor = normalizarValorNumericoEntrada(inputBusqueda.value.trim());
        const valorFin = normalizarValorNumericoEntrada(inputBusquedaFin?.value?.trim() || '');
        const soloDisponibles = checkboxFiltroDisponibles?.checked === true;
        const requestId = estadoBusqueda.requestId + 1;
        const esBusquedaSimple = !busquedaAvanzadaHabilitada() || modo === 'exacto';

        if (!valor) {
            mostrarFeedbackBusqueda('Ingresa un valor para realizar la búsqueda.', 'info');
            rifaplusUtils.showFeedback('⚠️ Escribe un número o rango para buscar', 'warning');
            limpiarResultadosBusqueda();
            restaurarVistaPrincipalBoletos();
            restaurarGridPrincipalSiHaceFalta();
            return;
        }

        const params = {
            modo,
            limite: LIMITE_RESULTADOS_BUSQUEDA,
            availableOnly: soloDisponibles
        };

        if (modo === 'rango') {
            const inicio = parseInt(valor, 10);
            const fin = parseInt(valorFin, 10);

            if (!valorFin) {
                mostrarFeedbackBusqueda('Completa el número final del rango para poder buscar.', 'info');
                limpiarResultadosBusqueda();
                restaurarVistaPrincipalBoletos();
                restaurarGridPrincipalSiHaceFalta();
                return;
            }

            if (!Number.isInteger(inicio) || !Number.isInteger(fin) || inicio < rango.inicio || fin > rango.fin || inicio > fin) {
                mostrarFeedbackBusqueda(`Ingresa un rango válido entre ${rango.inicio.toLocaleString()} y ${rango.fin.toLocaleString()}.`, 'warning');
                rifaplusUtils.showFeedback('⚠️ Revisa el rango de búsqueda', 'warning');
                limpiarResultadosBusqueda();
                restaurarVistaPrincipalBoletos();
                restaurarGridPrincipalSiHaceFalta();
                return;
            }

            params.inicio = inicio;
            params.fin = fin;
        } else {
            params.q = valor;

            if (modo === 'exacto') {
                const numero = parseInt(valor, 10);
                if (!Number.isInteger(numero) || numero < rango.inicio || numero > rango.fin) {
                    mostrarFeedbackBusqueda(`Ese boleto está fuera del rango disponible. Puedes buscar del ${rango.inicio.toLocaleString()} al ${rango.fin.toLocaleString()}.`, 'warning');
                    rifaplusUtils.showFeedback(`⚠️ Ingresa un número válido entre ${rango.inicio.toLocaleString()} y ${rango.fin.toLocaleString()}`, 'warning');
                    limpiarResultadosBusqueda();
                    restaurarVistaPrincipalBoletos();
                    restaurarGridPrincipalSiHaceFalta();
                    return;
                }
            }
        }

        limpiarFeedbackBusqueda();
        cancelarBusquedaActiva();
        estadoBusqueda.requestId = requestId;
        estadoBusqueda.abortController = new AbortController();
        establecerEstadoBuscando(true);

        try {
            const signal = estadoBusqueda.abortController.signal;
            const data = modo === 'exacto'
                ? await buscarBoletosEnServidor(params, { signal })
                : await buscarTodosLosBoletosEnServidor(params, requestId, signal);
            asegurarBusquedaVigente(requestId);
            if (modo !== 'exacto') {
                estadoBusquedaGrid.activa = true;
                estadoBusquedaGrid.params = { ...params };
                estadoBusquedaGrid.meta = {
                    modo,
                    availableOnly: soloDisponibles,
                    textoBusqueda: modo === 'rango' ? `${params.inicio} - ${params.fin}` : valor,
                    labelModo: modoMeta[modo]?.label || modo
                };
                estadoBusquedaGrid.ultimoOffset = data.siguienteOffset || (Array.isArray(data.items) ? data.items.length : 0);
                estadoBusquedaGrid.hayMas = data.hayMas === true;
                estadoBusquedaGrid.totalMostrados = Array.isArray(data.items) ? data.items.length : 0;
            } else {
                resetearEstadoBusquedaGrid();
            }
            await renderizarResultadosBusqueda(data.items || [], {
                modo,
                availableOnly: soloDisponibles,
                textoBusqueda: modo === 'rango' ? `${params.inicio} - ${params.fin}` : valor,
                labelModo: modoMeta[modo]?.label || modo,
                totalMostrados: Array.isArray(data.items) ? data.items.length : 0,
                requestId
            });
            asegurarBusquedaVigente(requestId);

            if (!esBusquedaSimple) {
                await enfocarResultadosBusquedaGrid();
            } else {
                const numeroExacto = parseInt(valor, 10);
                if (Array.isArray(data.items) && data.items.length > 0 && Number.isInteger(numeroExacto)) {
                    await enfocarResultadoBusquedaSimple(numeroExacto);
                } else {
                    scrollCompraSiHaceFalta(resultadosDiv || '.busqueda-boletos-card', -110);
                }
            }

            if (modo !== 'exacto') {
                if (data.truncado) {
                    mostrarFeedbackBusqueda(`Mostrando los primeros ${data.items.length.toLocaleString()} resultados. Ajusta el filtro para afinar la búsqueda.`, 'info');
                } else {
                    limpiarFeedbackBusqueda();
                }
            } else if (Array.isArray(data.items) && data.items.length > 0) {
                if (data.truncado) {
                    mostrarFeedbackBusqueda(`Mostrando los primeros ${LIMITE_RESULTADOS_BUSQUEDA} resultados. Ajusta el filtro si quieres afinar más.`, 'info');
                } else {
                    limpiarFeedbackBusqueda();
                }
            } else {
                mostrarFeedbackBusqueda(construirMensajeSinResultados(modo, soloDisponibles), 'info');
            }
        } catch (error) {
            if (modo === 'exacto' && /ruta no encontrada|404/i.test(String(error.message || ''))) {
                try {
                    const numero = parseInt(valor, 10);
                    const dataFallback = await buscarExactoConFallbackLocal(numero, soloDisponibles);
                    renderizarResultadosBusqueda(dataFallback.items || [], {
                        modo,
                        availableOnly: soloDisponibles
                    });
                    if (Array.isArray(dataFallback.items) && dataFallback.items.length > 0 && Number.isInteger(numero)) {
                        await enfocarResultadoBusquedaSimple(numero);
                    } else {
                        scrollCompraSiHaceFalta(resultadosDiv || '.busqueda-boletos-card', -110);
                    }
                    mostrarFeedbackBusqueda('La búsqueda exacta siguió funcionando con compatibilidad temporal. Reinicia el backend para habilitar la búsqueda avanzada completa.', 'info');
                    return;
                } catch (fallbackError) {
                    console.warn('⚠️ Fallback de búsqueda exacta también falló:', fallbackError.message);
                }
            }

            if (esBusquedaCancelada(error)) {
                return;
            }

            console.warn('⚠️ Error en búsqueda de boletos:', error.message);
            mostrarFeedbackBusqueda(error.message || 'No se pudo completar la búsqueda.', 'warning');
            rifaplusUtils.showFeedback('⚠️ No se pudo realizar la búsqueda en este momento.', 'warning');
            limpiarResultadosBusqueda();
            restaurarVistaPrincipalBoletos();
            restaurarGridPrincipalSiHaceFalta();
        } finally {
            if (requestId === estadoBusqueda.requestId) {
                estadoBusqueda.abortController = null;
                establecerEstadoBuscando(false);
            }
        }
    }

    if (!configurarBuscadorBoletos._listenerRegistrado && window.rifaplusConfig?.escucharEvento) {
        window.rifaplusConfig.escucharEvento('configuracionActualizada', () => {
            actualizarRangoBusquedaEnUI();
            aplicarModoBusquedaEnUI();
        });
        configurarBuscadorBoletos._listenerRegistrado = true;
    }
}

/**
 * Agregar un boleto directamente al carrito desde búsqueda o máquina
 * Valida disponibilidad en tiempo real antes de agregar
 */
async function agregarBoletoDirectoCarrito(numero) {
    // ⭐ BLOQUEAR AGREGAR BOLETOS MIENTRAS SE CARGAN LOS ESTADOS
    if (window.rifaplusBoletosLoading) {
        rifaplusUtils.showFeedback('⏳ Por favor espera, cargando estado de los boletos...', 'warning');
        return false;
    }
    
    // Validar estado actual del boleto
    const { soldSet, reservedSet } = obtenerEstadoLocalBoletos();
    const selectedNumbers = obtenerBoletosSelecionados();

    // Validaciones previas
    if (soldSet.has(numero)) {
        rifaplusUtils.showFeedback(`❌ Boleto #${numero} está vendido`, 'error');
        return false;
    }

    if (reservedSet.has(numero)) {
        rifaplusUtils.showFeedback(`⏳ Boleto #${numero} está apartado`, 'warning');
        return false;
    }

    if (selectedNumbers.includes(numero)) {
        rifaplusUtils.showFeedback(`✔️ Boleto #${numero} ya está en tu carrito`, 'info');
        return false;
    }

    try {
        const estadoServidor = await verificarEstadoBoletoEnServidor(numero);
        if (estadoServidor.vendido) {
            rifaplusUtils.showFeedback(`❌ Boleto #${numero} está vendido`, 'error');
            return false;
        }

        if (estadoServidor.apartado) {
            rifaplusUtils.showFeedback(`⏳ Boleto #${numero} está apartado`, 'warning');
            return false;
        }
    } catch (error) {
        console.warn('⚠️ Error verificando boleto antes de agregar:', error.message);
        rifaplusUtils.showFeedback('⚠️ No se pudo validar el boleto en este momento. Intenta de nuevo.', 'warning');
        return false;
    }

    if (typeof selectedNumbersGlobal !== 'undefined') {
        selectedNumbersGlobal.add(numero);
    }

    sincronizarSeleccionCompraEnStorage();
    programarActualizacionSeleccionCompra();
    marcarNumeroComoSeleccionadoEnBusqueda(numero);
    marcarBoletoComoSeleccionadoEnGrid(numero);
    
    // Feedback de éxito
    rifaplusUtils.showFeedback(`✅ Boleto #${numero} agregado al carrito`, 'success');
    return true;
}

/* ============================================================ */
/* SECCIÓN 13: FILTRO DE BOLETOS - MOSTRAR SOLO DISPONIBLES      */
/* ============================================================ */

/**
 * aplicarFiltroDisponibles - Oculta boletos apartados y vendidos
 * @param {boolean} activo - Si el filtro está activo
 */
function aplicarFiltroDisponibles(activo, opciones = {}) {
    const { persistir = true, refrescarGridPrincipal = false, preservarScroll = false } = opciones;

    // Guardar estado del filtro en variable global (persiste al cambiar rangos)
    filtroDisponiblesActivo = activo;

    // ⭐ IMPORTANTE: Guardar estado en localStorage para persistencia entre recargas
    if (persistir) {
        localStorage.setItem('rifaplusFiltroDisponibles', JSON.stringify(activo));
        localStorage.setItem('rifaplusMostrarTodosBoletos', JSON.stringify(!activo));
    }

    // ⭐ IMPORTANTE: Sincronizar checkbox UI con estado (checked = mostrar todos)
    const checkboxFiltro = document.getElementById('filtroDisponibles');
    if (checkboxFiltro) {
        checkboxFiltro.checked = !activo;
    }

    const labelFiltro = document.getElementById('filtroDisponiblesLabel');
    const helpFiltro = document.getElementById('filtroDisponiblesHelp');
    if (labelFiltro) {
        labelFiltro.textContent = activo ? 'Solo disponibles' : 'Mostrar todos';
    }
    if (helpFiltro) {
        helpFiltro.textContent = activo
            ? 'Recomendado: muestra solo boletos que puedes elegir ahora.'
            : 'Incluye también boletos apartados y vendidos para ver el panorama completo.';
    }

    if (refrescarGridPrincipal && !estaVistaBusquedaActiva()) {
        const rangoActual = infiniteScrollState.rangoActual || obtenerRangoVisibleInicial();
        const container = document.querySelector('.boletos-container-scrolleable');
        const scrollTopActual = preservarScroll && container ? container.scrollTop : null;

        void renderRange(rangoActual.inicio, rangoActual.fin, {
            reason: 'toggle-disponibles',
            preservarScroll,
            restoreScrollTop: scrollTopActual
        });
        logCompraDebug('[compra] Filtro aplicado:', activo ? 'Solo disponibles' : 'Todos los boletos');
        return;
    }

    // OPTIMIZACIÓN: Usar requestAnimationFrame para agrupar cambios DOM
    requestAnimationFrame(() => {
        const todosLosBoletos = document.querySelectorAll('.numero-btn');

        // OPTIMIZACIÓN: Usar classList.toggle es más rápido que if/else
        if (activo) {
            // Si el filtro está activo, ocultar los vendidos (sold) y apartados (reserved)
            todosLosBoletos.forEach(boleto => {
                const debeOcultarse = boleto.classList.contains('sold') || boleto.classList.contains('reserved');
                boleto.classList.toggle('filtrado', debeOcultarse);
            });
        } else {
            // Si el filtro está inactivo, mostrar todos
            todosLosBoletos.forEach(boleto => {
                boleto.classList.remove('filtrado');
            });
        }

        actualizarMensajeGridSinDisponibles();
    });

    logCompraDebug('[compra] Filtro aplicado:', activo ? 'Solo disponibles' : 'Todos los boletos');
}

/* ============================================================ */
/* SECCIÓN 13B: ANIMACIÓN VISUAL AL AGREGAR AL CARRITO */
/* ============================================================ */

/**
 * obtenerColorSeleccionado - Obtiene dinámicamente el color de los boletos seleccionados desde CSS
 * @param {string|null} alpha - Valor de transparencia (ej: '66' para #RRGGBBAA). Si null, sin transparencia
 */
function obtenerColorSeleccionado(alpha = null) {
    try {
        let colorCSS = getComputedStyle(document.documentElement).getPropertyValue('--seleccionado').trim();
        const colorBase = colorCSS || '#0F3A7D';
        return alpha ? colorBase + alpha : colorBase;
    } catch (error) {
        console.warn('No se pudo obtener el color seleccionado, usando por defecto');
        return '#0F3A7D' + (alpha || '');
    }
}

function parsearColorCssSeguro(color) {
    const valor = String(color || '').trim();
    const hexMatch = valor.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (hexMatch) {
        let hex = hexMatch[1];
        if (hex.length === 3) {
            hex = hex.split('').map((char) => char + char).join('');
        }
        return {
            r: parseInt(hex.slice(0, 2), 16),
            g: parseInt(hex.slice(2, 4), 16),
            b: parseInt(hex.slice(4, 6), 16),
            a: 1
        };
    }

    const rgbaMatch = valor.match(/^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*([0-9.]+))?\s*\)$/i);
    if (rgbaMatch) {
        return {
            r: Math.max(0, Math.min(255, parseFloat(rgbaMatch[1]))),
            g: Math.max(0, Math.min(255, parseFloat(rgbaMatch[2]))),
            b: Math.max(0, Math.min(255, parseFloat(rgbaMatch[3]))),
            a: rgbaMatch[4] !== undefined ? Math.max(0, Math.min(1, parseFloat(rgbaMatch[4]))) : 1
        };
    }

    return { r: 39, g: 82, b: 126, a: 1 };
}

function colorRgbToCss({ r, g, b, a = 1 }) {
    const rr = Math.round(r);
    const gg = Math.round(g);
    const bb = Math.round(b);
    if (a >= 1) return `rgb(${rr}, ${gg}, ${bb})`;
    return `rgba(${rr}, ${gg}, ${bb}, ${a})`;
}

function mezclarColorCss(color, colorObjetivo, ratio = 0.5) {
    const base = parsearColorCssSeguro(color);
    const target = parsearColorCssSeguro(colorObjetivo);
    const t = Math.max(0, Math.min(1, ratio));
    return colorRgbToCss({
        r: base.r + ((target.r - base.r) * t),
        g: base.g + ((target.g - base.g) * t),
        b: base.b + ((target.b - base.b) * t),
        a: base.a + ((target.a - base.a) * t)
    });
}

function colorConAlpha(color, alpha = 1) {
    const base = parsearColorCssSeguro(color);
    return colorRgbToCss({ ...base, a: Math.max(0, Math.min(1, alpha)) });
}

function configurarColoresAnimacionCarrito(colorBase) {
    const root = document.documentElement;
    const colorPrincipal = colorBase || obtenerColorSeleccionado();
    root.style.setProperty('--cart-confirm-color', colorPrincipal);
    root.style.setProperty('--cart-confirm-color-dark', mezclarColorCss(colorPrincipal, 'rgb(8, 20, 32)', 0.22));
    root.style.setProperty('--cart-confirm-shadow', colorConAlpha(colorPrincipal, 0.48));
}

const selectionEffectControllers = new WeakMap();

function enfatizarNumeroSeleccionado(boton) {
    if (!boton || boton.nodeType !== 1) {
        return;
    }

    const previous = selectionEffectControllers.get(boton);
    if (previous) {
        if (previous.rafStart) {
            cancelAnimationFrame(previous.rafStart);
        }
        if (previous.rafCommit) {
            cancelAnimationFrame(previous.rafCommit);
        }
        if (previous.timeoutId) {
            clearTimeout(previous.timeoutId);
        }
        if (previous.onAnimationEnd) {
            boton.removeEventListener('animationend', previous.onAnimationEnd);
        }
    }

    const cleanup = () => {
        const current = selectionEffectControllers.get(boton);
        if (!current) {
            return;
        }

        boton.classList.remove('selection-emphasis');
        boton.removeEventListener('animationend', current.onAnimationEnd);
        selectionEffectControllers.delete(boton);
    };

    boton.classList.remove('selection-emphasis');

    const onAnimationEnd = (event) => {
        if (event.target !== boton || event.animationName !== 'selectedNumberPop') {
            return;
        }
        cleanup();
    };

    const controller = {
        rafStart: 0,
        rafCommit: 0,
        timeoutId: 0,
        onAnimationEnd
    };

    selectionEffectControllers.set(boton, controller);
    boton.addEventListener('animationend', onAnimationEnd);

    controller.rafStart = requestAnimationFrame(() => {
        controller.rafCommit = requestAnimationFrame(() => {
            if (!boton.isConnected) {
                cleanup();
                return;
            }

            boton.classList.add('selection-emphasis');
            controller.timeoutId = window.setTimeout(cleanup, 480);
        });
    });
}

function crearEstallidoCarrito(carritoNav, colorSeleccionado) {
    if (!carritoNav) {
        return;
    }

    try {
        const burst = document.createElement('div');
        burst.className = 'carrito-arrival-burst';
        burst.style.borderColor = colorSeleccionado;
        burst.style.boxShadow = `
            0 0 0 6px ${colorConAlpha(colorSeleccionado, 0.16)},
            0 0 22px ${colorConAlpha(colorSeleccionado, 0.42)}
        `;
        carritoNav.appendChild(burst);
        setTimeout(() => burst.remove(), 620);
    } catch (error) {
        console.warn('No se pudo crear estallido en carrito:', error.message);
    }
}



/**
 * animarAgregarAlCarrito - Crea animación completa al agregar boleto
 * Parámetros:
 * - botonElemento: elemento del botón (puede ser null para grid sin botón)
 * - numeroDelBoleto: número del boleto añadido
 * - conAnimacionBoton: si es true, anima el botón; si es false, solo anima carrito y volado
 */
function animarAgregarAlCarrito(botonElemento = null, numeroDelBoleto = 0, conAnimacionBoton = false) {
    try {
        const colorSeleccionado = obtenerColorSeleccionado();
        configurarColoresAnimacionCarrito(colorSeleccionado);
        const isMobile = window.matchMedia('(max-width: 768px)').matches;
        
        // 1️⃣ ANIMACIÓN DEL BOTÓN (opcional): Mostrar confirmación visual
        if (botonElemento && conAnimacionBoton) {
            botonElemento.classList.add('being-added');
            const textoOriginal = botonElemento.textContent;
            botonElemento.textContent = '✅ ¡Agregado!';
            botonElemento.style.backgroundColor = colorSeleccionado;
            botonElemento.style.color = 'white';
            enfatizarNumeroSeleccionado(botonElemento);
            
            setTimeout(() => {
                botonElemento.classList.remove('being-added');
                botonElemento.style.backgroundColor = '';
                botonElemento.style.color = '';
                botonElemento.textContent = '✔️ Seleccionado';
            }, 600);
        }
        
        // 2️⃣ ANIMACIÓN DEL CARRITO: Pulso visual
        const carritoNav = document.getElementById('carritoNav');
        if (carritoNav) {
            carritoNav.classList.add('cart-pulse');
            const originalColor = carritoNav.style.color;
            carritoNav.style.color = colorSeleccionado;
            carritoNav.style.transform = isMobile ? 'scale(1.18)' : 'scale(1.34)';
            
            setTimeout(() => {
                carritoNav.classList.remove('cart-pulse');
                carritoNav.style.color = originalColor;
                carritoNav.style.transform = '';
            }, isMobile ? 520 : 720);
            
            // 3️⃣ EFECTO VOLADO: Animar boleto volando al carrito
            crearAnimacionVolado(botonElemento, numeroDelBoleto);
            setTimeout(() => {
                crearEstallidoCarrito(carritoNav, colorSeleccionado);
            }, isMobile ? 280 : 420);
        }
    } catch (error) {
        console.error('Error al animar agregar al carrito:', error);
    }
}

/**
 * crearEfectoVoladoProfesional - Crea un efecto volador profesional y llamativo
 * MEJORADO para móvil: Maneja correctamente scroll y viewport
 * Soporta: grid, buscador, máquina de suerte
 */
function crearEfectoVoladoProfesional(origenElement, numeroDelBoleto, origen = 'grid') {
    try {
        const carritoNav = document.getElementById('carritoNav');
        if (!carritoNav) {
            return;
        }
        
        const colorSeleccionado = obtenerColorSeleccionado();
        const colorSeleccionadoClaro = mezclarColorCss(colorSeleccionado, 'rgb(255, 255, 255)', 0.28);
        const isMobile = window.matchMedia('(max-width: 768px)').matches;
        const isTouch = window.matchMedia('(pointer: coarse)').matches;
        const lowPowerMode = isMobile || isTouch;
        
        // 📍 Obtener posiciones correctas (ROBUSTO)
        let origenRect = null;
        let origenValido = false;
        
        if (origenElement && typeof origenElement.getBoundingClientRect === 'function') {
            try {
                origenRect = origenElement.getBoundingClientRect();
                // Validar que el rect tiene valores razonables
                if (origenRect.width > 0 || origenRect.height > 0 || 
                    (origenRect.top >= 0 && origenRect.left >= 0)) {
                    origenValido = true;
                }
            } catch (e) {
                console.warn('Error al obtener rect del origen:', e);
            }
        }
        
        // Si origen no es válido, usar fallback inteligente
        if (!origenValido) {
            const numsGrid = document.getElementById('numerosGrid');
            const numsSuerte = document.getElementById('numerosSuerte');
            
            // Preferir máquina de suerte si está visible
            if (numsSuerte && numsSuerte.offsetParent !== null) {
                try {
                    origenRect = numsSuerte.getBoundingClientRect();
                    origenValido = true;
                } catch (e) {
                    console.warn('Error obteniendo rect máquina:', e);
                }
            }
            // Luego intentar grid
            else if (numsGrid && numsGrid.offsetParent !== null) {
                try {
                    origenRect = numsGrid.getBoundingClientRect();
                    origenValido = true;
                } catch (e) {
                    console.warn('Error obteniendo rect grid:', e);
                }
            }
        }
        
        // Si aún no tenemos rect válido, crear uno desde viewport center
        if (!origenValido) {
            origenRect = {
                left: window.innerWidth / 2,
                top: window.innerHeight / 2,
                width: 0,
                height: 0,
                bottom: window.innerHeight / 2,
                right: window.innerWidth / 2
            };
        }
        
        // Obtener posición del carrito
        let carritoRect = null;
        try {
            carritoRect = carritoNav.getBoundingClientRect();
            // Validar que carrito tiene posición válida
            if (!carritoRect || carritoRect.width === 0) {
                throw new Error('Carrito rect inválido');
            }
        } catch (e) {
            console.warn('Error al obtener rect carrito:', e);
            return;
        }
        
        // 🎯 Calcular punto de inicio (MÁS ROBUSTO)
        let startX = window.innerWidth / 2;
        let startY = window.innerHeight / 2;
        
        if (origenRect) {
            startX = origenRect.left + origenRect.width / 2;
            startY = origenRect.top + origenRect.height / 2;
            
            // Validación de cordura: si está MUY fuera de pantalla, ajustar
            const isOutOfView = startY < -200 || startY > window.innerHeight + 200 || 
                                startX < -200 || startX > window.innerWidth + 200;
            
            if (isOutOfView) {
                startY = Math.max(50, Math.min(startY, window.innerHeight - 50));
                startX = Math.max(50, Math.min(startX, window.innerWidth - 50));
            }
        }
        
        // 🎨 Crear elemento principal del boleto volador
        const mainTicket = document.createElement('div');
        mainTicket.className = 'ticket-fly-animation';
        
        mainTicket.style.cssText = `
            position: fixed;
            left: ${startX}px;
            top: ${startY}px;
            width: ${lowPowerMode ? 50 : 62}px;
            height: ${lowPowerMode ? 50 : 62}px;
            z-index: 9998;
            pointer-events: none;
            will-change: transform, opacity;
            opacity: 1;
            contain: layout style paint;
            transform: translateZ(0);
            filter: drop-shadow(0 12px 24px ${colorConAlpha(colorSeleccionado, lowPowerMode ? 0.3 : 0.42)});
        `;

        const trail = document.createElement('div');
        trail.className = 'ticket-fly-animation__trail';
        trail.style.cssText = `
            position: absolute;
            left: 50%;
            top: 50%;
            width: ${lowPowerMode ? 84 : 120}px;
            height: ${lowPowerMode ? 12 : 16}px;
            transform: translate(-72%, -50%);
            border-radius: 999px;
            background: linear-gradient(90deg, ${colorConAlpha(colorSeleccionado, 0)} 0%, ${colorConAlpha(colorSeleccionado, lowPowerMode ? 0.18 : 0.3)} 42%, ${colorConAlpha(colorSeleccionado, lowPowerMode ? 0.42 : 0.62)} 100%);
            filter: blur(${lowPowerMode ? 4 : 5}px);
            opacity: ${lowPowerMode ? 0.78 : 0.96};
        `;
        mainTicket.appendChild(trail);
        
        // 🎫 Icono del boleto con efecto de destello (MEJORADO)
        const ticketIcon = document.createElement('div');
        ticketIcon.className = 'ticket-fly-animation__icon';
        ticketIcon.style.cssText = `
            width: 100%;
            height: 100%;
            background: linear-gradient(135deg, ${colorSeleccionado}, ${colorSeleccionadoClaro});
            border-radius: 12px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: ${lowPowerMode ? 24 : 30}px;
            font-weight: bold;
            box-shadow: ${lowPowerMode
                ? `0 0 14px ${colorConAlpha(colorSeleccionado, 0.45)}, inset 0 1px 0 rgba(255,255,255,0.35)`
                : `0 0 30px ${colorConAlpha(colorSeleccionado, 0.9)}, inset 0 2px 0 rgba(255,255,255,0.5), 0 0 0 2px ${colorSeleccionado}`};
            transform: rotate(-15deg);
            transition: transform linear;
        `;
        ticketIcon.textContent = '🎫';
        mainTicket.appendChild(ticketIcon);

        if (numeroDelBoleto) {
            const ticketLabel = document.createElement('div');
            ticketLabel.className = 'ticket-fly-animation__label';
            ticketLabel.style.cssText = `
                position: absolute;
                left: 50%;
                top: -16px;
                transform: translateX(-50%);
                padding: 4px 8px;
                border-radius: 999px;
                background: rgba(12, 15, 28, 0.82);
                color: #ffffff;
                font-size: ${lowPowerMode ? 10 : 11}px;
                font-weight: 800;
                letter-spacing: 0.04em;
                white-space: nowrap;
                box-shadow: 0 8px 18px rgba(0, 0, 0, 0.22);
            `;
            ticketLabel.textContent = `#${numeroDelBoleto}`;
            mainTicket.appendChild(ticketLabel);
        }
        
        // En móvil reducimos partículas para mejorar fps sin perder el efecto
        const particleCount = lowPowerMode ? 6 : Math.min(14, Math.max(8, Math.floor(window.innerWidth / 120)));
        for (let i = 0; i < particleCount; i++) {
            const particle = document.createElement('div');
            particle.className = 'ticket-fly-animation__particle';
            const angle = (i / particleCount) * Math.PI * 2;
            const distance = lowPowerMode ? 32 : 52;
            const offsetX = Math.cos(angle) * distance;
            const offsetY = Math.sin(angle) * distance;
            
            particle.style.cssText = `
                position: absolute;
                width: ${lowPowerMode ? 8 : 12}px;
                height: ${lowPowerMode ? 8 : 12}px;
                background: ${colorSeleccionado};
                border-radius: 50%;
                left: 50%;
                top: 50%;
                transform: translate(calc(-50% + ${offsetX}px), calc(-50% + ${offsetY}px));
                opacity: ${lowPowerMode ? 0.82 : 1};
                box-shadow: ${lowPowerMode
                    ? `0 0 10px ${colorConAlpha(colorSeleccionado, 0.62)}`
                    : `0 0 18px ${colorConAlpha(colorSeleccionado, 1)}, 0 0 34px ${colorConAlpha(colorSeleccionado, 0.64)}`};
            `;
            mainTicket.appendChild(particle);
        }
        
        // Agregar al DOM
        document.body.appendChild(mainTicket);
        
        // 🚀 Calcular trayectoria hacia carrito (ROBUSTO)
        const deltaX = carritoRect.left - startX;
        const deltaY = carritoRect.top - startY;
        const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
        
        // Duración adaptiva pero SIEMPRE VISIBLE
        let baseDuration = lowPowerMode ? 380 : 800;
        if (origen === 'suerte') baseDuration = lowPowerMode ? 440 : 1100;
        if (origen === 'fallback') baseDuration = lowPowerMode ? 420 : 950;
        
        const duration = lowPowerMode
            ? Math.max(320, Math.min(560, baseDuration + distance * 0.08))
            : Math.max(720, Math.min(1400, baseDuration + distance * 0.18));
        
        // ✨ Crear animación suave y CONFIABLE
        requestAnimationFrame(() => {
            mainTicket.style.transition = `transform ${duration}ms cubic-bezier(0.16, 1, 0.3, 1), opacity ${duration}ms ease-out`;
            mainTicket.style.transform = `translate(${deltaX}px, ${deltaY}px) scale(${lowPowerMode ? 0.22 : 0.12}) rotate(${lowPowerMode ? 340 : 760}deg)`;
            mainTicket.style.opacity = '0';

            trail.style.transition = `transform ${duration}ms ease-out, opacity ${duration}ms ease-out`;
            trail.style.transform = `translate(-110%, -50%) scaleX(${lowPowerMode ? 1.25 : 1.55})`;
            trail.style.opacity = '0';
            
            // Animar partículas de forma más ligera
            const particles = mainTicket.querySelectorAll('.ticket-fly-animation__particle');
            particles.forEach((p, i) => {
                p.style.transition = `transform ${duration}ms ease-out, opacity ${duration}ms ease-out`;
                p.style.opacity = '0';
                const angle = (i / particles.length) * Math.PI * 2;
                const finalDistance = lowPowerMode
                    ? (Math.random() * 70 + 70)
                    : (Math.random() * 220 + 140);
                p.style.transform = `translate(calc(-50% + ${Math.cos(angle) * finalDistance}px), calc(-50% + ${Math.sin(angle) * finalDistance}px)) scale(0)`;
            });
        });
        
        // Limpiar elemento después de TODA la animación
        const cleanupTimeout = setTimeout(() => {
            try {
                if (mainTicket && mainTicket.parentNode) {
                    mainTicket.remove();
                }
            } catch (e) {
                console.warn('Error al limpiar elemento:', e);
            }
        }, duration + 300);
        
        // Guardar timeout para poder limpiarlo si es necesario
        mainTicket.cleanupTimeout = cleanupTimeout;
        
    } catch (error) {
        console.error('❌ Error en crearEfectoVoladoProfesional:', error);
    }
}

/**
 * crearAnimacionVolado - ULTRA-ROBUSTO para cualquier dispositivo
 * Busca el origen del boleto en grid/máquina y crea efecto volador hacia carrito
 * Garantiza animación incluso si el elemento origen no se encuentra
 */
function crearAnimacionVolado(botonElemento = null, numeroDelBoleto = 0) {
    try {
        let origenElement = botonElemento;
        let origen = 'unknown';
        
        // 1️⃣ Si pasamos un botón, usarlo directamente
        if (origenElement && origenElement.nodeType === 1) {
            origen = 'boton';
            crearEfectoVoladoProfesional(origenElement, numeroDelBoleto, origen);
            return;
        }
        
        // 2️⃣ Buscar en grid de números (prioritario)
        const numerosGrid = document.getElementById('numerosGrid');
        if (numerosGrid && numerosGrid.offsetParent !== null) {
            try {
                origenElement = numerosGrid.querySelector(`[data-numero="${numeroDelBoleto}"]`);
                if (origenElement && origenElement.nodeType === 1) {
                    origen = 'grid';
                    crearEfectoVoladoProfesional(origenElement, numeroDelBoleto, origen);
                    return;
                }
            } catch (e) {
                console.warn('Error buscando en grid:', e);
            }
        }
        
        // 3️⃣ Buscar en máquina de suerte
        const numerosSuerte = document.getElementById('numerosSuerte');
        if (numerosSuerte && numerosSuerte.offsetParent !== null) {
            try {
                // Primero buscar el número específico
                origenElement = numerosSuerte.querySelector(`[data-numero="${numeroDelBoleto}"]`);
                if (origenElement && origenElement.nodeType === 1) {
                    origen = 'suerte-elemento';
                    crearEfectoVoladoProfesional(origenElement, numeroDelBoleto, origen);
                    return;
                }
                
                // Si no encontramos el número, usar toda la máquina como origen
                origenElement = numerosSuerte;
                origen = 'suerte';
                crearEfectoVoladoProfesional(origenElement, numeroDelBoleto, origen);
                return;
            } catch (e) {
                console.warn('Error buscando en máquina:', e);
            }
        }
        
        // 4️⃣ Si grid no está visible, crear fallback desde su posición anterior
        if (numerosGrid) {
            try {
                const gridRect = numerosGrid.getBoundingClientRect();
                origenElement = document.createElement('div');
                origenElement.style.cssText = `position: fixed; left: ${gridRect.left + gridRect.width / 2}px; top: ${gridRect.top + gridRect.height / 2}px; width: 0; height: 0;`;
                document.body.appendChild(origenElement);
                crearEfectoVoladoProfesional(origenElement, numeroDelBoleto, 'fallback-grid');
                setTimeout(() => {
                    if (origenElement && origenElement.parentNode) {
                        origenElement.remove();
                    }
                }, 2300);
                return;
            } catch (e) {
                console.warn('Error creando fallback grid:', e);
            }
        }
        
        // 5️⃣ Último recurso: viewport center (NUNCA falla)
        origenElement = document.createElement('div');
        origenElement.style.cssText = `position: fixed; left: ${window.innerWidth / 2}px; top: ${window.innerHeight / 2}px; width: 0; height: 0;`;
        document.body.appendChild(origenElement);
        crearEfectoVoladoProfesional(origenElement, numeroDelBoleto, 'fallback-viewport');
        setTimeout(() => {
            if (origenElement && origenElement.parentNode) {
                origenElement.remove();
            }
        }, 2300);
        
    } catch (error) {
        console.error('❌ Error CRÍTICO en crearAnimacionVolado:', error);
        // Incluso si todo falla, intentar fallback final
        try {
            const fallbackEl = document.createElement('div');
            fallbackEl.style.cssText = `position: fixed; left: ${window.innerWidth / 2}px; top: ${window.innerHeight / 2}px; width: 0; height: 0;`;
            document.body.appendChild(fallbackEl);
            crearEfectoVoladoProfesional(fallbackEl, numeroDelBoleto, 'emergency-fallback');
            setTimeout(() => fallbackEl.remove(), 2300);
        } catch (e) {
            console.error('❌ Fallback de emergencia también falló:', e);
        }
    }
}


/* ============================================================ */
/* SECCIÓN 14: CARRITO EXPANDIBLE - GESTIONADO POR carrito-global.js */
/* ============================================================ */

/**
 * Bloquea/Desbloquea los botones "Lo quiero" basado en estado de carga
 */
function controlarEstadoBotonesLoQuiero() {
    const botones = document.querySelectorAll('.btn-lo-quiero');
    const estaLoading = window.rifaplusBoletosLoading;
    
    botones.forEach(btn => {
        if (estaLoading) {
            btn.disabled = true;
            btn.style.opacity = '0.6';
            btn.style.cursor = 'not-allowed';
            btn.title = 'Esperando carga de estados...';
        } else {
            btn.disabled = false;
            btn.style.opacity = '1';
            btn.style.cursor = 'pointer';
            btn.title = 'Agregar boleto al carrito';
        }
    });
}

// El carrito es inicializado y gestionado completamente por carrito-global.js
// que se carga ANTES de compra.js en el HEAD de compra.html

/**
 * Procesa datos de boletos (sold/reserved) y actualiza vista
 * Marca ventana.rifaplusBoletosDatosActualizados para sincronizar
 */
function procesarBoletosEnBackground(sold, reserved) {
    try {
        // Marcar datos como OBSOLETOS antes de actualizar
        window.rifaplusBoletosDatosActualizados = false;
        
        window.rifaplusSoldNumbers = sold.map(Number);
        window.rifaplusReservedNumbers = reserved.map(Number);
        // Actualizar grid y availability note sincronizados
        actualizarEstadoBoletosVisibles();
        if (typeof actualizarNotaDisponibilidad === 'function') {
            actualizarNotaDisponibilidad();
        }
        
        // Marcar datos como FRESCOS
        window.rifaplusBoletosDatosActualizados = true;
    } catch (error) {
        console.error('❌ Error procesando boletos:', error);
        // Último fallback: arrays vacíos
        window.rifaplusSoldNumbers = [];
        window.rifaplusReservedNumbers = [];
        window.rifaplusBoletosDatosActualizados = true;
    }
}

// Exponer funciones globalmente para que otras páginas/módulos puedan llamarlas
window.cargarBoletosPublicos = cargarBoletosPublicos;
window.actualizarResumenCompra = actualizarResumenCompra;
window.controlarEstadoBotonesLoQuiero = controlarEstadoBotonesLoQuiero;
