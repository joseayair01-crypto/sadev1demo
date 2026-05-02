/**
 * ============================================================
 * ARCHIVO: js/modal-contacto.js
 * DESCRIPCIÓN: Gestión del modal de formulario de contacto
 * Validación de datos, almacenamiento y generación de ID de orden
 * ÚLTIMA ACTUALIZACIÓN: 2025
 * ============================================================
 */

/* ============================================================ */
/* FUNCIONES DEFENSIVAS DE ALMACENAMIENTO                      */
/* ============================================================ */

/**
 * 🛡️ FUNCIÓN DEFENSIVA: Obtener clave con scope de rifa
 */
function obtenerClaveScopedModal(key) {
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
function setItemSafeModal(key, value) {
    const scopedKey = obtenerClaveScopedModal(key);
    try {
        if (typeof window.safeTrySetItem === 'function') {
            return window.safeTrySetItem(scopedKey, value);
        } else {
            localStorage.setItem(scopedKey, value);
            return true;
        }
    } catch (error) {
        console.warn(`⚠️  [MODAL] Error guardando '${scopedKey}':`, error.message);
        if (!window.StorageMemoryFallback) window.StorageMemoryFallback = {};
        window.StorageMemoryFallback[scopedKey] = value;
        return false;
    }
}

/**
 * 🛡️ FUNCIÓN DEFENSIVA: Leer desde storage de forma segura
 */
function getItemSafeModal(key) {
    const scopedKey = obtenerClaveScopedModal(key);
    try {
        if (typeof window.safeTryGetItem === 'function') {
            return window.safeTryGetItem(scopedKey);
        } else {
            return localStorage.getItem(scopedKey);
        }
    } catch (error) {
        console.warn(`⚠️  [MODAL] Error leyendo '${scopedKey}':`, error.message);
        if (window.StorageMemoryFallback && window.StorageMemoryFallback[scopedKey]) {
            return window.StorageMemoryFallback[scopedKey];
        }
        return null;
    }
}

/**
 * 🛡️ FUNCIÓN DEFENSIVA: Remover del storage
 */
function removeItemSafeModal(key) {
    const scopedKey = obtenerClaveScopedModal(key);
    try {
        if (typeof window.safeTryRemoveItem === 'function') {
            return window.safeTryRemoveItem(scopedKey);
        } else {
            localStorage.removeItem(scopedKey);
            return true;
        }
    } catch (error) {
        console.warn(`⚠️  [MODAL] Error removiendo '${scopedKey}':`, error.message);
        if (window.StorageMemoryFallback) delete window.StorageMemoryFallback[scopedKey];
        return false;
    }
}

/* ============================================================ */
/* SECCIÓN 1: FUNCIONES DE GESTIÓN DEL MODAL                   */
/* ============================================================ */

/**
 * abrirModalContacto - Abre el modal de contacto
 * @returns {void}
 */
function abrirModalContacto(opciones = {}) {
    const modal = document.getElementById('modalContacto');
    if (!modal) {
        return;
    }

    const aperturaDesdeCarrito = !!opciones.instant;
    const primerCampo = document.getElementById('clienteNombre');

    if (modal.classList.contains('show') || modal.dataset.opening === 'true') {
        window.requestAnimationFrame(() => {
            if (primerCampo instanceof HTMLElement) {
                primerCampo.focus({ preventScroll: true });
            }
        });
        return;
    }

    modal.dataset.opening = 'true';
    modal.classList.toggle('modal-overlay--handoff', aperturaDesdeCarrito);
    limpiarFormularioContacto();
    modal.classList.add('show');
    window.rifaplusModalScrollLock?.sync?.();
    modalContactoViewportManager.open();

    window.requestAnimationFrame(() => {
        if (primerCampo instanceof HTMLElement) {
            primerCampo.focus({ preventScroll: true });
        }

        window.setTimeout(() => {
            delete modal.dataset.opening;
        }, aperturaDesdeCarrito ? 200 : 320);
    });
}

/**
 * cerrarModalContacto - Cierra el modal de contacto
 * @returns {void}
 */
function cerrarModalContacto() {
    const modal = document.getElementById('modalContacto');
    if (modal) {
        delete modal.dataset.opening;
        modal.classList.remove('show');
        modal.classList.remove('modal-overlay--handoff');
        modalContactoViewportManager.close();
        window.rifaplusModalScrollLock?.sync?.();
    }
}

/**
 * limpiarFormularioContacto - Limpia campos y errores del formulario
 * @returns {void}
 */
function limpiarFormularioContacto() {
    const form = document.getElementById('formularioContacto');
    if (form) {
        form.reset();
        limpiarErroresFormularioContacto();
    }
}

function limpiarErroresFormularioContacto() {
    document.querySelectorAll('.form-error').forEach(error => {
        error.textContent = '';
    });
}

const modalContactoViewportManager = (() => {
    const MOBILE_MAX_WIDTH = 768;
    const KEYBOARD_OPEN_THRESHOLD = 120;
    const FIELD_SCROLL_PADDING = 20;
    const KEYBOARD_SETTLE_DELAY_MS = 140;
    const FIELD_SELECTOR = 'input, select, textarea';

    let activeField = null;
    let settleTimer = 0;
    let bound = false;

    function getModal() {
        return document.getElementById('modalContacto');
    }

    function getModalCard() {
        return document.querySelector('#modalContacto .modal-contacto');
    }

    function isField(element) {
        return element instanceof HTMLElement && element.matches(FIELD_SELECTOR);
    }

    function syncViewport() {
        const modal = getModal();
        if (!modal) return;

        const viewportHeight = Math.round(window.visualViewport?.height || window.innerHeight || 0);
        const offsetTop = Math.max(12, Math.round((window.visualViewport?.offsetTop || 0) + 12));
        const keyboardOpen = window.matchMedia(`(max-width: ${MOBILE_MAX_WIDTH}px)`).matches
            && window.visualViewport
            && (window.innerHeight - window.visualViewport.height) > KEYBOARD_OPEN_THRESHOLD;

        modal.style.setProperty('--modal-contacto-viewport-height', `${viewportHeight}px`);
        modal.style.setProperty('--modal-contacto-offset-top', `${offsetTop}px`);
        modal.style.setProperty('--modal-contacto-offset-bottom', keyboardOpen ? '12px' : '20px');
        modal.classList.toggle('modal-overlay--keyboard-open', Boolean(keyboardOpen));
    }

    function ensureFieldVisible(target = activeField) {
        const modalCard = getModalCard();
        if (!modalCard || !isField(target) || !modalCard.contains(target)) return;

        const fieldRect = target.getBoundingClientRect();
        const cardRect = modalCard.getBoundingClientRect();
        const footerHeight = modalCard.querySelector('.modal-footer-contacto')?.getBoundingClientRect().height || 0;
        const visibleTop = cardRect.top + FIELD_SCROLL_PADDING;
        const visibleBottom = cardRect.bottom - footerHeight - FIELD_SCROLL_PADDING;

        if (fieldRect.top < visibleTop || fieldRect.bottom > visibleBottom) {
            target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
        }
    }

    function schedule(target = activeField, delay = KEYBOARD_SETTLE_DELAY_MS) {
        window.clearTimeout(settleTimer);
        settleTimer = window.setTimeout(() => {
            syncViewport();
            ensureFieldVisible(target);
        }, delay);
    }

    function bind() {
        if (bound) return;

        const modal = getModal();
        if (!modal) return;

        const handleViewportChange = () => schedule();
        const handleFocusIn = (event) => {
            if (!isField(event.target)) return;
            activeField = event.target;
            schedule(activeField);
        };
        const handleFocusOut = (event) => {
            if (event.target === activeField) activeField = null;
            schedule(null, 60);
        };

        window.visualViewport?.addEventListener('resize', handleViewportChange);
        window.visualViewport?.addEventListener('scroll', handleViewportChange);
        modal.addEventListener('focusin', handleFocusIn);
        modal.addEventListener('focusout', handleFocusOut);
        bound = true;
    }

    return {
        open() {
            bind();
            schedule();
        },
        close() {
            const modal = getModal();
            if (!modal) return;

            activeField = null;
            window.clearTimeout(settleTimer);
            modal.classList.remove('modal-overlay--keyboard-open');
            modal.style.removeProperty('--modal-contacto-viewport-height');
            modal.style.removeProperty('--modal-contacto-offset-top');
            modal.style.removeProperty('--modal-contacto-offset-bottom');
        },
        ensureFieldVisible(target) {
            schedule(target);
        }
    };
})();

function obtenerDatosFormularioContacto() {
    const estadoEl = document.getElementById('clienteEstado');

    return {
        nombre: (document.getElementById('clienteNombre')?.value || '').trim(),
        apellidos: (document.getElementById('clienteApellidos')?.value || '').trim(),
        whatsapp: (document.getElementById('clienteWhatsapp')?.value || '').trim(),
        estado: estadoEl ? (estadoEl.value || '').trim() : ''
    };
}

function normalizarWhatsappContacto(valor) {
    return String(valor || '').replace(/\D/g, '').slice(0, 10);
}

function validarDatosFormularioContacto(datos) {
    const errores = {};
    const whatsappDigits = normalizarWhatsappContacto(datos.whatsapp);

    if (!datos.nombre || datos.nombre.length < 2) {
        errores.nombre = 'El nombre debe tener al menos 2 caracteres';
    }

    if (!datos.apellidos || datos.apellidos.length < 2) {
        errores.apellidos = 'Los apellidos deben tener al menos 2 caracteres';
    }

    if (!whatsappDigits || whatsappDigits.length !== 10) {
        errores.whatsapp = 'Ingresa exactamente 10 dígitos para WhatsApp';
    }

    if (!datos.estado) {
        errores.estado = 'Selecciona tu estado';
    }

    return errores;
}

function aplicarErroresFormularioContacto(errores) {
    const campos = {
        nombre: 'errorNombre',
        apellidos: 'errorApellidos',
        whatsapp: 'errorWhatsapp',
        estado: 'errorEstado'
    };

    Object.entries(campos).forEach(([campo, errorId]) => {
        const errorEl = document.getElementById(errorId);
        if (errorEl) {
            errorEl.textContent = errores[campo] || '';
        }
    });
}

function enlazarCampoMayusculas(field) {
    if (!field) {
        return;
    }

    function normalizar() {
        this.value = this.value.toUpperCase();
    }

    field.addEventListener('input', normalizar);
    field.addEventListener('change', normalizar);
}

function enlazarInputWhatsapp(field) {
    if (!field) {
        return;
    }

    field.addEventListener('input', function() {
        this.value = normalizarWhatsappContacto(this.value);
    });

    field.addEventListener('keypress', function(e) {
        if (!/[0-9]/.test(e.key)) {
            e.preventDefault();
        }
    });
}

async function procesarConfirmacionContacto() {
    const datos = obtenerDatosFormularioContacto();
    const errores = validarDatosFormularioContacto(datos);

    aplicarErroresFormularioContacto(errores);

    if (Object.keys(errores).length > 0) {
        rifaplusUtils.showFeedback('⚠️ Por favor completa correctamente el formulario', 'warning');
        return;
    }

    try {
        await guardarClienteEnStorage(
            datos.nombre,
            datos.apellidos,
            datos.whatsapp,
            datos.estado
        );
    } catch (error) {
        console.error('❌ [Modal-Contacto] No se pudo generar un numero de orden oficial:', error);
        rifaplusUtils.showFeedback('❌ No se pudo obtener un numero de orden oficial. Intenta de nuevo.', 'error');
        return;
    }

    guardarBoletoSeleccionadosEnStorage();

    if (window.rifaplusFlujoPago && typeof window.onContactoConfirmado === 'function') {
        try {
            window.onContactoConfirmado();
            return;
        } catch (err) {
            window.location.href = 'compra.html';
            return;
        }
    }

    window.location.href = 'compra.html';
}

/* ============================================================ */
/* SECCIÓN 2: VALIDACIÓN DE FORMULARIO                       */
/* ============================================================ */

/**
 * validarFormularioContacto - Valida todos los campos del formulario
 * @returns {boolean} Verdadero si el formulario es válido
 */
function validarFormularioContacto() {
    const errores = validarDatosFormularioContacto(obtenerDatosFormularioContacto());
    aplicarErroresFormularioContacto(errores);
    return Object.keys(errores).length === 0;
}

/* ============================================================ */
/* SECCIÓN 3: GENERACIÓN Y GESTIÓN DE ID DE ORDEN            */
/* ============================================================ */

/**
 * generarIdOrden - Genera un ID único para la orden con secuencia alfabética
 * Patrón dinámico: [PREFIJO]-AA001, [PREFIJO]-AA002... [PREFIJO]-AA999, [PREFIJO]-AB000, etc.
 * Ej: "SORTEOS EL TREBOL" → SET-AA001, SET-AA002, etc.
 * Ej: "Rifas El Trebol" → RET-AA001, RET-AA002, etc.
 * El prefijo se genera dinámicamente de config.cliente.nombre (primeras letras de cada palabra)
 * @returns {Promise<string>} ID de orden formateado (ej: SET-AA001, RET-AA001, etc.)
 */
async function generarIdOrden() {
    const config = window.rifaplusConfig;
    if (!config?.backend?.apiBase) {
        throw new Error('BACKEND_API_BASE_UNAVAILABLE');
    }

    let clienteId = String(config?.cliente?.id || '').trim();

    if ((!clienteId || !config?.cliente?.prefijoOrden) && typeof config?.sincronizarConfigDelBackend === 'function') {
        try {
            await config.sincronizarConfigDelBackend({ force: true });
            clienteId = String(config?.cliente?.id || '').trim();
        } catch (syncError) {
            console.warn('⚠️ [Modal-Contacto] No se pudo sincronizar config antes de generar orden:', syncError?.message || syncError);
        }
    }

    const respuesta = await fetch(`${config.backend.apiBase}/api/public/order-counter/next`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cliente_id: clienteId || null })
    });

    if (!respuesta.ok) {
        throw new Error(`ORDER_COUNTER_HTTP_${respuesta.status}`);
    }

    const data = await respuesta.json();
    const ordenIdFinal = String(data?.orden_id || '').trim().toUpperCase();

    if (!data?.success || !config?.esOrdenIdOficial?.(ordenIdFinal)) {
        throw new Error(`ORDER_COUNTER_INVALID_RESPONSE:${ordenIdFinal || 'EMPTY'}`);
    }

    guardarIdEnLocalStorage(ordenIdFinal);

    const cliente = JSON.parse(getItemSafeModal('rifaplus_cliente') || '{}');
    cliente.ordenId = ordenIdFinal;
    setItemSafeModal('rifaplus_cliente', JSON.stringify(cliente));

    return ordenIdFinal;
}

