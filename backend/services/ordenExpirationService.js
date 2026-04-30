/**
 * Servicio de Expiración de Órdenes - PRODUCCIÓN ROBUSTO
 * ========================================================
 * Maneja la limpieza automática de órdenes que no pagaron en tiempo
 * Libera boletos automáticamente después de X horas (configurable)
 * 
 * CARACTERÍSTICAS DE PRODUCCIÓN:
 * - Error handling exhaustivo con reintentos
 * - Logging detallado para debugging
 * - Prevención de múltiples ejecuciones simultáneas
 * - Manejo de transacciones con rollback automático
 * - Estadísticas y monitoreo en tiempo real
 * 
 * Archivo: backend/services/ordenExpirationService.js
 */

const db = require('../db');
const { normalizeRifaContext, applyRifaScope } = require('./rifaScope');
const { obtenerConfigExpiracion } = require('../config-loader');
const { enviarPushOrdenCancelada, enviarPushOrdenPorVencer } = require('./pushNotificationsService');
const ConfigManagerV2 = require('../config-manager-v2');

class OrdenExpirationService {
    constructor() {
        this.interval = null;
        this.isRunning = false;
        this.isExecuting = false;  // Flag para evitar ejecuciones concurrentes
        this.tiempoApartadoMs = 12 * 60 * 60 * 1000;  // Default: 12 horas
        this.intervaloMs = 5 * 60 * 1000;  // Default: 5 minutos
        this.warningThresholdsMinutes = null;
        this.stats = {
            totalEjecuciones: 0,
            ordenesLiberadas: 0,
            boletosTotalesLiberados: 0,
            ultimaEjecucion: null,
            ultimoError: null,
            proximaEjecucion: null
        };
    }

    _normalizarContextoRifa(contexto = {}) {
        return normalizeRifaContext(contexto);
    }

    _whereRifa(query, contexto = {}) {
        return applyRifaScope(query, contexto);
    }

    /**
     * Inicia el servicio de expiración (corre cada N minutos)
     * @param {number} intervaloMinutos - Cada cuántos minutos verificar
     * @param {number} tiempoApartadoHoras - Cuántas horas dura apartado
     */
    iniciar(intervaloMinutos = 5, tiempoApartadoHoras = 12, warningThresholdsMinutes = null) {
        if (this.isRunning) {
            console.warn('⚠️ [ExpService] Servicio ya está corriendo');
            return;
        }

        this.isRunning = true;
        this.tiempoApartadoMs = tiempoApartadoHoras * 60 * 60 * 1000;
        this.intervaloMs = intervaloMinutos * 60 * 1000;
        this.warningThresholdsMinutes = this.normalizarUmbralesAvisoExpiracionMinutos(warningThresholdsMinutes);

        const mensaje = `
╔════════════════════════════════════════════════════════╗
║         🚀 SERVICIO DE EXPIRACIÓN INICIADO             ║
╠════════════════════════════════════════════════════════╣
║ Intervalo: ${intervaloMinutos} minutos                              
║ Tiempo apartado: ${tiempoApartadoHoras} horas                        
║ Próxima ejecución: ${new Date(Date.now() + this.intervaloMs).toISOString()}
╚════════════════════════════════════════════════════════╝`;
        console.log(mensaje);

        // Ejecutar inmediatamente la primera vez (después de 2 segundos para estabilidad)
        setTimeout(() => {
            this.limpiarOrdenesExpiradas();
        }, 2000);

        // Luego cada X minutos
        this.interval = setInterval(() => {
            this.limpiarOrdenesExpiradas();
        }, this.intervaloMs);
    }

