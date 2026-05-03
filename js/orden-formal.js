/**
 * ============================================================
 * ARCHIVO: js/orden-formal.js
 * DESCRIPCIÓN: Gestión de órdenes formales con generación de PDF
 * y envío de información por WhatsApp al organizador
 * ÚLTIMA ACTUALIZACIÓN: 2025
 * ============================================================
 */

/* ============================================================ */
/* FUNCIONES DEFENSIVAS DE ALMACENAMIENTO                      */
/* ============================================================ */

/**
 * 🛡️ FUNCIÓN DEFENSIVA: Guardar en storage de forma segura
 * Usa localStorage directo con fallback a memoria
 * NUNCA falla - siempre tiene un plan B
 * @param {string} key - Clave a guardar
 * @param {string} value - Valor a guardar
 * @returns {boolean} true si guardó en localStorage, false si tuvo que usar memoria
 */
function setItemSafeOrden(key, value) {
    try {
        const scopedKey = typeof window.rifaplusConfig?.construirClaveLocal === 'function'
            ? window.rifaplusConfig.construirClaveLocal(key)
            : key;
        localStorage.setItem(scopedKey, value);
        return true;
    } catch (error) {
        console.warn(`⚠️  [ORDEN] Cuota localStorage excedida para '${key}'. Usando memoria.`, error.message);
        if (!window.StorageMemoryFallback) window.StorageMemoryFallback = {};
        window.StorageMemoryFallback[key] = value;
        return false;
    }
}

/**
 * 🛡️ FUNCIÓN DEFENSIVA: Leer desde storage de forma segura
 * @param {string} key - Clave a leer
 * @returns {string|null} Valor guardado o null si no existe
 */
function getItemSafeOrden(key) {
    try {
        const scopedKey = typeof window.rifaplusConfig?.construirClaveLocal === 'function'
            ? window.rifaplusConfig.construirClaveLocal(key)
            : key;
        return localStorage.getItem(scopedKey);
    } catch (error) {
        console.warn(`⚠️  [ORDEN] Error leyendo '${key}'. Intentando memoria.`, error.message);
        if (window.StorageMemoryFallback && window.StorageMemoryFallback[key]) {
            return window.StorageMemoryFallback[key];
        }
        return null;
    }
}

function removeItemSafeOrden(key) {
    try {
        const scopedKey = typeof window.rifaplusConfig?.construirClaveLocal === 'function'
            ? window.rifaplusConfig.construirClaveLocal(key)
            : key;
        localStorage.removeItem(scopedKey);
    } catch (error) {
        console.warn(`⚠️  [ORDEN] Error eliminando '${key}'.`, error.message);
    }
}

/* ============================================================ */
/* SECCIÓN 1: CONFIGURACIÓN GLOBAL Y VARIABLES DE ESTADO       */
/* ============================================================ */

var ordenActual = null;

function debugOrdenFormalHabilitado() {
    const debugGlobal = window.RIFAPLUS_DEBUG || window.rifaplusDebug;
    return debugGlobal === true || Boolean(debugGlobal?.ordenFormal);
}

function logOrdenFormalDebug(...args) {
    if (debugOrdenFormalHabilitado()) {
        console.log(...args);
    }
}

function crearErrorOrdenFormal(message, options = {}) {
    const error = new Error(String(message || 'Error desconocido'));
    if (options && typeof options === 'object') {
        if (options.code) error.code = options.code;
        if (options.status) error.status = options.status;
        if (options.userMessage) error.userMessage = options.userMessage;
        if (options.serverMessage) error.serverMessage = options.serverMessage;
    }
    return error;
}

function resolverMensajeUsuarioOrdenFormal(error) {
    const code = String(error?.code || '').trim().toUpperCase();
    const status = Number(error?.status || 0);
    const rawMessage = String(error?.userMessage || error?.message || '').trim();

    if (code === 'ORDEN_TEMPORALMENTE_BLOQUEADA' || (status === 503 && /procesando demasiadas compras|intenta de nuevo en unos segundos/i.test(rawMessage))) {
        return 'Hay mucha actividad en este momento y tu apartado no pudo completarse todavia. Intenta nuevamente en unos segundos. No se genero una orden incompleta.';
    }

    if (code === 'ORDEN_ID_EN_CONTENCION') {
        return 'Tu compra se cruzo con otra operacion en ese instante. Intenta nuevamente en unos segundos para generar una orden valida.';
    }

    return rawMessage || 'Error desconocido';
}

function obtenerOportunidadesValidadasOrdenActual(boletos) {
    const oportunidadesAlCarrito = [];
    const oportunidadesVistas = new Set();
    const boletosEnOrden = new Set(boletos.map((boleto) => String(Number(boleto))));

    if (!window.rifaplusOportunidadesCarrito || typeof window.rifaplusOportunidadesCarrito !== 'object') {
        return oportunidadesAlCarrito;
    }

    for (const boletoKey in window.rifaplusOportunidadesCarrito) {
        if (!boletosEnOrden.has(String(Number(boletoKey)))) {
            console.warn(`[Orden-Formal] ⚠️  Boleto #${boletoKey} ya no está en la orden, omitiendo sus oportunidades`);
            continue;
        }

        const oportunidadesPorBoleto = window.rifaplusOportunidadesCarrito[boletoKey];
        if (!Array.isArray(oportunidadesPorBoleto)) {
            continue;
        }

        for (const opp of oportunidadesPorBoleto) {
            const oppNum = Number(opp);
            if (!Number.isFinite(oppNum) || oppNum <= 0 || oportunidadesVistas.has(oppNum)) {
                continue;
            }

            oportunidadesAlCarrito.push(oppNum);
            oportunidadesVistas.add(oppNum);
        }
    }

    oportunidadesAlCarrito.sort((a, b) => a - b);
    return oportunidadesAlCarrito;
}

function obtenerOportunidadesDisponiblesRenderOrden(boletosArray) {
    const oportunidades = [];

    if (window.rifaplusOportunidadesCarrito && typeof window.rifaplusOportunidadesCarrito === 'object') {
        for (const boleto of boletosArray) {
            const boletoKey = String(boleto);
            const oportunidadesBoleto = window.rifaplusOportunidadesCarrito[boletoKey];
            if (Array.isArray(oportunidadesBoleto)) {
                oportunidades.push(...oportunidadesBoleto);
            }
        }
    }

    if (oportunidades.length > 0 || !window.oportunidadesManager) {
        return oportunidades;
    }

    const oportunidadesPorBoleto = window.oportunidadesManager.obtenerMultiples(boletosArray);
    for (const boleto of boletosArray) {
        const oportunidadesBoleto = oportunidadesPorBoleto[Number(boleto)];
        if (Array.isArray(oportunidadesBoleto)) {
            oportunidades.push(...oportunidadesBoleto);
        }
    }

    return oportunidades;
}

function obtenerLogoActualOrdenFormal() {
    const logoConfig = String(
        window.rifaplusConfig?.cliente?.logo ||
        window.rifaplusConfig?.cliente?.logotipo ||
        ''
    ).trim();

    if (logoConfig && logoConfig !== 'images/placeholder-logo.svg') {
        return logoConfig;
    }

    const logoCacheadoGlobal = String(window.__RIFAPLUS_CACHED_LOGO__ || '').trim();
    if (logoCacheadoGlobal && logoCacheadoGlobal !== 'images/placeholder-logo.svg') {
        return logoCacheadoGlobal;
    }

    try {
        const logoCacheadoLocal = String(localStorage.getItem('rifaplus_cached_logo') || '').trim();
        if (logoCacheadoLocal && logoCacheadoLocal !== 'images/placeholder-logo.svg') {
            return logoCacheadoLocal;
        }
    } catch (error) {
        console.warn('⚠️ [Orden-Formal] No se pudo leer el logo cacheado:', error?.message || error);
    }

    return 'images/placeholder-logo.svg';
}

/**
 * compactRanges - Compacta un array de números en rangos
 * @param {Array} arr - Array de números
 * @returns {string} String con rangos compactados (ej: "1-5, 7, 9-11")
 */
function compactRanges(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return '-';
    const nums = arr.slice().map(n => Number(n)).filter(n => !isNaN(n)).sort((a,b) => a - b);
    const ranges = [];
    let start = nums[0], end = nums[0];
    for (let i = 1; i < nums.length; i++) {
        const n = nums[i];
        if (n === end || n === end + 1) {
            end = n;
        } else {
            ranges.push(start === end ? String(start) : `${start}-${end}`);
            start = n;
            end = n;
        }
    }
    ranges.push(start === end ? String(start) : `${start}-${end}`);
    return ranges.join(',');
}

