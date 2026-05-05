const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../backend/.env') });

const knex = require('knex');
const knexConfig = require('../backend/knexfile');

const db = knex(knexConfig.development);

async function compareConfigs() {
  try {
    const s1 = await db('rifas').where('slug', 'S1').first();
    const s2 = await db('rifas').where('slug', 's2').first();
    
    console.log('=== RIFA S1 (ID: ' + s1.id + ') ===');
    console.log('Nombre:', s1.nombre);
    console.log('Total Boletos:', s1.configuracion?.rifa?.totalBoletos);
    console.log('Precio:', s1.configuracion?.rifa?.precioBoleto);
    
    console.log('\n=== RIFA s2 (ID: ' + s2.id + ') ===');
    console.log('Nombre:', s2.nombre);
    console.log('Total Boletos:', s2.configuracion?.rifa?.totalBoletos);
    console.log('Precio:', s2.configuracion?.rifa?.precioBoleto);
    
    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  } finally {
    await db.destroy();
  }
}

compareConfigs();
