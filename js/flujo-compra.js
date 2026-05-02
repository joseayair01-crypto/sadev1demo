/**
 * ============================================================
 * ARCHIVO: js/flujo-compra.js
 * DESCRIPCIÓN: Orquesta el flujo completo de compra
 * Formulario → Selección de cuenta → Orden Formal
 * ÚLTIMA ACTUALIZACIÓN: 2025
 * ============================================================
 */

/* ============================================================ */
/* FUNCIONES DEFENSIVAS DE ALMACENAMIENTO                      */
/* ============================================================ */

/**
 * 🛡️ FUNCIÓN DEFENSIVA: Obtener clave con scope de rifa
 */
function obtenerClaveScopedFlujo(key) {
    if (typeof window.rifaplusConfig?.construirClaveLocal === 'function') {
        return window.rifaplusConfig.construirClaveLocal(key);
    }
    // Fallback manual si no está el cargador
    const slug = window.rifaplusConfig?.obtenerSlugRifaActual?.() || 'global';
    return `rifaplus:${slug}:${key}`;
}

/**
 * 🛡️ FUNCIÓN DEFENSIVA: Guardar en storage de forma segura
 */
function setItemSafeFlujo(key, value) {
    const scopedKey = obtenerClaveScopedFlujo(key);
    try {
        if (typeof window.safeTrySetItem === 'function') {
            return window.safeTrySetItem(scopedKey, value);
        } else {
            localStorage.setItem(scopedKey, value);
            return true;
        }
    } catch (error) {
        console.warn(`⚠️  [FLUJO] Error guardando '${scopedKey}':`, error.message);
        if (!window.StorageMemoryFallback) window.StorageMemoryFallback = {};
        window.StorageMemoryFallback[scopedKey] = value;
        return false;
    }
}

/**
 * 🛡️ FUNCIÓN DEFENSIVA: Leer desde storage de forma segura
 */
function getItemSafeFlujo(key) {
    const scopedKey = obtenerClaveScopedFlujo(key);
    try {
        if (typeof window.safeTryGetItem === 'function') {
            return window.safeTryGetItem(scopedKey);
        } else {
            return localStorage.getItem(scopedKey);
        }
    } catch (error) {
        console.warn(`⚠️  [FLUJO] Error leyendo '${scopedKey}':`, error.message);
        if (window.StorageMemoryFallback && window.StorageMemoryFallback[scopedKey]) {
            return window.StorageMemoryFallback[scopedKey];
        }
        return null;
    }
}

/**
 * 🛡️ FUNCIÓN DEFENSIVA: Remover del storage
 */
function removeItemSafeFlujo(key) {
    const scopedKey = obtenerClaveScopedFlujo(key);
    try {
        if (typeof window.safeTryRemoveItem === 'function') {
            return window.safeTryRemoveItem(scopedKey);
        } else {
            localStorage.removeItem(scopedKey);
            return true;
        }
    } catch (error) {
        console.warn(`⚠️  [FLUJO] Error removiendo '${scopedKey}':`, error.message);
        if (window.StorageMemoryFallback) delete window.StorageMemoryFallback[scopedKey];
        return false;
    }
}

/* ============================================================ */
/* SECCIÓN 1: CONFIGURACIÓN GLOBAL Y VARIABLES                 */
// Todas las funciones de cálculo de precios están delegadas
// al módulo centralizado calculo-precios.js
// obtenerPrecioDinamico() y calcularTotales() se usan desde allí

/* ============================================================ */

var clienteCheckout = null;
let cuentasDisponiblesPromiseFlujo = null;

function desenfocarElementoActivoFlujo() {
    if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
    }
}

function obtenerAccountIdSeguroFlujo(cuenta, idx) {
    return String(
        cuenta?.id ?? cuenta?.accountNumber ?? `${cuenta?.nombreBanco || 'cuenta'}_${idx}`
    );
}

function liberarTransicionModalCuentas(modal) {
    if (!modal) {
        return;
    }

    delete modal.dataset.transitioning;
    modal.classList.remove('modal-seleccion-cuenta--busy');

    modal.querySelectorAll('input[type="radio"][name="cuentaPago"]').forEach((radio) => {
        radio.disabled = false;
    });
}