function crearFormateadorNumerosOrdenFormal(...colecciones) {
    const valoresCrudos = colecciones.flat().filter((valor) => valor !== null && valor !== undefined && valor !== '');
    const digitosConfig = typeof window.rifaplusConfig?.obtenerDigitosNumeracion === 'function'
        ? Number(window.rifaplusConfig.obtenerDigitosNumeracion())
        : 0;

    let digitos = 0;

    // Priorizar la configuración sincronizada real del universo visible + oculto.
    if (Number.isFinite(digitosConfig) && digitosConfig > 0) {
        digitos = digitosConfig;
    } else {
        const digitosCrudos = valoresCrudos
            .map((valor) => String(valor).replace(/[^0-9]/g, ''))
            .filter(Boolean)
            .map((valor) => valor.length);

        const maxNumero = valoresCrudos.reduce((maximo, valor) => {
            const numero = parseInt(String(valor).replace(/[^0-9]/g, ''), 10);
            return Number.isFinite(numero) ? Math.max(maximo, numero) : maximo;
        }, 0);

        digitos = Math.max(
            digitosCrudos.length ? Math.max(...digitosCrudos) : 0,
            String(Math.max(maxNumero, 0)).length
        );
    }

    const digitosFinales = Math.max(1, digitos);

    return function formatearNumeroOrdenFormal(numero) {
        const limpio = String(numero ?? '').replace(/[^0-9]/g, '');
        if (!limpio) {
            return '?'.repeat(digitosFinales);
        }

        const numeroNormalizado = parseInt(limpio, 10);
        if (!Number.isFinite(numeroNormalizado) || numeroNormalizado < 0) {
            return '?'.repeat(digitosFinales);
        }

        return String(numeroNormalizado).padStart(digitosFinales, '0');
    };
}

function esOrdenIdOficialActualOrdenFormal(ordenId) {
    const valor = String(ordenId || '').trim().toUpperCase();
    if (!valor) return false;

    const esOficial = typeof window.rifaplusConfig?.esOrdenIdOficial === 'function'
        ? window.rifaplusConfig.esOrdenIdOficial(valor)
        : /^[A-Z0-9]+-[A-Z]{2}\d{3}$/.test(valor);

    return esOficial;
}

function obtenerOrdenIdVisibleOrdenFormal(ordenId) {
    return esOrdenIdOficialActualOrdenFormal(ordenId)
        ? String(ordenId).trim().toUpperCase()
        : 'Se asigna al confirmar';
}

/* ============================================================ */
/* SECCIÓN 2: APERTURA Y CIERRE DE MODAL DE ORDEN              */
/* ============================================================ */

/**
 * abrirOrdenFormal - Abre el modal de orden formal con datos compilados
 * @param {Object} cuenta - Objeto con datos de cuenta bancaria
 * @returns {void}
 */
function abrirOrdenFormal(cuenta, opciones = {}) {
    // VALIDACIÓN 1: Verificar que rifaplusConfig existe
    if (!window.rifaplusConfig) {
        console.error('❌ rifaplusConfig no está inicializado');
        rifaplusUtils.showFeedback('❌ Error de configuración del sistema', 'error');
        return;
    }
    
    // Compilar datos de la orden
    const cliente = JSON.parse(getItemSafeOrden('rifaplus_cliente') || '{}');
    let boletos = JSON.parse(getItemSafeOrden('rifaplus_boletos') || '[]');
    const totales = JSON.parse(getItemSafeOrden('rifaplus_total') || '{}');

    // Si rifaplus_boletos está vacío, intentar recuperar de rifaplusSelectedNumbers
    if (!boletos || boletos.length === 0) {
        const selectedNumbers = JSON.parse(getItemSafeOrden('rifaplusSelectedNumbers') || '[]');
        if (selectedNumbers && selectedNumbers.length > 0) {
            console.warn('⚠️  rifaplus_boletos está vacío, usando rifaplusSelectedNumbers como fallback');
            boletos = selectedNumbers;
            setItemSafeOrden('rifaplus_boletos', JSON.stringify(boletos));
        }
    }

    let ordenId = String(cliente.ordenId || '').trim().toUpperCase();
    if (!esOrdenIdOficialActualOrdenFormal(ordenId)) {
        ordenId = '';
    }
    
    // Guardar el ID oficial en localStorage para futuros usos
    cliente.ordenId = ordenId;
    setItemSafeOrden('rifaplus_cliente', JSON.stringify(cliente));

    ordenActual = {
        ordenId: ordenId,
        ordenIdVisible: obtenerOrdenIdVisibleOrdenFormal(ordenId),
        cliente: {
            nombre: cliente.nombre,
            apellidos: cliente.apellidos,
            whatsapp: cliente.whatsapp,
            estado: cliente.estado || '',
            ciudad: cliente.ciudad || ''
        },
        cuenta: cuenta,
        boletos: boletos,
        totales: totales,
        // Precio dinámico: desde totales (si se calculó) → desde config.js → default 15
        precioUnitario: totales?.precioUnitario || (typeof obtenerPrecioDinamico === 'function' ? obtenerPrecioDinamico() : 15),
        fecha: new Date().toISOString(),
        referencia: ordenId || ''
    };

    // Guardar en storage
    setItemSafeOrden('rifaplus_orden_actual', JSON.stringify(ordenActual));

    // ✅ SINCRONIZAR OPORTUNIDADES antes de renderizar (robusto y confiable)
    // Esto asegura que window.rifaplusOportunidadesCarrito esté poblado
    if (typeof window.sincronizarOportunidadesAlCarrito === 'function') {
        window.sincronizarOportunidadesAlCarrito();
        logOrdenFormalDebug('[Orden-Formal] Oportunidades sincronizadas antes de renderizar');
    }

    const oportunidadesAlCarrito = obtenerOportunidadesValidadasOrdenActual(boletos);

    const multiplicadorOportunidades = Number(window.rifaplusConfig?.rifa?.oportunidades?.multiplicador) > 0
        ? Number(window.rifaplusConfig.rifa.oportunidades.multiplicador)
        : 0;
    
    // Almacenar las oportunidades en la orden (será incluida en payload)
    ordenActual.boletosOcultos = oportunidadesAlCarrito;
    logOrdenFormalDebug('[Orden-Formal] Oportunidades validadas en ordenActual:', {
        cantidad: oportunidadesAlCarrito.length,
        boletosEnOrden: boletos.length,
        esperadas: boletos.length * multiplicadorOportunidades,
        oportunidades: oportunidadesAlCarrito.slice(0, 5)
    });
    
    // ✅ VALIDACIÓN: Si no hay oportunidades esperadas, avisar
    if (oportunidadesAlCarrito.length === 0 && window.rifaplusConfig?.rifa?.oportunidades?.enabled) {
        console.warn('[Orden-Formal] ⚠️  ADVERTENCIA: Oportunidades habilitadas pero no hay ninguna');
    }

    // Renderizar modal
    renderizarOrdenFormal(ordenActual);

    // Mostrar modal
    const modal = document.getElementById('modalOrdenFormal');
    if (modal) {
        modal.classList.toggle('modal-orden-formal--handoff', !!opciones.handoff);
        modal.classList.add('show');
        window.rifaplusModalScrollLock?.sync?.();

        const contenedor = modal.querySelector('.orden-formal-container');
        const contenido = modal.querySelector('.orden-formal-content');
        modal.scrollTop = 0;
        if (contenedor) contenedor.scrollTop = 0;
        if (contenido) contenido.scrollTop = 0;
    }
}

/**
 * cerrarOrdenFormal - Cierra el modal de orden formal
 * @returns {void}
 */
function cerrarOrdenFormal() {
    const modal = document.getElementById('modalOrdenFormal');
    if (modal) {
        modal.classList.remove('show');
        modal.classList.remove('modal-orden-formal--handoff');
        window.rifaplusModalScrollLock?.sync?.();
    }
}

/* ============================================================ */
/* SECCIÓN 3: RENDERIZADO DE ORDEN FORMAL EN HTML              */
/* ============================================================ */

/**
 * renderizarOrdenFormal - Renderiza el contenido HTML de la orden formal
 * @param {Object} orden - Objeto con datos de la orden actual
 * @returns {void}
 */
