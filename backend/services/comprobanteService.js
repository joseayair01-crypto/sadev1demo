/**
 * ============================================================================
 * SERVICE: Comprobante de Pago
 * ============================================================================
 * Maneja toda la lógica de carga y validación de comprobantes
 * - Validación de archivos
 * - Upload a Cloudinary
 * - Actualización de BD con transacciones
 * - Manejo robusto de errores
 */

const db = require('../db');
const { execSync } = require('child_process');
const {
    ASSET_TYPES,
    subirBufferACloudinary
} = require('./cloudinaryUploadService');

const SCHEMA_CACHE_TTL_MS = 10 * 60 * 1000;
let schemaOrdenesValidadoHasta = 0;

/**
 * Validar que la tabla ordenes tiene las columnas requeridas
 * @throws {Error} Si faltan columnas
 */
async function validarSchemaOrdenes() {
    if (Date.now() < schemaOrdenesValidadoHasta) {
        return true;
    }

    try {
        const result = await db.raw(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = 'ordenes'
            AND column_name IN ('comprobante_path', 'comprobante_fecha')
        `);

        const columnasRequeridas = ['comprobante_path', 'comprobante_fecha'];
        const columnasEncontradas = result.rows.map(r => r.column_name);
        
        const columnasAusentes = columnasRequeridas.filter(
            col => !columnasEncontradas.includes(col)
        );

        if (columnasAusentes.length > 0) {
            throw new Error(
                `Esquema de BD incompleto. Faltan columnas: ${columnasAusentes.join(', ')}. ` +
                `Ejecuta: npm run migrate`
            );
        }

        schemaOrdenesValidadoHasta = Date.now() + SCHEMA_CACHE_TTL_MS;
        return true;
    } catch (error) {
        schemaOrdenesValidadoHasta = 0;
        console.error('[ComprobanteService] Error validando schema:', error.message);
        throw error;
    }
}

/**
 * Validar archivo de comprobante
 * @param {object} archivo - Objeto file de express-fileupload
 * @returns {object} { valido: boolean, error?: string }
 */
function validarArchivo(archivo) {
    if (!archivo) {
        return { valido: false, error: 'Archivo de comprobante es obligatorio' };
    }

    // Extensiones permitidas (más confiable entre navegadores)
    const EXTENSIONES_VALIDAS = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'pdf'];
    const extension = String(archivo.name || '').split('.').pop().toLowerCase();
    
    // 1️⃣ PRIMERO: Validar extensión (es lo más confiable)
    if (!EXTENSIONES_VALIDAS.includes(extension)) {
        console.warn(`[ComprobanteService] ❌ Extensión rechazada: ${extension} | Archivo: ${archivo.name}`);
        return {
            valido: false,
            error: `Extensión no permitida. Usa: .jpg, .png, .webp, .heic, .heif o .pdf`
        };
    }

    // 2️⃣ SEGUNDO: Si tiene MIME type, validarlo (pero ser tolerante)
    // Diferentes navegadores reportan tipos diferentes para el mismo archivo
    const TIPOS_VALIDOS = [
        'image/jpeg',
        'image/png',
        'image/webp',
        'image/heic',
        'image/heif',
        'application/pdf',
        // Tipos alternativos que navegadores reportan en diferentes sistemas operativos:
        'image/jpg',
        'application/octet-stream',  // Cuando el navegador no puede determinar el tipo
        'image/x-heic',
        'image/x-heif',
        'application/x-heic'
    ];

    if (archivo.mimetype && !TIPOS_VALIDOS.includes(archivo.mimetype)) {
        console.warn(
            `[ComprobanteService] ⚠️ MIME type no reconocido pero extensión válida`,
            `{ archivo: "${archivo.name}", mimeType: "${archivo.mimetype}", extension: ".${extension}" }`
        );
        // NO rechazo si la extensión es válida
        console.info(`[ComprobanteService] ℹ️ Permitiendo por extensión válida (.${extension})`);
    }

    // 3️⃣ Validar tamaño (máximo 5MB)
    const MAX_SIZE = 5 * 1024 * 1024;
    if (archivo.size > MAX_SIZE) {
        console.warn(`[ComprobanteService] ❌ Archivo demasiado grande: ${(archivo.size / 1024 / 1024).toFixed(2)}MB`);
        return {
            valido: false,
            error: `Archivo demasiado grande. Máximo 5MB. Tamaño actual: ${(archivo.size / 1024 / 1024).toFixed(2)}MB`
        };
    }

    // 4️⃣ Validar que tiene datos
    if (!archivo.data || archivo.data.length === 0) {
        console.warn(`[ComprobanteService] ❌ Archivo vacío`);
        return { valido: false, error: 'Archivo vacío' };
    }

    console.info(
        `[ComprobanteService] ✅ Validación OK`,
        `{ archivo: "${archivo.name}", size: "${(archivo.size / 1024).toFixed(1)}KB", extension: ".${extension}", mimeType: "${archivo.mimetype || 'no-reportado'}" }`
    );

    return { valido: true };
}

/**
 * Validar datos del cliente
 * @param {string} whatsapp - Número de WhatsApp
 * @param {string} numeroOrden - Número de orden
 * @returns {object} { valido: boolean, error?: string }
 */
function validarDatos(whatsapp, numeroOrden) {
    if (!numeroOrden || typeof numeroOrden !== 'string' || numeroOrden.length === 0) {
        return { valido: false, error: 'Número de orden inválido' };
    }

    if (!whatsapp) {
        return { valido: false, error: 'WhatsApp es obligatorio' };
    }

    // Validar formato WhatsApp: solo dígitos, 10-12 caracteres
    const whatsappSanitizado = String(whatsapp).replace(/[^0-9]/g, '');
    if (whatsappSanitizado.length < 10 || whatsappSanitizado.length > 12) {
        return { valido: false, error: 'WhatsApp inválido' };
    }

    return { valido: true, whatsappSanitizado };
}

/**
 * Validar que la orden existe y pertenece al cliente
 * @param {string} numeroOrden - Número de orden
 * @param {string} whatsappSanitizado - WhatsApp sanitizado
 * @returns {object} { valido: boolean, error?: string, orden?: object }
 */
async function validarOrden(numeroOrden, whatsappSanitizado, contexto = {}) {
    try {
        const rifaId = Number.parseInt(contexto?.rifaId, 10);
        const orden = await db('ordenes')
            .modify((qb) => {
                if (Number.isInteger(rifaId) && rifaId > 0) {
                    qb.where('rifa_id', rifaId);
                }
            })
            .where('numero_orden', numeroOrden)
            .first();

        if (!orden) {
            return { valido: false, error: 'Orden no encontrada' };
        }

        // Verificar que el WhatsApp coincida (validación de propiedad)
        const whatsappEnBd = String(orden.telefono_cliente || '').replace(/[^0-9]/g, '');
        if (whatsappSanitizado !== whatsappEnBd) {
            return {
                valido: false,
                error: 'No tienes permiso para subir comprobante a esta orden'
            };
        }

        // Verificar que el estado sea "pendiente"
        if (orden.estado !== 'pendiente') {
            return {
                valido: false,
                error: `No puedes subir comprobante. Estado actual: ${orden.estado}`
            };
        }

        return { valido: true, orden };
    } catch (error) {
        return {
            valido: false,
            error: `Error al validar orden: ${error.message}`
        };
    }
}

/**
 * Subir archivo a Cloudinary
 * @param {Buffer} datos - Buffer del archivo
 * @param {string} nombreArchivo - Nombre único del archivo
 * @param {string} mimetype - Tipo MIME del archivo
 * @returns {Promise<string>} URL de Cloudinary
 * @throws {Error} Si falla el upload
 */
async function subirACloudinary(datos, nombreArchivo, mimetype) {
    let bufferFinal = datos;
    let mimeFinal = mimetype;

    // Convertir HEIC → JPEG usando sips (nativo en macOS)
    if (mimetype === 'image/heic' || mimetype === 'image/heif') {
        try {
            const fs = require('fs');
            const path = require('path');
            const tmpDir = '/tmp';
            const inputPath = path.join(tmpDir, `heic-${Date.now()}.heic`);
            const outputPath = path.join(tmpDir, `jpeg-${Date.now()}.jpg`);
            
            // Guardar HEIC temporal
            fs.writeFileSync(inputPath, datos);
            
            // Convertir con sips (disponible en macOS)
            execSync(`sips -s format jpeg "${inputPath}" --out "${outputPath}"`, { encoding: 'utf-8' });
            
            // Leer JPEG convertido
            bufferFinal = fs.readFileSync(outputPath);
            mimeFinal = 'image/jpeg';
            nombreArchivo = nombreArchivo.replace(/\.(heic|heif)$/i, '.jpg');
            
            // Limpiar temporales
            fs.unlinkSync(inputPath);
            fs.unlinkSync(outputPath);
            
            console.log(`✅ HEIC convertido a JPEG: ${nombreArchivo} (${(bufferFinal.length / 1024).toFixed(1)}KB)`);
        } catch (error) {
            console.error(`❌ Error al convertir HEIC: ${error.message}`);
            throw new Error(`No se pudo convertir HEIC a JPEG: ${error.message}`);
        }
    }

    const result = await subirBufferACloudinary({
        buffer: bufferFinal,
        originalName: nombreArchivo,
        mimetype: mimeFinal,
        assetType: ASSET_TYPES.COMPROBANTE
    });

    return result.secureUrl;
}

/**
 * Actualizar orden en BD después de subir comprobante
 * @param {string} numeroOrden - Número de orden
 * @param {string} urlComprobante - URL de Cloudinary
 * @returns {Promise<boolean>}
 * @throws {Error} Si falla la actualización
 */
async function actualizarOrdenEnBd(numeroOrden, urlComprobante, contexto = {}) {
    try {
        const timestampUTC = new Date().toISOString();
        const rifaId = Number.parseInt(contexto?.rifaId, 10);
        
        const result = await db('ordenes')
            .modify((qb) => {
                if (Number.isInteger(rifaId) && rifaId > 0) {
                    qb.where('rifa_id', rifaId);
                }
            })
            .where('numero_orden', numeroOrden)
            .update({
                comprobante_recibido: true,
                comprobante_path: urlComprobante,
                comprobante_fecha: timestampUTC,
                updated_at: timestampUTC
            });

        if (result === 0) {
            throw new Error('Orden no encontrada para actualizar');
        }

        return true;
    } catch (error) {
        throw new Error(`Error actualizando orden en BD: ${error.message}`);
    }
}

/**
 * FUNCIÓN PRINCIPAL: Procesar upload de comprobante
 * @param {object} params - Parámetros
 * @param {string} params.numeroOrden - Número de orden
 * @param {string} params.whatsapp - WhatsApp del cliente
 * @param {object} params.archivo - Objeto file
 * @returns {Promise<object>} { success: true, message, url?, numeroOrden }
 * @throws {Error} Si hay cualquier error en el proceso
 */
async function procesarComprobante({ numeroOrden, whatsapp, archivo, rifaId = null }) {
    const debugId = `[PROC-COMPR-${Date.now()}]`;
    
    try {
        console.log(`${debugId} [STEP 1] Iniciando procesamiento`);
        console.log(`${debugId} [STEP 1] Parámetros: orden=${numeroOrden}, whatsapp=${whatsapp ? 'YES' : 'NO'}, archivo=${archivo ? 'YES' : 'NO'}, rifaId=${rifaId}`);
        
        // Step 1: Validar schema
        console.log(`${debugId} [STEP 1] Validando schema de BD...`);
        await validarSchemaOrdenes();
        console.log(`${debugId} [STEP 1] ✅ Schema válido`);

        // Step 2: Validar datos básicos
        console.log(`${debugId} [STEP 2] Validando datos básicos...`);
        const validacionDatos = validarDatos(whatsapp, numeroOrden);
        if (!validacionDatos.valido) {
            console.log(`${debugId} [STEP 2] ❌ Datos inválidos: ${validacionDatos.error}`);
            throw new Error(validacionDatos.error);
        }
        const { whatsappSanitizado } = validacionDatos;
        console.log(`${debugId} [STEP 2] ✅ Datos válidos (whatsapp sanitizado)`);

        // Step 3: Validar archivo
        console.log(`${debugId} [STEP 3] Validando archivo...`);
        console.log(`${debugId} [STEP 3] Archivo info: name=${archivo?.name}, size=${archivo?.size} bytes, mimetype=${archivo?.mimetype}, hasData=${!!archivo?.data}`);
        const validacionArchivo = validarArchivo(archivo);
        if (!validacionArchivo.valido) {
            console.log(`${debugId} [STEP 3] ❌ Archivo inválido: ${validacionArchivo.error}`);
            throw new Error(validacionArchivo.error);
        }
        console.log(`${debugId} [STEP 3] ✅ Archivo válido (${(archivo.size / 1024).toFixed(1)}KB)`);

        // Step 4: Validar orden en BD
        console.log(`${debugId} [STEP 4] Validando orden en BD...`);
        const contexto = { rifaId };
        const validacionOrden = await validarOrden(numeroOrden, whatsappSanitizado, contexto);
        if (!validacionOrden.valido) {
            console.log(`${debugId} [STEP 4] ❌ Orden inválida: ${validacionOrden.error}`);
            throw new Error(validacionOrden.error);
        }
        console.log(`${debugId} [STEP 4] ✅ Orden válida (estado=${validacionOrden.orden?.estado})`);

        // Step 5: Upload a Cloudinary
        console.log(`${debugId} [STEP 5] Iniciando upload a Cloudinary...`);
        const nombreArchivo = `${numeroOrden}_${Date.now()}`;
        console.log(`${debugId} [STEP 5] Nombre archivo: ${nombreArchivo}, mimetype: ${archivo.mimetype}`);
        
        let urlComprobante;
        try {
            urlComprobante = await subirACloudinary(
                archivo.data,
                nombreArchivo,
                archivo.mimetype
            );
            console.log(`${debugId} [STEP 5] ✅ Upload completado: ${urlComprobante.substring(0, 60)}...`);
        } catch (cloudError) {
            console.log(`${debugId} [STEP 5] ❌ Error en Cloudinary: ${cloudError.message}`);
            throw cloudError;
        }

        // Step 6: Actualizar BD
        console.log(`${debugId} [STEP 6] Actualizando orden en BD...`);
        try {
            await actualizarOrdenEnBd(numeroOrden, urlComprobante, contexto);
            console.log(`${debugId} [STEP 6] ✅ BD actualizada`);
        } catch (bdError) {
            console.log(`${debugId} [STEP 6] ❌ Error en BD: ${bdError.message}`);
            throw bdError;
        }

        console.log(`${debugId} [SUCCESS] ✅ Proceso completado exitosamente\n`);

        return {
            success: true,
            message: 'Comprobante subido exitosamente',
            numero_orden: numeroOrden,
            url: urlComprobante,
            tamaño_mb: (archivo.size / 1024 / 1024).toFixed(2)
        };
    } catch (error) {
        console.error(`${debugId} [ERROR] ❌ Error en procesarComprobante: ${error.message}\n`);
        throw error;
    }
}

module.exports = {
    procesarComprobante,
    validarSchemaOrdenes,
    validarArchivo,
    validarDatos,
    validarOrden,
    subirACloudinary,
    actualizarOrdenEnBd
};