function prepararModalSeleccionCuenta(modal, transferenciasContainer, efectivoContainer) {
    transferenciasContainer.innerHTML = '<p class="payment-empty-state">Cargando cuentas de transferencia...</p>';
    efectivoContainer.innerHTML = '<p class="payment-empty-state">Cargando opciones de pago...</p>';
    modal.classList.add('show');
    window.rifaplusModalScrollLock?.sync?.();
    modal.scrollTop = 0;

    const closeBtn = document.getElementById('closeModalSeleccionCuenta');
    if (closeBtn) {
        closeBtn.onclick = cerrarModalSeleccionCuenta;
    }

    const modalBody = modal.querySelector('.modal-body-cuentas');
    const modalCard = modal.querySelector('.modal-seleccion-cuentas');

    if (modalBody) {
        modalBody.scrollTop = 0;
    }

    if (modalCard) {
        modalCard.scrollTop = 0;
    }

    window.requestAnimationFrame(() => {
        if (modalBody) modalBody.scrollTop = 0;
        if (modalCard) modalCard.scrollTop = 0;
    });
}

function obtenerCuentasLocalesFlujo() {
    return Array.isArray(window.rifaplusConfig?.bankAccounts)
        ? window.rifaplusConfig.bankAccounts.filter(Boolean)
        : [];
}

function precargarCuentasDisponiblesFlujo() {
    if (cuentasDisponiblesPromiseFlujo) {
        return cuentasDisponiblesPromiseFlujo;
    }

    cuentasDisponiblesPromiseFlujo = obtenerCuentasDisponiblesFlujo()
        .catch((error) => {
            console.debug('[flujo-compra] No se pudo precargar cuentas:', error?.message || error);
            return obtenerCuentasLocalesFlujo();
        })
        .finally(() => {
            cuentasDisponiblesPromiseFlujo = null;
        });

    return cuentasDisponiblesPromiseFlujo;
}

async function obtenerCuentasDisponiblesFlujo() {
    let cuentas = [];

    try {
        const configPublica = typeof window.rifaplusConfig?.obtenerConfigPublicaCompartida === 'function'
            ? await window.rifaplusConfig.obtenerConfigPublicaCompartida()
            : null;

        if (Array.isArray(configPublica?.cuentas) && configPublica.cuentas.length > 0) {
            cuentas = configPublica.cuentas;

            if (window.rifaplusConfig) {
                window.rifaplusConfig.tecnica = window.rifaplusConfig.tecnica || {};
                window.rifaplusConfig.tecnica.bankAccounts = cuentas;
                window.rifaplusConfig.bankAccounts = cuentas;
            }
        }
    } catch (err) {
        console.debug('[flujo-compra] No se cargaron cuentas del servidor:', err.message);
    }

    if (cuentas.length > 0) {
        return cuentas;
    }

    return Array.isArray(window.rifaplusConfig?.bankAccounts)
        ? window.rifaplusConfig.bankAccounts
        : [];
}

function construirCuentaHtmlFlujo(cuentas, paymentType, idPrefix, description) {
    return cuentas
        .filter((cuenta) => cuenta.paymentType === paymentType)
        .map((cuenta, idx) => {
            const id = `${idPrefix}${idx}`;
            const banco = cuenta.nombreBanco || (paymentType === 'efectivo' ? 'Tienda' : 'Banco');
            const accountId = obtenerAccountIdSeguroFlujo(cuenta, idx);

            return `
                <div class="stack-item">
                    <input type="radio" id="${id}" name="cuentaPago" value="${accountId}" data-account-id="${accountId}" data-payment-type="${paymentType}" class="cuenta-radio">
                    <label for="${id}" class="stack-label">
                        <div class="stack-content">
                            <span class="stack-bank">${banco}</span>
                            <span class="stack-description">${description}</span>
                        </div>
                        <span class="stack-action">Seleccionar</span>
                    </label>
                </div>
            `;
        })
        .join('');
}

