/**
 * ============================================================
 * ARCHIVO: js/modal-orden-confirmada.js
 * DESCRIPCIÓN: Modal de orden confirmada - VERSIÓN PRODUCCIÓN
 * ✓ Validado ✓ Robust ✓ Sin memory leaks ✓ Error handling
 * ÚLTIMA ACTUALIZACIÓN: 5 marzo 2026
 * ============================================================
 */

function normalizarTextoModalOrden(valor, fallback = '-') {
    if (valor === null || valor === undefined || typeof valor === 'object') {
        return fallback;
    }

    return String(valor).trim() || fallback;
}

function construirUrlMisBoletosOrdenConfirmada(ordenId, whatsapp) {
    if (typeof window.rifaplusConfig?.construirUrlMisBoletos === 'function') {
        return window.rifaplusConfig.construirUrlMisBoletos({
            ordenId,
            whatsapp,
            autoOpen: true
        });
    }

    const query = [`ordenId=${encodeURIComponent(ordenId)}`, 'autoOpen=true'];

    if (whatsapp && whatsapp !== '-') {
        query.push(`whatsapp=${encodeURIComponent(whatsapp)}`);
    }

    return `mis-boletos.html?${query.join('&')}`;
}

function notificarErrorModalOrdenConfirmada() {
    if (window.rifaplusUtils?.showFeedback) {
        window.rifaplusUtils.showFeedback('Error al procesar la orden. Por favor intenta de nuevo.', 'error');
        return;
    }

    alert('Error al procesar la orden. Por favor intenta de nuevo.');
}

function prepararRedireccionSinShellMisBoletos() {
    try {
        sessionStorage.setItem('rifaplus_skip_mis_boletos_shell_once', 'true');
    } catch (error) {
        // Ignorar errores de storage para no bloquear la redirección.
    }
}

async function solicitarPermisoNotificacionesOrdenConfirmada() {
    try {
        if (typeof window === 'undefined' || !('Notification' in window)) {
            return { supported: false, permission: 'unsupported' };
        }

        if (Notification.permission === 'granted') {
            return { supported: true, permission: 'granted' };
        }

        if (Notification.permission === 'denied') {
            return { supported: true, permission: 'denied' };
        }

        const permission = await Notification.requestPermission();
        return { supported: true, permission };
    } catch (error) {
        return { supported: true, permission: 'error' };
    }
}

/**
 * mostrarModalOrdenConfirmada - Abre modal con datos de orden
 * @param {Object} datosOrden - Datos de la orden
 */
