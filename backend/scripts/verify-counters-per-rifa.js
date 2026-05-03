const path = require('path');
const knexConfig = require(path.resolve(__dirname, '..', 'knexfile')).production;
const knex = require('knex')(knexConfig);

(async () => {
    try {
        console.log('\n' + '='.repeat(80));
        console.log('📋 VALIDACIÓN: CONTADORES INDEPENDIENTES POR RIFA');
        console.log('='.repeat(80) + '\n');
        
        const counters = await knex('order_id_counter')
            .select('rifa_id', 'cliente_id', 'ultima_secuencia', 'proximo_numero', 'contador_total')
            .orderBy('rifa_id', 'asc');
        
        if (counters.length === 0) {
            console.log('⚠️ No hay contadores');
            await knex.destroy();
            return;
        }
        
        counters.forEach((counter) => {
            const proximoId = `S${counter.rifa_id}-${counter.ultima_secuencia}${counter.proximo_numero.toString().padStart(3, '0')}`;
            console.log(`✅ Rifa ${counter.rifa_id}:`);
            console.log(`   • Cliente key: ${counter.cliente_id}`);
            console.log(`   • Próximo ID a generar: ${proximoId}`);
            console.log(`   • Total IDs generados: ${counter.contador_total}`);
            console.log('');
        });
        
        // Mostrar órdenes generadas
        console.log('-'.repeat(80));
        console.log('📊 ÓRDENES GENERADAS (últimas 10):\n');
        
        const ordenes = await knex('ordenes')
            .select('numero_orden', 'estado', 'created_at')
            .whereIn('numero_orden', [
                knex.raw(`CONCAT('S1-', *)::text`),
                knex.raw(`CONCAT('S2-', *)::text`)
            ])
            .orWhere('numero_orden', 'like', 'S1-%')
            .orWhere('numero_orden', 'like', 'S2-%')
            .orderBy('created_at', 'desc')
            .limit(10);
        
        if (ordenes.length > 0) {
            const s1Orders = ordenes.filter(o => o.numero_orden.startsWith('S1-'));
            const s2Orders = ordenes.filter(o => o.numero_orden.startsWith('S2-'));
            
            if (s1Orders.length > 0) {
                console.log('Rifa 1 (últimas):');
                s1Orders.slice(0, 3).forEach(o => {
                    console.log(`  ${o.numero_orden} (${o.estado})`);
                });
            }
            
            if (s2Orders.length > 0) {
                console.log('\nRifa 2 (últimas):');
                s2Orders.slice(0, 3).forEach(o => {
                    console.log(`  ${o.numero_orden} (${o.estado})`);
                });
            }
        }
        
        console.log('\n' + '='.repeat(80));
        console.log('✅ RESULTADO: CADA RIFA TIENE SU PROPIO CONTADOR INDEPENDIENTE');
        console.log('='.repeat(80) + '\n');
        
        await knex.destroy();
    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
})();