function renderizarListasCuentasFlujo(cuentas, transferenciasContainer, efectivoContainer) {
    const htmlTransferencias = construirCuentaHtmlFlujo(
        cuentas,
        'transferencia',
        'cuenta_',
        'Haz tu transferencia a esta cuenta.'
    );

    const htmlEfectivo = construirCuentaHtmlFlujo(
        cuentas,
        'efectivo',
        'cuenta_efe_',
        'Usa esta opción para pagar en efectivo.'
    );

    transferenciasContainer.innerHTML = htmlTransferencias || '<p class="payment-empty-state">No hay transferencias disponibles en este momento.</p>';
    efectivoContainer.innerHTML = htmlEfectivo || '<p class="payment-empty-state">No hay opciones de efectivo disponibles en este momento.</p>';
}

async function obtenerOrdenIdOficialFlujo(clienteGuardado = {}) {
    const config = window.rifaplusConfig;
    const apiBase = config?.backend?.apiBase;
    const esOrdenIdOficial = typeof config?.esOrdenIdOficial === 'function'
        ? config.esOrdenIdOficial.bind(config)
        : (valor => /^[A-Z0-9]+-[A-Z]{2}\d{3}$/.test(String(valor || '').trim().toUpperCase()));

    let clienteId = String(config?.cliente?.id || '').trim();
    if ((!clienteId || !config?.cliente?.prefijoOrden) && typeof config?.sincronizarConfigDelBackend === 'function') {
        try {
            await config.sincronizarConfigDelBackend({ force: true });
            clienteId = String(config?.cliente?.id || '').trim();
        } catch (error) {
            console.warn('⚠️ [flujo-compra] No se pudo resincronizar config antes de generar orden:', error?.message || error);
        }
    }

    if (!apiBase) {
        return '';
    }

    if (typeof window.generarIdOrden === 'function') {
        try {
            const ordenIdGenerado = String(await window.generarIdOrden()).trim().toUpperCase();
            if (esOrdenIdOficial(ordenIdGenerado)) {
                return ordenIdGenerado;
            }
            console.warn('⚠️ [flujo-compra] window.generarIdOrden devolvió un valor no reutilizable:', ordenIdGenerado);
        } catch (error) {
            console.warn('⚠️ [flujo-compra] window.generarIdOrden falló:', error?.message || error);
        }
    }
    return '';
}

/* ============================================================ */
/* SECCIÓN 2: INICIALIZACIÓN DEL FLUJO DE COMPRA              */
/* ============================================================ */

/**
 * Inicializa el flujo de compra con event listeners
 */
document.addEventListener('DOMContentLoaded', function() {
    inicializarFlujoCompra();
    
    // 🗑️  REMOVED: cargarOportunidadesDisponiblesDelBackend() - obsoleto (sistema antiguo)
    // Nuevo sistema: cargarOportunidadesDelCarrito() usa el multiplicador configurado por boleto
    
    // Verificar si debe iniciar el flujo de pago (redirigido desde otra página)
    setTimeout(function() {
        if (getItemSafeFlujo('rifaplusIniciarFlujoPago') === 'true') {
            removeItemSafeFlujo('rifaplusIniciarFlujoPago');
            iniciarFlujoPago();
        }
    }, 100);
});

/**
 * inicializarFlujoCompra - Ya no necesita hacer nada porque el listener
 * de btnProcederCarrito es configurado por carrito-global.js que se carga antes.
 * @returns {void}
 */
function inicializarFlujoCompra() {
    // El flujo de compra es iniciado cuando el usuario hace clic en
    // "Proceder al pago" desde el carrito o resumen de compra.
    // Este listener es configurado por carrito-global.js
}

/* ============================================================ */
/* SECCIÓN 3: PASO 1 - INICIAR FLUJO Y CONTACTO                */
/* ============================================================ */

/**
 * iniciarFlujoPago - Inicia el flujo abriendo el modal de contacto
 * @returns {void}
 */