// Exponer explícitamente el generador para otros flujos (compra/orden formal).
// No depender de que el navegador eleve implícitamente la función al objeto window.
window.generarIdOrden = generarIdOrden;
if (window.rifaplusConfig) {
    window.rifaplusConfig.generarIdOrden = generarIdOrden;
}

/**
 * incrementarSecuencia - Avanza la secuencia alfabética (AA → AB → AC... ZZ)
 * @param {string} secuencia - Secuencia actual (ej: "AA")
 * @returns {string} Siguiente secuencia (ej: "AB")
 */
function incrementarSecuencia(secuencia) {
    if (secuencia.length !== 2) return 'AA';
    
    let [letra1, letra2] = secuencia.split('');
    
    // Incrementar segunda letra
    letra2 = String.fromCharCode(letra2.charCodeAt(0) + 1);
    
    // Si excede 'Z', reiniciar y avanzar primera letra
    if (letra2 > 'Z') {
        letra2 = 'A';
        letra1 = String.fromCharCode(letra1.charCodeAt(0) + 1);
    }
    
    // Si excede 'Z', volvemos a 'AA' (ciclo completo)
    if (letra1 > 'Z') {
        return 'AA';
    }
    
    return letra1 + letra2;
}

/**
 * guardarIdEnLocalStorage - Registra un ID como usado en localStorage
 * @param {string} orderId - ID de orden a registrar
 */
