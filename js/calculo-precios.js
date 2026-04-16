/**
 * ============================================================
 * ARCHIVO: js/calculo-precios.js
 * DESCRIPCIÓN: Módulo CENTRALIZADO para cálculo de precios
 * ÚNICA FUENTE DE VERDAD para totales, descuentos y cálculos
 * ============================================================
 */

/**
 * Obtiene el precio unitario del boleto desde config
 * ✅ ACTUALIZADO: Verifica promoción por tiempo + descuento por porcentaje
 * @returns {number} Precio unitario del boleto (con descuentos aplicados si aplica)
 */
function obtenerPrecioBoleto() {
    const ahora = new Date();
    const precioNormal = Number(window.rifaplusConfig?.obtenerPrecioBoleto?.() ?? window.rifaplusConfig?.rifa?.precioBoleto ?? 0);
    let precioFinal = precioNormal;
    let mejorDescuento = 0;
    let tipoDescuento = null;
    const estaActiva = typeof window.rifaplusConfig?.esFechaPromocionActiva === 'function'
        ? window.rifaplusConfig.esFechaPromocionActiva
        : ((inicio, fin, ahoraActual) => {
            const inicioFecha = new Date(inicio);
            const finFecha = new Date(fin);
            return ahoraActual >= inicioFecha && ahoraActual <= finFecha;
        });
    
    // Verificar descuento por porcentaje
    const descPorcentaje = window.rifaplusConfig?.rifa?.descuentoPorcentaje;
    if (descPorcentaje && descPorcentaje.enabled && descPorcentaje.porcentaje) {
        if (estaActiva(descPorcentaje.fechaInicio, descPorcentaje.fechaFin, ahora)) {
            const porcentaje = Number(descPorcentaje.porcentaje);
            if (!Number.isNaN(porcentaje) && isFinite(porcentaje) && porcentaje > 0) {
                const descuento = (precioNormal * porcentaje) / 100;
                if (descuento > mejorDescuento) {
                    mejorDescuento = descuento;
                    precioFinal = precioNormal - descuento;
                    tipoDescuento = 'Descuento %';
                }
            }
        }
    }
    
    // Verificar si hay promoción por tiempo activa
    const promo = window.rifaplusConfig?.rifa?.promocionPorTiempo;
    if (promo && promo.enabled && promo.precioProvisional !== null && promo.precioProvisional !== undefined) {
        if (estaActiva(promo.fechaInicio, promo.fechaFin, ahora)) {
            const precioProvisional = Number(promo.precioProvisional);
            if (!Number.isNaN(precioProvisional) && isFinite(precioProvisional) && precioProvisional >= 0) {
                const descuento = precioNormal - precioProvisional;
                if (descuento > mejorDescuento) {
                    mejorDescuento = descuento;
                    precioFinal = precioProvisional;
                    tipoDescuento = 'Promo Tiempo';
                }
            }
        }
    }
    
    if (mejorDescuento > 0) {
        console.log(`💰 [${tipoDescuento}] Descuento: $${mejorDescuento.toFixed(2)} → Precio: $${precioFinal.toFixed(2)}`);
    }
    
    return precioFinal;
}

/**
 * Calcula el total incluyendo promociones
 * @param {number} cantidad - Cantidad de boletos
 * @param {number} precioBoleto - (Opcional) Precio unitario. Si no se proporciona, se obtiene dinámicamente
 * @returns {Object} Objeto con detalles de cálculo: {
 *      cantidadBoletos, precioUnitario, subtotal, descuentoMonto, 
 *      descuentoPorcentaje, totalFinal, promocionAplicada
 * }
 */
