/**
 * Migración: Optimización para Concurrencia Alta
 * Crea índices específicos para operaciones concurrentes de órdenes
 */

exports.up = async function(knex) {
    try {
        console.log('🚀 [Migration] Optimizando índices para concurrencia alta...');

        // Índice compuesto específico para el UPDATE de reserva de boletos
        // Esta es la operación más crítica en concurrencia
        await knex.raw(`
            CREATE INDEX IF NOT EXISTS idx_boletos_concurrency 
            ON boletos_estado(rifa_id, estado, numero_orden, numero)
            WHERE estado = 'disponible' AND numero_orden IS NULL
        `);
        console.log('✅ idx_boletos_concurrency creado');

        // Índice para UPDATE de oportunidades
        await knex.raw(`
            CREATE INDEX IF NOT EXISTS idx_oportunidades_concurrency 
            ON orden_oportunidades(rifa_id, estado, numero_orden, numero_boleto)
            WHERE estado = 'disponible' AND numero_orden IS NULL
        `);
        console.log('✅ idx_oportunidades_concurrency creado');

        // Índice para búsqueda rápida de órdenes por numero_orden
        await knex.raw(`
            CREATE INDEX IF NOT EXISTS idx_ordenes_numero_orden_rifa 
            ON ordenes(rifa_id, numero_orden)
        `);
        console.log('✅ idx_ordenes_numero_orden_rifa creado');

        // Índice para búsqueda por rifa_id + estado (usado en varias queries)
        await knex.raw(`
            CREATE INDEX IF NOT EXISTS idx_boletos_rifa_estado 
            ON boletos_estado(rifa_id, estado)
        `);
        console.log('✅ idx_boletos_rifa_estado creado');

        // Estadísticas
        await knex.raw(`ANALYZE boletos_estado`);
        await knex.raw(`ANALYZE orden_oportunidades`);
        await knex.raw(`ANALYZE ordenes`);
        console.log('✅ Estadísticas actualizadas');

        console.log('✅ Migración completada exitosamente');

    } catch (error) {
        console.error('❌ Error en migración:', error.message);
        // No fallar la migración si los índices ya existen
    }
};

exports.down = async function(knex) {
    try {
        console.log('🔄 [Migration] Eliminando índices de concurrencia...');

        const indexes = [
            'idx_boletos_concurrency',
            'idx_oportunidades_concurrency',
            'idx_ordenes_numero_orden_rifa',
            'idx_boletos_rifa_estado'
        ];

        for (const idx of indexes) {
            try {
                await knex.raw(`DROP INDEX IF EXISTS ${idx}`);
                console.log(`🗑️  ${idx} eliminado`);
            } catch (e) {
                console.log(`⚠️  ${idx} no existía`);
            }
        }

        console.log('✅ Rollback completado');
    } catch (error) {
        console.error('❌ Error al eliminar índices:', error.message);
    }
};
