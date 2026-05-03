
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../backend/.env') });
const db = require('../backend/db');

async function checkResults() {
    const count = await db('ordenes').where('nombre_cliente', 'like', 'User%Stress%').count('* as total').first();
    console.log(`Órdenes de estrés encontradas en BD: ${count.total}`);
    await db.destroy();
}
checkResults();
