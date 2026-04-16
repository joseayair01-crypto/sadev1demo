/**
 * ============================================================
 * ARCHIVO: backend/calculo-precios-server.js
 * DESCRIPCIÓN: Módulo compartido para cálculo de precios
 * CRÍTICO: Usado por servidor para sincronizar con cliente
 * PRÓPOSITO: Evitar discrepancias entre cliente y servidor
 * ============================================================
 */

function redondearMoneda(valor) {
    return Math.round((Number(valor) || 0) * 100) / 100;
}

const RIFAPLUS_PROMO_TIMEZONE = 'America/Mexico_City';

function obtenerOffsetMinutosEnZona(fecha, timeZone = RIFAPLUS_PROMO_TIMEZONE) {
    try {
        const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone,
            timeZoneName: 'shortOffset',
            hour: '2-digit',
            minute: '2-digit'
        });
        const offsetPart = formatter.formatToParts(fecha).find((part) => part.type === 'timeZoneName')?.value || 'GMT-6';
        const match = offsetPart.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/i);
        if (!match) return -360;

        const sign = match[1] === '-' ? -1 : 1;
        const hours = Number(match[2] || 0);
        const minutes = Number(match[3] || 0);
        return sign * ((hours * 60) + minutes);
    } catch (error) {
        return -360;
    }
}

function parseFechaPromocion(valor, timeZone = RIFAPLUS_PROMO_TIMEZONE) {
    if (!valor) return null;
    if (valor instanceof Date) return Number.isNaN(valor.getTime()) ? null : valor;

    const texto = String(valor).trim();
    if (!texto) return null;

    if (/(?:Z|[+-]\d{2}:\d{2})$/i.test(texto)) {
        const fechaConZona = new Date(texto);
        return Number.isNaN(fechaConZona.getTime()) ? null : fechaConZona;
    }

    const match = texto.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!match) {
        const fecha = new Date(texto);
        return Number.isNaN(fecha.getTime()) ? null : fecha;
    }

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6] || 0);

    const utcTentativo = Date.UTC(year, month - 1, day, hour, minute, second);
    const offsetMinutos = obtenerOffsetMinutosEnZona(new Date(utcTentativo), timeZone);
    const fecha = new Date(utcTentativo - (offsetMinutos * 60 * 1000));

    return Number.isNaN(fecha.getTime()) ? null : fecha;
}

function esFechaActiva(fechaInicio, fechaFin, ahora = new Date()) {
    if (!fechaInicio || !fechaFin) return false;

    const inicio = parseFechaPromocion(fechaInicio);
    const fin = parseFechaPromocion(fechaFin);

    if (!inicio || !fin || Number.isNaN(inicio.getTime()) || Number.isNaN(fin.getTime())) {
        return false;
    }

    return ahora >= inicio && ahora <= fin;
}

/**
 * Calcula el precio unitario vigente usando la misma lógica que el frontend:
 * - parte de precioBoleto normal
 * - compara promoción por tiempo vs descuento por porcentaje
 * - usa el mejor descuento disponible
 */
function obtenerPrecioUnitarioVigente(config = {}, ahora = new Date()) {
    const rifa = config?.rifa || {};
    const precioNormal = Number(rifa.precioBoleto) || 0;

    let precioFinal = precioNormal;
    let mejorDescuento = 0;
    let origenDescuento = null;

    const descPorcentaje = rifa.descuentoPorcentaje;
    if (
        descPorcentaje?.enabled &&
        descPorcentaje?.porcentaje &&
        esFechaActiva(descPorcentaje.fechaInicio, descPorcentaje.fechaFin, ahora)
    ) {
        const porcentaje = Number(descPorcentaje.porcentaje);
        if (!Number.isNaN(porcentaje) && Number.isFinite(porcentaje) && porcentaje > 0) {
            const descuento = (precioNormal * porcentaje) / 100;
            if (descuento > mejorDescuento) {
                mejorDescuento = descuento;
                precioFinal = precioNormal - descuento;
                origenDescuento = 'descuento_porcentaje';
            }
        }
    }

    const promoTiempo = rifa.promocionPorTiempo;
    if (
        promoTiempo?.enabled &&
        promoTiempo?.precioProvisional !== null &&
        promoTiempo?.precioProvisional !== undefined &&
        esFechaActiva(promoTiempo.fechaInicio, promoTiempo.fechaFin, ahora)
    ) {
        const precioPromo = Number(promoTiempo.precioProvisional);
        if (!Number.isNaN(precioPromo) && Number.isFinite(precioPromo) && precioPromo >= 0) {
            const descuento = precioNormal - precioPromo;
            if (descuento > mejorDescuento) {
                mejorDescuento = descuento;
                precioFinal = precioPromo;
                origenDescuento = 'promocion_tiempo';
            }
        }
    }

    return {
        precioNormal: redondearMoneda(precioNormal),
        precioUnitario: redondearMoneda(precioFinal),
        descuentoPorBoleto: redondearMoneda(mejorDescuento),
        origenDescuento
    };
}

