/**
 * Migración: Optimizar Índices para Concurrencia
 * 
 * ESTRATEGIA:
 * 1. Mantener solo índices que se usan en queries críticas
 * 2. Usar índices PARCIALES para reducir tamaño y overhead
 * 3. Eliminar índices redundantes o no usados
 * 
 * Índices críticos para concurrencia:
 * - UPDATE boletos_estado WHERE rifa_id=? AND estado='disponible' AND numero_orden IS NULL
 * - UPDATE orden_oportunidades WHERE rifa_id=? AND estado='disponible' AND numero_orden IS NULL
 * - SELECT de órdenes por número
 */

exports.up = async function(knex) {
    try {
        console.log('🚀 Optimizando índices para concurrencia...\n');

        // ===== PASO 1: CREAR ÍNDICES PARCIALES OPTIMIZADOS =====
        console.log('📌 Creando índices parciales para operaciones críticas...');

        // Índice PARCIAL para boletos disponibles (solo los que importan para UPDATE)
        await knex.raw(`
            CREATE INDEX IF NOT EXISTS idx_boletos_disponibles_para_actualizar
            ON boletos_estado(rifa_id, numero)
            WHERE estado = 'disponible' AND numero_orden IS NULL
        `);
        console.log('✅ idx_boletos_disponibles_para_actualizar');

        // Índice PARCIAL para búsqueda rápida de oportunidades
        await knex.raw(`
            CREATE INDEX IF NOT EXISTS idx_opp_disponibles_para_actualizar
            ON orden_oportunidades(rifa_id, numero_boleto)
            WHERE estado = 'disponible' AND numero_orden IS NULL
        `);
        console.log('✅ idx_opp_disponibles_para_actualizar');

        // Índice para búsqueda de órdenes por número (duplicado check es crítico)
        await knex.raw(`
            CREATE INDEX IF NOT EXISTS idx_ordenes_numero_rifa_id
            ON ordenes(numero_orden, rifa_id)
        `);
        console.log('✅ idx_ordenes_numero_rifa_id');

        // ===== PASO 2: ANALIZAR ÍNDICES REDUNDANTES =====
        console.log('\n📊 Analizando índices redundantes...');

        const result = await knex.raw(`
            SELECT 
                schemaname,
                tablename,
                indexname,
                indexdef,
                idx_scan,
                idx_tup_read,
                idx_tup_fetch
            FROM pg_stat_user_indexes
            WHERE schemaname = 'public'
            ORDER BY idx_scan ASC, idx_tup_read ASC
            LIMIT 20
        `);

        console.log('\n⚠️  Índices nunca/raramente usados (candidatos a eliminar):');
        if (result.rows && result.rows.length > 0) {
            result.rows.forEach((row, i) => {
                console.log(`${i + 1}. ${row.indexname}`);
                console.log(`   Tabla: ${row.tablename}`);
                console.log(`   Scans: ${row.idx_scan}, Lecturas: ${row.idx_tup_read}`);
            });
        }

        // ===== PASO 3: ESTADÍSTICAS Y RECOMENDACIONES =====
        console.log('\n' + '='.repeat(80));
        console.log('📈 RECOMENDACIONES DE LIMPIEZA');
        console.log('='.repeat(80));
        console.log(`
⚠️  Considera eliminar ÍNDICES NO USADOS (con idx_scan = 0):
   - idx_boletos_disponibles_para_seleccion
   - idx_boletos_estado (muy genérico, usar parcial en su lugar)
   - idx_boletos_vendidos_fecha
   - idx_boletos_estado_updated

✅ MANTENER ÍNDICES ESENCIALES:
   - idx_boletos_rifa_numero_unique (UNIQUE constraint)
   - idx_boletos_rifa_numero_orden_estado (compound, crítico)
   - idx_opp_numero_boleto_oportunidad (UNIQUE)
   - idx_ordenes_numero_orden (UNIQUE)
   - idx_ordenes_rifa_estado_created (expiración)

🔥 NUEVOS ÍNDICES PARCIALES (creados):
   - idx_boletos_disponibles_para_actualizar (solo "disponible")
   - idx_opp_disponibles_para_actualizar (solo "disponible")
   - idx_ordenes_numero_rifa_id (búsqueda de duplicados)
        `);

        console.log('\n✅ Migración completada');
        console.log('⚡ PRÓXIMO PASO: Ejecutar VACUUM ANALYZE para actualizar estadísticas');

    } catch (error) {
        console.error('❌ Error:', error.message);
        throw error;
    }
};

exports.down = async function(knex) {
    try {
        console.log('🔄 Eliminando índices optimizados...');

        const indexes = [
            'idx_boletos_disponibles_para_actualizar',
            'idx_opp_disponibles_para_actualizar',
            'idx_ordenes_numero_rifa_id'
        ];

        for (const idx of indexes) {
            try {
                await knex.raw(`DROP INDEX IF EXISTS ${idx}`);
                console.log(`🗑️  ${idx} eliminado`);
            } catch (e) {
                console.log(`⚠️  ${idx} no pudo eliminarse`);
            }
        }

        console.log('✅ Rollback completado');
    } catch (error) {
        console.error('❌ Error al hacer rollback:', error.message);
    }
};