function iniciarFlujoPago() {
    // ✅ VALIDACIÓN CRÍTICA: Bloquear si oportunidades aún no terminaron de cargar
    const estadoCarga = window.rifaplusOportunidadesEstadoCarga;
    if (estadoCarga?.iniciado && !estadoCarga?.completado) {
        // Las oportunidades se están cargando pero no terminaron
        const progreso = estadoCarga.cargadas || 0;
        const total = estadoCarga.total || 0;
        const porcentaje = total > 0 ? Math.round((progreso / total) * 100) : 0;
        
        rifaplusUtils.showFeedback(
            `⏳ Aún se están cargando las oportunidades... (${progreso}/${total} - ${porcentaje}%)`,
            'warning'
        );
        console.warn('[OPPS-BLOQUEO] Intento de confirmar orden antes de terminar carga de oportunidades');
        return;
    }
    
    if (estadoCarga?.total > 0 && !estadoCarga?.iniciado) {
        // Hay boletos pero las oportunidades nunca empezaron a cargar
        console.warn('[OPPS-BLOQUEO] Oportunidades nunca iniciaron carga, iniciando ahora...');
        if (typeof cargarOportunidadesDelCarrito === 'function') {
            cargarOportunidadesDelCarrito();
            rifaplusUtils.showFeedback('⏳ Cargando oportunidades antes de proceder...', 'info');
            return;
        }
    }
    
    const carritoEstabaAbierto = !!(document.getElementById('carritoModal')?.classList.contains('active'));
    const boletosCheckout = typeof window.obtenerBoletosSelecionados === 'function'
        ? window.obtenerBoletosSelecionados()
        : [];
    const totalesCheckout = typeof window.calcularDescuentoGlobal === 'function'
        ? window.calcularDescuentoGlobal(boletosCheckout.length)
        : null;

    window.RifaPlusMetaPixel?.trackInitiateCheckout?.({
        content_name: window.rifaplusConfig?.rifa?.nombreSorteo || 'Sorteo',
        content_category: 'rifa',
        content_type: 'product',
        content_ids: boletosCheckout.map((numero) => String(numero)),
        num_items: boletosCheckout.length,
        value: Number(totalesCheckout?.totalFinal || 0),
        currency: 'MXN'
    });

    // Cerrar carrito si está abierto
    const carritoModal = document.getElementById('carritoModal');
    if (carritoModal && carritoModal.classList && carritoModal.classList.contains('active')) {
        carritoModal.classList.remove('active');
    }
    
    // Activar modo flujo para que modal-contacto no redirija
    window.rifaplusFlujoPago = true;
    
    // Definir callback que se ejecuta cuando el usuario confirma el formulario
    window.onContactoConfirmado = function() {
        desenfocarElementoActivoFlujo();

        // El cliente ya está guardado en localStorage por modal-contacto.js
        clienteCheckout = obtenerClienteDelStorage();

        // ✅ UX: Mostrar loader ANTES de cerrar el modal para evitar flashazo de la página
        const modalLoading = document.getElementById('modalLoadingOrden');
        if (modalLoading) {
            modalLoading.style.display = 'flex';
        }

        // Cerrar modal de contacto
        if (typeof cerrarModalContacto === 'function') {
            cerrarModalContacto();
        }

        // ✅ FLUJO SIMPLIFICADO: Ir directo al apartado
        window.requestAnimationFrame(() => {
            desenfocarElementoActivoFlujo();
            apartarDirectamente();
        });
    };

    // Abrir modal de contacto con un traspaso limpio si viene del carrito.
    if (typeof abrirModalContacto === 'function') {
        const abrirContacto = () => abrirModalContacto({ instant: carritoEstabaAbierto });

        if (carritoEstabaAbierto) {
            window.requestAnimationFrame(() => {
                abrirContacto();
            });
        } else {
            abrirContacto();
        }
    }
}

/* ============================================================ */
/* SECCIÓN 3B: APARTAR DIRECTAMENTE (FLUJO SIMPLIFICADO)       */
/* Salta modal de cuentas y orden formal → va directo a guardarOrden()
/* ============================================================ */

/**
 * apartarDirectamente - Prepara la orden y llama guardarOrden() sin pasar
 * por el modal de selección de cuenta ni por el modal de orden formal.
 * Se invoca desde el callback onContactoConfirmado del flujo simplificado.
 * @returns {void}
 */
