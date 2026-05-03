const path = require('path');
const knexConfig = require(path.resolve(__dirname, '..', 'knexfile')).production;
const knex = require('knex')(knexConfig);

(async () => {
  try {
    const row = await knex('ordenes')
      .select('numero_orden')
      .where('numero_orden', 'like', 'S1-%')
      .orderBy('numero_orden', 'desc')
      .first();
    console.log('max orden S1:', row ? row.numero_orden : null);
  } catch (err) {
    console.error('Error querying ordenes:', err.message || err);
    process.exit(1);
  } finally {
    await knex.destroy();
  }
})();
