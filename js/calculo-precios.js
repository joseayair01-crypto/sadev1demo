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
function redondearMonedaCliente(valor) {
    return Math.round((Number(valor) || 0) * 100) / 100;
}

function normalizarReglasComboCliente(reglas = []) {
    return (Array.isArray(reglas) ? reglas : [])
        .map((regla) => {
            const cantidadRecibe = parseInt(
                regla?.cantidadRecibe
                ?? regla?.cantidadEntrega
                ?? regla?.cantidad
                ?? regla?.boletos
                ?? 0,
                10
            );
            const cantidadPaga = parseInt(
                regla?.cantidadPaga
                ?? regla?.paga
                ?? regla?.compra
                ?? 0,
                10
            );

            if (
                !Number.isInteger(cantidadRecibe) ||
                !Number.isInteger(cantidadPaga) ||
                cantidadRecibe <= 1 ||
                cantidadPaga <= 0 ||
                cantidadPaga >= cantidadRecibe
            ) {
                return null;
            }

            return {
                cantidadRecibe,
                cantidadPaga,
                boletosBonificados: cantidadRecibe - cantidadPaga,
                etiqueta: String(regla?.etiqueta || regla?.label || `${cantidadRecibe}x${cantidadPaga}`).trim() || `${cantidadRecibe}x${cantidadPaga}`
            };
        })
        .filter(Boolean)
        .sort((a, b) => {
            if (a.cantidadRecibe !== b.cantidadRecibe) return a.cantidadRecibe - b.cantidadRecibe;
            return a.cantidadPaga - b.cantidadPaga;
        });
}