function calcularTotalConPromociones(cantidad, precioBoleto = null) {
    // Validar cantidad primero
    if (!Number.isInteger(cantidad) || cantidad < 0) {
        return {
            cantidadBoletos: 0,
            precioUnitario: 0,
            subtotal: 0,
            descuentoMonto: 0,
            descuentoPorcentaje: 0,
            totalFinal: 0,
            promocionAplicada: null
        };
    }

    // PASO 1: Obtener precio NORMAL (sin promoción)
    const precioNormal = Number(window.rifaplusConfig?.obtenerPrecioBoleto?.() ?? window.rifaplusConfig?.rifa?.precioBoleto ?? 0);
    
    // PASO 2: Verificar descuentos disponibles (Tiempo + Porcentaje) y usar el mejor
    const ahora = new Date();
    let descuentoPorPromocion = 0;
    let precioUnitarioFinal = precioNormal;
    let tipoDescuento = null;
    let mejorDescuento = 0;
    const estaActiva = typeof window.rifaplusConfig?.esFechaPromocionActiva === 'function'
        ? window.rifaplusConfig.esFechaPromocionActiva
        : ((inicio, fin, ahoraActual) => {
            const inicioFecha = new Date(inicio);
            const finFecha = new Date(fin);
            return ahoraActual >= inicioFecha && ahoraActual <= finFecha;
        });
    
    // Verificar descuento por porcentaje
    const descPorcentaje = window.rifaplusConfig?.rifa?.descuentoPorcentaje;
    if (descPorcentaje && descPorcentaje.enabled && descPorcentaje.porcentaje) {
        if (estaActiva(descPorcentaje.fechaInicio, descPorcentaje.fechaFin, ahora)) {
            const porcentaje = Number(descPorcentaje.porcentaje);
            if (!Number.isNaN(porcentaje) && isFinite(porcentaje) && porcentaje > 0) {
                const descuento = (precioNormal * porcentaje) / 100;
                if (descuento > mejorDescuento) {
                    mejorDescuento = descuento;
                    precioUnitarioFinal = precioNormal - descuento;
                    descuentoPorPromocion = descuento;
                    tipoDescuento = 'Descuento %';
                    console.log(`✅ [Descuento %] Descuento: $${descuento.toFixed(2)} por boleto`);
                }
            }
        }
    }
    
    // Verificar si hay promoción por tiempo activa
    const promo = window.rifaplusConfig?.rifa?.promocionPorTiempo;
    if (promo && promo.enabled && promo.precioProvisional !== null && promo.precioProvisional !== undefined) {
        if (estaActiva(promo.fechaInicio, promo.fechaFin, ahora)) {
            const precioProvisional = Number(promo.precioProvisional);
            if (!Number.isNaN(precioProvisional) && isFinite(precioProvisional) && precioProvisional >= 0) {
                const descuento = precioNormal - precioProvisional;
                if (descuento > mejorDescuento) {
                    mejorDescuento = descuento;
                    precioUnitarioFinal = precioProvisional;
                    descuentoPorPromocion = descuento;
                    tipoDescuento = 'Promo Tiempo';
                    console.log(`✅ [Promoción Tiempo] Descuento: $${descuento.toFixed(2)} por boleto`);
                }
            }
        }
    }
    
    // PASO 3: Calcular subtotal con precio normal (para mostrar descuento)
    const subtotal = cantidad * precioNormal;
    
    // PASO 4: Calcular descuento total por promoción
    const descuentoTotalPromocion = cantidad * descuentoPorPromocion;
    
    // PASO 5: Calcular precio unitario efectivo a usar
    if (!precioBoleto) {
        precioBoleto = precioUnitarioFinal;
    }
    
    // PASO 6: Usar función de descuentos por cantidad si existe
    let descuentoPorCantidad = 0;
    let totalFinal = subtotal - descuentoTotalPromocion;
    
    if (window.rifaplusConfig && typeof window.rifaplusConfig.calcularDescuento === 'function') {
        const resultado = window.rifaplusConfig.calcularDescuento(cantidad, precioNormal);
        descuentoPorCantidad = resultado.monto || 0;
        // El descuento por cantidad se aplica adicional SOLO si no hay promoción activa
        if (descuentoPorPromocion === 0) {
            totalFinal = totalFinal - descuentoPorCantidad;
        }
    }

    // Descuento total visible al cliente: mostrar SOLO lo que realmente se aplicó
    const descuentoMonto = descuentoPorPromocion > 0
        ? descuentoTotalPromocion
        : descuentoPorCantidad;
    const descuentoPorcentaje = subtotal > 0 ? (descuentoMonto / subtotal * 100).toFixed(2) : 0;

    return {
        cantidadBoletos: cantidad,
        precioUnitario: precioBoleto,
        subtotal: Number(subtotal.toFixed(2)),
        descuentoMonto: Number(descuentoMonto.toFixed(2)),
        descuentoPorcentaje: Number(descuentoPorcentaje),
        totalFinal: Number(totalFinal.toFixed(2)),
        promocionAplicada: tipoDescuento
    };
}
