const path = require('path');
const knexConfig = require(path.resolve(__dirname, '..', 'knexfile')).production;
const knex = require('knex')(knexConfig);

(async () => {
    try {
        console.log('\n📝 Reseteando contador order_id_counter...\n');
        const r = await knex('order_id_counter')
            .where('cliente_id', 'rifa_1')
            .where('rifa_id', 1)
            .update({
                ultima_secuencia: 'AA',
                ultimo_numero: 0,
                proximo_numero: 1,
                contador_total: 0,
                updated_at: new Date()
            });
        
        console.log(`✅ Rows updated: ${r}`);
        
        // Verify
        const counter = await knex('order_id_counter')
            .where('cliente_id', 'rifa_1')
            .where('rifa_id', 1)
            .first();
        
        console.log('\n📋 Estado después del reset:');
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
