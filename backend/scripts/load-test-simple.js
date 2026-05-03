#!/usr/bin/env node

const https = require('https');
const START_TIME = Date.now();
const DURATION_MS = 180 * 1000; // 3 minutos
const CONCURRENCY = 5;
const BASE_URL = 'https://sadev1demo-production.up.railway.app';
const RIFA_ID = '1';

let totalRequests = 0;
let successCount = 0;
let errorCount = 0;
let latencies = [];
const errorTypes = {};

console.log('\n' + '='.repeat(80));
console.log('PRUEBA DE CARGA - 5 SOLICITUDES SIMULTÁNEAS');
console.log('='.repeat(80) + '\n');

const generarPayload = (idx) => {
    const num = String(1000000 + (idx % 8000000)).slice(-7);
    return JSON.stringify({
        cliente: {
            nombre: `Test ${idx}`,
            apellidos: `Load`,
            whatsapp: `412${num}`,
            estado: 'Aragua',
            ciudad: 'Maracay'
        },
        boletos: [idx % 100000],
        totales: {
            subtotal: 100,
            descuento: 0,
            totalFinal: 100
        }
    });
};

const hacerRequest = () => {
    return new Promise((resolve) => {
        const payload = generarPayload(totalRequests);
        const t0 = Date.now();

        const req = https.request({
            hostname: 'sadev1demo-production.up.railway.app',
            path: '/api/ordenes',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                'x-rifa-id': RIFA_ID
            },
            timeout: 10000
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                const latency = Date.now() - t0;
                latencies.push(latency);
                totalRequests++;

                if (res.statusCode === 200) {
                    successCount++;
                } else {
                    errorCount++;
                    try {
                        const j = JSON.parse(data);
                        const key = `HTTP ${res.statusCode}: ${j.message || '?'}`;
                        errorTypes[key] = (errorTypes[key] || 0) + 1;
                    } catch (e) {
                        errorTypes[`HTTP ${res.statusCode}`] = (errorTypes[`HTTP ${res.statusCode}`] || 0) + 1;
                    }
                }
                resolve();
            });
        });

        req.on('error', (e) => {
            const latency = Date.now() - t0;
            latencies.push(latency);
            totalRequests++;
            errorCount++;
            errorTypes[e.code || e.message] = (errorTypes[e.code || e.message] || 0) + 1;
            resolve();
        });

        req.on('timeout', () => {
            req.destroy();
            const latency = Date.now() - t0;
            latencies.push(latency);
            totalRequests++;
            errorCount++;
            errorTypes['TIMEOUT'] = (errorTypes['TIMEOUT'] || 0) + 1;
            resolve();
        });

        req.write(payload);
        req.end();
    });
};

const esperar = (ms) => new Promise(r => setTimeout(r, ms));

const main = async () => {
    const queue = [];
    let lastReport = Date.now();

    while (Date.now() - START_TIME < DURATION_MS) {
        // Mantener 5 concurrentes
        while (queue.length < CONCURRENCY && Date.now() - START_TIME < DURATION_MS) {
            queue.push(hacerRequest());
        }

        if (queue.length > 0) {
            await Promise.race(queue);
            queue.shift();
        }

        // Reporte cada 30s
        const now = Date.now();
        if (now - lastReport >= 30000) {
            lastReport = now;
            const elapsed = (now - START_TIME) / 1000;
            const rate = (totalRequests / elapsed).toFixed(2);
            const pct = ((successCount / totalRequests) * 100).toFixed(1);
            console.log(`⏱️  ${elapsed.toFixed(0)}s | Total: ${totalRequests} | Tasa: ${rate}/s | Éxito: ${successCount} (${pct}%) | Error: ${errorCount}`);
        }
    }

    await Promise.all(queue);

    // REPORTE FINAL
    const total_time = (Date.now() - START_TIME) / 1000;
    const avg_latency = latencies.length ? (latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(0) : 'N/A';
    const sorted = [...latencies].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] || 'N/A';
    const p99 = sorted[Math.floor(sorted.length * 0.99)] || 'N/A';
    const pct_success = ((successCount / totalRequests) * 100).toFixed(2);

    console.log('\n' + '='.repeat(80));
    console.log('RESULTADOS FINALES');
    console.log('='.repeat(80));
    console.log(`Total de solicitudes: ${totalRequests}`);
    console.log(`Exitosas: ${successCount} (${pct_success}%)`);
    console.log(`Fallidas: ${errorCount}`);
    console.log(`Duración: ${total_time.toFixed(2)}s`);
    console.log(`Tasa: ${(totalRequests / total_time).toFixed(2)} req/s`);
    console.log(`\nLatencia (ms):`);
    console.log(`  Promedio: ${avg_latency}`);
    console.log(`  P95: ${p95}`);
    console.log(`  P99: ${p99}`);
    console.log(`\nErrores:`);
    if (Object.keys(errorTypes).length === 0) {
        console.log('  Ninguno');
    } else {
        for (const [err, count] of Object.entries(errorTypes).sort((a, b) => b[1] - a[1])) {
            console.log(`  - ${err}: ${count}`);
        }
    }
    console.log('='.repeat(80) + '\n');
};

main().catch(e => console.error('ERROR:', e.message));
