/**
 * Config Loader - Carga configuración base/legacy hacia Node.js
 * 
 * Se usa como fallback de arranque cuando la configuración dinámica aún no está disponible.
 * Prioridad:
 * 1. Variables de entorno (.env)
 * 2. Archivo config.json local
 * 3. Archivo config.js legacy
 * 3. Valores por defecto
 */

const fs = require('fs');
const path = require('path');

/**
 * Carga configuración legacy extrayendo la sección 'rifa' de config.js
 * Usa regex para evitar ejecutar todo el código
 */
function cargarConfigJavaScript() {
    try {
        const configPath = path.join(__dirname, '..', 'js', 'config.js');
        const codigo = fs.readFileSync(configPath, 'utf8');
        
        // Buscar la sección rifa: { ... }
        const rifaMatch = codigo.match(/rifa:\s*\{([\s\S]*?)\n\s*\},/);
        if (!rifaMatch) {
            throw new Error('No se encontró la sección "rifa" en config.js');
        }
        
        const rifaContent = rifaMatch[1];
        
        // Extraer valores específicos con regex
        const extraerValor = (nombre) => {
            // Buscar: nombreVariable: valor,
            const regex = new RegExp(`${nombre}:\\s*([^,\n]+)`, 'i');
            const match = rifaContent.match(regex);
            if (!match) return null;
            
            const valor = match[1].trim();
            
            // Si es un número (entero o decimal), parsearlo
            if (!isNaN(valor) && valor !== '') {
                return parseFloat(valor);  // ✅ Cambio: parseFloat en vez de parseInt para soportar decimales
            }
            
            // Si es string entre comillas
            if (valor.startsWith("'") || valor.startsWith('"')) {
                return valor.slice(1, -1);
            }
            
            return valor;
        };
        
        return {
            tiempoApartadoHoras: extraerValor('tiempoApartadoHoras'),
            intervaloLimpiezaMinutos: extraerValor('intervaloLimpiezaMinutos'),
            advertenciaExpirationHoras: extraerValor('advertenciaExpirationHoras'),
            maxBoletosApartadosSinPago: extraerValor('maxBoletosApartadosSinPago'),
            precioBoleto: extraerValor('precioBoleto'),
            totalBoletos: extraerValor('totalBoletos')
        };
    } catch (error) {
        console.warn('⚠️  No se pudo cargar config.js:', error.message);
        return {};
    }
}

/**
 * Obtiene la configuración de expiración de órdenes y PRECIO
 * Prioridad: .env > config.json local > config.js legacy > fallbacks
 * 
 * ⚠️ NOTA: esto NO es la fuente principal de verdad cuando la BD está disponible.
 */
function obtenerConfigExpiracion() {
    let configGuardado = {};
    const resolverNumeroPreferido = (...candidatos) => {
        for (const candidato of candidatos) {
            if (candidato === null || candidato === undefined || candidato === '') {
                continue;
            }

            const numero = Number(candidato);
            if (Number.isFinite(numero)) {
                return numero;
            }
        }

        return null;
    };
    
    // 🔥 PASO 1: Intentar leer desde config.json local como fallback de arranque
    try {
        const configJsonPath = path.join(__dirname, 'config.json');
        if (fs.existsSync(configJsonPath)) {
            const configData = fs.readFileSync(configJsonPath, 'utf8');
            const parsed = JSON.parse(configData);
            if (parsed?.rifa) {
                configGuardado = parsed.rifa;
                console.log('✅ [Config-Loader] Configuración base cargada desde config.json');
            }
        }
    } catch (err) {
        console.warn('⚠️  No se pudo leer config.json:', err.message);
    }
    
    // 🔥 PASO 2: Fallback a config.js legacy para valores faltantes
    const configDefault = cargarConfigJavaScript();
    
    return {
        tiempoApartadoHoras: parseFloat(process.env.ORDEN_APARTADO_HORAS) 
            || configGuardado.tiempoApartadoHoras
            || configDefault.tiempoApartadoHoras 
            || 4,
        
        intervaloLimpiezaMinutos: parseInt(process.env.ORDEN_LIMPIEZA_MINUTOS) 
            || configGuardado.intervaloLimpiezaMinutos
            || configDefault.intervaloLimpiezaMinutos 
            || 5,
        
        advertenciaExpirationHoras: configGuardado.advertenciaExpirationHoras 
            || configDefault.advertenciaExpirationHoras 
            || 1,
        
        maxBoletosApartadosSinPago: configGuardado.maxBoletosApartadosSinPago 
            || configDefault.maxBoletosApartadosSinPago 
            || null,
        
        // Precio de respaldo para arranque/fallback
        precioBoleto: resolverNumeroPreferido(
            process.env.PRECIO_BOLETO,
            configGuardado.precioBoleto,
            configDefault.precioBoleto
        ),
        
        // Total de boletos de respaldo para arranque/fallback
        totalBoletos: parseInt(process.env.TOTAL_BOLETOS)
            || configGuardado.totalBoletos
            || configDefault.totalBoletos
            || 1000000
    };
}

module.exports = {
    cargarConfigJavaScript,
    obtenerConfigExpiracion
};