async function apartarDirectamente() {
    // Boletos del carrito
    const boletos = typeof window.obtenerBoletosSelecionados === 'function'
        ? window.obtenerBoletosSelecionados()
        : [];

    if (!boletos || boletos.length === 0) {
        if (typeof rifaplusUtils !== 'undefined') {
            rifaplusUtils.showFeedback('❌ No hay boletos seleccionados', 'error');
        }
        return;
    }

    const clienteGuardado = JSON.parse(getItemSafeFlujo('rifaplus_cliente') || '{}');

    // Calcular totales
    const precioUnitario = typeof obtenerPrecioDinamico === 'function' ? obtenerPrecioDinamico() : 0;
    const totales = typeof calcularTotales === 'function'
        ? calcularTotales(boletos.length, precioUnitario)
        : { subtotal: boletos.length * precioUnitario, descuentoMonto: 0, totalFinal: boletos.length * precioUnitario, precioUnitario };

    // Guardar datos en localStorage (para que guardarOrden() los lea)
    setItemSafeFlujo('rifaplus_boletos', JSON.stringify(boletos));
    setItemSafeFlujo('rifaplus_total', JSON.stringify({
        subtotal: totales.subtotal,
        descuento: totales.descuentoMonto,
        descuentoMonto: totales.descuentoMonto,
        totalFinal: totales.totalFinal,
        total: totales.totalFinal,
        precioUnitario: totales.precioUnitario,
        combo: totales.combo || null
    }));

    // Intentar obtener un ordenId oficial del servidor
    let ordenId = String(clienteGuardado.ordenId || '').trim().toUpperCase();
    const esOficial = typeof window.rifaplusConfig?.esOrdenIdOficial === 'function'
        ? window.rifaplusConfig.esOrdenIdOficial.bind(window.rifaplusConfig)
        : (v) => /^[A-Z0-9]+-[A-Z]{2}\d{3}$/.test(String(v || '').trim().toUpperCase());

    if (!ordenId || !esOficial(ordenId)) {
        ordenId = await obtenerOrdenIdOficialFlujo(clienteGuardado).catch(() => '');
    }

    // Actualizar cliente con el ordenId
    const clienteActualizado = { ...clienteGuardado, ordenId };
    setItemSafeFlujo('rifaplus_cliente', JSON.stringify(clienteActualizado));

    // Construir ordenActual (variable global usada por guardarOrden() en orden-formal.js)
    window.ordenActual = {
        ordenId: ordenId,
        ordenIdVisible: ordenId || 'Se asigna al confirmar',
        cliente: {
            nombre: clienteActualizado.nombre || '',
            apellidos: clienteActualizado.apellidos || '',
            whatsapp: clienteActualizado.whatsapp || '',
            estado: clienteActualizado.estado || '',
            ciudad: clienteActualizado.ciudad || ''
        },
        cuenta: {},         // Sin cuenta: el backend la ignora en este flujo
        boletos: boletos,
        totales: totales,
        precioUnitario: totales.precioUnitario,
        fecha: new Date().toISOString(),
        referencia: ordenId || ''
    };

    // Sincronizar oportunidades si aplica
    if (typeof window.sincronizarOportunidadesAlCarrito === 'function') {
        window.sincronizarOportunidadesAlCarrito();
    }
    const oportunidades = typeof window.obtenerOportunidadesValidadasOrdenActual === 'function'
        ? window.obtenerOportunidadesValidadasOrdenActual(boletos)
        : [];
    window.ordenActual.boletosOcultos = oportunidades;

    // ✅ Guardar la orden directamente (llama a guardarOrden() de orden-formal.js)
    if (typeof window.guardarOrden === 'function') {
        await window.guardarOrden();
    } else {
        console.error('❌ guardarOrden no disponible');
        if (typeof rifaplusUtils !== 'undefined') {
            rifaplusUtils.showFeedback('❌ Error al intentar apartar. Recarga la página e inténtalo de nuevo.', 'error');
        }
    }
}

/* ============================================================ */
/* SECCIÓN 4: PASO 2 - SELECCIÓN DE CUENTA DE PAGO               */
/* ============================================================ */

/**
 * abrirModalSeleccionCuenta - Abre modal para seleccionar cuenta bancaria
 * @returns {void}
 */
