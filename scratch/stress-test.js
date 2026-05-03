
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../backend/.env') });
const db = require('../backend/db');
const { startServer } = require('../backend/tests/integration/helpers/serverHarness');

async function runStressTest() {
    console.log('--- Stress Test: Self-Managed Server Simulation ---');
    
    const port = 5301;
    const server = await startServer({ 
        cwd: path.join(__dirname, '../backend'), 
        port 
    });
    console.log(`🚀 Servidor iniciado en puerto ${port}`);

    const rifa = await db('rifas').where('activa_publica', true).first();
    if (!rifa) {
        console.error('No hay rifas activas.');
        await server.stop();
        process.exit(1);
    }

    const availableTickets = await db('boletos_estado')
        .where('rifa_id', rifa.id)
        .where('estado', 'disponible')
        .limit(100)
        .select('numero');
    
    if (availableTickets.length < 15) {
        console.error('No hay suficientes boletos disponibles.');
        await server.stop();
        process.exit(1);
    }

    const ticketsToTest = availableTickets.slice(0, 15).map(t => t.numero);
    console.log(`Comprando ${ticketsToTest.length} boletos...`);

    const serverUrl = `http://127.0.0.1:${port}`; 
    
    const startTime = Date.now();
    const requests = ticketsToTest.map(async (ticketNum, index) => {
        try {
            const response = await fetch(`${serverUrl}/api/ordenes`, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'x-rifa-id': String(rifa.id) 
                },
                body: JSON.stringify({
                    cliente: {
                        nombre: `User${index}`,
                        apellidos: 'Stress',
                        whatsapp: `55123456${index.toString().padStart(2, '0')}`,
                        estado: 'MX',
                        ciudad: 'MX'
                    },
                    boletos: [ticketNum],
                    totales: { subtotal: 50, descuento: 0, totalFinal: 50 },
                    metodoPago: 'transferencia'
                })
            });
            const data = await response.json();
            return { ok: response.ok, status: response.status, message: data.message };
        } catch (err) {
            return { error: true, message: err.message };
        }
    });

    const results = await Promise.all(requests);
    const endTime = Date.now();

    console.log('\n--- Resultados ---');
    console.log(`Exitos: ${results.filter(r => r.ok).length}`);
    console.log(`Fallos: ${results.filter(r => !r.ok).length}`);

    if (results.some(r => !r.ok)) {
        console.log('\n--- SERVER LOGS ---');
        const logs = server.getLogs();
        console.log(logs.stdout);
        console.error(logs.stderr);
    }

    await server.stop();
    await db.destroy();
}

runStressTest().catch(console.error);
