#!/usr/bin/env node
/**
 * VERIFICADOR: Busca llamadas a funciones de BoletoService sin contexto de rifa
 * Esto detecta problemas de multirifa como el que encontramos en máquina-suerte
 */

const fs = require('fs');
const path = require('path');

const serverFile = path.join(__dirname, 'server.js');
const boletoServiceFile = path.join(__dirname, 'services/boletoService.js');

const funcionsToCheck = [
    { name: 'obtenerBoletosAleatoriosDisponibles', needsContext: true },
    { name: 'obtenerBoletosDisponibles', needsContext: true },
    { name: 'contarBoletosDisponibles', needsContext: true },
    { name: 'obtenerResumenInventario', needsContext: true },
    { name: 'verificarDisponibilidad', needsContext: true },
    { name: 'previsualizarRangoBoletos', needsContext: true },
    { name: 'poblarRangoBoletos', needsContext: true },
    { name: 'borrarRangoBoletos', needsContext: true },
    { name: 'obtenerEstadoNoDisponibleEnRango', needsContext: true },
    { name: '_obtenerTotalBoletosConfig', needsContext: true }
];

console.log('\n🔍 VERIFICADOR: Multirifa Context Checking\n');
console.log('='.repeat(70));

const fileContent = fs.readFileSync(serverFile, 'utf8');
const lines = fileContent.split('\n');

let erroresEncontrados = [];

funcionsToCheck.forEach(func => {
    console.log(`\n📋 Buscando: ${func.name}()`);
    
    lines.forEach((line, idx) => {
        // Skip comments
        if (line.trim().startsWith('//')) return;
        
        // Look for calls to this function
        const regex = new RegExp(`BoletoService\\.${func.name}\\s*\\(([^)]{0,200})\\)`, 'g');
        const matches = line.matchAll(regex);
        
        for (const match of matches) {
            const params = match[1];
            const lineNum = idx + 1;
            
            // Check if it has a context parameter (object with rifaId or similar)
            const hasContext = /{\s*(rifaId|contexto)/.test(params);
            
            if (func.needsContext && !hasContext) {
                erroresEncontrados.push({
                    linea: lineNum,
                    funcion: func.name,
                    params: params.substring(0, 60),
                    error: 'Falta contexto de rifa'
                });
                
                console.log(`   ❌ Línea ${lineNum}: ${params.substring(0, 80)}`);
            } else if (hasContext) {
                console.log(`   ✅ Línea ${lineNum}: Tiene contexto`);
            }
        }
    });
});

console.log('\n' + '='.repeat(70));

if (erroresEncontrados.length === 0) {
    console.log('\n✅ NO SE ENCONTRARON ERRORES DE CONTEXTO MULTIRIFA\n');
} else {
    console.log(`\n⚠️  SE ENCONTRARON ${erroresEncontrados.length} PROBLEMAS:\n`);
    erroresEncontrados.forEach((err, idx) => {
        console.log(`${idx + 1}. Línea ${err.linea}: ${err.funcion}()`);
        console.log(`   Parámetros: ${err.params}...`);
        console.log(`   Problema: ${err.error}\n`);
    });
}

console.log('='.repeat(70) + '\n');