function guardarIdEnLocalStorage(orderId) {
    const usedKey = 'rifaplus_used_order_ids';
    let used = [];
    
    try {
        used = JSON.parse(getItemSafeModal(usedKey) || '[]');
        if (!Array.isArray(used)) used = [];
    } catch (e) {
        used = [];
    }
    
    // Evitar duplicados
    if (!used.includes(orderId)) {
        used.push(orderId);
        // Mantener solo los últimos 10000 IDs para no llenar localStorage
        if (used.length > 10000) {
            used = used.slice(-10000);
        }
        setItemSafeModal(usedKey, JSON.stringify(used));
    }
}

/* ============================================================ */
/* SECCIÓN 4: ALMACENAMIENTO DE DATOS DE CLIENTE               */
/* ============================================================ */

/**
 * guardarClienteEnStorage - Guarda datos del cliente en localStorage
 * @param {string} nombre - Nombre del cliente
 * @param {string} apellidos - Apellidos del cliente
 * @param {string} whatsapp - Número de WhatsApp
 * @param {string} estado - Estado/Departamento
 * @param {string} ciudad - Ciudad/Localidad
 * @returns {Promise<Object>} Objeto con datos guardados
 */
async function guardarClienteEnStorage(nombre, apellidos, whatsapp, estado) {
    const clienteData = {
        nombre,
        apellidos,
        whatsapp,
        estado: estado || undefined,
        ordenId: '',
        fecha: new Date().toISOString()
    };
    
    setItemSafeModal('rifaplus_cliente', JSON.stringify(clienteData));
    
    return clienteData;
}

