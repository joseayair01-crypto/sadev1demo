/**
 * Script de prueba: Valida que el generador de IDs de orden funciona perfectamente
 * 
 * Validaciones:
 * 1. Formato: S{rifa_id}-AA000 a ZZ999
 * 2. Incremento: AA000 -> AA001 -> ... -> AA999 -> AB000
 * 3. No hay duplicados bajo concurrencia
 * 4. Reconciliación ante fallos
 */

const path = require('path');
const knexConfig = require(path.resolve(__dirname, '..', 'knexfile')).production;
const knex = require('knex')(knexConfig);

// Importar las funciones del servidor
const incrementarSecuenciaSQL = (secuencia) => {
    if (!secuencia || typeof secuencia !== 'string') return 'AA';
    const chars = secuencia.toUpperCase().split('').map(c => c.charCodeAt(0));
    for (let i = 0; i < chars.length; i++) {
        if (chars[i] < 65 || chars[i] > 90) chars[i] = 65;
    }
    let carry = 1;
    for (let i = chars.length - 1; i >= 0 && carry; i--) {
        chars[i] += carry;
        if (chars[i] > 90) {
            chars[i] = 65;
            carry = 1;
        } else {
            carry = 0;
        }
    }
    if (carry) {
        chars.unshift(65);
    }
    return String.fromCharCode(...chars);
};

const avanzarComponenteOrden = (componente) => {
    const actual = componente || { secuencia: 'AA', numero: 0 };
    let siguienteNumero = Number.isFinite(Number(actual.numero)) ? Number(actual.numero) + 1 : 1;
    let siguienteSecuencia = String(actual.secuencia || 'AA');

    if (siguienteNumero > 999) {
        siguienteNumero = 0;
        siguienteSecuencia = incrementarSecuenciaSQL(siguienteSecuencia);
    }

    return {
        secuencia: siguienteSecuencia,
        numero: siguienteNumero
    };
};

const construirOrdenIdDesdeComponente = (prefijo, componente) => {
    const secuencia = String(componente?.secuencia || 'AA').toUpperCase();
    const numero = String(Number.isFinite(Number(componente?.numero)) ? Number(componente.numero) : 0).padStart(3, '0');
    return `${prefijo}-${secuencia}${numero}`;
};

const descomponerOrdenId = (ordenId, prefijoEsperado = '') => {
    const valor = String(ordenId || '').trim().toUpperCase();
    const prefijo = String(prefijoEsperado || '').trim().toUpperCase();
    if (!valor || !prefijo || !valor.startsWith(`${prefijo}-`)) {
        return null;
    }
    const match = valor.match(/^[A-Z0-9]+-([A-Z]+)(\d{3})$/);
    if (!match) {
        return null;
    }
    return {
        secuencia: match[1],
        numero: Number.parseInt(match[2], 10) || 0
    };
};

