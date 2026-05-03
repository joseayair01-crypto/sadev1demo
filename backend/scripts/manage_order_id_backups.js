const path = require('path');
const knexConfig = require(path.resolve(__dirname, '..', 'knexfile')).production;
const knex = require('knex')(knexConfig);

async function listTables() {
  const tables = await knex.raw(`
    SELECT tablename
    FROM pg_catalog.pg_tables
    WHERE schemaname = 'public' AND (tablename ILIKE '%order_id_counter%' OR (tablename ILIKE '%order%' AND tablename ILIKE '%counter%'))
  `);
  return tables.rows.map(r => r.tablename);
}

async function inspectTable(tableName) {
  try {
    const sizeRes = await knex.raw(`SELECT pg_size_pretty(pg_total_relation_size(?::regclass)) AS total_size`, [tableName]);
    const rows = await knex.raw('SELECT * FROM ?? LIMIT 5', [tableName]);
    return { tableName, total_size: sizeRes.rows[0] && sizeRes.rows[0].total_size, sample: rows.rows };
  } catch (err) {
    return { tableName, error: err.message };
  }
}

async function dropBackups() {
  const backups = await knex.raw(`
    SELECT tablename FROM pg_catalog.pg_tables
    WHERE schemaname = 'public' AND tablename ILIKE 'order_id_counter_backup_%'
  `);
  for (const r of backups.rows) {
    const name = r.tablename;
    console.log('Dropping', name);
    await knex.raw('DROP TABLE IF EXISTS ?? CASCADE', [name]);
  }
  return backups.rows.map(r => r.tablename);
}

(async () => {
  try {
    console.log('Listing candidate tables...');
    const tables = await listTables();
    if (!tables.length) {
      console.log('No matching tables found.');
      process.exit(0);
    }
    const results = [];
    for (const t of tables) {
      const info = await inspectTable(t);
      results.push(info);
    }
    console.log('INSPECTION_RESULT_START');
    console.log(JSON.stringify(results, null, 2));
    console.log('INSPECTION_RESULT_END');

    if (process.argv.includes('--drop')) {
      console.log('Dropping backup tables matching order_id_counter_backup_%...');
      const dropped = await dropBackups();
      console.log('Dropped:', dropped);
    } else {
      console.log('Run with --drop to remove tables named order_id_counter_backup_%');
    }
  } catch (err) {
    console.error('Error:', err.message || err);
    process.exit(1);
  } finally {
    await knex.destroy();
  }
})();