async function abrirModalSeleccionCuenta() {
    const modal = document.getElementById('modalSeleccionCuenta');
    if (!modal) {
        console.error('❌ [AbrirModal] modalSeleccionCuenta no encontrado');
        return;
    }

    const transferenciasContainer = document.getElementById('transferenciasLista');
    const efectivoContainer = document.getElementById('efectivoLista');
    
    if (!transferenciasContainer || !efectivoContainer) {
        console.error('❌ [AbrirModal] Contenedores de cuentas no encontrados');
        return;
    }

    liberarTransicionModalCuentas(modal);
    prepararModalSeleccionCuenta(modal, transferenciasContainer, efectivoContainer);

    const cuentasLocales = obtenerCuentasLocalesFlujo();
    if (cuentasLocales.length > 0) {
        renderizarListasCuentasFlujo(cuentasLocales, transferenciasContainer, efectivoContainer);
    }

    const cuentas = await (cuentasDisponiblesPromiseFlujo || obtenerCuentasDisponiblesFlujo());
    
    if (cuentas.length === 0) {
        transferenciasContainer.innerHTML = '<p style="color: var(--danger);">No hay cuentas de pago disponibles</p>';
        efectivoContainer.innerHTML = '<p class="payment-empty-state">No hay opciones de pago disponibles.</p>';
        return;
    }

    renderizarListasCuentasFlujo(cuentas, transferenciasContainer, efectivoContainer);
    
    // Agregar event listeners a los radios
    const radios = document.querySelectorAll('input[type="radio"][name="cuentaPago"]');
    
    radios.forEach(radio => {
        radio.addEventListener('change', function() {
            if (modal.dataset.transitioning === 'true') {
                return;
            }

            const accountId = String(this.value);
            const cuentaSeleccionada = cuentas.find((cuenta, idx) =>
                obtenerAccountIdSeguroFlujo(cuenta, idx) === accountId
            );

            if (!cuentaSeleccionada) {
                console.error('[AbrirModal] ❌ Cuenta no encontrada para id:', accountId);
                return;
            }

            modal.dataset.transitioning = 'true';
            modal.classList.add('modal-seleccion-cuenta--busy');
            radios.forEach((item) => {
                item.disabled = true;
            });

            cerrarModalSeleccionCuenta();

            // Paso 3: Generar y mostrar orden formal con traspaso rápido y estable.
            window.requestAnimationFrame(() => {
                window.requestAnimationFrame(async () => {
                    try {
                        await mostrarOrdenFormal(cuentaSeleccionada, { handoff: true });
                    } finally {
                        liberarTransicionModalCuentas(modal);
                    }
                });
            });
        });
    });
    
    // Emitir evento para que otras páginas se enteren
    if (window.rifaplusConfig && typeof window.rifaplusConfig.emitirEvento === 'function') {
        window.rifaplusConfig.emitirEvento('modalCuentasAbierto', { cuentas });
    }
    
    // Event listener para cerrar
    // No cerrar al tocar fuera; evita salidas accidentales en móvil
    modal.onclick = function() {};
}

function cerrarModalSeleccionCuenta() {
    const modal = document.getElementById('modalSeleccionCuenta');
    if (modal) {
        modal.classList.remove('show');
        window.rifaplusModalScrollLock?.sync?.();
    }
}

/* ============================================================ */
/* SECCIÓN 6: PASO 3 - MOSTRAR ORDEN FORMAL                    */
/* ============================================================ */

/**
 * mostrarOrdenFormal - Prepara y muestra la orden formal de compra
 * @param {Object} cuenta - Objeto con datos de la cuenta bancaria
 * @returns {Promise<void>}
 */
