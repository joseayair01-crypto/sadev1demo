#!/usr/bin/env node
/**
 * PRUEBA DE CARGA AGRESIVA - 5+ Solicitudes Simultáneas
 * 
 * Simula tráfico en pico con retry logic mejorado
 * - Fuerza deshabilitación de rate limiting (LOAD_TEST=true)
 * - Implementa retry automático en conflictos
 * - Reporta métricas detalladas cada 30s
 */

const https = require('https');
const http = require('http');

// ✅ FUERZA NODE_ENV=production pero LOAD_TEST=true
process.env.NODE_ENV = 'production';
process.env.LOAD_TEST = 'true';

const BASE_URL = 'https://sadev1demo-production.up.railway.app';
const RIFA_ID = 1;
const DURATION_MS = 180000;  // 3 minutos
const CONCURRENT_REQUESTS = 5;
const MAX_RETRIES = 3;

// Métricas
const metrics = {
    totalRequests: 0,
    successCount: 0,
    failureCount: 0,
    retryCount: 0,
    httpErrors: {},
    codeErrors: {},
    latencies: []
};

let testActive = true;
const queue = [];
let activeCount = 0;

/**
 * Generar payload válido para /api/ordenes
 */
function generarPayload(idx) {
    const phoneNum = 412 + String(1000000 + (idx % 8000000)).slice(-7);
    return {
        cliente: {
            nombre: `Test${idx}`,
            apellidos: 'LoadTest',
            whatsapp: phoneNum,  // Exactamente 10 dígitos
            estado: 'Aragua',
            ciudad: 'Maracay'
        },
        boletos: [idx % 100000],  // Array con número 0-99999
        totales: {
            subtotal: 100,
            descuento: 0,
            totalFinal: 100
        }
    };
}

/**
 * Hacer request con reintentos automáticos
 */
function makeRequestWithRetry(payload, retryCount = 0) {
    return new Promise((resolve) => {
        const attempt = () => {
            const startTime = Date.now();
            metrics.totalRequests++;

            const options = {
                hostname: 'sadev1demo-production.up.railway.app',
                port: 443,
                path: '/api/ordenes',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-rifa-id': String(RIFA_ID),
                    'User-Agent': 'LoadTest/1.0'
                },
                timeout: 15000
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    const latency = Date.now() - startTime;
                    metrics.latencies.push(latency);

                    // ✅ HTTP 200 o 201 = SUCCESS
                    if (res.statusCode === 200 || res.statusCode === 201) {
                        metrics.successCount++;
                        resolve({ success: true, status: res.statusCode, latency });
                    }
                    // ✅ HTTP 409 CONFLICTO = Reintentar
                    else if (res.statusCode === 409 && retryCount < MAX_RETRIES) {
                        metrics.retryCount++;
                        console.log(`  ↻ Reintentando por 409 (intento ${retryCount + 1}/${MAX_RETRIES})`);
                        // Backoff exponencial
                        const backoff = 100 * Math.pow(2, retryCount) + Math.floor(Math.random() * 200);
                        setTimeout(() => attempt(), backoff);
                    }
                    // ❌ HTTP 429 RATE LIMIT = Reintentar con backoff mayor
                    else if (res.statusCode === 429 && retryCount < MAX_RETRIES) {
                        metrics.retryCount++;
                        console.log(`  ↻ Rate limit (429), reintentando en ${500 + retryCount * 300}ms...`);
                        setTimeout(() => attempt(), 500 + retryCount * 300);
                    }
                    // ❌ Otros errores
                    else {
                        metrics.httpErrors[res.statusCode] = (metrics.httpErrors[res.statusCode] || 0) + 1;
                        if (res.statusCode >= 400) {
                            metrics.failureCount++;
                            try {
                                const json = JSON.parse(data);
                                if (json.code) {
                                    metrics.codeErrors[json.code] = (metrics.codeErrors[json.code] || 0) + 1;
                                }
                            } catch {}
                        }
                        resolve({ success: res.statusCode === 200 || res.statusCode === 201, status: res.statusCode, latency });
                    }
                });
            });

            req.on('error', (err) => {
                const latency = Date.now() - startTime;
                metrics.latencies.push(latency);
                metrics.failureCount++;
                metrics.codeErrors['NETWORK_ERROR'] = (metrics.codeErrors['NETWORK_ERROR'] || 0) + 1;
                resolve({ success: false, error: err.message, latency });
            });

            req.on('timeout', () => {
                metrics.failureCount++;
                metrics.codeErrors['TIMEOUT'] = (metrics.codeErrors['TIMEOUT'] || 0) + 1;
                req.destroy();
                resolve({ success: false, error: 'TIMEOUT', latency: 15000 });
            });

            req.write(JSON.stringify(payload));
            req.end();
        };

        attempt();
    });
}