function mostrarModalOrdenConfirmada(datosOrden) {
    try {
        // ✅ 1. VALIDACIÓN COMPLETA
        if (!datosOrden || typeof datosOrden !== 'object') {
            console.error('❌ [Modal] datosOrden inválido:', datosOrden);
            return;
        }

        if (!datosOrden.ordenId) {
            console.error('❌ [Modal] OrdenId faltante');
            return;
        }

        // Datos validados
        const ordenId = normalizarTextoModalOrden(datosOrden.ordenId);
        const sorteo = normalizarTextoModalOrden(datosOrden.sorteo, 'Sorteo');
        const nombre = `${normalizarTextoModalOrden(datosOrden.cliente?.nombre, '')} ${normalizarTextoModalOrden(datosOrden.cliente?.apellidos, '')}`;
        const whatsapp = normalizarTextoModalOrden(datosOrden.cliente?.whatsapp);
        const boletos = normalizarTextoModalOrden(datosOrden.cantidad_boletos, '0');
        const oportunidadesHabilitadas = window.rifaplusConfig?.rifa?.oportunidades?.enabled === true;
        const oportunidadesNumericas = Number(datosOrden.oportunidades ?? 0);
        const oportunidades = Number.isFinite(oportunidadesNumericas) && oportunidadesNumericas >= 0
            ? oportunidadesNumericas
            : 0;
        const oportunidadesTexto = oportunidades.toLocaleString('es-MX');
        const mostrarResumenOportunidades = oportunidadesHabilitadas || oportunidades > 0;
        const resumenHeroClass = mostrarResumenOportunidades
            ? 'resumen-hero-confirmada--4'
            : 'resumen-hero-confirmada--3';
        const subtotalSource = datosOrden.totales?.subtotal;
        const totalSource = datosOrden.totales?.totalFinal ?? datosOrden.totales?.total;
        const descuentoSource = datosOrden.totales?.descuento ?? datosOrden.totales?.descuentoMonto;
        const subtotalRaw = Number(subtotalSource ?? 0);
        const totalRawBase = Number(totalSource ?? 0);
        const descuentoRawBase = Number(descuentoSource ?? 0);
        const descuentoRaw = descuentoRawBase > 0
            ? descuentoRawBase
            : Math.max(0, subtotalRaw - totalRawBase);
        const totalRaw = totalSource !== null && totalSource !== undefined
            ? totalRawBase
            : Math.max(0, subtotalRaw - descuentoRaw);

        const subtotal = subtotalRaw.toFixed(2);
        const descuento = descuentoRaw.toFixed(2);
        const total = totalRaw.toFixed(2);
        const comboInfo = datosOrden.totales?.combo || null;
        const tiempoApartadoHoras = Number(window.rifaplusConfig?.rifa?.tiempoApartadoHoras || 0);
        const tiempoApartadoTexto = tiempoApartadoHoras > 0
            ? `${tiempoApartadoHoras} hora${tiempoApartadoHoras === 1 ? '' : 's'}`
            : '';
        const nombreVisible = nombre.trim() || 'Participante';
        const urlMisBoletos = construirUrlMisBoletosOrdenConfirmada(ordenId, whatsapp);

        // ✅ 2. CREAR O REUTILIZAR MODAL
        let modal = document.getElementById('modalOrdenConfirmada');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'modalOrdenConfirmada';
            document.body.appendChild(modal);
        }

        // ✅ 3. SETEAR CONTENIDO (sin listeners problemáticos)
        modal.innerHTML = `
            <div class="modal-overlay modal-overlay-orden-confirmada">
                <div class="modal-contenido modal-contenido-orden-confirmada">
                    <div class="modal-header-confirmada">
                        <div class="checkmark-confirmada">✓</div>
                        <div class="estado-chip-confirmada">Orden guardada</div>
                    </div>
                    <div class="modal-body-confirmada">
                        <h2 class="titulo-confirmada">Tu orden fue apartada correctamente</h2>
                        <p class="subtitulo-confirmada">
                            ${nombreVisible}, ya registramos tu orden. En <strong>Mis Boletos</strong> podrás ver el detalle y subir tu comprobante de pago.
                        </p>

                        <div class="resumen-hero-confirmada ${resumenHeroClass}">
                            <div class="resumen-hero-item">
                                <span class="resumen-hero-label">Orden</span>
                                <span class="resumen-hero-value">${ordenId}</span>
                            </div>
                            <div class="resumen-hero-item">
                                <span class="resumen-hero-label">Boletos</span>
                                <span class="resumen-hero-value">${boletos}</span>
                            </div>
                            <div class="resumen-hero-item">
                                <span class="resumen-hero-label">Total</span>
                                <span class="resumen-hero-value accent">$${total}</span>
                            </div>
                            ${mostrarResumenOportunidades ? `
                                <div class="resumen-hero-item resumen-hero-item--oportunidades">
                                    <span class="resumen-hero-label">Oportunidades</span>
                                    <span class="resumen-hero-value">${oportunidadesTexto}</span>
                                </div>
                            ` : ''}
                        </div>

                        <div class="datos-orden-confirmada">
                            <div class="dato-fila">
                                <span class="dato-label">Sorteo</span>
                                <span class="dato-valor">${sorteo}</span>
                            </div>
                            <div class="dato-fila">
                                <span class="dato-label">Cliente</span>
                                <span class="dato-valor">${nombreVisible}</span>
                            </div>
                            <div class="dato-fila">
                                <span class="dato-label">WhatsApp</span>
                                <span class="dato-valor">${whatsapp}</span>
                            </div>
                            ${subtotalRaw > 0 ? `
                                <div class="dato-fila">
                                    <span class="dato-label">Subtotal</span>
                                    <span class="dato-valor">$${subtotal}</span>
                                </div>
                            ` : ''}
                            ${descuentoRaw > 0 ? `
                                <div class="dato-fila ahorro">
                                    <span class="dato-label">Descuento</span>
                                    <span class="dato-valor">-$${descuento}</span>
                                </div>
                            ` : ''}
                            ${comboInfo?.applied ? `
                                <div class="dato-fila">
                                    <span class="dato-label">Promo combo</span>
                                    <span class="dato-valor">Pagas ${Number(comboInfo.boletosPagados || boletos)} y recibes ${Number(comboInfo.boletosEntregados || boletos)}</span>
                                </div>
                            ` : ''}
                        </div>

                        <div class="aviso-confirmada">
                            ${tiempoApartadoTexto
                                ? `Tus boletos se mantienen apartados por <strong>${tiempoApartadoTexto}</strong>.`
                                : 'Revisa tu orden y completa el pago lo antes posible para conservar tus boletos.'}
                        </div>

                        <div class="push-consent-confirmada" role="note" aria-live="polite">
                            <i class="fas fa-bell" aria-hidden="true"></i>
                            <span>Permite las notificaciones para recibir avisos sobre la confirmación de tu pago y el estado de tu orden.</span>
                        </div>

                    </div>
                    <button id="btnIrAPagar" class="btn-ir-pagar" style="margin-top: 0.95rem;">IR A PAGAR</button>
                </div>
            </div>
        `;

        // ✅ 4. MOSTRAR MODAL
        modal.classList.add('show');
        window.rifaplusModalScrollLock?.sync?.();

        // ✅ 5. AGREGAR LISTENER AL BOTÓN (LIMPIO, SIN MEMORY LEAK)
        const btnPagar = modal.querySelector('#btnIrAPagar');
        
        // Event handler
        const handleClick = async (e) => {
            e.preventDefault();
            // Deshabilitar para evitar múltiples clicks
            btnPagar.disabled = true;
            btnPagar.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Preparando...';

            await solicitarPermisoNotificacionesOrdenConfirmada();

            // Redirigir después de 300ms para UX fluida
            setTimeout(() => {
                prepararRedireccionSinShellMisBoletos();
                window.location.href = urlMisBoletos;
            }, 300);
        };

        btnPagar.addEventListener('click', handleClick, { once: true });

    } catch (error) {
        console.error('❌ [Modal] Error fatal:', error);
        notificarErrorModalOrdenConfirmada();
    }
}

// Exportar función globalmente
window.mostrarModalOrdenConfirmada = mostrarModalOrdenConfirmada;