async function mostrarOrdenFormal(cuenta, opciones = {}) {
    if (!clienteCheckout) {
        console.error('No hay datos de cliente');
        return;
    }
    
    // Obtener boletos seleccionados
    const boletos = obtenerBoletosSelecionados();
    if (!boletos || boletos.length === 0) {
        alert('Error: No hay boletos seleccionados');
        return;
    }
    
    const clienteGuardado = JSON.parse(getItemSafeFlujo('rifaplus_cliente') || '{}');
    let ordenIdActual = String(clienteGuardado.ordenId || '').trim().toUpperCase();
    const esOrdenIdOficial = typeof window.rifaplusConfig?.esOrdenIdOficial === 'function'
        ? window.rifaplusConfig.esOrdenIdOficial.bind(window.rifaplusConfig)
        : (valor => /^[A-Z0-9]+-[A-Z]{2}\d{3}$/.test(String(valor || '').trim().toUpperCase()));

    if (ordenIdActual && !esOrdenIdOficial(ordenIdActual)) {
        console.warn('⚠️ [flujo-compra] Se descartó un ordenId viejo o no oficial:', ordenIdActual);
        ordenIdActual = '';
    }

    if (ordenIdActual && !esOrdenIdOficial(ordenIdActual)) {
        console.error('❌ [flujo-compra] Se obtuvo un ordenId no válido tras intentar regenerarlo:', ordenIdActual);
        ordenIdActual = '';
    }

    // Guardar datos para orden-formal.js (sin email)
    setItemSafeFlujo('rifaplus_cliente', JSON.stringify({
        nombre: clienteCheckout.nombre || '',
        apellidos: clienteCheckout.apellidos || clienteCheckout.apellido || '',
        whatsapp: clienteCheckout.whatsapp || '',
        estado: clienteCheckout.estado || '',
        ciudad: clienteCheckout.ciudad || '',
        ordenId: ordenIdActual
    }));
    
    setItemSafeFlujo('rifaplus_boletos', JSON.stringify(boletos));
    
    // Guardar totales
    const precioUnitario = obtenerPrecioDinamico();
    const totales = calcularTotales(boletos.length, precioUnitario);
    
    setItemSafeFlujo('rifaplus_total', JSON.stringify({
        subtotal: totales.subtotal,
        descuento: totales.descuentoMonto,
        descuentoMonto: totales.descuentoMonto,
        totalFinal: totales.totalFinal,
        total: totales.totalFinal,
        precioUnitario: totales.precioUnitario
    }));
    
    // Crear objeto de orden para orden-formal
    const orden = {
        ordenId: ordenIdActual,
        cliente: {
            nombre: clienteCheckout.nombre || '',
            apellidos: clienteCheckout.apellidos || clienteCheckout.apellido || '',
            whatsapp: clienteCheckout.whatsapp || '',
            estado: clienteCheckout.estado || '',
            ciudad: clienteCheckout.ciudad || ''
        },
        cuenta: cuenta,
        boletos: boletos,
        totales: totales,
        fecha: new Date().toISOString(),
        referencia: ordenIdActual || ''
    };
    
    setItemSafeFlujo('rifaplus_orden_actual', JSON.stringify(orden));
    
    // Usar función de orden-formal.js si está disponible
    if (typeof window.abrirOrdenFormal === 'function') {
        try {
            window.abrirOrdenFormal(cuenta, opciones);
        } catch (e) {
            console.error('Error al abrir orden formal:', e);
            mostrarOrdenFormalManual(orden, opciones);
        }
    } else {
        console.warn('abrirOrdenFormal no disponible, usando renderizado manual');
        mostrarOrdenFormalManual(orden, opciones);
    }
}

/* ============================================================ */
/* SECCIÓN 7: RENDERIZADO MANUAL DE ORDEN FORMAL (FALLBACK)    */
/* ============================================================ */

/**
 * mostrarOrdenFormalManual - Renderiza la orden formal si orden-formal.js no está disponible
 * @param {Object} orden - Objeto con datos de la orden
 * @returns {void}
 */
