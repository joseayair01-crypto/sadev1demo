const path = require('path');
const tableName = process.argv[2];
if (!tableName) {
  console.error('Uso: node drop_backup_table.js <table_name>');
  process.exit(2);
}
const knexConfig = require(path.resolve(__dirname, '..', 'knexfile')).production;
const knex = require('knex')(knexConfig);
(async () => {
  try {
    console.log('Dropping table if exists:', tableName);
    await knex.raw(`DROP TABLE IF EXISTS "${tableName}"`);
    console.log('Dropped:', tableName);
    process.exit(0);
  } catch (err) {
    console.error('Error dropping table:', err.message || err);
    process.exit(1);
  } finally {
    await knex.destroy();
  }
})();
