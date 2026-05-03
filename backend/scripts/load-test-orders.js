#!/usr/bin/env node

/**
 * PRUEBA DE CONCURRENCIA - ÓRDENES REALES
 * 
 * Uso:
 *   node load-test-orders.js
 * 
 * Parámetros por defecto:
 *   - Concurrencia: 5
 *   - Duración: 3 minutos
 *   - 1 boleto por orden
 *   - Rifa ID: 1
 */

const http = require('http');
const https = require('https');

const BASE_URL = process.env.BASE_URL || 'https://sadev1demo-production.up.railway.app';
const RIFA_ID = '1';
const CONCURRENCY = 5;
const DURATION_MS = 180 * 1000; // 3 minutos
const REQUEST_TIMEOUT = 10000;

let totalRequests = 0;
let successCount = 0;
let errorCount = 0;
let latencies = [];
const errorTypes = {};
let requestIndex = 0;
const START_TIME = Date.now();

console.log('\n' + '='.repeat(80));
console.log('PRUEBA DE CARGA - CREACIÓN DE ÓRDENES');
console.log('='.repeat(80));
console.log(`BASE_URL: ${BASE_URL}`);
console.log(`Rifa ID: ${RIFA_ID}`);
console.log(`Concurrencia: ${CONCURRENCY} solicitudes simultáneas`);
console.log(`Duración: 3 minutos`);
console.log(`Inicio: ${new Date().toLocaleTimeString()}`);
console.log('='.repeat(80) + '\n');

const generarPayloadOrden = (index) => {
    // Generar número único pero siempre con exactamente 7 dígitos después de 412
    const numeroSeguro = String(1000000 + (index % 8000000)).slice(-7); // Garantiza 7 dígitos
    return {
        cliente: {
            nombre: `Test ${index}`,
            apellidos: `Load`,
            whatsapp: `412${numeroSeguro}`, // 10 dígitos exactos
            estado: 'Aragua',
            ciudad: 'Maracay'
        },
        boletos: [index % 100000], // Boleto válido (0-99999)
        totales: {
            subtotal: 100,
            descuento: 0,
            totalFinal: 100
        }
    };
};

const hacerRequest = () => {
    return new Promise((resolve) => {
        const payload = JSON.stringify(generarPayloadOrden(requestIndex++));
        const startTime = Date.now();

        const options = {
            hostname: new URL(BASE_URL).hostname,
            port: 443,
            path: '/api/ordenes',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                'x-rifa-id': RIFA_ID
            },
            timeout: REQUEST_TIMEOUT
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                const latency = Date.now() - startTime;
                latencies.push(latency);
                totalRequests++;

                try {
                    const json = JSON.parse(data);
                    if (res.statusCode === 200 && json.orden_id) {
                        successCount++;
                    } else {
                        errorCount++;
                        const key = `HTTP ${res.statusCode}: ${json.message || 'error'}`;
                        errorTypes[key] = (errorTypes[key] || 0) + 1;
                    }
                } catch (e) {
                    errorCount++;
                    errorTypes['Parse error'] = (errorTypes['Parse error'] || 0) + 1;
                }
                resolve();
            });
        });

        req.on('error', (e) => {
            const latency = Date.now() - startTime;
            latencies.push(latency);
            totalRequests++;
            errorCount++;
            const key = e.code || e.message || 'Connection error';
            errorTypes[key] = (errorTypes[key] || 0) + 1;
            resolve();
        });

        req.on('timeout', () => {
            req.destroy();
            const latency = Date.now() - startTime;
            latencies.push(latency);
            totalRequests++;
            errorCount++;
            errorTypes['Timeout'] = (errorTypes['Timeout'] || 0) + 1;
            resolve();
        });

        req.write(payload);
        req.end();
    });
};

const ejecutarTest = async () => {
    const queue = [];
    
    while (Date.now() - START_TIME < DURATION_MS) {
        // Mantener concurrencia
        while (queue.length < CONCURRENCY && Date.now() - START_TIME < DURATION_MS) {
            queue.push(hacerRequest());
        }

        if (queue.length > 0) {
            await Promise.race(queue);
            queue.splice(0, 1);
        }

        // Reporte cada 30 segundos
        const elapsed = Date.now() - START_TIME;
        if (totalRequests > 0 && Math.floor(elapsed / 30000) > Math.floor((elapsed - 100) / 30000)) {
            const rate = (totalRequests / (elapsed / 1000)).toFixed(2);
            const success = ((successCount / totalRequests) * 100).toFixed(1);
            console.log(`⏱️  ${(elapsed / 1000).toFixed(0)}s - Total: ${totalRequests} | Tasa: ${rate} req/s | Éxito: ${successCount} (${success}%) | Error: ${errorCount}`);
        }
    }

    // Esperar promesas pendientes
    await Promise.all(queue);

    // REPORTE FINAL
    const totalTime = (Date.now() - START_TIME) / 1000;
    const avgLatency = latencies.length ? (latencies.reduce((a,b)=>a+b,0) / latencies.length).toFixed(0) : 'N/A';
    const sortedLat = latencies.sort((a,b)=>a-b);
    const p95 = sortedLat[Math.floor(sortedLat.length * 0.95)] || 'N/A';
    const p99 = sortedLat[Math.floor(sortedLat.length * 0.99)] || 'N/A';
    const minLat = Math.min(...latencies) || 'N/A';
    const maxLat = Math.max(...latencies) || 'N/A';
    const successRate = ((successCount / totalRequests) * 100).toFixed(2);
    const rps = (totalRequests / totalTime).toFixed(2);

    console.log('\n' + '='.repeat(80));
    console.log('RESULTADOS FINALES');
    console.log('='.repeat(80));
    console.log(`Duración: ${totalTime.toFixed(2)}s`);
    console.log(`Total solicitudes: ${totalRequests}`);
    console.log(`Solicitudes/seg: ${rps}`);
    console.log(`Órdenes creadas: ${successCount}`);
    console.log(`Tasa éxito: ${successRate}%`);
    console.log(`Errores: ${errorCount}`);
    console.log(`\nLatencia (ms):`);
    console.log(`  Promedio: ${avgLatency}`);
    console.log(`  Mínima: ${minLat}`);
    console.log(`  Máxima: ${maxLat}`);
    console.log(`  P95: ${p95}`);
    console.log(`  P99: ${p99}`);

    if (Object.keys(errorTypes).length > 0) {
        console.log(`\nErrores por tipo:`);
        Object.entries(errorTypes).forEach(([type, count]) => {
            console.log(`  - ${type}: ${count}`);
        });
    }

    console.log('\n✅ Las órdenes deberían estar en: https://sadev1demo-production.up.railway.app/admin-ordenes.html');
    console.log('='.repeat(80) + '\n');

    process.exit(successCount > 0 ? 0 : 1);
};

ejecutarTest().catch(e => {
    console.error('Error:', e);
    process.exit(1);
});
