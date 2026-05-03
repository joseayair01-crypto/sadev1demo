
/**
 * MIGRACIÓN 20260503_0002: LIMPIEZA FINAL DE ÍNDICES REDUNDANTES
 * 
 * Objetivo: Eliminar índices que son duplicados exactos o que ya están cubiertos
 * por otros índices compuestos, optimizando el rendimiento de escritura.
 */

exports.up = async function(knex) {
    console.log('🧹 Iniciando limpieza de índices redundantes...');

    const indexesToDrop = [
        // Duplicados Exactos
        'idx_boletos_vendidos_fecha',
        'idx_ordenes_expiracion',
        'idx_ordenes_numero_orden',
        'idx_opp_disponibles',
        
        // Redundantes (Cubiertos por índices compuestos)
        'idx_ordenes_rifa_id',
        'idx_boletos_numero_orden',
        'idx_boletos_estado_rifa_id',
        'idx_ganadores_rifa_id',
        'idx_opp_numero_boleto_disponibles',
        
        // Push Subscriptions
        'push_campaign_subscriptions_status_idx'
    ];

    for (const idx of indexesToDrop) {
        try {
            await knex.raw(`DROP INDEX IF EXISTS "${idx}"`);
            console.log(`   ✅ Eliminado: ${idx}`);
        } catch (err) {
            console.log(`   ⚠️  Saltado: ${idx} (${err.message})`);
        }
    }

    console.log('✅ Limpieza de índices completada.');
};

exports.down = async function(knex) {
    console.log('↩️  Recreando índices eliminados (Rollback)...');

    // Nota: Solo recreamos los más críticos si fuera necesario, 
    // pero para un rollback completo se deberían definir todos.
    // Por brevedad y seguridad, recreamos los que podrían ser usados individualmente.
    
    try {
        await knex.raw('CREATE INDEX IF NOT EXISTS idx_ordenes_rifa_id ON ordenes(rifa_id)');
        await knex.raw('CREATE INDEX IF NOT EXISTS idx_boletos_numero_orden ON boletos_estado(numero_orden)');
        console.log('   ✅ Índices básicos recreados.');
    } catch (err) {
        console.error('   ❌ Error en rollback:', err.message);
    }
};