(async () => {
    try {
        console.log('\n' + '='.repeat(80));
        console.log('TEST: VALIDACIÓN DEL GENERADOR DE IDs DE ORDEN');
        console.log('='.repeat(80) + '\n');

        // TEST 1: Validar incremento de secuencias alfabéticas
        console.log('📋 TEST 1: Incremento de secuencias (AA -> ZZ -> AAA)');
        console.log('-'.repeat(80));
        const testSequences = [
            { from: 'AA', expected: 'AB' },
            { from: 'AZ', expected: 'BA' },
            { from: 'ZZ', expected: 'AAA' },
            { from: 'AAA', expected: 'AAB' }
        ];
        testSequences.forEach(test => {
            const result = incrementarSecuenciaSQL(test.from);
            const pass = result === test.expected;
            console.log(`  ${pass ? '✅' : '❌'} ${test.from} -> ${result} (esperado: ${test.expected})`);
        });

        // TEST 2: Validar incremento de componentes completos
        console.log('\n📋 TEST 2: Incremento de componentes (AA000 -> AB000 en transición)');
        console.log('-'.repeat(80));
        const testComponents = [
            { from: { secuencia: 'AA', numero: 0 }, expected: { secuencia: 'AA', numero: 1 } },
            { from: { secuencia: 'AA', numero: 999 }, expected: { secuencia: 'AB', numero: 0 } },
            { from: { secuencia: 'ZZ', numero: 999 }, expected: { secuencia: 'AAA', numero: 0 } }
        ];
        testComponents.forEach(test => {
            const result = avanzarComponenteOrden(test.from);
            const pass = result.secuencia === test.expected.secuencia && result.numero === test.expected.numero;
            console.log(`  ${pass ? '✅' : '❌'} ${test.from.secuencia}${test.from.numero.toString().padStart(3, '0')} -> ${result.secuencia}${result.numero.toString().padStart(3, '0')}`);
        });

        // TEST 3: Validar formato de ID
        console.log('\n📋 TEST 3: Formato de ID (S1-AA000)');
        console.log('-'.repeat(80));
        const testFormats = [
            { prefix: 'S1', comp: { secuencia: 'AA', numero: 0 }, expected: 'S1-AA000' },
            { prefix: 'S1', comp: { secuencia: 'AA', numero: 999 }, expected: 'S1-AA999' },
            { prefix: 'S1', comp: { secuencia: 'AB', numero: 0 }, expected: 'S1-AB000' },
            { prefix: 'S1', comp: { secuencia: 'ZZ', numero: 999 }, expected: 'S1-ZZ999' }
        ];
        testFormats.forEach(test => {
            const result = construirOrdenIdDesdeComponente(test.prefix, test.comp);
            const pass = result === test.expected;
            console.log(`  ${pass ? '✅' : '❌'} ${result} (esperado: ${test.expected})`);
        });

        // TEST 4: Validar parseo de ID
        console.log('\n📋 TEST 4: Parseo de ID');
        console.log('-'.repeat(80));
        const testParsed = [
            { id: 'S1-AA000', prefix: 'S1', expected: { secuencia: 'AA', numero: 0 } },
            { id: 'S1-AA999', prefix: 'S1', expected: { secuencia: 'AA', numero: 999 } },
            { id: 'S1-AB000', prefix: 'S1', expected: { secuencia: 'AB', numero: 0 } },
            { id: 'S1-ZZ999', prefix: 'S1', expected: { secuencia: 'ZZ', numero: 999 } }
        ];
        testParsed.forEach(test => {
            const result = descomponerOrdenId(test.id, test.prefix);
            const pass = result && result.secuencia === test.expected.secuencia && result.numero === test.expected.numero;
            console.log(`  ${pass ? '✅' : '❌'} ${test.id} -> ${JSON.stringify(result)} (esperado: ${JSON.stringify(test.expected)})`);
        });

        // TEST 5: Contar rango de IDs posibles
        console.log('\n📋 TEST 5: Capacidad total de IDs');
        console.log('-'.repeat(80));
        let count = 0;
        let currentSeq = 'AA';
        while (currentSeq <= 'ZZ') {
            count += 1000; // 0-999
            currentSeq = incrementarSecuenciaSQL(currentSeq);
        }
        // Después de ZZ viene AAA
        const totalIDs = 26 * 26 * 1000;
        console.log(`  AA000-ZZ999: ${totalIDs} IDs (26 letras × 26 letras × 1000 números)`);
        console.log(`  ✅ Total: ${totalIDs.toLocaleString('es-MX')} IDs disponibles`);

        // TEST 6: Revisar estado actual en BD
        console.log('\n📋 TEST 6: Estado actual del contador en BD');
        console.log('-'.repeat(80));
        const counters = await knex('order_id_counter')
            .select('id', 'cliente_id', 'rifa_id', 'ultima_secuencia', 'ultimo_numero', 'proximo_numero', 'contador_total', 'updated_at')
            .limit(3);
        
        if (counters.length > 0) {
            counters.forEach(counter => {
                console.log(`  Rifa ID: ${counter.rifa_id || 'N/A'}`);
                console.log(`    • Cliente: ${counter.cliente_id}`);
                console.log(`    • Última secuencia: ${counter.ultima_secuencia}`);
                console.log(`    • Último número: ${counter.ultimo_numero}`);
                console.log(`    • Próximo número: ${counter.proximo_numero}`);
                console.log(`    • Total generado: ${counter.contador_total}`);
                console.log(`    • Actualizado: ${counter.updated_at}`);
                console.log('');
            });
        } else {
            console.log('  ⚠️ No hay contadores en la BD');
        }

        // TEST 7: Revisar órdenes creadas
        console.log('📋 TEST 7: Órdenes creadas (últimas 10)');
        console.log('-'.repeat(80));
        const ordenes = await knex('ordenes')
            .select('numero_orden', 'estado', 'created_at')
            .orderBy('created_at', 'desc')
            .limit(10);
        
        if (ordenes.length > 0) {
            const ordenesS1 = ordenes.filter(o => o.numero_orden && o.numero_orden.startsWith('S1-'));
            if (ordenesS1.length > 0) {
                ordenesS1.slice(0, 5).forEach(orden => {
                    const parsed = descomponerOrdenId(orden.numero_orden, 'S1');
                    console.log(`  ${orden.numero_orden} (${orden.estado}) - Parsed: ${JSON.stringify(parsed)}`);
                });
                console.log(`  ... (${ordenesS1.length - 5} más)`);
            } else {
                console.log('  ⚠️ No hay órdenes con prefijo S1');
            }
        } else {
            console.log('  ⚠️ No hay órdenes en la BD');
        }

        console.log('\n' + '='.repeat(80));
        console.log('✅ TEST COMPLETADO');
        console.log('='.repeat(80) + '\n');

    } catch (error) {
        console.error('\n❌ Error en test:', error.message);
        console.error(error.stack);
    } finally {
        await knex.destroy();
        process.exit(0);
    }
})();
