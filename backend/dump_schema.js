require('dotenv').config();
const db = require('./db');

async function dumpSchema() {
    try {
        const query = `
            SELECT table_name, column_name, data_type 
            FROM information_schema.columns 
            WHERE table_schema = 'public' 
            AND table_name IN ('boletos_estado', 'ordenes', 'orden_oportunidades');
        `;
        const result = await db.raw(query);
        console.log(JSON.stringify(result.rows, null, 2));

        const queryIndexes = `
            SELECT tablename, indexname, indexdef
            FROM pg_indexes
            WHERE schemaname = 'public'
            AND tablename IN ('boletos_estado', 'ordenes', 'orden_oportunidades');
        `;
        const resultIndexes = await db.raw(queryIndexes);
        console.log(JSON.stringify(resultIndexes.rows, null, 2));

    } catch (e) {
        console.error(e);
    } finally {
        await db.destroy();
    }
}

dumpSchema();