function mostrarOrdenFormalManual(orden, opciones = {}) {
    const modal = document.getElementById('modalOrdenFormal');
    if (!modal) {
        alert('No hay modal de orden disponible');
        return;
    }
    
    const contenedor = document.getElementById('contenidoOrdenFormal');
    if (!contenedor) {
        alert('No hay contenedor para la orden');
        return;
    }
    
    // Renderizar contenido (usar template similar a orden-formal.js)
    const fecha = new Date(orden.fecha).toLocaleDateString('es-ES', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
    
    const concepto = `Boletos: ${orden.boletos.join(', ')}`;
    const monto = orden.totales.totalFinal || orden.totales.subtotal || 0;
    
    const html = `
        <div class="orden-documento" id="documentoPDF" style="font-family: Inter, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue'; color:var(--text-dark); padding:12px;">
            <div style="display:flex; justify-content:space-between; align-items:center; gap:12px;">
                <div style="display:flex; align-items:center; gap:12px;">
                    <img src="images/placeholder-logo.svg" alt="logo" style="height:144px; width:auto; object-fit:contain;" />
                    <div style="font-weight:700; font-size:0.95rem;">${window.rifaplusConfig?.cliente?.nombre || window.rifaplusConfig?.tecnica?.nombreOrganizador || 'Organizador'}</div>
                </div>
                <div style="text-align:right;">
                    <div style="font-size:0.75rem; color:var(--text-light);">Referencia de pago</div>
                    <div style="font-size:0.85rem; color:var(--text-light); font-weight:700;">${`${orden.cliente.nombre || ''} ${orden.cliente.apellidos || ''}`.trim() || '-'}</div>
                </div>
            </div>

            <div style="margin-top:10px; display:flex; gap:10px; align-items:center; justify-content:space-between;">
                <div style="font-size:0.9rem;">
                    <div style="font-weight:700;">${orden.cliente.nombre || ''} ${orden.cliente.apellidos || ''}</div>
                    <div style="font-size:0.85rem; color:var(--text-light);">${orden.cliente.whatsapp || '-'}</div>
                </div>
                <div style="font-size:0.85rem; color:var(--text-light);">Emitida: ${fecha}</div>
            </div>

            <div style="margin-top:12px; padding:10px 0; border-top:1px solid var(--border-color); border-bottom:1px solid var(--border-color); display:flex; justify-content:space-between; align-items:center; gap:8px;">
                <div style="font-size:0.85rem; color:var(--text-dark); max-width:70%; white-space:normal; overflow-wrap:break-word; word-break:break-word;">${concepto}</div>
                <div style="font-weight:800; font-size:1rem; color:var(--text-dark);">$${Number(monto).toFixed(2)}</div>
            </div>

            <div style="margin-top:10px;">
                <div style="font-weight:700; font-size:0.9rem; margin-bottom:6px;">Método de pago</div>
                <div style="display:flex; flex-direction:column; gap:6px;">
                    <div style="font-weight:700;">${orden.cuenta.nombreBanco || '-'}</div>
                    <div style="font-family: 'Courier New', monospace; font-size:0.95rem;">${orden.cuenta.accountNumber || orden.cuenta.numero || '-'}</div>
                    ${orden.cuenta.numero_referencia ? `<div style="font-size:0.88rem; color:var(--text-light);">Referencia: ${orden.cuenta.numero_referencia}</div>` : ''}
                    <div style="font-size:0.88rem; color:var(--text-dark);">Beneficiario: ${orden.cuenta.beneficiary || orden.cuenta.titular || '-'}</div>
                </div>
            </div>
        </div>
    `;
    
    contenedor.innerHTML = html;
    
    // Mostrar modal
    modal.classList.toggle('modal-orden-formal--handoff', !!opciones.handoff);
    modal.classList.add('show');
    window.rifaplusModalScrollLock?.sync?.();
}

/* ============================================================ */
/* SECCIÓN 8: FUNCIONES AUXILIARES Y CÁLCULOS                */
/* ============================================================ */

/**
 * obtenerBoletosSelecionados - Ya implementado en carrito-global.js
 * Se usa en: mostrarOrdenFormal() para compilar datos de orden
 */

/**
 * calcularTotales - Calcula subtotal, descuentos y total final con ofertas DINÁMICAS
 * AHORA USA PROMOCIONES DE config.js (robusto, configurable)
 * @param {number} cantidad - Número de boletos
 * @param {number} precioUnitario - Precio unitario del boleto (obtenido de config si no se proporciona)
 * @returns {Object} Objeto con detalles de totales
 */
function calcularTotales(cantidad, precioUnitario = null) {
    // NOTA: Esta función ahora delega al módulo centralizado calculo-precios.js
    // Se mantiene aquí por compatibilidad, pero internamente usa calcularTotalConPromociones
    if (typeof calcularTotalConPromociones === 'function') {
        return calcularTotalConPromociones(cantidad, precioUnitario);
    }
    
    // Fallback si calculo-precios.js no está cargado (no debería pasar)
    console.warn('⚠️ calcularTotales: calculo-precios.js no está cargado');
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

/* ============================================================ */
/* SECCIÓN 9: EXPORTACIÓN GLOBAL DE FUNCIONES                 */
/* ============================================================ */

// Exportar funciones para acceso global desde otros scripts
window.iniciarFlujoPago = iniciarFlujoPago;
window.apartarDirectamente = apartarDirectamente;
window.abrirModalSeleccionCuenta = abrirModalSeleccionCuenta;
window.cerrarModalSeleccionCuenta = cerrarModalSeleccionCuenta;
window.mostrarOrdenFormal = mostrarOrdenFormal;