/**
 * Worker que procesa requests de la queue
 */
async function worker() {
    while (testActive || queue.length > 0) {
        if (queue.length > 0) {
            const payload = queue.shift();
            activeCount++;
            await makeRequestWithRetry(payload);
            activeCount--;
        } else if (testActive) {
            await new Promise(r => setTimeout(r, 10));
        } else {
            break;
        }
    }
}

/**
 * Rellenar queue continuamente
 */
async function fillQueue() {
    let idx = 0;
    const fillInterval = setInterval(() => {
        if (!testActive) {
            clearInterval(fillInterval);
            return;
        }
        // Mantener exactamente CONCURRENT_REQUESTS requests en flight
        while (activeCount + queue.length < CONCURRENT_REQUESTS) {
            queue.push(generarPayload(idx++));
        }
    }, 10);
}

/**
 * Reporter cada 30s
 */
function reportMetrics(elapsed) {
    const successRate = metrics.totalRequests > 0 
        ? ((metrics.successCount / metrics.totalRequests) * 100).toFixed(1)
        : '0.0';
    const throughput = (metrics.totalRequests / (elapsed / 1000)).toFixed(2);

    console.log(`⏱️  ${(elapsed / 1000).toFixed(0).padStart(3)}s | ` +
        `Total: ${metrics.totalRequests} | ` +
        `Éxito: ${metrics.successCount} (${successRate}%) | ` +
        `Error: ${metrics.failureCount} | ` +
        `Reintentos: ${metrics.retryCount} | ` +
        `Tasa: ${throughput} req/s`);
}

/**
 * Main
 */
async function main() {
    console.log('================================================================================');
    console.log('🚀 PRUEBA DE CARGA AGRESIVA - 5 SOLICITUDES SIMULTÁNEAS (CON REINTENTOS)');
    console.log('================================================================================\n');
    console.log(`🎯 Servidor: ${BASE_URL}`);
    console.log(`🎲 Rifa ID: ${RIFA_ID}`);
    console.log(`⏱️  Duración: 3 minutos`);
    console.log(`🔄 Concurrentes: ${CONCURRENT_REQUESTS}`);
    console.log(`📍 Reintentos: ${MAX_RETRIES} por request\n`);

    // Iniciar workers
    const workers = Array(CONCURRENT_REQUESTS)
        .fill(0)
        .map(() => worker());

    // Iniciar rellenado de queue
    fillQueue();

    // Reporter cada 30s
    const reportInterval = setInterval(() => {
        reportMetrics(Date.now() - startTime);
    }, 30000);

    // Dejar correr por DURATION_MS
    const startTime = Date.now();
    await new Promise(r => setTimeout(r, DURATION_MS));
    testActive = false;

    // Esperar que se completen los workers
    await Promise.all(workers);
    clearInterval(reportInterval);

    // Reporte final
    const elapsed = Date.now() - startTime;
    console.log('\n================================================================================');
    console.log('📊 RESULTADOS FINALES');
    console.log('================================================================================');

    const successRate = ((metrics.successCount / metrics.totalRequests) * 100).toFixed(2);
    const avgLatency = metrics.latencies.length > 0
        ? (metrics.latencies.reduce((a, b) => a + b, 0) / metrics.latencies.length).toFixed(0)
        : 0;

    const sorted = [...metrics.latencies].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
    const p99 = sorted[Math.floor(sorted.length * 0.99)] || 0;

    console.log(`Total de solicitudes: ${metrics.totalRequests}`);
    console.log(`Exitosas: ${metrics.successCount} (${successRate}%)`);
    console.log(`Fallidas: ${metrics.failureCount}`);
    console.log(`Reintentos automáticos: ${metrics.retryCount}`);
    console.log(`Duración: ${(elapsed / 1000).toFixed(2)}s`);
    console.log(`Tasa: ${(metrics.totalRequests / (elapsed / 1000)).toFixed(2)} req/s`);

    console.log(`\n⏱️  Latencia (ms):`);
    console.log(`  Promedio: ${avgLatency}`);
    console.log(`  P95: ${p95}`);
    console.log(`  P99: ${p99}`);

    if (Object.keys(metrics.httpErrors).length > 0) {
        console.log(`\n🔴 Errores HTTP:`);
        Object.entries(metrics.httpErrors).forEach(([code, count]) => {
            console.log(`  - HTTP ${code}: ${count}`);
        });
    }

    if (Object.keys(metrics.codeErrors).length > 0) {
        console.log(`\n🔴 Errores por código:`);
        Object.entries(metrics.codeErrors).forEach(([code, count]) => {
            console.log(`  - ${code}: ${count}`);
        });
    }

    console.log('\n================================================================================\n');

    process.exit(successRate >= 95 ? 0 : 1);
}

main().catch(err => {
    console.error('❌ Error fatal:', err);
    process.exit(1);
});
