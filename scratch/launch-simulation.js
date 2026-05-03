
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../backend/.env') });
const db = require('../backend/db');
const { startServer } = require('../backend/tests/integration/helpers/serverHarness');

async function runLaunchSimulation() {
    console.log('--- Sustained Launch Simulation: Self-Managed ---');
    
    const port = 5400;
    const server = await startServer({ 
        cwd: path.join(__dirname, '../backend'), 
        port 
    });
    console.log(`🚀 Servidor iniciado en puerto ${port}`);

    const rifa = await db('rifas').where('activa_publica', true).first();
    const availableTickets = await db('boletos_estado')
        .where({ rifa_id: rifa.id, estado: 'disponible' })
        .limit(500)
        .select('numero');

    if (availableTickets.length < 200) {
        console.error('No hay suficientes boletos.');
        await server.stop();
        process.exit(1);
    }

    const serverUrl = `http://127.0.0.1:${port}`;
    let totalSuccess = 0;
    let totalFail = 0;
    const durationMs = 30000; // 30 segundos para no tardar tanto
    const startTime = Date.now();
    let ticketIndex = 0;

    console.log(`Lanzando ráfagas (3 compras/seg) durante 30s...`);

    const interval = setInterval(async () => {
        const elapsed = Date.now() - startTime;
        if (elapsed >= durationMs || ticketIndex >= availableTickets.length) {
            clearInterval(interval);
            return;
        }

        const burstPromises = [];
        for (let i = 0; i < 3; i++) {
            if (ticketIndex >= availableTickets.length) break;
            const ticketNum = availableTickets[ticketIndex++].numero;
            
            burstPromises.push(
                fetch(`${serverUrl}/api/ordenes`, {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'x-rifa-id': String(rifa.id) 
                    },
                    body: JSON.stringify({
                        cliente: {
                            nombre: `RushUser${ticketIndex}`,
                            apellidos: 'Test',
                            whatsapp: `5500${ticketIndex.toString().padStart(6, '0')}`,
                            estado: 'MX',
                            ciudad: 'MX'
                        },
                        boletos: [ticketNum],
                        totales: { subtotal: 50, descuento: 0, totalFinal: 50 },
                        metodoPago: 'transferencia'
                    })
                }).then(res => res.ok).catch(() => false)
            );
        }
        const results = await Promise.all(burstPromises);
        totalSuccess += results.filter(r => r).length;
        totalFail += results.filter(r => !r).length;
        
        process.stdout.write(`\rProgreso: ${Math.round((elapsed/durationMs)*100)}% | Éxitos: ${totalSuccess} | Fallos: ${totalFail}`);
    }, 1000);

    await new Promise(resolve => setTimeout(resolve, durationMs + 5000));

    console.log('\n\n--- Resultados ---');
    console.log(`Éxitos: ${totalSuccess}`);
    console.log(`Fallos: ${totalFail}`);

    await server.stop();
    await db.destroy();
}

runLaunchSimulation();