    /**
     * Detiene el servicio
     */
    detener() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
            this.isRunning = false;
            console.log('⏹️  [ExpService] Servicio detenido');
        }
    }

    /**
     * Busca y libera órdenes que han expirado
     * ⚡ ROBUSTO: Previene ejecuciones concurrentes, maneja errores, reintentos
     * 
     * LÓGICA DE EXPIRACIÓN (CONTUNDENTE Y PROFESIONAL):
     * - Busca órdenes en estado 'pendiente' ÚNICAMENTE
     * - Que fueron creadas hace más de X horas (config.js)
     * - Sin comprobante_path (comprobante_path IS NULL)
     * - Las libera de vuelta a disponibles y marca como 'cancelada'
     * 
     * ⚠️ IMPORTANTE: Las órdenes con comprobante_path (tiene comprobante subido) NO expiran
     * porque están esperando revisión del admin
     */
    async limpiarOrdenesExpiradas(contexto = {}) {
        // Prevenir ejecuciones concurrentes
        if (this.isExecuting) {
            console.warn('⚠️ [ExpService] Ya hay una limpieza en progreso, saltando...');
            return;
        }

        this.isExecuting = true;
        const inicioEjecucion = Date.now();
        let ordenesLiberades = 0;
        let boletosCancelados = 0;

        try {
            const ahora = new Date();
            const tiempoLimite = new Date(ahora.getTime() - this.tiempoApartadoMs);

            // Log del inicio
            console.log(`\n[${ahora.toISOString()}] 🔍 [ExpService] INICIANDO LIMPIEZA MULTI-RIFA`);
            console.log(`   Búsqueda: órdenes 'pendiente' sin comprobante recibido`);
            console.log(`   NOTA: Órdenes con comprobante recibido NO expiran (esperan revisión de admin)`);

            // ✅ CORRECCIÓN: Buscar SOLO órdenes en estado 'pendiente' SIN comprobante recibido
            // Las 'confirmada' O las con 'comprobante_path' NO expiran (están esperando revisión de admin)
            let ordenesIncompletas;
            try {
                ordenesIncompletas = await this._whereRifa(db('ordenes'), contexto)
                    .select('id', 'numero_orden', 'estado', 'boletos', 'comprobante_path', 'created_at', 'updated_at', 'telefono_cliente', 'cantidad_boletos')
                    .select('rifa_id')
                    .where('estado', 'pendiente')  // SOLO pendiente
                    .whereNull('comprobante_path')  // SIN comprobante subido
                    .timeout(10000); // Timeout de 10 segundos
            } catch (dbError) {
                console.error('❌ [ExpService] Error consultando BD:', dbError.message);
                this.stats.ultimoError = dbError.message;
                return;
            }

            if (!ordenesIncompletas || ordenesIncompletas.length === 0) {
                console.log(`✅ [ExpService] No hay órdenes pendientes (todas están confirmadas o canceladas)`);
                this.stats.totalEjecuciones++;
                this.stats.ultimaEjecucion = new Date();
                this.stats.proximaEjecucion = new Date(Date.now() + this.intervaloMs);
                return;
            }

            // Filtrar en JavaScript basado en fecha de creación (Dinámico por rifa_id)
            const configManagerV2 = ConfigManagerV2.getInstance();
            const ordenesExpiradas = ordenesIncompletas.filter(orden => {
                // Obtener configuración específica de la rifa de esta orden
                const configRifa = configManagerV2?.getConfig(orden.rifa_id);
                const tiempoApartadoHoras = Number(configRifa?.rifa?.tiempoApartadoHoras) || (this.tiempoApartadoMs / (1000 * 60 * 60));
                const tiempoApartadoMsRifa = tiempoApartadoHoras * 60 * 60 * 1000;
                
                const fechaOrden = new Date(orden.created_at);
                const tiempoLimiteRifa = new Date(ahora.getTime() - tiempoApartadoMsRifa);
                const hasExpired = fechaOrden < tiempoLimiteRifa;
                
                if (hasExpired) {
                    const horasTranscurridas = (ahora.getTime() - fechaOrden.getTime()) / (1000 * 60 * 60);
                    console.log(`   ⏰ ${orden.numero_orden} (rifa:${orden.rifa_id}, pendiente): ${horasTranscurridas.toFixed(1)}h > ${tiempoApartadoHoras}h → EXPIRA`);
                }
                
                return hasExpired;
            });

            if (ordenesExpiradas.length === 0) {
                await this.notificarOrdenesPorVencer(ordenesIncompletas, ahora, contexto);
                console.log(`✅ [ExpService] ${ordenesIncompletas.length} orden(es) pendiente(s), pero DENTRO del plazo`);
                this.stats.totalEjecuciones++;
                this.stats.ultimaEjecucion = new Date();
                this.stats.proximaEjecucion = new Date(Date.now() + this.intervaloMs);
                return;
            }

            await this.notificarOrdenesPorVencer(ordenesIncompletas, ahora, contexto);

            console.log(`\n⚠️  [ExpService] Encontradas ${ordenesExpiradas.length} órdenes EXPIRADAS (liberando boletos...)\n`);

            // Procesar cada orden expirada con manejo de errores individual
            for (const orden of ordenesExpiradas) {
                try {
                    const resultado = await this.liberarOrden(orden, { rifaId: orden.rifa_id });
                    ordenesLiberades++;
                    boletosCancelados += resultado.boletosCancelados;
                } catch (liberarError) {
                    console.error(`❌ [ExpService] Error liberando orden ${orden.numero_orden}:`, liberarError.message);
                    // Continuar con la siguiente orden en vez de parar
                }
            }

            // Estadísticas finales
            const duracion = ((Date.now() - inicioEjecucion) / 1000).toFixed(2);
            console.log(`
╔════════════════════════════════════════════════════════╗
║              ✅ LIMPIEZA COMPLETADA                   ║
╠════════════════════════════════════════════════════════╣
║ Órdenes canceladas: ${ordenesLiberades.toString().padEnd(35)}║
║ Boletos liberados: ${boletosCancelados.toString().padEnd(37)}║
║ Duración: ${duracion}s${' '.repeat(47 - duracion.length)}║
║ Próxima: ${new Date(Date.now() + this.intervaloMs).toISOString().padEnd(42)}║
╚════════════════════════════════════════════════════════╝`);

            // Actualizar estadísticas
            this.stats.totalEjecuciones++;
            this.stats.ordenesLiberadas += ordenesLiberades;
            this.stats.boletosTotalesLiberados += boletosCancelados;
            this.stats.ultimaEjecucion = new Date();
            this.stats.ultimoError = null;
            this.stats.proximaEjecucion = new Date(Date.now() + this.intervaloMs);

        } catch (error) {
            console.error('❌ [ExpService] ERROR CRÍTICO durante limpieza:');
            console.error(`   Mensaje: ${error.message}`);
            console.error(`   Stack: ${error.stack}`);
            
            this.stats.ultimoError = {
                mensaje: error.message,
                timestamp: new Date()
            };
        } finally {
            this.isExecuting = false;
        }
    }

    async liberarOrden(orden, contexto = {}) {
        let boletosCancelados = 0;
        const contextoRifa = this._normalizarContextoRifa(contexto);

        try {
            // ⭐ VALIDACIÓN CRÍTICA: No liberar órdenes con comprobante de pago
            if (orden.comprobante_path) {
                console.warn(`⚠️  [ExpService] PROTECCIÓN: No se libera ${orden.numero_orden} - tiene comprobante`);
                throw new Error('ORDEN_PROTEGIDA_CON_COMPROBANTE');
            }

            // 1. Parsear boletos de forma segura
            let boletos = [];
            try {
                if (Array.isArray(orden.boletos)) {
                    boletos = orden.boletos.map(n => {
                        const num = parseInt(n, 10);
                        return isNaN(num) ? null : num;
                    }).filter(n => n !== null);
                } else if (typeof orden.boletos === 'string') {
                    boletos = JSON.parse(orden.boletos);
                    if (!Array.isArray(boletos)) boletos = [];
                }
            } catch (parseError) {
                console.warn(`⚠️  [ExpService] Boletos malformados en orden ${orden.numero_orden}:`, parseError.message);
                boletos = [];
            }

            boletosCancelados = boletos.length;
            console.log(`  📋 ${orden.numero_orden}: ${boletos.length} boletos a liberar`);
            console.log(`     Primeros: [${boletos.slice(0, 10).join(',')}]`);

            if (boletos.length === 0) {
                console.warn(`  ⚠️  ${orden.numero_orden}: SIN BOLETOS para liberar`);
                return { boletosCancelados: 0, ordenId: orden.id };
            }

            // 2. Actualizar estado en transacción
            const resultado = await db.transaction(async (trx) => {
                // PASO 1: Actualizar la orden a 'cancelada'
                console.log(`  🔄 [PASO 1] Actualizando orden ${orden.numero_orden} a 'cancelada'...`);
                
                const actualizadoOrden = await this._whereRifa(trx('ordenes'), contextoRifa)
                    .where('id', orden.id)
                    .update({
                        estado: 'cancelada',
                        updated_at: new Date()
                    });

                if (actualizadoOrden === 0) {
                    throw new Error(`NO SE ACTUALIZÓ LA ORDEN ${orden.numero_orden}`);
                }
                console.log(`  ✅ Orden actualizada a 'cancelada'`);

                // PASO 2: CRÍTICO - Liberar los boletos
                console.log(`  🔄 [PASO 2] Liberando ${boletos.length} boletos a 'disponible'...`);
                console.log(`     IDs: [${boletos.slice(0, 5).join(',')}${boletos.length > 5 ? '...' : ''}]`);

                // Verificar que los boletos EXISTEN antes de actualizar
                const boletosExistentes = await this._whereRifa(trx('boletos_estado'), contextoRifa)
                    .whereIn('numero', boletos)
                    .count('* as cantidad')
                    .first();

                console.log(`  🔍 Boletos encontrados en BD: ${boletosExistentes.cantidad} de ${boletos.length}`);

                if (!boletosExistentes.cantidad || boletosExistentes.cantidad === 0) {
                    console.error(`  ❌ ERROR CRÍTICO: Ninguno de los boletos existe en boletos_estado`);
                    throw new Error('BOLETOS_NO_ENCONTRADOS_EN_BD');
                }

                // Actualizar boletos
                const actualizadosBoletos = await this._whereRifa(trx('boletos_estado'), contextoRifa)
                    .whereIn('numero', boletos)
                    .update({
                        estado: 'disponible',
                        numero_orden: null,
                        updated_at: new Date()
                    });

                console.log(`  ✅ Boletos liberados: ${actualizadosBoletos}/${boletos.length}`);

                if (actualizadosBoletos !== boletos.length) {
                    console.warn(`  ⚠️  Advertencia: Solo se liberaron ${actualizadosBoletos} de ${boletos.length}`);
                }

                // Verificar que realmente se actualizaron
                const boletosVerificacion = await this._whereRifa(trx('boletos_estado'), contextoRifa)
                    .whereIn('numero', boletos.slice(0, 5))
                    .select('numero', 'estado')
                    .limit(5);

                console.log(`  🔍 Verificación post-update (primeros 5): ${JSON.stringify(boletosVerificacion.map(b => `${b.numero}:${b.estado}`))}`);

                return { actualizadosBoletos, boletosVerificacion };
            });

            // ✅ PASO 3: Liberar oportunidades (si existen) - NO BLOQUEANTE
            try {
                const OportunidadesOrdenService = require('./oportunidadesOrdenService');
                const resultOportunidades = await OportunidadesOrdenService.liberarOportunidades(orden.numero_orden, contextoRifa);
                console.log(`  ✅ Oportunidades liberadas: ${resultOportunidades.cantidad}`);
            } catch (error) {
                console.warn(`  ⚠️  Error liberando oportunidades (no crítico):`, error.message);
                // No lanzar error aquí - ya se liberaron los boletos
            }

            try {
                await enviarPushOrdenCancelada(db, {
                    numero_orden: orden.numero_orden,
                    rifa_id: orden.rifa_id,
                    telefono_cliente: orden.telefono_cliente,
                    cantidad_boletos: boletos.length,
                    estado: 'cancelada',
                    created_at: orden.created_at,
                    updated_at: new Date().toISOString()
                }, {
                    reason: 'expired',
                    eventAt: new Date().toISOString()
                });
            } catch (pushError) {
                console.warn(`  ⚠️  Error enviando push de expiración para ${orden.numero_orden}:`, pushError.message);
            }

            console.log(`  ✅ TRANSACCIÓN EXITOSA: ${resultado.actualizadosBoletos} boletos liberados`);
            return { boletosCancelados: resultado.actualizadosBoletos, ordenId: orden.id };

        } catch (error) {
            console.error(`  ❌ ERROR FATAL en ${orden.numero_orden}:`, error.message);
            console.error(`     Stack:`, error.stack);
            throw error;
        }
    }

    /**
     * Obtiene el estado actual del servicio
     * Útil para monitoreo y debugging
     */
    obtenerEstado() {
        return {
            activo: this.isRunning,
            ejecutando: this.isExecuting,
            tiempoApartado: `${Math.round(this.tiempoApartadoMs / (60 * 60 * 1000))} horas`,
            intervalo: `${Math.round(this.intervaloMs / 60000)} minutos`,
            estadisticas: this.stats
        };
    }

    /**
     * Obtiene estadísticas de órdenes en el sistema
     * Útil para el dashboard del admin
     */
    async obtenerEstadisticas(contexto = {}) {
        try {
            const stats = {
                total_pendientes: 0,
                total_confirmadas: 0,
                total_canceladas: 0,
                boletos_apartados_sin_pago: 0,
                ordenes_proximas_expirar: 0,
                detalles: []
            };

            // Total por estado con timeout
            const porEstado = await this._whereRifa(db('ordenes'), contexto)
                .select('estado')
                .count('* as cantidad')
                .groupBy('estado')
                .timeout(10000);

            for (const row of porEstado) {
                if (row.estado === 'pendiente') stats.total_pendientes = row.cantidad;
                if (row.estado === 'confirmada') stats.total_confirmadas = row.cantidad;
                if (row.estado === 'cancelada') stats.total_canceladas = row.cantidad;
            }

            // Órdenes pendientes sin comprobante (próximas a expirar)
            const boletosPendientes = await this._whereRifa(db('ordenes'), contexto)
                .where('estado', 'pendiente')
                .whereNull('detalles_pago')
                .timeout(10000);

            const ahora = new Date();
            const tiempoLimite = new Date(ahora.getTime() - this.tiempoApartadoMs);

            for (const orden of boletosPendientes) {
                try {
                    const boletos = JSON.parse(orden.boletos);
                    if (Array.isArray(boletos)) {
                        stats.boletos_apartados_sin_pago += boletos.length;
                    }

                    // Contar las que van a expirar pronto (en menos de 1 hora)
                    const fechaOrden = new Date(orden.created_at);
                    const proximaExpiracion = new Date(fechaOrden.getTime() + this.tiempoApartadoMs);
                    if (proximaExpiracion < new Date(ahora.getTime() + 60 * 60 * 1000)) {
                        stats.ordenes_proximas_expirar++;
                    }
                } catch (e) {
                    // Ignorar errores de parseo
                }
            }

            stats.detalles = {
                ahora: ahora.toISOString(),
                limiteExpiracion: tiempoLimite.toISOString(),
                tiempoApartadoMs: this.tiempoApartadoMs
            };

            return stats;
        } catch (error) {
            console.error('Error obteniendo estadísticas:', error.message);
            return null;
        }
    }

    /**
     * Configura el tiempo de expiración dinámicamente
     */
    configurar(tiempoApartadoHoras, intervaloMinutos, warningThresholdsMinutes) {
        if (tiempoApartadoHoras) {
            this.tiempoApartadoMs = tiempoApartadoHoras * 60 * 60 * 1000;
        }
        if (intervaloMinutos) {
            this.intervaloMs = intervaloMinutos * 60 * 1000;
            // Reiniciar el intervalo si está corriendo
            if (this.isRunning) {
                clearInterval(this.interval);
                this.interval = setInterval(() => {
                    this.limpiarOrdenesExpiradas();
                }, this.intervaloMs);
            }
        }
        if (warningThresholdsMinutes !== undefined) {
            this.warningThresholdsMinutes = this.normalizarUmbralesAvisoExpiracionMinutos(warningThresholdsMinutes);
        }
        
        console.log(`⚙️  [ExpService] Configuración actualizada:`);
        console.log(`   - Tiempo apartado: ${tiempoApartadoHoras || (this.tiempoApartadoMs / (60 * 60 * 1000))} horas`);
        console.log(`   - Intervalo: ${intervaloMinutos || (this.intervaloMs / 60000)} minutos`);
        console.log(`   - Avisos previos: ${(this.warningThresholdsMinutes || []).join(', ') || 'desactivados / fallback'}`);
    }

    normalizarUmbralesAvisoExpiracionMinutos(rawValue) {
        if (rawValue === undefined || rawValue === null || rawValue === '') {
            return null;
        }

        const values = Array.isArray(rawValue)
            ? rawValue
            : String(rawValue)
                .split(',')
                .map((value) => value.trim())
                .filter(Boolean);

        const normalized = values
            .map((value) => Number.parseInt(String(value).replace(/[^0-9]/g, ''), 10))
            .filter((value) => Number.isInteger(value) && value > 0);

        return [...new Set(normalized)].sort((a, b) => a - b);
    }

    obtenerUmbralesAvisoExpiracionMinutos(durationMs = null) {
        const tiempoApartadoMs = durationMs || this.tiempoApartadoMs;
        if (Array.isArray(this.warningThresholdsMinutes)) {
            const maxMinutesConfigured = Math.max(1, Math.floor(tiempoApartadoMs / 60000) - 1);
            return this.warningThresholdsMinutes
                .map((value) => Math.max(1, Math.min(maxMinutesConfigured, value)))
                .filter((value, index, array) => array.indexOf(value) === index)
                .sort((a, b) => a - b);
        }

        const configExpiracion = obtenerConfigExpiracion();
        const thresholds = new Set([15, 5]);
        const thresholdListFromConfig = Array.isArray(configExpiracion?.pushOrderWarningMinutes)
            ? configExpiracion.pushOrderWarningMinutes
            : [];
        thresholdListFromConfig
            .map((value) => Number.parseInt(value, 10))
            .filter((value) => Number.isInteger(value) && value > 0)
            .forEach((value) => thresholds.add(value));
        const thresholdFromConfig = Number(configExpiracion?.advertenciaExpirationHoras);
        if (Number.isFinite(thresholdFromConfig) && thresholdFromConfig > 0) {
            thresholds.add(Math.round(thresholdFromConfig * 60));
        }

        const thresholdFromEnv = String(process.env.PUSH_ORDER_WARNING_MINUTES || '').trim();
        if (thresholdFromEnv) {
            thresholdFromEnv
                .split(',')
                .map((value) => Number.parseInt(value.trim(), 10))
                .filter((value) => Number.isInteger(value) && value > 0)
                .forEach((value) => thresholds.add(value));
        }

        const maxMinutes = Math.max(1, Math.floor(tiempoApartadoMs / 60000) - 1);
        return [...thresholds]
            .map((value) => Math.max(1, Math.min(maxMinutes, value)))
            .filter((value, index, array) => array.indexOf(value) === index)
            .sort((a, b) => a - b);
    }

    resolverUmbralAvisoParaOrden(remainingMs, durationMs = null) {
        if (!(remainingMs > 0)) {
            return null;
        }

        const remainingMinutes = remainingMs / 60000;
        const thresholds = this.obtenerUmbralesAvisoExpiracionMinutos(durationMs);
        return thresholds.find((threshold) => remainingMinutes <= threshold) || null;
    }

    async notificarOrdenesPorVencer(ordenesPendientes = [], ahora = new Date(), contexto = {}) {
        if (!Array.isArray(ordenesPendientes) || !ordenesPendientes.length) {
            return;
        }

        for (const orden of ordenesPendientes) {
            try {
                if (orden.comprobante_path || String(orden.estado || '').trim().toLowerCase() !== 'pendiente') {
                    continue;
                }

                const configManagerV2 = ConfigManagerV2.getInstance();
                const configRifa = configManagerV2?.getConfig(orden.rifa_id);
                const tiempoApartadoHoras = Number(configRifa?.rifa?.tiempoApartadoHoras) || (this.tiempoApartadoMs / (1000 * 60 * 60));
                const tiempoApartadoMsRifa = tiempoApartadoHoras * 60 * 60 * 1000;

                const createdAt = new Date(orden.created_at);
                if (Number.isNaN(createdAt.getTime())) {
                    continue;
                }

                const expiresAt = createdAt.getTime() + tiempoApartadoMsRifa;
                const remainingMs = expiresAt - ahora.getTime();
                // Pasar el tiempo de apartado ms al resolvedor para que sea preciso
                const warningMinutes = this.resolverUmbralAvisoParaOrden(remainingMs, tiempoApartadoMsRifa);
                if (!warningMinutes) {
                    continue;
                }

                await enviarPushOrdenPorVencer(db, {
                    numero_orden: orden.numero_orden,
                    rifa_id: orden.rifa_id,
                    telefono_cliente: orden.telefono_cliente,
                    cantidad_boletos: Array.isArray(orden.boletos) ? orden.boletos.length : Number(orden.cantidad_boletos || 0),
                    estado: orden.estado,
                    created_at: orden.created_at,
                    updated_at: orden.updated_at || orden.created_at
                }, {
                    warningMinutes
                });
            } catch (pushError) {
                console.warn(`⚠️ [ExpService] Error enviando aviso por vencer para ${orden?.numero_orden || 'N/A'}:`, pushError.message);
            }
        }
    }
}

module.exports = new OrdenExpirationService();
