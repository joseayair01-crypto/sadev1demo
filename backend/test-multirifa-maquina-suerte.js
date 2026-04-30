/**
 * TEST: Validar que máquina de suerte genera boletos correctamente por rifa
 * Prueba que Rifa A (100 boletos) y Rifa B (1000 boletos) generen números en su rango
 */

const db = require('./db');
const BoletoService = require('./services/boletoService');
const ConfigManagerV2 = require('./config-manager-v2').getInstance();

async function testMaquinaSuerte() {
    console.log('\n🧪 TEST: Máquina de Suerte - Multi-Rifa\n');
    console.log('='.repeat(60));

    try {
        // Obtener rifas de prueba (asumiendo IDs 1 y 2 existen)
        const rifas = await db('rifas')
            .select('id', 'nombre', 'slug')
            .orderBy('id')
            .limit(2);

        if (rifas.length < 2) {
            console.log('⚠️  Se necesitan al menos 2 rifas para hacer el test');
            console.log('   Rifas encontradas:', rifas.length);
            process.exit(1);
        }

        const [rifaA, rifaB] = rifas;
        
        // Obtener configuración de cada rifa
        const configA = ConfigManagerV2.getConfig(rifaA.id);
        const configB = ConfigManagerV2.getConfig(rifaB.id);

        console.log(`\n📍 Rifa A: ${rifaA.nombre} (ID: ${rifaA.id})`);
        console.log(`   Total Boletos: ${configA?.rifa?.totalBoletos || 'NO CONFIGURADO'}`);
        console.log(`   Slug: ${rifaA.slug}`);

        console.log(`\n📍 Rifa B: ${rifaB.nombre} (ID: ${rifaB.id})`);
        console.log(`   Total Boletos: ${configB?.rifa?.totalBoletos || 'NO CONFIGURADO'}`);
        console.log(`   Slug: ${rifaB.slug}`);

        // TEST 1: Generar 50 boletos para Rifa A
        console.log(`\n\n🎲 TEST 1: Generar 50 boletos para Rifa A`);
        console.log('-'.repeat(60));

        const boletosRifaA = await BoletoService.obtenerBoletosAleatoriosDisponibles(50, [], {
            rifaId: rifaA.id
        });

        const totalBoletosA = configA?.rifa?.totalBoletos || 0;
        const maxNumeroA = totalBoletosA - 1;

        console.log(`✅ Generados: ${boletosRifaA.length} boletos`);
        console.log(`   Rango esperado: 0 - ${maxNumeroA}`);
        
        const invalidosA = boletosRifaA.filter(n => n < 0 || n > maxNumeroA);
        if (invalidosA.length > 0) {
            console.log(`❌ FALLO: ${invalidosA.length} boletos fuera de rango: ${invalidosA.slice(0, 5).join(', ')}...`);
        } else {
            console.log(`✅ ÉXITO: Todos los boletos están en rango [0-${maxNumeroA}]`);
        }

        console.log(`   Muestra: [${boletosRifaA.slice(0, 10).join(', ')}...]`);

        // TEST 2: Generar 100 boletos para Rifa B
        console.log(`\n\n🎲 TEST 2: Generar 100 boletos para Rifa B`);
        console.log('-'.repeat(60));

        const boletosRifaB = await BoletoService.obtenerBoletosAleatoriosDisponibles(100, [], {
            rifaId: rifaB.id
        });

        const totalBoletosB = configB?.rifa?.totalBoletos || 0;
        const maxNumeroB = totalBoletosB - 1;

        console.log(`✅ Generados: ${boletosRifaB.length} boletos`);
        console.log(`   Rango esperado: 0 - ${maxNumeroB}`);

        const invalidosB = boletosRifaB.filter(n => n < 0 || n > maxNumeroB);
        if (invalidosB.length > 0) {
            console.log(`❌ FALLO: ${invalidosB.length} boletos fuera de rango: ${invalidosB.slice(0, 5).join(', ')}...`);
        } else {
            console.log(`✅ ÉXITO: Todos los boletos están en rango [0-${maxNumeroB}]`);
        }

        console.log(`   Muestra: [${boletosRifaB.slice(0, 10).join(', ')}...]`);

        // TEST 3: Verificar que números de Rifa B NO estén en Rifa A
        console.log(`\n\n🎲 TEST 3: Verificar aislamiento entre rifas`);
        console.log('-'.repeat(60));

        const setA = new Set(boletosRifaA);
        const overlaps = boletosRifaB.filter(n => setA.has(n));

        if (overlaps.length > 0) {
            console.log(`⚠️  ADVERTENCIA: ${overlaps.length} números repetidos entre rifas`);
            console.log(`   Repetidos: [${overlaps.slice(0, 10).join(', ')}...]`);
        } else {
            console.log(`✅ ÉXITO: No hay overlaps entre rifas (ambas selecciones independientes)`);
        }

        // TEST 4: Generar 200 boletos para Rifa B (debe generar todos)
        console.log(`\n\n🎲 TEST 4: Generar 200 boletos para Rifa B (capacidad)`);
        console.log('-'.repeat(60));

        const boletosRifaB_200 = await BoletoService.obtenerBoletosAleatoriosDisponibles(200, [], {
            rifaId: rifaB.id
        });

        console.log(`✅ Solicitados: 200 | Generados: ${boletosRifaB_200.length}`);
        
        if (boletosRifaB_200.length === 200) {
            console.log(`✅ ÉXITO: Rifa B pudo generar 200 boletos (capacidad suficiente)`);
        } else if (boletosRifaB_200.length === 0) {
            console.log(`❌ FALLO: Rifa B no pudo generar ningún boleto`);
        } else {
            console.log(`⚠️  Rifa B generó ${boletosRifaB_200.length}/200 (capacidad limitada)`);
        }

        // RESUMEN
        console.log(`\n\n${'='.repeat(60)}`);
        console.log('📊 RESUMEN DEL TEST');
        console.log('='.repeat(60));

        const testsPasados = [
            invalidosA.length === 0,
            invalidosB.length === 0,
            overlaps.length === 0,
            boletosRifaB_200.length >= 100
        ].filter(Boolean).length;

        console.log(`✅ Tests pasados: ${testsPasados}/4`);

        if (testsPasados === 4) {
            console.log('\n🎉 TODOS LOS TESTS PASARON - Máquina de suerte está correctamente aislada por rifa');
        } else {
            console.log('\n⚠️  ALGUNOS TESTS FALLARON - Revisar consola arriba');
        }

        process.exit(testsPasados === 4 ? 0 : 1);

    } catch (error) {
        console.error('\n❌ ERROR EN TEST:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

// Ejecutar test
testMaquinaSuerte().catch(err => {
    console.error('❌ Test abortado:', err.message);
    process.exit(1);
});
