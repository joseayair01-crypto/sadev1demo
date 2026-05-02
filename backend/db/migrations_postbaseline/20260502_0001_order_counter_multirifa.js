/**
 * 📊 MIGRACIÓN: Soporte Multi-Tenant para Contadores de Órdenes
 * 
 * Esta migración añade la columna rifa_id a la tabla order_id_counter
 * y establece las restricciones de unicidad necesarias para el aislamiento total.
 */

exports.up = async function(knex) {
    console.log('🚀 Iniciando migración: Multi-Tenant para order_id_counter');

    // 1. Añadir columna rifa_id si no existe
    const hasColumn = await knex.schema.hasColumn('order_id_counter', 'rifa_id');
    if (!hasColumn) {
        await knex.schema.table('order_id_counter', (table) => {
            table.integer('rifa_id').nullable().references('id').inTable('rifas').onDelete('CASCADE');
            table.index(['rifa_id'], 'idx_order_id_counter_rifa_id');
        });
        console.log('✅ Columna rifa_id añadida a order_id_counter');
    }

    // 2. Limpiar restricciones de unicidad antiguas (si existen)
    await knex.raw('ALTER TABLE order_id_counter DROP CONSTRAINT IF EXISTS order_id_counter_cliente_id_unique');
    await knex.raw('ALTER TABLE order_id_counter DROP CONSTRAINT IF EXISTS uniq_order_id_counter_ctx');

    // 3. Crear el nuevo índice de unicidad por contexto (cliente + rifa)
    // Esto es lo que permite que cada rifa tenga su propia secuencia 001
    await knex.schema.table('order_id_counter', (table) => {
        table.unique(['cliente_id', 'rifa_id'], 'uniq_order_id_counter_ctx');
    });
    console.log('✅ Restricción de unicidad por contexto (cliente, rifa) aplicada');
};

exports.down = async function(knex) {
    await knex.schema.table('order_id_counter', (table) => {
        table.dropUnique(['cliente_id', 'rifa_id'], 'uniq_order_id_counter_ctx');
        table.dropColumn('rifa_id');
    });
};
