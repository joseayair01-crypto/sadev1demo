
exports.up = async function (knex) {
  const hasColumn = await knex.schema.hasColumn('rifas', 'dominio');
  if (!hasColumn) {
    await knex.schema.table('rifas', (table) => {
      table.string('dominio', 255).nullable().unique();
      table.index(['dominio']);
    });
  }
};

exports.down = async function (knex) {
  const hasColumn = await knex.schema.hasColumn('rifas', 'dominio');
  if (hasColumn) {
    await knex.schema.table('rifas', (table) => {
      table.dropColumn('dominio');
    });
  }
};
