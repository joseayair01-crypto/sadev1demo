const dotenv = require('dotenv');
const path = require('path');
dotenv.config({ path: path.resolve(__dirname, '../backend/.env') });

const db = require('../backend/db');

async function main() {
    try {
        console.log('--- DETALLE DE BOLETOS POR ESTADO ---');
        
        // 1. Conteo total real usando COUNT(*)
        const [totalReal] = await db('boletos_estado').count('* as count');
        console.log(`Conteo total REAL físico en boletos_estado: ${totalReal.count}`);

        // 2. Conteo por estado de boleto
        const porEstado = await db('boletos_estado')
            .select('estado')
            .count('* as total')
            .groupBy('estado');
        console.table(porEstado);

        // 3. Conteo de rifas por id
        const rifasIds = await db('rifas').select('id');
        console.log('IDs de rifas existentes en la tabla "rifas":');
        console.table(rifasIds);

    } catch (error) {
        console.error('Error al ejecutar inspección:', error);
    } finally {
        await db.destroy();
    }
}

main();
