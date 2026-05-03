
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../backend/.env') });
const db = require('../backend/db');

async function runConcurrencyRace() {
    console.log('--- Concurrency Race: 10 Users vs 1 Ticket ---');
    
    // 1. Encontrar un boleto que esté disponible
    const rifa = await db('rifas').where('activa_publica', true).first();
    const boleto = await db('boletos_estado')
        .where({ rifa_id: rifa.id, estado: 'disponible' })
        .first();

    if (!boleto) {
        console.error('No hay boletos disponibles para la prueba.');
        process.exit(1);
    }

    const targetTicket = boleto.numero;
    console.log(`Objetivo: Boleto #${targetTicket} en Rifa ID ${rifa.id}`);

    const serverUrl = 'http://127.0.0.1:5001'; // Ajusta si el puerto es distinto
    
    // 2. Lanzar 10 ataques al mismo boleto
    const startTime = Date.now();
    const attempts = Array.from({ length: 10 }).map(async (_, index) => {
        try {
            const response = await fetch(`${serverUrl}/api/ordenes`, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'x-rifa-id': String(rifa.id) 
                },
                body: JSON.stringify({
                    cliente: {
                        nombre: `Racer${index}`,
                        apellidos: 'Test',
                        whatsapp: `55999999${index.toString().padStart(2, '0')}`,
                        estado: 'MX',
                        ciudad: 'MX'
                    },
                    boletos: [targetTicket],
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

    const results = await Promise.all(attempts);
    const endTime = Date.now();

    const winners = results.filter(r => r.ok).length;
    const losers = results.filter(r => !r.ok).length;

    console.log('\n--- Resultado de la Carrera ---');
    console.log(`Ganadores: ${winners} (Debe ser exactamente 1)`);
    console.log(`Perdedores: ${losers} (Debe ser exactamente 9)`);
    console.log(`Tiempo total: ${endTime - startTime}ms`);

    if (winners > 1) {
        console.error('❌ ¡FALLO CRÍTICO! Se vendió el mismo boleto a más de una persona.');
    } else if (winners === 1) {
        console.log('✅ ¡ÉXITO! El sistema bloqueó correctamente las compras duplicadas.');
    } else {
        console.log('⚠️ Nadie pudo comprar el boleto (posible error de red o timeout).');
    }

    await db.destroy();
}

runConcurrencyRace();