function calcularPromocionComboCliente(cantidadBoletos, precioUnitario, reglas = []) {
    const reglasNormalizadas = normalizarReglasComboCliente(reglas);
    const cantidad = Number.parseInt(cantidadBoletos, 10);
    const precio = Number(precioUnitario);
    const subtotalBase = redondearMonedaCliente((Number.isInteger(cantidad) ? cantidad : 0) * (Number.isFinite(precio) ? precio : 0));

    if (!Number.isInteger(cantidad) || cantidad <= 0 || !Number.isFinite(precio) || precio <= 0 || reglasNormalizadas.length === 0) {
        return {
            comboAplicado: false,
            subtotalBase,
            total: subtotalBase,
            descuento: 0,
            boletosEntregados: Math.max(0, cantidad || 0),
            boletosPagados: Math.max(0, cantidad || 0),
            boletosBonificados: 0,
            desglose: [],
            reglaPrincipal: null,
            mensaje: 'Sin combo aplicable'
        };
    }

    const dp = Array(cantidad + 1).fill(Infinity);
    const ruta = Array(cantidad + 1).fill(null);
    dp[0] = 0;

    const debePreferirNuevaRuta = (costoNuevo, costoActual, rutaActual, nuevaRegla) => {
        if (costoNuevo < costoActual - 0.000001) return true;
        if (Math.abs(costoNuevo - costoActual) > 0.000001) return false;
        if (!rutaActual) return true;
        if (rutaActual.tipo !== 'combo') return true;
        if ((nuevaRegla?.cantidadRecibe || 0) !== (rutaActual.regla?.cantidadRecibe || 0)) {
            return (nuevaRegla?.cantidadRecibe || 0) > (rutaActual.regla?.cantidadRecibe || 0);
        }
        return (nuevaRegla?.cantidadPaga || 0) < (rutaActual.regla?.cantidadPaga || 0);
    };

    for (let boletos = 1; boletos <= cantidad; boletos += 1) {
        const costoRegular = dp[boletos - 1] + precio;
        dp[boletos] = costoRegular;
        ruta[boletos] = {
            previo: boletos - 1,
            tipo: 'regular',
            cantidadRecibe: 1,
            cantidadPaga: 1
        };

        for (const regla of reglasNormalizadas) {
            if (boletos < regla.cantidadRecibe) continue;

            const costoConCombo = dp[boletos - regla.cantidadRecibe] + (regla.cantidadPaga * precio);
            if (debePreferirNuevaRuta(costoConCombo, dp[boletos], ruta[boletos], regla)) {
                dp[boletos] = costoConCombo;
                ruta[boletos] = {
                    previo: boletos - regla.cantidadRecibe,
                    tipo: 'combo',
                    cantidadRecibe: regla.cantidadRecibe,
                    cantidadPaga: regla.cantidadPaga,
                    regla
                };
            }
        }
    }

    const total = redondearMonedaCliente(dp[cantidad]);
    const descuento = redondearMonedaCliente(subtotalBase - total);

    if (descuento <= 0) {
        return {
            comboAplicado: false,
            subtotalBase,
            total: subtotalBase,
            descuento: 0,
            boletosEntregados: cantidad,
            boletosPagados: cantidad,
            boletosBonificados: 0,
            desglose: [],
            reglaPrincipal: null,
            mensaje: 'Sin combo aplicable'
        };
    }

    const desglose = [];
    let cursor = cantidad;
    let boletosPagados = 0;

    while (cursor > 0 && ruta[cursor]) {
        const paso = ruta[cursor];
        boletosPagados += Number(paso.cantidadPaga || 0);

        if (paso.tipo === 'combo' && paso.regla) {
            const existente = desglose.find((item) =>
                item.tipo === 'combo'
                && item.cantidadRecibe === paso.regla.cantidadRecibe
                && item.cantidadPaga === paso.regla.cantidadPaga
            );
            if (existente) {
                existente.veces += 1;
            } else {
                desglose.push({
                    tipo: 'combo',
                    etiqueta: paso.regla.etiqueta,
                    cantidadRecibe: paso.regla.cantidadRecibe,
                    cantidadPaga: paso.regla.cantidadPaga,
                    boletosBonificados: paso.regla.boletosBonificados,
                    veces: 1
                });
            }
        } else {
            const existente = desglose.find((item) => item.tipo === 'regular');
            if (existente) {
                existente.veces += 1;
                existente.cantidadRecibe += 1;
                existente.cantidadPaga += 1;
            } else {
                desglose.push({
                    tipo: 'regular',
                    etiqueta: 'Boleto regular',
                    cantidadRecibe: 1,
                    cantidadPaga: 1,
                    boletosBonificados: 0,
                    veces: 1
                });
            }
        }

        cursor = paso.previo;
    }

    const combosUsados = desglose
        .filter((item) => item.tipo === 'combo')
        .sort((a, b) => b.cantidadRecibe - a.cantidadRecibe);

    return {
        comboAplicado: true,
        subtotalBase,
        total,
        descuento,
        boletosEntregados: cantidad,
        boletosPagados,
        boletosBonificados: Math.max(0, cantidad - boletosPagados),
        desglose,
        reglaPrincipal: combosUsados[0] || null,
        mensaje: combosUsados.length > 0
            ? combosUsados.map((item) => `${item.veces}x ${item.cantidadRecibe}x${item.cantidadPaga}`).join(' + ')
            : 'Combo aplicado'
    };
}

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
            promocionAplicada: null,
            combo: {
                applied: false,
                boletosEntregados: 0,
                boletosPagados: 0,
                boletosBonificados: 0,
                reglaPrincipal: null,
                desglose: []
            }
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
    const comboConfig = window.rifaplusConfig?.rifa?.promocionesCombo;
    const comboInfo = comboConfig?.enabled === true
        ? calcularPromocionComboCliente(cantidad, precioUnitarioFinal, comboConfig?.reglas)
        : calcularPromocionComboCliente(cantidad, precioUnitarioFinal, []);
    const descuentoCombo = comboInfo.comboAplicado ? comboInfo.descuento : 0;

    if (!comboInfo.comboAplicado && window.rifaplusConfig && typeof window.rifaplusConfig.calcularDescuento === 'function') {
        const resultado = window.rifaplusConfig.calcularDescuento(cantidad, precioNormal);
        descuentoPorCantidad = resultado.monto || 0;
        // El descuento por cantidad se aplica adicional SOLO si no hay promoción activa
        if (descuentoPorPromocion === 0) {
            totalFinal = totalFinal - descuentoPorCantidad;
        }
    }

    if (comboInfo.comboAplicado) {
        totalFinal = Math.max(0, totalFinal - descuentoCombo);
    }

    // Descuento total visible al cliente: mostrar SOLO lo que realmente se aplicó
    const descuentoMonto = descuentoPorPromocion > 0
        ? descuentoTotalPromocion + descuentoCombo
        : descuentoCombo > 0
            ? descuentoCombo
            : descuentoPorCantidad;
    const descuentoPorcentaje = subtotal > 0 ? (descuentoMonto / subtotal * 100).toFixed(2) : 0;
    const promocionesAplicadas = [
        tipoDescuento,
        comboInfo.comboAplicado ? 'Promocion Combo' : null,
        descuentoPorCantidad > 0 ? 'Volumen' : null
    ].filter(Boolean);

    return {
        cantidadBoletos: cantidad,
        precioUnitario: precioBoleto,
        subtotal: Number(subtotal.toFixed(2)),
        descuentoMonto: Number(descuentoMonto.toFixed(2)),
        descuentoPorcentaje: Number(descuentoPorcentaje),
        totalFinal: Number(totalFinal.toFixed(2)),
        promocionAplicada: promocionesAplicadas.join(' + ') || null,
        combo: {
            applied: comboInfo.comboAplicado === true,
            boletosEntregados: comboInfo.boletosEntregados || cantidad,
            boletosPagados: comboInfo.boletosPagados || cantidad,
            boletosBonificados: comboInfo.boletosBonificados || 0,
            reglaPrincipal: comboInfo.reglaPrincipal || null,
            desglose: comboInfo.desglose || []
        }
    };
}
