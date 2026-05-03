const path = require('path');
const knexConfig = require(path.resolve(__dirname, '..', 'knexfile')).production;
const knex = require('knex')(knexConfig);

(async () => {
    try {
        console.log('\n🧹 Limpiando órdenes S1 antiguas...\n');
        
        // Delete orders
        const deletedOrdenes = await knex('ordenes')
            .where('numero_orden', 'like', 'S1-%')
            .delete();
        console.log(`✅ Órdenes eliminadas: ${deletedOrdenes}`);
        
        // Delete boletos_estado entries linked to deleted orders
        const deletedBoletos = await knex('boletos_estado')
            .where('numero_orden', 'like', 'S1-%')
            .update({ numero_orden: null, estado: 'disponible', updated_at: new Date() });
        console.log(`✅ Boletos liberados: ${deletedBoletos}`);
        
        // Reset counter
        const resetCounter = await knex('order_id_counter')
            .where('cliente_id', 'rifa_1')
            .where('rifa_id', 1)
            .update({
                ultima_secuencia: 'AA',
                ultimo_numero: 0,
                proximo_numero: 1,
                contador_total: 0,
                updated_at: new Date()
            });
        console.log(`✅ Contador reset: ${resetCounter}`);
        
        // Verify counter
        const counter = await knex('order_id_counter')
            .where('cliente_id', 'rifa_1')
            .where('rifa_id', 1)
            .first();
        
        console.log('\n📋 Estado limpio:');
        console.log(`  • ultima_secuencia: ${counter.ultima_secuencia}`);
        console.log(`  • ultimo_numero: ${counter.ultimo_numero}`);
        console.log(`  • proximo_numero: ${counter.proximo_numero}`);
        console.log(`  • contador_total: ${counter.contador_total}`);
        console.log('');
        
        await knex.destroy();
    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
})();
