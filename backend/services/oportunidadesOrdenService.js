const db = require('../db');
const { normalizeRifaContext, applyRifaScope } = require('./rifaScope');

class OportunidadesOrdenService {
    static _normalizarContextoRifa(contexto = {}) {
        return normalizeRifaContext(contexto);
    }

    static _whereRifa(query, contexto = {}) {
        return applyRifaScope(query, contexto);
    }

    /**
     * El sistema actual usa oportunidades precargadas en BD:
     * 1. Cada oportunidad existe antes de la compra y queda ligada a un numero_boleto.
     * 2. La orden solo aparta o confirma esas filas ya preasignadas.
     * 3. Este servicio consulta y libera ese estado persistido.
     */
    static async obtenerOportunidades(numeroOrden, contexto = {}) {
        try {
            const opps = await this._whereRifa(db('orden_oportunidades'), contexto)
                .where('numero_orden', numeroOrden)
                .pluck('numero_oportunidad');
            
            // ✅ Retornar estructura CORRECTA con 'tipo'
            if (opps.length === 0) {
                return { tipo: 'no_data', data: [], error: null };
            }
            
            return { tipo: 'success', data: opps, error: null };
        } catch (error) {
            console.error(`Error obtenerOportunidades:`, error.message);
            return { tipo: 'error', data: [], error: error.message };
        }
    }

    /**
     * Liberar oportunidades cuando se cancela orden
     */
    static async liberarOportunidades(numeroOrden, contexto = {}) {
        try {
            const cantidad = await this._whereRifa(db('orden_oportunidades'), contexto)
                .where('numero_orden', numeroOrden)
                .whereIn('estado', ['apartado', 'vendido'])
                .update({
                    numero_orden: null,
                    estado: 'disponible'
                });

            console.log(`✅ Liberadas ${cantidad} oportunidades de ${numeroOrden}`);
            return { success: true, cantidad };
        } catch (error) {
            console.error(`Error liberarOportunidades:`, error.message);
            throw error;
        }
    }

    /**
     * Estadísticas
     */
    static async obtenerEstadisticas(contexto = {}) {
        try {
            const resultado = await this._whereRifa(db('orden_oportunidades'), contexto)
                .select(
                    db.raw('COUNT(*) as total'),
                    db.raw(`SUM(CASE WHEN estado = 'disponible' AND numero_orden IS NULL THEN 1 ELSE 0 END) as disponibles`),
                    db.raw(`SUM(CASE WHEN estado = 'apartado' THEN 1 ELSE 0 END) as apartadas`),
                    db.raw(`SUM(CASE WHEN estado = 'vendido' THEN 1 ELSE 0 END) as vendidas`)
                )
                .first();

            return {
                total: resultado?.total || 0,
                disponibles: resultado?.disponibles || 0,
                apartadas: resultado?.apartadas || 0,
                vendidas: resultado?.vendidas || 0
            };
        } catch (error) {
            console.error(`Error obtenerEstadisticas:`, error.message);
            return { total: 0, disponibles: 0, apartadas: 0, vendidas: 0 };
        }
    }
}

module.exports = OportunidadesOrdenService;
