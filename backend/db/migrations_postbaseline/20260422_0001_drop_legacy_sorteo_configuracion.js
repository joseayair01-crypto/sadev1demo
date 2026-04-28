exports.up = async function up(knex) {
  const exists = await knex.schema.hasTable('sorteo_configuracion');
  if (!exists) {
    return;
  }

  await knex.schema.dropTable('sorteo_configuracion');
};

exports.down = async function down(knex) {
  const exists = await knex.schema.hasTable('sorteo_configuracion');
  if (exists) {
    return;
  }

  await knex.schema.createTable('sorteo_configuracion', (table) => {
    table.increments('id').primary();
    table.string('clave', 100).notNullable().unique();
    table.jsonb('valor').notNullable().defaultTo('{}');
    table.string('actualizado_por', 255).nullable();
    table.timestamps(true, true);
    table.index('clave');
    table.index('updated_at');
  });
};
