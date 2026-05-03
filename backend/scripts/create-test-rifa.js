const path = require('path');
const knexConfig = require(path.resolve(__dirname, '..', 'knexfile')).production;
const knex = require('knex')(knexConfig);

(async () => {
    try {
        console.log('\n📝 Creando nueva rifa de prueba...\n');
        
        // Crear nueva rifa
        const [nuevaRifa] = await knex('rifas')
            .insert({
                slug: 'test-rifa-2',
                nombre: 'Rifa Test 2',
                estado: 'borrador',
                es_predeterminada: false,
                activa_publica: false,
                configuracion: {
                    rifa: { totalBoletos: 1000, nombreSorteo: 'Test 2' },
                    cliente: { id: 'test_client_2', prefijoOrden: 'S2' }
                },
                created_at: knex.fn.now(),
                updated_at: knex.fn.now(),
                actualizado_por: 'TEST_SCRIPT'
            })
            .returning('*');
        
        console.log(`✅ Nueva rifa creada: ID = ${nuevaRifa.id}, Slug = ${nuevaRifa.slug}`);
        console.log(`   Nombre: ${nuevaRifa.nombre}`);
        
        // Mostrar rifas existentes
        console.log('\n📋 Rifas existentes en BD:');
        const rifas = await knex('rifas').select('id', 'slug', 'nombre', 'estado');
        rifas.forEach(r => {
            console.log(`   • ID: ${r.id}, Slug: ${r.slug}, Nombre: ${r.nombre}, Estado: ${r.estado}`);
        });
        
        // Mostrar contadores existentes
        console.log('\n📋 Contadores existentes:');
        const counters = await knex('order_id_counter')
            .select('id', 'cliente_id', 'rifa_id', 'ultima_secuencia', 'proximo_numero', 'contador_total')
            .orderBy('rifa_id', 'asc');
        if (counters.length > 0) {
            counters.forEach(c => {
                console.log(`   • Rifa ID: ${c.rifa_id}, Cliente: ${c.cliente_id}, Proximo: ${c.ultima_secuencia}${c.proximo_numero.toString().padStart(3, '0')}, Total generado: ${c.contador_total}`);
            });
        } else {
            console.log('   (Ninguno aún - se crearán cuando se genere el primer ID)');
        }
        
        console.log('\n💡 PRÓXIMOS PASOS:');
        console.log(`   1. Generar ID para Rifa 1 con endpoint: POST /api/public/order-counter/next (x-rifa-id: 1)`);
        console.log(`   2. Generar ID para Rifa ${nuevaRifa.id} con endpoint: POST /api/public/order-counter/next (x-rifa-id: ${nuevaRifa.id})`);
        console.log('   3. Verificar que cada rifa tiene su propio contador independiente\n');
        
        await knex.destroy();
    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
})();
