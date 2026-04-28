/**
 * CacheDisponibilidadService
 * 
 * Mantiene caché en memoria de:
 * - Total de oportunidades disponibles
 * - Total de boletos disponibles
 * - Se actualiza cuando se crean/liberan órdenes
 * 
 * Beneficio: Evita queries COUNT(*) costosas en cada request
 */

const db = require('../db');

class CacheDisponibilidadService {
    constructor() {
        this.cache = new Map();
        this.ttl = 5000; // 5 segundos
    }

    _normalizarContexto(contexto = {}) {
        const rifaId = Number.parseInt(contexto?.rifaId, 10);
        return {
            rifaId: Number.isInteger(rifaId) && rifaId > 0 ? rifaId : null
        };
    }

    _obtenerClave(contexto = {}) {
        const { rifaId } = this._normalizarContexto(contexto);
        return String(rifaId || 'default');
    }

    _obtenerEstadoInicial() {
        return {
            disponibles: {
                oportunidades: 0,
                boletos: 0
            },
            lastUpdate: null,
            updateInProgress: false
        };
    }

    _obtenerEstado(contexto = {}) {
        const cacheKey = this._obtenerClave(contexto);
        if (!this.cache.has(cacheKey)) {
            this.cache.set(cacheKey, this._obtenerEstadoInicial());
        }
        return this.cache.get(cacheKey);
    }

    _aplicarContexto(query, contexto = {}) {
        const { rifaId } = this._normalizarContexto(contexto);
        if (rifaId) {
            query.where('rifa_id', rifaId);
        }
        return query;
    }

    /**
     * Obtener disponibles con caché
     * Si caché expiró (> 5s), recalcula
     */
    async obtenerDisponibles(contexto = {}) {
        const ahora = Date.now();
        const state = this._obtenerEstado(contexto);
        
        // Si caché es fresco, devolverlo
        if (state.lastUpdate && (ahora - state.lastUpdate) < this.ttl && !state.updateInProgress) {
            return {
                ...state.disponibles,
                fromCache: true,
                edad: ahora - state.lastUpdate
            };
        }

        // Si ya se está actualizando, devolver valor actual
        if (state.updateInProgress) {
            return {
                ...state.disponibles,
                fromCache: true,
                actualizando: true
            };
        }

        // Si caché expiró, actualizar en background
        if (state.lastUpdate && (ahora - state.lastUpdate) >= this.ttl) {
            this.actualizarEnBackground(contexto);
            return {
                ...state.disponibles,
                fromCache: true,
                edad: ahora - state.lastUpdate
            };
        }

        // Primera vez, esperar actualización
        return await this.actualizarAhora(contexto);
    }

    /**
     * Actualizar caché AHORA (bloqueante)
     */
    async actualizarAhora(contexto = {}) {
        const state = this._obtenerEstado(contexto);
        state.updateInProgress = true;
        try {
            const [opp, bol] = await Promise.all([
                this._aplicarContexto(db('orden_oportunidades'), contexto)
                    .where('estado', 'disponible')
                    .whereNull('numero_orden')
                    .count('*', { as: 'total' })
                    .first(),
                this._aplicarContexto(db('boletos_estado'), contexto)
                    .where('estado', 'disponible')
                    .whereNull('numero_orden')
                    .count('*', { as: 'total' })
                    .first()
            ]);

            state.disponibles = {
                oportunidades: parseInt(opp?.total || 0),
                boletos: parseInt(bol?.total || 0)
            };
            state.lastUpdate = Date.now();

            console.log(`♻️  [Cache] Actualizado: ${state.disponibles.oportunidades} opp, ${state.disponibles.boletos} boletos`);
            return {
                ...state.disponibles,
                fromCache: false
            };
        } finally {
            state.updateInProgress = false;
        }
    }

    /**
     * Actualizar en background (sin esperar)
     */
    actualizarEnBackground(contexto = {}) {
        const state = this._obtenerEstado(contexto);
        state.updateInProgress = true;
        
        Promise.all([
            this._aplicarContexto(db('orden_oportunidades'), contexto)
                .where('estado', 'disponible')
                .whereNull('numero_orden')
                .count('*', { as: 'total' })
                .first(),
            this._aplicarContexto(db('boletos_estado'), contexto)
                .where('estado', 'disponible')
                .whereNull('numero_orden')
                .count('*', { as: 'total' })
                .first()
        ])
        .then(([opp, bol]) => {
            state.disponibles = {
                oportunidades: parseInt(opp?.total || 0),
                boletos: parseInt(bol?.total || 0)
            };
            state.lastUpdate = Date.now();
            console.log(`♻️  [Cache] Actualizado (background): ${state.disponibles.oportunidades} opp, ${state.disponibles.boletos} boletos`);
        })
        .catch(err => {
            console.error('❌ [Cache] Error actualizando:', err.message);
        })
        .finally(() => {
            state.updateInProgress = false;
        });
    }

    /**
     * Invalidar caché (cuando se crean/liberan órdenes)
     */
    invalidar(contexto = {}) {
        console.log('🗑️  [Cache] Invalidado');
        const state = this._obtenerEstado(contexto);
        state.lastUpdate = null;
        this.actualizarEnBackground(contexto);
    }

    /**
     * Restar manualmente (cuando se crea una orden)
     * Más rápido que recalcular
     */
    restarOportunidades(cantidad = 1, contexto = {}) {
        const state = this._obtenerEstado(contexto);
        state.disponibles.oportunidades = Math.max(0, state.disponibles.oportunidades - cantidad);
    }

    restarBoletos(cantidad = 1, contexto = {}) {
        const state = this._obtenerEstado(contexto);
        state.disponibles.boletos = Math.max(0, state.disponibles.boletos - cantidad);
    }

    /**
     * Sumar manualmente (cuando se liberan órdenes)
     */
    sumarOportunidades(cantidad = 1, contexto = {}) {
        const state = this._obtenerEstado(contexto);
        state.disponibles.oportunidades += cantidad;
    }

    sumarBoletos(cantidad = 1, contexto = {}) {
        const state = this._obtenerEstado(contexto);
        state.disponibles.boletos += cantidad;
    }

    /**
     * Estado actual del caché
     */
    getStatus(contexto = {}) {
        const state = this._obtenerEstado(contexto);
        return {
            disponibles: state.disponibles,
            lastUpdate: state.lastUpdate,
            edad: state.lastUpdate ? Date.now() - state.lastUpdate : null,
            actualizando: state.updateInProgress,
            ttl: this.ttl
        };
    }
}

module.exports = new CacheDisponibilidadService();