/**
 * 🎯 FUNCIÓN CRÍTICA: Calcula descuento de forma IDÉNTICA al cliente
 * 
 * Esta función DEBE ser idéntica a window.rifaplusConfig.calcularDescuento
 * en js/config.js para evitar inconsistencias de precio
 * 
 * @param {number} cantidadBoletos - Cantidad de boletos
 * @param {number} precioUnitario - Precio por boleto
 * @param {Array} reglas - (Opcional) Reglas de descuento. Si no se proporciona, usa hardcodeadas
 * @param {Object} config - (Opcional) Objeto de configuración que puede contener descuentos.enabled
 * @returns {Object} { descuentoAplicable, monto, porcentaje, subtotal, total, regla, mensaje }
 */
function calcularDescuentoCompartido(cantidadBoletos, precioUnitario = null, reglas = null, config = null) {
    // Valores por defecto
    if (!precioUnitario) precioUnitario = 15;
    
    // ✅ VALIDACIÓN CRÍTICA: Si descuentos están DESHABILITADOS, retornar 0
    if (config && config.rifa && config.rifa.descuentos && config.rifa.descuentos.enabled === false) {
        const subtotal = cantidadBoletos * precioUnitario;
        return {
            descuentoAplicable: false,
            monto: 0,
            porcentaje: 0,
            subtotal: subtotal,
            total: subtotal,
            regla: null,
            mensaje: 'Descuentos deshabilitados en configuración'
        };
    }
    
    // Reglas hardcodeadas como fallback (DEBEN COINCIDIR con config.js)
    if (!reglas) {
        reglas = [
            { cantidad: 20, precio: 250 },
            { cantidad: 10, precio: 130 }
        ];
    }

    const reglasNormalizadas = (reglas || [])
        .map((regla) => {
            const cantidad = parseInt(regla?.cantidad, 10);
            const total = Number(regla?.total ?? regla?.precio);

            if (!Number.isFinite(cantidad) || cantidad <= 0 || !Number.isFinite(total) || total <= 0) {
                return null;
            }

            return {
                cantidad,
                total,
                precio: total
            };
        })
        .filter(Boolean);

    const subtotal = cantidadBoletos * precioUnitario;

    if (cantidadBoletos <= 0 || reglasNormalizadas.length === 0) {
        return {
            descuentoAplicable: false,
            monto: 0,
            porcentaje: 0,
            subtotal: subtotal,
            total: subtotal,
            regla: null,
            desglose: [],
            mensaje: 'Sin descuento aplicable'
        };
    }

    const costoRegular = Number(precioUnitario);
    const dp = Array(cantidadBoletos + 1).fill(Infinity);
    const ruta = Array(cantidadBoletos + 1).fill(null);
    dp[0] = 0;

    const debePreferirNuevaRuta = (costoNuevo, costoActual, rutaActual, nuevaCantidad) => {
        if (costoNuevo < costoActual - 0.000001) return true;
        if (Math.abs(costoNuevo - costoActual) > 0.000001) return false;
        if (!rutaActual) return true;
        if (rutaActual.tipo !== 'regla') return true;
        return nuevaCantidad > (rutaActual.cantidad || 0);
    };

    for (let boletos = 1; boletos <= cantidadBoletos; boletos++) {
        const costoUnitario = dp[boletos - 1] + costoRegular;
        dp[boletos] = costoUnitario;
        ruta[boletos] = {
            previo: boletos - 1,
            tipo: 'regular',
            cantidad: 1,
            total: costoRegular
        };

        for (const regla of reglasNormalizadas) {
            if (boletos < regla.cantidad) continue;

            const costoConRegla = dp[boletos - regla.cantidad] + regla.total;
            if (debePreferirNuevaRuta(costoConRegla, dp[boletos], ruta[boletos], regla.cantidad)) {
                dp[boletos] = costoConRegla;
                ruta[boletos] = {
                    previo: boletos - regla.cantidad,
                    tipo: 'regla',
                    cantidad: regla.cantidad,
                    total: regla.total,
                    regla
                };
            }
        }
    }

    const totalConDescuento = redondearMoneda(dp[cantidadBoletos]);
    const montoDescuento = redondearMoneda(subtotal - totalConDescuento);

    if (montoDescuento > 0) {
        const desglose = [];
        let cursor = cantidadBoletos;

        while (cursor > 0 && ruta[cursor]) {
            const paso = ruta[cursor];
            if (paso.tipo === 'regla' && paso.regla) {
                const existente = desglose.find((item) => item.cantidad === paso.regla.cantidad && item.total === paso.regla.total);
                if (existente) {
                    existente.veces += 1;
                } else {
                    desglose.push({
                        tipo: 'regla',
                        cantidad: paso.regla.cantidad,
                        total: paso.regla.total,
                        veces: 1
                    });
                }
            } else {
                const existente = desglose.find((item) => item.tipo === 'regular');
                if (existente) {
                    existente.cantidad += 1;
                    existente.total += costoRegular;
                } else {
                    desglose.push({
                        tipo: 'regular',
                        cantidad: 1,
                        total: costoRegular,
                        veces: 1
                    });
                }
            }
            cursor = paso.previo;
        }

        const reglasUsadas = desglose
            .filter((item) => item.tipo === 'regla')
            .sort((a, b) => b.cantidad - a.cantidad);
        const porcentajeDescuento = Math.round((montoDescuento / subtotal) * 100);
        const mensaje = reglasUsadas.length > 0
            ? reglasUsadas.map((item) => `${item.veces}x paquete de ${item.cantidad}`).join(' + ')
            : 'Descuento por volumen aplicado';

        return {
            descuentoAplicable: true,
            monto: montoDescuento,
            porcentaje: porcentajeDescuento,
            subtotal: subtotal,
            total: totalConDescuento,
            regla: reglasUsadas[0] || null,
            desglose,
            mensaje
        };
    }

    // Si no hay regla que aplique
    return {
        descuentoAplicable: false,
        monto: 0,
        porcentaje: 0,
        subtotal: subtotal,
        total: subtotal,
        regla: null,
        desglose: [],
        mensaje: 'Sin descuento aplicable'
    };
}

