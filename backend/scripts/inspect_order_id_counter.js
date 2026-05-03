const path = require('path');
const knexConfig = require(path.resolve(__dirname, '..', 'knexfile')).production;
const knex = require('knex')(knexConfig);

(async () => {
  try {
    const rows = await knex
      .select('id', 'cliente_id', 'rifa_id', 'ultima_secuencia', 'ultimo_numero', 'proximo_numero')
      .from('order_id_counter')
      .orderBy('updated_at', 'desc')
      .limit(10);
    console.log('order_id_counter sample:');
    console.log(JSON.stringify(rows, null, 2));
  } catch (err) {
    console.error('Error querying order_id_counter:', err.message || err);
    process.exit(1);
  } finally {
    await knex.destroy();
  }
})();