/**
 * obtenerClienteDelStorage - Recupera datos del cliente del almacenamiento
 * @returns {Object|null} Objeto con datos del cliente o null
 */
function obtenerClienteDelStorage() {
    try {
        const data = getItemSafeModal('rifaplus_cliente');
        return data ? JSON.parse(data) : null;
    } catch (error) {
        return null;
    }
}

function limpiarOrdenIdObsoletoDelStorage() {
    try {
        const raw = getItemSafeModal('rifaplus_cliente');
        if (!raw) return;

        const cliente = JSON.parse(raw);
        const ordenId = String(cliente?.ordenId || '').trim().toUpperCase();
        const config = window.rifaplusConfig;

        if (!ordenId || !config?.esOrdenIdOficial) {
            return;
        }

        if (!config.esOrdenIdOficial(ordenId)) {
            delete cliente.ordenId;
            setItemSafeModal('rifaplus_cliente', JSON.stringify(cliente));
        }
    } catch (error) {
        console.warn('⚠️ [Modal-Contacto] No se pudo limpiar ordenId obsoleto:', error?.message || error);
    }
}

/**
 * guardarBoletoSeleccionadosEnStorage - Guarda boletos seleccionados en localStorage
 * @returns {void}
 */
function guardarBoletoSeleccionadosEnStorage() {
    try {
        // Guardar números seleccionados para que aparezcan en la orden
        const boletos = Array.from(selectedNumbersGlobal);
        
        // ✅ VALIDACIÓN CORRECTA: Validar retorno para saber si está persistido
        const saveResult = setItemSafeModal('rifaplus_boletos', JSON.stringify(boletos));

        if (saveResult === false) {
            console.warn(`⚠️  [MODAL] Boletos guardados en MEMORIA (no persistente)`);
        } else if (saveResult && saveResult.persisted !== undefined) {
            if (!saveResult.persisted) {
                console.warn(`⚠️  [MODAL] Boletos guardados en MEMORIA (se pierde en reload)`);
            }
        }
    } catch (e) {
        console.error('❌ Error preparando boletos para storage:', e);
    }
}