function renderizarOrdenFormal(orden) {
    const contenedor = document.getElementById('contenidoOrdenFormal');
    if (!contenedor) return;

    // CRÍTICO: RECONSTRUIR EL ID CON EL PREFIJO DINÁMICO ACTUAL
    // Esto garantiza que el modal SIEMPRE muestre el prefijo correcto
    const ordenIdReconstruido = window.rifaplusConfig?.reconstruirIdOrdenConPrefijoActual?.(orden.ordenId) || orden.ordenId;
    orden.ordenId = ordenIdReconstruido; // Actualizar en el objeto orden también

    const fecha = new Date(orden.fecha);
    const fechaFormato = fecha.toLocaleDateString('es-ES', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });
    const horaFormato = fecha.toLocaleTimeString('es-ES', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    });

    const logoUrl = obtenerLogoActualOrdenFormal();
    const nombreOrganizador = window.rifaplusConfig?.cliente?.nombre || 'Organizador';
    
    // Obtener todos los boletos (sin compactar - mostrar todos los números)
    const boletosOriginales = Array.isArray(orden.boletos) ? orden.boletos : [];
    const boletosArray = boletosOriginales.map(b => Number(b)).filter(n => !isNaN(n)).sort((a, b) => a - b);
    const formatear = crearFormateadorNumerosOrdenFormal(boletosOriginales, orden.boletosOcultos || []);
    const boletosStr = boletosArray.map(formatear).join(', ');
    
    // ✅ OBTENER OPORTUNIDADES - Lectura robusta del manager o del carrito global
    let boletosOcultosHtml = '';
    const oportunidadesHabilitadas = window.rifaplusConfig?.rifa?.oportunidades?.enabled === true;
    
    if (oportunidadesHabilitadas) {
        const oppsDisponibles = obtenerOportunidadesDisponiblesRenderOrden(boletosArray);
        
        // Renderizar HTML si hay oportunidades
        if (oppsDisponibles.length > 0) {
            logOrdenFormalDebug('[Orden-Formal] Mostrando oportunidades en la orden:', oppsDisponibles.length);
            const oppsFormato = oppsDisponibles.map(formatear).join(', ');
            
            boletosOcultosHtml = `
                <div class="orden-boletos">
                    <div class="orden-field-label">Oportunidades Adicionales (${oppsDisponibles.length})</div>
                    <div class="orden-boletos-list">${oppsFormato}</div>
                </div>
            `;
        }
    }
    
    const oportunidadesHtml = boletosOcultosHtml;
    
    // Totales normalizados para que siempre reflejen el cálculo real
    const subtotalSource = orden.totales?.subtotal;
    const totalSource = orden.totales?.totalFinal ?? orden.totales?.total;
    const descuentoSource = orden.totales?.descuento ?? orden.totales?.descuentoMonto;
    const subtotal = Number(subtotalSource ?? 0);
    const totalBase = Number(totalSource ?? 0);
    const descuentoBase = Number(descuentoSource ?? 0);
    const descuento = descuentoBase > 0 ? descuentoBase : Math.max(0, subtotal - totalBase);
    const total = totalSource !== null && totalSource !== undefined ? totalBase : Math.max(0, subtotal - descuento);
    const comboInfo = orden.totales?.combo || null;
    const comboHtml = comboInfo?.applied ? `
        <div class="orden-boletos">
            <div class="orden-field-label">Promoción Combo Aplicada</div>
            <div class="orden-field-value">
                Recibes ${Number(comboInfo.boletosEntregados || boletosArray.length)} boleto(s), pagas ${Number(comboInfo.boletosPagados || boletosArray.length)} y se bonifican ${Number(comboInfo.boletosBonificados || 0)}.
            </div>
        </div>
    ` : '';
    const html = `
        <div class="orden-documento" id="documentoPDF">
            
            <!-- ENCABEZADO: Logo Grande + Nombre Organizador + fecha -->
            <div class="orden-header">
                <div class="orden-header-left">
                    <img src="${logoUrl}" alt="logo" data-dynamic-logo="true" class="dynamic-logo" onerror="this.onerror=null; this.src='images/placeholder-logo.svg';" />
                    <div class="orden-organizador">${nombreOrganizador}</div>
                </div>
                <div class="orden-header-right">
                    <div class="orden-label">Orden de Pago</div>
                    <div class="orden-fecha">📅 ${fechaFormato}</div>
                    <div class="orden-hora">⏰ ${horaFormato}</div>
                </div>
            </div>

            <!-- DATOS DEL CLIENTE -->
            <div class="orden-section">
                <div class="orden-section-title">Datos del Cliente</div>
                <div class="orden-cliente-grid">
                    <div>
                        <div class="orden-field-label">Nombre</div>
                        <div class="orden-field-value">${orden.cliente.nombre || '-'}</div>
                    </div>
                    <div>
                        <div class="orden-field-label">Apellidos</div>
                        <div class="orden-field-value">${orden.cliente.apellidos || '-'}</div>
                    </div>
                    <div>
                        <div class="orden-field-label">WhatsApp</div>
                        <div class="orden-field-value">${orden.cliente.whatsapp || '-'}</div>
                    </div>
                </div>
            </div>

            <!-- RESUMEN DE COMPRA -->
            <div class="orden-section">
                <div class="orden-section-title">Resumen de Compra</div>
                <div class="orden-section-content">
                    <div class="orden-boletos">
                        <div class="orden-field-label">Boletos Adquiridos (${boletosArray.length})</div>
                        <div class="orden-boletos-list">${boletosStr}</div>
                    </div>
                    ${comboHtml}
                    ${oportunidadesHtml}
                    <div class="orden-totales">
                        <div class="orden-subtotal">
                            <span class="orden-subtotal-label">Subtotal:</span>
                            <span>$${Number(subtotal).toFixed(2)}</span>
                        </div>
                        ${descuento > 0 ? `
                        <div class="orden-descuento">
                            <span class="orden-descuento-label">Descuento:</span>
                            <span class="orden-descuento-valor">-$${Number(descuento).toFixed(2)}</span>
                        </div>
                        ` : ''}
                        <div class="orden-total-bar">
                            <span>TOTAL A PAGAR:</span>
                            <span class="orden-total-valor">$${Number(total).toFixed(2)}</span>
                        </div>
                    </div>
                </div>
            </div>

            <!-- MÉTODO DE PAGO -->
            <div class="orden-section">
                <div class="orden-section-title">Información de Pago</div>
                <div class="orden-section-content">
                    <div class="orden-pago-item">
                        <div class="orden-pago-label">Banco</div>
                        <div class="orden-pago-valor">${orden.cuenta?.nombreBanco || '-'}</div>
                    </div>
                    <div class="orden-pago-item">
                        <div class="orden-pago-label">Número de Cuenta</div>
                        <div class="orden-pago-valor-monospace">${orden.cuenta?.accountNumber || '-'}</div>
                    </div>
                    <div class="orden-pago-item">
                        <div class="orden-pago-label">Referencia de Pago</div>
                        <div class="orden-pago-valor">${`${orden.cliente.nombre || ''} ${orden.cliente.apellidos || ''}`.trim() || '-'}</div>
                    </div>
                    <div class="orden-pago-item">
                        <div class="orden-pago-label">Beneficiario</div>
                        <div class="orden-pago-valor">${orden.cuenta?.beneficiary || '-'}</div>
                    </div>
                </div>
            </div>

            <!-- MENSAJE FINAL -->
            <div class="orden-mensaje-final">
                <div class="orden-mensaje-texto">
                    <p style="margin: 0.5rem 0; line-height: 1.5;"><strong>1.</strong> Realiza tu pago con los datos mostrados arriba.</p>
                    <p style="margin: 0.5rem 0; line-height: 1.5;"><strong>2.</strong> Guarda tu comprobante.</p>
                    <p style="margin: 0.5rem 0; line-height: 1.5;"><strong>3.</strong> Súbelo desde <strong>"Subir Comprobante"</strong> o desde <strong>"Mis Boletos"</strong>.</p>
                    <div style="margin: 1rem 0 0 0; padding: 1rem; border-top: 2px solid #1A1A1A; background: #f8f9fa; border-radius: 8px; text-align: center;">
                        <p style="margin: 0; color: #1A1A1A; font-weight: 700; font-size: 1rem; line-height: 1.4;">Cuando completes estos pasos, tu participación quedará lista.</p>
                    </div>
                </div>
            </div>
        </div>
    `;

    contenedor.innerHTML = html;
}

/* ============================================================ */
/* SECCIÓN 4: CONSTRUCCIÓN DE MENSAJES PARA WHATSAPP           */
/* ============================================================ */

/**
 * makeOrderMessage - Construye el mensaje de orden para el cliente
 * @param {Object} ord - Objeto con datos de la orden
 * @returns {string} Mensaje formateado para WhatsApp
 */