/**
 * Calcula los totales oficiales del servidor respetando la lógica actual:
 * - el subtotal visible se calcula con precio normal
 * - promoción por tiempo o descuento porcentual compiten entre sí
 * - descuento por cantidad solo aplica si NO hay promoción por boleto activa
 */
function calcularTotalesServidor(cantidadBoletos, config = {}, ahora = new Date()) {
    const rifa = config?.rifa || {};
    const precioInfo = obtenerPrecioUnitarioVigente(config, ahora);

    const precioNormal = precioInfo.precioNormal;
    const precioUnitario = precioInfo.precioUnitario;
    const subtotal = redondearMoneda(cantidadBoletos * precioNormal);
    const descuentoPromocion = redondearMoneda(cantidadBoletos * precioInfo.descuentoPorBoleto);

    let descuentoCantidad = 0;
    let reglaCantidad = null;

    if (descuentoPromocion === 0) {
        const resultadoCantidad = calcularDescuentoCompartido(
            cantidadBoletos,
            precioNormal,
            rifa?.descuentos?.reglas,
            config
        );
        descuentoCantidad = redondearMoneda(resultadoCantidad.monto || 0);
        reglaCantidad = resultadoCantidad.regla || null;
    }

    const descuentoTotal = redondearMoneda(descuentoPromocion + descuentoCantidad);
    const totalFinal = redondearMoneda(Math.max(0, subtotal - descuentoTotal));

    return {
        cantidadBoletos,
        precioNormal,
        precioUnitario,
        subtotal,
        descuento: descuentoTotal,
        descuentoPromocion,
        descuentoCantidad,
        totalFinal,
        promocionAplicada: precioInfo.origenDescuento,
        reglaCantidad
    };
}

/**
 * 🔍 AUDITORÍA: Compara cálculos cliente vs servidor
 * Útil para detectar y loguear discrepancias
 * 
 * @param {number} cantidadBoletos
 * @param {number} precioUnitario
 * @param {Object} datosCliente - { subtotal, descuento, totalFinal }
 * @param {Object} config
 * @returns {Object} { sonIguales, diferencia, detalles }
 */
function auditarConsistenciaPrecios(cantidadBoletos, precioUnitario, datosCliente, config) {
    const calculoServidor = calcularTotalesServidor(cantidadBoletos, config);

    const diferenciaMonto = Math.abs((datosCliente.descuento || 0) - calculoServidor.descuento);
    const diferenciaTotal = Math.abs((datosCliente.totalFinal || 0) - calculoServidor.totalFinal);
    const diferenciaSubtotal = Math.abs((datosCliente.subtotal || 0) - calculoServidor.subtotal);

    const sonIguales = diferenciaMonto < 0.01 && diferenciaTotal < 0.01 && diferenciaSubtotal < 0.01;

    return {
        sonIguales,
        diferenciaSubtotal,
        diferenciaMonto,
        diferenciaTotal,
        detalles: {
            cliente: {
                subtotal: datosCliente.subtotal,
                descuento: datosCliente.descuento,
                totalFinal: datosCliente.totalFinal
            },
            servidor: {
                subtotal: calculoServidor.subtotal,
                descuento: calculoServidor.descuento,
                totalFinal: calculoServidor.totalFinal
            }
        }
    };
}

module.exports = {
    calcularDescuentoCompartido,
    auditarConsistenciaPrecios,
    obtenerPrecioUnitarioVigente,
    calcularTotalesServidor
};