// ✅ NOTA: Las oportunidades YA fueron calculadas por carrito-global.js
// y están guardadas en localStorage 'rifaplus_oportunidades'
// NO recalcular aquí para evitar duplicados o conflictos
// El siguiente paso es flujo-compra.js que las recupera de localStorage

/* ============================================================ */
/* SECCIÓN 5: INICIALIZACIÓN Y EVENT LISTENERS                */
/* ============================================================ */

/**
 * Configura todos los event listeners del modal de contacto
 */
document.addEventListener('DOMContentLoaded', function() {
    limpiarOrdenIdObsoletoDelStorage();

    const btnCancelarContacto = document.getElementById('btnCancelarContacto');
    const btnContinuarContacto = document.getElementById('btnContinuarContacto');
    const closeContacto = document.getElementById('closeContacto');
    const formularioContacto = document.getElementById('formularioContacto');
    const inputWhatsapp = document.getElementById('clienteWhatsapp');
    const inputNombre = document.getElementById('clienteNombre');
    const inputApellidos = document.getElementById('clienteApellidos');
    
    // 🔤 CONVERTIR A MAYÚSCULAS AUTOMÁTICAMENTE en campos de texto
    [inputNombre, inputApellidos].forEach(enlazarCampoMayusculas);
    
    // Validación en tiempo real para WhatsApp: solo números
    enlazarInputWhatsapp(inputWhatsapp);
    
    // Cerrar modal
    if (btnCancelarContacto) {
        btnCancelarContacto.addEventListener('click', cerrarModalContacto);
    }
    
    if (closeContacto) {
        closeContacto.addEventListener('click', cerrarModalContacto);
    }
    
    // Cerrar al hacer click fuera del modal (en el overlay)
    const modalOverlay = document.getElementById('modalContacto');
    if (modalOverlay) {
        modalOverlay.addEventListener('click', function(e) {
            if (e.target === modalOverlay) {
                cerrarModalContacto();
            }
        });
    }
    
    // Continuar (validar y proceder a orden)
    if (btnContinuarContacto) {
        btnContinuarContacto.addEventListener('click', async function(e) {
            e.preventDefault();
            await procesarConfirmacionContacto();
        });
    }
    
    // Permitir Enter para enviar
    if (formularioContacto) {
        formularioContacto.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                btnContinuarContacto.click();
            }
        });
    }
});

// Exportar función para que compra.js pueda usarla
// (o ya está disponible globalmente)