function imprimirOrden() {
    const docEl = document.getElementById('documentoPDF');
    if (!docEl) {
        rifaplusUtils.showFeedback('❌ No hay documento para descargar', 'error');
        return;
    }

    try {
        if (typeof window.html2canvas !== 'function') {
            rifaplusUtils.showFeedback('❌ html2canvas no está disponible', 'error');
            return;
        }
        if (!window.jspdf || typeof window.jspdf.jsPDF !== 'function') {
            rifaplusUtils.showFeedback('❌ jsPDF no está disponible', 'error');
            return;
        }
        
        rifaplusUtils.showFeedback('⏳ Generando PDF profesional...', 'info');
        
        // SOLUCIÓN: Clonar el elemento en un contenedor oculto con ancho de desktop
        // Esto garantiza captura perfecta sin afectar la página
        
        const container = document.createElement('div');
        container.style.position = 'fixed';
        container.style.left = '-9999px';  // Fuera de vista
        container.style.top = '0';
        container.style.width = '1000px';  // Ancho de DESKTOP
        container.style.display = 'block';
        container.style.zIndex = '-9999';
        
        // Clonar el elemento completo
        const clone = docEl.cloneNode(true);
        container.appendChild(clone);
        document.body.appendChild(container);
        
        // Esperar a que se renderice el clone
        setTimeout(() => {
            // Capturar el clon (no el original)
            window.html2canvas(clone, {
                scale: 2,                   // Buena calidad
                useCORS: true,
                logging: false,
                allowTaint: true,
                backgroundColor: '#ffffff',
                imageTimeout: 0,
                width: 1000,                // Ancho exacto
                windowWidth: 1000
            }).then(canvas => {
                // Eliminar el contenedor clonado
                document.body.removeChild(container);
                
                // Convertir a imagen JPEG
                const imgData = canvas.toDataURL('image/jpeg', 0.92);
                const { jsPDF } = window.jspdf;
                
                // Crear PDF A4
                const pdf = new jsPDF({
                    unit: 'mm',
                    format: 'a4',
                    orientation: 'portrait',
                    compress: true
                });
                
                const pdfWidth = 210;
                const pdfHeight = 297;
                const margin = 10;
                const availableWidth = pdfWidth - (margin * 2);  // 190mm
                const availableHeight = pdfHeight - (margin * 2); // 277mm
                
                // Calcular proporciones
                const canvasRatio = canvas.height / canvas.width;
                const imgHeight = availableWidth * canvasRatio;
                
                // Calcular cuántas páginas se necesitan
                const pagesNeeded = Math.ceil(imgHeight / availableHeight);
                
                if (pagesNeeded === 1) {
                    // Cabe en una página - centrar verticalmente
                    const yPos = margin + ((availableHeight - imgHeight) / 2);
                    pdf.addImage(imgData, 'JPEG', margin, yPos, availableWidth, imgHeight);
                } else {
                    // Necesita múltiples páginas - dividir la imagen inteligentemente
                    const heightPerPage = imgHeight / pagesNeeded;
                    
                    for (let i = 0; i < pagesNeeded; i++) {
                        if (i > 0) {
                            pdf.addPage('a4', 'portrait');
                        }
                        
                        // Usar crop para mostrar la porción correcta de la imagen en cada página
                        const sourceY = (i / pagesNeeded) * canvas.height;
                        const sourceHeight = canvas.height / pagesNeeded;
                        
                        // Crear un canvas temporal con la porción de la imagen
                        const tempCanvas = document.createElement('canvas');
                        tempCanvas.width = canvas.width;
                        tempCanvas.height = sourceHeight;
                        const tempCtx = tempCanvas.getContext('2d');
                        tempCtx.drawImage(canvas, 0, sourceY, canvas.width, sourceHeight, 0, 0, canvas.width, sourceHeight);
                        
                        const portionImgData = tempCanvas.toDataURL('image/jpeg', 0.92);
                        pdf.addImage(portionImgData, 'JPEG', margin, margin, availableWidth, heightPerPage);
                    }
                }
                
                const nombreOrdenPdf = esOrdenIdOficialActualOrdenFormal(ordenActual?.ordenId)
                    ? ordenActual.ordenId
                    : Date.now();
                const filename = `orden-${nombreOrdenPdf}.pdf`;
                pdf.save(filename);
                rifaplusUtils.showFeedback('✅ PDF descargado', 'success');
                
            }).catch(err => {
                document.body.removeChild(container);
                console.error('Error al generar PDF:', err);
                rifaplusUtils.showFeedback('❌ Error al generar PDF', 'error');
            });
        }, 100);
        
    } catch (err) {
        console.error('Error al generar PDF:', err);
        rifaplusUtils.showFeedback('❌ Error al generar PDF', 'error');
    }
}

/* ============================================================ */
/* SECCIÓN 6: GUARDADO Y CONFIRMACIÓN DE ORDEN                 */
/* ============================================================ */

/**
 * limpiarCarritoCompletamente - Limpia todo el carrito y localStorage
 * Se llama después de éxito (409 verificado, timeout verificado, o éxito normal)
 * @returns {void}
 */
function limpiarCarritoCompletamente() {
    try {
        // Limpiar localStorage - Todos los keys del carrito
        const keysALimpiar = [
            'rifaplusSelectedNumbers',
            'rifaplus_boletos',
            'rifaplus_cliente',
            'rifaplus_total',
            'rifaplusBoletosCache',
            'rifaplusBoletosTimestamp',
            'rifaplus_oportunidades',                 // Obsoleto: sistema viejo
            'rifaplus_oportunidades_por_boleto',     // Obsoleto: sistema viejo
            'rifaplusOportunidadesCalculadas',       // Obsoleto: sistema viejo
            'rifaplusOportunidadesLoading'           // Obsoleto: sistema viejo
        ];
        
        keysALimpiar.forEach(key => {
            try {
                removeItemSafeOrden(key);
            } catch (e) {
                console.warn(`⚠️  Error removiendo ${key}:`, e.message);
            }
        });
        
        // Limpiar objeto global del carrito
        if (typeof selectedNumbersGlobal !== 'undefined' && selectedNumbersGlobal?.clear) {
            try {
                selectedNumbersGlobal.clear();
            } catch (e) {
                console.warn('⚠️  Error limpiando selectedNumbersGlobal:', e?.message);
            }
        }
        
        // Actualizar UI
        if (typeof actualizarVistaCarritoGlobal === 'function') {
            try { 
                actualizarVistaCarritoGlobal();
            } catch (e) { 
                console.warn('⚠️  Error actualizando vista:', e); 
            }
        }
        if (typeof actualizarContadorCarritoGlobal === 'function') {
            try { 
                actualizarContadorCarritoGlobal();
            } catch (e) { 
                console.warn('⚠️  Error actualizando contador:', e); 
            }
        }
    } catch (e) {
        console.error('❌ Error crítico limpiando carrito:', e);
    }
}

/**
 * guardarOrden - Guarda la orden en backend y redirige a página de confirmación
 * @async
 * @returns {Promise<void>}
 */
