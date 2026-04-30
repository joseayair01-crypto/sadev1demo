exports.up = async function(knex) {
  console.log('📊 [Migration] Creando índices para rifa_id (Optimización Multi-Rifa)...');
  
  await knex.schema.table('boletos_estado', (table) => {
    table.index('rifa_id', 'idx_boletos_rifa_id');
  }).catch(() => console.log('⚠️  Índice rifa_id ya existe en boletos_estado'));

  await knex.schema.table('ordenes', (table) => {
    table.index('rifa_id', 'idx_ordenes_rifa_id');
  }).catch(() => console.log('⚠️  Índice rifa_id ya existe en ordenes'));

  await knex.schema.table('orden_oportunidades', (table) => {
    table.index('rifa_id', 'idx_oportunidades_rifa_id');
  }).catch(() => console.log('⚠️  Índice rifa_id ya existe en orden_oportunidades'));

  console.log('✅ Índices de rifa_id creados');
};

exports.down = async function(knex) {
  await knex.schema.table('boletos_estado', (table) => table.dropIndex('rifa_id', 'idx_boletos_rifa_id'));
  await knex.schema.table('ordenes', (table) => table.dropIndex('rifa_id', 'idx_ordenes_rifa_id'));
  await knex.schema.table('orden_oportunidades', (table) => table.dropIndex('rifa_id', 'idx_oportunidades_rifa_id'));
};
