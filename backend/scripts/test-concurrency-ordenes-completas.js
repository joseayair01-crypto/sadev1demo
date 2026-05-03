const testConcurrencyOrdenes = async () => {
    const baseUrl = 'https://sadev1demo-production.up.railway.app';
    const rifaId = 1;
    const CONCURRENCY = 5;
    const DURATION_MS = 180 * 1000; // 3 minutos
    const START_TIME = Date.now();
    
    let totalRequests = 0;
    let successCount = 0;
    let errorCount = 0;
    let latencies = [];
    const allOrderIds = [];
    const errorTypes = {};
    
    console.log('\n' + '='.repeat(80));
    console.log('TEST DE CONCURRENCIA - ÓRDENES COMPLETAS');
    console.log('='.repeat(80));
    console.log(`Iniciando a las ${new Date().toLocaleTimeString()}`);
    console.log(`Concurrencia: ${CONCURRENCY} solicitudes simultáneas`);
    console.log(`Duración: 3 minutos`);
    console.log(`Rifa ID: ${rifaId}`);
    console.log(`Endpoint: POST ${baseUrl}/api/ordenes`);
    console.log('='.repeat(80) + '\n');
    
    // Generar payload de orden realista
    const generarPayloadOrden = (index) => {
        const numeroTelefono = `412${String(1000000 + index).slice(-7)}`;  // 10 dígitos
        const email = `test-concurrency-${index}@example.com`;
        const cedula = String(10000000 + index);
        
        return {
            cliente: {
                nombre: `Cliente Concurrencia ${index}`,
                email: email,
                telefono: numeroTelefono,
                cedula: cedula
            },
            boletos_a_reservar: 1,
            monto_total: 100,
            metodo_pago: 'transferencia'
        };
    };
    
    const makeRequest = async (index) => {
        const reqStart = Date.now();
        try {
            const res = await fetch(`${baseUrl}/api/ordenes`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-rifa-id': String(rifaId)
                },
                body: JSON.stringify(generarPayloadOrden(index)),
                timeout: 10000
            });
            const data = await res.json();
            const latency = Date.now() - reqStart;
            latencies.push(latency);
            
            if (res.status === 200 || res.status === 201) {
                if (data.success && data.orden_id) {
                    successCount++;
                    allOrderIds.push(data.orden_id);
                } else if (data.orden_id) {
                    successCount++;
                    allOrderIds.push(data.orden_id);
                } else {
                    errorCount++;
                    const errKey = `Sin orden_id (status: ${res.status})`;
                    errorTypes[errKey] = (errorTypes[errKey] || 0) + 1;
                }
            } else {
                errorCount++;
                const errKey = `HTTP ${res.status}: ${data.message || 'Error desconocido'}`;
                errorTypes[errKey] = (errorTypes[errKey] || 0) + 1;
            }
        } catch (e) {
            errorCount++;
            const latency = Date.now() - reqStart;
            latencies.push(latency);
            const errKey = e.message || 'Error de conexión';
            errorTypes[errKey] = (errorTypes[errKey] || 0) + 1;
        }
        totalRequests++;
    };
    
    // Mantener concurrencia durante 3 minutos
    const queue = [];
    let requestIndex = 0;
    
    while (Date.now() - START_TIME < DURATION_MS) {
        // Llenar queue con solicitudes hasta alcanzar concurrencia
        while (queue.length < CONCURRENCY && Date.now() - START_TIME < DURATION_MS) {
            const promise = makeRequest(requestIndex++).catch(() => {});
            queue.push(promise);
        }
        
        // Esperar a que al menos una se complete
        if (queue.length > 0) {
            await Promise.race(queue);
            queue.splice(0, 1);
        }
        
        // Mostrar progreso cada 30 segundos
        const elapsed = Date.now() - START_TIME;
        if (Math.floor(elapsed / 30000) > Math.floor((elapsed - 100) / 30000) && totalRequests > 0) {
            const rate = (totalRequests / (elapsed / 1000)).toFixed(2);
            const successRate = ((successCount / totalRequests) * 100).toFixed(1);
            console.log(`⏱️  ${(elapsed / 1000).toFixed(0)}s - Total: ${totalRequests} | Tasa: ${rate} req/s | Éxito: ${successCount} (${successRate}%) | Error: ${errorCount}`);
        }
    }
    
    // Esperar a que terminen las promesas pendientes
    await Promise.all(queue);
    
    const END_TIME = Date.now();
    const TOTAL_TIME_S = ((END_TIME - START_TIME) / 1000).toFixed(2);
    
    // Calcular estadísticas
    if (latencies.length > 0) {
        const avgLatency = (latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(2);
        const minLatency = Math.min(...latencies);
        const maxLatency = Math.max(...latencies);
        const sortedLatencies = latencies.sort((a, b) => a - b);
        const medianLatency = sortedLatencies[Math.floor(sortedLatencies.length / 2)];
        const p95Latency = sortedLatencies[Math.floor(sortedLatencies.length * 0.95)];
        const p99Latency = sortedLatencies[Math.floor(sortedLatencies.length * 0.99)];
        
        const successRate = ((successCount / totalRequests) * 100).toFixed(2);
        const requestsPerSec = (totalRequests / TOTAL_TIME_S).toFixed(2);
        
        // Detectar duplicados
        const uniqOrderIds = new Set(allOrderIds);
        const duplicateCount = allOrderIds.length - uniqOrderIds.size;
        
        console.log('\n' + '='.repeat(80));
        console.log('RESULTADOS DEL TEST DE CONCURRENCIA');
        console.log('='.repeat(80));
        
        console.log('\n📊 ESTADÍSTICAS GENERALES:');
        console.log(`  Duración total: ${TOTAL_TIME_S}s`);
        console.log(`  Total solicitudes: ${totalRequests}`);
        console.log(`  Solicitudes por segundo: ${requestsPerSec}`);
        console.log(`  Tasa de éxito: ${successRate}%`);
        console.log(`  Órdenes creadas: ${successCount}`);
        console.log(`  Errores: ${errorCount}`);
        
        console.log('\n⚡ LATENCIA (ms):');
        console.log(`  Promedio: ${avgLatency}ms`);
        console.log(`  Mínima: ${minLatency}ms`);
        console.log(`  Máxima: ${maxLatency}ms`);
        console.log(`  Mediana: ${medianLatency}ms`);
        console.log(`  P95: ${p95Latency}ms`);
        console.log(`  P99: ${p99Latency}ms`);
        
        console.log('\n🔍 TIPOS DE ERRORES:');
        if (Object.keys(errorTypes).length === 0) {
            console.log('  ✅ Sin errores');
        } else {
            Object.entries(errorTypes).forEach(([err, count]) => {
                console.log(`  - ${err}: ${count}`);
            });
        }
        
        console.log('\n🆔 ÓRDENES GENERADAS:');
        console.log(`  Total IDs únicos: ${uniqOrderIds.size}`);
        console.log(`  Duplicados: ${duplicateCount}`);
        if (allOrderIds.length > 0) {
            console.log(`  Primeros IDs: ${Array.from(uniqOrderIds).slice(0, 5).join(', ')}`);
        }
        
        console.log('\n' + '='.repeat(80));
        if (errorCount === 0 && duplicateCount === 0 && successRate >= 99) {
            console.log('✅ EXCELENTE - Sistema aguanta concurrencia sin problemas');
        } else if (successRate >= 95 && duplicateCount === 0) {
            console.log('⚠️  ACEPTABLE - Alta tasa de éxito, revisar errores');
        } else if (successRate >= 85) {
            console.log('⚠️  PROBLEMAS - Tasa de éxito baja, revisar backend');
        } else {
            console.log('❌ CRÍTICO - Sistema con serios problemas de concurrencia');
        }
        console.log('='.repeat(80) + '\n');
        
        console.log(`📝 Las ${successCount} órdenes deberían estar visibles en:`);
        console.log(`  1. Panel admin: https://sadev1demo-production.up.railway.app/admin-ordenes.html`);
        console.log(`  2. Base de datos Supabase: tabla "ordenes" con rifa_id = ${rifaId}`);
        console.log(`  3. Búsqueda avanzada: filtrar por rifa ${rifaId}\n`);
    }
};

testConcurrencyOrdenes();