async function guardarOrden() {
    if (!ordenActual) {
        rifaplusUtils.showFeedback('❌ No hay orden para guardar', 'error');
        return;
    }

    // Prevenir múltiples clics
    if (window.guardandoOrden) {
        console.warn('⚠️  Ya hay una orden en proceso de guardado');
        return;
    }

    window.guardandoOrden = true;

    try {
        // Mostrar modal de loading
        const modalLoading = document.getElementById('modalLoadingOrden');
        const btnContinuar = document.getElementById('btnContinuarOrdenFormal');
        if (modalLoading) {
            modalLoading.style.display = 'flex';
            // Iniciar contador de tiempo
            let segundos = 0;
            const contadorInterval = setInterval(() => {
                segundos++;
                const tiempoEl = document.getElementById('tiempoTranscurrido');
                if (tiempoEl) tiempoEl.textContent = `Tiempo: ${segundos}s`;
                // Si no se completa en 120 segundos, mostrar advertencia
                if (segundos > 120) {
                    const pEl = document.getElementById('tiempoTranscurrido');
                    if (pEl) pEl.style.color = '#ff6b6b';
                }
            }, 1000);
            window.contadorOrdenInterval = contadorInterval;
        }
        if (btnContinuar) btnContinuar.disabled = true;
        
        // Mostrar mensaje de envío
        rifaplusUtils.showFeedback('📤 Guardando orden en la base de datos...', 'loading');
        
        // VALIDACIÓN 1: Datos básicos de orden
        if (!ordenActual.cliente) {
            throw new Error('Datos del cliente incompletos');
        }
        if (!ordenActual.boletos) {
            throw new Error('No hay boletos en la orden');
        }

        // VALIDACIÓN 2: Asegurar que boletos es un array válido
        let boletosArray = ordenActual.boletos;
        if (!Array.isArray(boletosArray)) {
            console.error('❌ boletosArray no es array:', { type: typeof boletosArray, value: boletosArray });
            throw new Error('Los boletos deben ser un array válido');
        }

        if (boletosArray.length === 0) {
            throw new Error('Se requiere al menos un boleto');
        }

        // VALIDACIÓN 3: Limpiar y validar cada boleto
        boletosArray = boletosArray
            .map(b => {
                const num = Number(b);
                if (isNaN(num)) {
                    console.warn(`⚠️  Boleto no válido: ${b}`);
                    return null;
                }
                return num;
            })
            .filter(b => b !== null && b >= 0);

        if (boletosArray.length === 0) {
            throw new Error('No hay boletos válidos para guardar');
        }

        // ✅ OPTIMIZACIÓN: Verificación de disponibilidad DELEGADA AL SERVIDOR
        // El servidor ya valida y maneja race conditions con transacciones
        // Omitimos el check en cliente para ahorrar roundtrip y transferencia de datos
        logOrdenFormalDebug('[Orden-Formal] Verificación delegada al servidor');

        // VALIDACIÓN 4: Datos del cliente
        const nombre = (ordenActual.cliente.nombre || '').trim();
        const whatsapp = (ordenActual.cliente.whatsapp || '').trim();
        
        if (!nombre || nombre.length < 2) {
            throw new Error('Nombre del cliente requerido (mín. 2 caracteres)');
        }

        if (!whatsapp || whatsapp.replace(/[^0-9]/g, '').length < 10) {
            throw new Error('Teléfono/WhatsApp inválido');
        }

        // VALIDACIÓN 5: Datos monetarios
        const subtotalSource = ordenActual.totales?.subtotal ?? ordenActual.totales?.total;
        const totalFinalSource = ordenActual.totales?.totalFinal ?? ordenActual.totales?.total;
        const subtotal = Number(subtotalSource ?? 0);
        const totalFinal = Number(totalFinalSource ?? 0);

        if (subtotal <= 0) {
            throw new Error('El subtotal debe ser mayor a 0');
        }

        if (totalFinal < 0) {
            throw new Error('El total final no puede ser negativo');
        }

        // Preparar payload validado
        const ordenIdPayload = esOrdenIdOficialActualOrdenFormal(ordenActual.ordenId)
            ? String(ordenActual.ordenId).trim().toUpperCase().slice(0, 50)
            : '';

        const payload = {
            ordenId: ordenIdPayload,
            nombre_sorteo: window.rifaplusConfig?.rifa?.nombre || 'Sorteo',  // Nombre del sorteo from config
            cliente: {
                nombre: nombre.slice(0, 100),
                apellidos: (ordenActual.cliente.apellidos || '').trim().slice(0, 100),
                whatsapp: whatsapp.slice(0, 20),
                estado: (ordenActual.cliente.estado || '').trim().slice(0, 50),
                ciudad: (ordenActual.cliente.ciudad || '').trim().slice(0, 50)
            },
            boletos: boletosArray,
            cantidad_boletos: boletosArray.length,  // ✅ AGREGADO: cantidad de boletos
            totales: {
                subtotal: Math.round(subtotal * 100) / 100,
                descuento: Math.max(0, Math.round((parseFloat(ordenActual.totales?.descuento) || 0) * 100) / 100),
                totalFinal: Math.round(totalFinal * 100) / 100,
                combo: ordenActual.totales?.combo || null
            },
            cuenta: ordenActual.cuenta || {},
            precioUnitario: (function(){
                const p1 = parseFloat(ordenActual.totales?.precioUnitario);
                if (!Number.isNaN(p1) && p1 > 0) return p1;
                if (typeof obtenerPrecioDinamico === 'function') return obtenerPrecioDinamico();
                return window.rifaplusConfig?.obtenerPrecioBoleto?.() || Number(window.rifaplusConfig?.rifa?.precioBoleto || 0);
            })(),
            metodoPago: 'transferencia',
            notas: '',
            // ✅ INCLUIR OPORTUNIDADES EN EL PAYLOAD (para persistencia en BD)
            // Las oportunidades fueron calculadas y sincronizadas antes
            boletosOcultos: Array.isArray(ordenActual.boletosOcultos) ? ordenActual.boletosOcultos : []
        };
        
        logOrdenFormalDebug('[Orden-Formal] Payload construido con boletosOcultos:', {
            cantidad: payload.boletosOcultos.length,
            oportunidades: payload.boletosOcultos
        });

        // VALIDACIÓN 6: Consistencia de precio
        const precioCalculado = boletosArray.length * payload.precioUnitario;
        const diferencia = Math.abs(precioCalculado - payload.totales.subtotal);
        if (diferencia > 0.01 * boletosArray.length) {  // Permitir pequeña diferencia por redondeos
            console.warn(`⚠️  Diferencia de precio: calculado=${precioCalculado}, enviado=${payload.totales.subtotal}`);
            // No fallar, pero avisar
        }

        // ENVÍO AL SERVIDOR CON TIMEOUT Y REINTENTOS
        const apiBase = window.rifaplusConfig?.backend?.apiBase
            || window.rifaplusConfig?.obtenerApiBase?.()
            || window.location.origin;
        const apiUrl = `${apiBase}/api/ordenes`;
        const maxReintentos = 5;
        let ultimoError = null;

        // Calcular timeout dinámico según cantidad de boletos
        // ✅ OPTIMIZADO v5: Timeouts adaptativos para diferentes conexiones
        // - Fast (>= 1Mbps): 5s base + 5ms por boleto
        // - Normal (100-1000 Kbps): 8s base + 15ms por boleto  
        // - Slow (< 100 Kbps): 12s base + 25ms por boleto
        // 
        // Ejemplos (con velocidad Normal asumida):
        // - 100 boletos: 8000 + 1500 = 9.5s ✅
        // - 500 boletos: 8000 + 7500 = 15.5s ✅
        // - 1000 boletos: 8000 + 15000 = 23s ✅
        // - 10000 boletos: 8000 + 150000 = 158s (máx: 120s) = 120s ✅
        const cantidadBoletos = boletosArray.length;
        const baseTimeout = 8000;  // 8 segundos base (conexión normal)
        const msPerBoleto = 15;    // 15ms por boleto (conservador)
        const timeoutMs = Math.max(8000, Math.min(120000, baseTimeout + (cantidadBoletos * msPerBoleto)));
        logOrdenFormalDebug(`[Orden-Formal] Timeout dinámico: ${timeoutMs}ms para ${cantidadBoletos} boletos`);

        for (let intento = 1; intento <= maxReintentos; intento++) {
            try {
                logOrdenFormalDebug(`[Orden-Formal] Intento ${intento}/${maxReintentos} de guardar orden`);

                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), timeoutMs);  // Timeout dinámico

                const fetchHeaders = {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                };
                const currentParams = new URLSearchParams(window.location.search);
                const activeSlug = currentParams.get('rifa') || currentParams.get('slug') || window.rifaplusConfig?.rifa?.slug;
                if (activeSlug) {
                    fetchHeaders['x-rifaplus-rifa-slug'] = activeSlug;
                }

                const response = await fetch(apiUrl, {
                    method: 'POST',
                    headers: fetchHeaders,
                    body: JSON.stringify(payload),
                    mode: 'cors',
                    signal: controller.signal,
                    credentials: 'omit'
                });

                clearTimeout(timeoutId);

                // PROCESAR RESPUESTA
                if (!response.ok) {
                    let errorData = {};
                    try {
                        errorData = await response.json();
                    } catch (parseError) {
                        console.warn('No se pudo parsear respuesta de error:', parseError);
                    }

                    const mensajeError = errorData.message || `Error ${response.status}`;
                    console.error(`❌ Error HTTP ${response.status}:`, errorData);
                    
                    // Errores que SÍ se pueden reintentar
                    if (response.status >= 500 && intento < maxReintentos) {
                        // Backoff exponencial mejorado: 2s, 4s, 8s (en lugar de 2s, 4s, 6s)
                        const delayMs = 1000 * Math.pow(2, intento - 1);
                        ultimoError = `Error servidor (${response.status}). Reintentando en ${(delayMs/1000).toFixed(1)}s...`;
                        logOrdenFormalDebug(`[Orden-Formal] ${ultimoError}`);
                        await new Promise(resolve => setTimeout(resolve, delayMs));
                        continue;
                    }

                    // Manejo específico de 429 RATE_LIMIT_ORDENES: respetar retryAfterSeconds y reintentar con backoff
                    if (response.status === 429 && errorData && errorData.code === 'RATE_LIMIT_ORDENES') {
                        const retryAfter = Number(errorData.retryAfterSeconds) || 1;
                        if (intento < maxReintentos) {
                            const waitMs = retryAfter * 1000 * intento; // aumentar espera por intento
                            logOrdenFormalDebug(`[Orden-Formal] RATE_LIMIT_ORDENES recibido. Esperando ${waitMs}ms antes de reintentar (intento ${intento})`);
                            await new Promise(resolve => setTimeout(resolve, waitMs));
                            continue;
                        } else {
                            // Último intento: notificar al usuario de forma clara
                            alert('El servidor está recibiendo muchas solicitudes. Por favor espera unos segundos y vuelve a intentar. Si el problema persiste, inténtalo más tarde.');
                            return;
                        }
                    }

                    // Errores que NO se reintentan
                    if (response.status === 409) {
                        // Error 409 = Conflicto de boletos
                        logOrdenFormalDebug('[Orden-Formal] Conflicto 409 detectado');

                        // ✅ Manejo elegante de conflictos - ÚNICA verificación
                        if (errorData.code === 'BOLETOS_CONFLICTO' && typeof window.ModalConflictoBoletos !== 'undefined') {
                            logOrdenFormalDebug('[Orden-Formal] Mostrando modal de conflicto de boletos');
                            
                            // Mostrar modal al usuario
                            const opcionUsuario = await window.ModalConflictoBoletos.manejarConflicto(errorData);
                            
                            if (opcionUsuario.opcion === 'elegir_otros') {
                                // Usuario quiere elegir otros boletos
                                logOrdenFormalDebug('[Orden-Formal] Usuario decidió elegir otros boletos');

                                // Eliminar boletos conflictivos del carrito
                                if (typeof window.removerBoletoSeleccionado === 'function') {
                                    errorData.boletosConflicto.forEach(boleto => {
                                        window.removerBoletoSeleccionado(boleto);
                                    });
                                } else {
                                    console.warn('⚠️  removerBoletoSeleccionado no disponible, removiendo manualmente...');
                                    // Fallback manual si la función no está disponible
                                    let stored = getItemSafeOrden('rifaplusSelectedNumbers');
                                    let numbers = stored ? JSON.parse(stored).map(n => parseInt(n, 10)) : [];
                                    numbers = numbers.filter(n => !errorData.boletosConflicto.includes(n));
                                    setItemSafeOrden('rifaplusSelectedNumbers', JSON.stringify(numbers));
                                }

                                // Volver a la tienda para que seleccione otros
                                alert('Por favor, selecciona otros boletos de la tienda.\n\n✓ Los boletos en conflicto han sido removidos automáticamente de tu carrito.');
                                window.location.href = 'compra.html';
                                return;
                            } else if (opcionUsuario.opcion === 'continuar_sin_conflicto') {
                                // Usuario quiere continuar sin los boletos conflictivos
                                logOrdenFormalDebug('[Orden-Formal] Usuario continúa sin los boletos conflictivos:', opcionUsuario.boletosSeleccionados);
                                
                                // Actualizar payload con boletos disponibles
                                payload.boletos = opcionUsuario.boletosSeleccionados;
                                boletosArray = opcionUsuario.boletosSeleccionados;
                                
                                // 🔴 CRÍTICO: Limpiar localStorage de boletos para sincronizar UI
                                setItemSafeOrden('rifaplusSelectedNumbers', JSON.stringify(boletosArray));
                                
                                // ✅ CRÍTICO: Recalcular oportunidades removiendo las de boletos conflictivos
                                // Usar el array original de oportunidades que ya tenemos en memoria
                                let oportunidadesFinales = [];
                                
                                try {
                                    // Obtener oportunidades por boleto del localStorage (antes de limpiar)
                                    const oportunidadesGuardadas = getItemSafeOrden('rifaplus_oportunidades');
                                    if (oportunidadesGuardadas) {
                                        const datosOpp = JSON.parse(oportunidadesGuardadas);
                                        
                                        // Crear mapa de oportunidades por boleto ANTES de eliminar
                                        const oportunidadesPorBoletoCopia = JSON.parse(JSON.stringify(datosOpp.oportunidadesPorBoleto || {}));
                                        
                                        // Reconstruir array SOLO con boletos que permanecen
                                        if (oportunidadesPorBoletoCopia) {
                                            boletosArray.forEach(boletoBueno => {
                                                const oppsDelBoleto = oportunidadesPorBoletoCopia[boletoBueno];
                                                if (Array.isArray(oppsDelBoleto)) {
                                                    oportunidadesFinales.push(...oppsDelBoleto);
                                                }
                                            });
                                        }
                                        
                                        logOrdenFormalDebug('[Orden-Formal] Oportunidades recalculadas:', {
                                            boletos: boletosArray.length,
                                            oportunidades: oportunidadesFinales.length,
                                            porBoleto: Math.round(oportunidadesFinales.length / boletosArray.length)
                                        });
                                        
                                        // Ahora sí: remover oportunidades de boletos conflictivos del caché
                                        if (datosOpp.oportunidadesPorBoleto) {
                                            errorData.boletosConflicto.forEach(boletoCon => {
                                                delete datosOpp.oportunidadesPorBoleto[boletoCon];
                                            });
                                        }
                                        
                                        // Guardar caché actualizado
                                        localStorage.setItem('rifaplus_oportunidades', JSON.stringify(datosOpp));
                                    } else {
                                        // ✅ FALLBACK DINÁMICO: Calcular opps por boleto desde array original
                                        if (Array.isArray(ordenActual.boletosOcultos)) {
                                            const oppsActuales = ordenActual.boletosOcultos;
                                            const boletosOriginales = payload.boletos.length + errorData.boletosConflicto.length;
                                            
                                            // Calcular dinámicamente: opps por boleto
                                            const oppsPerBoleto = boletosOriginales > 0 
                                                ? Math.round(oppsActuales.length / boletosOriginales)
                                                : 0;
                                            
                                            // Tomar solo la cantidad correspondiente a boletos restantes
                                            const oppsTargetCount = boletosArray.length * oppsPerBoleto;
                                            oportunidadesFinales = oppsActuales.slice(0, oppsTargetCount);
                                            
                                            console.warn('⚠️  FALLBACK DINÁMICO usado:', {
                                                boletosOriginales,
                                                boletosRestantes: boletosArray.length,
                                                oppsPerBoleto,
                                                oppsActuales: oppsActuales.length,
                                                oppsFinales: oportunidadesFinales.length
                                            });
                                        }
                                    }
                                } catch (e) {
                                    console.warn('⚠️  Error recalculando oportunidades:', e.message);
                                    // Último recurso: usar array original sin filtro pero logged
                                    if (Array.isArray(ordenActual.boletosOcultos)) {
                                        oportunidadesFinales = ordenActual.boletosOcultos;
                                        console.error('🔴 CRÍTICO: No se pudo recalcular, usando array original sin filtro');
                                    }
                                }
                                
                                // Actualizar payload y ordenActual con oportunidades correctas
                                payload.boletosOcultos = oportunidadesFinales;
                                ordenActual.boletosOcultos = oportunidadesFinales;
                                
                                logOrdenFormalDebug('[Orden-Formal] Payload actualizado después de conflicto:', {
                                    boletos: boletosArray.length,
                                    oportunidades: oportunidadesFinales.length
                                });
                                
                                // Recalcular totales
                                const precioUnitarioActual = Number(payload.precioUnitario)
                                    || window.rifaplusConfig?.obtenerPrecioBoleto?.()
                                    || Number(window.rifaplusConfig?.rifa?.precioBoleto || 0);
                                payload.cantidad_boletos = boletosArray.length;
                                payload.totales = {
                                    subtotal: boletosArray.length * precioUnitarioActual,
                                    descuentoMonto: 0,
                                    totalFinal: boletosArray.length * precioUnitarioActual
                                };
                                
                                // ✅ VALIDACIÓN DE INTEGRIDAD
                                const validacionPayload = {
                                    boletos: Array.isArray(payload.boletos) && payload.boletos.length > 0,
                                    totales: payload.totales
                                        && Number.isFinite(Number(payload.totales.subtotal))
                                        && Number(payload.totales.subtotal) > 0
                                        && Number.isFinite(Number(payload.totales.totalFinal))
                                        && Number(payload.totales.totalFinal) >= 0,
                                    precio: payload.precioUnitario > 0
                                };

                                if (!Object.values(validacionPayload).every(v => v)) {
                                    console.error('❌ Payload corrupto:', validacionPayload);
                                    throw new Error('PAYLOAD_INTEGRITY_CHECK_FAILED');
                                }
                                
                                logOrdenFormalDebug('[Orden-Formal] Reintentando con boletos filtrados');
                                continue;
                            }
                        }

                        // Sin modal: error directo del servidor
                        console.warn('Modal de conflicto no disponible');
                        if (errorData.boletosConflicto) {
                            throw new Error(
                                `Boletos conflictivos: ${errorData.boletosConflicto.join(', ')}. Intenta otros.`
                            );
                        }
                        throw crearErrorOrdenFormal('Error 409: Conflicto al guardar la orden.', {
                            code: errorData.code || 'BOLETOS_CONFLICTO',
                            status: response.status,
                            serverMessage: mensajeError
                        });
                    }
                    if (response.status >= 400 && response.status < 500) {
                        throw crearErrorOrdenFormal(`Error en los datos: ${mensajeError}`, {
                            code: errorData.code || 'ERROR_DATOS_ORDEN',
                            status: response.status,
                            serverMessage: mensajeError
                        });
                    }

                    throw crearErrorOrdenFormal(`Error del servidor: ${mensajeError}`, {
                        code: errorData.code || 'ERROR_SERVIDOR_ORDEN',
                        status: response.status,
                        serverMessage: mensajeError
                    });
                }

                // ÉXITO - Procesar respuesta (incluye 200 OK para órdenes duplicadas idempotentes)
                const respuestaExitosa = await response.json();
                
                if (respuestaExitosa.success) {
                    // Detectar si fue una orden duplicada (idempotencia)
                    const esIdempotente = response.status === 200 && respuestaExitosa.message?.includes('idempotencia');
                    if (esIdempotente) {
                        logOrdenFormalDebug('[Orden-Formal] Orden duplicada detectada por idempotencia:', respuestaExitosa.ordenId);
                    } else {
                        logOrdenFormalDebug('[Orden-Formal] Orden guardada en BD:', respuestaExitosa);
                    }
                } else {
                    console.error('❌ Respuesta no exitosa:', respuestaExitosa);
                    throw new Error(respuestaExitosa.message || 'Respuesta no exitosa del servidor');
                }

                const totalesOficiales = respuestaExitosa?.data?.totales;
                if (totalesOficiales) {
                    payload.ordenId = respuestaExitosa?.data?.numero_orden || respuestaExitosa?.ordenId || payload.ordenId;
                    payload.totales = {
                        subtotal: Number(totalesOficiales.subtotal || 0),
                        descuento: Number(totalesOficiales.descuento || 0),
                        totalFinal: Number(totalesOficiales.totalFinal || 0),
                        precioUnitario: Number(totalesOficiales.precioUnitario || payload.precioUnitario || 0),
                        combo: totalesOficiales.combo || payload.totales?.combo || null
                    };
                    payload.precioUnitario = Number(totalesOficiales.precioUnitario || payload.precioUnitario || 0);
                    logOrdenFormalDebug('[Orden-Formal] Totales oficiales aplicados al cliente:', payload.totales);
                }

                if (payload.ordenId) {
                    ordenActual.ordenId = payload.ordenId;
                    ordenActual.ordenIdVisible = payload.ordenId;

                    try {
                        const clientePersistido = JSON.parse(getItemSafeOrden('rifaplus_cliente') || '{}');
                        clientePersistido.ordenId = payload.ordenId;
                        setItemSafeOrden('rifaplus_cliente', JSON.stringify(clientePersistido));
                    } catch (errorActualizandoCliente) {
                        console.warn('⚠️ [Orden-Formal] No se pudo persistir el ordenId oficial:', errorActualizandoCliente?.message || errorActualizandoCliente);
                    }

                    setItemSafeOrden('rifaplus_orden_actual', JSON.stringify(ordenActual));
                }

                // ⭐ OCULTAR LOADING INMEDIATAMENTE (cuando se crea exitosamente la orden)
                const modalLoadingSuccess = document.getElementById('modalLoadingOrden');
                if (modalLoadingSuccess) {
                    modalLoadingSuccess.style.display = 'none';
                }
                
                // Limpiar contador
                if (window.contadorOrdenInterval) {
                    clearInterval(window.contadorOrdenInterval);
                    window.contadorOrdenInterval = null;
                }

                // ACTUALIZAR DISPONIBILIDAD
                if (typeof cargarBoletosPublicos === 'function') {
                    try {
                        await cargarBoletosPublicos();
                    } catch (e) {
                        console.warn('⚠️  No se pudo actualizar disponibilidad:', e?.message);
                    }
                }
                
                // ✅ CONSOLIDADO: Usar la función unificada limpiarCarritoCompletamente()
                limpiarCarritoCompletamente();
                
                // GUARDAR DATOS FINALES de la orden para confirmación
                const datosFinalesOrden = {
                    ordenId: payload.ordenId,
                    boletos: payload.boletos,
                    boletosOcultos: payload.boletosOcultos,
                    cantidad_boletos: payload.cantidad_boletos,
                    cantidad_oportunidades: Number(respuestaExitosa?.data?.cantidad_oportunidades ?? payload.boletosOcultos?.length ?? 0),
                    totales: payload.totales,
                    cliente: payload.cliente,
                    fecha: new Date().toISOString()
                };
                
                setItemSafeOrden('rifaplus_orden_final', JSON.stringify(datosFinalesOrden));
                setItemSafeOrden('rifaplus_orden_confirmada', 'true');
                setItemSafeOrden('rifaplus_orden_url', respuestaExitosa.url || '');
                logOrdenFormalDebug('[Orden-Formal] Orden guardada para confirmación:', datosFinalesOrden);

                window.RifaPlusMetaPixel?.trackPurchase?.({
                    content_name: window.rifaplusConfig?.rifa?.nombreSorteo || 'Sorteo',
                    content_category: 'rifa',
                    content_type: 'product',
                    content_ids: Array.isArray(datosFinalesOrden.boletos)
                        ? datosFinalesOrden.boletos.map((numero) => String(numero))
                        : [],
                    num_items: Number(datosFinalesOrden.cantidad_boletos || 0),
                    value: Number(datosFinalesOrden?.totales?.totalFinal || 0),
                    currency: 'MXN'
                });
                
                // ⭐ MOSTRAR MODAL Y AUTO-REDIRIGIR A MIS BOLETOS
                logOrdenFormalDebug('[Orden-Formal] Mostrando modal de orden confirmada');
                if (typeof mostrarModalOrdenConfirmada === 'function') {
                    const totalOportunidades = Number.isFinite(Number(datosFinalesOrden.cantidad_oportunidades))
                        ? Number(datosFinalesOrden.cantidad_oportunidades)
                        : (Array.isArray(datosFinalesOrden.boletosOcultos)
                            ? datosFinalesOrden.boletosOcultos.length
                            : 0);
                    
                    mostrarModalOrdenConfirmada({
                        ordenId: datosFinalesOrden.ordenId,
                        sorteo: window.rifaplusConfig?.rifa?.nombreSorteo || 'Sorteo',
                        cliente: datosFinalesOrden.cliente,
                        cantidad_boletos: datosFinalesOrden.cantidad_boletos || 0,
                        oportunidades: totalOportunidades,
                        totales: datosFinalesOrden.totales
                    });
                } else {
                    // Fallback si el modal no está cargado
                    console.warn('Modal no disponible, redirigiendo directamente');
                    try {
                        sessionStorage.setItem('rifaplus_skip_mis_boletos_shell_once', 'true');
                    } catch (error) {
                        // Ignorar errores de storage para no bloquear la navegación.
                    }
                    const destinoMisBoletos = typeof window.rifaplusConfig?.construirUrlMisBoletos === 'function'
                        ? window.rifaplusConfig.construirUrlMisBoletos({
                            ordenId: datosFinalesOrden.ordenId,
                            autoOpen: true
                        })
                        : `mis-boletos.html?ordenId=${encodeURIComponent(datosFinalesOrden.ordenId)}&autoOpen=true`;
                    window.location.href = destinoMisBoletos;
                }
                
                return;  // ÉXITO - salir del loop de reintentos

            } catch (fetchError) {
                ultimoError = fetchError.message;
                
                if (fetchError.name === 'AbortError') {
                    console.error(`⏱️  Timeout en intento ${intento}`);
                    ultimoError = 'Timeout de conexión. Verificando si la orden se guardó...';
                    
                    // Si fue timeout, verificar si la orden se guardó en el servidor
                    if (intento === maxReintentos) {
                        logOrdenFormalDebug('[Orden-Formal] Verificando si la orden existe en el servidor tras timeout final');
                        try {
                            // Usar un timeout más corto para el polling
                            const pollController = new AbortController();
                            const pollTimeoutId = setTimeout(() => pollController.abort(), 5000);
                            
                            const nombreCliente = payload.cliente?.nombre || '';
                            const whatsappCliente = payload.cliente?.whatsapp || '';
                            const cantidadBoletos = payload.boletos?.length || 0;
                            
                            // Búsqueda por nombre + whatsapp (datos que SÍ tenemos)
                            const searchUrl = `${apiBase}/api/ordenes/por-cliente/dummy?nombre=${encodeURIComponent(nombreCliente)}&whatsapp=${encodeURIComponent(whatsappCliente)}`;
                            
                            const searchHeaders = { 'Content-Type': 'application/json' };
                            const activeSlug = currentParams.get('rifa') || currentParams.get('slug') || window.rifaplusConfig?.rifa?.slug;
                            if (activeSlug) {
                                searchHeaders['x-rifaplus-rifa-slug'] = activeSlug;
                            }
                            
                            const checkResponse = await fetch(searchUrl, {
                                method: 'GET',
                                headers: searchHeaders,
                                credentials: 'omit',
                                signal: pollController.signal
                            });
                            
                            clearTimeout(pollTimeoutId);
                            
                            if (checkResponse.ok) {
                                const ordenes = await checkResponse.json();
                                // Buscar orden MÁS RECIENTE con cantidad similar
                                if (Array.isArray(ordenes) && ordenes.length > 0) {
                                    const ordenReciente = ordenes[0]; // Primera (más reciente)
                                    
                                    if (ordenReciente.cantidad_boletos === cantidadBoletos) {
                                        logOrdenFormalDebug('[Orden-Formal] La orden se encontró en el servidor después del timeout:', ordenReciente.numero_orden);
                                        try {
                                            sessionStorage.setItem('rifaplus_skip_mis_boletos_shell_once', 'true');
                                        } catch (error) {
                                            // Ignorar errores de storage para no bloquear la navegación.
                                        }
                                        const destinoMisBoletos = typeof window.rifaplusConfig?.construirUrlMisBoletos === 'function'
                                            ? window.rifaplusConfig.construirUrlMisBoletos({
                                                ordenId: ordenReciente.numero_orden,
                                                autoOpen: true
                                            })
                                            : `mis-boletos.html?ordenId=${encodeURIComponent(ordenReciente.numero_orden)}&autoOpen=true`;
                                        window.location.href = destinoMisBoletos;
                                        return;
                                    }
                                }
                            }
                        } catch (checkError) {
                            console.warn('No se pudo verificar si la orden existe (polling falló):', checkError.message);
                            // Si el polling falla, asumir que la orden SÍ se guardó
                            // porque llegó al último reintento con timeout
                            logOrdenFormalDebug('[Orden-Formal] Asumiendo guardado tras timeout final y redirigiendo');
                            // Usar última orden conocida para la redirección
                            const ordenId = datosFinalesOrden?.numero_orden || payload?.cliente?.ordenId || 'unknown';
                            try {
                                sessionStorage.setItem('rifaplus_skip_mis_boletos_shell_once', 'true');
                            } catch (error) {
                                // Ignorar errores de storage para no bloquear la navegación.
                            }
                            const destinoMisBoletos = typeof window.rifaplusConfig?.construirUrlMisBoletos === 'function'
                                ? window.rifaplusConfig.construirUrlMisBoletos({
                                    ordenId,
                                    autoOpen: true
                                })
                                : `mis-boletos.html?ordenId=${encodeURIComponent(ordenId)}&autoOpen=true`;
                            window.location.href = destinoMisBoletos;
                            return;
                        }
                    }
                } else if (fetchError instanceof TypeError && fetchError.message.includes('Failed to fetch')) {
                    console.error(`🌐 Error de red en intento ${intento}`);
                    ultimoError = 'No se puede conectar al servidor. Verifica tu conexión a internet.';
                } else {
                    console.error(`❌ Error en intento ${intento}:`, fetchError);
                }

                if (intento < maxReintentos) {
                    // ✅ Backoff exponencial con jitter para evitar thundering herd
                    // Intento 1: ~1-2s, Intento 2: ~2-4s, Intento 3: ~4-8s
                    const baseDelay = 1000 * Math.pow(2, intento - 1);
                    const jitter = Math.random() * 1000; // 0-1s jitter
                    const delayMs = baseDelay + jitter;
                    logOrdenFormalDebug(`[Orden-Formal] Reintentando (${intento + 1}/${maxReintentos}) en ${(delayMs/1000).toFixed(1)}s`);
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                    continue;
                }

                throw (typeof ultimoError === 'string'
                    ? crearErrorOrdenFormal(ultimoError)
                    : ultimoError);
            }
        }

    } catch (error) {
        console.error('❌ Error crítico al guardar orden:', error);
        
        // Detectar tipo de error para mensaje más específico
        let mensajeFinal = 'Error desconocido';

        if (typeof error === 'string') {
            if (error === 'PAYLOAD_INTEGRITY_CHECK_FAILED') {
                mensajeFinal = 'Error de integridad en datos de orden. Por favor, intenta de nuevo.';
                console.error('   El payload contiene datos inválidos o corruptos.');
            } else {
                mensajeFinal = error;
            }
        } else if (error?.message) {
            if (error.message.includes('PAYLOAD_INTEGRITY_CHECK_FAILED')) {
                mensajeFinal = 'Los datos de la orden se corrompieron durante el procesamiento. Por favor, intenta de nuevo.';
            } else {
                mensajeFinal = resolverMensajeUsuarioOrdenFormal(error);
            }
        }

        rifaplusUtils.showFeedback(`❌ ${mensajeFinal}`, 'error');
        console.error('   Detalles:', error);
        
    } finally {
        window.guardandoOrden = false;
        
        // Ocultar modal de loading
        const modalLoading = document.getElementById('modalLoadingOrden');
        if (modalLoading) {
            modalLoading.style.display = 'none';
        }
        
        // Limpiar contador
        if (window.contadorOrdenInterval) {
            clearInterval(window.contadorOrdenInterval);
            window.contadorOrdenInterval = null;
        }
        
        // Re-habilitar botón
        const btnContinuar = document.getElementById('btnContinuarOrdenFormal');
        if (btnContinuar) btnContinuar.disabled = false;
    }
}

