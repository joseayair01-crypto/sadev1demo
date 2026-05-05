const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../backend/.env') });

const knex = require('knex');
const knexConfig = require('../backend/knexfile');

const db = knex(knexConfig.development);

async function listRifas() {
  try {
    const rifas = await db('rifas').select('id', 'slug', 'nombre', 'activa_publica');
    console.log(JSON.stringify(rifas, null, 2));
    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  } finally {
    await db.destroy();
  }
}

listRifas();