/**
 * Inicializa los event listeners para botones y modales
 */
document.addEventListener('DOMContentLoaded', function() {
    const btnCancelarOrdenFormal = document.getElementById('btnCancelarOrdenFormal');
    const btnContinuarOrdenFormal = document.getElementById('btnContinuarOrdenFormal');
    const closeOrdenFormal = document.getElementById('closeOrdenFormal');
    const modalOrdenFormal = document.getElementById('modalOrdenFormal');
    const btnDescargarOrdenFormal = document.getElementById('btnDescargarOrdenFormal');

    if (btnCancelarOrdenFormal) {
        btnCancelarOrdenFormal.addEventListener('click', cerrarOrdenFormal);
    }
    if (btnContinuarOrdenFormal) {
        btnContinuarOrdenFormal.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            guardarOrden();
        });
    } else {
        console.warn('⚠️ btnContinuarOrdenFormal NO ENCONTRADO');
    }

    if (btnDescargarOrdenFormal) {
        btnDescargarOrdenFormal.addEventListener('click', function() {
            imprimirOrden();
        });
    }

    if (closeOrdenFormal) {
        closeOrdenFormal.addEventListener('click', cerrarOrdenFormal);
    }

    // NO permitir cerrar al hacer click fuera
    // El modal solo se cierra al hacer clic en "Apartar boletos"
    if (modalOrdenFormal) {
        modalOrdenFormal.addEventListener('click', function(e) {
            // Prevenir que se cierre al hacer click en el fondo (overlay)
            if (e.target === modalOrdenFormal) {
                e.preventDefault();
                e.stopPropagation();
                // NO llamar a cerrarOrdenFormal() aquí
            }
        });
    }
});

/* ============================================================ */
/* EXPORTACIONES GLOBALES                                       */
/* ============================================================ */
window.guardarOrden = guardarOrden;
window.abrirOrdenFormal = abrirOrdenFormal;
window.cerrarOrdenFormal = cerrarOrdenFormal;
window.obtenerOportunidadesValidadasOrdenActual = obtenerOportunidadesValidadasOrdenActual;
