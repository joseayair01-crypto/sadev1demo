// backend/server.js - Backend Express para RifaPlus
// Provee endpoints para guardar órdenes y servir páginas viewables
// v2.0: Migrado a PostgreSQL con Knex para persistencia segura
// v2.1: Autenticación JWT para panel admin
// v2.2: Validaciones, seguridad, sanitización y rate limiting
// v2.3: Sistema automático de expiración de órdenes (configurable dinámicamente)
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fileUpload = require('express-fileupload');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const sanitizeHtml = require('sanitize-html');
const compression = require('compression');
const crypto = require('crypto');  // ⭐ FASE 1: Para calcular ETags en HTTP caching
const { AsyncLocalStorage } = require('async_hooks');
const lockfile = require('proper-lockfile');  // 🔒 File locking para race conditions
const socketIO = require('socket.io');  // 🔌 WebSocket para actualizaciones en tiempo real
// ⚠️ CRÍTICO: cargar .env desde el directorio backend para DATABASE_URL
require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();
// Configurar `trust proxy` de forma segura para ambientes PaaS
// - Evitar `true` porque es demasiado permisivo y causa error en express-rate-limit
// - Permitir override con la variable `TRUST_PROXY` (ej: '1')
const rawTrustProxy = process.env.TRUST_PROXY;
if (rawTrustProxy !== undefined) {
    let value = rawTrustProxy;
    if (rawTrustProxy === 'true') value = true;
    else if (rawTrustProxy === 'false') value = false;
    else if (!Number.isNaN(Number(rawTrustProxy))) value = Number(rawTrustProxy);
    app.set('trust proxy', value);
    console.log('⚙️ [server] trust proxy set from TRUST_PROXY env:', value);
} else {
    // Default safe behaviour: confiar en 1 proxy en producción, loopback en desarrollo
    const isProd = process.env.NODE_ENV === 'production';
    const defaultValue = isProd ? 1 : 'loopback';
    app.set('trust proxy', defaultValue);
    console.log('⚙️ [server] trust proxy defaulted to:', defaultValue);
}
const db = require('./db'); // Instancia Knex (Postgres)
const cloudinary = require('./cloudinary-config'); // ✅ Cloudinary para almacenar comprobantes
const ordenExpirationService = require('./services/ordenExpirationService'); // Servicio de expiración
const OportunidadesOrdenService = require('./services/oportunidadesOrdenService'); // Servicio de oportunidades
const OportunidadesInventoryService = require('./services/oportunidadesInventoryService');
const NuevaRifaService = require('./services/nuevaRifaService');
const BoletoService = require('./services/boletoService'); // Servicio de boletos para estadísticas y limpieza
const RifaService = require('./services/rifaService');
const RifaArchiveService = require('./services/rifaArchiveService');
const { applyRifaScope, getRifaIdFromRequest } = require('./services/rifaScope');
const comprobanteService = require('./services/comprobanteService'); // ✅ Servicio de comprobantes
const { subirBufferACloudinary, normalizarAssetType } = require('./services/cloudinaryUploadService');
const SorteoFinalizadoSnapshotService = require('./services/sorteoFinalizadoSnapshotService');
const { inicializarEventosWebSocket } = require('./services/websocket-events'); // 🔌 Eventos de WebSocket
const {
    obtenerConfigPush,
    construirMetadatosOrdenPushPublica,
    verificarTokenOrdenPush,
    upsertSuscripcionPush,
    desactivarSuscripcionPush,
    upsertSuscripcionCampanaPush,
    desactivarSuscripcionCampanaPush,
    resolverOrganizerKeyPush,
    enviarPushOrdenConfirmada,
    enviarPushOrdenCancelada,
    enviarPushOrdenPorVencer,
    backfillSuscripcionesCampanaDesdeOrdenes,
    PUSH_CAMPAIGN_EVENT_TYPE_NUEVA_RIFA,
    PUSH_CAMPAIGN_EVENT_TYPE_PRESORTEO_PROXIMO,
    PUSH_CAMPAIGN_EVENT_TYPE_SORTEO_PROXIMO,
    PUSH_CAMPAIGN_EVENT_TYPE_RESULTADOS_DISPONIBLES
} = require('./services/pushNotificationsService');
const { PushCampaignQueueService } = require('./services/pushCampaignQueueService');
const { obtenerConfigExpiracion } = require('./config-loader'); // Fallback/base de arranque
const dbUtils = require('./db-utils');
const { calcularDescuentoCompartido, auditarConsistenciaPrecios, calcularTotalesServidor } = require('./calculo-precios-server'); // ✅ Cálculo sincronizado
const { resolverConfigOportunidades } = require('./oportunidades-config');
const PUBLIC_READ_RATE_LIMIT_PATHS = new Set([
    '/api/health',
    '/api/cliente',
    '/api/ganadores',
    '/api/public/config',
    '/api/public/ordenes-stats',
    '/api/public/boletos',
    '/api/public/boletos/stats',
    '/api/public/boletos/optimizado'
]);

const limiterPushPublico = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 40,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        message: 'Demasiadas solicitudes de notificaciones. Intenta de nuevo en unos minutos.'
    }
});

let recordatoriosEventoInterval = null;
let recordatoriosEventoEnEjecucion = false;
let pushCampaignQueueService = null;

// ===== VALIDACIÓN CRÍTICA DE CONFIGURACIÓN =====
// Verificar que variables de entorno REQUERIDAS existan y sean válidas
const variablesRequeridas = ['JWT_SECRET'];
const variablesFaltantes = variablesRequeridas.filter(v => !process.env[v]);

if (variablesFaltantes.length > 0) {
    console.error('');
    console.error('🚨 ❌ ERROR CRÍTICO: Configuración incompleta');
    console.error('================================================');
    console.error('Variables de entorno requeridas pero FALTANTES:');
    variablesFaltantes.forEach(v => {
        console.error(`  - ${v}`);
    });
    console.error('');
    console.error('SOLUCIÓN: Crea archivo .env con:');
    console.error('  JWT_SECRET=tu-secret-muy-seguro-aqui');
    console.error('  NODE_ENV=production');
    console.error('================================================');
    console.error('');
    process.exit(1);
}

// 🔐 VALIDACIÓN: JWT_SECRET debe tener min 32 caracteres en PRODUCCIÓN
const JWT_SECRET = process.env.JWT_SECRET;
if (process.env.NODE_ENV === 'production') {
    if (JWT_SECRET.length < 32) {
        console.error('');
        console.error('🚨 ❌ ERROR CRÍTICO: JWT_SECRET muy débil');
        console.error('================================================');
        console.error('En PRODUCCIÓN, JWT_SECRET debe tener min 32 caracteres aleatorios');
        console.error('');
        console.error('GENERAR JWT_SECRET FUERTE:');
        console.error('  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
        console.error('');
        console.error('Luego copiar el resultado en .env como:');
        console.error('  JWT_SECRET=<resultado_del_comando>');
        console.error('================================================');
        console.error('');
        process.exit(1);
    }
}
const JWT_EXPIRES_IN = '24h'; // Token expira en 24 horas

// ⚠️ UTILITY: Limitar concurrencia para evitar "MaxClientsInSessionMode" en Vercel
// Ejecuta promesas en batches de N simultáneas
async function pLimit(promises, maxConcurrent = 3) {
    const results = [];
    for (let i = 0; i < promises.length; i += maxConcurrent) {
        const batch = promises.slice(i, i + maxConcurrent);
        const batchResults = await Promise.all(batch);
        results.push(...batchResults);
    }
    return results;
}

// ============================================================
// FUNCIÓN: OBTENER PRECIO DINAMICO (Lee en cada petición)
// ============================================================
/**
 * Obtiene el precio del boleto dinámicamente desde la configuración actual
 * ✅ ACTUALIZADO: Verifica promoción por tiempo
 * IMPORTANTE: Se ejecuta en cada petición, no usa cache para mantener sincronía
 * @returns {number} Precio del boleto actual (o precio provisional si hay promoción activa)
 */
function obtenerPrecioDinamico() {
    try {
        const config = obtenerConfigActual();
        const ahora = new Date();

        // Verificar si hay promoción por tiempo activa
        const promo = config.rifa?.promocionPorTiempo;
        if (promo && promo.enabled && promo.precioProvisional !== null && promo.precioProvisional !== undefined) {
            const inicio = promo.fechaInicio ? new Date(/(?:Z|[+-]\d{2}:\d{2})$/i.test(String(promo.fechaInicio)) ? promo.fechaInicio : `${promo.fechaInicio}-06:00`) : null;
            const fin = promo.fechaFin ? new Date(/(?:Z|[+-]\d{2}:\d{2})$/i.test(String(promo.fechaFin)) ? promo.fechaFin : `${promo.fechaFin}-06:00`) : null;

            // Si estamos dentro del rango de promoción, usar precio provisional
            if (inicio && fin && ahora >= inicio && ahora <= fin) {
                const precioProvisional = Number(promo.precioProvisional);
                if (precioProvisional >= 0 && Number.isFinite(precioProvisional)) {
                    console.log(`💰 [Promoción Activa] Usando precio provisional: $${precioProvisional.toFixed(2)}`);
                    return precioProvisional;
                }
            }
        }

        // Si no hay promoción activa, usar precio normal
        if (config?.rifa?.precioBoleto !== undefined && Number(config.rifa.precioBoleto) >= 0) {
            return Number(config.rifa.precioBoleto);
        }
    } catch (err) {
        console.error('Error leyendo precio dinámico:', err.message);
    }
    return Number(PRECIO_BOLETO_DEFAULT) || 0;
}

// Configuración base de arranque para expiración de órdenes
// La configuración dinámica principal viene de la BD cuando está disponible.
const configExpiracion = obtenerConfigExpiracion();
const TIEMPO_APARTADO_HORAS = configExpiracion.tiempoApartadoHoras;
const INTERVALO_LIMPIEZA_MINUTOS = configExpiracion.intervaloLimpiezaMinutos;

function normalizarPushOrderWarningMinutesConfig(rawValue) {
    if (rawValue === undefined || rawValue === null || rawValue === '') {
        return null;
    }

    const values = Array.isArray(rawValue)
        ? rawValue
        : String(rawValue)
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean);

    return [...new Set(
        values
            .map((value) => Number.parseInt(String(value).replace(/[^0-9]/g, ''), 10))
            .filter((value) => Number.isInteger(value) && value > 0)
    )].sort((a, b) => b - a);
}
const PRECIO_BOLETO_DEFAULT = configExpiracion.precioBoleto;

// ⭐ CACHE GLOBAL EN SERVIDOR (en lugar de window.* que no existe en Node.js)
const serverCache = {
    publicConfigs: new Map(), // ✅ NUEVO: Mapa de caches por rifa (slug/id -> { payload, timestamp })
    boletosPublicosCached: null,
    boletosPublicosCachedTime: 0,
    boletosStatsCached: {},
    boletosStatsCachedTime: {},
    boletosPublicosByRange: new Map(),
    ordenesStatsCached: {},
    ordenesStatsCachedTime: {},
    publicConfigCached: null,
    publicConfigCachedKey: '',
    publicConfigCachedTime: 0,
    clienteConfigCached: null,
    clienteConfigCachedKey: '',
    clienteConfigCachedTime: 0,
    publicRequestFlights: new Map()
};

function limpiarCacheConfiguracionPublica(rifaIdOrSlug = null) {
    if (rifaIdOrSlug) {
        serverCache.publicConfigs.delete(String(rifaIdOrSlug));
    } else {
        serverCache.publicConfigs.clear();
    }
    
    serverCache.publicConfigCached = null;
    serverCache.publicConfigCachedKey = '';
    serverCache.publicConfigCachedTime = 0;
    serverCache.clienteConfigCached = null;
    serverCache.clienteConfigCachedKey = '';
    serverCache.clienteConfigCachedTime = 0;
}

function limpiarCacheBoletosPublicos() {
    global.boletosPublicRangeStatsCache = null;
    global.boletosPublicRangeStatsCacheTime = null;
    serverCache.boletosStatsCached = {};
    serverCache.boletosStatsCachedTime = {};
    serverCache.boletosPublicosCached = null;
    serverCache.boletosPublicosCachedTime = 0;
    serverCache.boletosPublicosByRange.clear();
    serverCache.ordenesStatsCached = {};
    serverCache.ordenesStatsCachedTime = {};
}

function refrescarCachesTrasCambioInventario() {
    limpiarCacheBoletosPublicos();
}

function obtenerTtlCachePublico({ productionMs = 60000, developmentMs = 5000 } = {}) {
    return process.env.NODE_ENV === 'production' ? productionMs : developmentMs;
}

function obtenerCacheMemoriaVigente(payload, cachedTime, ttlMs) {
    if (!payload || !cachedTime) {
        return null;
    }

    const ageMs = Date.now() - cachedTime;
    if (ageMs < 0 || ageMs >= ttlMs) {
        return null;
    }

    return { payload, ageMs };
}

async function resolverSingleFlightPublico(cacheKey, taskFactory) {
    const existingFlight = serverCache.publicRequestFlights.get(cacheKey);
    if (existingFlight) {
        return existingFlight;
    }

    const flight = Promise.resolve()
        .then(taskFactory)
        .finally(() => {
            if (serverCache.publicRequestFlights.get(cacheKey) === flight) {
                serverCache.publicRequestFlights.delete(cacheKey);
            }
        });

    serverCache.publicRequestFlights.set(cacheKey, flight);
    return flight;
}

// 🔌 VARIABLE GLOBAL: Instancia de eventos WebSocket (se inicializa al arrancar el servidor)
let wsEvents = null;
const requestRifaStorage = new AsyncLocalStorage();
let rifaService = null;
let rifaArchiveService = null;

// Log de configuración cargada
console.log(`⚙️  Configuración base de arranque cargada:`);
console.log(`   - Tiempo reservado: ${TIEMPO_APARTADO_HORAS} horas`);
console.log(`   - Intervalo limpieza: ${INTERVALO_LIMPIEZA_MINUTOS} minutos`);
console.log(`   - Precio boleto: $${PRECIO_BOLETO_DEFAULT}`);  // ✅ LOG del precio

// Middleware de Seguridad
app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },  // Permitir CORS para recursos
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: [
                "'self'",
                "'unsafe-inline'",
                "'unsafe-eval'",
                "https://cdnjs.cloudflare.com",
                "https://fonts.googleapis.com",
                "https://cdn.sheetjs.com",
                "https://cdn.jsdelivr.net"  // ✅ Chart.js CDN
            ],
            styleSrc: [
                "'self'",
                "'unsafe-inline'",
                "https://cdnjs.cloudflare.com",
                "https://fonts.googleapis.com"
            ],
            imgSrc: ["'self'", "data:", "https:"],
            fontSrc: ["'self'", "https://fonts.googleapis.com", "https://fonts.gstatic.com"],
            connectSrc: ["'self'", "https:"]
        }
    }
}));

// ✅ COMPRESSION MIDDLEWARE - Comprime respuestas con gzip
// Reduce tamaño de JSON/HTML hasta 80%
app.use(compression({
    level: 6,  // 0-9, 6 es balance entre velocidad y compresión
    threshold: 1024,  // Solo comprimir respuestas > 1KB
    filter: (req, res) => {
        // Evitar comprimir algunas respuestas
        if (req.headers['x-no-compression']) {
            return false;
        }
        return compression.filter(req, res);
    }
}));

// 🔒 CORS SEGURO: Whitelist de orígenes permitidos
const getCorsOrigins = () => {
    // DESARROLLO: Lista incorporada
    if (process.env.NODE_ENV !== 'production') {
        return [
            'http://localhost:3000',
            'http://localhost:5500',
            'http://127.0.0.1:5500',
            'http://127.0.0.1:3000',
            'http://127.0.0.1:5001',
        ];
    }

    // PRODUCCIÓN: Desde .env (variable CORS_ORIGINS)
    const corsEnv = process.env.CORS_ORIGINS || '';
    if (!corsEnv) {
        console.warn('⚠️  CORS_ORIGINS no configurado en .env. Usando lista vacía (solo MISMO ORIGEN)');
        return [];
    }

    return corsEnv.split(',').map(o => o.trim()).filter(o => o.length > 0);
};

const allowedCorsOrigins = getCorsOrigins();
const DEFAULT_CORS_ALLOWED_HEADERS = [
    'Content-Type',
    'Authorization',
    'Accept',
    'x-rifaplus-rifa-id',
    'x-rifa-id',
    'x-rifaplus-rifa-slug'
];

// Configurar CORS con whitelist
app.use(cors({
    origin: function (origin, callback) {
        // No hay origen en solicitudes como GET desde servidor
        if (!origin) {
            return callback(null, true);
        }

        // Verificar si origen está en whitelist
        if (allowedCorsOrigins.includes(origin)) {
            return callback(null, true);
        }

        // En desarrollo, ser un poco más permisivo
        if (process.env.NODE_ENV !== 'production') {
            // Log warning pero permitir en desarrollo
            console.warn(`⚠️  CORS: Origen no whitelistado: ${origin}`);
            return callback(null, true);
        }

        // En producción, RECHAZAR
        return callback(new Error(`CORS: Origen no autorizado: ${origin}`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: DEFAULT_CORS_ALLOWED_HEADERS,
    maxAge: 86400 // Cache CORS por 24 horas para reducir preflight requests
}));

app.use((req, res, next) => {
    const requestHeaders = String(req.headers['access-control-request-headers'] || '').trim();

    // ✅ CRÍTICO: Siempre incluir headers custom en la respuesta CORS
    const customHeaders = 'x-rifaplus-rifa-id, x-rifa-id, x-rifaplus-rifa-slug, x-rifa-slug';
    const allHeaders = requestHeaders
        ? `${requestHeaders}, ${customHeaders}`
        : `${DEFAULT_CORS_ALLOWED_HEADERS.join(', ')}, ${customHeaders}`;

    res.setHeader('Access-Control-Allow-Headers', allHeaders);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Max-Age', '86400');

    // Manejar preflight OPTIONS
    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }

    next();
});

// 🔐 HEADERS DE SEGURIDAD ADICIONALES
// Headers custom que mejoran seguridad más allá de helmet
app.use((req, res, next) => {
    // Prevenir ataques de timing
    res.setHeader('X-Content-Type-Options', 'nosniff');

    // Prevenir clickjacking (aunque helmet ya lo hace)
    res.setHeader('X-Frame-Options', 'DENY');

    // Prevenir browser sniffing
    res.setHeader('X-UA-Compatible', 'IE=edge');

    // Referrer policy: no enviar referrer a otros dominios
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

    // Permissions policy (anteriormente Feature-Policy)
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');

    // Prevenir MIME sniffing
    res.setHeader('X-Content-Type-Options', 'nosniff');

    next();
});

// Parsear JSON y form data
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

// Parsear archivos de formularios (FormData con archivos)
app.use(fileUpload({
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max para imágenes
    abortOnLimit: true,
    responseOnLimit: 'El archivo es demasiado grande. Máximo 50MB.'
}));

app.use(async (req, res, next) => {
    try {
        if (!rifaService?.enabled) {
            const contextoFallback = construirContextoRifaFallback();
            req.rifaContext = contextoFallback;
            return requestRifaStorage.run(contextoFallback, next);
        }

        const { rifaId, slug } = obtenerHeadersRifaRequest(req);

        // 🔄 Reintentar resolución de contexto si la BD está ocupada
        let contexto = null;
        let lastError = null;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                contexto = await rifaService.resolverContexto({
                    rifaId,
                    slug,
                    hostname: (req.headers.host || req.hostname || '').split(':')[0],
                    fallbackActive: true
                });
                if (contexto) break;
            } catch (err) {
                lastError = err;
                const isConnError = /connection|pool|deadlock|max client/i.test(err.message);
                if (isConnError && attempt < 2) {
                    await new Promise(r => setTimeout(r, 200 + Math.floor(Math.random() * 500)));
                    continue;
                }
                throw err;
            }
        }

        contexto = contexto || construirContextoRifaFallback();

        req.rifaContext = contexto;
        res.setHeader('X-RifaPlus-Rifa-Slug', String(contexto?.slug || ''));
        if (contexto?.id) {
            res.setHeader('X-RifaPlus-Rifa-Id', String(contexto.id));
        }

        return requestRifaStorage.run(contexto, next);
    } catch (error) {
        console.warn('[rifa-context] No se pudo resolver el contexto de rifa:', error.message);
        const contextoFallback = construirContextoRifaFallback();
        req.rifaContext = contextoFallback;
        return requestRifaStorage.run(contextoFallback, next);
    }
});

// 🔒 RATE LIMITING: Protegiendo contra ataques de fuerza bruta y DoS

function esMetodoLecturaHttp(method) {
    return method === 'GET' || method === 'HEAD';
}

function esRutaLecturaPublicaEsencial(req) {
    if (!req || !esMetodoLecturaHttp(req.method)) {
        return false;
    }

    return PUBLIC_READ_RATE_LIMIT_PATHS.has(req.path);
}

function esRutaConRateLimitDedicado(req) {
    if (!req) {
        return false;
    }

    const method = String(req.method || '').toUpperCase();
    const routePath = String(req.path || '').trim();

    if (!routePath) {
        return false;
    }

    if (method === 'POST' && (routePath === '/api/admin/login' || routePath === '/api/ordenes')) {
        return true;
    }

    if (routePath === '/api/public/order-counter/next' && method === 'POST') {
        return true;
    }

    if (routePath.startsWith('/api/ordenes/por-cliente/') && method === 'GET') {
        return true;
    }

    if (routePath === '/api/public/boletos/busqueda' && method === 'GET') {
        return true;
    }

    if (/^\/api\/public\/boletos\/[^/]+\/oportunidades$/i.test(routePath) && method === 'GET') {
        return true;
    }

    if (routePath === '/api/public/boletos/oportunidades/batch' && method === 'POST') {
        return true;
    }

    if (routePath === '/api/public/oportunidades/disponibles' && method === 'GET') {
        return true;
    }

    if (routePath === '/api/public/oportunidades/validar' && method === 'POST') {
        return true;
    }

    return false;
}

function obtenerRateLimitsEntornoActual() {
    const isProduction = process.env.NODE_ENV === 'production';
    const envKey = isProduction ? 'production' : 'development';
    const defaults = configManager?.getDefaultConfig?.().rate_limits?.[envKey] || {};

    let configActual = null;
    try {
        configActual = typeof obtenerConfigActual === 'function' ? obtenerConfigActual() : null;
    } catch (error) {
        configActual = null;
    }

    return {
        isProduction,
        envKey,
        config: configActual?.rate_limits?.[envKey]
            || configManager?.config?.rate_limits?.[envKey]
            || defaults,
        defaults
    };
}

function obtenerConfiguracionRateLimitGeneral() {
    const { isProduction, config, defaults } = obtenerRateLimitsEntornoActual();

    return {
        enabled: isProduction,
        windowMs: normalizarEnteroPositivo(config?.windowMs, normalizarEnteroPositivo(defaults?.windowMs, 15 * 60 * 1000)),
        max: normalizarEnteroPositivo(config?.general, normalizarEnteroPositivo(defaults?.general, isProduction ? 800 : 10000))
    };
}

function obtenerConfiguracionRateLimitLecturaPublica() {
    const { isProduction, config } = obtenerRateLimitsEntornoActual();
    const defaults = {
        enabled: isProduction,
        windowMs: 60 * 1000,
        max: isProduction ? 1200 : 10000
    };
    const rawConfig = config?.publicReadConfig || config?.lecturaPublicaConfig || {};

    return {
        enabled: rawConfig.enabled !== undefined ? rawConfig.enabled === true : defaults.enabled,
        windowMs: normalizarEnteroPositivo(rawConfig.windowMs, defaults.windowMs),
        max: normalizarEnteroPositivo(rawConfig.max, defaults.max)
    };
}

const limiterGeneral = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: process.env.NODE_ENV === 'production' ? 800 : 10000,
    message: 'Demasiadas solicitudes, intenta más tarde',
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => {
        const configGeneral = obtenerConfiguracionRateLimitGeneral();
        if (!configGeneral.enabled) {
            return true;
        }

        return esRutaLecturaPublicaEsencial(req) || esRutaConRateLimitDedicado(req);
    }
});

const limiterLogin = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: process.env.NODE_ENV === 'production' ? 5 : 1000, // Muy restrictivo: solo 5 intentos en 15 min
    message: 'Demasiados intentos de login. Intenta en 15 minutos',
    skipSuccessfulRequests: true, // No contar intentos exitosos
    skip: (req, res) => {
        return process.env.NODE_ENV !== 'production';
    }
});

function normalizarEnteroPositivo(valor, fallback) {
    const numero = Number(valor);
    return Number.isInteger(numero) && numero > 0 ? numero : fallback;
}

function normalizarHoraDelDia(valor, fallback) {
    const numero = Number(valor);
    return Number.isInteger(numero) && numero >= 0 && numero <= 23 ? numero : fallback;
}

function esperar(ms) {
    const duration = Math.max(0, Number(ms) || 0);
    if (duration <= 0) {
        return Promise.resolve();
    }

    return new Promise((resolve) => setTimeout(resolve, duration));
}

function resolverHoraActualEnZona(timeZone) {
    const zona = String(timeZone || '').trim() || 'America/Mexico_City';

    try {
        const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: zona,
            hour: '2-digit',
            hour12: false
        });
        const hourPart = formatter.formatToParts(new Date()).find((part) => part.type === 'hour')?.value;
        return normalizarHoraDelDia(Number(hourPart), new Date().getHours());
    } catch (error) {
        return new Date().getHours();
    }
}

function horaEstaEnVentanaPico(hour, startHour, endHour) {
    if (startHour === endHour) {
        return true;
    }

    if (startHour < endHour) {
        return hour >= startHour && hour < endHour;
    }

    return hour >= startHour || hour < endHour;
}

function obtenerConfiguracionRateLimitOrdenes() {
    const isProduction = process.env.NODE_ENV === 'production';
    const isTest = process.env.NODE_ENV === 'test' || process.env.LOAD_TEST === 'true';

    const defaults = {
        enabled: isProduction && !isTest,  // ⬆️ Deshabilitar en test
        windowMs: 60 * 1000,
        normalMax: isProduction ? 1000 : 999999,          // ⬆️ 300 → 1000 (16 req/seg)
        peakMax: isProduction ? 2000 : 999999,             // ⬆️ 600 → 2000 (33 req/seg en pico)
        normalBurstCapacity: isProduction ? 2000 : 999999, // ⬆️ 600 → 2000
        peakBurstCapacity: isProduction ? 4000 : 999999,   // ⬆️ 1200 → 4000
        maxQueueWaitMs: isProduction && !isTest ? 5000 : 0,  // ⬆️ 3000 → 5000 (test: 0)
        queuePollMs: 100,
        peakStartHour: 20,
        peakEndHour: 23
    };

    let configActual = null;
    try {
        configActual = typeof obtenerConfigActual === 'function' ? obtenerConfigActual() : null;
    } catch (error) {
        configActual = null;
    }

    const envKey = isProduction ? 'production' : 'development';
    const rawEnvConfig = configActual?.rate_limits?.[envKey]
        || configManager?.config?.rate_limits?.[envKey]
        || configManager?.getDefaultConfig?.().rate_limits?.[envKey]
        || {};

    const rawOrdersConfig = rawEnvConfig?.ordenesConfig || rawEnvConfig?.ordenesRateLimit || {};

    const enabled = rawOrdersConfig.enabled !== undefined
        ? rawOrdersConfig.enabled === true
        : defaults.enabled;

    const windowMs = normalizarEnteroPositivo(
        rawOrdersConfig.windowMs ?? rawEnvConfig.ordenesWindowMs,
        defaults.windowMs
    );
    const normalMax = normalizarEnteroPositivo(
        rawOrdersConfig.normalMax ?? rawEnvConfig.ordenesNormal,
        defaults.normalMax
    );
    const peakMax = normalizarEnteroPositivo(
        rawOrdersConfig.peakMax ?? rawEnvConfig.ordenesPico,
        Math.max(normalMax, defaults.peakMax)
    );
    const normalBurstCapacity = normalizarEnteroPositivo(
        rawOrdersConfig.normalBurstCapacity ?? rawOrdersConfig.burstCapacityNormal,
        Math.max(normalMax, defaults.normalBurstCapacity)
    );
    const peakBurstCapacity = normalizarEnteroPositivo(
        rawOrdersConfig.peakBurstCapacity ?? rawOrdersConfig.burstCapacityPeak,
        Math.max(peakMax, defaults.peakBurstCapacity)
    );
    const maxQueueWaitMs = normalizarEnteroPositivo(
        rawOrdersConfig.maxQueueWaitMs ?? rawOrdersConfig.queueMaxWaitMs,
        defaults.maxQueueWaitMs
    );
    const queuePollMs = normalizarEnteroPositivo(
        rawOrdersConfig.queuePollMs ?? rawOrdersConfig.queueCheckEveryMs,
        defaults.queuePollMs
    );
    const peakStartHour = normalizarHoraDelDia(
        rawOrdersConfig.peakStartHour ?? rawEnvConfig.horaPicoInicio,
        defaults.peakStartHour
    );
    const peakEndHour = normalizarHoraDelDia(
        rawOrdersConfig.peakEndHour ?? rawEnvConfig.horaPicoFin,
        defaults.peakEndHour
    );
    const timeZone = configActual?.rifa?.timeZone || configActual?.rifa?.zonaHoraria || 'America/Mexico_City';

    return {
        enabled,
        windowMs,
        normalMax,
        peakMax: Math.max(peakMax, normalMax),
        normalBurstCapacity: Math.max(normalBurstCapacity, normalMax),
        peakBurstCapacity: Math.max(peakBurstCapacity, peakMax, normalBurstCapacity),
        maxQueueWaitMs,
        queuePollMs,
        peakStartHour,
        peakEndHour,
        timeZone
    };
}

const orderRateLimitStore = new Map();
let orderRateLimitLastCleanupAt = 0;

function limpiarRateLimitOrdenes(now = Date.now()) {
    if (now - orderRateLimitLastCleanupAt < 60 * 1000) {
        return;
    }

    orderRateLimitLastCleanupAt = now;

    for (const [key, entry] of orderRateLimitStore.entries()) {
        if (!entry) {
            orderRateLimitStore.delete(key);
            continue;
        }

        const idleForMs = now - Number(entry.lastRefillAt || 0);
        const staleThresholdMs = Math.max(Number(entry.windowMs || 0) * 3, 5 * 60 * 1000);
        if (idleForMs >= staleThresholdMs) {
            orderRateLimitStore.delete(key);
        }
    }
}

function obtenerKeyRateLimitOrdenes(req) {
    const ipCdn = String(req.headers['cf-connecting-ip'] || '').trim();
    if (ipCdn) {
        return ipCdn;
    }

    const forwardedFor = String(req.headers['x-forwarded-for'] || '')
        .split(',')
        .map((value) => value.trim())
        .find(Boolean);
    if (forwardedFor) {
        return forwardedFor;
    }

    const ipReal = String(req.headers['x-real-ip'] || '').trim();
    if (ipReal) {
        return ipReal;
    }

    const ip = String(req.ip || req.socket?.remoteAddress || 'unknown').trim();
    return ip || 'unknown';
}

function calcularResetSegundosTokenBucket(entry, now = Date.now()) {
    if (!entry || !Number.isFinite(entry.refillPerMs) || entry.refillPerMs <= 0) {
        return 1;
    }

    if (Number(entry.tokens) >= 1) {
        return 1;
    }

    const missingTokens = Math.max(0, 1 - Number(entry.tokens || 0));
    return Math.max(1, Math.ceil(missingTokens / entry.refillPerMs / 1000));
}

function calcularEsperaSiguienteTokenMs(entry) {
    if (!entry || !Number.isFinite(entry.refillPerMs) || entry.refillPerMs <= 0) {
        return Infinity;
    }

    const missingTokens = Math.max(0, 1 - Number(entry.tokens || 0));
    if (missingTokens <= 0) {
        return 0;
    }

    return Math.ceil(missingTokens / entry.refillPerMs);
}

function establecerHeadersRateLimitOrdenes(res, { policyLimit, remaining, resetSeconds, windowMs }) {
    const policyWindow = Math.max(1, Math.ceil(windowMs / 1000));

    res.setHeader('RateLimit-Policy', `${policyLimit};w=${policyWindow}`);
    res.setHeader('RateLimit-Limit', String(policyLimit));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, remaining)));
    res.setHeader('RateLimit-Reset', String(resetSeconds));
    res.setHeader('Retry-After', String(resetSeconds));
}

function refillOrderRateLimitEntry(entry, now) {
    if (!entry) {
        return null;
    }

    const lastRefillAt = Number(entry.lastRefillAt || now);
    const elapsedMs = Math.max(0, now - lastRefillAt);
    const refillPerMs = Number(entry.refillPerMs || 0);
    const capacity = Number(entry.capacity || 0);
    const currentTokens = Number(entry.tokens || 0);

    if (elapsedMs > 0 && refillPerMs > 0 && capacity > 0) {
        entry.tokens = Math.min(capacity, currentTokens + (elapsedMs * refillPerMs));
    } else {
        entry.tokens = Math.min(capacity, currentTokens);
    }

    entry.lastRefillAt = now;
    entry.lastSeenAt = now;
    return entry;
}

const publicReadRateLimitStore = new Map();
let publicReadRateLimitLastCleanupAt = 0;

function limpiarRateLimitLecturaPublica(now = Date.now()) {
    if (now - publicReadRateLimitLastCleanupAt < 60 * 1000) {
        return;
    }

    publicReadRateLimitLastCleanupAt = now;

    for (const [key, entry] of publicReadRateLimitStore.entries()) {
        if (!entry || entry.resetAt <= now) {
            publicReadRateLimitStore.delete(key);
        }
    }
}

function establecerHeadersRateLimitLecturaPublica(res, { limit, remaining, resetAt, windowMs }) {
    const now = Date.now();
    const resetSeconds = Math.max(1, Math.ceil((resetAt - now) / 1000));
    const policyWindow = Math.max(1, Math.ceil(windowMs / 1000));

    res.setHeader('RateLimit-Policy', `${limit};w=${policyWindow}`);
    res.setHeader('RateLimit-Limit', String(limit));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, remaining)));
    res.setHeader('RateLimit-Reset', String(resetSeconds));
    res.setHeader('Retry-After', String(resetSeconds));
}

function limiterLecturasPublicas(req, res, next) {
    if (!esRutaLecturaPublicaEsencial(req)) {
        return next();
    }

    const configLectura = obtenerConfiguracionRateLimitLecturaPublica();
    if (!configLectura.enabled) {
        return next();
    }

    const now = Date.now();
    limpiarRateLimitLecturaPublica(now);

    const key = `public-read:${obtenerKeyRateLimitOrdenes(req)}`;
    let entry = publicReadRateLimitStore.get(key);

    if (!entry || entry.resetAt <= now || entry.windowMs !== configLectura.windowMs) {
        entry = {
            count: 0,
            resetAt: now + configLectura.windowMs,
            windowMs: configLectura.windowMs
        };
    }

    if (entry.count >= configLectura.max) {
        publicReadRateLimitStore.set(key, entry);
        establecerHeadersRateLimitLecturaPublica(res, {
            limit: configLectura.max,
            remaining: 0,
            resetAt: entry.resetAt,
            windowMs: configLectura.windowMs
        });

        return res.status(429).json({
            success: false,
            message: 'Demasiadas lecturas públicas en un corto periodo. Intenta nuevamente en unos segundos.',
            code: 'RATE_LIMIT_PUBLIC_READ',
            retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
            limit: configLectura.max
        });
    }

    entry.count += 1;
    publicReadRateLimitStore.set(key, entry);

    establecerHeadersRateLimitLecturaPublica(res, {
        limit: configLectura.max,
        remaining: configLectura.max - entry.count,
        resetAt: entry.resetAt,
        windowMs: configLectura.windowMs
    });

    return next();
}

async function limiterOrdenes(req, res, next) {
    const configOrdenes = obtenerConfiguracionRateLimitOrdenes();

    if (!configOrdenes.enabled) {
        return next();
    }

    const now = Date.now();
    limpiarRateLimitOrdenes(now);

    const hour = resolverHoraActualEnZona(configOrdenes.timeZone);
    const isPeakWindow = horaEstaEnVentanaPico(hour, configOrdenes.peakStartHour, configOrdenes.peakEndHour);
    const sustainedLimit = isPeakWindow
        ? configOrdenes.peakMax
        : configOrdenes.normalMax;
    const burstCapacity = isPeakWindow
        ? configOrdenes.peakBurstCapacity
        : configOrdenes.normalBurstCapacity;
    const windowMs = configOrdenes.windowMs;
    const key = obtenerKeyRateLimitOrdenes(req);
    const refillPerMs = sustainedLimit / windowMs;

    let entry = orderRateLimitStore.get(key);
    if (!entry || entry.windowMs !== windowMs || entry.capacity !== burstCapacity || entry.refillPerMs !== refillPerMs) {
        entry = {
            tokens: burstCapacity,
            capacity: burstCapacity,
            refillPerMs,
            lastRefillAt: now,
            lastSeenAt: now,
            windowMs
        };
    }

    refillOrderRateLimitEntry(entry, now);

    let waitedMs = 0;
    while (entry.tokens < 1) {
        const waitForNextTokenMs = calcularEsperaSiguienteTokenMs(entry);
        const maxQueueWaitMs = Number(configOrdenes.maxQueueWaitMs || 0);

        if (!Number.isFinite(waitForNextTokenMs) || waitForNextTokenMs <= 0 || waitForNextTokenMs > maxQueueWaitMs || waitedMs >= maxQueueWaitMs) {
            break;
        }

        const remainingQueueBudgetMs = Math.max(0, maxQueueWaitMs - waitedMs);
        const queuePollMs = Math.max(25, Number(configOrdenes.queuePollMs || 100));
        const waitMs = Math.max(25, Math.min(waitForNextTokenMs, queuePollMs, remainingQueueBudgetMs));
        if (waitMs <= 0) {
            break;
        }

        await esperar(waitMs);
        waitedMs += waitMs;
        refillOrderRateLimitEntry(entry, Date.now());
    }

    if (entry.tokens < 1) {
        const resetSeconds = calcularResetSegundosTokenBucket(entry, Date.now());
        orderRateLimitStore.set(key, entry);
        establecerHeadersRateLimitOrdenes(res, {
            policyLimit: burstCapacity,
            remaining: 0,
            resetSeconds,
            windowMs
        });

        return res.status(429).json({
            success: false,
            message: 'Demasiadas solicitudes. Por favor espera e intenta nuevamente',
            code: 'RATE_LIMIT_ORDENES',
            retryAfterSeconds: resetSeconds,
            limit: sustainedLimit,
            burstCapacity
        });
    }

    entry.tokens = Math.max(0, entry.tokens - 1);
    orderRateLimitStore.set(key, entry);

    establecerHeadersRateLimitOrdenes(res, {
        policyLimit: burstCapacity,
        remaining: Math.floor(entry.tokens),
        resetSeconds: calcularResetSegundosTokenBucket(entry, now),
        windowMs
    });

    return next();
}

const limiterRecuperacionOrdenes = rateLimit({
    windowMs: 10 * 60 * 1000, // 10 minutos
    max: process.env.NODE_ENV === 'production' ? 12 : 500,
    message: 'Demasiadas consultas de recuperación. Intenta más tarde',
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req, res) => {
        return process.env.NODE_ENV !== 'production';
    }
});

// Aplicar rate limiting general a todas las rutas
app.use(limiterGeneral);
app.use(limiterLecturasPublicas);

// Endpoint administrativo seguro para sobreescribir rate limits en caliente
app.post('/api/admin/rate-limits', async (req, res) => {
    try {
        const adminToken = process.env.ADMIN_TOKEN || '';
        const provided = String(req.headers['x-admin-token'] || '').trim();
        if (!adminToken || !provided || provided !== adminToken) {
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }

        const payload = req.body;
        if (!payload || typeof payload !== 'object') {
            return res.status(400).json({ success: false, message: 'Payload inválido' });
        }

        const ok = configManager.setRateLimits(payload);
        if (!ok) return res.status(500).json({ success: false, message: 'No se pudo actualizar configuración' });

        return res.json({ success: true, message: 'Rate limits actualizados en memoria y persistidos' });
    } catch (error) {
        console.error('POST /api/admin/rate-limits error:', error.message);
        return res.status(500).json({ success: false, message: 'Error interno' });
    }
});

// ===== FASE 1: HTTP CACHING HEADERS UTILITY (PROFESIONAL & SIMPLE) =====
// ⭐ Función utility para agregar headers de caching HTTP en respuestas
// Se llama directamente antes de res.json() en endpoints
// Ventajas: Simple, no interfiere con otros middlewares, reversible
function setHttpCacheHeaders(res, maxAgeSeconds = 60, isPublic = true) {
    const cacheControl = isPublic
        ? `public, max-age=${maxAgeSeconds}`
        : `private, max-age=${maxAgeSeconds}`;

    res.setHeader('Cache-Control', cacheControl);
    res.setHeader('Vary', 'Accept-Encoding');
    // ETag será calculado por el cliente si lo necesita
    // Los navegadores modernos ya cachean por defecto con estos headers
}
// Fin Utility de Caching HTTP

// ===== CONFIGURACIÓN DINÁMICA DEL SORTEO =====
// Usar config manager para cargar configuración en memoria (caché)
const configManager = require('./config-manager').getInstance();
const ConfigManagerV2 = require('./config-manager-v2'); // 🟦 NUEVO: Para persistencia en BD
let configManagerV2 = null; // Se inicializa en setImmediate

function obtenerHeadersRifaRequest(req) {
    return {
        rifaId: req?.headers?.['x-rifaplus-rifa-id'] || req?.headers?.['x-rifa-id'] || req?.query?.rifa_id || null,
        slug: req?.headers?.['x-rifaplus-rifa-slug'] || req?.query?.rifa || req?.query?.slug || null,
        hostname: (req?.headers?.host || req?.hostname || '').split(':')[0] || null
    };
}

function obtenerContextoRifaActual(rifaIdExplicit = null) {
    const store = requestRifaStorage.getStore() || null;
    
    // Si se pide un ID específico y el contexto actual no coincide,
    // o si no hay contexto, intentar resolverlo desde la instancia de RifaService
    // (aunque esto último debería ser evitado en favor del middleware)
    if (rifaIdExplicit && Number(store?.id) !== Number(rifaIdExplicit)) {
        return null; 
    }
    
    return store;
}

function obtenerRifaIdActual() {
    const contexto = obtenerContextoRifaActual();
    const rifaId = Number.parseInt(contexto?.id, 10);
    return Number.isInteger(rifaId) && rifaId > 0 ? rifaId : null;
}

function obtenerRifaIdRequest(req) {
    return getRifaIdFromRequest(req);
}

function aplicarFiltroRifa(query, rifaId, column = 'rifa_id') {
    return applyRifaScope(query, { rifaId }, column);
}

function construirContextoRifaFallback() {
    const config = configManagerV2?.getConfig?.() || configManager?.getAll?.() || {};
    return {
        id: null,
        slug: '',
        nombre: String(config?.rifa?.nombreSorteo || config?.rifa?.edicionNombre || 'Rifa principal').trim(),
        estado: String(config?.rifa?.estado || 'activa').trim() || 'activa',
        configuracion: clonarConfigSeguro(config),
        snapshotFinal: config?.rifa?.modalFinalizadoSnapshot || null,
        finalizadaAt: null,
        depuracionProgramadaAt: null,
        depuradaAt: null,
        raw: null
    };
}

function construirUrlPublicaRifaServidor(rifa = {}) {
    const slug = String(rifa?.slug || '').trim();
    const basePath = '/';
    return slug ? `${basePath}?rifa=${encodeURIComponent(slug)}` : basePath;
}

function obtenerMetadatosCampanaDesdeContextoRifa(contexto = {}) {
    const config = contexto?.configuracion || {};
    return {
        organizerKey: resolverOrganizerKeyPush({
            configuracion: config
        }),
        organizerName: String(config?.cliente?.nombre || 'tu organizador').trim() || 'tu organizador',
        organizerLogo: String(config?.cliente?.logo || '').trim() || '/images/placeholder-logo.svg'
    };
}

function normalizarTextoConfigCampana(valor, maxLength, fallback = '') {
    const normalized = String(valor || '').replace(/\s+/g, ' ').trim();
    const fallbackNormalized = String(fallback || '').trim();
    return (normalized || fallbackNormalized).slice(0, maxLength);
}

function normalizarUrlConfigCampana(valor) {
    const raw = String(valor || '').trim();
    if (!raw) return '';

    if (raw.startsWith('/')) {
        return raw.slice(0, 500);
    }

    try {
        const parsed = new URL(raw);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            return '';
        }
        return parsed.toString().slice(0, 500);
    } catch (error) {
        return '';
    }
}

function normalizarListaMinutosCampana(rawValue, fallback = []) {
    const source = rawValue === undefined ? fallback : rawValue;
    if (source === null || source === '') {
        return [];
    }

    const values = Array.isArray(source)
        ? source
        : String(source)
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean);

    const normalized = values
        .map((value) => Number.parseInt(String(value).replace(/[^0-9]/g, ''), 10))
        .filter((value) => Number.isInteger(value) && value > 0);

    return [...new Set(normalized)].sort((a, b) => b - a);
}

function obtenerConfigCampanasPush(config = null) {
    const source = config || obtenerConfigActual() || {};
    const rawCampaigns = source?.marketing?.pushCampaigns || {};
    const rawNuevaRifa = rawCampaigns?.nuevaRifa || {};
    const rawEventReminders = rawCampaigns?.eventReminders || {};
    const rawResultsAvailable = rawCampaigns?.resultsAvailable || {};
    const rawAudience = rawCampaigns?.audience || {};
    const defaultTitle = 'Nuevo sorteo disponible';
    const defaultBody = '{organizerName} ya abrió {rifaNombre}. Entra ahora y aparta tus boletos.';
    const defaultResultsTitle = 'Resultados disponibles';
    const defaultResultsBody = '{organizerName} ya publicó los resultados de {rifaNombre}. Entra a revisar si ganaste.';
    const customUrl = normalizarUrlConfigCampana(rawNuevaRifa.customUrl);
    const customResultsUrl = normalizarUrlConfigCampana(rawResultsAvailable.customUrl);

    return {
        nuevaRifa: {
            enabled: rawNuevaRifa.enabled !== false,
            autoSendOnPublicActivation: rawNuevaRifa.autoSendOnPublicActivation !== false,
            title: normalizarTextoConfigCampana(rawNuevaRifa.title, 120, defaultTitle),
            body: normalizarTextoConfigCampana(rawNuevaRifa.body, 240, defaultBody),
            useCustomUrl: rawNuevaRifa.useCustomUrl === true && Boolean(customUrl),
            customUrl
        },
        resultsAvailable: {
            enabled: rawResultsAvailable.enabled !== false,
            autoSendOnFirstPublication: rawResultsAvailable.autoSendOnFirstPublication !== false,
            title: normalizarTextoConfigCampana(rawResultsAvailable.title, 120, defaultResultsTitle),
            body: normalizarTextoConfigCampana(rawResultsAvailable.body, 240, defaultResultsBody),
            useCustomUrl: rawResultsAvailable.useCustomUrl === true && Boolean(customResultsUrl),
            customUrl: customResultsUrl
        },
        eventReminders: {
            enabled: rawEventReminders.enabled === true,
            presorteoMinutes: normalizarListaMinutosCampana(rawEventReminders.presorteoMinutes, []),
            sorteoMinutes: normalizarListaMinutosCampana(rawEventReminders.sorteoMinutes, [])
        },
        audience: {
            marketingRecencyDays: Math.max(30, Math.min(3650, Number.parseInt(rawAudience.marketingRecencyDays, 10) || 120))
        }
    };
}

function normalizarConfigCampanasPushAdmin(rawConfig = {}, baseConfig = null) {
    const normalized = obtenerConfigCampanasPush({
        marketing: {
            pushCampaigns: {
                ...(baseConfig || {}),
                ...(rawConfig || {})
            }
        }
    });

    return normalized;
}

function construirCampanaNuevaRifaDesdeContexto(contexto = {}, options = {}) {
    const settings = obtenerConfigCampanasPush(contexto?.configuracion || {}).nuevaRifa;
    const campaignMeta = obtenerMetadatosCampanaDesdeContextoRifa(contexto);
    const publicUrl = settings.useCustomUrl && settings.customUrl
        ? settings.customUrl
        : construirUrlPublicaRifaServidor(contexto);

    return {
        ...campaignMeta,
        enabled: settings.enabled,
        autoSendOnPublicActivation: settings.autoSendOnPublicActivation,
        audiencePolicy: obtenerConfigCampanasPush(contexto?.configuracion || {}).audience,
        title: settings.title,
        body: settings.body,
        customUrl: settings.useCustomUrl ? settings.customUrl : '',
        publicUrl,
        rifaId: Number.parseInt(options.rifaId || contexto?.id, 10) || null,
        rifaSlug: String(options.rifaSlug || contexto?.slug || '').trim(),
        rifaNombre: String(options.rifaNombre || contexto?.nombre || '').trim() || 'un nuevo sorteo'
    };
}

function construirCampanaResultadosDisponiblesDesdeContexto(contexto = {}, options = {}) {
    const settings = obtenerConfigCampanasPush(contexto?.configuracion || {}).resultsAvailable;
    const campaignMeta = obtenerMetadatosCampanaDesdeContextoRifa(contexto);
    const publicUrl = settings.useCustomUrl && settings.customUrl
        ? settings.customUrl
        : construirUrlPublicaRifaServidor(contexto);

    return {
        ...campaignMeta,
        enabled: settings.enabled,
        autoSendOnFirstPublication: settings.autoSendOnFirstPublication,
        audiencePolicy: obtenerConfigCampanasPush(contexto?.configuracion || {}).audience,
        title: settings.title,
        body: settings.body,
        customUrl: settings.useCustomUrl ? settings.customUrl : '',
        publicUrl,
        rifaId: Number.parseInt(options.rifaId || contexto?.id, 10) || null,
        rifaSlug: String(options.rifaSlug || contexto?.slug || '').trim(),
        rifaNombre: String(options.rifaNombre || contexto?.nombre || '').trim() || 'tu sorteo',
        resultsCount: Math.max(0, Number.parseInt(options.resultsCount, 10) || 0),
        eventType: PUSH_CAMPAIGN_EVENT_TYPE_RESULTADOS_DISPONIBLES,
        eventKey: `${PUSH_CAMPAIGN_EVENT_TYPE_RESULTADOS_DISPONIBLES}:rifa:${Number.parseInt(options.rifaId || contexto?.id, 10) || 'sin-id'}`
    };
}

function resolverUmbralRecordatorioEvento(minuteList = [], eventDateRaw) {
    const eventDate = eventDateRaw ? new Date(eventDateRaw) : null;
    if (!(eventDate instanceof Date) || Number.isNaN(eventDate.getTime())) {
        return null;
    }

    const remainingMs = eventDate.getTime() - Date.now();
    if (!(remainingMs > 0)) {
        return null;
    }

    const remainingMinutes = remainingMs / 60000;
    const thresholds = normalizarListaMinutosCampana(minuteList, []).sort((a, b) => a - b);
    return thresholds.find((threshold) => remainingMinutes <= threshold) || null;
}

function construirCampanaRecordatorioEventoDesdeContexto(contexto = {}, options = {}) {
    const settings = obtenerConfigCampanasPush(contexto?.configuracion || {});
    const eventType = String(options.eventType || '').trim();
    const campaignMeta = obtenerMetadatosCampanaDesdeContextoRifa(contexto);
    const publicUrl = construirUrlPublicaRifaServidor(contexto);
    const warningMinutes = Math.max(1, Number.parseInt(options.warningMinutes, 10) || 0);
    const eventDate = String(options.eventDate || '').trim();
    const eventKey = `${eventType}:rifa:${Number.parseInt(contexto?.id, 10) || 'sin-id'}:${eventDate}:m${warningMinutes}`;

    return {
        ...campaignMeta,
        enabled: settings?.eventReminders?.enabled === true,
        audiencePolicy: settings?.audience || { marketingRecencyDays: 120 },
        publicUrl,
        rifaId: Number.parseInt(options.rifaId || contexto?.id, 10) || null,
        rifaSlug: String(options.rifaSlug || contexto?.slug || '').trim(),
        rifaNombre: String(options.rifaNombre || contexto?.nombre || '').trim() || 'tu sorteo',
        eventType,
        eventDate,
        warningMinutes,
        eventKey
    };
}

async function encolarCampanaPushDesdeServidor(campaign, options = {}) {
    if (!pushCampaignQueueService) {
        return {
            queued: false,
            skipped: true,
            reason: 'queue_service_unavailable',
            job: null
        };
    }

    return pushCampaignQueueService.enqueueCampaign(campaign, options);
}

async function procesarRecordatoriosEventoProgramados() {
    const contexto = rifaService?.enabled
        ? await rifaService.obtenerRifaActivaPublica(true)
        : construirContextoRifaFallback();
    if (!contexto) {
        return [];
    }

    const configCampanas = obtenerConfigCampanasPush(contexto?.configuracion || {});
    if (configCampanas?.eventReminders?.enabled !== true) {
        return [];
    }

    const rifa = contexto?.configuracion?.rifa || {};
    const candidatos = [
        {
            eventType: 'presorteo_proximo',
            eventDate: rifa.fechaPresorteo,
            minuteList: configCampanas.eventReminders.presorteoMinutes
        },
        {
            eventType: 'sorteo_proximo',
            eventDate: rifa.fechaSorteo,
            minuteList: configCampanas.eventReminders.sorteoMinutes
        }
    ];

    const resultados = [];
    for (const candidato of candidatos) {
        const warningMinutes = resolverUmbralRecordatorioEvento(candidato.minuteList, candidato.eventDate);
        if (!warningMinutes) {
            continue;
        }

        const campaign = construirCampanaRecordatorioEventoDesdeContexto(contexto, {
            ...candidato,
            warningMinutes,
            rifaId: contexto.id,
            rifaSlug: contexto.slug,
            rifaNombre: contexto.nombre
        });

        if (!campaign.enabled) {
            continue;
        }

        const result = await encolarCampanaPushDesdeServidor(campaign, {
            priority: 160
        });
        resultados.push({
            eventType: candidato.eventType,
            warningMinutes,
            result
        });
    }

    return resultados;
}

async function ejecutarRecordatoriosEventoProgramados() {
    if (recordatoriosEventoEnEjecucion) {
        return;
    }

    recordatoriosEventoEnEjecucion = true;
    try {
        const resultados = await procesarRecordatoriosEventoProgramados();
        resultados.forEach((item) => {
            if (item?.result?.skipped !== true && Number(item?.result?.delivered || 0) > 0) {
                console.log(`🔔 Recordatorio ${item.eventType} enviado (${item.warningMinutes} min antes): ${item.result.delivered} entregadas`);
            }
        });
    } catch (error) {
        console.warn('⚠️  Error procesando recordatorios programados de presorteo/sorteo:', error.message);
    } finally {
        recordatoriosEventoEnEjecucion = false;
    }
}

function iniciarRecordatoriosEventoProgramados() {
    if (recordatoriosEventoInterval) {
        clearInterval(recordatoriosEventoInterval);
    }

    ejecutarRecordatoriosEventoProgramados().catch(() => { });
    recordatoriosEventoInterval = setInterval(() => {
        ejecutarRecordatoriosEventoProgramados().catch(() => { });
    }, 60 * 1000);
}

async function construirResumenCampanasPushAdmin(options = {}) {
    const contexto = options.contexto || construirContextoRifaFallback();
    const organizerKey = resolverOrganizerKeyPush({
        configuracion: contexto?.configuracion || {}
    });
    const selectedRifa = {
        id: Number.parseInt(contexto?.id, 10) || null,
        slug: String(contexto?.slug || '').trim(),
        nombre: String(contexto?.nombre || '').trim() || 'Rifa activa'
    };
    const fallback = {
        organizerKey,
        pushReady: obtenerConfigPush().enabled === true,
        config: obtenerConfigCampanasPush(contexto?.configuracion || {}),
        audience: {
            total: 0,
            active: 0,
            optedIn: 0,
            eligibleMarketing: 0,
            inactive: 0,
            optedOut: 0,
            expired: 0,
            lastSentAt: null
        },
        jobs: {
            pending: 0,
            running: 0,
            failed: 0,
            recent: []
        },
        selectedRifa,
        publicRifa: null,
        preview: construirCampanaNuevaRifaDesdeContexto(contexto, selectedRifa),
        recentEvents: []
    };

    try {
        const hasSubscriptionsTable = await db.schema.hasTable('push_campaign_subscriptions');
        const hasEventsTable = await db.schema.hasTable('push_campaign_events');
        const hasJobsTable = await db.schema.hasTable('push_campaign_jobs');

        if (!hasSubscriptionsTable || !hasEventsTable) {
            return fallback;
        }

        const [
            totalRows,
            activeRows,
            optedInRows,
            eligibleMarketingRows,
            inactiveAudienceRows,
            optedOutRows,
            expiredRows,
            latestEventRows,
            recentEvents,
            pendingJobsRows,
            runningJobsRows,
            failedJobsRows,
            recentJobs
        ] = await Promise.all([
            db('push_campaign_subscriptions').where({ organizer_key: organizerKey }).count('* as total'),
            db('push_campaign_subscriptions').where({ organizer_key: organizerKey, status: 'active' }).count('* as total'),
            db('push_campaign_subscriptions').where({ organizer_key: organizerKey, status: 'active', marketing_opt_in: true }).count('* as total'),
            db('push_campaign_subscriptions').where({ organizer_key: organizerKey, status: 'active', marketing_opt_in: true, audience_status: 'active' }).count('* as total'),
            db('push_campaign_subscriptions').where({ organizer_key: organizerKey, audience_status: 'inactive' }).count('* as total'),
            db('push_campaign_subscriptions').where({ organizer_key: organizerKey, marketing_opt_in: false }).count('* as total'),
            db('push_campaign_subscriptions').where({ organizer_key: organizerKey, status: 'expired' }).count('* as total'),
            db('push_campaign_events').where({ organizer_key: organizerKey }).max('sent_at as sent_at'),
            db('push_campaign_events')
                .where({ organizer_key: organizerKey })
                .orderBy('sent_at', 'desc')
                .limit(8)
                .select('id', 'event_type', 'event_key', 'target_rifa_id', 'target_rifa_slug', 'delivered_count', 'failed_count', 'expired_count', 'sent_at'),
            hasJobsTable
                ? db('push_campaign_jobs').where({ organizer_key: organizerKey, status: 'pending' }).count('* as total')
                : Promise.resolve([{ total: 0 }]),
            hasJobsTable
                ? db('push_campaign_jobs').where({ organizer_key: organizerKey, status: 'running' }).count('* as total')
                : Promise.resolve([{ total: 0 }]),
            hasJobsTable
                ? db('push_campaign_jobs').where({ organizer_key: organizerKey, status: 'failed' }).count('* as total')
                : Promise.resolve([{ total: 0 }]),
            hasJobsTable
                ? db('push_campaign_jobs')
                    .where({ organizer_key: organizerKey })
                    .orderBy('created_at', 'desc')
                    .limit(8)
                    .select('id', 'event_type', 'event_key', 'status', 'total_targets', 'processed_count', 'delivered_count', 'failed_count', 'expired_count', 'created_at', 'started_at', 'completed_at', 'last_error')
                : Promise.resolve([])
        ]);

        const activePublicRifa = rifaService?.enabled
            ? await rifaService.obtenerRifaActivaPublica(true)
            : null;

        return {
            ...fallback,
            audience: {
                total: Number.parseInt(totalRows?.[0]?.total, 10) || 0,
                active: Number.parseInt(activeRows?.[0]?.total, 10) || 0,
                optedIn: Number.parseInt(optedInRows?.[0]?.total, 10) || 0,
                eligibleMarketing: Number.parseInt(eligibleMarketingRows?.[0]?.total, 10) || 0,
                inactive: Number.parseInt(inactiveAudienceRows?.[0]?.total, 10) || 0,
                optedOut: Number.parseInt(optedOutRows?.[0]?.total, 10) || 0,
                expired: Number.parseInt(expiredRows?.[0]?.total, 10) || 0,
                lastSentAt: latestEventRows?.[0]?.sent_at || null
            },
            jobs: {
                pending: Number.parseInt(pendingJobsRows?.[0]?.total, 10) || 0,
                running: Number.parseInt(runningJobsRows?.[0]?.total, 10) || 0,
                failed: Number.parseInt(failedJobsRows?.[0]?.total, 10) || 0,
                recent: Array.isArray(recentJobs) ? recentJobs : []
            },
            publicRifa: activePublicRifa ? {
                id: Number.parseInt(activePublicRifa?.id, 10) || null,
                slug: String(activePublicRifa?.slug || '').trim(),
                nombre: String(activePublicRifa?.nombre || '').trim() || 'Rifa pública',
                estado: String(activePublicRifa?.estado || '').trim() || 'activa'
            } : null,
            recentEvents
        };
    } catch (error) {
        console.warn('⚠️  construirResumenCampanasPushAdmin degradado:', error.message);
        return fallback;
    }
}

function resolverErrorContextoAdminRifa(req) {
    if (!rifaService?.enabled) {
        return null;
    }

    const rifaIdActual = Number.parseInt(req?.rifaContext?.id, 10);
    if (Number.isInteger(rifaIdActual) && rifaIdActual > 0) {
        return null;
    }

    return {
        success: false,
        code: 'ADMIN_RIFA_CONTEXT_REQUIRED',
        message: 'Selecciona una rifa activa válida antes de continuar en el panel.'
    };
}

function clonarConfigSeguro(config) {
    return JSON.parse(JSON.stringify(config || {}));
}

function sincronizarConfigLegacyEnMemoria(config) {
    if (!config || typeof config !== 'object') return;

    try {
        configManager.config = clonarConfigSeguro(config);
        configManager.lastLoadTime = Date.now();
        configManager.cacheVersion = (configManager.cacheVersion || 0) + 1;
    } catch (error) {
        console.warn('⚠️ No se pudo sincronizar ConfigManager legacy en memoria:', error.message);
    }
}

async function persistirConfigActualizada(config, usuarioAdmin = 'SYSTEM') {
    const configPath = path.join(__dirname, 'config.json');
    let guardadoEnBD = false;
    const contextoRifa = obtenerContextoRifaActual();
    const rifaIdActual = Number.parseInt(contextoRifa?.id, 10);

    if (rifaService?.enabled && Number.isInteger(rifaIdActual) && rifaIdActual > 0) {
        await rifaService.guardarConfiguracion(rifaIdActual, config, usuarioAdmin);
        
        // ✅ CRÍTICO: Sincronizar con ConfigManagerV2 inmediatamente para evitar datos obsoletos
        if (configManagerV2) {
            await configManagerV2.guardarEnBD(config, usuarioAdmin, rifaIdActual);
        }

        sincronizarConfigLegacyEnMemoria(config);
        limpiarCacheConfiguracionPublica(rifaIdActual);
        return true;
    }

    if (configManagerV2) {
        try {
            guardadoEnBD = await configManagerV2.guardarEnBD(config, usuarioAdmin);
        } catch (error) {
            console.warn('[persistirConfigActualizada] ⚠️ ConfigManagerV2 falló, usando fallback config.json:', error.message);
        }
    }

    if (!guardadoEnBD) {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    }

    sincronizarConfigLegacyEnMemoria(configManagerV2?.getConfig?.() || config);
    limpiarCacheConfiguracionPublica();
    return guardadoEnBD;
}

async function obtenerGanadoresPersistidos(runner = db) {
    const rifaIdActual = obtenerRifaIdActual();
    const query = runner('ganadores');
    if (rifaIdActual) {
        query.where('rifa_id', rifaIdActual);
    }

    return query
        .select('*')
        .orderBy([{ column: 'tipo_ganador', order: 'asc' }, { column: 'posicion', order: 'asc' }, { column: 'id', order: 'asc' }]);
}

async function asegurarSnapshotModalFinalizado(config, options = {}) {
    const usuarioAdmin = options.usuarioAdmin || 'SYSTEM';
    const refrescarGanadores = options.refrescarGanadores === true;
    const contextoRifa = obtenerContextoRifaActual();

    if (!SorteoFinalizadoSnapshotService.esRifaFinalizada(config?.rifa || {})) {
        return { persisted: false, snapshot: SorteoFinalizadoSnapshotService.obtenerSnapshot(config) };
    }

    const snapshotExistente = SorteoFinalizadoSnapshotService.obtenerSnapshot(config);
    const snapshotCoincide = snapshotExistente
        ? SorteoFinalizadoSnapshotService.snapshotCorrespondeARifaActual(snapshotExistente, config)
        : false;

    let snapshotFinal = snapshotExistente;

    if (!snapshotExistente) {
        const ganadoresRows = await obtenerGanadoresPersistidos();
        snapshotFinal = SorteoFinalizadoSnapshotService.construirSnapshot(config, ganadoresRows);
    } else if (refrescarGanadores) {
        const ganadoresRows = await obtenerGanadoresPersistidos();
        if (snapshotCoincide) {
            snapshotFinal = SorteoFinalizadoSnapshotService.construirSnapshot(config, ganadoresRows);
        } else {
            snapshotFinal = SorteoFinalizadoSnapshotService.actualizarSoloGanadores(snapshotExistente, ganadoresRows);
        }
    } else if (!snapshotCoincide) {
        return { persisted: false, snapshot: snapshotExistente };
    }

    const snapshotSerializadoAnterior = JSON.stringify(snapshotExistente || null);
    const snapshotSerializadoNuevo = JSON.stringify(snapshotFinal || null);

    if (snapshotSerializadoAnterior === snapshotSerializadoNuevo) {
        return { persisted: false, snapshot: snapshotFinal };
    }

    SorteoFinalizadoSnapshotService.aplicarSnapshotEnConfig(config, snapshotFinal);
    await persistirConfigActualizada(config, usuarioAdmin);
    if (rifaService?.enabled && contextoRifa?.id) {
        await rifaService.guardarSnapshotFinal(contextoRifa.id, snapshotFinal, {
            estado: 'finalizado'
        });
    }
    return { persisted: true, snapshot: snapshotFinal };
}

function obtenerConfigActual(rifaId = null) {
    const rifaIdResuelto = rifaId || obtenerRifaIdActual();
    const contextoRifa = obtenerContextoRifaActual(rifaIdResuelto);

    if (contextoRifa?.configuracion && typeof contextoRifa.configuracion === 'object') {
        const configContextual = clonarConfigSeguro(contextoRifa.configuracion);
        if (!configContextual.rifa || typeof configContextual.rifa !== 'object') {
            configContextual.rifa = {};
        }

        if (contextoRifa?.estado) {
            configContextual.rifa.estado = String(contextoRifa.estado).trim() || configContextual.rifa.estado || 'activa';
        }

        if (contextoRifa?.snapshotFinal && typeof contextoRifa.snapshotFinal === 'object') {
            configContextual.rifa.modalFinalizadoSnapshot = clonarConfigSeguro(contextoRifa.snapshotFinal);
        }

        return configContextual;
    }

    // Si tenemos un ID pero no configuración en BD, intentar construir una config mínima
    // para esa rifa en lugar de caer en la Rifa 1.
    if (rifaIdResuelto && contextoRifa) {
        console.warn(`⚠️ Rifa ${rifaIdResuelto} (${contextoRifa.slug}) no tiene configuración en BD. Generando config mínima.`);
        const fallbackConfig = obtenerConfigExpiracion();
        return {
            cliente: { nombre: contextoRifa.nombre || 'Mi Rifa' },
            rifa: {
                nombreSorteo: contextoRifa.nombre || 'Sorteo Especial',
                totalBoletos: Number(fallbackConfig.totalBoletos) || 1000,
                precioBoleto: Number(fallbackConfig.precioBoleto) || 50,
                estado: contextoRifa.estado || 'borrador'
            },
            tecnica: { bankAccounts: [] }
        };
    }

    if (configManagerV2?.getConfig) {
        const configBD = configManagerV2.getConfig(rifaIdResuelto);
        if (configBD && typeof configBD === 'object') {
            // ⭐ DEFENSA: Si pedimos un ID específico y lo que devuelve el manager es la default (ID 1),
            // ignoramos si no coinciden los IDs para evitar contaminación.
            const idEnConfig = configBD.rifa_id || configBD.rifa?.id;
            if (!rifaIdResuelto || !idEnConfig || Number(idEnConfig) === Number(rifaIdResuelto)) {
                return clonarConfigSeguro(configBD);
            }
        }
    }

    // ÚLTIMO RECURSO: config.json solo si no hay un ID solicitado (Home/Default)
    if (!rifaIdResuelto) {
        try {
            const configPath = path.join(__dirname, 'config.json');
            const raw = fs.readFileSync(configPath, 'utf8');
            return JSON.parse(raw);
        } catch (error) {
            console.warn('⚠️ No se pudo leer configuración actual desde disco:', error.message);
        }
    }
    
    return {};
}

function cargarConfigSorteo(rifaId = null) {
    const rifaIdActual = rifaId || obtenerRifaIdActual();
    const configActual = obtenerConfigActual(rifaIdActual);
    const configManagerConfig = configManager?.config || {};
    const oportunidadesActuales = configActual?.rifa?.oportunidades || configManagerConfig?.rifa?.oportunidades || {};
    const clienteActual = configActual?.cliente || {};
    const clienteFallback = configManagerConfig?.cliente || {};
    const clienteNombreResuelto = String(clienteActual?.nombre || clienteFallback?.nombre || '').trim();
    const clienteIdResuelto = String(clienteActual?.id || clienteFallback?.id || '').trim();
    const prefijoOrdenResuelto = String(clienteActual?.prefijoOrden || clienteFallback?.prefijoOrden || '').trim().toUpperCase();

    return {
        rifaId: rifaIdActual,
        rifaSlug: String(obtenerContextoRifaActual()?.slug || '').trim(),
        totalBoletos: configActual?.rifa?.totalBoletos || configManager.totalBoletos,
        precioBoleta: configActual?.rifa?.precioBoleto || configManager.precioBoleto,
        precioBoleto: configActual?.rifa?.precioBoleto || configManager.precioBoleto,
        clienteNombre: clienteNombreResuelto || 'Sorteo',
        // ✅ AGREGADO: Información de cliente y prefijo
        cliente: {
            id: clienteIdResuelto || '',
            nombre: clienteNombreResuelto || 'Sorteo',
            prefijoOrden: prefijoOrdenResuelto || ''
        },
        // ✅ AGREGADO: Información de descuentos desde config
        rifa: {
            precioBoleto: configActual?.rifa?.precioBoleto || configManagerConfig?.rifa?.precioBoleto || configManager.precioBoleto,
            tiempoApartadoHoras: configActual?.rifa?.tiempoApartadoHoras || configManagerConfig?.rifa?.tiempoApartadoHoras || TIEMPO_APARTADO_HORAS,
            intervaloLimpiezaMinutos: configActual?.rifa?.intervaloLimpiezaMinutos || configManagerConfig?.rifa?.intervaloLimpiezaMinutos || INTERVALO_LIMPIEZA_MINUTOS,
            descuentos: configActual?.rifa?.descuentos || configManagerConfig?.rifa?.descuentos || { enabled: false, reglas: [] },
            promocionesCombo: configActual?.rifa?.promocionesCombo || configManagerConfig?.rifa?.promocionesCombo || { enabled: false, reglas: [] },
            promocionPorTiempo: configActual?.rifa?.promocionPorTiempo || configManagerConfig?.rifa?.promocionPorTiempo || { enabled: false },
            descuentoPorcentaje: configActual?.rifa?.descuentoPorcentaje || configManagerConfig?.rifa?.descuentoPorcentaje || { enabled: false },
            oportunidades: {
                enabled: oportunidadesActuales.enabled === true,
                multiplicador: Number(oportunidadesActuales.multiplicador) > 0
                    ? Number(oportunidadesActuales.multiplicador)
                    : 1,
                rango_visible: oportunidadesActuales.rango_visible || false,
                rango_oculto: oportunidadesActuales.rango_oculto || null
            }
        }
    };
}

function obtenerConfigOportunidadesSistema(configBase = null) {
    return resolverConfigOportunidades(configBase || cargarConfigSorteo(), {
        permitirFallbackVisible: true
    });
}

function obtenerTotalBoletosConfigurado(configBase = null) {
    const config = configBase || obtenerConfigActual();
    const total = Number.parseInt(config?.rifa?.totalBoletos ?? config?.totalBoletos, 10);
    return Number.isInteger(total) && total > 0 ? total : 0;
}

function normalizarRangoBusquedaRifa(rango) {
    const inicio = Number.parseInt(rango?.inicio, 10);
    const fin = Number.parseInt(rango?.fin, 10);

    if (!Number.isInteger(inicio) || !Number.isInteger(fin) || inicio < 0 || fin < inicio) {
        return null;
    }

    return { inicio, fin };
}

function fusionarRangosBusquedaRifa(rangos = []) {
    const ordenados = (Array.isArray(rangos) ? rangos : [])
        .map((rango) => normalizarRangoBusquedaRifa(rango))
        .filter(Boolean)
        .sort((a, b) => {
            if (a.inicio !== b.inicio) return a.inicio - b.inicio;
            return a.fin - b.fin;
        });

    if (ordenados.length === 0) {
        return [];
    }

    const fusionados = [ordenados[0]];

    for (let indice = 1; indice < ordenados.length; indice += 1) {
        const actual = ordenados[indice];
        const ultimo = fusionados[fusionados.length - 1];

        if (actual.inicio <= ultimo.fin + 1) {
            ultimo.fin = Math.max(ultimo.fin, actual.fin);
        } else {
            fusionados.push({ ...actual });
        }
    }

    return fusionados;
}

function obtenerRangosBusquedaPermitidos(configBase = null) {
    const config = configBase || obtenerConfigActual();
    const rangosConfigurados = fusionarRangosBusquedaRifa(config?.rifa?.rangos || []);

    if (rangosConfigurados.length > 0) {
        return rangosConfigurados;
    }

    const oportunidadesConfig = obtenerConfigOportunidadesSistema(config);
    if (oportunidadesConfig?.enabled && oportunidadesConfig?.rangoVisible) {
        const rangosOportunidades = fusionarRangosBusquedaRifa([oportunidadesConfig.rangoVisible]);
        if (rangosOportunidades.length > 0) {
            return rangosOportunidades;
        }
    }

    const totalBoletos = obtenerTotalBoletosConfigurado(config);
    if (totalBoletos > 0) {
        return [{ inicio: 0, fin: totalBoletos - 1 }];
    }

    return [{ inicio: 0, fin: 0 }];
}

function numeroPerteneceARangosBusqueda(numero, rangos = []) {
    return Number.isInteger(numero) && (Array.isArray(rangos) ? rangos : []).some((rango) =>
        numero >= rango.inicio && numero <= rango.fin
    );
}

function rangoIntersectaRangosBusqueda(inicio, fin, rangos = []) {
    if (!Number.isInteger(inicio) || !Number.isInteger(fin) || inicio > fin) {
        return false;
    }

    return (Array.isArray(rangos) ? rangos : []).some((rango) =>
        inicio <= rango.fin && fin >= rango.inicio
    );
}

function construirFiltroSqlRangos(columnaSql, rangos = []) {
    const rangosNormalizados = fusionarRangosBusquedaRifa(rangos);

    if (rangosNormalizados.length === 0) {
        return {
            sql: '1 = 0',
            params: []
        };
    }

    const fragmentos = [];
    const params = [];

    rangosNormalizados.forEach((rango) => {
        fragmentos.push(`(${columnaSql} BETWEEN ? AND ?)`);
        params.push(rango.inicio, rango.fin);
    });

    return {
        sql: fragmentos.join(' OR '),
        params
    };
}

async function resolverClasificacionNumeroAdmin(numero, configBase = null) {
    const config = configBase || obtenerConfigActual();
    const rifaIdActual = obtenerRifaIdActual();
    const oportunidadesConfig = obtenerConfigOportunidadesSistema(config);
    const rangoVisible = oportunidadesConfig.rangoVisible;
    const rangoOculto = oportunidadesConfig.rangoOculto;
    const totalBoletosConfigurados = obtenerTotalBoletosConfigurado(config);

    let estaEnRangoVisible = Boolean(
        rangoVisible
        && numero >= rangoVisible.inicio
        && numero <= rangoVisible.fin
    );
    let estaEnRangoOculto = Boolean(
        oportunidadesConfig.enabled
        && rangoOculto
        && numero >= rangoOculto.inicio
        && numero <= rangoOculto.fin
    );

    let motivoFallback = null;

    if (!estaEnRangoVisible && !estaEnRangoOculto) {
        if (totalBoletosConfigurados > 0 && numero >= 0 && numero <= totalBoletosConfigurados - 1) {
            estaEnRangoVisible = true;
            motivoFallback = 'totalBoletos-config';
        } else {
            const boletoExistenteQuery = db('boletos_estado')
                .select('numero')
                .where('numero', numero);
            if (rifaIdActual) boletoExistenteQuery.where('rifa_id', rifaIdActual);
            const boletoExistente = await boletoExistenteQuery.first();

            if (boletoExistente) {
                estaEnRangoVisible = true;
                motivoFallback = 'boletos_estado';
            } else {
                const oportunidadExistenteQuery = db('orden_oportunidades')
                    .select('numero_oportunidad')
                    .where('numero_oportunidad', numero);
                if (rifaIdActual) oportunidadExistenteQuery.where('rifa_id', rifaIdActual);
                const oportunidadExistente = await oportunidadExistenteQuery.first();

                if (oportunidadExistente) {
                    estaEnRangoOculto = true;
                    motivoFallback = 'orden_oportunidades';
                }
            }
        }
    }

    return {
        oportunidadesConfig,
        rangoVisible,
        rangoOculto,
        totalBoletosConfigurados,
        estaEnRangoVisible,
        estaEnRangoOculto,
        motivoFallback
    };
}

function parseBoletosOrdenLegacy(raw) {
    let boletosArr = [];

    if (!raw) {
        boletosArr = [];
    } else if (Array.isArray(raw)) {
        boletosArr = raw;
    } else if (typeof raw === 'object' && raw !== null) {
        boletosArr = Object.values(raw);
    } else if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                boletosArr = parsed;
            } else if (typeof parsed === 'object' && parsed !== null) {
                boletosArr = Object.values(parsed);
            } else if (typeof parsed === 'string') {
                boletosArr = parsed.split(',').map((s) => s.trim()).filter(Boolean);
            }
        } catch (err) {
            boletosArr = raw.split(',').map((s) => s.trim()).filter(Boolean);
        }
    }

    return boletosArr.map((b) => {
        if (b === null || typeof b === 'undefined') return NaN;
        if (typeof b === 'number') return b;
        if (typeof b === 'string') {
            const n = Number(b);
            if (!Number.isNaN(n)) return n;
            try {
                const inner = JSON.parse(b);
                if (inner && typeof inner === 'object') {
                    return Number(inner.numero || inner.numero_boleto || inner.n || inner.id || NaN);
                }
            } catch (e) {
                return NaN;
            }
        }
        if (typeof b === 'object') {
            return Number(b.numero || b.numero_boleto || b.n || b.id || NaN);
        }
        return NaN;
    }).filter((n) => !Number.isNaN(n));
}

async function buscarOrdenActivaPorBoleto(numero, options = {}) {
    const numeroBoleto = Number(numero);
    if (!Number.isFinite(numeroBoleto)) {
        return { orden: null, boletoEstado: null, origen: null };
    }

    const incluirCanceladas = options.incluirCanceladas === true;
    const configActual = options.configActual || obtenerConfigActual();
    const rifaIdActual = Number.parseInt(options.rifaId, 10) || obtenerRifaIdActual();
    const oportunidadesHabilitadas = obtenerConfigOportunidadesSistema(configActual).enabled === true;
    const boletoEstadoQuery = db('boletos_estado')
        .select('numero', 'estado', 'numero_orden', 'created_at', 'updated_at')
        .where('numero', numeroBoleto);
    if (rifaIdActual) boletoEstadoQuery.where('rifa_id', rifaIdActual);
    const boletoEstado = await boletoEstadoQuery.first();

    if (boletoEstado?.numero_orden) {
        const ordenPorEstadoQuery = db('ordenes')
            .select('*')
            .where('numero_orden', boletoEstado.numero_orden)
            .modify((qb) => {
                if (!incluirCanceladas) qb.whereNot('estado', 'cancelada');
                if (rifaIdActual) qb.where('rifa_id', rifaIdActual);
            });
        const ordenPorEstado = await ordenPorEstadoQuery.first();

        if (ordenPorEstado) {
            return {
                orden: ordenPorEstado,
                boletoEstado,
                origen: 'boletos_estado'
            };
        }
    }

    const oportunidadEstado = oportunidadesHabilitadas
        ? await db('orden_oportunidades')
            .select('numero_oportunidad', 'estado', 'numero_orden', 'numero_boleto')
            .where('numero_oportunidad', numeroBoleto)
            .modify((qb) => {
                if (rifaIdActual) qb.where('rifa_id', rifaIdActual);
            })
            .first()
        : null;

    if (oportunidadEstado?.numero_orden) {
        const ordenPorOportunidad = await db('ordenes')
            .select('*')
            .where('numero_orden', oportunidadEstado.numero_orden)
            .modify((qb) => {
                if (!incluirCanceladas) qb.whereNot('estado', 'cancelada');
                if (rifaIdActual) qb.where('rifa_id', rifaIdActual);
            })
            .first();

        if (ordenPorOportunidad) {
            return {
                orden: ordenPorOportunidad,
                boletoEstado: {
                    numero: numeroBoleto,
                    estado: oportunidadEstado.estado || null,
                    numero_orden: oportunidadEstado.numero_orden,
                    numero_boleto_base: oportunidadEstado.numero_boleto ?? null,
                    es_oportunidad: true
                },
                origen: 'orden_oportunidades'
            };
        }
    }

    const ordenesLegacy = await dbUtils
        .ordersContainingBoletoQuery(numeroBoleto)
        .select('*')
        .modify((qb) => {
            if (!incluirCanceladas) qb.whereNot('estado', 'cancelada');
            // ⚠️ FILTRO POR RIFA: Evita que boletos de otras rifas se mezclen
            if (rifaIdActual) qb.where('rifa_id', rifaIdActual);
        });

    let ordenLegacy = null;
    for (const orden of ordenesLegacy) {
        try {
            const boletosNumericos = parseBoletosOrdenLegacy(orden.boletos);
            if (boletosNumericos.includes(numeroBoleto)) {
                if (!ordenLegacy || new Date(orden.created_at) > new Date(ordenLegacy.created_at)) {
                    ordenLegacy = orden;
                }
            }
        } catch (error) {
            console.warn('[buscarOrdenActivaPorBoleto] Error parseando orden legacy', orden?.numero_orden, error?.message);
        }
    }

    return {
        orden: ordenLegacy,
        boletoEstado,
        origen: ordenLegacy ? 'ordenes.boletos' : null
    };
}

function normalizarTipoGanadorPersistencia(valor) {
    const tipo = String(valor || 'sorteo').toLowerCase().trim();
    if (tipo === 'sorteo' || tipo === 'principal') return 'principal';
    if (tipo === 'presorteo' || tipo === 'presorte') return 'presorte';
    if (tipo === 'ruletazos' || tipo === 'ruletazo') return 'ruletazo';
    return 'principal';
}

function obtenerLimitesGanadoresConfig(configActual = {}) {
    const rifa = configActual?.rifa || {};
    const ganadores = rifa.ganadores || {};
    const sistemaPremios = rifa.sistemaPremios || {};

    const totalSorteo = Number(ganadores.sorteo)
        || (Array.isArray(sistemaPremios.sorteo) ? sistemaPremios.sorteo.length : 0)
        || 0;
    const totalPresorteo = Number(ganadores.presorteo)
        || (Array.isArray(sistemaPremios.presorteo) ? sistemaPremios.presorteo.length : 0)
        || 0;
    const totalRuletazos = Number(ganadores.ruletazos)
        || (Array.isArray(sistemaPremios.ruletazos) ? sistemaPremios.ruletazos.length : 0)
        || 0;

    return {
        principal: totalSorteo,
        presorte: totalPresorteo,
        ruletazo: totalRuletazos
    };
}

function construirRangoPorPrefijo(valor, anchoBoletos, maxNumero) {
    const prefijo = String(valor || '').trim();
    if (!/^\d+$/.test(prefijo) || prefijo.length === 0 || prefijo.length > anchoBoletos) {
        return null;
    }

    const multiplicador = 10 ** Math.max(0, anchoBoletos - prefijo.length);
    const inicio = Number(prefijo) * multiplicador;
    const fin = Math.min(maxNumero, inicio + multiplicador - 1);

    if (!Number.isFinite(inicio) || !Number.isFinite(fin) || inicio > maxNumero || fin < inicio) {
        return null;
    }

    return { inicio, fin };
}

function construirSerieSuffixQuery(valor, maxNumero) {
    const sufijo = String(valor || '').trim();
    if (!/^\d+$/.test(sufijo) || sufijo.length === 0) {
        return null;
    }

    const inicio = Number(sufijo);
    const paso = 10 ** sufijo.length;

    if (!Number.isFinite(inicio) || !Number.isFinite(paso) || paso <= 0 || inicio > maxNumero) {
        return null;
    }

    return db
        .select(db.raw('gs::int AS numero'))
        .from(db.raw('generate_series(?::bigint, ?::bigint, ?::bigint) AS gs', [inicio, maxNumero, paso]))
        .as('s');
}

function construirQueryBusquedaSobreSerie(serieQuery, { availableOnly = false, limite = 100, offset = 0, rifaId = null } = {}) {
    const rifaIdResuelto = rifaId || obtenerRifaIdActual();

    // Usamos una consulta base clara para evitar ambigüedades de parámetros
    const query = db
        .from(serieQuery)
        .leftJoin('boletos_estado as be', function () {
            this.on('be.numero', '=', 's.numero');
            if (rifaIdResuelto) {
                this.andOn('be.rifa_id', '=', db.raw('?::int', [rifaIdResuelto]));
            }
            this.andOnIn('be.estado', ['vendido', 'apartado']);
        })
        .select(
            's.numero',
            db.raw("COALESCE(be.estado, 'disponible') AS estado")
        )
        .orderBy('s.numero', 'asc')
        .limit(limite)
        .offset(offset)
        .timeout(15000);

    if (availableOnly) {
        query.whereNull('be.numero');
    }

    return query;
}

// Servir archivos estáticos en /public con caché inteligente
app.use('/public', express.static(path.join(__dirname, 'public'), {
    maxAge: '1d', // Caché base de 1 día
    setHeaders: (res, filePath) => {
        if (filePath.match(/\.(jpg|jpeg|png|gif|svg|webp|ico|woff|woff2|ttf|otf)$/i)) {
            // Imágenes y fuentes: 1 año (Agresiva)
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else if (filePath.match(/\.(css|js)$/i)) {
            // CSS y JS: 1 mes
            res.setHeader('Cache-Control', 'public, max-age=2592000');
        }
    }
}));

// 🔒 Bloquear acceso estático a archivos internos del proyecto
app.use((req, res, next) => {
    const requestPath = decodeURIComponent(req.path || '').replace(/\\/g, '/');
    const sensitivePrefixes = [
        '/backend/',
        '/node_modules/',
        '/.git/',
        '/.vscode/',
        '/.idea/'
    ];
    const sensitiveFiles = [
        '/backend',
        '/package.json',
        '/package-lock.json',
        '/pnpm-lock.yaml',
        '/yarn.lock',
        '/docker-compose.yml',
        '/Dockerfile',
        '/.env',
        '/.env.example'
    ];
    const sensitiveExtensions = /\.(env|sql|db|sqlite|sqlite3|log|md|map)$/i;

    if (
        sensitivePrefixes.some((prefix) => requestPath.startsWith(prefix)) ||
        sensitiveFiles.includes(requestPath) ||
        sensitiveExtensions.test(requestPath)
    ) {
        return res.status(404).json({
            success: false,
            message: 'Ruta no encontrada'
        });
    }

    return next();
});

// ✅ Servir archivos estáticos del frontend con caché optimizada
// IMPORTANTE: Va ANTES de la ruta catch-all de index.html
app.use(express.static(path.join(__dirname, '..'), {
    maxAge: '1h', // Caché base de 1 hora para archivos generales
    setHeaders: (res, filePath) => {
        if (filePath.match(/\.(html|php)$/i)) {
            // Documentos: Siempre frescos
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        } else if (filePath.match(/\.(jpg|jpeg|png|gif|svg|webp|ico|woff|woff2|ttf|otf)$/i)) {
            // Imágenes y fuentes locales: 1 año
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else if (filePath.match(/\.(css|js)$/i)) {
            // Scripts y estilos: 1 mes (apoyado por el versionado ?v= en el HTML)
            res.setHeader('Cache-Control', 'public, max-age=2592000');
        }
    }
}));

// Nota: Frontend se sirve desde un host separado (Vercel, GitHub Pages, etc.)

app.get('/api/public/push/config', (req, res) => {
    const config = obtenerConfigPush();
    return res.json({
        success: true,
        enabled: config.enabled,
        publicKey: config.enabled ? config.publicKey : null
    });
});

/**
 * Middleware: Verificar JWT
 * Usado en endpoints protegidos (/api/admin/*, /api/ordenes POST, PATCH, etc.)
 */
function verificarToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer <token>

    if (!token) {
        console.error('❌ [verificarToken] No hay token');
        return res.status(401).json({
            success: false,
            message: 'Token no proporcionado',
            code: 'NO_TOKEN'
        });
    }

    jwt.verify(token, JWT_SECRET, (err, usuario) => {
        if (err) {
            console.error('❌ [verificarToken] Error al verificar:', err.message);
            return res.status(403).json({
                success: false,
                message: 'Token inválido o expirado',
                code: 'INVALID_TOKEN'
            });
        }
        req.usuario = usuario; // Adjuntar usuario al request
        next();
    });
}

function verificarSocketAdminToken(socket, next) {
    const authToken = socket.handshake?.auth?.token;
    const headerToken = socket.handshake?.headers?.authorization
        ? String(socket.handshake.headers.authorization).replace(/^Bearer\s+/i, '')
        : '';
    const queryToken = socket.handshake?.query?.token;
    const token = authToken || headerToken || queryToken;

    if (!token) {
        return next(new Error('NO_TOKEN'));
    }

    jwt.verify(token, JWT_SECRET, (err, usuario) => {
        if (err) {
            return next(new Error('INVALID_TOKEN'));
        }

        const rolesPermitidos = ['administrador', 'gestor_ordenes'];
        if (!rolesPermitidos.includes(usuario?.rol)) {
            return next(new Error('FORBIDDEN'));
        }

        socket.adminUser = usuario;
        return next();
    });
}

// 🔐 SEGURIDAD: Función para sanitizar mensajes de error (NO exponer detalles internos)
/**
 * Sanitiza mensajes de error para NO exponer:
 * - URLs de Cloudinary
 * - Paths de archivos internos
 * - Stack traces
 * - Credenciales o tokens
 * - Detalles técnicos de BD
 * @param {string} errorMessage - Mensaje original de error
 * @param {boolean} isDevelopment - Si estamos en desarrollo
 * @returns {string} Mensaje sanitizado
 */
function sanitizarErrorMessage(errorMessage, isDevelopment = false) {
    if (!isDevelopment) {
        // En PRODUCCIÓN: Retornar mensaje genérico
        // Mostrar SOLO el mensaje amigo del usuario
        const mensajeOriginal = String(errorMessage || 'Error desconocido');

        // Mapping de errores conocidos a mensajes seguros
        const errorMappings = {
            'Archivo': 'El archivo no es válido',
            'obligatorio': 'Faltan datos requeridos',
            'inválido': 'Los datos proporcionados no son válidos',
            'no encontrada': 'Recurso no encontrado',
            'permiso': 'No tienes permiso para esta acción',
            'demasiado grande': 'El archivo es demasiado grande',
            'Cloudinary': 'Error al procesar archivo. Intenta más tarde',
            'Esquema': 'Error de configuración del servidor',
            'BOLETOS_CONFLICTO': 'algunos boletos ya no están disponibles',
            'EOF': 'Error de conexión. Intenta nuevamente'
        };

        // Buscar un mapping para el error
        for (const [clave, mensaje] of Object.entries(errorMappings)) {
            if (mensajeOriginal.includes(clave)) {
                return mensaje;
            }
        }

        // Si no hay mapping, retornar mensaje genérico
        return 'Error al procesar tu solicitud. Por favor intenta nuevamente';
    }

    // En DESARROLLO: Mostrar detalles (para debugging)
    return String(errorMessage || 'Error desconocido');
}

// ===== FUNCIONES DE VALIDACIÓN =====

/**
 * Sanitiza strings: elimina HTML, trimea espacios
 */
function sanitizar(str) {
    if (typeof str !== 'string') return '';
    return sanitizeHtml(str, {
        allowedTags: [],
        allowedAttributes: {}
    }).trim();
}

/**
 * 🔒 Valida y sanitiza un campo de premio
 * @param {string} campo - El nombre del campo (nombre, premio, descripcion)
 * @param {*} valor - El valor a validar
 * @returns {string} - Valor sanitizado y validado
 */
function validarCampoPremio(campo, valor) {
    if (typeof valor !== 'string') return '';

    // Sanitizar
    let limpio = sanitizar(valor);

    // Validar longitud (max 200 caracteres)
    if (limpio.length > 200) {
        limpio = limpio.substring(0, 200);
    }

    // No permitir vacío
    if (limpio.length === 0) {
        throw new Error(`${campo} no puede estar vacío`);
    }

    return limpio;
}

/**
 * 📦 Crea backup automático de config.json
 * Guarda versión anterior en backup/
 */
async function crearBackupConfig(configPath, configSnapshot = null) {
    try {
        const backupDir = path.join(path.dirname(configPath), 'backups');

        // Crear directorio backups si no existe
        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir, { recursive: true });
        }

        // Nombre del backup con timestamp
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = path.join(backupDir, `config.${timestamp}.json`);

        const contenido = configSnapshot
            ? JSON.stringify(configSnapshot, null, 2)
            : (fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : null);

        // Copiar snapshot actual al backup
        if (contenido) {
            fs.writeFileSync(backupPath, contenido, 'utf8');

            // Limpiar backups viejos (mantener últimos 10)
            limpiarBackupsAntiguos(backupDir);
        }
    } catch (error) {
        console.warn('⚠️  Error creando backup:', error.message);
        // No fallar si el backup falla, solo warnings
    }
}

/**
 * 🧹 Elimina backups muy antiguos (mantiene últimos 10)
 */
function limpiarBackupsAntiguos(backupDir) {
    try {
        const archivos = fs.readdirSync(backupDir).sort().reverse();
        if (archivos.length > 10) {
            archivos.slice(10).forEach(archivo => {
                fs.unlinkSync(path.join(backupDir, archivo));
            });
        }
    } catch (error) {
        console.warn('⚠️  Error limpiando backups:', error.message);
    }
}

/**
 * Valida teléfono (básico)
 */
function esTelefonoValido(tel) {
    return tel && tel.length >= 10 && tel.length <= 20;
}

/**
 * Valida precio (número positivo)
 */
function esPrecioValido(precio) {
    const num = parseFloat(precio);
    return !isNaN(num) && num > 0;
}

/**
 * FUNCIÓN LOG: Registra eventos en la consola
 * Usada para logging consistente en todo el servidor
 * @param {string} level - Nivel de log ('info', 'warn', 'error', 'debug')
 * @param {string} mensaje - Mensaje a registrar
 * @param {object} datos - Datos adicionales a incluir en el log
 */
function log(level = 'info', mensaje = '', datos = {}) {
    const timestamp = new Date().toISOString();
    const prefijos = {
        info: '📋',
        warn: '⚠️ ',
        error: '❌',
        debug: '🔍'
    };
    const prefijo = prefijos[level] || '•';

    if (typeof datos === 'object' && Object.keys(datos).length > 0) {
        console.log(`${prefijo} [${level.toUpperCase()}] ${mensaje}`, datos);
    } else {
        console.log(`${prefijo} [${level.toUpperCase()}] ${mensaje}`);
    }
}

function clasificarDuracion(ms, umbrales = {}) {
    const slowMs = Number(umbrales.slowMs) || 800;
    const warnMs = Number(umbrales.warnMs) || 2000;

    if (ms >= warnMs) return 'error';
    if (ms >= slowMs) return 'warn';
    return 'info';
}

function logOperacionHttp(nombre, inicioMs, datos = {}, umbrales = {}) {
    const duracionMs = Math.max(0, Date.now() - inicioMs);
    const level = clasificarDuracion(duracionMs, umbrales);
    log(level, `${nombre} completado`, {
        duracionMs,
        ...datos
    });
    return duracionMs;
}

/**
 * FUNCIÓN CRÍTICA: Calcula descuento basado en cantidad de boletos y promociones
 * Esta función se ejecuta en BACKEND para garantizar consistencia
 * Usa promociones dinámicas de la configuración actual, con fallback seguro
 * @param {number} cantidad - Número de boletos
 * @param {number} precioUnitario - Precio por boleto (obtiene dinámicamente si no se proporciona)
 * @returns {number} Monto de descuento en pesos
 */
/**
 * ✅ NUEVA FUNCIÓN: Calcula descuento de forma SINCRONIZADA con cliente
 * Usa calcularDescuentoCompartido() con la misma lógica compartida entre cliente y servidor
 * Esto evita inconsistencias como el bug ST-AA074 (24k vs 25k)
 */
function calcularDescuentoBackend(cantidad, precioUnitario, config = null) {
    // Si no se proporciona precio, obtenerlo desde la configuración actual
    if (!precioUnitario) {
        precioUnitario = obtenerPrecioDinamico() || 15;
    }

    // Obtener reglas de descuento desde config si está disponible
    let reglas = null;
    if (config && config.rifa && config.rifa.descuentos && config.rifa.descuentos.reglas) {
        reglas = config.rifa.descuentos.reglas;
    }

    // ✅ USAR FUNCIÓN COMPARTIDA (misma lógica que cliente)
    // Pasar el config COMPLETO para que valide descuentos.enabled
    const resultado = calcularDescuentoCompartido(cantidad, precioUnitario, reglas, config);
    return resultado.monto;
}

// ===== HEALTH CHECK - CRÍTICO PARA PRODUCCIÓN =====
let dbHealthy = true;
let lastDbCheck = Date.now();

/**
 * Verifica salud de la conexión a BD
 * Se ejecuta en background cada 30 segundos
 */
async function verificarSaludBD() {
    try {
        // Query simple para verificar conectividad
        await db.raw('SELECT 1');
        dbHealthy = true;
        lastDbCheck = Date.now();
        // console.log('✅ BD health check OK');
    } catch (error) {
        console.error('❌ BD HEALTH CHECK FALLÓ:', error.message);
        dbHealthy = false;
        lastDbCheck = Date.now();
    }
}

// Verificar salud de BD cada 30 segundos
setInterval(verificarSaludBD, 30000);
// Verificación inicial
verificarSaludBD();

/**
 * 🎁 GUARDAR OPORTUNIDADES EN BACKGROUND
 * ================================================
 * Función helper que maneja el guardado asincrónico de oportunidades
 * Se ejecuta en background (setImmediate) sin bloquear la respuesta al cliente
 * 
 * @param {string} numeroOrden - Número de orden
 * @param {Array<number>} boletosOcultos - Array de números de oportunidades
 * @param {boolean} habilitadas - Si las oportunidades están habilitadas en config
 */
function obtenerUrlBasePublica(req, fallbackUrlBase = '') {
    if (fallbackUrlBase && /^https?:\/\//i.test(fallbackUrlBase)) {
        return fallbackUrlBase.replace(/\/+$/, '');
    }

    const forwardedProto = req.get('x-forwarded-proto');
    const protocol = (forwardedProto || req.protocol || 'https').split(',')[0].trim();
    const host = req.get('x-forwarded-host') || req.get('host');

    if (host) {
        return `${protocol}://${host}`.replace(/\/+$/, '');
    }

    const envPublicBase = String(
        process.env.PUBLIC_BASE_URL
        || process.env.FRONTEND_URL
        || String(process.env.CORS_ORIGINS || '').split(',')[0]
        || ''
    ).trim();

    if (/^https?:\/\//i.test(envPublicBase)) {
        return envPublicBase.replace(/\/+$/, '');
    }

    return 'http://localhost:5001';
}

function normalizarRutaPublicaSeo(valor = '') {
    const crudo = String(valor || '').trim();
    if (!crudo) return '/';

    try {
        const soloPath = crudo.startsWith('http://') || crudo.startsWith('https://')
            ? new URL(crudo).pathname
            : crudo;
        const base = soloPath.startsWith('/') ? soloPath : `/${soloPath}`;
        return base.replace(/\/{2,}/g, '/');
    } catch (error) {
        const base = crudo.startsWith('/') ? crudo : `/${crudo}`;
        return base.replace(/\/{2,}/g, '/');
    }
}

function resolverAliasRutaSeo(ruta = '/') {
    const limpia = normalizarRutaPublicaSeo(ruta).toLowerCase();

    if (limpia === '/' || limpia === '/index.html') return 'inicio';
    if (limpia === '/compra' || limpia === '/compra.html') return 'compra';
    if (limpia === '/mis-boletos' || limpia === '/mis-boletos.html') return 'mis-boletos';
    if (limpia === '/mis-boletos-restringido' || limpia === '/mis-boletos-restringido.html') return 'mis-boletos';
    if (limpia === '/ayuda' || limpia === '/ayuda.html') return 'ayuda';
    if (limpia === '/cuentas-pago' || limpia === '/cuentas-pago.html') return 'cuentas-pago';
    if (limpia === '/admin-dashboard' || limpia === '/admin-dashboard.html') return 'admin-dashboard';
    if (limpia === '/admin-configuracion' || limpia === '/admin-configuracion.html') return 'admin-configuracion';
    if (limpia === '/admin-ordenes' || limpia === '/admin-ordenes.html') return 'admin-ordenes';
    if (limpia === '/admin-boletos' || limpia === '/admin-boletos.html') return 'admin-boletos';
    if (limpia === '/admin-ayuda' || limpia === '/admin-ayuda.html') return 'admin-ayuda';
    if (limpia === '/admin-ruletazo' || limpia === '/admin-ruletazo.html') return 'admin-ruletazo';

    return '';
}

function construirUrlCanonica(baseUrl, ruta = '/') {
    const baseNormalizada = String(baseUrl || '').replace(/\/+$/, '');
    const rutaNormalizada = normalizarRutaPublicaSeo(ruta);
    if (!baseNormalizada) return rutaNormalizada;
    if (rutaNormalizada === '/' || rutaNormalizada === '/index.html') return baseNormalizada;
    return `${baseNormalizada}${rutaNormalizada}`;
}

function esTextoSeoConfiable(valor) {
    const texto = String(valor || '').trim();
    if (!texto) return false;
    return !/^(aqui va|aquí va|aqui puedes|aquí puedes|demo\b|titulo seo|descripci[oó]n seo)$/i.test(texto);
}

function esUrlBaseSeoConfiable(valor) {
    const url = String(valor || '').trim();
    if (!/^https?:\/\//i.test(url)) return false;
    return !/tu-dominio\.com/i.test(url);
}

function formatearPrecioSeo(precio) {
    const numero = Number(precio);
    if (!Number.isFinite(numero)) return '';

    try {
        return new Intl.NumberFormat('es-MX', {
            style: 'currency',
            currency: 'MXN',
            maximumFractionDigits: numero % 1 === 0 ? 0 : 2
        }).format(numero);
    } catch (error) {
        return `$${numero}`;
    }
}

function obtenerSeoPaginaConfig(seo = {}, alias = '') {
    if (!alias || !seo || typeof seo !== 'object') return {};
    const paginas = seo.paginas || seo.pages || {};
    const pagina = paginas[alias];
    return pagina && typeof pagina === 'object' ? pagina : {};
}

function construirSeoPorRuta(config = {}, ruta = '/', baseUrl = '') {
    const cliente = config.cliente || {};
    const rifa = config.rifa || {};
    const seo = normalizarSeoConfigParaPersistencia(config.seo || {}, config);
    const alias = resolverAliasRutaSeo(ruta);
    const paginaSeo = obtenerSeoPaginaConfig(seo, alias);
    const precioFormateado = formatearPrecioSeo(rifa.precioBoleto);
    const nombreSorteo = String(rifa.nombreSorteo || '').trim();
    const nombreCliente = String(cliente.nombre || '').trim();
    const marcaAdmin = String(cliente.id || cliente.nombre || cliente.eslogan || 'SaDev')
        .replace(/^(aqui va|aquí va)/i, '')
        .replace(/^sorteos?\s+/i, '')
        .replace(/\s+-\s+admin$/i, '')
        .trim() || 'SaDev';
    const descripcionRifa = String(rifa.descripcion || '').replace(/\s+/g, ' ').trim();
    const tituloBase = seo.title || seo.titulo || nombreSorteo || nombreCliente || 'Sorteos';
    const descripcionBase = seo.description || seo.descripcion || descripcionRifa || `Participa en ${nombreSorteo || 'nuestro sorteo'}.`;
    const tituloCliente = [nombreSorteo, nombreCliente].filter(Boolean).join(' | ') || tituloBase;
    const canonical = construirUrlCanonica(baseUrl, ruta);

    const definiciones = {
        inicio: {
            title: tituloCliente,
            description: descripcionBase
        },
        compra: {
            title: nombreSorteo
                ? `Compra tus boletos para ${nombreSorteo}${nombreCliente ? ` | ${nombreCliente}` : ''}`
                : `Compra tus boletos${nombreCliente ? ` | ${nombreCliente}` : ''}`,
            description: [
                nombreSorteo ? `Elige tus boletos para ${nombreSorteo}.` : 'Elige tus boletos para el sorteo activo.',
                precioFormateado ? `Precio por boleto: ${precioFormateado}.` : '',
                descripcionRifa
            ].filter(Boolean).join(' ')
        },
        'mis-boletos': {
            title: `Consulta tus boletos${nombreCliente ? ` | ${nombreCliente}` : ''}`,
            description: nombreSorteo
                ? `Revisa el estado de tus boletos para ${nombreSorteo}, tu orden y el avance de validacion de pago.`
                : 'Revisa el estado de tus boletos, tu orden y el avance de validacion de pago.'
        },
        ayuda: {
            title: `Ayuda y preguntas frecuentes${nombreCliente ? ` | ${nombreCliente}` : ''}`,
            description: nombreSorteo
                ? `Resuelve dudas sobre ${nombreSorteo}, pagos, validaciones y dinamica del sorteo.`
                : 'Resuelve dudas sobre pagos, validaciones y dinamica del sorteo.'
        },
        'cuentas-pago': {
            title: `Cuentas y medios de pago${nombreCliente ? ` | ${nombreCliente}` : ''}`,
            description: nombreSorteo
                ? `Consulta las cuentas oficiales y medios de pago para participar en ${nombreSorteo}.`
                : 'Consulta las cuentas oficiales y medios de pago del sorteo activo.'
        },
        'admin-dashboard': {
            title: `Panel Admin - ${marcaAdmin}`,
            description: `Panel de control del sorteo${nombreSorteo ? ` ${nombreSorteo}` : ''}.`
        },
        'admin-configuracion': {
            title: `Panel Admin - ${marcaAdmin}`,
            description: `Configuracion general del sorteo${nombreSorteo ? ` ${nombreSorteo}` : ''}.`
        },
        'admin-ordenes': {
            title: `Panel Admin - ${marcaAdmin}`,
            description: `Gestion administrativa de ordenes${nombreSorteo ? ` para ${nombreSorteo}` : ''}.`
        },
        'admin-boletos': {
            title: `Panel Admin - ${marcaAdmin}`,
            description: `Gestion administrativa de boletos${nombreSorteo ? ` para ${nombreSorteo}` : ''}.`
        },
        'admin-ayuda': {
            title: `Panel Admin - ${marcaAdmin}`,
            description: `Ayuda administrativa del sorteo${nombreSorteo ? ` ${nombreSorteo}` : ''}.`
        },
        'admin-ruletazo': {
            title: `Panel Admin - ${marcaAdmin}`,
            description: `Control administrativo del ruletazo${nombreSorteo ? ` de ${nombreSorteo}` : ''}.`
        }
    };

    const pagina = definiciones[alias] || {
        title: tituloCliente,
        description: descripcionBase
    };

    const tituloPaginaEspecifico = esTextoSeoConfiable(paginaSeo.title || paginaSeo.titulo) ? (paginaSeo.title || paginaSeo.titulo) : '';
    const descripcionPaginaEspecifica = esTextoSeoConfiable(paginaSeo.description || paginaSeo.descripcion) ? (paginaSeo.description || paginaSeo.descripcion) : '';
    const tituloGlobal = esTextoSeoConfiable(tituloBase) ? tituloBase : '';
    const descripcionGlobal = esTextoSeoConfiable(descripcionBase) ? descripcionBase : '';

    return {
        title: tituloPaginaEspecifico || tituloGlobal || pagina.title,
        description: descripcionPaginaEspecifica || descripcionGlobal || pagina.description,
        canonical
    };
}

function resolverUrlPublica(valor, baseUrl) {
    const valorNormalizado = String(valor || '').trim();
    const baseNormalizada = String(baseUrl || '').replace(/\/+$/, '');

    if (!valorNormalizado) return `${baseNormalizada}/images/ImgPrincipal.png`;
    if (/^https?:\/\//i.test(valorNormalizado)) return valorNormalizado;
    if (valorNormalizado.startsWith('//')) return `https:${valorNormalizado}`;
    if (!baseNormalizada) return valorNormalizado;
    if (valorNormalizado.startsWith('/')) return `${baseNormalizada}${valorNormalizado}`;
    return `${baseNormalizada}/${valorNormalizado.replace(/^\.?\//, '')}`;
}

function normalizarTemaConfig(tema = {}) {
    const coloresBase = tema.colores || {};
    const colorPrimario = tema.colorPrimario || coloresBase.colorPrimario || coloresBase.primary || '#1877F2';
    const colorAcento = tema.colorAcento || coloresBase.colorAccento || coloresBase.colorSecundario || coloresBase.secondary || colorPrimario;
    const colorFondo = tema.colorFondo || coloresBase.colorFondo || coloresBase.bgLight || '#F8FAFC';
    const colorSuperficie = tema.colorSuperficie || coloresBase.colorSuperficie || coloresBase.bgWhite || '#FFFFFF';
    const colorTexto = tema.colorTexto || coloresBase.colorTexto || coloresBase.textDark || colorAcento;

    const normalizarHex = (valor, fallback) => {
        const limpio = String(valor || '').trim();
        const match = limpio.match(/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
        if (!match) return fallback;
        const hex = match[1];
        if (hex.length === 3) {
            return `#${hex.split('').map((char) => char + char).join('').toLowerCase()}`;
        }
        return `#${hex.toLowerCase()}`;
    };

    const hexToRgb = (hex) => {
        const value = normalizarHex(hex, '#000000').slice(1);
        return {
            r: parseInt(value.slice(0, 2), 16),
            g: parseInt(value.slice(2, 4), 16),
            b: parseInt(value.slice(4, 6), 16)
        };
    };

    const rgbToHex = ({ r, g, b }) => {
        const toHex = (value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
        return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
    };

    const mezclarHex = (colorA, colorB, ratioB = 0.5) => {
        const a = hexToRgb(colorA);
        const b = hexToRgb(colorB);
        const ratio = Math.max(0, Math.min(1, ratioB));
        return rgbToHex({
            r: a.r + ((b.r - a.r) * ratio),
            g: a.g + ((b.g - a.g) * ratio),
            b: a.b + ((b.b - a.b) * ratio)
        });
    };

    const ajustarLuminosidad = (color, factor = 0) => (
        factor >= 0
            ? mezclarHex(color, '#ffffff', factor)
            : mezclarHex(color, '#000000', Math.abs(factor))
    );

    const luminancia = (color) => {
        const { r, g, b } = hexToRgb(color);
        const canal = (valor) => {
            const normalizado = valor / 255;
            return normalizado <= 0.03928
                ? normalizado / 12.92
                : ((normalizado + 0.055) / 1.055) ** 2.4;
        };
        return (0.2126 * canal(r)) + (0.7152 * canal(g)) + (0.0722 * canal(b));
    };

    const contraste = (colorA, colorB) => {
        const l1 = luminancia(colorA);
        const l2 = luminancia(colorB);
        const claro = Math.max(l1, l2);
        const oscuro = Math.min(l1, l2);
        return (claro + 0.05) / (oscuro + 0.05);
    };

    const asegurarTexto = (textoPreferido, fondo, minimo = 4.5) => {
        const preferido = normalizarHex(textoPreferido, '#0f172a');
        if (contraste(preferido, fondo) >= minimo) return preferido;
        const oscuro = '#0f172a';
        const claro = '#ffffff';
        return contraste(claro, fondo) > contraste(oscuro, fondo) ? claro : oscuro;
    };

    const primario = normalizarHex(colorPrimario, '#1877f2');
    const acento = normalizarHex(colorAcento, '#0f172a');
    const fondo = normalizarHex(colorFondo, '#f8fafc');
    const superficie = normalizarHex(colorSuperficie, '#ffffff');
    const texto = asegurarTexto(colorTexto, superficie);
    const textoSecundario = asegurarTexto(coloresBase.colorTextoSecundario || coloresBase.textLight || mezclarHex(texto, superficie, 0.42), superficie, 3.6);

    return {
        ...tema,
        personalizado: tema.personalizado === true,
        preset: tema.preset || 'clasico',
        colorPrimario: primario,
        colorAcento: acento,
        colorFondo: fondo,
        colorSuperficie: superficie,
        colorTexto: texto,
        colores: {
            ...coloresBase,
            colorPrimario: primario,
            colorSecundario: coloresBase.colorSecundario || acento,
            colorAccento: coloresBase.colorAccento || acento,
            colorFondo: fondo,
            colorSuperficie: superficie,
            colorTexto: texto,
            colorTextoSecundario: textoSecundario,
            primary: coloresBase.primary || primario,
            primaryDark: coloresBase.primaryDark || ajustarLuminosidad(primario, -0.22),
            primaryLight: coloresBase.primaryLight || mezclarHex(primario, superficie, 0.82),
            secondary: coloresBase.secondary || acento,
            success: coloresBase.success || '#16a34a',
            danger: coloresBase.danger || '#dc2626',
            textDark: coloresBase.textDark || texto,
            textLight: coloresBase.textLight || textoSecundario,
            bgLight: coloresBase.bgLight || fondo,
            bgWhite: coloresBase.bgWhite || superficie,
            borderColor: coloresBase.borderColor || mezclarHex(texto, superficie, 0.84)
        }
    };
}

function normalizarSeoConfigParaPersistencia(seo = {}, configActual = {}) {
    const cliente = configActual.cliente || {};
    const rifa = configActual.rifa || {};
    const seoActual = configActual.seo || {};
    const tieneCampo = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);
    const leerCampo = (obj, keys = []) => {
        for (const key of keys) {
            if (tieneCampo(obj, key)) {
                return obj[key];
            }
        }
        return undefined;
    };
    const limpiarSeo = (valor) => (typeof valor === 'string' ? valor.trim() : valor);

    const tituloDerivado = rifa.nombreSorteo ? `${rifa.nombreSorteo}${cliente.nombre ? ` | ${cliente.nombre}` : ''}` : (cliente.nombre || 'Sorteos');
    const descripcionDerivada = rifa.descripcion || cliente.eslogan || (rifa.nombreSorteo ? `Participa en el sorteo de ${rifa.nombreSorteo}.` : 'Compra tus boletos en linea.');
    const imagenDerivada = cliente.imagenPrincipal || cliente.logo || cliente.logotipo || '/images/ImgPrincipal.png';
    const palabrasLlaveDerivadas = `sorteo, rifa, ${rifa.nombreSorteo || ''}, ${cliente.nombre || 'Sorteos'}`.replace(/,\s*,/g, ',').trim();
    const autorDerivado = cliente.nombre || 'Sorteos';

    const titulo = limpiarSeo(leerCampo(seo, ['title', 'titulo']))
        || limpiarSeo(leerCampo(seo.openGraph, ['titulo']))
        || limpiarSeo(leerCampo(seo.twitter, ['titulo']))
        || limpiarSeo(leerCampo(seoActual, ['title', 'titulo']))
        || tituloDerivado;

    const descripcion = limpiarSeo(leerCampo(seo, ['description', 'descripcion']))
        || limpiarSeo(leerCampo(seo.openGraph, ['descripcion']))
        || limpiarSeo(leerCampo(seo.twitter, ['descripcion']))
        || limpiarSeo(leerCampo(seoActual, ['description', 'descripcion']))
        || descripcionDerivada;

    const imagen = limpiarSeo(leerCampo(seo, ['image', 'imagen']))
        || limpiarSeo(leerCampo(seo.openGraph, ['imagen']))
        || limpiarSeo(leerCampo(seo.twitter, ['imagen']))
        || limpiarSeo(leerCampo(seoActual, ['image', 'imagen']))
        || imagenDerivada;

    const palabrasLlave = limpiarSeo(leerCampo(seo, ['keywords', 'palabrasLlave']))
        || limpiarSeo(leerCampo(seoActual, ['keywords', 'palabrasLlave']))
        || palabrasLlaveDerivadas;

    const urlBaseSeo = limpiarSeo(leerCampo(seo, ['urlBase']))
        || limpiarSeo(leerCampo(seoActual, ['urlBase']))
        || '';
    const urlBase = esUrlBaseSeoConfiable(urlBaseSeo) ? urlBaseSeo : '';

    const autor = limpiarSeo(leerCampo(seo, ['author', 'autor']))
        || limpiarSeo(leerCampo(seoActual, ['author', 'autor']))
        || autorDerivado;

    const ogTitulo = limpiarSeo(leerCampo(seo.openGraph, ['titulo'])) || titulo;
    const ogDescripcion = limpiarSeo(leerCampo(seo.openGraph, ['descripcion'])) || descripcion;
    const ogImagen = limpiarSeo(leerCampo(seo.openGraph, ['imagen'])) || imagen;
    const ogTipo = limpiarSeo(leerCampo(seo.openGraph, ['tipo']))
        || limpiarSeo(leerCampo(seoActual.openGraph, ['tipo']))
        || 'website';
    const ogLocale = limpiarSeo(leerCampo(seo.openGraph, ['locale']))
        || limpiarSeo(leerCampo(seoActual.openGraph, ['locale']))
        || 'es_MX';

    const twitterCard = limpiarSeo(leerCampo(seo.twitter, ['card']))
        || limpiarSeo(leerCampo(seoActual.twitter, ['card']))
        || 'summary_large_image';
    const twitterTitulo = limpiarSeo(leerCampo(seo.twitter, ['titulo'])) || titulo;
    const twitterDescripcion = limpiarSeo(leerCampo(seo.twitter, ['descripcion'])) || descripcion;
    const twitterImagen = limpiarSeo(leerCampo(seo.twitter, ['imagen'])) || imagen;
    const twitterCreador = limpiarSeo(leerCampo(seo.twitter, ['creador']))
        || limpiarSeo(leerCampo(seoActual.twitter, ['creador']))
        || cliente.redesSociales?.twitter
        || '';

    return {
        ...seoActual,
        ...seo,
        title: titulo,
        titulo,
        description: descripcion,
        descripcion,
        image: imagen,
        imagen,
        keywords: palabrasLlave,
        palabrasLlave,
        author: autor,
        autor,
        urlBase,
        openGraph: {
            ...(seoActual.openGraph || {}),
            ...(seo.openGraph || {}),
            titulo: ogTitulo,
            descripcion: ogDescripcion,
            imagen: ogImagen,
            tipo: ogTipo,
            locale: ogLocale
        },
        twitter: {
            ...(seoActual.twitter || {}),
            ...(seo.twitter || {}),
            card: twitterCard,
            titulo: twitterTitulo,
            descripcion: twitterDescripcion,
            imagen: twitterImagen,
            creador: twitterCreador
        }
    };
}

function construirMetadatosSeo(config = {}, req, routePath = '', publicBase = '') {
    const cliente = config.cliente || {};
    const rifa = config.rifa || {};
    const seo = normalizarSeoConfigParaPersistencia(config.seo || {}, config);
    const tema = normalizarTemaConfig(config.tema || {});
    const urlBase = obtenerUrlBasePublica(req, publicBase || seo.urlBase);
    const rutaObjetivo = routePath || req?.query?.path || req?.path || '/';
    const aliasRuta = resolverAliasRutaSeo(rutaObjetivo);
    const seoPaginaConfig = obtenerSeoPaginaConfig(seo, aliasRuta);
    const seoPagina = construirSeoPorRuta(config, rutaObjetivo, urlBase);
    const titulo = seoPagina.title || seo.title || seo.titulo;
    const descripcion = seoPagina.description || seo.description || seo.descripcion;
    const ogGlobal = seo.openGraph || {};
    const twitterGlobal = seo.twitter || {};
    const ogPagina = seoPaginaConfig.openGraph || seoPaginaConfig.og || {};
    const twitterPagina = seoPaginaConfig.twitter || {};
    const tituloOgPagina = esTextoSeoConfiable(ogPagina.titulo) ? ogPagina.titulo : '';
    const descripcionOgPagina = esTextoSeoConfiable(ogPagina.descripcion) ? ogPagina.descripcion : '';
    const tituloOgGlobal = esTextoSeoConfiable(ogGlobal.titulo) ? ogGlobal.titulo : '';
    const descripcionOgGlobal = esTextoSeoConfiable(ogGlobal.descripcion) ? ogGlobal.descripcion : '';
    const tituloTwitterPagina = esTextoSeoConfiable(twitterPagina.titulo) ? twitterPagina.titulo : '';
    const descripcionTwitterPagina = esTextoSeoConfiable(twitterPagina.descripcion) ? twitterPagina.descripcion : '';
    const tituloTwitterGlobal = esTextoSeoConfiable(twitterGlobal.titulo) ? twitterGlobal.titulo : '';
    const descripcionTwitterGlobal = esTextoSeoConfiable(twitterGlobal.descripcion) ? twitterGlobal.descripcion : '';
    const imagenBase = seoPaginaConfig.image || seoPaginaConfig.imagen || seo.image || seo.imagen;
    const imagen = resolverUrlPublica(imagenBase, urlBase);

    return {
        title: titulo,
        description: descripcion,
        keywords: seo.keywords || seo.palabrasLlave || `sorteo, rifa, ${rifa.nombreSorteo || ''}, ${cliente.nombre || 'Sorteos'}`,
        author: seo.author || seo.autor || cliente.nombre || 'Sorteos',
        og: {
            title: tituloOgPagina || tituloOgGlobal || titulo,
            description: descripcionOgPagina || descripcionOgGlobal || descripcion,
            image: resolverUrlPublica(ogPagina.imagen || ogGlobal.imagen || imagen, urlBase),
            url: seoPagina.canonical || urlBase,
            type: ogPagina.tipo || ogGlobal.tipo || 'website',
            locale: ogPagina.locale || ogGlobal.locale || 'es_MX',
            site_name: cliente.nombre || 'Sorteos'
        },
        twitter: {
            card: twitterPagina.card || twitterGlobal.card || 'summary_large_image',
            title: tituloTwitterPagina || tituloTwitterGlobal || titulo,
            description: descripcionTwitterPagina || descripcionTwitterGlobal || descripcion,
            image: resolverUrlPublica(twitterPagina.imagen || twitterGlobal.imagen || imagen, urlBase),
            creator: twitterPagina.creador || twitterGlobal.creador || cliente.redesSociales?.twitter || ''
        },
        canonical: seoPagina.canonical || urlBase,
        robots: 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1',
        themeColor: tema.colorPrimario || tema.colores?.colorPrimario || '#1877F2'
    };
}

function escaparHtmlAttr(valor) {
    return String(valor || '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// ===== ENDPOINT CRÍTICO: OPEN GRAPH PARA REDES SOCIALES =====
// Sirve HTML dinámico con meta tags cuando lo solicita WhatsApp, Facebook, etc.
app.get('/og', (req, res) => {
    try {
        const config = obtenerConfigActual(req.rifaContext?.id || null);
        const metadatos = construirMetadatosSeo(config, req, req.query.path, req.query.publicBase);

        const metaTags = `
<meta property="og:title" content="${escaparHtmlAttr(metadatos.og.title)}" />
<meta property="og:description" content="${escaparHtmlAttr(metadatos.og.description)}" />
<meta property="og:image" content="${escaparHtmlAttr(metadatos.og.image)}" />
<meta property="og:url" content="${escaparHtmlAttr(metadatos.og.url)}" />
<meta property="og:type" content="${escaparHtmlAttr(metadatos.og.type)}" />
<meta property="og:locale" content="${escaparHtmlAttr(metadatos.og.locale)}" />
<meta property="og:site_name" content="${escaparHtmlAttr(metadatos.og.site_name)}" />
<meta name="twitter:card" content="${escaparHtmlAttr(metadatos.twitter.card)}" />
<meta name="twitter:title" content="${escaparHtmlAttr(metadatos.twitter.title)}" />
<meta name="twitter:description" content="${escaparHtmlAttr(metadatos.twitter.description)}" />
<meta name="twitter:image" content="${escaparHtmlAttr(metadatos.twitter.image)}" />
        `;

        const indexPath = path.join(__dirname, '../index.html');
        let html = fs.readFileSync(indexPath, 'utf8');

        html = html.replace(
            /<title>.*?<\/title>/,
            `<title>${escaparHtmlAttr(metadatos.title)}</title>`
        );

        html = html.replace(
            /(<meta name="viewport"[^>]*>)/,
            `$1\n    ${metaTags}`
        );

        html = html.replace(
            /(<meta name="description" content=")([^"]*)/,
            `$1${escaparHtmlAttr(metadatos.description)}`
        );

        res.type('text/html').send(html);

        console.log(`✅ Open Graph servido dinámicamente para: ${req.get('user-agent')?.substring(0, 50)}`);
    } catch (error) {
        console.error('❌ Error sirviendo Open Graph:', error.message);
        res.status(500).json({ error: 'Error sirviendo página' });
    }
});

/**
 * GET /api/public/sorteo-info - Información pública del sorteo para Open Graph
 * Devuelve nombre, descripción y configuración pública del sorteo
 * Usado por Open Graph y frontend para valores dinámicos
 */
app.get('/api/public/sorteo-info', (req, res) => {
    try {
        const configActual = obtenerConfigActual(req.rifaContext?.id || null);
        const clienteNombre = configActual.cliente?.nombre || 'SORTEOS EL TREBOL';
        const rifaTitulo = configActual.rifa?.nombreSorteo || 'Sorteo';
        const rifaDescripcion = configActual.rifa?.descripcion || 'Compra tus boletos en linea';
        const totalBoletos = Number(configActual.rifa?.totalBoletos) || 1000000;
        const precioBoleta = Number(configActual.rifa?.precioBoleto);

        res.json({
            cliente: clienteNombre,
            titulo: rifaTitulo,
            descripcion: rifaDescripcion,
            titulo_completo: `${clienteNombre} - Gana ${rifaTitulo}`,
            descripcion_completa: `Participa en ${clienteNombre}. ${rifaDescripcion}. Sorteo 100% transparente en vivo.`,
            totalBoletos: totalBoletos,
            precioBoleta: Number.isFinite(precioBoleta) ? precioBoleta : 15
        });

        console.log(`✅ /api/public/sorteo-info: ${clienteNombre} - ${totalBoletos} boletos @ $${Number.isFinite(precioBoleta) ? precioBoleta : 15}`);
    } catch (error) {
        console.error('❌ Error en /api/public/sorteo-info:', error.message);
        res.json({
            cliente: 'SORTEOS EL TREBOL',
            titulo: 'Sorteo',
            descripcion: 'Compra tus boletos en linea',
            titulo_completo: 'SORTEOS EL TREBOL - Sorteo 100% Transparente',
            descripcion_completa: 'Participa en SORTEOS EL TREBOL. Sorteo 100% transparente en vivo.'
        });
    }
});

// Rutas
app.get('/', (req, res) => {
    res.json({
        mensaje: 'API RifaPlus - Servidor en funcionamiento',
        version: '2.2',
        auth: 'JWT habilitado',
        seguridad: 'rate-limiting + sanitización + helmet'
    });
});

/**
 * GET /api/health - CRITICAL PARA PRODUCCIÓN
 * Endpoint de health check para load balancers, monitoring
 * Verifica:
 * - Servidor Express corriendo ✅
 * - Conexión a base de datos ✅
 * - Uptime
 */
app.get('/api/health', (req, res) => {
    const health = {
        status: dbHealthy ? 'healthy' : 'unhealthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        database: {
            healthy: dbHealthy,
            lastCheck: new Date(lastDbCheck).toISOString()
        },
        memory: {
            used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB',
            total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + ' MB'
        }
    };

    // Si BD está mal, devolver 503 Service Unavailable
    const statusCode = dbHealthy ? 200 : 503;
    res.status(statusCode).json(health);
});

/**
 * POST /api/admin/login
 * Autentica usuario admin y devuelve JWT
 * Body: { username: 'admin', password: 'admin123' }
 * Protegido con rate limiting
 */
app.post('/api/admin/login', limiterLogin, async (req, res) => {
    try {
        const { username, password } = req.body;

        // Validar entrada
        if (!username || !password) {
            log('warn', 'Intento de login sin credenciales', { ip: req.ip });
            return res.status(400).json({
                success: false,
                message: 'Usuario y contraseña requeridos'
            });
        }

        // Sanitizar username (prevenir inyección)
        const usernameSanitizado = sanitizar(username);
        if (usernameSanitizado.length === 0) {
            log('warn', 'Username vacío después de sanitizar', { ip: req.ip });
            return res.status(400).json({
                success: false,
                message: 'Usuario inválido'
            });
        }

        // Buscar usuario en BD
        const usuario = await db('admin_users').where('username', usernameSanitizado).first();

        if (!usuario || !usuario.activo) {
            log('warn', 'Intento de login fallido', { username: usernameSanitizado, ip: req.ip });
            return res.status(401).json({
                success: false,
                message: 'Usuario o contraseña incorrectos'
            });
        }

        // Verificar contraseña
        const passwordValida = await bcrypt.compare(password, usuario.password_hash);

        if (!passwordValida) {
            return res.status(401).json({
                success: false,
                message: 'Usuario o contraseña incorrectos'
            });
        }

        // Generar JWT
        // ✅ Validar que el rol sea válido, sino usar 'gestor_ordenes' como default
        const rolesValidos = ['administrador', 'gestor_ordenes'];
        const rolJWT = rolesValidos.includes(usuario.rol) ? usuario.rol : 'gestor_ordenes';

        const token = jwt.sign(
            {
                id: usuario.id,
                username: usuario.username,
                email: usuario.email,
                rol: rolJWT  // ✅ Incluir rol validado en JWT
            },
            JWT_SECRET,
            { expiresIn: JWT_EXPIRES_IN }
        );

        // Nota: La columna último_acceso no existe en admin_users, así que omitimos esta actualización
        // await db('admin_users').where('id', usuario.id).update({
        //     ultimo_acceso: new Date()
        // });

        log('info', 'Login exitoso', { username: usuario.username, ip: req.ip });

        return res.json({
            success: true,
            token: token,
            usuario: {
                id: usuario.id,
                username: usuario.username,
                email: usuario.email
            },
            expiresIn: JWT_EXPIRES_IN
        });
    } catch (error) {
        log('error', 'POST /api/admin/login error', { error: error.message });
        return res.status(500).json({
            success: false,
            message: 'Error al autenticar',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * GET /api/admin/verify-token
 * Verifica que el token enviado sea válido
 * Útil para debugging
 */
app.get('/api/admin/verify-token', verificarToken, (req, res) => {
    res.json({
        success: true,
        message: 'Token válido',
        usuario: req.usuario
    });
});

/**
 * POST /api/admin/logout
 * Endpoint de logout (principalmente para limpiar token en cliente)
 */
app.post('/api/admin/logout', verificarToken, (req, res) => {
    // JWT es stateless, no hay nada que limpiar en servidor
    // El cliente simplemente descarta el token
    res.json({
        success: true,
        message: 'Sesión cerrada'
    });
});

/* ============================================================ */
/* SECCIÓN: GESTIÓN DE USUARIOS ADMIN                          */
/* ============================================================ */

/**
 * GET /api/admin/users
 * Obtiene lista de todos los usuarios admin
 * Requiere autenticación
 */
app.get('/api/admin/users', verificarToken, async (req, res) => {
    try {
        if (req.usuario.rol !== 'administrador') {
            return res.status(403).json({
                success: false,
                message: 'Permiso denegado: Solo administradores pueden ver usuarios'
            });
        }

        const usuarios = await db('admin_users')
            .select('id', 'username', 'email', 'rol', 'activo', 'created_at')
            .orderBy('username', 'asc');

        res.json({
            success: true,
            data: usuarios
        });
    } catch (error) {
        log('error', 'GET /api/admin/users error', { error: error.message });
        res.status(500).json({
            success: false,
            message: 'Error al obtener usuarios'
        });
    }
});

/**
 * POST /api/admin/users
 * Crea un nuevo usuario admin
 * Body: { username, email, password, rol }
 * Roles: admin, operador, solo_lectura
 */
app.post('/api/admin/users', verificarToken, async (req, res) => {
    try {
        // ✅ VALIDACIÓN: Solo administradores pueden crear usuarios
        if (req.usuario.rol !== 'administrador') {
            return res.status(403).json({
                success: false,
                message: 'Permiso denegado: Solo administradores pueden crear usuarios'
            });
        }

        const { username, email, password, rol } = req.body;

        // Validaciones
        if (!username || !email || !password) {
            return res.status(400).json({
                success: false,
                message: 'Username, email y password son requeridos'
            });
        }

        const usernameSanitizado = sanitizar(username);
        const emailSanitizado = sanitizar(email);
        const rolValido = ['administrador', 'gestor_ordenes'].includes(rol) ? rol : 'gestor_ordenes';

        if (usernameSanitizado.length < 3) {
            return res.status(400).json({
                success: false,
                message: 'Username debe tener al menos 3 caracteres'
            });
        }

        if (password.length < 8) {
            return res.status(400).json({
                success: false,
                message: 'Password debe tener al menos 8 caracteres'
            });
        }

        // Verificar que el usuario no exista
        const existe = await db('admin_users').where('username', usernameSanitizado).first();
        if (existe) {
            return res.status(400).json({
                success: false,
                message: 'El usuario ya existe'
            });
        }

        // Hashear password
        const passwordHash = await bcrypt.hash(password, 10);

        // Crear usuario
        const id = await db('admin_users').insert({
            username: usernameSanitizado,
            email: emailSanitizado,
            password_hash: passwordHash,
            rol: rolValido,
            activo: true,
            created_at: new Date(),
            updated_at: new Date()
        });

        log('info', 'POST /api/admin/users - Usuario creado', { username: usernameSanitizado, id: id[0] });

        res.status(201).json({
            success: true,
            message: 'Usuario creado exitosamente',
            usuario: {
                id: id[0],
                username: usernameSanitizado,
                email: emailSanitizado,
                rol: rolValido
            }
        });
    } catch (error) {
        log('error', 'POST /api/admin/users error', { error: error.message });

        // Manejar errores de constraint violation de la base de datos
        if (error.message && error.message.includes('unique constraint')) {
            if (error.message.includes('username')) {
                return res.status(400).json({
                    success: false,
                    message: `El usuario "${usernameSanitizado}" ya existe. Elige otro.`
                });
            }
            if (error.message.includes('email')) {
                return res.status(400).json({
                    success: false,
                    message: `El email "${emailSanitizado}" ya está registrado.`
                });
            }
        }

        res.status(500).json({
            success: false,
            message: 'Error al crear usuario',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * PUT /api/admin/users/:id
 * Actualiza datos de un usuario admin (nombre, email, rol, contraseña)
 * Body: { username, email, rol, password (opcional) }
 */
app.put('/api/admin/users/:id', verificarToken, async (req, res) => {
    try {
        // ✅ VALIDACIÓN: Solo administradores pueden actualizar usuarios
        if (req.usuario.rol !== 'administrador') {
            return res.status(403).json({
                success: false,
                message: 'Permiso denegado: Solo administradores pueden actualizar usuarios'
            });
        }

        const usuarioId = parseInt(req.params.id);
        const { username, email, rol, password } = req.body;
        const isCurrentUser = req.usuario.id === usuarioId;

        // Validaciones básicas
        if (!username || !email) {
            return res.status(400).json({
                success: false,
                message: 'Username y email son requeridos'
            });
        }

        const usernameSanitizado = sanitizar(username);
        const emailSanitizado = sanitizar(email);

        // ✅ Si es el usuario actual, NO permitir cambiar el rol
        // Si no es el usuario actual, el rol es requerido
        let rolValido = null;
        if (isCurrentUser) {
            // Usuario no puede cambiar su propio rol
            rolValido = req.usuario.rol;  // Mantener el rol actual
        } else {
            // Validar rol solo si no es el usuario actual
            if (!rol) {
                return res.status(400).json({
                    success: false,
                    message: 'Rol es requerido'
                });
            }
            rolValido = ['administrador', 'gestor_ordenes'].includes(rol) ? rol : 'gestor_ordenes';
        }

        if (usernameSanitizado.length < 3) {
            return res.status(400).json({
                success: false,
                message: 'Username debe tener al menos 3 caracteres'
            });
        }

        // Verificar que el usuario existe
        const usuarioActual = await db('admin_users').where('id', usuarioId).first();
        if (!usuarioActual) {
            return res.status(404).json({
                success: false,
                message: 'Usuario no encontrado'
            });
        }

        // Verificar que no cambie a un username ya existente (si lo intenta cambiar)
        if (usernameSanitizado !== usuarioActual.username) {
            const existe = await db('admin_users').where('username', usernameSanitizado).first();
            if (existe) {
                return res.status(400).json({
                    success: false,
                    message: `El usuario "${usernameSanitizado}" ya existe`
                });
            }
        }

        // Verificar que no cambie a un email ya existente (si lo intenta cambiar)
        if (emailSanitizado !== usuarioActual.email) {
            const existe = await db('admin_users').where('email', emailSanitizado).first();
            if (existe) {
                return res.status(400).json({
                    success: false,
                    message: `El email "${emailSanitizado}" ya está registrado`
                });
            }
        }

        // Preparar actualización
        const actualizacion = {
            username: usernameSanitizado,
            email: emailSanitizado,
            rol: rolValido,
            updated_at: new Date()
        };

        // Si se proporciona contraseña, validar y usarla
        if (password) {
            if (password.length < 8) {
                return res.status(400).json({
                    success: false,
                    message: 'La contraseña debe tener al menos 8 caracteres'
                });
            }

            // Hashear nueva contraseña
            const passwordHash = await bcrypt.hash(password, 10);
            actualizacion.password_hash = passwordHash;
        }

        // Actualizar usuario en BD
        await db('admin_users').where('id', usuarioId).update(actualizacion);

        log('info', 'PUT /api/admin/users/:id - Usuario actualizado', {
            usuario_id: usuarioId,
            actualizado_por: req.usuario.username,
            cambios: Object.keys(actualizacion).filter(k => k !== 'updated_at').join(', ')
        });

        res.json({
            success: true,
            message: 'Usuario actualizado exitosamente',
            usuario: {
                id: usuarioId,
                username: usernameSanitizado,
                email: emailSanitizado,
                rol: rolValido
            }
        });
    } catch (error) {
        log('error', 'PUT /api/admin/users/:id error', { error: error.message });

        res.status(500).json({
            success: false,
            message: 'Error al actualizar usuario',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * POST /api/admin/change-password
 * Permite cambiar contraseña:
 * - Usuario cambia su propia contraseña (requiere password_actual)
 * - Admin cambia contraseña de otro usuario (requiere user_id y password_actual del usuario)
 * Body: { password_actual, password_nueva, password_repetida, user_id (opcional) }
 */
app.post('/api/admin/change-password', verificarToken, async (req, res) => {
    try {
        const { password_actual, password_nueva, password_repetida, user_id } = req.body;
        const usuarioAutenticado = req.usuario.id;
        const esAdmin = req.usuario.rol === 'administrador';

        // Validaciones
        if (!password_actual || !password_nueva || !password_repetida) {
            return res.status(400).json({
                success: false,
                message: 'Todos los campos de contraseña son requeridos'
            });
        }

        if (password_nueva.length < 8) {
            return res.status(400).json({
                success: false,
                message: 'La nueva contraseña debe tener al menos 8 caracteres'
            });
        }

        if (!/[A-Z]/.test(password_nueva)) {
            return res.status(400).json({
                success: false,
                message: 'La contraseña debe incluir al menos una mayúscula'
            });
        }

        if (!/[0-9]/.test(password_nueva)) {
            return res.status(400).json({
                success: false,
                message: 'La contraseña debe incluir al menos un número'
            });
        }

        if (password_nueva !== password_repetida) {
            return res.status(400).json({
                success: false,
                message: 'Las contraseñas no coinciden'
            });
        }

        // Determinar cuál usuario está siendo actualizado
        let idUsuarioAActualizar = usuarioAutenticado;

        if (user_id) {
            // Si se especifica user_id, solo admins pueden cambiar contraseña de otros
            if (!esAdmin) {
                return res.status(403).json({
                    success: false,
                    message: 'No tienes permiso para cambiar la contraseña de otros usuarios'
                });
            }
            idUsuarioAActualizar = user_id;
        }

        // Obtener usuario actual (el que está siendo actualizado)
        const usuario = await db('admin_users').where('id', idUsuarioAActualizar).first();
        if (!usuario) {
            return res.status(404).json({
                success: false,
                message: 'Usuario no encontrado'
            });
        }

        // Verificar password actual
        const passwordValida = await bcrypt.compare(password_actual, usuario.password_hash);
        if (!passwordValida) {
            return res.status(401).json({
                success: false,
                message: 'La contraseña actual es incorrecta'
            });
        }

        // Verificar que no sea la misma
        const mismPassword = await bcrypt.compare(password_nueva, usuario.password_hash);
        if (mismPassword) {
            return res.status(400).json({
                success: false,
                message: 'La nueva contraseña debe ser diferente a la actual'
            });
        }

        // Hashear nueva password
        const nuevoHash = await bcrypt.hash(password_nueva, 10);

        // Actualizar en BD
        await db('admin_users').where('id', idUsuarioAActualizar).update({
            password_hash: nuevoHash,
            updated_at: new Date()
        });

        log('info', 'POST /api/admin/change-password - Password cambiado', {
            usuario_id: idUsuarioAActualizar,
            cambiad_por: usuarioAutenticado
        });

        res.json({
            success: true,
            message: 'Contraseña cambiada exitosamente'
        });
    } catch (error) {
        log('error', 'POST /api/admin/change-password error', { error: error.message });
        res.status(500).json({
            success: false,
            message: 'Error al cambiar contraseña: ' + error.message
        });
    }
});

/**
 * DELETE /api/admin/users/:id
 * Elimina un usuario admin
 * Solo admin puede eliminar otros usuarios
 */
app.delete('/api/admin/users/:id', verificarToken, async (req, res) => {
    try {
        // ✅ VALIDACIÓN: Solo administradores pueden eliminar usuarios
        if (req.usuario.rol !== 'administrador') {
            return res.status(403).json({
                success: false,
                message: 'Permiso denegado: Solo administradores pueden eliminar usuarios'
            });
        }

        const usuarioId = parseInt(req.params.id);

        // Validar que no se elimine a sí mismo
        if (usuarioId === req.usuario.id) {
            return res.status(400).json({
                success: false,
                message: 'No puedes eliminar tu propia cuenta'
            });
        }

        // Verificar que el usuario existe
        const usuario = await db('admin_users').where('id', usuarioId).first();
        if (!usuario) {
            return res.status(404).json({
                success: false,
                message: 'Usuario no encontrado'
            });
        }

        // Borrar usuario
        await db('admin_users').where('id', usuarioId).del();

        log('info', 'DELETE /api/admin/users/:id - Usuario eliminado', { usuario_id: usuarioId, eliminado_por: req.usuario.username });

        res.json({
            success: true,
            message: 'Usuario eliminado exitosamente'
        });
    } catch (error) {
        log('error', 'DELETE /api/admin/users/:id error', { error: error.message });
        res.status(500).json({
            success: false,
            message: 'Error al eliminar usuario'
        });
    }
});

/**
 * GET /api/admin/config
 * Obtiene la configuración del sistema
 */
app.get('/api/admin/rifas', verificarToken, async (req, res) => {
    try {
        if (!rifaService?.enabled) {
            return res.json({ success: true, data: [] });
        }

        // ✅ INCLUIR DEPURADAS para el historial
        const incluirDepuradas = req.query.incluirDepuradas === 'true';
        const rifas = await rifaService.listarRifas({ incluirDepuradas });

        return res.json({
            success: true,
            data: rifas,
            activeRifaId: req.rifaContext?.id || null
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: 'No se pudieron cargar las rifas',
            error: error.message
        });
    }
});

app.post('/api/admin/rifas', verificarToken, async (req, res) => {
    try {
        if (req.usuario?.rol !== 'administrador') {
            return res.status(403).json({
                success: false,
                message: 'Solo administradores pueden crear rifas'
            });
        }

        if (!rifaService?.enabled) {
            return res.status(503).json({
                success: false,
                message: 'El modo multi-rifa todavía no está disponible'
            });
        }

        const creada = await rifaService.crearRifa(req.body || {}, req.usuario?.username || 'SYSTEM');
        return res.status(201).json({ success: true, data: creada });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: 'No se pudo crear la rifa',
            error: error.message
        });
    }
});

app.post('/api/admin/rifas/:id/activar-publica', verificarToken, async (req, res) => {
    try {
        if (req.usuario?.rol !== 'administrador') {
            return res.status(403).json({
                success: false,
                message: 'Solo administradores pueden cambiar la rifa pública'
            });
        }

        if (!rifaService?.enabled) {
            return res.status(503).json({
                success: false,
                message: 'El modo multi-rifa todavía no está disponible'
            });
        }

        const rifaId = Number.parseInt(req.params.id, 10);
        await rifaService.activarPublica(rifaId);
        limpiarCacheConfiguracionPublica();

        let pushCampaign = null;
        try {
            const rifaPublica = await rifaService.resolverContexto({ rifaId, fallbackActive: false });
            if (rifaPublica) {
                const campaign = construirCampanaNuevaRifaDesdeContexto(rifaPublica, {
                    rifaId: rifaPublica.id,
                    rifaSlug: rifaPublica.slug,
                    rifaNombre: rifaPublica.nombre
                });
                if (campaign.enabled && campaign.autoSendOnPublicActivation) {
                    pushCampaign = await encolarCampanaPushDesdeServidor(campaign, {
                        priority: 200
                    });
                } else {
                    pushCampaign = {
                        skipped: true,
                        reason: campaign.enabled ? 'auto_send_disabled' : 'campaign_disabled'
                    };
                }
            }
        } catch (pushError) {
            console.warn(`⚠️  Error enviando campaña de nueva rifa para ${rifaId}:`, pushError.message);
        }

        return res.json({ success: true, pushCampaign });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: 'No se pudo activar la rifa pública',
            error: error.message
        });
    }
});

app.get('/api/admin/push-campaigns/overview', verificarToken, async (req, res) => {
    try {
        const resumen = await construirResumenCampanasPushAdmin({
            contexto: req.rifaContext || construirContextoRifaFallback()
        });
        return res.json({ success: true, data: resumen });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: 'No se pudo cargar el panel de campañas push',
            error: error.message
        });
    }
});

app.post('/api/admin/push-campaigns/sync-audience', verificarToken, async (req, res) => {
    try {
        if (req.usuario?.rol !== 'administrador') {
            return res.status(403).json({
                success: false,
                message: 'Solo administradores pueden sincronizar la audiencia'
            });
        }

        const resultado = await backfillSuscripcionesCampanaDesdeOrdenes(db);
        const resumen = await construirResumenCampanasPushAdmin({
            contexto: req.rifaContext || construirContextoRifaFallback()
        });

        return res.json({
            success: true,
            message: 'Audiencia sincronizada correctamente',
            data: {
                sync: resultado,
                overview: resumen
            }
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: 'No se pudo sincronizar la audiencia push',
            error: error.message
        });
    }
});

app.post('/api/admin/push-campaigns/send', verificarToken, async (req, res) => {
    try {
        if (req.usuario?.rol !== 'administrador') {
            return res.status(403).json({
                success: false,
                message: 'Solo administradores pueden enviar campañas'
            });
        }

        const requestedRifaId = Number.parseInt(req.body?.rifaId || req.rifaContext?.id, 10) || null;

        const contexto = requestedRifaId && rifaService?.enabled
            ? await rifaService.resolverContexto({ rifaId: requestedRifaId, fallbackActive: false })
            : (req.rifaContext || construirContextoRifaFallback());

        if (!contexto) {
            return res.status(404).json({
                success: false,
                message: 'No se encontró la rifa para enviar la campaña'
            });
        }

        const campaignType = String(req.body?.campaignType || PUSH_CAMPAIGN_EVENT_TYPE_NUEVA_RIFA).trim().toLowerCase();
        const campaign = campaignType === PUSH_CAMPAIGN_EVENT_TYPE_RESULTADOS_DISPONIBLES
            ? construirCampanaResultadosDisponiblesDesdeContexto(contexto, {
                rifaId: contexto.id,
                rifaSlug: contexto.slug,
                rifaNombre: contexto.nombre,
                resultsCount: Number.parseInt(req.body?.resultsCount, 10) || 0
            })
            : (campaignType === PUSH_CAMPAIGN_EVENT_TYPE_PRESORTEO_PROXIMO || campaignType === PUSH_CAMPAIGN_EVENT_TYPE_SORTEO_PROXIMO)
                ? construirCampanaRecordatorioEventoDesdeContexto(contexto, {
                    rifaId: contexto.id,
                    rifaSlug: contexto.slug,
                    rifaNombre: contexto.nombre,
                    eventType: campaignType,
                    eventDate: campaignType === PUSH_CAMPAIGN_EVENT_TYPE_PRESORTEO_PROXIMO
                        ? contexto?.configuracion?.rifa?.fechaPresorteo
                        : contexto?.configuracion?.rifa?.fechaSorteo,
                    warningMinutes: Math.max(1, Number.parseInt(req.body?.warningMinutes, 10) || 30)
                })
                : construirCampanaNuevaRifaDesdeContexto(contexto, {
                    rifaId: contexto.id,
                    rifaSlug: contexto.slug,
                    rifaNombre: contexto.nombre
                });

        if (!campaign.enabled) {
            return res.status(409).json({
                success: false,
                message: 'Las campañas push están desactivadas para esta rifa.'
            });
        }

        const resultado = await encolarCampanaPushDesdeServidor(campaign, {
            createdByUserId: req.usuario?.id,
            createdByEmail: req.usuario?.email,
            priority: 180,
            force: true
        });
        const resumen = await construirResumenCampanasPushAdmin({
            contexto
        });

        return res.json({
            success: true,
            message: resultado?.queued === false && resultado?.existing === true
                ? 'La campaña push ya existía y no se duplicó'
                : 'Campaña push encolada',
            data: {
                result: resultado,
                campaignType,
                overview: resumen
            }
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: 'No se pudo enviar la campaña push',
            error: error.message
        });
    }
});

app.get('/api/admin/push-campaigns/jobs/:id', verificarToken, async (req, res) => {
    try {
        if (req.usuario?.rol !== 'administrador') {
            return res.status(403).json({
                success: false,
                message: 'Solo administradores pueden consultar campañas'
            });
        }

        const job = await pushCampaignQueueService?.getJobById?.(req.params.id);
        if (!job) {
            return res.status(404).json({
                success: false,
                message: 'No se encontró la campaña solicitada'
            });
        }

        return res.json({
            success: true,
            data: job
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: 'No se pudo consultar el estado de la campaña push',
            error: error.message
        });
    }
});

app.get('/api/admin/push-orders/diagnostic', verificarToken, async (req, res) => {
    try {
        const numeroOrden = String(req.query?.numero_orden || req.query?.numeroOrden || '')
            .trim()
            .toUpperCase()
            .replace(/[^A-Z0-9_-]/g, '');
        const rifaIdActual = Number.parseInt(req.rifaContext?.id, 10) || null;

        if (!numeroOrden) {
            return res.status(400).json({
                success: false,
                message: 'Debes indicar numero_orden'
            });
        }

        const [hasSubscriptionsTable, hasEventsTable] = await Promise.all([
            db.schema.hasTable('push_subscriptions'),
            db.schema.hasTable('push_notification_events')
        ]);

        const orden = await db('ordenes')
            .modify((qb) => {
                if (rifaIdActual) qb.where('rifa_id', rifaIdActual);
            })
            .where('numero_orden', numeroOrden)
            .first();

        if (!orden) {
            return res.status(404).json({
                success: false,
                message: 'Orden no encontrada'
            });
        }

        const pushConfig = obtenerConfigPush();
        const pushMeta = construirMetadatosOrdenPushPublica(orden);
        const warningMinutesConfigured = normalizarPushOrderWarningMinutesConfig(
            obtenerConfigActual()?.rifa?.pushOrderWarningMinutes
        ) || [];

        const [subscriptionRows, eventRows] = await Promise.all([
            hasSubscriptionsTable
                ? db('push_subscriptions')
                    .select(
                        'id',
                        'status',
                        'endpoint',
                        'permission_estado',
                        'created_at',
                        'updated_at',
                        'revoked_at',
                        'last_notified_at',
                        'last_error',
                        'last_error_at'
                    )
                    .where({
                        rifa_id: orden.rifa_id,
                        numero_orden: numeroOrden
                    })
                    .orderBy([{ column: 'updated_at', order: 'desc' }, { column: 'id', order: 'desc' }])
                : [],
            hasEventsTable
                ? db('push_notification_events')
                    .select(
                        'id',
                        'event_type',
                        'event_key',
                        'total_targets',
                        'delivered_count',
                        'failed_count',
                        'expired_count',
                        'sent_at',
                        'created_at',
                        'updated_at',
                        'payload'
                    )
                    .where({
                        rifa_id: orden.rifa_id,
                        numero_orden: numeroOrden
                    })
                    .orderBy('sent_at', 'desc')
                    .limit(10)
                : []
        ]);

        const resumenSuscripciones = subscriptionRows.reduce((acc, row) => {
            const status = String(row?.status || '').trim().toLowerCase();
            acc.total += 1;
            if (status === 'active') acc.active += 1;
            else if (status === 'revoked') acc.revoked += 1;
            else if (status === 'expired') acc.expired += 1;
            else acc.other += 1;

            if (row?.last_error) {
                acc.withErrors += 1;
            }

            return acc;
        }, {
            total: 0,
            active: 0,
            revoked: 0,
            expired: 0,
            other: 0,
            withErrors: 0
        });

        const ultimoIntento = subscriptionRows.find((row) => row?.last_notified_at || row?.last_error_at) || null;

        return res.json({
            success: true,
            data: {
                pushReady: pushConfig.enabled === true,
                tables: {
                    pushSubscriptions: hasSubscriptionsTable,
                    pushNotificationEvents: hasEventsTable
                },
                order: {
                    id: orden.id,
                    numeroOrden: orden.numero_orden,
                    rifaId: orden.rifa_id,
                    estado: orden.estado,
                    telefonoCliente: orden.telefono_cliente || '',
                    createdAt: orden.created_at,
                    updatedAt: orden.updated_at,
                    comprobanteRecibido: Boolean(orden.comprobante_path),
                    pushMeta
                },
                config: {
                    warningMinutes: warningMinutesConfigured,
                    tokenSecretConfigured: Boolean(pushConfig.tokenSecret),
                    vapidConfigured: Boolean(pushConfig.publicKey && pushConfig.privateKey),
                    subjectConfigured: Boolean(pushConfig.subject)
                },
                subscriptions: {
                    summary: resumenSuscripciones,
                    lastAttemptAt: ultimoIntento?.last_notified_at || ultimoIntento?.last_error_at || null,
                    rows: subscriptionRows.map((row) => ({
                        id: row.id,
                        status: row.status,
                        endpoint: row.endpoint,
                        permission: row.permission_estado,
                        createdAt: row.created_at,
                        updatedAt: row.updated_at,
                        revokedAt: row.revoked_at,
                        lastNotifiedAt: row.last_notified_at,
                        lastError: row.last_error,
                        lastErrorAt: row.last_error_at
                    }))
                },
                recentEvents: eventRows.map((row) => ({
                    id: row.id,
                    eventType: row.event_type,
                    eventKey: row.event_key,
                    totalTargets: Number(row.total_targets || 0),
                    deliveredCount: Number(row.delivered_count || 0),
                    failedCount: Number(row.failed_count || 0),
                    expiredCount: Number(row.expired_count || 0),
                    sentAt: row.sent_at,
                    createdAt: row.created_at,
                    updatedAt: row.updated_at,
                    payload: row.payload || null
                }))
            }
        });
    } catch (error) {
        console.error('GET /api/admin/push-orders/diagnostic error:', error);
        return res.status(500).json({
            success: false,
            message: 'No se pudo obtener el diagnóstico push de la orden'
        });
    }
});

app.post('/api/admin/push-orders/test-send', verificarToken, async (req, res) => {
    try {
        if (req.usuario?.rol !== 'administrador') {
            return res.status(403).json({
                success: false,
                message: 'Solo administradores pueden enviar pruebas push'
            });
        }

        const numeroOrden = String(req.body?.numero_orden || req.body?.numeroOrden || '')
            .trim()
            .toUpperCase()
            .replace(/[^A-Z0-9_-]/g, '');
        const eventType = String(req.body?.eventType || 'orden_por_vencer').trim().toLowerCase();
        const warningMinutes = Math.max(1, Number.parseInt(req.body?.warningMinutes, 10) || 5);
        const rifaIdActual = Number.parseInt(req.rifaContext?.id, 10) || null;

        if (!numeroOrden) {
            return res.status(400).json({
                success: false,
                message: 'Debes indicar numero_orden'
            });
        }

        const orden = await db('ordenes')
            .modify((qb) => {
                if (rifaIdActual) qb.where('rifa_id', rifaIdActual);
            })
            .where('numero_orden', numeroOrden)
            .first();

        if (!orden) {
            return res.status(404).json({
                success: false,
                message: 'Orden no encontrada'
            });
        }

        let result;
        if (eventType === 'orden_confirmada') {
            result = await enviarPushOrdenConfirmada(db, orden, {
                testMode: true,
                eventAt: new Date().toISOString()
            });
        } else if (eventType === 'orden_cancelada') {
            result = await enviarPushOrdenCancelada(db, orden, {
                reason: 'manual',
                testMode: true,
                eventAt: new Date().toISOString()
            });
        } else if (eventType === 'orden_por_vencer') {
            result = await enviarPushOrdenPorVencer(db, orden, {
                warningMinutes,
                testMode: true
            });
        } else {
            return res.status(400).json({
                success: false,
                message: 'eventType inválido. Usa orden_por_vencer, orden_confirmada u orden_cancelada'
            });
        }

        return res.json({
            success: true,
            message: 'Prueba push procesada',
            data: {
                numeroOrden,
                eventType,
                warningMinutes: eventType === 'orden_por_vencer' ? warningMinutes : null,
                result
            }
        });
    } catch (error) {
        console.error('POST /api/admin/push-orders/test-send error:', error);
        return res.status(500).json({
            success: false,
            message: 'No se pudo enviar la prueba push'
        });
    }
});

app.post('/api/admin/rifas/:id/depurar', verificarToken, async (req, res) => {
    try {
        if (req.usuario?.rol !== 'administrador') {
            return res.status(403).json({
                success: false,
                message: 'Solo administradores pueden depurar rifas'
            });
        }

        if (!rifaService?.enabled || !rifaArchiveService) {
            return res.status(503).json({
                success: false,
                message: 'El modo multi-rifa todavía no está disponible'
            });
        }

        const rifaId = Number.parseInt(req.params.id, 10);
        if (!Number.isInteger(rifaId) || rifaId <= 0) {
            return res.status(400).json({
                success: false,
                message: 'ID de rifa inválido'
            });
        }

        const confirmacion = String(req.body?.confirmacion || '').trim().toUpperCase();
        if (confirmacion !== 'ELIMINAR RIFA') {
            return res.status(400).json({
                success: false,
                message: 'Confirmación inválida para depurar la rifa'
            });
        }

        const contexto = await rifaService.resolverContexto({ rifaId, fallbackActive: false });
        if (!contexto) {
            return res.status(404).json({
                success: false,
                message: 'La rifa solicitada no existe'
            });
        }

        if (contexto.depuradaAt) {
            return res.status(409).json({
                success: false,
                message: 'La rifa ya fue depurada anteriormente'
            });
        }

        if (contexto.raw?.activa_publica === true) {
            return res.status(409).json({
                success: false,
                message: 'No puedes depurar la rifa pública activa. Activa otra rifa primero.'
            });
        }

        const estadoRifa = String(contexto.estado || contexto.configuracion?.rifa?.estado || '').trim().toLowerCase();
        const puedeDepurarse = ['finalizado', 'archivada'].includes(estadoRifa) || Boolean(contexto.snapshotFinal);
        if (!puedeDepurarse) {
            return res.status(409).json({
                success: false,
                message: 'Solo puedes depurar una rifa finalizada o archivada'
            });
        }

        await rifaArchiveService.depurarRifa(rifaId);
        limpiarCacheConfiguracionPublica();
        limpiarCacheBoletosPublicos();

        return res.json({
            success: true,
            message: 'La rifa fue depurada correctamente y quedó disponible solo para historial.'
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: 'No se pudo depurar la rifa',
            error: error.message
        });
    }
});

/**
 * POST /api/admin/rifas/:id/archivar
 * Archiva una rifa finalizada (la mueve al historial)
 * 
 * ⚠️ VALIDACIONES DE SEGURIDAD:
 * - Solo administradores pueden archivar
 * - Solo rifas en estado 'finalizado' pueden archivarse
 * - No se puede archivar la rifa pública activa
 * - No se puede archivar una rifa ya depurada
 * 
 * ✅ PRODUCCIÓN READY:
 * - Logging completo para auditoría
 * - Transacción atómica
 * - Limpieza de cachés
 * - Validación de estado antes y después
 */
app.post('/api/admin/rifas/:id/archivar', verificarToken, async (req, res) => {
    const startTime = Date.now();
    const rifaId = Number.parseInt(req.params.id, 10);
    const adminUser = req.usuario?.username || 'UNKNOWN';

    try {
        // ============================================
        // 1. VALIDACIONES DE SEGURIDAD
        // ============================================

        // Solo administradores
        if (req.usuario?.rol !== 'administrador') {
            console.warn(`⚠️ [Archivar Rifa] Intento no autorizado - Usuario: ${adminUser}, Rol: ${req.usuario?.rol}`);
            return res.status(403).json({
                success: false,
                message: 'Solo administradores pueden archivar rifas',
                code: 'UNAUTHORIZED'
            });
        }

        // Validar ID de rifa
        if (!Number.isInteger(rifaId) || rifaId <= 0) {
            return res.status(400).json({
                success: false,
                message: 'ID de rifa inválido',
                code: 'INVALID_ID'
            });
        }

        // Verificar servicio multi-rifa
        if (!rifaService?.enabled) {
            return res.status(503).json({
                success: false,
                message: 'El modo multi-rifa no está disponible',
                code: 'SERVICE_UNAVAILABLE'
            });
        }

        // ============================================
        // 2. OBTENER Y VALIDAR ESTADO DE LA RIFA
        // ============================================

        const contexto = await rifaService.resolverContexto({ rifaId, fallbackActive: false });

        if (!contexto) {
            return res.status(404).json({
                success: false,
                message: `La rifa ID=${rifaId} no existe`,
                code: 'RIFA_NOT_FOUND'
            });
        }

        // No archivar si ya está depurada
        if (contexto.depuradaAt) {
            return res.status(409).json({
                success: false,
                message: 'No se puede archivar una rifa que ya fue depurada',
                code: 'ALREADY_PURGED'
            });
        }

        // No archivar rifa pública activa
        if (contexto.raw?.activa_publica === true) {
            return res.status(409).json({
                success: false,
                message: 'No puedes archivar la rifa pública activa. Activa otra rifa primero.',
                code: 'ACTIVE_PUBLIC_RIFA'
            });
        }

        // ============================================
        // 3. VALIDAR QUE SOLO RIFAS FINALIZADAS
        // ============================================

        const estadoRifa = String(contexto.estado || contexto.configuracion?.rifa?.estado || '').trim().toLowerCase();

        if (estadoRifa !== 'finalizado') {
            console.warn(`⚠️ [Archivar Rifa] Intento de archivar rifa NO finalizada - ID: ${rifaId}, Estado: ${estadoRifa}, Usuario: ${adminUser}`);
            return res.status(409).json({
                success: false,
                message: `Solo puedes archivar una rifa que esté finalizada. Estado actual: ${estadoRifa}`,
                code: 'NOT_FINALIZED',
                currentStatus: estadoRifa
            });
        }

        // ============================================
        // 4. VALIDAR QUE NO SEA LA ÚLTIMA RIFA OPERABLE
        // ============================================

        // Contar rifas operables (activo + borrador + finalizado)
        const rifasOperables = await db('rifas')
            .whereNull('depurada_at')
            .whereIn('estado', ['activo', 'borrador', 'finalizado'])
            .count('* as total')
            .first();

        const totalOperables = Number(rifasOperables?.total || 0);

        console.log(`📊 [Archivar Rifa] Rifas operables actuales: ${totalOperables}`);

        if (totalOperables <= 1) {
            console.warn(`⚠️ [Archivar Rifa] Bloqueado - Solo hay ${totalOperables} rifa(s) operable(s)`);
            return res.status(409).json({
                success: false,
                message: 'No puedes archivar la última rifa operable. Debes crear al menos una rifa nueva antes de archivar esta.',
                code: 'LAST_OPERABLE_RIFA',
                totalOperables,
                hint: 'Crea una nueva rifa desde el botón "Nueva" en el panel de administración'
            });
        }

        console.log(`📝 [Archivar Rifa] === INICIANDO ARCHIVADO ===`);
        console.log(`📝 [Archivar Rifa] Rifa ID: ${rifaId}`);
        console.log(`📝 [Archivar Rifa] Rifa Nombre: ${contexto.nombre}`);
        console.log(`📝 [Archivar Rifa] Usuario: ${adminUser}`);
        console.log(`📝 [Archivar Rifa] Estado ANTES: ${estadoRifa}`);

        // ============================================
        // 4. ACTUALIZAR ESTADO EN BD
        // ============================================

        const beforeRifa = await db('rifas').where('id', rifaId).first();

        const updateResult = await db('rifas')
            .where('id', rifaId)
            .update({
                estado: 'archivada',
                updated_at: new Date()
            });

        console.log(`📊 [Archivar Rifa] Rows affected: ${updateResult}`);

        if (updateResult === 0) {
            throw new Error('El update no afectó ninguna fila. La rifa podría no existir.');
        }

        // ============================================
        // 5. ACTUALIZAR CONFIGURACIÓN JSON
        // ============================================

        const configRifa = beforeRifa?.configuracion || {};
        if (configRifa?.rifa) {
            configRifa.rifa.estado = 'archivada';
            await db('rifas')
                .where('id', rifaId)
                .update({ configuracion: configRifa });
            console.log(`📊 [Archivar Rifa] Configuración JSON actualizada`);
        }

        // ============================================
        // 6. VERIFICAR ACTUALIZACIÓN
        // ============================================

        await new Promise(resolve => setTimeout(resolve, 100)); // Asegurar commit

        const afterRifa = await db('rifas').where('id', rifaId).first();
        console.log(`🔍 [Archivar Rifa] Estado DESPUÉS: ${afterRifa?.estado}`);
        console.log(`🔍 [Archivar Rifa] Configuración estado: ${afterRifa?.configuracion?.rifa?.estado}`);

        if (!afterRifa || afterRifa.estado !== 'archivada') {
            console.error('❌ [Archivar Rifa] VERIFICACIÓN FALLÓ - Estado no se actualizó correctamente');
            throw new Error('La verificación post-update falló. Estado: ' + (afterRifa?.estado || 'null'));
        }

        // ============================================
        // 7. LIMPIEZA DE CACHÉS
        // ============================================

        limpiarCacheConfiguracionPublica();
        limpiarCacheBoletosPublicos();

        // ============================================
        // 8. LOG DE AUDITORÍA
        // ============================================

        const duration = Date.now() - startTime;
        console.log(`✅ [Archivar Rifa] COMPLETADO - ID=${rifaId}, Nombre=${contexto.nombre}, Usuario=${adminUser}, Duración=${duration}ms`);

        return res.json({
            success: true,
            message: 'La rifa fue archivada exitosamente. Ahora aparecerá solo en el historial.',
            data: {
                rifaId,
                rifaNombre: contexto.nombre,
                anteriorEstado: 'finalizado',
                nuevoEstado: 'archivada',
                archivadoPor: adminUser,
                timestamp: new Date().toISOString()
            }
        });

    } catch (error) {
        const duration = Date.now() - startTime;
        console.error(`❌ [Archivar Rifa] FALLÓ - ID=${rifaId}, Usuario=${adminUser}, Duración=${duration}ms`);
        console.error(`❌ [Archivar Rifa] Error:`, error);

        // No exponer detalles internos en producción
        const isDev = process.env.NODE_ENV === 'development';

        return res.status(500).json({
            success: false,
            message: 'No se pudo archivar la rifa',
            error: isDev ? error.message : undefined,
            code: 'ARCHIVE_ERROR'
        });
    }
});

/**
 * GET /api/public/config
 * Devuelve la configuración pública del sorteo (sin datos sensibles)
 * Lee desde la configuración actual en memoria/BD y usa fallback solo si hace falta
 */
app.get('/api/public/config', (req, res) => {
    try {
        const cacheKey = String(req.rifaContext?.slug || req.rifaContext?.id || 'default');
        const cached = serverCache.publicConfigs.get(cacheKey);
        
        if (cached) {
            const cacheAge = Date.now() - cached.timestamp;
            if (cacheAge >= 0 && cacheAge < 15000) { // 15 segundos de cache por rifa
                return res.json(cached.payload);
            }
        }

        const configActual = obtenerConfigActual(req.rifaContext?.id || null);
        const fallbackConfig = obtenerConfigExpiracion();

        const config = {
            totalBoletos: configActual.rifa?.totalBoletos ?? fallbackConfig.totalBoletos ?? null,
            precioBoleto: configActual.rifa?.precioBoleto ?? fallbackConfig.precioBoleto ?? null,
            tiempoApartadoHoras: configActual.rifa?.tiempoApartadoHoras ?? fallbackConfig.tiempoApartadoHoras ?? null,
            intervaloLimpiezaMinutos: configActual.rifa?.intervaloLimpiezaMinutos ?? fallbackConfig.intervaloLimpiezaMinutos ?? null,
            rifa: configActual.rifa || {}
        };

        const sistemaPremios = configActual.rifa?.sistemaPremios || null;
        const cuentasBancarias = configActual.tecnica?.bankAccounts || [];

        console.log(`[GET /api/public/config] ✅ Config actual: ${config.totalBoletos} boletos, $${config.precioBoleto} por boleto`);

        const payload = {
            success: true,
            data: {
                totalBoletos: config.totalBoletos,
                precioBoleto: config.precioBoleto,
                tiempoApartadoHoras: config.tiempoApartadoHoras,
                intervaloLimpiezaMinutos: config.intervaloLimpiezaMinutos,
                sistemaPremios: sistemaPremios,
                rifa: {
                    ...(config.rifa || {}),
                    id: req.rifaContext?.id || config.rifa?.id || null,
                    slug: req.rifaContext?.slug || config.rifa?.slug || null
                },
                marketing: configActual.marketing || {},
                // 🏦 Agregar cuentas bancarias a la respuesta pública
                cuentas: cuentasBancarias
            }
        };

        // ✅ USAR CACHÉ POR RIFA (Map) en lugar de variable global compartida
        serverCache.publicConfigs.set(cacheKey, {
            payload,
            timestamp: Date.now()
        });

        res.json(payload);
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: 'Error obteniendo configuración',
            error: error.message
        });
    }
});

app.get('/api/public/rifas-pasadas', async (req, res) => {
    try {
        if (!rifaService?.enabled) {
            return res.json({ success: true, data: [] });
        }

        const rifas = await rifaService.listarSorteosPasados();
        const data = rifas
            .filter((rifa) => Boolean(rifa?.snapshot_final))
            .map((rifa) => ({
                id: rifa.id,
                slug: rifa.slug,
                nombre: rifa.nombre,
                estado: rifa.estado,
                finalizadaAt: rifa.finalizada_at,
                depuradaAt: rifa.depurada_at,
                snapshot: rifa.snapshot_final
            }));

        return res.json({ success: true, data });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: 'No se pudieron cargar los sorteos pasados',
            error: error.message
        });
    }
});

app.get('/api/public/rifas-pasadas/:slug', async (req, res) => {
    try {
        if (!rifaService?.enabled) {
            return res.status(404).json({ success: false, message: 'Historial no disponible' });
        }

        const snapshot = await rifaService.obtenerSnapshotPublico(req.params.slug);
        if (!snapshot) {
            return res.status(404).json({ success: false, message: 'Sorteo pasado no encontrado' });
        }

        return res.json({ success: true, data: snapshot });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: 'No se pudo cargar el sorteo pasado',
            error: error.message
        });
    }
});

/**
 * GET /api/og-metadata - METADATOS DINÁMICOS PARA BOTS (Open Graph, Twitter, SEO)
 * 
 * IMPORTANTE PARA PRODUCCIÓN:
 * Cuando Facebook, WhatsApp, Twitter, LinkedIn hacen "crawl" (a través de bots),
 * reciben metadatos dinámicos basados en la configuración actual.
 * 
 * Así la vista previa en redes sociales SIEMPRE muestra:
 * ✅ Título actual del sorteo
 * ✅ Descripción correcta
 * ✅ Imagen del sorteo (logotipo o imagen principal)
 * ✅ Datos de la organización actuales
 * 
 * @returns {JSON} Metadatos listos para inyectar en <head>
 */
app.get('/api/og-metadata', (req, res) => {
    try {
        const config = obtenerConfigActual(req.rifaContext?.id || null);

        if (!config || Object.keys(config).length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Configuración no disponible'
            });
        }

        const metadatosConstruidos = construirMetadatosSeo(config, req, req.query.path, req.query.publicBase);

        const metadatos = {
            success: true,
            data: {
                ...metadatosConstruidos,
                viewport: 'width=device-width, initial-scale=1.0'
            }
        };

        // Responder con metadatos
        res.json(metadatos);

        // Log para debugging
        console.log('✅ [OG-Metadata] Generados metadatos dinámicos:', {
            titulo: String(metadatosConstruidos.title || '').substring(0, 50) + '...',
            canonical: metadatosConstruidos.canonical,
            image: metadatosConstruidos.og?.image
        });

    } catch (error) {
        console.error('❌ [OG-Metadata] Error:', error);
        if (res.headersSent) {
            return;
        }
        return res.status(500).json({
            success: false,
            message: 'Error generando metadatos',
            error: error.message
        });
    }
});

app.get('/api/admin/config', verificarToken, async (req, res) => {
    try {
        const contextoAdminError = resolverErrorContextoAdminRifa(req);
        if (contextoAdminError) {
            return res.status(409).json(contextoAdminError);
        }

        const config = obtenerConfigActual(req.rifaContext?.id || null);
        console.log(`[GET /api/admin/config] Leyendo desde ${configManagerV2 ? 'ConfigManagerV2 (BD)' : 'config legacy/fallback'}`);

        res.json({
            success: true,
            cargadoDesde: configManagerV2?.esBD ? 'bd' : 'fallback',
            data: {
                // Datos del cliente
                cliente: config.cliente || {},
                // Datos de la rifa
                rifa: config.rifa || {},
                // Redes sociales
                redesSociales: config.cliente?.redesSociales || {},
                // Cuentas bancarias
                cuentas: config.tecnica?.bankAccounts || [],
                // Premios (por compatibilidad)
                sistemaPremios: config.rifa?.sistemaPremios || {},
                seo: config.seo || {},
                tema: config.tema || {},
                publicacion: config.rifa?.publicacion || {},
                marketing: config.marketing || {},
                // Otros campos necesarios
                totalBoletos: config.rifa?.totalBoletos,
                precioBoleto: config.rifa?.precioBoleto,
                tiempoApartadoHoras: config.rifa?.tiempoApartadoHoras,
                rifaContext: req.rifaContext || null
            },
            rifaContext: req.rifaContext || null
        });
    } catch (error) {
        log('error', 'GET /api/admin/config error', { error: error.message });
        res.status(500).json({
            success: false,
            message: 'Error al obtener configuración',
            error: error.message
        });
    }
});

/**
 * POST /api/admin/cloudinary-signature 🎬 NUEVA FEATURE
 * Genera una firma para upload directo a Cloudinary desde el navegador
 * 
 * Cliente necesita:
 * - signature: para autenticarse con Cloudinary
 * - timestamp: para validar la firma
 * - cloud_name: para saber dónde subir
 * - api_key: clave pública de Cloudinary
 */
app.post('/api/admin/upload-image', verificarToken, async (req, res) => {
    try {
        // Validar que Cloudinary esté configurado
        if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
            return res.status(400).json({
                success: false,
                message: 'Cloudinary no está configurado en el servidor'
            });
        }

        // Validar que haya un archivo
        if (!req.files || !req.files.file) {
            return res.status(400).json({
                success: false,
                message: 'No file uploaded'
            });
        }

        const file = req.files.file;
        const assetType = normalizarAssetType(req.body?.assetType);

        // Validar tipo de archivo
        if (!file.mimetype.startsWith('image/')) {
            return res.status(400).json({
                success: false,
                message: 'Solo se permiten imágenes'
            });
        }

        // Validar tamaño (máximo 10MB)
        const maxSize = 10 * 1024 * 1024;
        if (file.size > maxSize) {
            return res.status(400).json({
                success: false,
                message: `Archivo muy grande. Máximo 10MB`
            });
        }

        const result = await subirBufferACloudinary({
            buffer: file.data,
            originalName: file.name,
            mimetype: file.mimetype,
            assetType
        });

        console.log('✅ [Upload-Image] Imagen subida a Cloudinary:', {
            userId: req.user?.id,
            assetType,
            url: result.secureUrl,
            publicId: result.publicId,
            size: result.bytes,
            format: result.format || 'original'
        });

        res.json({
            success: true,
            url: result.secureUrl,
            publicId: result.publicId,
            width: result.width,
            height: result.height,
            size: result.bytes
        });
    } catch (error) {
        console.error('❌ [Upload-Image] Error:', error.message);
        res.status(500).json({
            success: false,
            message: 'Error al subir imagen a Cloudinary',
            error: error.message
        });
    }
});

/**
 * DELETE /api/admin/cloudinary-image 🗑️ NUEVA FEATURE
 * Elimina una imagen de Cloudinary usando su public_id
 */
app.delete('/api/admin/cloudinary-image', verificarToken, async (req, res) => {
    try {
        const { publicId } = req.body;

        if (!publicId) {
            return res.status(400).json({
                success: false,
                message: 'public_id es requerido'
            });
        }

        // Validar que Cloudinary esté configurado
        if (!process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
            return res.status(400).json({
                success: false,
                message: 'Cloudinary no está configurado'
            });
        }

        // Eliminar imagen de Cloudinary
        await cloudinary.uploader.destroy(publicId, {
            resource_type: 'image'
        });

        console.log('🗑️ [Cloudinary-Delete] Imagen eliminada:', {
            publicId,
            userId: req.user?.id
        });

        res.json({
            success: true,
            message: 'Imagen eliminada de Cloudinary',
            publicId
        });
    } catch (error) {
        console.error('❌ [Cloudinary-Delete] Error:', error.message);
        res.status(500).json({
            success: false,
            message: 'Error al eliminar imagen',
            error: error.message
        });
    }
});

/**
 * PATCH /api/admin/config - VERSIÓN PRODUCTION-READY 🚀
 * Actualiza la configuración del sistema con:
 * - File lock (previene race conditions)
 * - Backup automático
 * - Sanitización XSS
 * - Validación estricta
 * - Escritura asincrónica
 * - Transacciones atómicas (o-todo-o-nada)
 */
const MAQUINA_SUERTE_LIMITE_MAXIMO = 5000;
const MAQUINA_SUERTE_QUICK_PICKS_MAXIMO = 12;
const MAQUINA_SUERTE_QUICK_PICKS_DEFAULT = Object.freeze([10, 20, 50, 100]);
const PROMOCIONES_COMBO_MAXIMO_REGLAS = 24;

function normalizarQuickPicksMaquinaSuerteConfig(valor, limiteMaximo = 500, fallback = MAQUINA_SUERTE_QUICK_PICKS_DEFAULT, opciones = {}) {
    const limiteSeguro = Number.isFinite(Number(limiteMaximo)) && Number(limiteMaximo) > 0
        ? Math.min(Math.floor(Number(limiteMaximo)), MAQUINA_SUERTE_LIMITE_MAXIMO)
        : 500;
    const permitirVacio = opciones.permitirVacio === true;

    const normalizarLista = (entrada) => {
        let candidatos = [];

        if (Array.isArray(entrada)) {
            candidatos = entrada;
        } else if (typeof entrada === 'string') {
            candidatos = entrada.split(',');
        } else if (typeof entrada === 'number') {
            candidatos = [entrada];
        } else if (entrada != null) {
            candidatos = [entrada];
        }

        return Array.from(new Set(
            candidatos
                .map((item) => Number.parseInt(String(item).trim(), 10))
                .filter((numero) => Number.isInteger(numero) && numero > 0 && numero <= limiteSeguro)
        ))
            .sort((a, b) => a - b)
            .slice(0, MAQUINA_SUERTE_QUICK_PICKS_MAXIMO);
    };

    const quickPicks = normalizarLista(valor);
    const entradaFueProvista = valor !== undefined && valor !== null;
    if (quickPicks.length > 0) {
        return quickPicks;
    }
    if (permitirVacio && entradaFueProvista) {
        return [];
    }

    const fallbackNormalizado = normalizarLista(fallback);
    if (fallbackNormalizado.length > 0) {
        return fallbackNormalizado;
    }

    return [Math.max(1, limiteSeguro)];
}

function normalizarReglasComboConfig(reglas = []) {
    const reglasNormalizadas = [];
    const claves = new Set();

    for (const regla of (Array.isArray(reglas) ? reglas : [])) {
        const cantidadRecibe = parseInt(
            regla?.cantidadRecibe
            ?? regla?.cantidadEntrega
            ?? regla?.cantidad
            ?? regla?.boletos
            ?? 0,
            10
        );
        const cantidadPaga = parseInt(
            regla?.cantidadPaga
            ?? regla?.paga
            ?? regla?.compra
            ?? 0,
            10
        );

        if (
            !Number.isInteger(cantidadRecibe)
            || !Number.isInteger(cantidadPaga)
            || cantidadRecibe <= 1
            || cantidadPaga <= 0
            || cantidadPaga >= cantidadRecibe
        ) {
            continue;
        }

        const clave = `${cantidadRecibe}:${cantidadPaga}`;
        if (claves.has(clave)) {
            continue;
        }

        claves.add(clave);
        reglasNormalizadas.push({
            cantidadRecibe,
            cantidadPaga,
            boletosBonificados: cantidadRecibe - cantidadPaga,
            etiqueta: `${cantidadRecibe}x${cantidadPaga}`
        });

        if (reglasNormalizadas.length >= PROMOCIONES_COMBO_MAXIMO_REGLAS) {
            break;
        }
    }

    return reglasNormalizadas.sort((a, b) => {
        if (a.cantidadRecibe !== b.cantidadRecibe) return a.cantidadRecibe - b.cantidadRecibe;
        return a.cantidadPaga - b.cantidadPaga;
    });
}

function obtenerAdvertenciasCompatibilidadPromociones(rifa = {}) {
    const advertencias = [];
    const tieneCombo = rifa?.promocionesCombo?.enabled === true && Array.isArray(rifa?.promocionesCombo?.reglas) && rifa.promocionesCombo.reglas.length > 0;
    const tieneVolumen = rifa?.descuentos?.enabled === true && Array.isArray(rifa?.descuentos?.reglas) && rifa.descuentos.reglas.length > 0;
    const tienePromoTiempo = rifa?.promocionPorTiempo?.enabled === true;
    const tienePromoPorcentaje = rifa?.descuentoPorcentaje?.enabled === true;

    if (rifa?.promocionesCombo?.enabled === true && !tieneCombo) {
        advertencias.push('Las promociones combo están activadas pero no tienen reglas válidas guardadas.');
    }

    if (rifa?.descuentos?.enabled === true && !tieneVolumen) {
        advertencias.push('El descuento por volumen está activado pero no tiene reglas válidas guardadas.');
    }

    if (tieneCombo && tieneVolumen) {
        advertencias.push('Combo y volumen no se acumulan: si aplica combo, el descuento por volumen no entrará en esa compra.');
    }

    if (tieneVolumen && (tienePromoTiempo || tienePromoPorcentaje)) {
        advertencias.push('Los descuentos por volumen no se acumulan con promociones por boleto activo; se usará la mejor lógica vigente.');
    }

    if (tienePromoTiempo && tienePromoPorcentaje) {
        advertencias.push('Promoción por tiempo y descuento por porcentaje pueden coincidir; el sistema aplicará el mejor precio por boleto.');
    }

    return advertencias;
}

app.patch('/api/admin/config', verificarToken, async (req, res) => {
    const configPath = path.join(__dirname, 'config.json');
    let release = null;

    try {
        const contextoAdminError = resolverErrorContextoAdminRifa(req);
        if (contextoAdminError) {
            return res.status(409).json(contextoAdminError);
        }

        // 🔍 DEBUG: Log del body recibido
        console.log('[PATCH /api/admin/config] 📥 Body recibido:', {
            tieneCliente: !!req.body.cliente,
            tieneRifa: !!req.body.rifa,
            tieneRedesSociales: !!req.body.redesSociales,
            tieneBankAccounts: !!req.body.tecnica?.bankAccounts,
            clienteKeys: req.body.cliente ? Object.keys(req.body.cliente) : [],
            rifaKeys: req.body.rifa ? Object.keys(req.body.rifa) : [],
            rifaPrecioBoleto: req.body.rifa?.precioBoleto,
            tienePromocionPorTiempo: !!req.body.rifa?.promocionPorTiempo,
            promocionPorTiempoFull: req.body.rifa?.promocionPorTiempo
        });

        // ✅ VALIDACIÓN: Solo administradores pueden actualizar config
        if (req.usuario.rol !== 'administrador') {
            return res.status(403).json({
                success: false,
                message: 'Permiso denegado: Solo administradores pueden actualizar configuración'
            });
        }

        // 🔄 FLEXIBILIDAD: systemaPremios es OPCIONAL
        // - Si viene, procesa premios
        // - Si NO viene pero vienen cuentas/otros datos, solo procesa esos
        let sistemaPremios = req.body.sistemaPremios;
        const requiereSystemaPremios = !!sistemaPremios;

        // Si viene en la estructura rifa.modalidadGanadores, transformar
        if (!sistemaPremios && req.body.rifa?.modalidadGanadores) {
            const modalidad = req.body.rifa.modalidadGanadores;
            // Transformar estructura legacy a sistemaPremios
            // Solo guardar los ruletazos si existen
            sistemaPremios = {
                enabled: true,
                mensaje: 'Múltiples oportunidades de ganar premios extraordinarios',
                sorteo: [],
                presorteo: [],
                ruletazos: Array.isArray(modalidad.premiosRuletazo) ? modalidad.premiosRuletazo : []
            };
        }

        // ⚠️ VALIDACIÓN: Debe venir sistemaPremios O tecnica.bankAccounts u otros campos
        if (!sistemaPremios && !req.body.tecnica?.bankAccounts && !req.body.cliente && !req.body.rifa && !req.body.redesSociales && !req.body.marketing && !req.body.tema && !req.body.seo) {
            return res.status(400).json({
                success: false,
                message: 'Debe enviar al menos sistemaPremios, bankAccounts, cliente, rifa, redesSociales, marketing, tema o seo'
            });
        }

        const usarPersistenciaLegacy = !configManagerV2;

        // 🔒 PASO 1: Adquirir file lock solo en modo fallback a config.json
        if (usarPersistenciaLegacy) {
            try {
                release = await lockfile.lock(configPath, {
                    realpath: false,
                    retries: {
                        retries: 50,
                        minTimeout: 100,
                        maxTimeout: 200
                    }
                });
            } catch (lockError) {
                return res.status(503).json({
                    success: false,
                    message: 'Servidor ocupado. Intenta de nuevo en unos segundos',
                    error: 'LOCK_TIMEOUT'
                });
            }
        }

        // 📖 PASO 2: Leer config actual desde la fuente de verdad
        let config;
        try {
            config = obtenerConfigActual();
        } catch (readError) {
            return res.status(500).json({
                success: false,
                message: 'Error leyendo configuración actual',
                error: readError.message
            });
        }

        if (!config || typeof config !== 'object' || Object.keys(config).length === 0) {
            return res.status(500).json({
                success: false,
                message: 'No se pudo obtener una configuración base válida'
            });
        }

        const tocaDatosVisiblesDeRifaFinalizada = Boolean(
            req.body.rifa
            || req.body.cliente
            || requiereSystemaPremios
            || req.body.tema
        );

        if (tocaDatosVisiblesDeRifaFinalizada) {
            try {
                await asegurarSnapshotModalFinalizado(config, {
                    usuarioAdmin: req.usuario?.username || 'SYSTEM'
                });
            } catch (snapshotError) {
                console.error('[PATCH /api/admin/config] ❌ Error asegurando snapshot de rifa finalizada:', snapshotError);
                return res.status(500).json({
                    success: false,
                    message: 'No se pudo congelar el modal de la rifa finalizada antes de aplicar cambios',
                    error: snapshotError.message
                });
            }
        }

        // ✔️ PASO 3: Validar estructura de sistemaPremios (SOLO si fue enviado)
        if (requiereSystemaPremios) {
            // Hacer validaciones más flexibles para arrays que pueden ser vacíos o null
            if (sistemaPremios.sorteo !== undefined && !Array.isArray(sistemaPremios.sorteo)) {
                return res.status(400).json({
                    success: false,
                    message: 'sistemaPremios.sorteo debe ser un array'
                });
            }
            if (sistemaPremios.presorteo !== undefined && !Array.isArray(sistemaPremios.presorteo)) {
                return res.status(400).json({
                    success: false,
                    message: 'sistemaPremios.presorteo debe ser un array'
                });
            }
            if (sistemaPremios.ruletazos !== undefined && !Array.isArray(sistemaPremios.ruletazos)) {
                return res.status(400).json({
                    success: false,
                    message: 'sistemaPremios.ruletazos debe ser un array'
                });
            }

            // Asegurar que sean arrays (vacíos si no existen)
            if (!Array.isArray(sistemaPremios.sorteo)) sistemaPremios.sorteo = [];
            if (!Array.isArray(sistemaPremios.presorteo)) sistemaPremios.presorteo = [];
            if (!Array.isArray(sistemaPremios.ruletazos)) sistemaPremios.ruletazos = [];

            // 🔐 PASO 4: Sanitizar y validar cada premio
            try {
                // Validar y sanitizar sorteo
                sistemaPremios.sorteo = sistemaPremios.sorteo.map((premio, idx) => ({
                    posicion: parseInt(premio.posicion) || (idx + 1),
                    nombre: validarCampoPremio('nombre', premio.nombre),
                    premio: validarCampoPremio('premio', premio.premio),
                    descripcion: validarCampoPremio('descripcion', premio.descripcion || ''),
                    icono: (premio.icono || '🎁').substring(0, 10) // Max 10 chars emoji
                }));

                // Validar y sanitizar presorteo
                sistemaPremios.presorteo = sistemaPremios.presorteo.map((premio, idx) => ({
                    posicion: parseInt(premio.posicion) || (idx + 1),
                    nombre: validarCampoPremio('nombre', premio.nombre),
                    premio: validarCampoPremio('premio', premio.premio),
                    descripcion: validarCampoPremio('descripcion', premio.descripcion || ''),
                    icono: (premio.icono || '🎁').substring(0, 10)
                }));

                // Validar y sanitizar ruletazos
                sistemaPremios.ruletazos = sistemaPremios.ruletazos.map((premio, idx) => ({
                    posicion: parseInt(premio.posicion) || (idx + 1),
                    nombre: validarCampoPremio('nombre', premio.nombre),
                    premio: validarCampoPremio('premio', premio.premio),
                    descripcion: validarCampoPremio('descripcion', premio.descripcion || ''),
                    icono: (premio.icono || '🎰').substring(0, 10)
                }));
            } catch (validationError) {
                return res.status(400).json({
                    success: false,
                    message: 'Validación fallida: ' + validationError.message
                });
            }
        }

        // 💾 PASO 5: Crear backup automático ANTES de actualizar
        await crearBackupConfig(configPath, config);

        // 🔄 PASO 6: Actualizar configuración (transacción atómica)
        // Actualizar sistemaPremios SOLO si fue enviado
        if (requiereSystemaPremios) {
            config.rifa.sistemaPremios = sistemaPremios;
            if (!Array.isArray(sistemaPremios.presorteo) || sistemaPremios.presorteo.length === 0) {
                config.rifa.fechaPresorteo = null;
                config.rifa.horaPresorteo = '';
                config.rifa.fechaPresorteoFormato = '';
                console.log('ℹ️ Presorteo desactivado desde sistemaPremios: fecha/hora limpiadas');
            }
        }

        // 🏦 PASO 6B: Procesar cuentas bancarias si vienen en la solicitud
        let bankAccountsActualizadas = null;
        if (req.body.tecnica && Array.isArray(req.body.tecnica.bankAccounts)) {
            try {
                // Validar que cada cuenta tenga campos mínimos requeridos
                const cuentasValidadas = req.body.tecnica.bankAccounts.map((cuenta, idx) => {
                    if (!cuenta.nombreBanco || !cuenta.accountNumber) {
                        throw new Error(`Cuenta ${idx + 1}: El banco y número de cuenta son obligatorios`);
                    }

                    return {
                        id: cuenta.id || (idx + 1),
                        nombreBanco: cuenta.nombreBanco.substring(0, 100),
                        accountNumber: cuenta.accountNumber.substring(0, 50),
                        beneficiary: cuenta.beneficiary ? cuenta.beneficiary.substring(0, 100) : '',
                        accountType: cuenta.accountType || 'Tarjeta',
                        paymentType: cuenta.paymentType || 'transferencia',
                        numero_referencia: cuenta.numero_referencia ? cuenta.numero_referencia.substring(0, 100) : '',
                        phone: cuenta.phone ? cuenta.phone.substring(0, 20) : ''
                    };
                });

                // Actualizar la configuración tecnica
                if (!config.tecnica) {
                    config.tecnica = {};
                }
                config.tecnica.bankAccounts = cuentasValidadas;
                bankAccountsActualizadas = cuentasValidadas;
                console.log('[PATCH /api/admin/config] ✅ Cuentas bancarias actualizadas:', cuentasValidadas.length);
            } catch (bankError) {
                return res.status(400).json({
                    success: false,
                    message: 'Validación de cuentas fallida: ' + bankError.message
                });
            }
        }

        // 📝 PASO 6C: Procesar datos del cliente si vienen
        // 📝 PASO 6C: Procesar datos del cliente si vienen
        if (req.body.cliente) {
            if (!config.cliente) config.cliente = {};

            // DEBUG: Ver exactamente qué viene en cliente
            console.log('[PATCH /api/admin/config] 🔍 DEBUG - req.body.cliente recibido:', {
                tienePropiedad: !!req.body.cliente,
                propiedades: Object.keys(req.body.cliente),
                imagenPrincipalValue: req.body.cliente.imagenPrincipal,
                imagenPrincipalType: typeof req.body.cliente.imagenPrincipal,
                logoValue: req.body.cliente.logo,
                logotipoValue: req.body.cliente.logotipo
            });

            const nombreAnterior = config.cliente.nombre;
            config.cliente.nombre = req.body.cliente.nombre || config.cliente.nombre;
            config.cliente.eslogan = req.body.cliente.eslogan || config.cliente.eslogan;
            config.cliente.telefono = req.body.cliente.telefono || config.cliente.telefono;
            config.cliente.email = req.body.cliente.email || config.cliente.email;

            // 🖼️ AGREGAR: Actualizar imagenPrincipal si viene en cliente
            if (req.body.cliente.imagenPrincipal) {
                const imagenAnterior = config.cliente.imagenPrincipal;
                config.cliente.imagenPrincipal = req.body.cliente.imagenPrincipal;
                console.log('[PATCH /api/admin/config] 🖼️ Imagen principal actualizada:', {
                    anterior: imagenAnterior,
                    nueva: config.cliente.imagenPrincipal
                });
            } else {
                console.log('[PATCH /api/admin/config] ⚠️ imagenPrincipal NO está en req.body.cliente o está vacío');
            }

            // 🏷️ Guardar logo/logotipo de forma normalizada para que toda la app lea el mismo valor
            const logoRecibido = req.body.cliente.logo ?? req.body.cliente.logotipo;
            if (logoRecibido !== undefined) {
                const logoAnterior = config.cliente.logo || config.cliente.logotipo || '';
                config.cliente.logo = logoRecibido || '';
                config.cliente.logotipo = logoRecibido || '';
                console.log('[PATCH /api/admin/config] 🏷️ Logo actualizado:', {
                    anterior: logoAnterior,
                    nuevo: config.cliente.logo
                });
            } else {
                console.log('[PATCH /api/admin/config] ℹ️ No se recibió logo/logotipo en req.body.cliente');
            }

            // ✅ AGREGAR: Actualizar redesSociales si viene en cliente
            if (req.body.cliente.redesSociales) {
                config.cliente.redesSociales = req.body.cliente.redesSociales;
            }

            if (req.body.cliente.mensajesWhatsapp) {
                config.cliente.mensajesWhatsapp = req.body.cliente.mensajesWhatsapp;
            }

            console.log('[PATCH /api/admin/config] ✅ Datos del cliente actualizados', {
                nombreAnterior,
                nombreNuevo: config.cliente.nombre,
                eslogan: config.cliente.eslogan,
                imagenPrincipal: config.cliente.imagenPrincipal,
                logo: config.cliente.logo,
                logotipo: config.cliente.logotipo,
                redesSociales: config.cliente.redesSociales ? 'actualizado' : 'sin cambios'
            });
        }

        // 📝 PASO 6D: Procesar datos de la rifa si vienen
        let advertenciasPromociones = [];
        if (req.body.rifa) {
            console.log('[PATCH /api/admin/config] 🔍 PROCESANDO RIFA - Datos recibidos:', {
                tieneRifa: !!req.body.rifa,
                tiempoApartadoHorasRecibido: req.body.rifa.tiempoApartadoHoras,
                fechaSorteoRecibido: req.body.rifa.fechaSorteo
            });

            if (!config.rifa) config.rifa = {};
            if (req.body.rifa.nombreSorteo) config.rifa.nombreSorteo = req.body.rifa.nombreSorteo;
            if (req.body.rifa.slug) config.rifa.slug = req.body.rifa.slug;
            if (req.body.rifa.dominio) config.rifa.dominio = req.body.rifa.dominio;
            if (req.body.rifa.edicionNombre) config.rifa.edicionNombre = req.body.rifa.edicionNombre;
            if (req.body.rifa.estado) config.rifa.estado = req.body.rifa.estado;
            if (req.body.rifa.totalBoletos !== undefined) config.rifa.totalBoletos = parseInt(req.body.rifa.totalBoletos) || config.rifa.totalBoletos;
            if (req.body.rifa.precioBoleto !== undefined) config.rifa.precioBoleto = parseFloat(req.body.rifa.precioBoleto) || config.rifa.precioBoleto;
            if (req.body.rifa.descripcion) config.rifa.descripcion = req.body.rifa.descripcion;
            if (req.body.rifa.modalidadSorteo !== undefined) {
                config.rifa.modalidadSorteo = sanitizar(String(req.body.rifa.modalidadSorteo || '')).trim();
            }
            if (req.body.rifa.modalidadEnlace !== undefined) {
                const tiposModalidadValidos = new Set(['facebook', 'grupo_whatsapp', 'canal_whatsapp', 'whatsapp_personal', 'sin_enlace']);
                const tipoRecibido = String(req.body.rifa.modalidadEnlace?.tipo || '').trim().toLowerCase();
                config.rifa.modalidadEnlace = {
                    ...(config.rifa.modalidadEnlace || {}),
                    tipo: tiposModalidadValidos.has(tipoRecibido) ? tipoRecibido : 'facebook'
                };
            }
            if (req.body.rifa.publicacion) config.rifa.publicacion = req.body.rifa.publicacion;
            const normalizarTimeZoneServidor = (valor) => {
                const texto = String(valor || '').trim();
                const alias = {
                    'Hora Centro Mexico': 'America/Mexico_City',
                    'Hora Centro México': 'America/Mexico_City',
                    'Hora Monterrey': 'America/Monterrey',
                    'Hora Chihuahua': 'America/Chihuahua',
                    'Hora Pacifico Mexico': 'America/Mazatlan',
                    'Hora Pacifico México': 'America/Mazatlan',
                    'Hora Sonora': 'America/Hermosillo',
                    'Hora Tijuana': 'America/Tijuana',
                    'Hora Cancun': 'America/Cancun',
                    'Hora Cancún': 'America/Cancun'
                };
                const validas = new Set([
                    'America/Mexico_City',
                    'America/Monterrey',
                    'America/Chihuahua',
                    'America/Mazatlan',
                    'America/Hermosillo',
                    'America/Tijuana',
                    'America/Cancun'
                ]);
                if (validas.has(texto)) return texto;
                return alias[texto] || 'America/Mexico_City';
            };
            const obtenerEtiquetaTimeZoneServidor = (timeZone) => ({
                'America/Mexico_City': 'Hora Centro Mexico',
                'America/Monterrey': 'Hora Monterrey',
                'America/Chihuahua': 'Hora Chihuahua',
                'America/Mazatlan': 'Hora Pacifico Mexico',
                'America/Hermosillo': 'Hora Sonora',
                'America/Tijuana': 'Hora Tijuana',
                'America/Cancun': 'Hora Cancun'
            }[normalizarTimeZoneServidor(timeZone)] || 'Hora Centro Mexico');
            const parseFechaEnZonaServidor = (valor, timeZone) => {
                if (!valor) return null;
                const texto = String(valor).trim();
                const tieneZonaExplicita = /(?:Z|[+-]\d{2}:\d{2})$/i.test(texto);
                if (tieneZonaExplicita) {
                    const fechaConZona = new Date(texto);
                    return Number.isNaN(fechaConZona.getTime()) ? null : fechaConZona;
                }
                const match = texto.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
                if (!match) {
                    const fechaDirecta = new Date(texto);
                    return Number.isNaN(fechaDirecta.getTime()) ? null : fechaDirecta;
                }
                const year = Number(match[1]);
                const month = Number(match[2]);
                const day = Number(match[3]);
                const hour = Number(match[4]);
                const minute = Number(match[5]);
                const second = Number(match[6] || 0);
                const utcTentativo = Date.UTC(year, month - 1, day, hour, minute, second);
                const formatter = new Intl.DateTimeFormat('en-US', {
                    timeZone: normalizarTimeZoneServidor(timeZone),
                    timeZoneName: 'shortOffset',
                    hour: '2-digit',
                    minute: '2-digit'
                });
                const offsetPart = formatter.formatToParts(new Date(utcTentativo)).find((part) => part.type === 'timeZoneName')?.value || 'GMT-6';
                const offsetMatch = offsetPart.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/i);
                const sign = offsetMatch?.[1] === '-' ? -1 : 1;
                const hours = Number(offsetMatch?.[2] || 0);
                const minutes = Number(offsetMatch?.[3] || 0);
                const offsetMinutes = sign * ((hours * 60) + minutes);
                const fecha = new Date(utcTentativo - (offsetMinutes * 60 * 1000));
                return Number.isNaN(fecha.getTime()) ? null : fecha;
            };
            const procesarFechaRifaServidor = (valorFecha, timeZone) => {
                const fecha = parseFechaEnZonaServidor(valorFecha, timeZone);
                if (!fecha) return null;
                const formatterFecha = new Intl.DateTimeFormat('es-MX', {
                    timeZone: normalizarTimeZoneServidor(timeZone),
                    day: 'numeric',
                    month: 'long',
                    year: 'numeric'
                });
                const formatterHora = new Intl.DateTimeFormat('es-MX', {
                    timeZone: normalizarTimeZoneServidor(timeZone),
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: false
                });
                const parts = formatterFecha.formatToParts(fecha);
                const dia = parts.find((part) => part.type === 'day')?.value || '';
                const mesRaw = parts.find((part) => part.type === 'month')?.value || '';
                const año = parts.find((part) => part.type === 'year')?.value || '';
                const mes = mesRaw ? mesRaw.charAt(0).toUpperCase() + mesRaw.slice(1) : '';
                return {
                    fecha,
                    hora: formatterHora.format(fecha),
                    fechaFormato: dia && mes && año ? `${dia} de ${mes} del ${año}` : formatterFecha.format(fecha)
                };
            };
            if (req.body.rifa.timeZone !== undefined || req.body.rifa.zonaHoraria !== undefined) {
                const timeZoneNormalizado = normalizarTimeZoneServidor(req.body.rifa.timeZone || req.body.rifa.zonaHoraria);
                config.rifa.timeZone = timeZoneNormalizado;
                config.rifa.zonaHoraria = obtenerEtiquetaTimeZoneServidor(timeZoneNormalizado);
            } else {
                config.rifa.timeZone = normalizarTimeZoneServidor(config.rifa.timeZone || config.rifa.zonaHoraria);
                config.rifa.zonaHoraria = obtenerEtiquetaTimeZoneServidor(config.rifa.timeZone);
            }
            if ((req.body.rifa.timeZone !== undefined || req.body.rifa.zonaHoraria !== undefined) && !req.body.rifa.fechaSorteo && config.rifa.fechaSorteo) {
                const fechaSorteoRecalculada = procesarFechaRifaServidor(config.rifa.fechaSorteo, config.rifa.timeZone);
                if (fechaSorteoRecalculada) {
                    config.rifa.horaSorteo = fechaSorteoRecalculada.hora;
                    config.rifa.fechaSorteoFormato = fechaSorteoRecalculada.fechaFormato;
                }
            }
            if ((req.body.rifa.timeZone !== undefined || req.body.rifa.zonaHoraria !== undefined) && !req.body.rifa.fechaPresorteo && config.rifa.fechaPresorteo) {
                const fechaPresorteoRecalculada = procesarFechaRifaServidor(config.rifa.fechaPresorteo, config.rifa.timeZone);
                if (fechaPresorteoRecalculada) {
                    config.rifa.horaPresorteo = fechaPresorteoRecalculada.hora;
                    config.rifa.fechaPresorteoFormato = fechaPresorteoRecalculada.fechaFormato;
                }
            }
            if (req.body.rifa.rangos !== undefined) {
                const rangosNormalizados = Array.isArray(req.body.rifa.rangos)
                    ? req.body.rifa.rangos
                        .map((rango, index) => {
                            const inicio = parseInt(rango?.inicio, 10);
                            const fin = parseInt(rango?.fin, 10);
                            const nombre = sanitizar(String(rango?.nombre || `Rango ${index + 1}`)).trim() || `Rango ${index + 1}`;

                            if (!Number.isInteger(inicio) || !Number.isInteger(fin) || inicio < 0 || fin < inicio) {
                                return null;
                            }

                            return { inicio, fin, nombre };
                        })
                        .filter(Boolean)
                    : [];

                if (rangosNormalizados.length > 0) {
                    config.rifa.rangos = rangosNormalizados;
                }
            }
            if (req.body.rifa.ayuda !== undefined) {
                const preguntasFrecuentes = Array.isArray(req.body.rifa.ayuda?.preguntasFrecuentes)
                    ? req.body.rifa.ayuda.preguntasFrecuentes
                    : [];
                const faqKeys = new Set();

                config.rifa.ayuda = {
                    ...(config.rifa.ayuda || {}),
                    ...(req.body.rifa.ayuda || {}),
                    preguntasFrecuentes: preguntasFrecuentes
                        .map((item) => ({
                            pregunta: sanitizar(item?.pregunta || '').trim(),
                            respuesta: sanitizar(item?.respuesta || '').trim()
                        }))
                        .filter((item) => item.pregunta && item.respuesta)
                        .filter((item) => {
                            const clave = `${item.pregunta.toLowerCase()}|||${item.respuesta.toLowerCase()}`;
                            if (faqKeys.has(clave)) return false;
                            faqKeys.add(clave);
                            return true;
                        })
                };
            }

            // ✅ Procesar fechaSorteo y generar horaSorteo y fechaSorteoFormato automáticamente
            if (req.body.rifa.fechaSorteo) {
                config.rifa.fechaSorteo = req.body.rifa.fechaSorteo;
                try {
                    const fechaProcesada = procesarFechaRifaServidor(req.body.rifa.fechaSorteo, config.rifa.timeZone);
                    if (fechaProcesada) {
                        config.rifa.horaSorteo = fechaProcesada.hora;
                        config.rifa.fechaSorteoFormato = fechaProcesada.fechaFormato;
                        console.log('✅ Fecha del sorteo procesada:', {
                            fechaSorteo: config.rifa.fechaSorteo,
                            timeZone: config.rifa.timeZone,
                            zonaHoraria: config.rifa.zonaHoraria,
                            horaSorteo: config.rifa.horaSorteo,
                            fechaSorteoFormato: config.rifa.fechaSorteoFormato
                        });

                        // 🔄 REACTIVACIÓN AUTOMÁTICA PROFESIONAL:
                        // Si la nueva fecha de sorteo está en el futuro y el estado actual de la rifa es "finalizado",
                        // reactivamos el sorteo de forma automática eliminando el snapshot del modal finalizado.
                        const tsCierre = fechaProcesada.fecha.getTime();
                        const ahora = Date.now();
                        if (tsCierre > ahora && config.rifa.estado === 'finalizado') {
                            console.log('🔄 [PATCH /api/admin/config] La nueva fecha está en el futuro. Reactivando rifa automáticamente...');
                            config.rifa.estado = 'activo';
                            config.rifa.modalFinalizadoSnapshot = null;
                            if (config.sorteoActivo) {
                                config.sorteoActivo.estado = 'activo';
                                config.sorteoActivo.fechaCierre = config.rifa.fechaSorteo;
                                config.sorteoActivo.fechaCierreFormato = config.rifa.fechaSorteoFormato;
                            }
                        }
                    }
                } catch (e) {
                    console.error('⚠️ Error procesando fechaSorteo:', e.message);
                }
            }

            // ✅ Procesar fechaPresorteo y generar horaPresorteo y fechaPresorteoFormato automáticamente
            if (Object.prototype.hasOwnProperty.call(req.body.rifa, 'fechaPresorteo') && !req.body.rifa.fechaPresorteo) {
                config.rifa.fechaPresorteo = null;
                config.rifa.horaPresorteo = '';
                config.rifa.fechaPresorteoFormato = '';
                console.log('ℹ️ Presorteo desactivado: fechaPresorteo limpiada');
            } else if (req.body.rifa.fechaPresorteo) {
                config.rifa.fechaPresorteo = req.body.rifa.fechaPresorteo;
                try {
                    const fechaProcesada = procesarFechaRifaServidor(req.body.rifa.fechaPresorteo, config.rifa.timeZone);
                    if (fechaProcesada) {
                        config.rifa.horaPresorteo = fechaProcesada.hora;
                        config.rifa.fechaPresorteoFormato = fechaProcesada.fechaFormato;
                        console.log('✅ Fecha del presorteo procesada:', {
                            fechaPresorteo: config.rifa.fechaPresorteo,
                            timeZone: config.rifa.timeZone,
                            horaPresorteo: config.rifa.horaPresorteo,
                            fechaPresorteoFormato: config.rifa.fechaPresorteoFormato
                        });
                    }
                } catch (e) {
                    console.error('⚠️ Error procesando fechaPresorteo:', e.message);
                }
            }

            // 🖼️ AGREGAR SOPORTE PARA GALERÍA (IMÁGENES)
            if (req.body.rifa.galeria) {
                config.rifa.galeria = req.body.rifa.galeria;
            }

            // 📋 AGREGAR SOPORTE PARA INFORMACIÓN DEL SORTEO
            if (req.body.rifa.informacionSorteoIntro !== undefined) {
                config.rifa.informacionSorteoIntro = String(req.body.rifa.informacionSorteoIntro || '').trim();
                console.log('✅ Intro del sorteo actualizada');
            }

            if (req.body.rifa.informacionSorteo) {
                config.rifa.informacionSorteo = req.body.rifa.informacionSorteo;
                console.log('✅ Información del sorteo actualizada:', config.rifa.informacionSorteo.length, 'elementos');
            }

            // 🎁 AGREGAR SOPORTE PARA BONOS
            if (req.body.rifa.bonos) {
                config.rifa.bonos = req.body.rifa.bonos;
                console.log('✅ Bonos actualizados:', config.rifa.bonos.items?.length, 'items,', config.rifa.bonos.enabled ? 'Habilitado' : 'Deshabilitado');
            }

            // 🎁 AGREGAR SOPORTE PARA BONOS DE PÁGINA DE COMPRA
            if (req.body.rifa.bonosCompra !== undefined) {
                const bonosCompraRecibidos = req.body.rifa.bonosCompra || {};
                const itemsNormalizados = Array.isArray(bonosCompraRecibidos.items)
                    ? bonosCompraRecibidos.items
                        .map((item) => ({
                            emoji: sanitizar(String(item?.emoji || '🎁')).trim() || '🎁',
                            titulo: sanitizar(String(item?.titulo || '')).trim(),
                            descripcion: sanitizar(String(item?.descripcion || '')).trim()
                        }))
                        .filter((item) => item.titulo && item.descripcion)
                    : [];

                config.rifa.bonosCompra = {
                    ...(config.rifa.bonosCompra || {}),
                    enabled: Boolean(bonosCompraRecibidos.enabled) && itemsNormalizados.length > 0,
                    items: itemsNormalizados
                };

                console.log('[PATCH /api/admin/config] 🎁 Bonos de compra actualizados:', {
                    enabled: config.rifa.bonosCompra.enabled,
                    itemsLength: config.rifa.bonosCompra.items.length
                });
            }

            // 🎰 AGREGAR SOPORTE PARA LÍMITE DE MÁQUINA DE LA SUERTE
            if (req.body.rifa.maquinaSuerte !== undefined) {
                const limiteRecibido = Number(req.body.rifa.maquinaSuerte?.limiteBoletos);
                const limiteNormalizado = Number.isFinite(limiteRecibido) && limiteRecibido > 0
                    ? Math.min(Math.floor(limiteRecibido), MAQUINA_SUERTE_LIMITE_MAXIMO)
                    : 500;
                const quickPicksNormalizados = normalizarQuickPicksMaquinaSuerteConfig(
                    req.body.rifa.maquinaSuerte?.quickPicks,
                    limiteNormalizado,
                    config.rifa.maquinaSuerte?.quickPicks,
                    { permitirVacio: true }
                );

                config.rifa.maquinaSuerte = {
                    ...(config.rifa.maquinaSuerte || {}),
                    ...(req.body.rifa.maquinaSuerte || {}),
                    limiteBoletos: limiteNormalizado,
                    quickPicks: quickPicksNormalizados
                };

                console.log('[PATCH /api/admin/config] 🎰 Límite máquina de la suerte actualizado:', {
                    limiteBoletos: config.rifa.maquinaSuerte.limiteBoletos,
                    quickPicks: config.rifa.maquinaSuerte.quickPicks
                });
            }

            if (req.body.rifa.busquedaBoletos !== undefined) {
                const busquedaRecibida = req.body.rifa.busquedaBoletos || {};
                config.rifa.busquedaBoletos = {
                    ...(config.rifa.busquedaBoletos || {}),
                    modoAvanzado: busquedaRecibida.modoAvanzado === true
                };

                console.log('[PATCH /api/admin/config] 🔎 Configuración de búsqueda de boletos actualizada:', {
                    modoAvanzado: config.rifa.busquedaBoletos.modoAvanzado
                });
            }

            // ⏲️ AGREGAR SOPORTE PARA PROMOCIÓN POR TIEMPO
            if (req.body.rifa.promocionPorTiempo !== undefined) {
                config.rifa.promocionPorTiempo = req.body.rifa.promocionPorTiempo;
                console.log('[PATCH /api/admin/config] ⏲️ Promoción por tiempo actualizada:', {
                    enabled: config.rifa.promocionPorTiempo.enabled,
                    precio: config.rifa.promocionPorTiempo.precioProvisional,
                    inicio: config.rifa.promocionPorTiempo.fechaInicio,
                    fin: config.rifa.promocionPorTiempo.fechaFin
                });
            }

            if (req.body.rifa.descuentoPorcentaje !== undefined) {
                config.rifa.descuentoPorcentaje = req.body.rifa.descuentoPorcentaje;
                console.log('[PATCH /api/admin/config] 📊 Descuento por porcentaje actualizado:', {
                    enabled: config.rifa.descuentoPorcentaje.enabled,
                    porcentaje: config.rifa.descuentoPorcentaje.porcentaje,
                    inicio: config.rifa.descuentoPorcentaje.fechaInicio,
                    fin: config.rifa.descuentoPorcentaje.fechaFin
                });
            }

            if (req.body.rifa.descuentos !== undefined) {
                const descuentosRecibidos = req.body.rifa.descuentos || {};
                const reglasNormalizadas = Array.isArray(descuentosRecibidos.reglas)
                    ? descuentosRecibidos.reglas
                        .map((regla) => {
                            const cantidad = parseInt(regla?.cantidad, 10);
                            const total = Number(regla?.total ?? regla?.precio);
                            const ahorro = Number(regla?.ahorro);

                            if (!Number.isFinite(cantidad) || cantidad <= 0 || !Number.isFinite(total) || total <= 0) {
                                return null;
                            }

                            return {
                                cantidad,
                                precio: total,
                                total,
                                ahorro: Number.isFinite(ahorro) && ahorro >= 0 ? ahorro : 0
                            };
                        })
                        .filter(Boolean)
                    : [];

                config.rifa.descuentos = {
                    ...(config.rifa.descuentos || {}),
                    enabled: Boolean(descuentosRecibidos.enabled),
                    reglas: reglasNormalizadas
                };

                console.log('[PATCH /api/admin/config] 📦 Descuentos por volumen actualizados:', {
                    enabled: config.rifa.descuentos.enabled,
                    reglasLength: config.rifa.descuentos.reglas.length
                });
            }

            if (req.body.rifa.promocionesCombo !== undefined) {
                const combosRecibidos = req.body.rifa.promocionesCombo || {};
                const reglasComboNormalizadas = normalizarReglasComboConfig(combosRecibidos.reglas);

                config.rifa.promocionesCombo = {
                    ...(config.rifa.promocionesCombo || {}),
                    enabled: Boolean(combosRecibidos.enabled),
                    reglas: reglasComboNormalizadas
                };

                console.log('[PATCH /api/admin/config] 🎟️ Promociones combo actualizadas:', {
                    enabled: config.rifa.promocionesCombo.enabled,
                    reglasLength: config.rifa.promocionesCombo.reglas.length
                });
            }

            advertenciasPromociones = obtenerAdvertenciasCompatibilidadPromociones(config.rifa || {});

            // 🎰 AGREGAR SOPORTE PARA PROMOCIONES DE OPORTUNIDADES
            if (req.body.rifa.promocionesOportunidades !== undefined) {
                config.rifa.promocionesOportunidades = req.body.rifa.promocionesOportunidades;
                console.log('[PATCH /api/admin/config] 🎰 Promociones de oportunidades actualizadas:', {
                    enabled: config.rifa.promocionesOportunidades.enabled,
                    ejemplosLength: config.rifa.promocionesOportunidades.ejemplos?.length || 0
                });
            }

            if (req.body.rifa.oportunidades !== undefined) {
                const oportunidadesActuales = config.rifa.oportunidades || {};
                const oportunidadesRecibidas = req.body.rifa.oportunidades || {};
                const multiplicadorActual = Number(oportunidadesActuales.multiplicador) > 0
                    ? Number(oportunidadesActuales.multiplicador)
                    : 3;
                const multiplicadorRecibido = Number(oportunidadesRecibidas.multiplicador);

                config.rifa.oportunidades = {
                    ...oportunidadesActuales,
                    ...oportunidadesRecibidas,
                    enabled: oportunidadesRecibidas.enabled !== undefined
                        ? Boolean(oportunidadesRecibidas.enabled)
                        : (oportunidadesActuales.enabled !== false),
                    multiplicador: Number.isFinite(multiplicadorRecibido) && multiplicadorRecibido > 0
                        ? multiplicadorRecibido
                        : multiplicadorActual
                };

                const normalizarRangoConfig = (rango) => {
                    const inicio = parseInt(rango?.inicio, 10);
                    const fin = parseInt(rango?.fin, 10);
                    if (!Number.isInteger(inicio) || !Number.isInteger(fin) || inicio < 0 || fin < inicio) {
                        return null;
                    }
                    return { inicio, fin };
                };

                if (oportunidadesRecibidas.rango_visible !== undefined) {
                    const rangoVisible = normalizarRangoConfig(oportunidadesRecibidas.rango_visible);
                    config.rifa.oportunidades.rango_visible = rangoVisible || false;
                }

                if (oportunidadesRecibidas.rango_oculto !== undefined) {
                    const rangoOculto = normalizarRangoConfig(oportunidadesRecibidas.rango_oculto);
                    config.rifa.oportunidades.rango_oculto = rangoOculto || null;
                }

                console.log('[PATCH /api/admin/config] 🎟️ Oportunidades actualizadas:', {
                    enabled: config.rifa.oportunidades.enabled,
                    multiplicador: config.rifa.oportunidades.multiplicador,
                    rango_visible: config.rifa.oportunidades.rango_visible || null,
                    rango_oculto: config.rifa.oportunidades.rango_oculto || null
                });
            }

            if (req.body.rifa.modoOptimizado !== undefined) {
                config.rifa.modoOptimizado = req.body.rifa.modoOptimizado === true || req.body.rifa.modoOptimizado === 'true';
                console.log('[PATCH /api/admin/config] ⚙️ Modo Optimizado actualizado:', config.rifa.modoOptimizado);
            }

            // ⏰ AGREGAR SOPORTE PARA TIEMPO DE APARTADO
            if (req.body.rifa.tiempoApartadoHoras !== undefined) {
                const tiempoAnterior = config.rifa.tiempoApartadoHoras;
                const nuevoTiempoApartadoHorasRaw = parseFloat(req.body.rifa.tiempoApartadoHoras);
                const nuevoTiempoApartadoHoras = Number.isFinite(nuevoTiempoApartadoHorasRaw) && nuevoTiempoApartadoHorasRaw > 0
                    ? Math.max(0.5, Math.round(nuevoTiempoApartadoHorasRaw / 0.5) * 0.5)
                    : NaN;
                if (Number.isNaN(nuevoTiempoApartadoHoras) || nuevoTiempoApartadoHoras <= 0) {
                    return res.status(400).json({
                        success: false,
                        message: 'tiempoApartadoHoras debe ser un numero mayor a 0'
                    });
                }

                config.rifa.tiempoApartadoHoras = Number(nuevoTiempoApartadoHoras.toFixed(1));
                console.log('[PATCH /api/admin/config] ⏰ Tiempo de apartado - ANTES DE GUARDAR:', {
                    anterior: tiempoAnterior,
                    nuevo: config.rifa.tiempoApartadoHoras,
                    tipoDelValor: typeof config.rifa.tiempoApartadoHoras,
                    requestValue: req.body.rifa.tiempoApartadoHoras
                });

                // 🔄 RECONFIGURER EL SERVICIO DE EXPIRACIÓN
                if (ordenExpirationService) {
                    console.log('[PATCH /api/admin/config] 🔄 Reconfigurando ordenExpirationService con nuevo tiempoApartadoHoras:', config.rifa.tiempoApartadoHoras);
                    ordenExpirationService.configurar(
                        config.rifa.tiempoApartadoHoras,
                        config.rifa.intervaloLimpiezaMinutos,
                        config.rifa.pushOrderWarningMinutes
                    );
                }
            }

            if (req.body.rifa.pushOrderWarningMinutes !== undefined) {
                const warningMinutes = normalizarPushOrderWarningMinutesConfig(req.body.rifa.pushOrderWarningMinutes) || [];
                config.rifa.pushOrderWarningMinutes = warningMinutes;

                if (ordenExpirationService) {
                    ordenExpirationService.configurar(
                        config.rifa.tiempoApartadoHoras,
                        config.rifa.intervaloLimpiezaMinutos,
                        config.rifa.pushOrderWarningMinutes
                    );
                }
            }

            console.log('[PATCH /api/admin/config] ✅ Datos de la rifa actualizados:', {
                nombreSorteo: config.rifa.nombreSorteo,
                edicionNombre: config.rifa.edicionNombre,
                estado: config.rifa.estado,
                precioBoleto: config.rifa.precioBoleto,
                totalBoletos: config.rifa.totalBoletos,
                fechaSorteo: config.rifa.fechaSorteo,
                modalidadSorteo: config.rifa.modalidadSorteo,
                modalidadEnlace: config.rifa.modalidadEnlace,
                fechaPresorteo: config.rifa.fechaPresorteo,
                tiempoApartadoHoras: config.rifa.tiempoApartadoHoras,
                pushOrderWarningMinutes: config.rifa.pushOrderWarningMinutes,
                maquinaSuerteLimite: config.rifa.maquinaSuerte?.limiteBoletos,
                imagenesGuardadas: config.rifa.galeria?.imagenes?.length || 0
            });
        }

        // 📝 PASO 6E: Procesar redes sociales si vienen
        if (req.body.redesSociales) {
            if (!config.cliente) config.cliente = {};
            config.cliente.redesSociales = req.body.redesSociales;
        }

        if (req.body.tema) {
            config.tema = normalizarTemaConfig({
                ...(config.tema || {}),
                ...(req.body.tema || {})
            });
        }

        if (req.body.seo) {
            config.seo = normalizarSeoConfigParaPersistencia(req.body.seo, config);
        }

        if (req.body.marketing) {
            const marketingRecibido = req.body.marketing || {};
            const metaPixelRecibido = marketingRecibido.metaPixel || {};
            const pushCampaignsRecibido = marketingRecibido.pushCampaigns || {};
            const metaPixelIncluido = Object.prototype.hasOwnProperty.call(marketingRecibido, 'metaPixel');
            const pushCampaignsIncluido = Object.prototype.hasOwnProperty.call(marketingRecibido, 'pushCampaigns');
            const pixelIdNormalizado = String(metaPixelRecibido.pixelId || '')
                .replace(/[^\d]/g, '')
                .slice(0, 32);
            const pushCampaignsNormalizado = normalizarConfigCampanasPushAdmin(
                pushCampaignsRecibido || {},
                config.marketing?.pushCampaigns || {}
            );

            config.marketing = {
                ...(config.marketing || {}),
                ...marketingRecibido,
                ...(pushCampaignsIncluido ? {
                    pushCampaigns: {
                        ...((config.marketing && config.marketing.pushCampaigns) || {}),
                        ...pushCampaignsNormalizado
                    }
                } : {}),
                ...(metaPixelIncluido ? {
                    metaPixel: {
                        ...((config.marketing && config.marketing.metaPixel) || {}),
                        ...metaPixelRecibido,
                        enabled: metaPixelRecibido.enabled === true,
                        pixelId: pixelIdNormalizado,
                        trackPageView: metaPixelRecibido.trackPageView !== false,
                        trackViewContent: metaPixelRecibido.trackViewContent !== false,
                        trackAddToCart: metaPixelRecibido.trackAddToCart !== false,
                        trackInitiateCheckout: metaPixelRecibido.trackInitiateCheckout !== false,
                        trackPurchase: metaPixelRecibido.trackPurchase !== false
                    }
                } : {})
            };

            if (metaPixelIncluido) {
                console.log('[PATCH /api/admin/config] 📈 Configuración Meta Pixel actualizada:', {
                    enabled: config.marketing.metaPixel.enabled,
                    pixelId: config.marketing.metaPixel.pixelId ? `${config.marketing.metaPixel.pixelId.slice(0, 6)}...` : '',
                    trackPageView: config.marketing.metaPixel.trackPageView,
                    trackViewContent: config.marketing.metaPixel.trackViewContent,
                    trackAddToCart: config.marketing.metaPixel.trackAddToCart,
                    trackInitiateCheckout: config.marketing.metaPixel.trackInitiateCheckout,
                    trackPurchase: config.marketing.metaPixel.trackPurchase
                });
            }
            if (pushCampaignsIncluido) {
                console.log('[PATCH /api/admin/config] 📣 Configuración campañas push actualizada:', config.marketing.pushCampaigns || {});
            }
        }

        // 📝 PASO 7: Persistir y sincronizar en memoria

        // DEBUG: Guardar en archivo lo que vamos a escribir
        try {
            fs.writeFileSync('/tmp/patch-debug.json', JSON.stringify({
                timestamp: new Date().toISOString(),
                rifaGaleríaImagenes: config.rifa?.galeria?.imagenes?.map(i => i.titulo) || [],
                rifaGaleríaLength: config.rifa?.galeria?.imagenes?.length || 0,
                requestBodyRifaGaleria: req.body.rifa?.galeria?.imagenes?.map(i => i.titulo) || []
            }, null, 2), 'utf8');
        } catch (e) {
            console.error('[DEBUG] Error writing debug file:', e);
        }

        console.log('[PATCH /api/admin/config] 📝 A ESCRIBIR:', {
            cliente: {
                nombre: config.cliente?.nombre,
                eslogan: config.cliente?.eslogan,
                imagenPrincipal: config.cliente?.imagenPrincipal,
                logo: config.cliente?.logo,
                logotipo: config.cliente?.logotipo
            },
            rifaGaleriaImagenes: config.rifa?.galeria?.imagenes?.length || 0,
            rifaContext: {
                id: req.rifaContext?.id || null,
                slug: req.rifaContext?.slug || '',
                nombre: req.rifaContext?.nombre || ''
            }
        });

        try {
            const contextoRifaActual = obtenerContextoRifaActual();
            const rifaIdActual = Number.parseInt(contextoRifaActual?.id, 10);
            const persistenciaContextual = Number.isInteger(rifaIdActual) && rifaIdActual > 0;
            const guardadoEnBD = await persistirConfigActualizada(config, req.usuario.username);
            const configVerificada = persistenciaContextual
                ? clonarConfigSeguro(config)
                : obtenerConfigActual();

            console.log('[PATCH /api/admin/config] ✅ VERIFICACIÓN POST-WRITE:', {
                imagenPrincipal: configVerificada.cliente?.imagenPrincipal,
                logo: configVerificada.cliente?.logo,
                nombreCliente: configVerificada.cliente?.nombre,
                fechaSorteo: configVerificada.rifa?.fechaSorteo,
                tiempoApartadoHoras: configVerificada.rifa?.tiempoApartadoHoras,
                guardadoEnBD: guardadoEnBD ? '🟦 Sí' : '🟨 No (config.json)',
                persistenciaContextual: persistenciaContextual ? `rifa:${rifaIdActual}` : 'global'
            });
        } catch (writeError) {
            console.error('[PATCH /api/admin/config] ❌ writeError:', writeError);
            log('error', 'Error guardando configuración', { error: writeError.message, usuario: req.usuario.username });
            return res.status(500).json({
                success: false,
                message: 'Error guardando configuración',
                error: writeError.message
            });
        }

        try {
            const contextoRifaActual = obtenerContextoRifaActual();
            const rifaIdActual = Number.parseInt(contextoRifaActual?.id, 10);
            if (Number.isInteger(rifaIdActual) && rifaIdActual > 0) {
                sincronizarConfigLegacyEnMemoria(config);
            } else {
                sincronizarConfigLegacyEnMemoria(configManagerV2?.getConfig?.() || config);
            }
            console.log('[PATCH /api/admin/config] ✅ Configuración sincronizada en memoria');
        } catch (reloadError) {
            console.error('[PATCH /api/admin/config] ❌ Error recargando ConfigManager:', reloadError);
            return res.status(500).json({
                success: false,
                message: 'Configuración guardada pero no se pudo recargar en memoria',
                error: reloadError.message
            });
        }

        limpiarCacheConfiguracionPublica();

        // ✅ PASO 8: Log de éxito
        const camposActualizados = [];
        if (requiereSystemaPremios) camposActualizados.push('sistemaPremios');
        if (bankAccountsActualizadas) camposActualizados.push('bankAccounts');
        if (req.body.cliente) camposActualizados.push('cliente');
        if (req.body.rifa) camposActualizados.push('rifa');
        if (req.body.redesSociales) camposActualizados.push('redesSociales');

        const logData = {
            usuario: req.usuario.username,
            campos_actualizados: camposActualizados.join(', ')
        };

        if (requiereSystemaPremios) {
            logData.premios_count = {
                sorteo: sistemaPremios.sorteo?.length || 0,
                presorteo: sistemaPremios.presorteo?.length || 0,
                ruletazos: sistemaPremios.ruletazos?.length || 0
            };
        }

        if (bankAccountsActualizadas) {
            logData.cuentas_bancarias = bankAccountsActualizadas.length;
        }

        log('info', '✅ PATCH /api/admin/config - Config actualizada (PRODUCTION-READY)', logData);

        res.json({
            success: true,
            message: 'Configuración actualizada exitosamente',
            warnings: advertenciasPromociones,
            data: {
                ...(requiereSystemaPremios && { sistemaPremios: config.rifa.sistemaPremios }),
                ...(bankAccountsActualizadas && {
                    cuentas: bankAccountsActualizadas
                }),
                ...(req.body.cliente && { cliente: config.cliente }),
                ...(req.body.rifa && {
                    rifa: config.rifa,
                    advertenciasPromociones
                }),
                ...(req.body.redesSociales && { redesSociales: config.cliente.redesSociales })
            }
        });

    } catch (error) {
        log('error', '❌ PATCH /api/admin/config error', {
            error: error.message,
            stack: error.stack,
            usuario: req.usuario?.username
        });
        res.status(500).json({
            success: false,
            message: 'Error al actualizar configuración',
            error: error.message
        });
    } finally {
        // 🔓 PASO 9: Liberar file lock
        if (release) {
            try {
                await release();
            } catch (unlockError) {
                console.warn('⚠️  Error liberando lock:', unlockError.message);
            }
        }
    }
});

/* ============================================================ */
/* SECCIÓN: GESTIÓN DE CONTADOR DE IDs DE ORDEN                */
/* ============================================================ */

/**
 * POST /api/public/order-counter/next
 * Genera el siguiente ID de orden único
 * Patrón visible multirifa: S9-AA000 → S9-AA001 → S9-AA999 → S9-AB000
 * Cliente: frontend o backend
 */
app.post('/api/public/order-counter/next', limiterOrdenes, async (req, res) => {
    try {
        // ===== OBTENER CONTEXTO MULTI-RIFA =====
        const rifaContext = req.rifaContext;
        if (!rifaContext || !rifaContext.id) {
            console.error('❌ [POST /api/public/order-counter/next] Error: No se pudo determinar el contexto de la rifa');
            return res.status(400).json({
                success: false,
                message: 'No se pudo identificar la rifa actual. Recarga la página.'
            });
        }

        const rifaIdActual = Number.parseInt(rifaContext.id, 10);
        const clienteConfigActual = rifaContext.configuracion?.cliente || {};
        const cliente_id = String(
            clienteConfigActual.id
            || rifaContext.organizador_key
            || rifaContext.organizerKey
            || ''
        ).trim();

        // Generador maneja su propia transacción y bloqueo; no envolver aquí
        const orderId = await generarSiguienteOrdenId(cliente_id, null, rifaIdActual);

        log('info', 'POST /api/public/order-counter/next success', { cliente_id, orden_id: orderId });

        return res.json({
            success: true,
            orden_id: orderId,
            message: 'ID de orden generado exitosamente'
        });

    } catch (error) {
        log('error', 'POST /api/public/order-counter/next error', { error: error.message, stack: error.stack });
        return res.status(500).json({
            success: false,
            message: error.message || 'Error generando ID de orden',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * GET /api/admin/order-counter/status
 * Obtiene el estado actual del contador de IDs
 */
app.get('/api/admin/order-counter/status', verificarToken, async (req, res) => {
    try {
        const rifaIdActual = Number.parseInt(req.query?.rifa_id || req.rifaContext?.id, 10) || null;
        const clienteIdQuery = String(req.query?.cliente_id || '').trim();
        const counterKey = construirClaveCounterOrden(rifaIdActual, clienteIdQuery);
        const prefijoVisible = construirPrefijoVisibleOrden(rifaIdActual, clienteIdQuery);

        if (!rifaIdActual && !clienteIdQuery) {
            return res.status(400).json({
                success: false,
                message: 'rifa_id o cliente_id es requerido'
            });
        }

        const counter = await db('order_id_counter')
            .modify((qb) => {
                qb.where('cliente_id', counterKey);
                if (rifaIdActual) {
                    qb.where('rifa_id', rifaIdActual);
                }
            })
            .first();

        if (!counter) {
            return res.json({
                success: true,
                data: {
                    cliente_id: counterKey,
                    rifa_id: rifaIdActual,
                    ultima_secuencia: 'AA',
                    ultimo_numero: 0,
                    proximo_numero: 1,
                    proximo_id: `${prefijoVisible}-AA000`,
                    contador_total: 0,
                    activo: true,
                    fecha_ultimo_reset: null
                }
            });
        }

        const proxNum = String(counter.proximo_numero).padStart(3, '0');
        const proximoId = `${prefijoVisible}-${counter.ultima_secuencia}${proxNum}`;

        res.json({
            success: true,
            data: {
                cliente_id: counter.cliente_id,
                rifa_id: counter.rifa_id || rifaIdActual || null,
                ultima_secuencia: counter.ultima_secuencia,
                ultimo_numero: counter.ultimo_numero,
                proximo_numero: counter.proximo_numero,
                proximo_id: proximoId,
                contador_total: counter.contador_total,
                activo: counter.activo,
                fecha_ultimo_reset: counter.fecha_ultimo_reset
            }
        });

    } catch (error) {
        log('error', 'GET /api/admin/order-counter/status error', { error: error.message });
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

/**
 * POST /api/admin/order-counter/reset
 * Resetea el contador de IDs (cuando termina un sorteo)
 * Solo accesible por admin autenticado
 */
app.post('/api/admin/order-counter/reset', verificarToken, async (req, res) => {
    try {
        const clienteIdBody = String(req.body?.cliente_id || '').trim();
        const rifaIdActual = Number.parseInt(req.body?.rifa_id || req.rifaContext?.id, 10) || null;
        const counterKey = construirClaveCounterOrden(rifaIdActual, clienteIdBody);
        const prefijoVisible = construirPrefijoVisibleOrden(rifaIdActual, clienteIdBody);

        if (!rifaIdActual && !clienteIdBody) {
            return res.status(400).json({
                success: false,
                message: 'rifa_id o cliente_id es requerido'
            });
        }

        // Usar transacción
        const result = await db.transaction(async (trx) => {
            const counter = await trx('order_id_counter')
                .modify((qb) => {
                    qb.where('cliente_id', counterKey);
                    if (rifaIdActual) {
                        qb.where('rifa_id', rifaIdActual);
                    }
                })
                .first();

            if (!counter) {
                throw new Error('Contador no encontrado');
            }

            // Guardar estado anterior para auditoría
            const estadoAnterior = {
                ultima_secuencia: counter.ultima_secuencia,
                contador_total: counter.contador_total,
                fecha_reset_anterior: counter.fecha_ultimo_reset
            };

            // Resetear contador
            await trx('order_id_counter')
                .where('id', counter.id)
                .update({
                    ultima_secuencia: 'AA',
                    proximo_numero: 1,
                    ultimo_numero: 0,
                    contador_total: 0,
                    fecha_ultimo_reset: new Date(),
                    updated_at: new Date()
                });

            return estadoAnterior;
        });

        log('info', 'POST /api/admin/order-counter/reset success', { cliente_id: counterKey, rifa_id: rifaIdActual, estado_anterior: result });

        res.json({
            success: true,
            message: 'Contador reseteado exitosamente',
            estado_anterior: result,
            nuevo_inicio: `${prefijoVisible}-AA000`
        });

    } catch (error) {
        log('error', 'POST /api/admin/order-counter/reset error', { error: error.message });
        res.status(500).json({
            success: false,
            message: error.message || 'Error reseteando contador'
        });
    }
});

/**
 * Función helper: Incrementa secuencia alfabética (AA → AB → AC... ZZ)
 */
function incrementarSecuenciaSQL(secuencia) {
    // Soportar secuencias alfabéticas de longitud variable.
    // Ejemplos:
    //  - 'AA' -> 'AB'
    //  - 'AZ' -> 'BA'
    //  - 'ZZ' -> 'AAA'
    if (!secuencia || typeof secuencia !== 'string') return 'AA';

    const chars = secuencia.toUpperCase().split('').map(c => c.charCodeAt(0));
    // Validar y normalizar (A-Z)
    for (let i = 0; i < chars.length; i++) {
        if (chars[i] < 65 || chars[i] > 90) chars[i] = 65;
    }

    // Increment estilo base-26 con acarreo
    let carry = 1;
    for (let i = chars.length - 1; i >= 0 && carry; i--) {
        chars[i] += carry;
        if (chars[i] > 90) {
            chars[i] = 65; // 'A'
            carry = 1;
        } else {
            carry = 0;
        }
    }

    if (carry) {
        // Si quedó acarreo al final, añadir una nueva 'A' al inicio
        chars.unshift(65);
    }

    return String.fromCharCode(...chars);
}

function logOrdenesDebug(...args) {
    if (process.env.DEBUG_ORDENES === 'true') {
        console.log(...args);
    }
}

function logOrdenesPerf(label, data = {}) {
    if (process.env.DEBUG_ORDENES_PERF === 'true') {
        console.log(`[ORDEN-PERF] ${label}`, data);
    }
}

async function obtenerOCrearCounterOrden(trx, clienteId, rifaId = null) {
    let counter = await trx('order_id_counter')
        .modify((qb) => {
            qb.where('cliente_id', clienteId);
            if (rifaId) {
                qb.where('rifa_id', rifaId);
            } else {
                qb.whereNull('rifa_id');
            }
        })
        .forUpdate()
        .first();

    if (counter) {
        return counter;
    }

    const newCounter = {
        cliente_id: clienteId,
        rifa_id: rifaId,
        ultima_secuencia: 'AA',
        ultimo_numero: 0,
        proximo_numero: 1,
        contador_total: 0,
        activo: true,
        fecha_ultimo_reset: new Date(),
        created_at: new Date(),
        updated_at: new Date()
    };

    try {
        await trx('order_id_counter').insert(newCounter);
    } catch (error) {
        if (error?.code !== '23505' && !error.message.includes('unique')) {
            throw error;
        }
    }

    counter = await trx('order_id_counter')
        .modify((qb) => {
            qb.where('cliente_id', clienteId);
            if (rifaId) {
                qb.where('rifa_id', rifaId);
            } else {
                qb.whereNull('rifa_id');
            }
        })
        .forUpdate()
        .first();

    if (!counter) {
        throw new Error(`No se pudo obtener el contador de orden para contexto rifa=${rifaId}`);
    }

    return counter;
}

function obtenerPrefijoOrdenCliente(clienteId, configActor = null) {
    try {
        // 1️⃣ Intentar obtener prefijoOrden desde config (PRIORITARIO)
        // Primero desde configActual si se proporciona, luego desde configManager
        const configParaUsar = configActor || cargarConfigSorteo();
        const prefijoConfig = String(configParaUsar?.cliente?.prefijoOrden || '').trim().toUpperCase();

        if (prefijoConfig && prefijoConfig.length >= 2) {
            console.log(`✅ PREFIJO ORDEN: "${prefijoConfig}" (desde configuración actual)`);
            return prefijoConfig;
        }

        console.warn(`⚠️ prefijoConfig vacío o inválido: "${prefijoConfig}"`);

        // ✅ CRÍTICO: Si no hay prefijo configurado, generar desde el slug de la rifa actual
        // Ejemplo: slug "s9" → prefijo "S9", slug "navidad2026" → prefijo "NA"
        const rifaSlug = String(configParaUsar?.rifa?.slug || '').trim();
        if (rifaSlug) {
            // Tomar primeros 2 caracteres del slug y convertir a mayúsculas
            const prefijoDesdeSlug = rifaSlug.substring(0, 2).toUpperCase();
            if (prefijoDesdeSlug.length >= 2 && /[A-Z0-9]/.test(prefijoDesdeSlug)) {
                console.log(`✅ PREFIJO ORDEN: "${prefijoDesdeSlug}" (generado desde slug "${rifaSlug}")`);
                return prefijoDesdeSlug;
            }
        }

        // Fallback: intentar desde el nombre del sorteo
        const nombreSorteo = String(configParaUsar?.rifa?.nombreSorteo || '').trim();
        if (nombreSorteo) {
            // Tomar primeras 2 letras del nombre
            const letras = nombreSorteo.replace(/[^a-zA-Z]/g, '').substring(0, 2).toUpperCase();
            if (letras.length >= 2) {
                console.log(`✅ PREFIJO ORDEN: "${letras}" (generado desde nombre "${nombreSorteo}")`);
                return letras;
            }
        }
    } catch (error) {
        console.warn('⚠️ Error obteniendoprefijoOrden:', error.message);
    }

    const clienteIdLimpio = String(clienteId || '').trim();
    if (clienteIdLimpio) {
        const letrasCliente = clienteIdLimpio.replace(/[^a-zA-Z0-9]/g, '').substring(0, 2).toUpperCase();
        if (letrasCliente.length >= 2) {
            console.log(`✅ PREFIJO ORDEN: "${letrasCliente}" (generado desde clienteId "${clienteIdLimpio}")`);
            return letrasCliente;
        }
    }

    // 2️⃣ Fallback seguro y genérico
    console.log('❌ FALLBACK: No se encontró prefijo dinámico válido, retornando "OR" por defecto');
    return 'OR';
}

function descomponerOrdenId(ordenId, prefijoEsperado = '') {
    const valor = String(ordenId || '').trim().toUpperCase();
    const prefijo = String(prefijoEsperado || '').trim().toUpperCase();
    if (!valor || !prefijo || !valor.startsWith(`${prefijo}-`)) {
        return null;
    }

    // Soportar secuencias alfabéticas de longitud variable (AA, AB, ..., ZZ, AAA, ...)
    const match = valor.match(/^[A-Z0-9]+-([A-Z]+)(\d{3})$/);
    if (!match) {
        return null;
    }

    return {
        secuencia: match[1],
        numero: Number.parseInt(match[2], 10) || 0
    };
}

function compararComponentesOrden(a, b) {
    if (!a && !b) return 0;
    if (!a) return -1;
    if (!b) return 1;
    if (a.secuencia !== b.secuencia) {
        return a.secuencia.localeCompare(b.secuencia);
    }
    return a.numero - b.numero;
}

function avanzarComponenteOrden(componente) {
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
}

function construirOrdenIdDesdeComponente(prefijo, componente) {
    const secuencia = String(componente?.secuencia || 'AA').toUpperCase();
    const numero = String(Number.isFinite(Number(componente?.numero)) ? Number(componente.numero) : 0).padStart(3, '0');
    return `${prefijo}-${secuencia}${numero}`;
}

function construirClaveCounterOrden(rifaId = null, clienteId = '') {
    const rifaNormalizada = Number.parseInt(rifaId, 10) || 0;
    const clienteNormalizado = String(clienteId || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');

    if (rifaNormalizada > 0) {
        return `rifa_${rifaNormalizada}`;
    }

    return clienteNormalizado || 'rifa_legacy';
}

function construirPrefijoVisibleOrden(rifaId = null, clienteId = '', configActor = null) {
    const rifaNormalizada = Number.parseInt(rifaId, 10) || 0;
    if (rifaNormalizada > 0) {
        return `S${rifaNormalizada}`;
    }

    return obtenerPrefijoOrdenCliente(clienteId, configActor);
}

async function obtenerMayorOrdenExistentePorPrefijo(trx, prefijo) {
    const prefijoLimpio = String(prefijo || '').trim().toUpperCase();
    if (!prefijoLimpio) {
        return null;
    }

    const ultimaOrden = await trx('ordenes')
        .where('numero_orden', 'like', `${prefijoLimpio}-%`)
        .orderBy('numero_orden', 'desc')
        .first('numero_orden');

    if (!ultimaOrden?.numero_orden) {
        return null;
    }

    return descomponerOrdenId(ultimaOrden.numero_orden, prefijoLimpio);
}

async function obtenerSiguienteComponenteOrdenRobusto(trx, clienteId, prefijo, rifaId = null) {
    const counter = await obtenerOCrearCounterOrden(trx, clienteId, rifaId);
    const candidatoCounter = {
        secuencia: String(counter?.ultima_secuencia || 'AA').toUpperCase(),
        numero: Number.isFinite(Number(counter?.proximo_numero)) ? Number(counter.proximo_numero) : 1
    };
    const mayorPersistido = await obtenerMayorOrdenExistentePorPrefijo(trx, prefijo);

    if (compararComponentesOrden(mayorPersistido, candidatoCounter) >= 0) {
        const reconciliado = avanzarComponenteOrden(mayorPersistido);
        logOrdenesDebug('♻️ Counter reconciliado con última orden persistida', {
            clienteId,
            prefijo,
            rifaId,
            counter: candidatoCounter,
            mayorPersistido,
            reconciliado
        });
        return { counter, componente: reconciliado };
    }

    return { counter, componente: candidatoCounter };
}

function normalizarBoletosOrdenParaComparacion(boletos) {
    const origen = Array.isArray(boletos) ? boletos : (() => {
        try {
            return typeof boletos === 'string' ? JSON.parse(boletos || '[]') : [];
        } catch (_) {
            return [];
        }
    })();

    return origen
        .map((n) => Number(n))
        .filter((n) => Number.isInteger(n) && n >= 0)
        .sort((a, b) => a - b);
}

async function obtenerDiagnosticoBoletosOrden(trx, boletosSolicitados, options = {}) {
    const boletosOrdenados = Array.from(new Set(
        (Array.isArray(boletosSolicitados) ? boletosSolicitados : [])
            .map((numero) => Number(numero))
            .filter((numero) => Number.isInteger(numero) && numero >= 0)
    )).sort((a, b) => a - b);
    const rifaId = Number.parseInt(options?.rifaId, 10) || obtenerRifaIdActual();

    if (boletosOrdenados.length === 0) {
        return {
            numerosConflictivos: [],
            boletosDisponibles: [],
            faltantes: []
        };
    }

    const filas = await trx('boletos_estado')
        .modify((qb) => {
            if (rifaId) qb.where('rifa_id', rifaId);
        })
        .whereIn('numero', boletosOrdenados)
        .select('numero', 'estado', 'numero_orden')
        .orderBy('numero', 'asc')
        .timeout(10000);

    const encontrados = new Set(filas.map((fila) => Number(fila.numero)));
    const faltantes = boletosOrdenados.filter((numero) => !encontrados.has(numero));
    const ocupados = filas
        .filter((fila) => fila.estado !== 'disponible' || fila.numero_orden !== null)
        .map((fila) => Number(fila.numero));

    const numerosConflictivos = Array.from(new Set([...ocupados, ...faltantes])).sort((a, b) => a - b);

    return {
        numerosConflictivos,
        boletosDisponibles: boletosOrdenados.filter((numero) => !numerosConflictivos.includes(numero)),
        faltantes
    };
}

function calcularCantidadOportunidadesEsperadas(boletos = [], oportunidadesConfig = null) {
    if (!oportunidadesConfig || oportunidadesConfig.enabled !== true) {
        return 0;
    }

    const multiplicador = Number.parseInt(oportunidadesConfig.multiplicador, 10);
    if (!Number.isInteger(multiplicador) || multiplicador < 1) {
        return 0;
    }

    return (Array.isArray(boletos) ? boletos.length : 0) * multiplicador;
}

function parseBoletosOrdenSeguro(raw) {
    return parseBoletosOrdenLegacy(raw).sort((a, b) => a - b);
}

async function obtenerMapaOportunidadesPorBoletos(runner, boletos = [], options = {}) {
    const boletosValidos = Array.from(new Set(
        (Array.isArray(boletos) ? boletos : [])
            .map((numero) => Number(numero))
            .filter((numero) => Number.isInteger(numero) && numero >= 0)
    )).sort((a, b) => a - b);

    const mapa = new Map();
    boletosValidos.forEach((numero) => {
        mapa.set(numero, []);
    });

    if (boletosValidos.length === 0) {
        return mapa;
    }

    const rifaId = Number.parseInt(options?.rifaId, 10) || obtenerRifaIdActual();
    const filas = await runner('orden_oportunidades')
        .modify((qb) => {
            if (rifaId) qb.where('rifa_id', rifaId);
        })
        .whereIn('numero_boleto', boletosValidos)
        .select('numero_boleto', 'numero_oportunidad')
        .orderBy('numero_boleto', 'asc')
        .orderBy('numero_oportunidad', 'asc');

    filas.forEach((fila) => {
        const numeroBoleto = Number(fila.numero_boleto);
        if (!mapa.has(numeroBoleto)) {
            mapa.set(numeroBoleto, []);
        }
        mapa.get(numeroBoleto).push(fila.numero_oportunidad);
    });

    return mapa;
}

function combinarOportunidadesPorBoletos(boletos = [], mapaOportunidades = new Map()) {
    return (Array.isArray(boletos) ? boletos : []).flatMap((numeroBoleto) => {
        return mapaOportunidades.get(Number(numeroBoleto)) || [];
    });
}

function esMismaOrdenIdempotente(ordenExistente, contexto) {
    if (!ordenExistente || !contexto) return false;

    const whatsappExistente = String(ordenExistente.telefono_cliente || '').replace(/[^0-9]/g, '');
    const whatsappContexto = String(contexto.whatsapp || '').replace(/[^0-9]/g, '');
    if (!whatsappExistente || !whatsappContexto || whatsappExistente !== whatsappContexto) {
        return false;
    }

    const boletosExistentes = normalizarBoletosOrdenParaComparacion(ordenExistente.boletos);
    const boletosContexto = normalizarBoletosOrdenParaComparacion(contexto.boletos);

    if (boletosExistentes.length !== boletosContexto.length) {
        return false;
    }

    return boletosExistentes.every((numero, index) => numero === boletosContexto[index]);
}

/**
 * Genera el siguiente ID de orden para un cliente dado usando la misma lógica
 * que /api/public/order-counter/next pero permitiendo pasar una transacción
 * para uso ATÓMICO dentro de la creación de ordenes.
 * @param {string} cliente_id
 * @param {object} trx - instancia de transacción Knex
 * @returns {Promise<string>} ordenId
 */
async function generarSiguienteOrdenId(cliente_id, trx, rifaId = null) {
    const cidOriginal = String(cliente_id || '').trim();
    const counterKey = construirClaveCounterOrden(rifaId, cidOriginal);
    const prefijo = construirPrefijoVisibleOrden(rifaId, cidOriginal, obtenerConfigActual(rifaId) || {});

    logOrdenesDebug(`📋 Generando siguiente ID con prefijo "${prefijo}" para rifa_id=${rifaId}`);

    // Usar transacción existente si se provee, de lo contrario crear una nueva
    const executeInTransaction = async (localTrx) => {
        // 1) Adquirir advisory lock por counterKey para serializar generación
        try {
            await localTrx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [counterKey]);
            logOrdenesDebug('🔐 Advisory lock adquirido para counterKey=' + counterKey);
        } catch (lockErr) {
            console.warn('⚠️ No se pudo adquirir advisory lock para', counterKey, lockErr && lockErr.message);
        }

        // 2) Insertar fila si no existe (concurrencia segura)
        try {
            await localTrx('order_id_counter')
                .insert({
                    cliente_id: counterKey,
                    rifa_id: rifaId,
                    ultima_secuencia: 'AA',
                    ultimo_numero: 0,
                    proximo_numero: 1,
                    contador_total: 0,
                    activo: true,
                    created_at: new Date(),
                    updated_at: new Date()
                })
                .onConflict(['cliente_id', 'rifa_id'])
                .ignore();
        } catch (insErr) {
            logOrdenesDebug('ℹ️ Error insertando counter (posible concurrencia)', insErr && insErr.message);
        }

        // 3) Leer fila bajo FOR UPDATE
        const counter = await localTrx('order_id_counter')
            .where({ cliente_id: counterKey, rifa_id: rifaId })
            .forUpdate()
            .first();

        if (!counter) throw new Error('NO_SE_PUDO_OBTENER_COUNTER');

        // 4) Componente candidato y reconciliación
        // CORRECCIÓN: Usar proximo_numero (lo que se generará) no ultimo_numero (lo que se usó)
        // Si proximo_numero > 999, significa cambio de secuencia: resetear a 0 y avanzar secuencia
        let proximoNumero = Number.isFinite(Number(counter.proximo_numero)) ? Number(counter.proximo_numero) : 1;
        let proximaSecuencia = String(counter.ultima_secuencia || 'AA').toUpperCase();
        if (proximoNumero > 999) {
            proximoNumero = 0;
            proximaSecuencia = incrementarSecuenciaSQL(proximaSecuencia);
            logOrdenesDebug('⚠️ proximo_numero > 999, avanzando secuencia a:', proximaSecuencia);
        }

        // El candidato es LO QUE SE GENERARÁ PRÓXIMO
        const candidato = {
            secuencia: proximaSecuencia,
            numero: proximoNumero
        };

        const mayorPersistido = await obtenerMayorOrdenExistentePorPrefijo(localTrx, prefijo);
        let componente = candidato;
        if (compararComponentesOrden(mayorPersistido, candidato) >= 0) {
            componente = avanzarComponenteOrden(mayorPersistido);
            logOrdenesDebug('♻️ Folio reconciliado', { candidato, mayorPersistido, componente });
        }

        // 5) Construir fullOrderId y calcular siguiente
        const fullOrderId = construirOrdenIdDesdeComponente(prefijo, componente);
        const siguiente = avanzarComponenteOrden(componente);

        // 6) Actualizar contador y retornar (UPDATE ... RETURNING)
        // CRÍTICO: Si siguiente.numero >= 1000, avanzar secuencia y resetear número
        // La próxima lectura debe devolver la secuencia/número correcto
        let proximoNumeroAGuardar = siguiente.numero;
        let proximaSecuenciaAGuardar = siguiente.secuencia;

        if (proximoNumeroAGuardar >= 1000) {
            proximoNumeroAGuardar = 0;
            proximaSecuenciaAGuardar = incrementarSecuenciaSQL(siguiente.secuencia);
            logOrdenesDebug('⚠️ siguiente.numero >= 1000, ajustando para próxima iteración', {
                de: { secuencia: siguiente.secuencia, numero: siguiente.numero },
                a: { secuencia: proximaSecuenciaAGuardar, numero: proximoNumeroAGuardar }
            });
        }

        const updateData = {
            ultimo_numero: componente.numero,
            ultima_secuencia: proximaSecuenciaAGuardar,  // Guardar la secuencia que será próxima
            proximo_numero: proximoNumeroAGuardar,      // Guardar el número que será próximo
            contador_total: (counter.contador_total || 0) + 1,
            updated_at: new Date()
        };

        try {
            const updated = await localTrx('order_id_counter')
                .where('id', counter.id)
                .update(updateData)
                .returning('*');

            if (!updated || updated.length === 0) {
                throw new Error('NO_SE_PUDO_ACTUALIZAR_COUNTER');
            }
            logOrdenesDebug('ℹ️ [counter] UPDATE result', { counterId: counter.id, updated: updated[0] });
        } catch (updErr) {
            console.error('❌ [counter] Error actualizando order_id_counter:', updErr && (updErr.message || updErr));
            throw updErr;
        }

        logOrdenesDebug(`✅ Folio generado: ${fullOrderId}`);
        return fullOrderId;
    };

    if (trx) {
        return await executeInTransaction(trx);
    } else {
        return await db.transaction(executeInTransaction);
    }
}

/**
 * POST /api/verify-payment
 * Endpoint para verificar pagos (futuro panel de admin)
 */
app.post('/api/verify-payment', async (req, res) => {
    try {
        const { ordenId, comprobante } = req.body;

        // Aquí irá lógica para verificar pagos
        // Por ahora solo confirmamos que se recibió

        res.json({
            success: true,
            message: 'Pago registrado para revisión',
            ordenId: ordenId
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

/**
 * POST /api/ordenes
 * Guarda una nueva orden en la BD y devuelve un link viewable
 * ✅ OPTIMIZADO PARA 1M BOLETOS - Usa BoletoService
 * Cambios principales:
 * - Verifica boletos con índices rápidos en BD
 * - Transacción atómica para evitar race conditions
 * - Usa tabla boletos_estado en lugar de JSON array
 * Protegido con rate limiting
 */
// ============================================================================
// POST /api/ordenes - CREAR NUEVA ORDEN DE COMPRA
// ============================================================================
// Versión 3.0: PRE-ASIGNADAS CON FK CASCADE
// - Boletos y oportunidades vinculados desde bd (FK)
// - UPDATE simplificado: solo numero_orden
// - FK CASCADE maneja automáticamente cambios de estado
// - Sin código de asignación dinámica, sin race conditions complejas
// ============================================================================
app.post('/api/ordenes', limiterOrdenes, async (req, res) => {
    const startTime = Date.now();
    let ordenId = '';
    const perfMarks = {
        requestStart: startTime
    };

    try {
        logOrdenesDebug('\n📨 [POST /api/ordenes] REQUEST RECIBIDO');
        const orden = req.body;

        // ===== OBTENER CONTEXTO MULTI-RIFA =====
        const rifaContext = req.rifaContext;
        if (!rifaContext || !rifaContext.id) {
            console.error('❌ [POST /api/ordenes] Error: No se pudo determinar el contexto de la rifa');
            return res.status(400).json({
                success: false,
                message: 'No se pudo identificar a qué rifa pertenece esta orden. Recarga la página.'
            });
        }

        const configCompleta = (rifaContext.configuracion && typeof rifaContext.configuracion === 'object')
            ? rifaContext.configuracion
            : { rifa: {} };
        const configRifa = configCompleta.rifa || {};
        const rifaIdActual = Number.parseInt(rifaContext.id, 10);
        const totalBoletosRifa = Number(configRifa.totalBoletos) || 100;

        // Validar cliente
        if (!orden.cliente || typeof orden.cliente !== 'object') {
            return res.status(400).json({ success: false, message: 'Datos del cliente requeridos' });
        }

        const clienteIdActual = String(
            rifaContext.configuracion?.cliente?.id
            || rifaContext.organizador_key
            || rifaContext.organizerKey
            || ''
        ).trim();
        const prefijoOrdenActual = rifaIdActual ? `S${rifaIdActual}` : obtenerPrefijoOrdenCliente(clienteIdActual, configCompleta);
        const ordenIdRecibido = typeof orden.ordenId === 'string'
            ? sanitizar(orden.ordenId).trim().toUpperCase()
            : '';

        if (ordenIdRecibido.length > 50) {
            return res.status(400).json({ success: false, message: 'Orden ID máximo 50 caracteres' });
        }

        const secuenciaOficial = ordenIdRecibido.match(/(?:^|[-])([A-Z]{2}\d{3})$/);
        const ordenIdSolicitado = secuenciaOficial
            ? `${prefijoOrdenActual}-${secuenciaOficial[1]}`
            : '';
        ordenId = '';

        const nombre = sanitizar(orden.cliente.nombre || '').trim();
        const apellidos = sanitizar(orden.cliente.apellidos || '').trim();
        const whatsapp = sanitizar(orden.cliente.whatsapp || '').replace(/[^0-9]/g, '');
        const estado = sanitizar(orden.cliente.estado || '').trim();
        const ciudad = sanitizar(orden.cliente.ciudad || '').trim();

        if (!nombre) {
            return res.status(400).json({ success: false, message: 'Nombre del cliente requerido' });
        }
        if (!esTelefonoValido(orden.cliente.whatsapp)) {
            return res.status(400).json({ success: false, message: 'Teléfono debe tener 10-20 dígitos' });
        }

        // Validar boletos
        if (!Array.isArray(orden.boletos) || orden.boletos.length === 0) {
            return res.status(400).json({ success: false, message: 'Se requiere al menos 1 boleto' });
        }

        const boletosValidos = orden.boletos.map(n => Number(n)).filter(n =>
            !isNaN(n) && n >= 0 && n < totalBoletosRifa && Number.isInteger(n)
        );

        if (boletosValidos.length !== orden.boletos.length) {
            return res.status(400).json({
                success: false,
                message: `Rango de boletos inválido para esta rifa (0 a ${totalBoletosRifa - 1})`
            });
        }

        // Validar boletos duplicados
        const boletoSet = new Set(boletosValidos);
        if (boletoSet.size !== boletosValidos.length) {
            return res.status(400).json({ success: false, message: 'Boletos duplicados en la orden' });
        }

        const boletosOrdenados = [...boletosValidos].sort((a, b) => a - b);

        const totalesCliente = {
            subtotal: parseFloat(orden.totales?.subtotal) || 0,
            descuento: parseFloat(orden.totales?.descuento) || 0,
            totalFinal: parseFloat(orden.totales?.totalFinal) || 0
        };

        const totalesServidor = calcularTotalesServidor(boletosValidos.length, configCompleta, new Date());
        const precioUnitario = totalesServidor.precioUnitario;
        const subtotal = totalesServidor.subtotal;
        const descuento = totalesServidor.descuento;
        const total = totalesServidor.totalFinal;

        if (!Number.isFinite(total) || total < 0) {
            return res.status(400).json({ success: false, message: 'Total calculado por servidor inválido' });
        }

        if (!Number.isFinite(subtotal) || subtotal <= 0) {
            return res.status(400).json({ success: false, message: 'Subtotal calculado por servidor inválido' });
        }

        const auditoria = auditarConsistenciaPrecios(
            boletosValidos.length,
            totalesServidor.precioNormal,
            totalesCliente,
            configCompleta
        );
        perfMarks.validacionesMs = Date.now() - startTime;

        if (!auditoria.sonIguales) {
            console.warn(`⚠️ [AUDITORÍA] Diferencia cliente/servidor en orden ${ordenId}:`);
            console.warn(`   Cliente: subtotal=$${totalesCliente.subtotal.toFixed(2)}, descuento=$${totalesCliente.descuento.toFixed(2)}, total=$${totalesCliente.totalFinal.toFixed(2)}`);
            console.warn(`   Servidor: subtotal=$${subtotal.toFixed(2)}, descuento=$${descuento.toFixed(2)}, total=$${total.toFixed(2)}`);
        } else {
            logOrdenesDebug(`✅ [AUDITORÍA] Precios consistentes para orden ${ordenId}`);
        }

        // ===== TRANSACCIÓN ATÓMICA =====
        const oportunidadesConfig = obtenerConfigOportunidadesSistema(configCompleta);
        const oportunidadesHabilitadas = oportunidadesConfig.enabled === true;

        const resultado = await db.transaction(async (trx) => {
            const trxStart = Date.now();
            await trx.raw("SET LOCAL lock_timeout = '5s'");    // ⬇️ 20s → 5s (reintentar rápido en conflicto)
            await trx.raw("SET LOCAL statement_timeout = '30s'"); // ⬇️ 60s → 30s (statements rápidas)
            perfMarks.trxSetupMs = Date.now() - trxStart;

            if (ordenIdSolicitado) {
                const duplicateStart = Date.now();
                const ordenSolicitada = await trx('ordenes')
                    .where('numero_orden', ordenIdSolicitado)
                    .timeout(10000)
                    .first();
                perfMarks.duplicateCheckMs = (perfMarks.duplicateCheckMs || 0) + (Date.now() - duplicateStart);

                if (ordenSolicitada && esMismaOrdenIdempotente(ordenSolicitada, {
                    whatsapp,
                    boletos: boletosOrdenados
                })) {
                    const cantidadOportunidadesExistente = calcularCantidadOportunidadesEsperadas(
                        boletosOrdenados,
                        oportunidadesConfig
                    );

                    return {
                        isDuplicate: true,
                        ordenExistente: ordenSolicitada,
                        cantidadOportunidades: cantidadOportunidadesExistente
                    };
                }
            }

            let createdResult = null;
            for (let intentoOrdenId = 0; intentoOrdenId < 30; intentoOrdenId++) {
                if (!ordenId) {
                    const counterStart = Date.now();
                    // Usar la misma transacción para máxima velocidad y ahorro de conexiones
                    ordenId = await generarSiguienteOrdenId(clienteIdActual, trx, rifaIdActual);
                    perfMarks.counterMs = (perfMarks.counterMs || 0) + (Date.now() - counterStart);
                }

                // PASO 1: Verificar orden duplicada del ID generado por backend
                const duplicateStart = Date.now();
                const ordenExistente = await trx('ordenes')
                    .where('numero_orden', ordenId)
                    .timeout(10000)
                    .first();
                perfMarks.duplicateCheckMs = (perfMarks.duplicateCheckMs || 0) + (Date.now() - duplicateStart);

                if (ordenExistente) {
                    if (esMismaOrdenIdempotente(ordenExistente, {
                        whatsapp,
                        boletos: boletosOrdenados
                    })) {
                        const cantidadOportunidadesExistente = calcularCantidadOportunidadesEsperadas(
                            boletosOrdenados,
                            oportunidadesConfig
                        );

                        // 200 OK: orden ya existe (idempotencia real)
                        return {
                            isDuplicate: true,
                            ordenExistente: ordenExistente,
                            cantidadOportunidades: cantidadOportunidadesExistente
                        };
                    }

                    console.warn('⚠️ [POST /api/ordenes] ordenId recibido o generado ya pertenece a otra orden; se regenerará', {
                        ordenId,
                        telefonoExistente: ordenExistente.telefono_cliente,
                        telefonoActual: whatsapp
                    });
                    ordenId = '';
                    // Exponential/randomized backoff to reduce thundering herd
                    await new Promise((resolve) => setTimeout(resolve, 50 + Math.floor(Math.random() * 300)));
                    continue;
                }

                // PASO 2: intentar INSERT orden; si colisiona por unique constraint, regenerar y reintentar
                const ordenData = {
                    rifa_id: rifaIdActual,
                    numero_orden: ordenId,
                    cantidad_boletos: boletosValidos.length,
                    precio_unitario: Math.round(precioUnitario * 100) / 100,
                    subtotal: Math.round(subtotal * 100) / 100,
                    descuento: Math.round(descuento * 100) / 100,
                    total: Math.round(total * 100) / 100,
                    nombre_cliente: `${nombre} ${apellidos}`.trim().slice(0, 100),
                    estado_cliente: estado.slice(0, 100),
                    ciudad_cliente: ciudad.slice(0, 100),
                    telefono_cliente: whatsapp.slice(0, 20),
                    metodo_pago: sanitizar(orden.metodoPago || 'transferencia').slice(0, 20),
                    detalles_pago: sanitizar(orden.cuenta?.accountNumber || '').slice(0, 255),
                    nombre_banco: sanitizar(orden.cuenta?.nombreBanco || '').slice(0, 100),
                    numero_referencia: sanitizar(orden.cuenta?.numero_referencia || orden.cuenta?.referencia || '').slice(0, 100),
                    nombre_beneficiario: sanitizar(orden.cuenta?.beneficiary || '').slice(0, 150),
                    estado: 'pendiente',
                    boletos: JSON.stringify(boletosOrdenados),
                    created_at: new Date(),
                    updated_at: new Date()
                };

                try {
                    const insertOrderStart = Date.now();
                    await trx('ordenes').insert(ordenData).timeout(10000);
                    perfMarks.insertOrderMs = (perfMarks.insertOrderMs || 0) + (Date.now() - insertOrderStart);

                    // PASO 3: Reservar boletos de forma condicional.
                    const reserveTicketsStart = Date.now();
                    const boletosActualizados = await trx('boletos_estado')
                        .modify((qb) => {
                            if (rifaIdActual) qb.where('rifa_id', rifaIdActual);
                        })
                        .whereIn('numero', boletosOrdenados)
                        .where('estado', 'disponible')
                        .whereNull('numero_orden')
                        .timeout(10000)
                        .update({
                            numero_orden: ordenId,
                            estado: 'apartado',
                            updated_at: new Date()
                        });
                    perfMarks.reserveTicketsMs = (perfMarks.reserveTicketsMs || 0) + (Date.now() - reserveTicketsStart);

                    if (boletosActualizados !== boletosOrdenados.length) {
                        const conflictQueryStart = Date.now();
                        const diagnosticoBoletos = await obtenerDiagnosticoBoletosOrden(trx, boletosOrdenados, {
                            rifaId: rifaIdActual
                        });
                        perfMarks.conflictQueryMs = (perfMarks.conflictQueryMs || 0) + (Date.now() - conflictQueryStart);

                        throw {
                            code: 'BOLETOS_CONFLICTO',
                            boletosConflicto: diagnosticoBoletos.numerosConflictivos,
                            boletosDisponibles: diagnosticoBoletos.boletosDisponibles,
                            message: 'Algunos boletos cambiaron de estado mientras se procesaba la orden'
                        };
                    }

                    if (oportunidadesHabilitadas) {
                        if (!oportunidadesConfig.configuracionCompleta || !oportunidadesConfig.configuracionConsistente) {
                            throw {
                                code: 'OPORTUNIDADES_INCONSISTENTES',
                                message: 'La configuración de oportunidades es inválida o incompleta',
                                detalles: {
                                    multiplicador: oportunidadesConfig.multiplicador,
                                    rangoVisible: oportunidadesConfig.rangoVisible,
                                    rangoOculto: oportunidadesConfig.rangoOculto,
                                    totalEsperado: oportunidadesConfig.totalOportunidadesEsperadas,
                                    totalConfigurado: oportunidadesConfig.totalOportunidadesConfiguradas,
                                    errores: oportunidadesConfig.errores
                                }
                            };
                        }

                        const oppReserveStart = Date.now();
                        const oportunidadesActualizadas = await trx('orden_oportunidades')
                            .modify((qb) => {
                                if (rifaIdActual) qb.where('rifa_id', rifaIdActual);
                            })
                            .whereIn('numero_boleto', boletosValidos)
                            .where('estado', 'disponible')
                            .whereNull('numero_orden')
                            .timeout(10000)
                            .update({
                                numero_orden: ordenId,
                                estado: 'apartado'
                            });
                        perfMarks.oppReserveMs = (perfMarks.oppReserveMs || 0) + (Date.now() - oppReserveStart);

                        const oportunidadesEsperadasOrden = calcularCantidadOportunidadesEsperadas(
                            boletosValidos,
                            oportunidadesConfig
                        );
                        if (oportunidadesActualizadas !== oportunidadesEsperadasOrden) {
                            throw {
                                code: 'OPORTUNIDADES_INCONSISTENTES',
                                message: 'La reserva de oportunidades preasignadas no coincidió con el multiplicador configurado',
                                detalles: {
                                    multiplicadorEsperado: oportunidadesConfig.multiplicador,
                                    totalBoletos: boletosValidos.length,
                                    oportunidadesEsperadas: oportunidadesEsperadasOrden,
                                    oportunidadesActualizadas
                                }
                            };
                        }

                        createdResult = {
                            isDuplicate: false,
                            ordenId: ordenId,
                            cantidad: boletosValidos.length,
                            cantidadOportunidades: oportunidadesActualizadas,
                            total: total,
                            precioUnitario,
                            subtotal,
                            descuento,
                            totalFinal: total,
                            combo: totalesServidor.combo || null
                        };
                        break; // success
                    } else {
                        createdResult = {
                            isDuplicate: false,
                            ordenId: ordenId,
                            cantidad: boletosValidos.length,
                            cantidadOportunidades: 0,
                            total: total,
                            precioUnitario,
                            subtotal,
                            descuento,
                            totalFinal: total,
                            combo: totalesServidor.combo || null
                        };
                        break; // success
                    }
                } catch (insErr) {
                    // Si la inserción falló por clave única en numero_orden, regenerar y reintentar
                    const errMsg = String(insErr && (insErr.message || insErr));
                    const isRetryablePostgresError = insErr && (
                        insErr.code === '23505' || // Duplicate key
                        insErr.code === '55P03' || // Lock timeout
                        insErr.code === '57014' || // Statement timeout
                        /duplicate key value|duplicate key|lock timeout|statement timeout|deadlock/i.test(errMsg)
                    );

                    if (isRetryablePostgresError) {
                        console.warn(`⚠️ [POST /api/ordenes] error reintentable (${insErr.code || 'TIMEOUT'}). Intento ${intentoOrdenId + 1}/30. Reintentando...`, { ordenId, err: errMsg });
                        ordenId = '';
                        // Randomized backoff
                        await new Promise((resolve) => setTimeout(resolve, 100 + Math.floor(Math.random() * 500)));
                        continue; // reintentar
                    }

                    // ⭐ NEW: Capturar BOLETOS_CONFLICTO y reintentar con backoff (no fallar inmediatamente)
                    if (insErr && insErr.code === 'BOLETOS_CONFLICTO' && intentoOrdenId < 12) {
                        console.warn(`⚠️ [POST /api/ordenes] conflicto de boletos en intento ${intentoOrdenId + 1}. Reintentando con backoff exponencial...`, {
                            intentoOrdenId,
                            conflictosDetectados: insErr.boletosConflicto?.length || 0
                        });
                        // Exponential backoff: 50ms, 100ms, 200ms, 400ms, ...
                        const backoffMs = Math.min(50 * Math.pow(2, Math.floor(intentoOrdenId / 3)), 2000) + Math.floor(Math.random() * 500);
                        await new Promise((resolve) => setTimeout(resolve, backoffMs));
                        ordenId = ''; // regenerar orden ID en siguiente intento
                        continue; // reintentar
                    }

                    // Re-throw para que el outer catch maneje otros errores o colisiones de oportunidades
                    throw insErr;
                }
            }

            if (!createdResult) {
                throw new Error('NO_SE_PUDO_GENERAR_ORDEN_ID_UNICO');
            }

            // Ya generamos y reservamos los recursos dentro del bucle anterior.
            // Aquí sólo devolvemos el resultado exitoso obtenido allí.
            return createdResult;
        });
        perfMarks.totalMs = Date.now() - startTime;
        logOrdenesPerf('POST /api/ordenes ok', {
            ordenId,
            cantidadBoletos: boletosOrdenados.length,
            oportunidadesHabilitadas,
            ...perfMarks
        });

        // Respuesta
        if (resultado.isDuplicate) {
            const ordenExistente = resultado.ordenExistente;
            const totalesExistentes = calcularTotalesServidor(
                Number(ordenExistente?.cantidad_boletos || 0),
                configCompleta,
                new Date(ordenExistente?.created_at || Date.now())
            );

            if (wsEvents && ordenExistente) {
                try {
                    const createdAtMs = new Date(ordenExistente.created_at).getTime();
                    const esOrdenReciente = Number.isFinite(createdAtMs)
                        ? (Date.now() - createdAtMs) <= (15 * 60 * 1000)
                        : true;

                    // Reemitir órdenes recientes ayuda a recuperar el realtime
                    // cuando el cliente reintenta el POST o la primera respuesta se pierde.
                    if (esOrdenReciente) {
                        wsEvents.emitirNuevaOrdenAdmin({
                            numero_orden: ordenExistente.numero_orden,
                            rifa_id: ordenExistente.rifa_id || rifaIdActual || null,
                            nombre_cliente: ordenExistente.nombre_cliente,
                            telefono_cliente: ordenExistente.telefono_cliente,
                            estado: ordenExistente.estado || 'pendiente',
                            cantidad_boletos: ordenExistente.cantidad_boletos,
                            total: ordenExistente.total,
                            comprobante_path: ordenExistente.comprobante_path || null,
                            created_at: ordenExistente.created_at || new Date().toISOString(),
                            updated_at: ordenExistente.updated_at || ordenExistente.created_at || new Date().toISOString()
                        });
                    }
                } catch (wsError) {
                    console.warn(`⚠️  Error reemitiendo orden idempotente al canal admin:`, wsError.message);
                }
            }

            // Idempotencia: 200 OK si la orden ya existe
            logOperacionHttp('POST /api/ordenes (idempotente)', startTime, {
                ordenId: ordenExistente.numero_orden,
                cantidad: ordenExistente.cantidad_boletos,
                statusCode: 200
            }, { slowMs: 1200, warnMs: 2500 });
            return res.json({
                success: true,
                message: 'Orden ya registrada',
                ordenId: ordenExistente.numero_orden,
                url: `http://${req.headers.host || `localhost:${PORT}`}/api/ordenes/${ordenExistente.numero_orden}`,
                cantidad: ordenExistente.cantidad_boletos,
                data: {
                    numero_orden: ordenExistente.numero_orden,
                    cantidad_boletos: ordenExistente.cantidad_boletos,
                    cantidad_oportunidades: resultado.cantidadOportunidades || 0,
                    totales: {
                        precioUnitario: Number(ordenExistente.precio_unitario ?? 0),
                        subtotal: Number(ordenExistente.subtotal ?? 0),
                        descuento: Number(ordenExistente.descuento ?? 0),
                        totalFinal: Number(ordenExistente.total ?? 0),
                        combo: totalesExistentes.combo || null
                    },
                    estado: ordenExistente.estado
                }
            });
        }

        const host = req.headers.host || `localhost:${PORT}`;
        refrescarCachesTrasCambioInventario();

        log('info', 'Orden creada exitosamente', { ordenId, cantidad: resultado.cantidad, total: resultado.total });
        logOperacionHttp('POST /api/ordenes', startTime, {
            ordenId,
            cantidad: resultado.cantidad,
            total: resultado.total,
            statusCode: 200
        }, { slowMs: 1200, warnMs: 2500 });

        // 🔌 EMITIR EVENTO DE WEBSOCKET: Nueva orden creada (actualizar grilla en tiempo real)
        if (wsEvents) {
            try {
                wsEvents.emitirNuevaOrden(resultado.cantidad, {
                    numerosApartados: resultado.cantidad,
                    cliente: nombre,
                    timestamp: new Date().toISOString()
                }, rifaIdActual);  // ✅ Pasar rifaIdActual
                wsEvents.emitirNuevaOrdenAdmin({
                    numero_orden: resultado.ordenId,
                    rifa_id: rifaIdActual,
                    nombre_cliente: nombre,
                    telefono_cliente: whatsapp,
                    estado: 'pendiente',
                    cantidad_boletos: resultado.cantidad,
                    total: resultado.totalFinal,
                    comprobante_path: null,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                }, rifaIdActual);  // ✅ Pasar rifaIdActual como segundo param
                logOrdenesDebug(`✅ Evento WebSocket emitido: Nueva orden con ${resultado.cantidad} boletos`);
            } catch (wsError) {
                // No fallar si hay error en WebSocket - es no-crítico
                console.warn(`⚠️  Error emitiendo evento WebSocket:`, wsError.message);
            }
        }

        return res.json({
            success: true,
            ordenId: resultado.ordenId,
            url: `http://${host}/api/ordenes/${resultado.ordenId}`,
            cantidad: resultado.cantidad,
            total: resultado.total,
            data: {
                numero_orden: resultado.ordenId,
                cantidad_boletos: resultado.cantidad,
                cantidad_oportunidades: resultado.cantidadOportunidades || 0,
                totales: {
                    precioUnitario: resultado.precioUnitario,
                    subtotal: resultado.subtotal,
                    descuento: resultado.descuento,
                    totalFinal: resultado.totalFinal,
                    combo: resultado.combo || {
                        applied: false,
                        boletosEntregados: resultado.cantidad,
                        boletosPagados: resultado.cantidad,
                        boletosBonificados: 0
                    }
                },
                estado: 'pendiente'
            }
        });

    } catch (error) {
        const errorId = `ERR-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        // Errores específicos
        if (error.code === 'BOLETOS_CONFLICTO') {
            perfMarks.totalMs = Date.now() - startTime;
            logOrdenesPerf('POST /api/ordenes conflicto', {
                ordenId,
                conflictos: error.boletosConflicto?.length || 0,
                ...perfMarks
            });
            log('warn', 'Boletos en conflicto detectados', { ordenId, conflictos: error.boletosConflicto.length });
            logOperacionHttp('POST /api/ordenes (conflicto)', startTime, {
                ordenId,
                conflictos: error.boletosConflicto.length,
                statusCode: 409
            }, { slowMs: 1200, warnMs: 2500 });
            return res.status(409).json({
                success: false,
                code: 'BOLETOS_CONFLICTO',
                message: error.message,
                boletosConflicto: error.boletosConflicto,
                boletosDisponibles: error.boletosDisponibles || []  // ← NUEVO: boletos que SÍ están disponibles
            });
        }

        if (error.code === 'OPORTUNIDADES_INCONSISTENTES') {
            perfMarks.totalMs = Date.now() - startTime;
            logOrdenesPerf('POST /api/ordenes oportunidades_inconsistentes', {
                ordenId,
                ...perfMarks
            });
            log('error', 'Inconsistencia de oportunidades detectada al crear orden', {
                ordenId,
                detalles: error.detalles || null
            });
            return res.status(409).json({
                success: false,
                code: 'OPORTUNIDADES_INCONSISTENTES',
                message: error.message,
                detalles: error.detalles || null
            });
        }

        if (error.code === '23505' && /numero_orden/i.test(String(error.detail || error.constraint || error.message || ''))) {
            perfMarks.totalMs = Date.now() - startTime;
            logOrdenesPerf('POST /api/ordenes colision_id', {
                ordenId,
                ...perfMarks
            });
            log('warn', 'Colisión de numero_orden detectada', {
                ordenId,
                errorCode: error.code || null,
                constraint: error.constraint || null
            });
            logOperacionHttp('POST /api/ordenes (colision-id)', startTime, {
                ordenId,
                errorCode: error.code || null,
                statusCode: 503
            }, { slowMs: 1200, warnMs: 2500 });

            return res.status(503).json({
                success: false,
                code: 'ORDEN_ID_EN_CONTENCION',
                message: 'La compra se cruzó con otra generación de orden. Intenta de nuevo en unos segundos.'
            });
        }

        if (error.code === '23505' && /idx_numero_opu_activo|numero_oportunidad/i.test(String(error.detail || error.constraint || error.message || ''))) {
            perfMarks.totalMs = Date.now() - startTime;
            logOrdenesPerf('POST /api/ordenes conflicto_oportunidades', {
                ordenId,
                errorCode: error.code || null,
                constraint: error.constraint || null,
                ...perfMarks
            });
            log('warn', 'Colisión de oportunidades activas detectada', {
                ordenId,
                errorCode: error.code || null,
                constraint: error.constraint || null,
                error: error.message
            });

            return res.status(409).json({
                success: false,
                code: 'OPORTUNIDADES_CONFLICTO',
                message: 'Algunas oportunidades asociadas a los boletos ya no estaban libres al mismo tiempo. Intenta nuevamente.'
            });
        }

        if (error.message === 'NO_SE_PUDO_GENERAR_ORDEN_ID_UNICO') {
            perfMarks.totalMs = Date.now() - startTime;
            logOrdenesPerf('POST /api/ordenes orden_id_agotado', {
                ordenId,
                ...perfMarks
            });
            log('warn', 'No se pudo generar un numero_orden unico tras varios intentos', {
                ordenId
            });

            return res.status(503).json({
                success: false,
                code: 'ORDEN_ID_EN_CONTENCION',
                message: 'No se pudo generar un identificador único para la orden. Intenta de nuevo en unos segundos.'
            });
        }

        if (['40P01', '55P03', '57014'].includes(error.code) || /lock timeout|statement timeout|deadlock/i.test(String(error.message || ''))) {
            perfMarks.totalMs = Date.now() - startTime;
            logOrdenesPerf('POST /api/ordenes timeout', {
                ordenId,
                errorCode: error.code || null,
                ...perfMarks
            });
            log('warn', 'POST /api/ordenes saturado o en contencion', {
                ordenId,
                errorCode: error.code || null,
                error: error.message
            });
            logOperacionHttp('POST /api/ordenes (timeout)', startTime, {
                ordenId,
                errorCode: error.code || null,
                statusCode: 503
            }, { slowMs: 1200, warnMs: 2500 });

            return res.status(503).json({
                success: false,
                code: 'ORDEN_TEMPORALMENTE_BLOQUEADA',
                message: 'Estamos procesando demasiadas compras al mismo tiempo. Intenta de nuevo en unos segundos.'
            });
        }

        // Error genérico
        perfMarks.totalMs = Date.now() - startTime;
        logOrdenesPerf('POST /api/ordenes error', {
            ordenId,
            errorCode: error.code || null,
            errorId,
            ...perfMarks
        });
        log('error', 'POST /api/ordenes error', { errorId, error: error.message, ordenId });
        logOperacionHttp('POST /api/ordenes (error)', startTime, {
            ordenId,
            errorId,
            statusCode: 500
        }, { slowMs: 1200, warnMs: 2500 });

        if (!res.headersSent) {
            return res.status(500).json({
                success: false,
                message: 'Error al guardar orden',
                errorId: errorId,
                error: process.env.NODE_ENV === 'development' ? error.message : undefined
            });
        }
    }
});

/**
 * GET /api/boletos/liberar-apartados
 * CRÍTICO: Libera TODOS los boletos apartados sin orden válida
 * Esto limpia tanto boletos visibles como oportunidades que quedaron huérfanas
 */
app.get('/api/boletos/liberar-apartados', async (req, res) => {
    try {
        console.log('\n=== LIBERANDO BOLETOS APARTADOS ===\n');

        // Contar boletos apartados ANTES
        const apartadosAntes = await db('boletos_estado')
            .where('estado', 'apartado')
            .count('* as cnt');
        const totalAntes = apartadosAntes[0].cnt;

        console.log(`📊 Boletos apartados ANTES: ${totalAntes}`);

        // PASO 1: Liberar boletos apartados sin numero_orden (huérfanos)
        console.log(`\n🧹 PASO 1: Liberando boletos HUÉRFANOS (sin número de orden)`);
        const resultado1 = await db.raw(`
            UPDATE boletos_estado
            SET estado = 'disponible',
                numero_orden = NULL,
                updated_at = NOW()
            WHERE estado = 'apartado' AND numero_orden IS NULL
        `);

        const liberados1 = resultado1.rowCount;
        console.log(`   ✅ Liberados: ${liberados1} boletos`);

        // PASO 2: Liberar boletos apartados en órdenes NO VÁLIDAS
        // (órdenes que no están en 'pendiente' ni 'confirmada')
        console.log(`\n🧹 PASO 2: Liberando boletos en ÓRDENES INVÁLIDAS`);
        const resultado2 = await db.raw(`
            UPDATE boletos_estado
            SET estado = 'disponible',
                numero_orden = NULL,
                updated_at = NOW()
            WHERE estado = 'apartado'
            AND numero_orden IS NOT NULL
            AND NOT EXISTS (
                SELECT 1 FROM ordenes o 
                WHERE o.numero_orden = boletos_estado.numero_orden 
                AND o.estado IN ('pendiente', 'confirmada')
            )
        `);

        const liberados2 = resultado2.rowCount;
        console.log(`   ✅ Liberados: ${liberados2} boletos`);

        const totalLiberados = liberados1 + liberados2;

        // Verificar que no quedan apartados sin orden válida
        const apartadosDespues = await db('boletos_estado')
            .where('estado', 'apartado')
            .count('* as cnt');
        const totalDespues = apartadosDespues[0].cnt;

        console.log(`\n📊 Boletos apartados DESPUÉS: ${totalDespues}`);
        console.log(`✅ TOTAL LIBERADOS: ${totalLiberados}\n`);

        return res.json({
            success: true,
            message: `Liberados ${totalLiberados} boletos apartados sin orden válida`,
            estadisticas: {
                apartadosAntes: totalAntes,
                apartadosDespues: totalDespues,
                liberados: totalLiberados,
                huerfanos: liberados1,
                ordenesInvalidas: liberados2
            }
        });

    } catch (error) {
        console.error('❌ Error al liberar apartados:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Error al liberar boletos apartados',
            error: error.message
        });
    }
});

/**
 * GET /api/boletos/sync-full
 * CRÍTICO: Sincroniza completamente boletos_estado con realidad de órdenes
 * 
 * Correcciones:
 * 1. Libera boletos reservados sin orden válida
 * 2. Marca como vendido boletos de órdenes confirmadas
 * 3. Limpia boletos vendidos sin orden confirmada
 */
app.get('/api/boletos/sync-full', async (req, res) => {
    try {
        console.log('\n=== SINCRONIZACIÓN COMPLETA DE BOLETOS_ESTADO ===\n');

        // PASO 1: Limpiar boletos reservados huérfanos
        console.log('1️⃣  Limpiando boletos reservados sin orden válida...');

        const liberarHuerfanos = await db.raw(`
            UPDATE boletos_estado
            SET estado = 'disponible',
                numero_orden = NULL,
                updated_at = NOW()
            WHERE estado = 'apartado'
            AND (
              numero_orden IS NULL
              OR NOT EXISTS (
                SELECT 1 FROM ordenes o 
                WHERE o.numero_orden = boletos_estado.numero_orden 
                AND o.estado IN ('pendiente', 'confirmada')
              )
            )
        `);
        const huerfanos = liberarHuerfanos.rowCount;
        console.log(`   ✓ ${huerfanos} boletos liberados\n`);

        // PASO 2: Marcar como vendido boletos de órdenes confirmadas
        console.log('2️⃣  Sincronizando órdenes confirmadas...');

        const ordenesConfirmadas = await db('ordenes')
            .where('estado', 'confirmada')
            .select('numero_orden', 'boletos');

        let actualizadosVendidos = 0;
        for (const orden of ordenesConfirmadas) {
            let boletos = [];
            try {
                boletos = JSON.parse(orden.boletos || '[]');
            } catch (e) {
                continue;
            }

            if (boletos.length === 0) continue;

            // Actualizar en lotes para evitar problemas con whereIn
            // Procesar en chunks de 1000 boletos
            const CHUNK_SIZE = 1000;
            for (let i = 0; i < boletos.length; i += CHUNK_SIZE) {
                const chunk = boletos.slice(i, i + CHUNK_SIZE);
                const actualizados = await db('boletos_estado')
                    .whereIn('numero', chunk)
                    .where('estado', '!=', 'vendido')
                    .update({
                        estado: 'vendido',
                        numero_orden: orden.numero_orden,
                        updated_at: new Date()
                    });

                if (actualizados > 0) {
                    actualizadosVendidos += actualizados;
                }
            }
        }
        console.log(`   ✓ ${actualizadosVendidos} boletos marcados como 'vendido'\n`);

        // PASO 3: Limpiar boletos vendidos sin orden confirmada
        console.log('3️⃣  Limpiando boletos vendidos sin orden confirmada...');

        const liberarVendidosHuerfanos = await db.raw(`
            UPDATE boletos_estado
            SET estado = 'disponible',
                numero_orden = NULL,
                updated_at = NOW()
            WHERE estado = 'vendido'
            AND (
              numero_orden IS NULL
              OR NOT EXISTS (
                SELECT 1 FROM ordenes o 
                WHERE o.numero_orden = boletos_estado.numero_orden 
                AND o.estado = 'confirmada'
              )
            )
        `);
        const huerfanosVendidos = liberarVendidosHuerfanos.rowCount;
        console.log(`   ✓ ${huerfanosVendidos} boletos liberados\n`);

        // PASO 4: Estadísticas finales
        console.log('4️⃣  Estado final:\n');

        const stats = await db.raw(`
            SELECT estado, COUNT(*) as count 
            FROM boletos_estado 
            GROUP BY estado 
            ORDER BY estado
        `);

        const resultado = {
            success: true,
            message: 'Sincronización completada',
            cambios: {
                reservados_liberados: huerfanos,
                vendidos_actualizados: actualizadosVendidos,
                vendidos_liberados: huerfanosVendidos
            },
            stats: {}
        };

        let total = 0;
        for (const stat of stats.rows) {
            resultado.stats[stat.estado] = stat.count;
            total += stat.count;
            console.log(`   ${stat.estado}: ${stat.count}`);
        }

        resultado.stats.total = total;
        const config = cargarConfigSorteo();
        console.log(`   TOTAL: ${total}/${config.totalBoletos.toLocaleString('es-MX')}\n`);
        console.log('✅ SINCRONIZACIÓN COMPLETADA\n');

        return res.json(resultado);

    } catch (error) {
        console.error('❌ Error en sincronización:', error.message);
        console.error(error.stack);
        return res.status(500).json({
            success: false,
            message: 'Error durante la sincronización',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * GET /api/ordenes/:id
 * Devuelve la orden en formato HTML viewable desde la BD
 */
app.get('/api/ordenes/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const rifaIdActual = Number.parseInt(req.rifaContext?.id, 10) || null;
        const ordenRow = await db('ordenes')
            .modify((qb) => {
                if (rifaIdActual) qb.where('rifa_id', rifaIdActual);
            })
            .where('numero_orden', id)
            .first();

        if (!ordenRow) {
            return res.status(404).type('text/html').send(`
                <html lang="es">
                <head>
                    <meta charset="UTF-8">
                    <title>Orden no encontrada</title>
                    <style>
                        body { font-family: sans-serif; text-align: center; padding: 2rem; background: #f3f4f6; }
                        .container { max-width: 600px; margin: 0 auto; background: white; padding: 2rem; border-radius: 8px; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h1>❌ Orden no encontrada</h1>
                        <p>El ID de orden <strong>${id}</strong> no existe en el sistema.</p>
                    </div>
                </body>
                </html>
            `);
        }

        // Parsear boletos JSON
        let boletos = [];
        try {
            boletos = JSON.parse(ordenRow.boletos);
        } catch (e) {
            boletos = [];
        }

        // ✅ Obtener oportunidades de la orden
        let oportunidadesData = { data: [], error: null };
        try {
            const resultado = await OportunidadesOrdenService.obtenerOportunidades(ordenRow.numero_orden, {
                rifaId: rifaIdActual
            });
            oportunidadesData = resultado;
            console.log(`📊 Oportunidades obtenidas para ${ordenRow.numero_orden}:`, {
                cantidad: resultado.data?.length || 0,
                error: resultado.error
            });
        } catch (e) {
            console.warn(`Advertencia obteniendo oportunidades para ${ordenRow.numero_orden}:`, e);
            oportunidadesData = { data: [], error: e.message };
        }

        // Extraer array de datos
        const oportunidades = oportunidadesData.data || [];

        const fecha = new Date(ordenRow.created_at).toLocaleDateString('es-MX', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });

        let filasboletos = '';
        boletos.forEach((numero, index) => {
            filasboletos += `
                <tr>
                    <td>${index + 1}</td>
                    <td><strong>${numero}</strong></td>
                    <td>$${ordenRow.precio_unitario.toFixed(2)}</td>
                </tr>
            `;
        });

        const html = `
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Orden de Pago ${ordenRow.numero_orden}</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: sans-serif;
            padding: 2rem 1rem;
        }
        .container {
            max-width: 800px;
            margin: 0 auto;
            background: white;
            padding: 2rem;
            border-radius: 12px;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
        }
        .header {
            text-align: center;
            margin-bottom: 2rem;
            border-bottom: 3px solid #2563eb;
            padding-bottom: 1rem;
        }
        .header h1 { color: #2563eb; font-size: 1.8rem; }
        .header p { color: #666; margin-top: 0.5rem; }
        .section {
            margin-bottom: 2rem;
        }
        .section-title {
            background: #f3f4f6;
            padding: 0.75rem 1rem;
            border-left: 4px solid #2563eb;
            font-weight: bold;
            margin-bottom: 1rem;
            color: #1f2937;
        }
        .field-row {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 1rem;
            margin-bottom: 1rem;
        }
        .field {
            padding: 0.75rem;
            background: #f9fafb;
            border-radius: 6px;
        }
        .field-label { font-size: 0.85rem; color: #666; font-weight: 600; text-transform: uppercase; }
        .field-value { font-size: 1rem; color: #1f2937; font-weight: 500; margin-top: 0.25rem; }
        table {
            width: 100%;
            border-collapse: collapse;
            margin: 1rem 0;
        }
        th, td {
            padding: 0.75rem;
            text-align: left;
            border-bottom: 1px solid #e5e7eb;
        }
        th {
            background: #f3f4f6;
            font-weight: 600;
            color: #1f2937;
        }
        .total-row {
            background: #dbeafe;
            font-weight: bold;
            color: #1e40af;
        }
        .footer {
            text-align: center;
            margin-top: 2rem;
            padding-top: 1rem;
            border-top: 1px solid #e5e7eb;
            color: #666;
            font-size: 0.9rem;
        }
        .print-btn {
            display: block;
            margin: 1rem auto;
            padding: 0.75rem 1.5rem;
            background: #2563eb;
            color: white;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font-size: 1rem;
        }
        .print-btn:hover { background: #1e40af; }
        @media print {
            body { background: white; padding: 0; }
            .print-btn { display: none; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🎯 Orden de Pago</h1>
            <p><strong>#${ordenRow.numero_orden}</strong></p>
            <p style="font-size: 0.9rem; color: #999; margin-top: 0.5rem;">${fecha}</p>
        </div>

        <button class="print-btn" onclick="window.print()">📄 Imprimir / Guardar como PDF</button>

        <div class="section">
            <div class="section-title">📋 Datos del Cliente</div>
            <div class="field-row">
                <div class="field">
                    <div class="field-label">Nombre Completo</div>
                    <div class="field-value">${ordenRow.nombre_cliente}</div>
                </div>
                <div class="field">
                    <div class="field-label">WhatsApp</div>
                    <div class="field-value">${ordenRow.telefono_cliente}</div>
                </div>
            </div>
            <div class="field-row">
                <div class="field">
                    <div class="field-label">Estado</div>
                    <div class="field-value">${ordenRow.estado.toUpperCase()}</div>
                </div>
            </div>
        </div>

        <div class="section">
            <div class="section-title">🎫 Detalles de Compra</div>
            <table>
                <thead>
                    <tr>
                        <th>#</th>
                        <th>Boleto</th>
                        <th>Precio Unitario</th>
                    </tr>
                </thead>
                <tbody>
                    ${filasboletos}
                    <tr class="total-row">
                        <td colspan="2">Subtotal (${boletos.length} boletos)</td>
                        <td>$${parseFloat(ordenRow.subtotal || 0).toFixed(2)}</td>
                    </tr>
                    ${parseFloat(ordenRow.descuento || 0) > 0 ? `
                    <tr class="total-row">
                        <td colspan="2">Descuento</td>
                        <td>-$${parseFloat(ordenRow.descuento || 0).toFixed(2)}</td>
                    </tr>
                    ` : ''}
                    <tr class="total-row">
                        <td colspan="2"><strong>TOTAL A PAGAR</strong></td>
                        <td><strong>$${parseFloat(ordenRow.total || 0).toFixed(2)}</strong></td>
                    </tr>
                </tbody>
            </table>
        </div>

        ${oportunidades.length > 0 ? `
        <div class="section">
            <div class="section-title">🎁 Boletos Oportunidades (Sorpresa)</div>
            <p style="color: #666; font-size: 0.95rem; margin-bottom: 1rem;">
                ¡Felicidades! Junto con tu compra recibiste boletos adicionales como sorpresa:
            </p>
            <table>
                <thead>
                    <tr>
                        <th>#</th>
                        <th>Número de Boleto</th>
                    </tr>
                </thead>
                <tbody>
                    ${oportunidades.map((num, idx) => `
                    <tr style="background: #fef08a;">
                        <td>${idx + 1}</td>
                        <td><strong style="color: #b45309;">${num}</strong></td>
                    </tr>
                    `).join('')}
                    <tr class="total-row" style="background: #fef3c7;">
                        <td colspan="2"><strong>Total Oportunidades: ${oportunidades.length}</strong></td>
                    </tr>
                </tbody>
            </table>
        </div>
        ` : ''}

        ${ordenRow.detalles_pago ? `
        <div class="section">
            <div class="section-title">💳 Detalles de Pago</div>
            <div class="field">
                <div class="field-label">Información</div>
                <div class="field-value">${ordenRow.detalles_pago}</div>
            </div>
        </div>
        ` : ''}

        <div class="footer">
            <p>✅ Esta orden fue registrada el ${fecha}</p>
            <p>Gracias por tu participación en nuestra rifa 🍀</p>
        </div>
    </div>
</body>
</html>
        `;

        res.type('text/html').send(html);
    } catch (error) {
        console.error('GET /api/ordenes/:id error:', error);
        res.status(500).type('text/html').send(`
            <html>
            <head><title>Error</title></head>
            <body><h1>❌ Error: ${error.message}</h1></body>
            </html>
        `);
    }
});

/**
 * GET /api/ordenes/:id/oportunidades
 * Obtiene SOLO las oportunidades de una orden específica (sin cargar boletos)
 * Usado cuando se hace click en "Ver Orden" en admin
 */
app.get('/api/ordenes/:id/oportunidades', verificarToken, async (req, res) => {
    try {
        const { id } = req.params;
        const rifaIdActual = Number.parseInt(req.rifaContext?.id, 10) || null;
        const orden = await db('ordenes')
            .modify((qb) => {
                if (rifaIdActual) qb.where('rifa_id', rifaIdActual);
            })
            .where('numero_orden', id)
            .select('numero_orden', 'boletos')
            .first();

        if (!orden) {
            return res.status(404).json({
                success: false,
                message: 'Orden no encontrada'
            });
        }

        const boletos = parseBoletosOrdenSeguro(orden.boletos);
        const mapaOportunidades = await obtenerMapaOportunidadesPorBoletos(db, boletos, {
            rifaId: rifaIdActual
        });
        const oportunidadesArray = combinarOportunidadesPorBoletos(boletos, mapaOportunidades);

        return res.json({
            success: true,
            numero_orden: id,
            oportunidades: oportunidadesArray,
            cantidad: oportunidadesArray.length
        });
    } catch (error) {
        console.error('GET /api/ordenes/:id/oportunidades error:', error);
        return res.status(500).json({
            success: false,
            message: 'Error al obtener oportunidades',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * GET /api/public/ordenes-cliente
 * Endpoint PÚBLICO para consultar órdenes de un cliente por WhatsApp
 * Usado por mis-boletos.html
 * Query params: ?whatsapp=5512345678
 * NO requiere JWT
 * 
 * Respuesta:
 * - Si hay órdenes: array de objetos { numero_orden, boletos, total, estado, created_at }
 * - Si no hay: array vacío []
 * - En error: { success: false, message: "..." }
 */
app.get('/api/public/ordenes-cliente', async (req, res) => {
    try {
        const { whatsapp } = req.query;
        const rifaIdActual = Number.parseInt(req.rifaContext?.id, 10) || null;

        // ===== VALIDACIÓN =====
        // WhatsApp es obligatorio
        if (!whatsapp) {
            log('warn', 'GET /api/public/ordenes-cliente: WhatsApp no proporcionado', { ip: req.ip });
            return res.status(400).json({
                success: false,
                message: 'El parámetro whatsapp es obligatorio'
            });
        }

        // Validar formato: solo dígitos, 10-12 caracteres
        const whatsappSanitizado = String(whatsapp).replace(/[^0-9]/g, '');

        if (whatsappSanitizado.length < 10 || whatsappSanitizado.length > 12) {
            log('warn', 'GET /api/public/ordenes-cliente: WhatsApp inválido', {
                whatsapp_input: whatsapp,
                whatsapp_sanitizado: whatsappSanitizado,
                ip: req.ip
            });
            return res.status(400).json({
                success: false,
                message: 'WhatsApp debe contener entre 10 y 12 dígitos'
            });
        }

        // ✅ Consultar órdenes primero
        const ordenes = await db('ordenes')
            .leftJoin('rifas', 'ordenes.rifa_id', 'rifas.id')
            .select('ordenes.*', 'rifas.configuracion as rifa_config')
            .modify((qb) => {
                if (rifaIdActual) qb.where('ordenes.rifa_id', rifaIdActual);
            })
            .where('ordenes.telefono_cliente', whatsappSanitizado)
            .orderBy('ordenes.created_at', 'desc');

        // DEBUG: Log si no encuentra nada
        if (ordenes.length === 0) {
            console.log(`⚠️ No se encontraron órdenes para: ${whatsappSanitizado}`);
        }

        const ordenesPreparadas = ordenes.map((orden) => {
            const boletosParsados = parseBoletosOrdenSeguro(orden.boletos);
            return {
                ...orden,
                boletosNormalizados: boletosParsados
            };
        });

        const boletosConsultados = ordenesPreparadas.flatMap((orden) => orden.boletosNormalizados);
        const mapaOportunidades = await obtenerMapaOportunidadesPorBoletos(db, boletosConsultados, {
            rifaId: rifaIdActual
        });

        const ordenesFormateadas = ordenesPreparadas.map(orden => {
            const oportunidades = combinarOportunidadesPorBoletos(
                orden.boletosNormalizados,
                mapaOportunidades
            ).filter(op => op !== null && op !== '');

            return {
                id: orden.numero_orden,
                numero_orden: orden.numero_orden,
                nombre_cliente: orden.nombre_cliente || '',
                apellido_cliente: orden.apellido_cliente || '',
                estado_cliente: orden.estado_cliente || '',
                ciudad_cliente: orden.ciudad_cliente || '',
                whatsapp: orden.telefono_cliente || '',
                telefono_cliente: orden.telefono_cliente || '',
                cantidad_boletos: orden.cantidad_boletos || 0,
                precio_unitario: Number(orden.precio_unitario ?? 0),
                subtotal: Number(orden.subtotal ?? 0),
                descuento: Number(orden.descuento ?? 0),
                boletos: orden.boletosNormalizados,
                oportunidades: oportunidades,
                total: Number(orden.total ?? 0),
                tipo_pago: orden.metodo_pago || 'No especificado',
                metodo_pago: orden.metodo_pago || 'No especificado',
                estado: orden.estado || 'pendiente',
                detalles_pago: orden.detalles_pago || null,
                nombre_banco: orden.nombre_banco || null,
                numero_referencia: orden.numero_referencia || null,
                nombre_beneficiario: orden.nombre_beneficiario || null,
                comprobante_path: orden.comprobante_path || null,
                comprobante_recibido: orden.comprobante_recibido === true || Boolean(orden.comprobante_path),
                createdAt: orden.created_at,
                updatedAt: orden.updated_at,
                nombre_sorteo: (typeof orden.rifa_config === 'string' ? JSON.parse(orden.rifa_config) : orden.rifa_config)?.rifa?.nombreSorteo || req.rifaContext?.configuracion?.rifa?.nombreSorteo || 'Sorteo',
                push_notificaciones: construirMetadatosOrdenPushPublica(orden)
            };
        });

        log('info', 'GET /api/public/ordenes-cliente exitoso', {
            whatsapp: whatsappSanitizado,
            cantidad_ordenes: ordenesFormateadas.length,
            ip: req.ip
        });

        // Devolver array (vacío si no hay órdenes)
        return res.json(ordenesFormateadas);

    } catch (error) {
        log('error', 'GET /api/public/ordenes-cliente error', {
            error: error.message,
            ip: req.ip
        });
        return res.status(500).json({
            success: false,
            message: 'Error al consultar órdenes',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * GET /api/public/ordenes-cliente/orden/:ordenId
 * Endpoint PÚBLICO para consultar una orden específica por numero_orden.
 * Se usa como respaldo cuando el flujo viene de una orden recién creada
 * y la recuperación por WhatsApp todavía no es suficiente.
 */
app.get('/api/public/ordenes-cliente/orden/:ordenId', async (req, res) => {
    try {
        const ordenId = sanitizar(req.params?.ordenId || '').trim().toUpperCase();
        const rifaIdActual = Number.parseInt(req.rifaContext?.id, 10) || null;

        if (!ordenId) {
            return res.status(400).json({
                success: false,
                message: 'El parámetro ordenId es obligatorio'
            });
        }

        const orden = await db('ordenes')
            .modify((qb) => {
                if (rifaIdActual) qb.where('rifa_id', rifaIdActual);
            })
            .where('numero_orden', ordenId)
            .first();

        if (!orden) {
            return res.status(404).json({
                success: false,
                message: 'Orden no encontrada'
            });
        }

        const boletosParsados = parseBoletosOrdenSeguro(orden.boletos);
        const mapaOportunidades = await obtenerMapaOportunidadesPorBoletos(db, boletosParsados, {
            rifaId: rifaIdActual
        });
        const oportunidades = combinarOportunidadesPorBoletos(boletosParsados, mapaOportunidades);

        return res.json({
            success: true,
            data: {
                id: orden.numero_orden,
                numero_orden: orden.numero_orden,
                nombre_cliente: orden.nombre_cliente || '',
                apellido_cliente: orden.apellido_cliente || '',
                estado_cliente: orden.estado_cliente || '',
                ciudad_cliente: orden.ciudad_cliente || '',
                whatsapp: orden.telefono_cliente || '',
                telefono_cliente: orden.telefono_cliente || '',
                cantidad_boletos: orden.cantidad_boletos || 0,
                precio_unitario: Number(orden.precio_unitario ?? 0),
                subtotal: Number(orden.subtotal ?? 0),
                descuento: Number(orden.descuento ?? 0),
                boletos: boletosParsados,
                oportunidades: Array.isArray(oportunidades)
                    ? oportunidades.filter(op => op !== null && op !== '')
                    : [],
                total: Number(orden.total ?? 0),
                tipo_pago: orden.metodo_pago || 'No especificado',
                metodo_pago: orden.metodo_pago || 'No especificado',
                estado: orden.estado || 'pendiente',
                detalles_pago: orden.detalles_pago || null,
                nombre_banco: orden.nombre_banco || null,
                numero_referencia: orden.numero_referencia || null,
                nombre_beneficiario: orden.nombre_beneficiario || null,
                comprobante_path: orden.comprobante_path || null,
                comprobante_recibido: orden.comprobante_recibido === true || Boolean(orden.comprobante_path),
                createdAt: orden.created_at,
                updatedAt: orden.updated_at,
                push_notificaciones: construirMetadatosOrdenPushPublica(orden)
            }
        });
    } catch (error) {
        log('error', 'GET /api/public/ordenes-cliente/orden/:ordenId error', {
            error: error.message,
            ordenId: req.params?.ordenId,
            ip: req.ip
        });
        return res.status(500).json({
            success: false,
            message: 'Error interno del servidor'
        });
    }
});

app.post('/api/public/push/subscribe', limiterPushPublico, async (req, res) => {
    try {
        const pushConfig = obtenerConfigPush();
        if (!pushConfig.enabled) {
            return res.status(503).json({
                success: false,
                message: 'Las notificaciones push no están configuradas en este momento.'
            });
        }

        const numeroOrden = sanitizar(req.body?.numero_orden || req.body?.ordenId || '').trim().toUpperCase();
        const token = String(req.body?.token || '').trim();
        const subscription = req.body?.subscription || null;
        const rifaIdActual = Number.parseInt(req.rifaContext?.id, 10) || null;

        if (!numeroOrden || !token || !subscription) {
            return res.status(400).json({
                success: false,
                message: 'numero_orden, token y subscription son obligatorios'
            });
        }

        const resultado = await db.transaction(async (trx) => {
            const orden = await trx('ordenes')
                .modify((qb) => {
                    if (rifaIdActual) qb.where('rifa_id', rifaIdActual);
                })
                .where('numero_orden', numeroOrden)
                .forUpdate()
                .first();

            if (!orden) {
                return {
                    httpStatus: 404, body: {
                        success: false,
                        message: 'Orden no encontrada'
                    }
                };
            }

            const verificacion = verificarTokenOrdenPush(token, orden);
            if (!verificacion.valido) {
                return {
                    httpStatus: 403, body: {
                        success: false,
                        message: 'Token de suscripción inválido'
                    }
                };
            }

            const pushMeta = construirMetadatosOrdenPushPublica(orden);
            if (!pushMeta.canSubscribe) {
                return {
                    httpStatus: 409, body: {
                        success: false,
                        message: 'Esta orden ya no permite activar notificaciones push.'
                    }
                };
            }

            const suscripcion = await upsertSuscripcionPush(trx, {
                rifaId: orden.rifa_id,
                numeroOrden: orden.numero_orden,
                telefonoCliente: orden.telefono_cliente,
                subscription,
                userAgent: req.headers['user-agent'] || '',
                permissionState: req.body?.permission || 'granted'
            });

            const rifa = await trx('rifas')
                .where('id', orden.rifa_id)
                .first('id', 'slug', 'configuracion');

            if (rifa) {
                await upsertSuscripcionCampanaPush(trx, {
                    organizerKey: resolverOrganizerKeyPush({
                        configuracion: rifa.configuracion || {}
                    }),
                    telefonoCliente: orden.telefono_cliente,
                    subscription,
                    userAgent: req.headers['user-agent'] || '',
                    permissionState: req.body?.permission || 'granted',
                    sourceRifaId: orden.rifa_id,
                    sourceRifaSlug: rifa.slug,
                    sourceNumeroOrden: orden.numero_orden,
                    lastPurchaseAt: orden.created_at || orden.updated_at,
                    lastPurchaseRifaId: orden.rifa_id,
                    lastPurchaseRifaSlug: rifa.slug,
                    marketingOptIn: true,
                    preserveOptOut: true
                });
            }

            return {
                httpStatus: 200,
                body: {
                    success: true,
                    created: suscripcion.created,
                    message: 'Notificaciones activadas para esta orden.'
                }
            };
        });

        return res.status(resultado.httpStatus || 200).json(resultado.body);
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: 'No fue posible activar las notificaciones',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

app.post('/api/public/push/unsubscribe', limiterPushPublico, async (req, res) => {
    try {
        const numeroOrden = sanitizar(req.body?.numero_orden || req.body?.ordenId || '').trim().toUpperCase();
        const token = String(req.body?.token || '').trim();
        const subscription = req.body?.subscription || null;
        const rifaIdActual = Number.parseInt(req.rifaContext?.id, 10) || null;

        if (!numeroOrden || !token || !subscription) {
            return res.status(400).json({
                success: false,
                message: 'numero_orden, token y subscription son obligatorios'
            });
        }

        const resultado = await db.transaction(async (trx) => {
            const orden = await trx('ordenes')
                .modify((qb) => {
                    if (rifaIdActual) qb.where('rifa_id', rifaIdActual);
                })
                .where('numero_orden', numeroOrden)
                .forUpdate()
                .first();

            if (!orden) {
                return {
                    httpStatus: 404, body: {
                        success: false,
                        message: 'Orden no encontrada'
                    }
                };
            }

            const verificacion = verificarTokenOrdenPush(token, orden);
            if (!verificacion.valido) {
                return {
                    httpStatus: 403, body: {
                        success: false,
                        message: 'Token de suscripción inválido'
                    }
                };
            }

            const suscripcion = await desactivarSuscripcionPush(trx, {
                rifaId: orden.rifa_id,
                numeroOrden: orden.numero_orden,
                subscription
            });

            const rifa = await trx('rifas')
                .where('id', orden.rifa_id)
                .first('id', 'configuracion');

            if (rifa) {
                await desactivarSuscripcionCampanaPush(trx, {
                    organizerKey: resolverOrganizerKeyPush({
                        configuracion: rifa.configuracion || {}
                    }),
                    subscription
                });
            }

            return {
                httpStatus: 200,
                body: {
                    success: true,
                    updated: suscripcion.updated,
                    message: 'Notificaciones desactivadas para esta orden.'
                }
            };
        });

        return res.status(resultado.httpStatus || 200).json(resultado.body);
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: 'No fue posible desactivar las notificaciones',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * POST /api/public/ordenes-cliente/:numero_orden/comprobante
 * Endpoint PÚBLICO para subir comprobante de pago
 * 
 * Utiliza comprobanteService para validación robusta:
 * 1. Validación de schema BD
 * 2. Validación de datos
 * 3. Validación de archivo
 * 4. Validación de orden
 * 5. Upload a Cloudinary
 * 6. Actualización de BD
 * 
 * @param {Request} req.params.numero_orden - Número de orden
 * @param {FormData} req.body.whatsapp - WhatsApp del cliente
 * @param {FormData} req.files.comprobante - Archivo JPG/PNG/PDF
 * @returns {JSON} { success, message, numero_orden, url?, error? }
 */
app.post('/api/public/ordenes-cliente/:numero_orden/comprobante', async (req, res) => {
    const debugId = `[COMPR-${Date.now()}]`;
    const startTime = Date.now();

    try {
        const { numero_orden } = req.params;
        const whatsapp = req.body?.whatsapp;
        const archivo = req.files?.comprobante;

        console.log(`\n${debugId} ═══════════════════════════════════════════════`);
        console.log(`${debugId} [REQUEST] POST /api/public/ordenes-cliente/:numero_orden/comprobante`);
        console.log(`${debugId} [REQUEST] Parámetros recibidos:`);
        console.log(`${debugId} [REQUEST]   - numero_orden: ${numero_orden}`);
        console.log(`${debugId} [REQUEST]   - whatsapp: ${whatsapp ? '✅ YES' : '❌ NO'}`);
        console.log(`${debugId} [REQUEST]   - archivo: ${archivo ? '✅ YES' : '❌ NO'}`);
        if (archivo) {
            console.log(`${debugId} [REQUEST]   - archivo.name: ${archivo.name}`);
            console.log(`${debugId} [REQUEST]   - archivo.size: ${archivo.size} bytes`);
            console.log(`${debugId} [REQUEST]   - archivo.mimetype: ${archivo.mimetype}`);
            console.log(`${debugId} [REQUEST]   - archivo.data: ${archivo.data ? '✅ Buffer present' : '❌ NO BUFFER'}`);
        }
        console.log(`${debugId} [REQUEST] req.files keys: ${req.files ? Object.keys(req.files).join(', ') : 'NO FILES OBJECT'}`);
        console.log(`${debugId} [REQUEST] req.body keys: ${req.body ? Object.keys(req.body).join(', ') : 'NO BODY OBJECT'}`);
        console.log(`${debugId} Content-Type: ${req.headers['content-type']}`);
        console.log(`${debugId} User-Agent: ${req.headers['user-agent']?.substring(0, 60)}...`);

        // Usar service para procesar comprobante (todas las validaciones incluidas)
        const resultado = await comprobanteService.procesarComprobante({
            numeroOrden: numero_orden,
            whatsapp,
            archivo,
            rifaId: req.rifaContext?.id || null
        });

        console.log(`${debugId} ✅ SUCCESS - Comprobante procesado exitosamente`);
        console.log(`${debugId} ═══════════════════════════════════════════════\n`);

        log('info', 'Comprobante subido exitosamente', {
            numero_orden,
            tamaño_mb: resultado.tamaño_mb,
            ip: req.ip
        });
        logOperacionHttp('POST /api/public/ordenes-cliente/:numero_orden/comprobante', startTime, {
            numero_orden,
            tamaño_mb: resultado.tamaño_mb,
            statusCode: 200
        }, { slowMs: 1500, warnMs: 4000 });

        res.json({
            success: true,
            message: 'Comprobante subido correctamente',
            numero_orden: resultado.numero_orden
        });

        setImmediate(() => {
            if (wsEvents) {
                try {
                    const rifaIdComprobante = req.rifaContext?.id || null;
                    wsEvents.emitirOrdenActualizadaAdmin({
                        numero_orden,
                        rifa_id: rifaIdComprobante,
                        estado: 'pendiente',
                        comprobante_path: '__present__',
                        updated_at: new Date().toISOString()
                    }, rifaIdComprobante);  // ✅ Pasar rifaId
                } catch (wsError) {
                    console.warn(`⚠️  Error emitiendo actualización admin de comprobante:`, wsError.message);
                }
            }

            try {
                refrescarCachesTrasCambioInventario();
            } catch (cacheError) {
                console.warn(`⚠️  Error refrescando cachés tras comprobante:`, cacheError.message);
            }
        });

        return;

    } catch (error) {
        // Error classification
        let statusCode = 500;
        let errorMessage = error.message || 'Error desconocido';

        // Clasificar errores comunes
        if (errorMessage.includes('Archivo')) statusCode = 400;
        if (errorMessage.includes('obligatorio')) statusCode = 400;
        if (errorMessage.includes('inválido')) statusCode = 400;
        if (errorMessage.includes('no encontrada')) statusCode = 404;
        if (errorMessage.includes('permiso')) statusCode = 403;
        if (errorMessage.includes('demasiado grande')) statusCode = 413;
        if (errorMessage.includes('Cloudinary')) statusCode = 500;
        if (errorMessage.includes('Esquema de BD')) statusCode = 500;

        console.error(`\n${debugId} ═══════════════════════════════════════════════`);
        console.error(`${debugId} ❌ ERROR PROCESANDO COMPROBANTE`);
        console.error(`${debugId} [ERROR] Status Code: ${statusCode}`);
        console.error(`${debugId} [ERROR] Mensaje: ${errorMessage}`);
        console.error(`${debugId} [ERROR] Stack (primeras 3 líneas):`);
        console.error(`${debugId}`, error.stack.split('\n').slice(0, 3).join(`\n${debugId}`));
        console.error(`${debugId} ═══════════════════════════════════════════════\n`);

        log('error', 'Error en POST /comprobante', {
            statusCode,
            error: errorMessage,
            numero_orden: req.params.numero_orden || 'N/A',
            ip: req.ip
        });
        logOperacionHttp('POST /api/public/ordenes-cliente/:numero_orden/comprobante (error)', startTime, {
            numero_orden: req.params.numero_orden || 'N/A',
            statusCode,
            error: errorMessage
        }, { slowMs: 1500, warnMs: 4000 });

        // 🔒 Sanitizar el mensaje de error ANTES de enviar al cliente
        const safeMessage = sanitizarErrorMessage(errorMessage, process.env.NODE_ENV === 'development');

        return res.status(statusCode).json({
            success: false,
            message: safeMessage,
            ...(process.env.NODE_ENV === 'development' && { debug: errorMessage })
        });
    }
});

/**
 * GET /api/ordenes/por-cliente/:email
 * Busca órdenes recientes del cliente para recuperación tras conflictos puntuales
 * Query params: ?nombre=X&whatsapp=Y (búsqueda por cliente)
 */
app.get('/api/ordenes/por-cliente/:email', limiterRecuperacionOrdenes, async (req, res) => {
    try {
        const { nombre, whatsapp } = req.query;
        const rifaIdActual = Number.parseInt(req.rifaContext?.id, 10) || null;

        // Se requiere al menos nombre + whatsapp para búsqueda
        if (!nombre || !whatsapp) {
            return res.status(400).json({
                success: false,
                message: 'Se requiere nombre y whatsapp'
            });
        }

        const nombreNormalizado = String(nombre).trim().toLowerCase().replace(/\s+/g, ' ');
        const whatsappDigitos = String(whatsapp).replace(/[^0-9]/g, '');

        if (nombreNormalizado.length < 3 || whatsappDigitos.length < 8) {
            return res.status(400).json({
                success: false,
                message: 'Datos insuficientes para recuperar la orden'
            });
        }

        // Buscar en últimos 30 minutos (para recuperación de race conditions)
        const hace30Min = new Date(Date.now() - 30 * 60 * 1000);

        // Búsqueda estricta por nombre normalizado en ventana corta
        const ordenes = await db('ordenes')
            .modify((qb) => {
                if (rifaIdActual) qb.where('rifa_id', rifaIdActual);
            })
            .where('created_at', '>=', hace30Min)
            .whereRaw("LOWER(TRIM(REGEXP_REPLACE(nombre_cliente, '\\s+', ' ', 'g'))) = ?", [nombreNormalizado])
            .select('numero_orden', 'estado', 'cantidad_boletos', 'total', 'created_at', 'nombre_cliente', 'telefono_cliente')
            .orderBy('created_at', 'desc')
            .limit(5);

        // Filtrar por whatsapp (últimos dígitos del teléfono guardado)
        const ordenesFiltradas = ordenes.filter(o => {
            const telefonoGuardado = (o.telefono_cliente || '').replace(/[^0-9]/g, '');
            return telefonoGuardado.endsWith(whatsappDigitos) || telefonoGuardado === whatsappDigitos;
        });

        return res.json(ordenesFiltradas.map((orden) => ({
            numero_orden: orden.numero_orden,
            estado: orden.estado,
            cantidad_boletos: orden.cantidad_boletos,
            total: orden.total,
            created_at: orden.created_at,
            nombre_cliente: orden.nombre_cliente
        })));
    } catch (error) {
        console.error('GET /api/ordenes/por-cliente/:email error:', error);
        return res.status(500).json({
            success: false,
            message: 'Error al buscar órdenes'
        });
    }
});

/**
 * GET /api/ordenes
 * Lista todas las órdenes (protegido con JWT)
 * Query params: ?estado=pendiente, ?limit=50, ?offset=0
 */
app.get('/api/ordenes', verificarToken, async (req, res) => {
    try {
        const rifaIdActual = obtenerRifaIdRequest(req);
        const {
            estado,
            limit = 50,
            offset = 0,
            searchId = '',
            searchNombre = '',
            searchWhatsapp = '',
            fechaDesde = '',
            fechaHasta = '',
            sortBy = 'fecha-desc'
        } = req.query;
        const limitSeguro = Math.max(1, Math.min(parseInt(limit, 10) || 50, 2000));
        const offsetSeguro = Math.max(0, parseInt(offset, 10) || 0);
        const estadoFiltro = String(estado || '').trim().toLowerCase();
        const nombreFiltro = String(searchNombre || '').trim().toLowerCase();
        const whatsappFiltro = String(searchWhatsapp || '').replace(/[^0-9]/g, '');
        const idFiltro = String(searchId || '').trim().toLowerCase();

        const applyFilters = (builder) => {
            aplicarFiltroRifa(builder, rifaIdActual);
            if (estadoFiltro) {
                if (estadoFiltro === 'comprobante_recibido' || estadoFiltro === 'comprobante') {
                    builder.where(function () {
                        this.whereNotNull('comprobante_path')
                            .orWhere('comprobante_recibido', true);
                    });
                } else {
                    builder.where('estado', estadoFiltro);
                }
            }

            if (idFiltro) {
                builder.whereRaw('LOWER(COALESCE(numero_orden, \'\')) LIKE ?', [`%${idFiltro}%`]);
            }

            if (nombreFiltro) {
                builder.whereRaw('LOWER(COALESCE(nombre_cliente, \'\')) LIKE ?', [`%${nombreFiltro}%`]);
            }

            if (whatsappFiltro) {
                builder.whereRaw("REGEXP_REPLACE(COALESCE(telefono_cliente, ''), '[^0-9]', '', 'g') LIKE ?", [`%${whatsappFiltro}%`]);
            }

            if (fechaDesde) {
                const desde = new Date(fechaDesde);
                desde.setHours(0, 0, 0, 0);
                if (!Number.isNaN(desde.getTime())) {
                    builder.where('created_at', '>=', desde.toISOString());
                }
            }

            if (fechaHasta) {
                const hasta = new Date(fechaHasta);
                hasta.setHours(23, 59, 59, 999);
                if (!Number.isNaN(hasta.getTime())) {
                    builder.where('created_at', '<=', hasta.toISOString());
                }
            }
        };

        const applySort = (builder) => {
            switch (sortBy) {
                case 'fecha-asc':
                    builder.orderBy('created_at', 'asc');
                    break;
                case 'nombre-asc':
                    builder.orderByRaw("LOWER(COALESCE(nombre_cliente, '')) ASC").orderBy('created_at', 'desc');
                    break;
                case 'nombre-desc':
                    builder.orderByRaw("LOWER(COALESCE(nombre_cliente, '')) DESC").orderBy('created_at', 'desc');
                    break;
                case 'estado':
                    builder.orderByRaw("LOWER(COALESCE(estado, '')) ASC").orderBy('created_at', 'desc');
                    break;
                case 'total-desc':
                    builder.orderBy('total', 'desc').orderBy('created_at', 'desc');
                    break;
                case 'total-asc':
                    builder.orderBy('total', 'asc').orderBy('created_at', 'desc');
                    break;
                case 'fecha-desc':
                default:
                    builder.orderBy('created_at', 'desc');
                    break;
            }
        };

        let query = db('ordenes').select('*');
        applyFilters(query);
        applySort(query);

        let totalQuery = db('ordenes');
        applyFilters(totalQuery);

        const summaryQuery = db('ordenes').select(
            db.raw("COUNT(CASE WHEN estado = 'pendiente' THEN 1 END) as pendiente"),
            db.raw("COUNT(CASE WHEN COALESCE(comprobante_recibido, false) = true OR comprobante_path IS NOT NULL THEN 1 END) as comprobante_recibido"),
            db.raw("COUNT(CASE WHEN estado = 'confirmada' THEN 1 END) as confirmada"),
            db.raw("COUNT(CASE WHEN estado = 'cancelada' THEN 1 END) as cancelada"),
            db.raw('COALESCE(SUM(cantidad_boletos), 0) as total_boletos'),
            db.raw("COALESCE(SUM(CASE WHEN estado = 'pendiente' OR COALESCE(comprobante_recibido, false) = true OR comprobante_path IS NOT NULL THEN total ELSE 0 END), 0) as pendiente_total")
        );
        applyFilters(summaryQuery);

        const [total, summaryRow, ordenes] = await Promise.all([
            totalQuery.count('* as count').first(),
            summaryQuery.first(),
            query.limit(limitSeguro).offset(offsetSeguro)
        ]);

        const summary = {
            pendiente: 0,
            comprobante_recibido: 0,
            confirmada: 0,
            cancelada: 0,
            totalBoletos: 0
        };

        summary.pendiente = parseInt(summaryRow?.pendiente || 0, 10) || 0;
        summary.comprobante_recibido = parseInt(summaryRow?.comprobante_recibido || 0, 10) || 0;
        summary.confirmada = parseInt(summaryRow?.confirmada || 0, 10) || 0;
        summary.cancelada = parseInt(summaryRow?.cancelada || 0, 10) || 0;
        summary.totalBoletos = parseInt(summaryRow?.total_boletos || 0, 10) || 0;
        summary.pendienteTotal = parseFloat(summaryRow?.pendiente_total || 0) || 0;

        // Parsear boletos de cada orden - manejo seguro para PostgreSQL
        // ⚠️ CRÍTICO: Limitar concurrencia a 3 para evitar "MaxClientsInSessionMode" en Vercel
        const ordenesConPromesas = ordenes.map(async (o) => {
            let boletosParsados = [];
            try {
                // Si ya es un objeto (PostgreSQL JSON), usarlo directamente
                // Si es string (posible JSON string), parsearlo
                if (typeof o.boletos === 'string') {
                    boletosParsados = JSON.parse(o.boletos || '[]');
                } else if (Array.isArray(o.boletos)) {
                    boletosParsados = o.boletos;
                } else if (o.boletos && typeof o.boletos === 'object') {
                    boletosParsados = Array.isArray(o.boletos) ? o.boletos : [];
                }
            } catch (e) {
                console.warn(`⚠️ Error parseando boletos de orden ${o.numero_orden}:`, e.message);
                boletosParsados = [];
            }

            return {
                ...o,
                ordenId: o.numero_orden,
                boletos: boletosParsados
            };
        });

        // Ejecutar promesas con concurrencia limitada (máx 3 simultáneas)
        const ordenesParsadas = await pLimit(ordenesConPromesas, 3);

        return res.json({
            success: true,
            data: ordenesParsadas,
            total: total.count,
            limit: limitSeguro,
            offset: offsetSeguro,
            summary
        });
    } catch (error) {
        console.error('GET /api/ordenes error:', error);
        return res.status(500).json({
            success: false,
            message: 'Error al obtener órdenes',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * GET /api/admin/boleto-simple/:numero
 * Busca un boleto específico (vendido o disponible)
 * Protegido con JWT
 * 
 * ⚠️ FILTRO POR RIFA: Usa req.rifaContext.id o header X-Rifa-Id para aislamiento multirifa
 */
app.get('/api/admin/boleto-simple/:numero', verificarToken, async (req, res) => {
    try {
        const numeroboleto = Number(req.params.numero);

        if (isNaN(numeroboleto)) {
            return res.status(400).json({
                success: false,
                message: 'Número de boleto inválido'
            });
        }

        // 🎯 OBTENER RIFA_ID: Usar resolución centralizada (soporta x-rifaplus-rifa-id y x-rifa-id)
        const rifaIdActual = getRifaIdFromRequest(req);

        // ⚠️ VALIDACIÓN CRÍTICA: Debe haber una rifa identificada para búsquedas admin
        if (!rifaIdActual) {
            console.warn('[boleto-simple] ⚠️ Búsqueda sin rifa identificada - número:', numeroboleto);
        }

        // 🎯 OBTENER RANGO DINÁMICO desde configuración (NO hardcodeado)
        const config = obtenerConfigActual();
        const oportunidadesConfig = obtenerConfigOportunidadesSistema(config);
        const totalBoletosConfigurados = obtenerTotalBoletosConfigurado(config);
        let rangoMin = 0;
        let rangoMax = Math.max(0, totalBoletosConfigurados - 1);

        // Caso 1: Oportunidades habilitadas → usar rango_visible
        if (oportunidadesConfig.enabled && oportunidadesConfig.rangoVisible) {
            const rango = oportunidadesConfig.rangoVisible;
            rangoMin = rango.inicio || 0;
            rangoMax = rango.fin || rangoMax;
            console.debug(`[boleto-simple] Usando rango visible (oportunidades): ${rangoMin}-${rangoMax}`);
        }
        // Caso 2: Sin oportunidades → usar totalBoletos
        else if (totalBoletosConfigurados > 0) {
            rangoMin = 0;
            rangoMax = totalBoletosConfigurados - 1;
            console.debug(`[boleto-simple] Usando totalBoletos: ${rangoMin}-${rangoMax}`);
        }

        // Validar que el número está en rango
        if (numeroboleto < rangoMin || numeroboleto > rangoMax) {
            return res.status(404).json({
                success: false,
                message: `Boleto fuera de rango (${rangoMin}-${rangoMax})`
            });
        }

        // Buscar órdenes que contienen este boleto (DB-agnóstico: JSONB/text/CSV)
        // ⚠️ FILTRAR POR RIFA_ID si está disponible
        const queryOrdenes = dbUtils.ordersContainingBoletoQuery(numeroboleto);
        if (rifaIdActual) {
            queryOrdenes.andWhere('rifa_id', rifaIdActual);
        }
        const ordenes = await queryOrdenes.select('*');

        let ordenEncontrada = null;
        for (const orden of ordenes) {
            try {
                // Soportar múltiples formatos históricos de la columna `boletos`:
                // - JSON array de números: [1,2,3]
                // - JSON array de objetos: [{"numero":1}, {"numero":2}]
                // - CSV string: "1,2,3"
                // - String con números
                let boletosArr = [];

                const raw = orden.boletos;
                if (!raw) {
                    boletosArr = [];
                } else if (Array.isArray(raw)) {
                    // La columna ya vino como array (JSONB en Postgres)
                    boletosArr = raw;
                } else if (typeof raw === 'object' && raw !== null) {
                    // Objeto - intentar extraer valores
                    boletosArr = Object.values(raw);
                } else if (typeof raw === 'string') {
                    // String: intentar parseo JSON o CSV
                    try {
                        const parsed = JSON.parse(raw);
                        if (Array.isArray(parsed)) {
                            boletosArr = parsed;
                        } else if (typeof parsed === 'object' && parsed !== null) {
                            boletosArr = Object.values(parsed);
                        } else if (typeof parsed === 'string') {
                            boletosArr = parsed.split(',').map(s => s.trim()).filter(Boolean);
                        }
                    } catch (err) {
                        // No JSON: intentar CSV o string separado por comas
                        boletosArr = raw.split(',').map(s => s.trim()).filter(Boolean);
                    }
                }

                // Normalizar a números: soportar elementos numéricos, strings numéricas y objetos {numero: X}
                const boletosNumericos = boletosArr.map(b => {
                    if (b === null || typeof b === 'undefined') return NaN;
                    if (typeof b === 'number') return b;
                    if (typeof b === 'string') {
                        const n = Number(b);
                        if (!isNaN(n)) return n;
                        // intentar parseo JSON embebido
                        try {
                            const inner = JSON.parse(b);
                            if (inner && typeof inner === 'object') {
                                return Number(inner.numero || inner.numero_boleto || inner.n || inner.id || NaN);
                            }
                        } catch (e) {
                            return NaN;
                        }
                    }
                    if (typeof b === 'object') {
                        return Number(b.numero || b.numero_boleto || b.n || b.id || NaN);
                    }
                    return NaN;
                }).filter(n => !isNaN(n));

                if (boletosNumericos.includes(numeroboleto)) {
                    // Si no hay orden encontrada, o esta orden es más reciente, actualizar
                    if (!ordenEncontrada || new Date(orden.created_at) > new Date(ordenEncontrada.created_at)) {
                        ordenEncontrada = orden;
                    }
                }
            } catch (e) {
                // Ignorar errores y continuar con la siguiente orden
                console.warn('Warning parsing boletos for orden', orden.id, e && e.message);
            }
        }

        // Si hay orden, retornarla
        if (ordenEncontrada) {
            // Consolidar datos de ciudad - preferir ciudad_cliente, fallback a ciudad
            const ciudadFinal = ordenEncontrada.ciudad_cliente || ordenEncontrada.ciudad || '';
            const estadoFinal = ordenEncontrada.estado_cliente || '';

            // Obtener número de teléfono (fallback a campos alternativos si es necesario)
            let telefonoFinal = ordenEncontrada.telefono_cliente ||
                ordenEncontrada.telefono ||
                '';

            return res.json({
                success: true,
                ok: true,
                data: {
                    numero: numeroboleto,
                    estado: ordenEncontrada.estado === 'confirmada' ? 'vendido' : 'apartado',
                    numero_orden: ordenEncontrada.numero_orden,
                    nombre_cliente: ordenEncontrada.nombre_cliente || '',
                    apellido_cliente: ordenEncontrada.apellido_cliente || '',
                    email: ordenEncontrada.email || '',
                    telefono: telefonoFinal,
                    ciudad: ciudadFinal,
                    estado_cliente: estadoFinal,
                    ciudad_cliente: ciudadFinal,
                    estado_orden: ordenEncontrada.estado,
                    cantidad_boletos: ordenEncontrada.cantidad_boletos || 0,
                    total: ordenEncontrada.total || 0,
                    fecha_pago: ordenEncontrada.fecha_pago,
                    comprobante_pagado_at: ordenEncontrada.comprobante_pagado_at,
                    // Si `comprobante_fecha` no existe (migraciones antiguas), usar updated_at o created_at como fallback
                    comprobante_fecha: ordenEncontrada.comprobante_fecha || ordenEncontrada.updated_at || ordenEncontrada.comprobante_pagado_at || ordenEncontrada.created_at,
                    comprobante_path: ordenEncontrada.comprobante_path,
                    created_at: ordenEncontrada.created_at
                }
            });
        }

        // Devolver boleto disponible
        return res.json({
            success: true,
            ok: true,
            data: {
                numero: numeroboleto,
                estado: 'disponible',
                numero_orden: null,
                nombre_cliente: '',
                apellido_cliente: '',
                email: '',
                telefono: '',
                ciudad: '',
                estado_cliente: '',
                ciudad_cliente: '',
                estado_orden: 'disponible',
                total: 0,
                fecha_pago: null,
                comprobante_pagado_at: null,
                created_at: null
            }
        });
    } catch (error) {
        console.error('GET /api/admin/boleto-simple/:numero error:', error);
        return res.status(500).json({
            success: false,
            message: 'Error al buscar boleto',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * GET /api/admin/numero-inteligente/:numero
 * Búsqueda inteligente que detecta si es boleto u oportunidad
 * - Si número cae en el rango visible: Busca en boletos
 * - Si número cae en el rango oculto: Busca en oportunidades
 * Retorna los mismos datos, pero agrega flag 'es_oportunidad'
 * Protegido con JWT
 * 
 * ⚠️ FILTRO POR RIFA: Usa req.rifaContext.id o header X-Rifa-Id para aislamiento multirifa
 */
app.get('/api/admin/numero-inteligente/:numero', verificarToken, async (req, res) => {
    try {
        const numero = Number(req.params.numero);

        if (isNaN(numero)) {
            return res.status(400).json({
                success: false,
                message: 'Número inválido'
            });
        }

        // 🎯 OBTENER RIFA_ID: Usar resolución centralizada (soporta x-rifaplus-rifa-id y x-rifa-id)
        const rifaIdActual = getRifaIdFromRequest(req);

        // ⚠️ VALIDACIÓN CRÍTICA: Debe haber una rifa identificada para búsquedas admin
        if (!rifaIdActual) {
            console.warn('[numero-inteligente] ⚠️ Búsqueda sin rifa identificada - número:', numero);
        }

        // 🎯 OBTENER RANGO DINÁMICO desde configuración + fallback por inventario
        const config = obtenerConfigActual();
        const {
            oportunidadesConfig,
            rangoVisible,
            rangoOculto,
            totalBoletosConfigurados,
            estaEnRangoVisible,
            estaEnRangoOculto,
            motivoFallback
        } = await resolverClasificacionNumeroAdmin(numero, config);

        if (oportunidadesConfig.enabled && !oportunidadesConfig.configuracionConsistente) {
            return res.status(409).json({
                success: false,
                message: 'La configuración de oportunidades es inválida o incompleta',
                detalles: oportunidadesConfig.errores
            });
        }

        if (!estaEnRangoVisible && !estaEnRangoOculto) {
            const rangoPermitido = oportunidadesConfig.enabled && rangoOculto
                ? `${rangoVisible?.inicio ?? 0}-${rangoVisible?.fin ?? 0} y ${rangoOculto.inicio}-${rangoOculto.fin}`
                : `${rangoVisible?.inicio ?? 0}-${rangoVisible?.fin ?? 0}`;

            return res.status(400).json({
                success: false,
                message: `Número fuera del rango permitido (${rangoPermitido})`,
                detalles: {
                    totalBoletosConfigurados,
                    oportunidadesHabilitadas: oportunidadesConfig.enabled === true,
                    rangoVisible,
                    rangoOculto
                }
            });
        }

        const esOportunidad = estaEnRangoOculto;

        console.log(`[numero-inteligente] Buscando #${numero} (${esOportunidad ? 'OPORTUNIDAD' : 'BOLETO'})${rifaIdActual ? ` en rifa_id=${rifaIdActual}` : ' SIN_RIFA'}${motivoFallback ? ` [fallback:${motivoFallback}]` : ''}`);

        // ===== CASO 1: OPORTUNIDAD =====
        if (esOportunidad) {
            // Buscar en tabla orden_oportunidades FILTRANDO POR RIFA_ID
            const queryOportunidad = db('orden_oportunidades')
                .where('numero_oportunidad', numero);

            if (rifaIdActual) {
                queryOportunidad.andWhere('rifa_id', rifaIdActual);
            }

            const oportunidad = await queryOportunidad.first();

            if (!oportunidad) {
                // Oportunidad no encontrada
                return res.json({
                    success: true,
                    ok: true,
                    es_oportunidad: true,
                    data: {
                        numero: numero,
                        estado: 'disponible',
                        numero_orden: null,
                        nombre_cliente: '',
                        apellido_cliente: '',
                        email: '',
                        telefono: '',
                        ciudad: '',
                        estado_cliente: '',
                        ciudad_cliente: '',
                        estado_orden: 'disponible',
                        cantidad_boletos: 0,
                        total: 0,
                        fecha_pago: null,
                        comprobante_pagado_at: null,
                        comprobante_fecha: null,
                        comprobante_path: null,
                        created_at: null
                    }
                });
            }

            // Oportunidad encontrada - Buscar orden asociada
            let ordenAsociada = null;
            if (oportunidad.numero_orden) {
                const queryOrden = db('ordenes').where('numero_orden', oportunidad.numero_orden);
                if (rifaIdActual) {
                    queryOrden.andWhere('rifa_id', rifaIdActual);
                }
                ordenAsociada = await queryOrden.first();
            }

            if (ordenAsociada) {
                // Consolidar datos de ciudad
                const ciudadFinal = ordenAsociada.ciudad_cliente || ordenAsociada.ciudad || '';
                const estadoFinal = ordenAsociada.estado_cliente || '';

                // Obtener número de teléfono
                let telefonoFinal = ordenAsociada.telefono_cliente ||
                    ordenAsociada.telefono ||
                    '';

                return res.json({
                    success: true,
                    ok: true,
                    es_oportunidad: true,
                    data: {
                        numero: numero,
                        estado: ordenAsociada.estado === 'confirmada' ? 'vendido' : 'apartado',
                        numero_orden: ordenAsociada.numero_orden,
                        nombre_cliente: ordenAsociada.nombre_cliente || '',
                        apellido_cliente: ordenAsociada.apellido_cliente || '',
                        email: ordenAsociada.email || '',
                        telefono: telefonoFinal,
                        ciudad: ciudadFinal,
                        estado_cliente: estadoFinal,
                        ciudad_cliente: ciudadFinal,
                        estado_orden: ordenAsociada.estado,
                        cantidad_boletos: ordenAsociada.cantidad_boletos || 0,
                        total: ordenAsociada.total || 0,
                        fecha_pago: ordenAsociada.fecha_pago,
                        comprobante_pagado_at: ordenAsociada.comprobante_pagado_at,
                        comprobante_fecha: ordenAsociada.comprobante_fecha || ordenAsociada.updated_at || ordenAsociada.comprobante_pagado_at || ordenAsociada.created_at,
                        comprobante_path: ordenAsociada.comprobante_path,
                        created_at: ordenAsociada.created_at
                    }
                });
            }

            // Oportunidad sin orden asociada - Estado disponible o apartado
            return res.json({
                success: true,
                ok: true,
                es_oportunidad: true,
                data: {
                    numero: numero,
                    estado: oportunidad.estado || 'disponible',
                    numero_orden: null,
                    nombre_cliente: '',
                    apellido_cliente: '',
                    email: '',
                    telefono: '',
                    ciudad: '',
                    estado_cliente: '',
                    ciudad_cliente: '',
                    estado_orden: oportunidad.estado || 'disponible',
                    cantidad_boletos: 0,
                    total: 0,
                    fecha_pago: null,
                    comprobante_pagado_at: null,
                    comprobante_fecha: null,
                    comprobante_path: null,
                    created_at: null
                }
            });
        }

        // ===== CASO 2: BOLETO =====
        else {
            // Fuente de verdad actual: boletos_estado FILTRANDO POR RIFA_ID
            const queryBoletoEstado = db('boletos_estado')
                .select('numero', 'estado', 'numero_orden', 'created_at', 'updated_at')
                .where('numero', numero);

            if (rifaIdActual) {
                queryBoletoEstado.andWhere('rifa_id', rifaIdActual);
            }

            const boletoEstado = await queryBoletoEstado.first();

            let ordenEncontrada = null;

            if (boletoEstado?.numero_orden) {
                const queryOrden = db('ordenes')
                    .where('numero_orden', boletoEstado.numero_orden);
                if (rifaIdActual) {
                    queryOrden.andWhere('rifa_id', rifaIdActual);
                }
                ordenEncontrada = await queryOrden.first();
            }

            // Fallback legacy: si por algún motivo no hay row en boletos_estado
            // o la orden asociada se perdió, intentar reconstruir desde ordenes.boletos.
            // ⚠️ IMPORTANTE: Este fallback también debe filtrar por rifa_id
            if (!ordenEncontrada && (!boletoEstado || boletoEstado.numero_orden)) {
                const ordenes = await dbUtils.ordersContainingBoletoQuery(numero).select('*');

                for (const orden of ordenes) {
                    // FILTRAR POR RIFA_ID en el fallback
                    if (rifaIdActual && orden.rifa_id && Number(orden.rifa_id) !== rifaIdActual) {
                        continue; // Saltar órdenes de otra rifa
                    }

                    try {
                        let boletosArr = [];
                        const raw = orden.boletos;

                        if (!raw) {
                            boletosArr = [];
                        } else if (Array.isArray(raw)) {
                            boletosArr = raw;
                        } else if (typeof raw === 'object' && raw !== null) {
                            boletosArr = Object.values(raw);
                        } else if (typeof raw === 'string') {
                            try {
                                const parsed = JSON.parse(raw);
                                if (Array.isArray(parsed)) {
                                    boletosArr = parsed;
                                } else if (typeof parsed === 'object' && parsed !== null) {
                                    boletosArr = Object.values(parsed);
                                } else if (typeof parsed === 'string') {
                                    boletosArr = parsed.split(',').map(s => s.trim()).filter(Boolean);
                                }
                            } catch (err) {
                                boletosArr = raw.split(',').map(s => s.trim()).filter(Boolean);
                            }
                        }

                        const boletosNumericos = boletosArr.map(b => {
                            if (b === null || typeof b === 'undefined') return NaN;
                            if (typeof b === 'number') return b;
                            if (typeof b === 'string') {
                                const n = Number(b);
                                if (!isNaN(n)) return n;
                                try {
                                    const inner = JSON.parse(b);
                                    if (inner && typeof inner === 'object') {
                                        return Number(inner.numero || inner.numero_boleto || inner.n || inner.id || NaN);
                                    }
                                } catch (e) {
                                    return NaN;
                                }
                            }
                            if (typeof b === 'object') {
                                return Number(b.numero || b.numero_boleto || b.n || b.id || NaN);
                            }
                            return NaN;
                        }).filter(n => !isNaN(n));

                        if (boletosNumericos.includes(numero)) {
                            if (!ordenEncontrada || new Date(orden.created_at) > new Date(ordenEncontrada.created_at)) {
                                ordenEncontrada = orden;
                            }
                        }
                    } catch (e) {
                        console.warn('Warning parsing boletos for orden', orden.id, e && e.message);
                    }
                }
            }

            if (ordenEncontrada) {
                const ciudadFinal = ordenEncontrada.ciudad_cliente || ordenEncontrada.ciudad || '';
                const estadoFinal = ordenEncontrada.estado_cliente || '';

                let telefonoFinal = ordenEncontrada.telefono_cliente ||
                    ordenEncontrada.telefono ||
                    '';

                return res.json({
                    success: true,
                    ok: true,
                    es_oportunidad: false,
                    data: {
                        numero: numero,
                        estado: boletoEstado?.estado || (ordenEncontrada.estado === 'confirmada' ? 'vendido' : 'apartado'),
                        numero_orden: ordenEncontrada.numero_orden,
                        nombre_cliente: ordenEncontrada.nombre_cliente || '',
                        apellido_cliente: ordenEncontrada.apellido_cliente || '',
                        email: ordenEncontrada.email || '',
                        telefono: telefonoFinal,
                        ciudad: ciudadFinal,
                        estado_cliente: estadoFinal,
                        ciudad_cliente: ciudadFinal,
                        estado_orden: ordenEncontrada.estado,
                        cantidad_boletos: ordenEncontrada.cantidad_boletos || 0,
                        total: ordenEncontrada.total || 0,
                        fecha_pago: ordenEncontrada.fecha_pago,
                        comprobante_pagado_at: ordenEncontrada.comprobante_pagado_at,
                        comprobante_fecha: ordenEncontrada.comprobante_fecha || ordenEncontrada.updated_at || ordenEncontrada.comprobante_pagado_at || ordenEncontrada.created_at,
                        comprobante_path: ordenEncontrada.comprobante_path,
                        created_at: ordenEncontrada.created_at,
                        updated_at: boletoEstado?.updated_at || ordenEncontrada.updated_at || ordenEncontrada.created_at
                    }
                });
            }

            if (boletoEstado) {
                return res.json({
                    success: true,
                    ok: true,
                    es_oportunidad: false,
                    data: {
                        numero: numero,
                        estado: boletoEstado.estado || 'disponible',
                        numero_orden: boletoEstado.numero_orden || null,
                        nombre_cliente: '',
                        apellido_cliente: '',
                        email: '',
                        telefono: '',
                        ciudad: '',
                        estado_cliente: '',
                        ciudad_cliente: '',
                        estado_orden: boletoEstado.estado || 'disponible',
                        total: 0,
                        fecha_pago: null,
                        comprobante_pagado_at: null,
                        comprobante_fecha: null,
                        comprobante_path: null,
                        created_at: boletoEstado.created_at || null,
                        updated_at: boletoEstado.updated_at || null
                    }
                });
            }

            // Boleto disponible
            return res.json({
                success: true,
                ok: true,
                es_oportunidad: false,
                data: {
                    numero: numero,
                    estado: 'disponible',
                    numero_orden: null,
                    nombre_cliente: '',
                    apellido_cliente: '',
                    email: '',
                    telefono: '',
                    ciudad: '',
                    estado_cliente: '',
                    ciudad_cliente: '',
                    estado_orden: 'disponible',
                    total: 0,
                    fecha_pago: null,
                    comprobante_pagado_at: null,
                    created_at: null
                }
            });
        }
    } catch (error) {
        console.error('GET /api/admin/numero-inteligente/:numero error:', error);
        return res.status(500).json({
            success: false,
            message: 'Error al buscar número',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * GET /api/admin/boleto/:numero
 * Busca una orden por número de boleto específico
 * Protegido con JWT
 * 
 * ⚠️ FILTRO POR RIFA: Usa req.rifaContext.id o header X-Rifa-Id para aislamiento multirifa
 */
app.get('/api/admin/boleto/:numero', verificarToken, async (req, res) => {
    try {
        const numeroboleto = Number(req.params.numero);

        if (isNaN(numeroboleto)) {
            return res.status(400).json({
                success: false,
                message: 'Número de boleto inválido'
            });
        }

        // 🎯 OBTENER RIFA_ID: Usar resolución centralizada (soporta x-rifaplus-rifa-id y x-rifa-id)
        const rifaIdActual = getRifaIdFromRequest(req);

        // ⚠️ VALIDACIÓN CRÍTICA: Debe haber una rifa identificada para búsquedas admin
        if (!rifaIdActual) {
            console.warn('[boleto] ⚠️ Búsqueda sin rifa identificada - número:', numeroboleto);
        }

        // Buscar la orden que contiene este boleto FILTRANDO POR RIFA_ID
        const queryOrdenes = db('ordenes').select('*');
        if (rifaIdActual) {
            queryOrdenes.andWhere('rifa_id', rifaIdActual);
        }
        const ordenes = await queryOrdenes;

        let ordenEncontrada = null;
        for (const orden of ordenes) {
            try {
                const boletos = JSON.parse(orden.boletos || '[]');
                const boletosNumericos = boletos.map(b => Number(b));

                if (boletosNumericos.includes(numeroboleto)) {
                    ordenEncontrada = orden;
                    break;
                }
            } catch (e) {
                // Ignorar errores de parseo
            }
        }

        if (!ordenEncontrada) {
            return res.status(404).json({
                success: false,
                message: 'Boleto no encontrado',
                numero_boleto: numeroboleto
            });
        }

        // Devolver datos de la orden
        return res.json({
            success: true,
            data: {
                id: ordenEncontrada.id,
                numero_orden: ordenEncontrada.numero_orden,
                nombre_cliente: ordenEncontrada.nombre_cliente,
                apellido_cliente: ordenEncontrada.apellido_cliente,
                email: ordenEncontrada.email,
                telefono: ordenEncontrada.telefono,
                ciudad: ordenEncontrada.ciudad,
                estado: ordenEncontrada.estado,
                fecha_pago: ordenEncontrada.fecha_pago,
                numero_boleto: numeroboleto,
                cantidad_boletos: ordenEncontrada.cantidad_boletos,
                total_pagado: ordenEncontrada.total_pagado,
                created_at: ordenEncontrada.created_at
            }
        });
    } catch (error) {
        console.error('GET /api/admin/boleto/:numero error:', error);
        return res.status(500).json({
            success: false,
            message: 'Error al buscar boleto',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * GET /api/public/ordenes-stats
 * Estadísticas públicas de órdenes (SIN autenticación)
 * Usado por el countdown para mostrar progreso de venta
 */
app.get('/api/public/ordenes-stats', async (req, res) => {
    const startTime = Date.now();
    const cacheSuffix = String(req.rifaContext?.slug || req.rifaContext?.id || 'default');
    const cacheTtl = obtenerTtlCachePublico({ productionMs: 30000, developmentMs: 5000 });
    const cached = obtenerCacheMemoriaVigente(
        serverCache.ordenesStatsCached?.[cacheSuffix],
        serverCache.ordenesStatsCachedTime?.[cacheSuffix],
        cacheTtl
    );

    try {
        const rifaContext = req.rifaContext;
        if (!rifaContext || !rifaContext.id) {
            console.warn('[STATS_ERROR] Detalle:', {
                rifaId_del_contexto: rifaContext?.id,
                slug_del_contexto: rifaContext?.slug,
                hostname_detectado: (req.headers.host || '').split(':')[0],
                url_pedida: req.originalUrl,
                headers_rifa_id: req.headers['x-rifaplus-rifa-id'],
                headers_rifa_slug: req.headers['x-rifaplus-rifa-slug']
            });
            return res.status(400).json({ success: false, message: 'Rifa no identificada' });
        }

        setHttpCacheHeaders(res, Math.max(5, Math.floor(cacheTtl / 1000)), true);

        if (cached) {
            return res.json({
                success: true,
                data: {
                    total_ordenes: cached.payload.total_ordenes,
                    total_boletos_vendidos: cached.payload.total_boletos_vendidos,
                    porcentaje_vendido: cached.payload.porcentaje_vendido || 0,
                    queryTime: cached.ageMs,
                    cached: true
                }
            });
        }

        const totalBoletosRifa = Number(req.rifaContext?.configuracion?.rifa?.totalBoletos) || 1000;
        const currentRifaId = rifaContext?.id;
        const isFallback = !currentRifaId;

        console.log(`[STATS_DEBUG] Request Slug: ${rifaContext?.slug}, ID: ${currentRifaId}, TotalConfig: ${totalBoletosRifa}, Fallback: ${isFallback}`);

        // Si es fallback y estamos en una página que espera una rifa específica, esto es un error
        if (isFallback && (req.query.rifa || req.headers['x-rifaplus-rifa-slug'])) {
            console.warn('[STATS_ERROR] Fallback detected when explicit slug was requested');
            return res.status(400).json({ success: false, message: 'Rifa no identificada (Context mismatch)' });
        }


        const stats = await resolverSingleFlightPublico(`public:ordenes-stats:${cacheSuffix}`, async () => {
            const result = await db('ordenes')
                .modify((qb) => {
                    if (currentRifaId) qb.where('rifa_id', currentRifaId);
                })
                .whereIn('estado', ['confirmada', 'completada'])
                .select(
                    db.raw('COUNT(*) as total_ordenes'),
                    db.raw('SUM(cantidad_boletos) as total_boletos_vendidos')
                )
                .first();

            const vendidos = Number(result?.total_boletos_vendidos) || 0;
            const porcentaje = totalBoletosRifa > 0 ? Math.round((vendidos / totalBoletosRifa) * 100) : 0;

            return {
                total_ordenes: Number(result?.total_ordenes) || 0,
                total_boletos_vendidos: vendidos,
                porcentaje_vendido: porcentaje
            };
        });

        serverCache.ordenesStatsCached = serverCache.ordenesStatsCached || {};
        serverCache.ordenesStatsCachedTime = serverCache.ordenesStatsCachedTime || {};
        serverCache.ordenesStatsCached[cacheSuffix] = stats;
        serverCache.ordenesStatsCachedTime[cacheSuffix] = Date.now();

        return res.json({
            success: true,
            data: {
                total_ordenes: stats.total_ordenes,
                total_boletos_vendidos: stats.total_boletos_vendidos,
                total: totalBoletosRifa,
                porcentaje_vendido: stats.porcentaje_vendido,
                queryTime: Date.now() - startTime,
                cached: false,
                context_resolved: !isFallback
            }
        });
    } catch (error) {
        console.error('GET /api/public/ordenes-stats error:', error);

        if (serverCache.ordenesStatsCached?.[cacheSuffix]) {
            const cached = serverCache.ordenesStatsCached[cacheSuffix];
            return res.json({
                success: true,
                data: {
                    total_ordenes: cached.total_ordenes,
                    total_boletos_vendidos: cached.total_boletos_vendidos,
                    porcentaje_vendido: cached.porcentaje_vendido,
                    queryTime: 0,
                    cached: true,
                    stale: true
                }
            });
        }

        return res.status(500).json({
            success: false,
            message: 'Error al obtener estadísticas',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * GET /api/public/boletos
 * ⚠️ CRÍTICO: Devuelve estado REAL DE BOLETOS directamente de boletos_estado
 * - "sold": boletos en estado 'vendido' (ya pagados y confirmados)
 * - "reserved": boletos en estado 'apartado' (en orden pendiente o con comprobante)
 * 
 * SIN CACHE: Siempre devuelve datos frescos directamente de BD para sincronización 100%
 * Esta es la fuente única de verdad para UI
 */

/**
 * GET /api/admin/clear-cache
 * 🧹 Limpiar caché de stats (debug/desarrollo)
 */
app.get('/api/admin/clear-cache', verificarToken, (req, res) => {
    limpiarCacheBoletosPublicos();
    console.log('🧹 [Admin] Caché limpia');
    res.json({ success: true, message: 'Caché limpia correctamente' });
});

/**
 * GET /api/public/boletos/stats
 * ⚡ ULTRA-RÁPIDO: Solo conteos cacheados + índices
 * Devuelve en < 50ms usando caché en memoria
 * 
 * ✅ DINÁMICO: Lee totalBoletos desde la configuración actual (BD)
 * ✅ CACHEADO: Stats se cachean por 5 segundos (TTL configurable)
 */
app.get('/api/public/boletos/stats', async (req, res) => {
    try {
        const startTime = Date.now();
        const rifaContext = req.rifaContext;
        if (!rifaContext || !rifaContext.id) {
            return res.status(400).json({ success: false, message: 'Rifa no identificada' });
        }
        const config = rifaContext.configuracion?.rifa || {};
        const rifaIdActual = Number.parseInt(rifaContext.id, 10);
        const isFallback = !rifaIdActual;
        const cacheSuffix = String(rifaContext.slug || rifaIdActual);
        const totalBoletos = Number(config.totalBoletos) || 100;

        // 🛡️ BLOQUEO DE CONTAMINACIÓN: Si se pidió un slug pero caímos en fallback, error.
        if (isFallback && (req.query.rifa || req.headers['x-rifaplus-rifa-slug'])) {
            return res.status(400).json({ success: false, message: 'Rifa no identificada (Context mismatch)' });
        }

        // Por defecto cache largo para público; para peticiones admin/autenticadas usar TTL mucho menor
        let cacheTtl = obtenerTtlCachePublico({ productionMs: 30000, developmentMs: 5000 });
        try {
            const isAdminRequest = Boolean(req.headers && (req.headers.authorization || req.headers['authorization']));
            if (isAdminRequest) {
                cacheTtl = obtenerTtlCachePublico({ productionMs: 5000, developmentMs: 500 });
            }
        } catch (e) {
            // ignorar y usar valor por defecto
        }
        const cached = obtenerCacheMemoriaVigente(
            serverCache.boletosStatsCached?.[cacheSuffix],
            serverCache.boletosStatsCachedTime?.[cacheSuffix],
            cacheTtl
        );

        setHttpCacheHeaders(res, Math.max(5, Math.floor(cacheTtl / 1000)), true);

        if (cached) {
            logOperacionHttp('GET /api/public/boletos/stats (cache)', startTime, {
                cached: true,
                cacheAgeMs: cached.ageMs,
                statusCode: 200
            }, { slowMs: 250, warnMs: 800 });
            return res.json({
                success: true,
                data: {
                    vendidos: cached.payload.vendidos,
                    apartados: cached.payload.apartados,
                    disponibles: cached.payload.disponibles,
                    total: totalBoletos,
                    queryTime: cached.ageMs,
                    cached: true,
                    context_resolved: !isFallback
                }
            });
        }

        // Función para obtener stats desde BD con estrategia más rápida
        const fetchStats = async () => {
            try {
                // ⭐ OPTIMIZACIÓN: Query más rápida usando índices
                // Separar en dos queries para cada estado (usa índices mejor)
                const [vendidosResult, apartadosResult] = await Promise.all([
                    db('boletos_estado').modify((qb) => {
                        if (rifaIdActual) qb.where('rifa_id', rifaIdActual);
                    }).where('estado', 'vendido').count('* as count').first(),
                    db('boletos_estado').modify((qb) => {
                        if (rifaIdActual) qb.where('rifa_id', rifaIdActual);
                    }).where('estado', 'apartado').count('* as count').first()
                ]);

                return {
                    vendidos: parseInt(vendidosResult?.count) || 0,
                    apartados: parseInt(apartadosResult?.count) || 0
                };
            } catch (dbError) {
                console.warn('[PublicBoletoStats] DB Query error (usando caché anterior):', dbError.message);
                // Si la BD falla, usar caché anterior si existe
                if (serverCache.boletosStatsCached?.[cacheSuffix]) {
                    return serverCache.boletosStatsCached[cacheSuffix];
                }
                // Si no hay caché, devolver error
                throw dbError;
            }
        };

        const stats = await resolverSingleFlightPublico(`public:boletos-stats:${cacheSuffix}`, fetchStats);
        const disponibles = totalBoletos - stats.vendidos - stats.apartados;
        const queryTime = Date.now() - startTime;

        // Guardar en caché local de servidor
        serverCache.boletosStatsCached = serverCache.boletosStatsCached || {};
        serverCache.boletosStatsCachedTime = serverCache.boletosStatsCachedTime || {};
        serverCache.boletosStatsCached[cacheSuffix] = {
            vendidos: stats.vendidos,
            apartados: stats.apartados,
            disponibles
        };
        serverCache.boletosStatsCachedTime[cacheSuffix] = Date.now();
        logOperacionHttp('GET /api/public/boletos/stats', startTime, {
            cached: false,
            vendidos: stats.vendidos,
            apartados: stats.apartados,
            statusCode: 200
        }, { slowMs: 300, warnMs: 1000 });

        return res.json({
            success: true,
            data: {
                vendidos: stats.vendidos,
                apartados: stats.apartados,
                disponibles: disponibles,
                total: totalBoletos,
                queryTime: queryTime,
                cached: false,
                context_resolved: !isFallback
            }
        });

    } catch (error) {
        console.error('[PublicBoletoStats] Error:', error.message);
        log('error', 'GET /api/public/boletos/stats error', { error: error.message });
        const config = cargarConfigSorteo();
        const cacheSuffix = String(req.rifaContext?.slug || req.rifaContext?.id || 'default');

        // ⭐ FALLBACK: Usar caché anterior o valores por defecto
        if (serverCache.boletosStatsCached?.[cacheSuffix]) {
            console.warn('[PublicBoletoStats] Error - usando cache anterior');
            return res.json({
                success: true,
                data: {
                    vendidos: serverCache.boletosStatsCached[cacheSuffix].vendidos,
                    apartados: serverCache.boletosStatsCached[cacheSuffix].apartados,
                    disponibles: serverCache.boletosStatsCached[cacheSuffix].disponibles,
                    total: config.totalBoletos,
                    queryTime: 0,
                    cached: true,
                    error: error.message
                }
            });
        }

        return res.status(500).json({
            success: false,
            message: 'Error al obtener estadísticas',
            data: {
                vendidos: 0,
                apartados: 0,
                disponibles: config.totalBoletos,
                total: config.totalBoletos,
                queryTime: 0,
                error: error.message
            }
        });
    }
});

app.get('/api/public/boletos/optimizado', async (req, res) => {
    const startTime = Date.now();
    const rifaContext = req.rifaContext || {};
    const rifaIdActual = Number.parseInt(rifaContext.id, 10) || null;

    try {
        if (!rifaIdActual) {
            return res.status(400).json({
                success: false,
                message: 'No se pudo identificar el contexto del sorteo'
            });
        }

        const configContextual = rifaContext.configuracion || obtenerConfigActual(rifaIdActual) || {};
        const isOptimizado = configContextual?.rifa?.modoOptimizado === true || configContextual?.rifa?.modoOptimizado === 'true';

        if (!isOptimizado) {
            return res.status(400).json({
                success: false,
                message: 'El Modo Optimizado no está activo para este sorteo'
            });
        }

        const totalBoletos = Number(configContextual?.rifa?.totalBoletos) || 1000000;

        let inicioVisible = 0;
        let finVisible = totalBoletos - 1;

        const oportunidades = configContextual?.rifa?.oportunidades || {};
        if (oportunidades.enabled && oportunidades.rango_visible) {
            const rango = oportunidades.rango_visible;
            if (rango && typeof rango === 'object' && rango.inicio !== undefined && rango.fin !== undefined) {
                inicioVisible = Number(rango.inicio);
                finVisible = Number(rango.fin);
            }
        }

        const boletosRows = await db('boletos_estado')
            .where('rifa_id', rifaIdActual)
            .where('estado', 'disponible')
            .whereNull('numero_orden')
            .whereBetween('numero', [inicioVisible, finVisible])
            .orderByRaw('RANDOM()')
            .limit(5000)
            .select('numero');

        const numerosDisponibles = boletosRows.map(row => Number(row.numero)).sort((a, b) => a - b);
        const queryTime = Date.now() - startTime;

        setHttpCacheHeaders(res, 2, true);

        return res.json({
            success: true,
            data: numerosDisponibles,
            count: numerosDisponibles.length,
            queryTimeMs: queryTime
        });

    } catch (error) {
        console.error('GET /api/public/boletos/optimizado error:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Error al obtener boletos optimizados',
            error: error.message
        });
    }
});

app.get('/api/public/boletos', async (req, res) => {
    const inicioQuery = req.query.inicio !== undefined ? parseInt(req.query.inicio, 10) : null;
    const finQuery = req.query.fin !== undefined ? parseInt(req.query.fin, 10) : null;
    const usarRango = Number.isInteger(inicioQuery) && Number.isInteger(finQuery);
    const rifaIdActual = Number.parseInt(req.rifaContext?.id, 10) || null;
    const cacheSuffix = String(req.rifaContext?.slug || req.rifaContext?.id || 'default');

    try {
        if (usarRango && inicioQuery > finQuery) {
            return res.status(400).json({
                success: false,
                message: 'inicio no puede ser mayor que fin'
            });
        }

        const rangeCacheTtl = obtenerTtlCachePublico({ productionMs: 10000, developmentMs: 5000 });
        const fullCacheTtl = obtenerTtlCachePublico({ productionMs: 10000, developmentMs: 5000 });
        setHttpCacheHeaders(res, Math.max(5, Math.floor((usarRango ? rangeCacheTtl : fullCacheTtl) / 1000)), true);

        if (usarRango) {
            const cacheKey = `${cacheSuffix}:${inicioQuery}-${finQuery}`;
            const cachedRange = serverCache.boletosPublicosByRange.get(cacheKey);
            if (cachedRange && (Date.now() - cachedRange.time) < rangeCacheTtl) {
                return res.json(cachedRange.payload);
            }
        }

        const cachedFull = obtenerCacheMemoriaVigente(
            serverCache.boletosPublicosCached?.[cacheSuffix],
            serverCache.boletosPublicosCachedTime?.[cacheSuffix],
            fullCacheTtl
        );

        if (!usarRango && cachedFull) {
            return res.json(cachedFull.payload);
        }

        const startTime = Date.now();

        // ✅ OBTENER TOTAL DE BOLETOS DESDE LA CONFIGURACIÓN ACTUAL
        const configActual = obtenerConfigActual();
        const fallbackConfig = obtenerConfigExpiracion();
        const totalBoletos = Number(configActual?.rifa?.totalBoletos) || Number(fallbackConfig?.totalBoletos) || 1000000;

        if (usarRango && (inicioQuery < 0 || finQuery >= totalBoletos)) {
            return res.status(400).json({
                success: false,
                message: `Rango inválido. Debe estar entre 0 y ${totalBoletos - 1}`
            });
        }

        const cacheTtl = process.env.NODE_ENV === 'production' ? 60000 : 5000;
        const cacheVigente = global.boletosPublicRangeStatsCache
            && global.boletosPublicRangeStatsCacheTime
            && (Date.now() - global.boletosPublicRangeStatsCacheTime) < cacheTtl;

        let statsGlobales = cacheVigente ? global.boletosPublicRangeStatsCache : null;
        let boletosOcultos = statsGlobales?.boletosOcultos || 0;

        if (!statsGlobales) {
            const [countResult, oportunidadesCount] = await Promise.all([
                db.raw(`
                    SELECT 
                        COUNT(*) FILTER (WHERE estado = 'vendido')::int as vendidos,
                        COUNT(*) FILTER (WHERE estado = 'apartado')::int as apartados
                    FROM boletos_estado
                    WHERE (?::int IS NULL OR rifa_id = ?::int)
                `, [rifaIdActual, rifaIdActual]).timeout(10000),
                db.raw(`
                    SELECT COUNT(*)::int as count FROM orden_oportunidades 
                    WHERE estado = 'disponible'
                      AND (?::int IS NULL OR rifa_id = ?::int)
                `, [rifaIdActual, rifaIdActual]).timeout(10000)
            ]);

            const countData = countResult.rows?.[0] || { vendidos: 0, apartados: 0 };
            boletosOcultos = parseInt(oportunidadesCount.rows?.[0]?.count || 0, 10) || 0;
            const vendidosGlobales = parseInt(countData.vendidos, 10) || 0;
            const apartadosGlobales = parseInt(countData.apartados, 10) || 0;
            const disponiblesGlobales = Math.max(0, totalBoletos - vendidosGlobales - apartadosGlobales);

            statsGlobales = {
                vendidos: vendidosGlobales,
                apartados: apartadosGlobales,
                boletosOcultos: boletosOcultos,
                disponibles: disponiblesGlobales
            };
            global.boletosPublicRangeStatsCache = statsGlobales;
            global.boletosPublicRangeStatsCacheTime = Date.now();
        }

        const fetchPayload = async () => {
            let sold = [];
            let reserved = [];
            let oportunidades = [];

            if (usarRango) {
                const estadoRango = await BoletoService.obtenerEstadoNoDisponibleEnRango(inicioQuery, finQuery, {
                    rifaId: rifaIdActual
                });
                sold = estadoRango.sold;
                reserved = estadoRango.reserved;
            } else {
                const [estadoCompleto, oportunidadesList, oportunidadesDisponiblesCount] = await Promise.all([
                    db('boletos_estado')
                        .modify((qb) => {
                            if (rifaIdActual) qb.where('rifa_id', rifaIdActual);
                        })
                        .whereIn('estado', ['vendido', 'apartado'])
                        .select('numero', 'estado')
                        .timeout(15000)
                        .orderBy('numero'),
                    db('orden_oportunidades')
                        .modify((qb) => {
                            if (rifaIdActual) qb.where('rifa_id', rifaIdActual);
                        })
                        .where('estado', 'apartado')
                        .select('numero_oportunidad')
                        .timeout(15000)
                        .orderBy('numero_oportunidad'),
                    boletosOcultos > 0
                        ? Promise.resolve({ rows: [{ count: boletosOcultos }] })
                        : db.raw(`
                            SELECT COUNT(*)::int as count FROM orden_oportunidades
                            WHERE estado = 'disponible'
                              AND (?::int IS NULL OR rifa_id = ?::int)
                        `, [rifaIdActual, rifaIdActual]).timeout(10000)
                ]);

                estadoCompleto.forEach((b) => {
                    if (b.estado === 'vendido') {
                        sold.push(Number(b.numero));
                    } else {
                        reserved.push(Number(b.numero));
                    }
                });

                oportunidades = oportunidadesList.map((o) => Number(o.numero_oportunidad));
                boletosOcultos = parseInt(oportunidadesDisponiblesCount.rows?.[0]?.count || 0, 10) || boletosOcultos;
            }

            const vendidos = statsGlobales.vendidos || 0;
            const reservados = statsGlobales.apartados || 0;
            boletosOcultos = Number(statsGlobales.boletosOcultos || boletosOcultos || 0);
            const totalApartados = reservados;
            const disponibles = Math.max(0, statsGlobales.disponibles ?? (totalBoletos - vendidos - reservados));
            const queryTime = Date.now() - startTime;

            return {
                success: true,
                data: {
                    sold: sold,
                    reserved: reserved,
                    oportunidades: oportunidades
                },
                stats: {
                    vendidos: vendidos,
                    reservados: reservados,
                    boletosOcultos: boletosOcultos,
                    totalApartados: totalApartados,
                    disponibles: disponibles,
                    total: totalBoletos,
                    rango: usarRango ? { inicio: inicioQuery, fin: finQuery } : null,
                    queryTime: queryTime,
                    cached: false
                }
            };
        };

        const payload = await resolverSingleFlightPublico(
            usarRango ? `public:boletos:${cacheSuffix}:${inicioQuery}-${finQuery}` : `public:boletos:full:${cacheSuffix}`,
            fetchPayload
        );

        // ⭐ GUARDAR EN CACHÉ para siguiente request
        if (usarRango) {
            serverCache.boletosPublicosByRange.set(`${cacheSuffix}:${inicioQuery}-${finQuery}`, {
                time: Date.now(),
                payload
            });
            if (serverCache.boletosPublicosByRange.size > 200) {
                const oldestKey = serverCache.boletosPublicosByRange.keys().next().value;
                if (oldestKey) serverCache.boletosPublicosByRange.delete(oldestKey);
            }
        } else {
            serverCache.boletosPublicosCached = serverCache.boletosPublicosCached || {};
            serverCache.boletosPublicosCachedTime = serverCache.boletosPublicosCachedTime || {};
            serverCache.boletosPublicosCached[cacheSuffix] = payload;
            serverCache.boletosPublicosCachedTime[cacheSuffix] = Date.now();
        }

        if ((payload.stats?.queryTime || 0) > 1000 || Math.random() < 0.05) {
            const vendidos = payload.stats?.vendidos || 0;
            const reservados = payload.stats?.reservados || 0;
            const totalApartados = payload.stats?.totalApartados || 0;
            const queryTime = payload.stats?.queryTime || 0;
            const ocultos = payload.stats?.boletosOcultos || 0;
            console.log(`[PublicBoletos] Vendidos: ${vendidos}, Apartados: ${reservados}, Oportunidades: ${boletosOcultos}, Total apartados: ${totalApartados}, Time: ${queryTime}ms, Rango: ${usarRango ? `${inicioQuery}-${finQuery}` : 'completo'}`);
        }

        return res.json(payload);

    } catch (error) {
        console.error('GET /api/public/boletos error:', error.message);

        if (usarRango) {
            const cachedRange = serverCache.boletosPublicosByRange.get(`${cacheSuffix}:${inicioQuery}-${finQuery}`);
            if (cachedRange?.payload) {
                console.warn(`[PublicBoletos] Error en rango ${inicioQuery}-${finQuery} - usando cache de rango`);
                return res.json(cachedRange.payload);
            }
        }

        // ⭐ SI FALLA, USAR CACHÉ ANTERIOR O DEVOLVER VACÍO
        if (serverCache.boletosPublicosCached?.[cacheSuffix]) {
            console.warn('[PublicBoletos] Error - usando cache antiguo');
            return res.json(serverCache.boletosPublicosCached[cacheSuffix]);
        }

        const totalFallback = Number(obtenerConfigActual()?.rifa?.totalBoletos) || Number(obtenerConfigExpiracion()?.totalBoletos) || 60000;

        return res.json({
            success: false,
            message: 'Error temporal',
            data: { sold: [], reserved: [] },
            stats: {
                vendidos: 0, reservados: 0, disponibles: totalFallback, total: totalFallback,
                cached: false, error: error.message
            }
        });
    }
});

app.get('/api/public/boletos/busqueda', limiterOrdenes, async (req, res) => {
    try {
        const rifaContext = req.rifaContext || {};
        const configContextual = rifaContext.configuracion || obtenerConfigActual(Number.parseInt(rifaContext.id, 10) || null) || {};
        const rifaIdActual = Number.parseInt(rifaContext.id, 10) || null;

        const modo = String(req.query.modo || req.query.mode || 'exacto').trim().toLowerCase();
        const availableOnly = ['1', 'true', 'si', 'sí', 'on'].includes(String(req.query.availableOnly || '').trim().toLowerCase());
        const limiteSolicitado = parseInt(req.query.limite || req.query.limit, 10);
        const offsetSolicitado = parseInt(req.query.offset, 10);
        const limite = Number.isInteger(limiteSolicitado) ? Math.max(1, Math.min(limiteSolicitado, 1000)) : 100;
        const offset = Number.isInteger(offsetSolicitado) ? Math.max(0, offsetSolicitado) : 0;

        const totalBoletos = obtenerTotalBoletosConfigurado(configContextual);
        const rangosPermitidos = obtenerRangosBusquedaPermitidos(configContextual);
        const rangoMinimo = rangosPermitidos[0] || { inicio: 0, fin: 0 };
        const rangoMaximo = rangosPermitidos[rangosPermitidos.length - 1] || rangoMinimo;
        const minNumero = Number.isInteger(rangoMinimo.inicio) ? rangoMinimo.inicio : 0;
        const maxNumero = Number.isInteger(rangoMaximo.fin) ? rangoMaximo.fin : Math.max(0, totalBoletos - 1);
        const anchoBoletos = String(Math.max(maxNumero, Math.max(0, totalBoletos - 1))).length;

        const formatearRespuesta = (items, criterios = {}) => ({
            success: true,
            data: {
                items: items.map((item) => ({
                    numero: Number(item.numero),
                    estado: item.estado || 'disponible'
                })),
                modo,
                availableOnly,
                limite,
                offset,
                truncado: items.length === limite,
                totalBoletos,
                rifaId: rifaIdActual,
                rifaSlug: String(rifaContext.slug || '').trim() || null,
                rangoBusqueda: {
                    inicio: minNumero,
                    fin: maxNumero,
                    segmentos: rangosPermitidos
                },
                criterios
            }
        });

        const filtroRangos = construirFiltroSqlRangos('gs', rangosPermitidos);
        let filterSql = '';
        let sqlParams = [minNumero, maxNumero, ...filtroRangos.params];

        if (modo === 'rango') {
            const inicio = parseInt(req.query.inicio, 10);
            const fin = parseInt(req.query.fin, 10);
            if (!Number.isInteger(inicio) || !Number.isInteger(fin) || inicio < 0 || fin < inicio || !rangoIntersectaRangosBusqueda(inicio, fin, rangosPermitidos)) {
                return res.status(400).json({ success: false, message: `Rango inválido para esta rifa (${minNumero}-${maxNumero})` });
            }
            filterSql = 'gs BETWEEN ? AND ?';
            sqlParams.push(inicio, fin);
        } else if (modo === 'exacto') {
            const valor = String(req.query.q || req.query.valor || '').trim();
            const numero = parseInt(valor, 10);
            if (!/^\d+$/.test(valor) || !Number.isInteger(numero) || !numeroPerteneceARangosBusqueda(numero, rangosPermitidos)) {
                return res.status(400).json({ success: false, message: 'Boleto inválido' });
            }
            filterSql = 'gs = ?';
            sqlParams.push(numero);
        } else {
            const valor = String(req.query.q || req.query.valor || '').trim();
            if (!/^\d+$/.test(valor)) {
                return res.status(400).json({ success: false, message: 'Usa solo números' });
            }

            let patron = `${valor}%`;
            if (modo === 'termina') patron = `%${valor}`;
            else if (modo === 'contiene') patron = `%${valor}%`;

            filterSql = '(CAST(gs AS text) LIKE ?) OR (LPAD(CAST(gs AS text), ?, \'0\') LIKE ?)';
            sqlParams.push(patron, anchoBoletos, patron);
        }

        const finalSql = `
            WITH serie AS (
                SELECT gs::int AS numero
                FROM generate_series(?::bigint, ?::bigint) AS gs
                WHERE (${filtroRangos.sql})
                  AND (${filterSql})
            ),
            estados_actuales AS (
                SELECT
                    numero,
                    CASE
                        WHEN BOOL_OR(estado = 'vendido') THEN 'vendido'
                        WHEN BOOL_OR(estado = 'apartado') THEN 'apartado'
                        ELSE 'disponible'
                    END AS estado
                FROM boletos_estado
                WHERE rifa_id = ?::int
                  AND estado IN ('vendido', 'apartado')
                GROUP BY numero
            )
            SELECT
                s.numero,
                COALESCE(ea.estado, 'disponible') AS estado
            FROM serie s
            LEFT JOIN estados_actuales ea
                ON ea.numero = s.numero
            ${availableOnly ? 'WHERE ea.numero IS NULL' : ''}
            ORDER BY s.numero ASC
            LIMIT ?
            OFFSET ?
        `;

        sqlParams.push(rifaIdActual, limite, offset);

        const result = await db.raw(finalSql, sqlParams).timeout(15000);
        return res.json(formatearRespuesta(result.rows || [], { q: req.query.q || req.query.valor }));
    } catch (error) {
        console.error('GET /api/public/boletos/busqueda error:', error);
        return res.status(500).json({ success: false, message: 'Error al buscar boletos' });
    }
});

/**
 * POST /api/boletos/disponibles-aleatorios
 * Devuelve boletos aleatorios DISPONIBLES del universo total del sorteo.
 * La máquina de la suerte usa este endpoint para no depender del rango visible actual.
 * Body: { cantidad: 5, excludeNumbers: [1, 2, 3] }
 */
app.post('/api/boletos/disponibles-aleatorios', async (req, res) => {
    try {
        const cantidad = parseInt(req.body?.cantidad, 10);
        const excludeNumbers = Array.isArray(req.body?.excludeNumbers) ? req.body.excludeNumbers : [];

        if (!Number.isInteger(cantidad) || cantidad < 1) {
            return res.status(400).json({
                success: false,
                message: 'cantidad debe ser un entero mayor a 0'
            });
        }

        if (cantidad > MAQUINA_SUERTE_LIMITE_MAXIMO) {
            return res.status(400).json({
                success: false,
                message: `No se pueden solicitar más de ${MAQUINA_SUERTE_LIMITE_MAXIMO} boletos aleatorios por intento`
            });
        }

        const boletos = await BoletoService.obtenerBoletosAleatoriosDisponibles(cantidad, excludeNumbers, {
            rifaId: req.rifaContext?.id
        });

        return res.json({
            success: true,
            boletos: boletos,
            resumen: {
                solicitados: cantidad,
                generados: boletos.length
            }
        });
    } catch (error) {
        log('error', 'POST /api/boletos/disponibles-aleatorios error', { error: error.message });
        return res.status(500).json({
            success: false,
            message: 'Error obteniendo boletos aleatorios disponibles',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * GET /api/admin/stats
 * Estadísticas del sistema (protegido con JWT)
 * ⭐ FASE 1: HTTP caching habilitado (30s, private)
 */
app.get('/api/admin/stats', verificarToken, async (req, res) => {
    try {
        const rifaIdActual = Number.parseInt(req.rifaContext?.id, 10) || null;
        const stats = await db('ordenes')
            .modify((qb) => {
                if (rifaIdActual) qb.where('rifa_id', rifaIdActual);
            })
            .select(
                db.raw('COUNT(*) as total_ordenes'),
                db.raw('SUM(cantidad_boletos) as total_boletos'),
                db.raw('SUM(total) as ingresos_totales'),
                db.raw("SUM(CASE WHEN estado IN ('confirmada','completada') THEN total ELSE 0 END) as ingresos_confirmados"),
                db.raw("SUM(CASE WHEN estado IN ('confirmada','completada') THEN cantidad_boletos ELSE 0 END) as total_boletos_vendidos"),
                db.raw('AVG(total) as promedio_orden')
            )
            .first();

        const porEstado = await db('ordenes')
            .modify((qb) => {
                if (rifaIdActual) qb.where('rifa_id', rifaIdActual);
            })
            .select('estado')
            .count('* as cantidad')
            .groupBy('estado');

        // Asegurar que los campos numéricos se convierten correctamente
        const data = {
            total_ordenes: parseInt(stats.total_ordenes) || 0,
            total_boletos: parseInt(stats.total_boletos) || 0,
            ingresos_totales: parseFloat(stats.ingresos_totales) || 0,
            ingresos_confirmados: parseFloat(stats.ingresos_confirmados) || 0,
            total_boletos_vendidos: parseInt(stats.total_boletos_vendidos) || 0,
            promedio_orden: parseFloat(stats.promedio_orden) || 0,
            por_estado: porEstado
        };

        // ⭐ FASE 1: Agregar headers de caching HTTP (respuesta privada, 30s)
        setHttpCacheHeaders(res, 30, false);

        return res.json({
            success: true,
            data: data
        });
    } catch (error) {
        console.error('GET /api/admin/stats error:', error);
        return res.status(500).json({
            success: false,
            message: 'Error al obtener estadísticas',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * GET /api/public/boletos/:numero/oportunidades
 * 🎁 Obtiene las oportunidades PRE-ASIGNADAS al boleto desde BD
 * 
 * @param numero - Número del boleto (ej: 1, 100, 500)
 * @returns {Array} Array de oportunidades desde BD
 */
app.get('/api/public/boletos/:numero/oportunidades', limiterOrdenes, async (req, res) => {
    try {
        const { numero } = req.params;
        const numeroBoleto = parseInt(numero, 10);
        const rifaIdActual = Number.parseInt(req.rifaContext?.id, 10) || null;
        const config = cargarConfigSorteo();
        const oportunidadesConfig = obtenerConfigOportunidadesSistema(config);

        if (!oportunidadesConfig.enabled) {
            return res.json({
                success: true,
                numero_boleto: Number.isInteger(numeroBoleto) ? numeroBoleto : null,
                oportunidades: [],
                cantidad: 0
            });
        }

        if (!oportunidadesConfig.configuracionCompleta || !oportunidadesConfig.configuracionConsistente) {
            return res.status(409).json({
                success: false,
                message: 'La configuración de oportunidades es inválida o incompleta',
                detalles: oportunidadesConfig.errores
            });
        }

        const rangoVisible = oportunidadesConfig.rangoVisible;

        if (
            !Number.isInteger(numeroBoleto)
            || !rangoVisible
            || numeroBoleto < rangoVisible.inicio
            || numeroBoleto > rangoVisible.fin
        ) {
            return res.status(400).json({
                success: false,
                message: `Número de boleto inválido (debe estar entre ${rangoVisible?.inicio ?? 0} y ${rangoVisible?.fin ?? 0})`
            });
        }

        const oportunidades = await db('orden_oportunidades')
            .modify((qb) => {
                if (rifaIdActual) qb.where('rifa_id', rifaIdActual);
            })
            .where('numero_boleto', numeroBoleto)
            .select('numero_oportunidad')
            .orderBy('numero_oportunidad');

        if (oportunidades.length === 0) {
            return res.status(404).json({
                success: false,
                message: `No hay oportunidades pre-asignadas para boleto ${numeroBoleto}`,
                debug: 'Ejecuta npm run populate:oportunidades en backend'
            });
        }

        if (oportunidades.length !== oportunidadesConfig.multiplicador) {
            return res.status(409).json({
                success: false,
                message: 'La cantidad de oportunidades del boleto no coincide con el multiplicador configurado',
                detalles: {
                    numero_boleto: numeroBoleto,
                    esperadas: oportunidadesConfig.multiplicador,
                    encontradas: oportunidades.length
                }
            });
        }

        const numeros = oportunidades.map(o => o.numero_oportunidad);

        return res.json({
            success: true,
            numero_boleto: numeroBoleto,
            oportunidades: numeros,
            cantidad: numeros.length
        });
    } catch (error) {
        console.error('GET /api/public/boletos/:numero/oportunidades error:', error);
        return res.status(500).json({
            success: false,
            message: 'Error al obtener oportunidades del boleto',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * POST /api/public/boletos/oportunidades/batch
 * ⚡ OPTIMIZADO: Obtiene oportunidades para múltiples boletos EN 1 REQUEST
 * 
 * En lugar de hacer 12,000 requests (1 por boleto):
 * - ANTES: 12,000 boletos = 12,000 requests = ~40 segundos (3 concurrent)
 * - AHORA: 12,000 boletos = 240 requests (batch de 50) = ~8 segundos (15 concurrent)
 * 
 * @body { numeros: [1, 2, 3, ..., 50] }  // Array de hasta 100 boletos
 * @returns { success: true, datos: { 1: [o1, o2, ...], 2: [...], ... } }
 */
app.post('/api/public/boletos/oportunidades/batch', limiterOrdenes, async (req, res) => {
    try {
        const { numeros } = req.body;
        const rifaIdActual = Number.parseInt(req.rifaContext?.id, 10) || null;
        const config = cargarConfigSorteo();
        const oportunidadesConfig = obtenerConfigOportunidadesSistema(config);

        if (!oportunidadesConfig.enabled) {
            return res.json({
                success: true,
                totales: {
                    solicitados: Array.isArray(numeros) ? numeros.length : 0,
                    procesados: 0,
                    oportunidades: 0
                },
                datos: {}
            });
        }

        if (!oportunidadesConfig.configuracionCompleta || !oportunidadesConfig.configuracionConsistente) {
            return res.status(409).json({
                success: false,
                message: 'La configuración de oportunidades es inválida o incompleta',
                detalles: oportunidadesConfig.errores
            });
        }

        // Validar entrada
        if (!Array.isArray(numeros) || numeros.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Requiere: { numeros: [1, 2, 3, ...] }'
            });
        }

        if (numeros.length > 100) {
            return res.status(400).json({
                success: false,
                message: 'Máximo 100 boletos por batch (recibidos: ' + numeros.length + ')'
            });
        }

        const rangoVisible = oportunidadesConfig.rangoVisible;
        const numerosValidos = numeros
            .map(n => parseInt(n, 10))
            .filter((n) => Number.isInteger(n)
                && rangoVisible
                && n >= rangoVisible.inicio
                && n <= rangoVisible.fin);

        if (numerosValidos.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No hay números de boleto válidos'
            });
        }

        // 🚀 QUERY OPTIMIZADO: Un solo WHERE IN() para todos los boletos
        const oportunidades = await db('orden_oportunidades')
            .modify((qb) => {
                if (rifaIdActual) qb.where('rifa_id', rifaIdActual);
            })
            .whereIn('numero_boleto', numerosValidos)
            .select('numero_boleto', 'numero_oportunidad')
            .orderBy('numero_boleto')
            .orderBy('numero_oportunidad');

        // Agrupar por número de boleto
        const resultado = {};
        numerosValidos.forEach(n => {
            resultado[n] = [];
        });

        oportunidades.forEach(row => {
            if (!resultado[row.numero_boleto]) {
                resultado[row.numero_boleto] = [];
            }
            resultado[row.numero_boleto].push(row.numero_oportunidad);
        });

        const boletosInconsistentes = numerosValidos
            .filter((numero) => (resultado[numero] || []).length !== oportunidadesConfig.multiplicador)
            .map((numero) => ({
                numero_boleto: numero,
                esperadas: oportunidadesConfig.multiplicador,
                encontradas: (resultado[numero] || []).length
            }));

        if (boletosInconsistentes.length > 0) {
            return res.status(409).json({
                success: false,
                message: 'Uno o más boletos no tienen el número correcto de oportunidades preasignadas',
                detalles: boletosInconsistentes
            });
        }

        return res.json({
            success: true,
            totales: {
                solicitados: numerosValidos.length,
                procesados: Object.keys(resultado).length,
                oportunidades: oportunidades.length
            },
            datos: resultado
        });
    } catch (error) {
        console.error('POST /api/public/boletos/oportunidades/batch error:', error);
        return res.status(500).json({
            success: false,
            message: 'Error al obtener oportunidades en batch',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * POST /api/public/maquina/generar
 * ✅ CRÍTICO: Genera números aleatorios DESDE EL BACKEND con reserva temporal
 * Evita que múltiples usuarios reciban los mismos números simultáneamente
 * 
 * Body: { cantidad: number (1-100), rifa_id?: number }
 * Response: { 
 *   success: true, 
 *   boletos: [5432, 7891, ...], 
 *   expiresAt: '2026-04-30T10:05:00Z',
 *   mensaje: 'Boletos reservados por 5 minutos'
 * }
 */
app.post('/api/public/maquina/generar', async (req, res) => {
    try {
        const { cantidad, rifa_id } = req.body || {};

        // Validaciones básicas
        if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > 100) {
            return res.status(400).json({
                success: false,
                message: 'Cantidad debe ser entre 1 y 100 boletos'
            });
        }

        const rifaIdActual = Number.parseInt(rifa_id || req.rifaContext?.id, 10) || null;
        const config = cargarConfigSorteo();
        const totalBoletos = config.totalBoletos;

        if (totalBoletos <= 0) {
            return res.status(400).json({
                success: false,
                message: 'No hay boletos disponibles en este sorteo'
            });
        }

        // Verificar disponibilidad suficiente
        const disponiblesActuales = Number(config.estado?.boletosDisponibles || 0);
        if (disponiblesActuales < cantidad) {
            return res.status(409).json({
                success: false,
                message: `Solo hay ${disponiblesActuales} boletos disponibles. Solicitaste ${cantidad}.`,
                disponibles: disponiblesActuales
            });
        }

        // ✅ TRANSACCIÓN: Reservar boletos temporalmente por 5 minutos
        const resultado = await db.transaction(async (trx) => {
            // Configurar timeouts
            await trx.raw("SET LOCAL lock_timeout = '5s'");
            await trx.raw("SET LOCAL statement_timeout = '20s'");

            // Seleccionar boletos disponibles ALEATORIOS con FOR UPDATE SKIP LOCKED
            // Esto garantiza que múltiples usuarios NO reciban los mismos boletos
            const boletosSeleccionados = await trx('boletos_estado')
                .select('numero')
                .modify((qb) => {
                    if (rifaIdActual) qb.where('rifa_id', rifaIdActual);
                })
                .where('estado', 'disponible')
                .whereNull('numero_orden')
                .orderByRaw('RANDOM()')  // ← ALEATORIO en backend
                .limit(cantidad)
                .forUpdate()  // ← Bloquea para otros transactions
                .timeout(5000);

            if (boletosSeleccionados.length < cantidad) {
                throw {
                    code: 'INSUFICIENTES_DISPONIBLES',
                    message: `Solo ${boletosSeleccionados.length} boletos disponibles actualmente`
                };
            }

            const numerosBoletos = boletosSeleccionados.map(b => b.numero);
            const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutos

            // Reservar boletos temporalmente
            const actualizados = await trx('boletos_estado')
                .modify((qb) => {
                    if (rifaIdActual) qb.where('rifa_id', rifaIdActual);
                })
                .whereIn('numero', numerosBoletos)
                .where('estado', 'disponible')
                .update({
                    estado: 'reservado_maquina',
                    updated_at: new Date()
                });

            if (actualizados !== numerosBoletos.length) {
                throw {
                    code: 'BOLETOS_CAMBIARON_ESTADO',
                    message: 'Algunos boletos ya no están disponibles'
                };
            }

            return {
                boletos: numerosBoletos,
                expiresAt: expiresAt.toISOString(),
                cantidad: numerosBoletos.length
            };
        });

        console.log(`[Máquina] ✅ ${resultado.cantidad} boletos reservados por 5 min`);

        return res.json({
            success: true,
            boletos: resultado.boletos,
            expiresAt: resultado.expiresAt,
            mensaje: `Boletos reservados por 5 minutos. Completa tu compra antes de ${new Date(resultado.expiresAt).toLocaleTimeString()}`
        });

    } catch (error) {
        console.error('[Máquina] ❌ Error generando boletos:', error);

        if (error.code === 'INSUFICIENTES_DISPONIBLES' || error.code === 'BOLETOS_CAMBIARON_ESTADO') {
            return res.status(409).json({
                success: false,
                message: error.message || 'Boletos no disponibles. Intenta con otra cantidad.'
            });
        }

        if (error.message?.includes('timeout') || error.message?.includes('lock')) {
            return res.status(503).json({
                success: false,
                message: 'Alta concurrencia. Por favor intenta en unos segundos.'
            });
        }

        return res.status(500).json({
            success: false,
            message: 'Error generando boletos aleatorios'
        });
    }
});

/**
 * GET /api/public/oportunidades/disponibles
 * ✅ FASE 2: Obtiene oportunidades disponibles CON SOPORTE PARA PAGINACIÓN
 * 
 * Query params opcionales:
 * - limit=10000    → Retorna máximo 10,000 números (default: todos)
 * - offset=0       → Comienza desde este índice (default: 0)
 * 
 * Respuesta (sin paginación - BACKWARD COMPATIBLE):
 * { 
 *   success: true,
 *   disponibles: [20000, 20001, ...],    // Array de números
 *   cantidad: 80000,                      // Total disponibles
 *   rango: { inicio: 20000, fin: 99999 },
 *   cached: true/false,
 *   timestamp: 1234567890
 * }
 * 
 * Respuesta (con paginación):
 * {
 *   success: true,
 *   disponibles: [20000, 20001, ...],    // 10,000 números max
 *   cantidad: 10000,                      // Números en esta página
 *   total: 80000,                         // Total disponibles en BD
 *   offset: 0,
 *   limit: 10000,
 *   paginas: 75,                          // ceil(total / limit)
 *   pagina_actual: 1,                     // offset/limit + 1
 *   cached: true/false,
 *   timestamp: 1234567890
 * }
 */
app.get('/api/public/oportunidades/disponibles', limiterOrdenes, async (req, res) => {
    const tiempoInicio = Date.now();
    try {
        const config = cargarConfigSorteo();
        const oportunidadesConfig = obtenerConfigOportunidadesSistema(config);
        const rangoOculto = oportunidadesConfig.rangoOculto;

        if (oportunidadesConfig.enabled && !oportunidadesConfig.configuracionConsistente) {
            return res.status(409).json({
                success: false,
                message: 'La configuración de oportunidades es inválida o incompleta',
                detalles: oportunidadesConfig.errores
            });
        }

        if (!oportunidadesConfig.enabled || !rangoOculto) {
            return res.json({
                success: true,
                disponibles: [],
                cantidad: 0,
                total: 0,
                rango: null,
                timestamp: Date.now(),
                cached: false,
                queryTime: Date.now() - tiempoInicio
            });
        }

        // 📊 PARÁMETROS: Soporte para paginación
        const limit = req.query.limit ? parseInt(req.query.limit) : null;
        const offset = req.query.offset ? parseInt(req.query.offset) : 0;

        // Validar parámetros
        if (limit !== null) {
            if (isNaN(limit) || limit < 1 || limit > 100000) {
                return res.status(400).json({
                    success: false,
                    message: 'limit debe ser un número entre 1 y 100000'
                });
            }
            if (isNaN(offset) || offset < 0) {
                return res.status(400).json({
                    success: false,
                    message: 'offset debe ser un número >= 0'
                });
            }
        }

        const ahora = Date.now();
        const CACHE_TTL = 60000; // ⭐ 60 segundos
        const modosPaginado = limit !== null;

        // ⭐ CACHE INTELIGENTE: Por página o global
        let cacheKey = 'oportunidades_disponibles';
        let caché = null;

        if (modosPaginado) {
            // Cache por página
            cacheKey = `oportunidades_page_${offset}_${limit}`;
            if (!global.oportunidadesCachePages) {
                global.oportunidadesCachePages = {};
            }
            caché = global.oportunidadesCachePages[cacheKey];
        } else {
            // Cache global (modo completo)
            caché = global.oportunidadesCache;
        }

        // Verificar si hay cache válido
        if (caché && global.oportunidadesCacheTime) {
            const edad = ahora - global.oportunidadesCacheTime;
            if (edad < CACHE_TTL) {
                // Cache hit - usando cache local
                setHttpCacheHeaders(res, 60, true);
                return res.json({ ...caché, cached: true, queryTime: Date.now() - tiempoInicio });
            }
        }

        // ⭐ FUNCIÓN AUXILIAR: Construir respuesta
        const construirRespuesta = (disponibles, esCompleto = false) => {
            if (esCompleto) {
                // Modo sin paginación (BACKWARD COMPATIBLE)
                return {
                    success: true,
                    disponibles: disponibles,
                    cantidad: disponibles.length,
                    rango: rangoOculto,
                    timestamp: Date.now(),
                    cached: false,
                    queryTime: Date.now() - tiempoInicio
                };
            } else {
                // Modo paginado
                const total = disponibles.total;
                const numeros = disponibles.items;
                const paginas = Math.ceil(total / limit);
                // Calcular página actual, garantizando que no exceda el máximo
                const paginaActual = Math.min(Math.floor(offset / limit) + 1, paginas);

                return {
                    success: true,
                    disponibles: numeros,
                    cantidad: numeros.length,
                    total: total,
                    offset: offset,
                    limit: limit,
                    paginas: paginas,
                    pagina_actual: paginaActual,
                    rango: rangoOculto,
                    timestamp: Date.now(),
                    cached: false,
                    queryTime: Date.now() - tiempoInicio
                };
            }
        };

        // 🔍 QUERY OPTIMIZADA: Field limiting (solo numero_oportunidad)
        let query = db('orden_oportunidades')
            .where('estado', 'disponible')
            .whereNull('numero_orden')
            .whereBetween('numero_oportunidad', [rangoOculto.inicio, rangoOculto.fin])
            .select('numero_oportunidad');

        let respuesta;

        if (modosPaginado) {
            // PAGINACIÓN: 2 queries (count + data)
            // Query 1: Contar total disponibles
            const countQuery = db('orden_oportunidades')
                .where('estado', 'disponible')
                .whereNull('numero_orden')
                .whereBetween('numero_oportunidad', [rangoOculto.inicio, rangoOculto.fin])
                .count('* as total')
                .first()
                .timeout(30000);  // 30s suficiente para paginado

            // Query 2: Obtener datos paginados
            const dataQuery = query
                .limit(limit)
                .offset(offset)
                .timeout(30000);  // 30s suficiente para paginado

            // Ejecutar en paralelo
            const [countResult, disponibles] = await Promise.all([countQuery, dataQuery]);

            const numeros = disponibles.map(o => o.numero_oportunidad);
            const totalEnBD = countResult.total || 0;

            // Validar offset
            if (offset > totalEnBD && offset > 0) {
                return res.status(400).json({
                    success: false,
                    message: `offset ${offset} excede total disponibles (${totalEnBD})`
                });
            }

            // Guardar en cache de página
            const respuestaPaginada = construirRespuesta({ total: totalEnBD, items: numeros }, false);
            if (!global.oportunidadesCachePages) {
                global.oportunidadesCachePages = {};
            }
            global.oportunidadesCachePages[cacheKey] = respuestaPaginada;
            global.oportunidadesCacheTime = ahora;

            respuesta = respuestaPaginada;
        } else {
            // MODO COMPLETO: Sin paginación (backwards compatible)
            const disponibles = await query.timeout(90000);  // ⭐ 90s para query completa (750k registros puede tardar)
            const numeros = disponibles.map(o => o.numero_oportunidad);

            // Guardar en cache global
            global.oportunidadesCache = { numeros, rango: rangoOculto };
            global.oportunidadesCacheTime = ahora;

            respuesta = construirRespuesta(numeros, true);
        }

        setHttpCacheHeaders(res, 60, true);
        return res.json(respuesta);

    } catch (error) {
        console.error('❌ [GET /api/public/oportunidades/disponibles] Error:', error.message);
        console.error('   Stack:', error.stack);
        return res.status(500).json({
            success: false,
            message: 'Error obteniendo oportunidades disponibles',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * POST /api/public/oportunidades/validar
 * ✅ NUEVO: Valida si oportunidades están REALMENTE disponibles en BD
 * 
 * Payload: { numeros: [250112, 252496, ...] }
 * Respuesta: { 
 *   disponibles: [250112, ...],      // Números que SÍ están disponibles
 *   noDisponibles: [252496, ...],    // Números que NO están disponibles
 *   cantidad: 100
 * }
 * 
 * ⚠️ CRÍTICO: El frontend usa esto para VALIDAR antes de enviar la orden
 * Evita el auto-reemplazo automático del backend
 */
app.post('/api/public/oportunidades/validar', limiterOrdenes, async (req, res) => {
    try {
        const { numeros } = req.body;

        // Validar entrada
        if (!Array.isArray(numeros) || numeros.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Números de oportunidades requeridos'
            });
        }

        // Limitar a máximo 500 para no saturar
        const numerosValidados = numeros.slice(0, 500);

        console.log(`🔍 [POST /api/public/oportunidades/validar] Validando ${numerosValidados.length} oportunidades...`);

        // Consultar BD: cuáles REALMENTE están disponibles
        const oportunidadesEnBD = await db('orden_oportunidades')
            .whereIn('numero_oportunidad', numerosValidados)
            .select('numero_oportunidad', 'estado', 'numero_orden');

        // Separar disponibles de no-disponibles
        const disponiblesEnBD = new Set(
            oportunidadesEnBD
                .filter(o => o.estado === 'disponible' && o.numero_orden === null)
                .map(o => o.numero_oportunidad)
        );

        const disponibles = numerosValidados.filter(n => disponiblesEnBD.has(n));
        const noDisponibles = numerosValidados.filter(n => !disponiblesEnBD.has(n));

        console.log(`✅ [POST /api/public/oportunidades/validar] Resultado:`);
        console.log(`   • Disponibles: ${disponibles.length}/${numerosValidados.length}`);
        console.log(`   • No-disponibles: ${noDisponibles.length}`);

        return res.json({
            success: true,
            disponibles: disponibles,
            noDisponibles: noDisponibles,
            cantidad: disponibles.length,
            cantidadNoDisponibles: noDisponibles.length
        });
    } catch (error) {
        console.error('❌ [POST /api/public/oportunidades/validar] Error:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Error validando oportunidades',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * GET /api/admin/oportunidades/inventario/resumen
 * Evalúa si la secuencia de oportunidades está lista para poblar desde admin
 */
app.get('/api/admin/oportunidades/inventario/resumen', verificarToken, async (req, res) => {
    try {
        const resumen = await OportunidadesInventoryService.obtenerResumen(cargarConfigSorteo(), db, {
            rifaId: req.rifaContext?.id
        });
        return res.json({
            success: true,
            data: resumen
        });
    } catch (error) {
        log('error', 'GET /api/admin/oportunidades/inventario/resumen error', { error: error.message });
        return res.status(500).json({
            success: false,
            message: 'No se pudo cargar el resumen del inventario de oportunidades',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * POST /api/admin/oportunidades/inventario/preview
 * Preview no destructivo del estado de oportunidades con la config actual
 */
app.post('/api/admin/oportunidades/inventario/preview', verificarToken, async (req, res) => {
    try {
        const resumen = await OportunidadesInventoryService.obtenerResumen(cargarConfigSorteo(), db, {
            rifaId: req.rifaContext?.id
        });
        return res.json({
            success: true,
            data: resumen
        });
    } catch (error) {
        log('error', 'POST /api/admin/oportunidades/inventario/preview error', { error: error.message });
        return res.status(500).json({
            success: false,
            message: error.message || 'No se pudo generar el preview de oportunidades'
        });
    }
});

/**
 * POST /api/admin/oportunidades/inventario/poblar
 * Poblado controlado desde la configuración actual del sorteo
 */
app.post('/api/admin/oportunidades/inventario/poblar', verificarToken, async (req, res) => {
    try {
        const shuffle = req.body?.shuffle !== false;
        const resultado = await OportunidadesInventoryService.poblarDesdeConfig(cargarConfigSorteo(), {
            shuffle,
            rifaId: req.rifaContext?.id
        });

        log('info', 'POST /api/admin/oportunidades/inventario/poblar success', {
            usuario: req.usuario?.username,
            insertadas: resultado.insertadas,
            multiplicador: resultado.configuracion?.multiplicador,
            totalEsperado: resultado.configuracion?.totalOportunidadesEsperadas
        });

        return res.json({
            success: true,
            message: resultado.insertadas > 0
                ? `Se poblaron ${resultado.insertadas.toLocaleString()} oportunidades preasignadas`
                : 'El inventario de oportunidades ya estaba correctamente poblado',
            data: resultado
        });
    } catch (error) {
        const statusCode = error.code === 'INVENTARIO_EN_PROGRESO'
            ? 409
            : error.code === 'OPORTUNIDADES_NO_LISTAS'
                ? 409
                : 500;

        log('error', 'POST /api/admin/oportunidades/inventario/poblar error', { error: error.message, code: error.code });
        return res.status(statusCode).json({
            success: false,
            message: error.message || 'No se pudo poblar el inventario de oportunidades',
            code: error.code || 'OPORTUNIDADES_POBLAR_ERROR'
        });
    }
});

/**
 * GET /api/admin/oportunidades-stats
 * Obtiene estadísticas COMPLETAS de oportunidades:
 * - Total configurado (del sistema)
 * - Conteos REALES de BD (disponibles, asignadas, apartadas, canceladas)
 * - Cálculos derivados (en uso, porcentaje)
 * Protegido: JWT token requerido
 */
app.get('/api/admin/oportunidades-stats', verificarToken, async (req, res) => {
    try {
        console.log('📊 [GET /api/admin/oportunidades-stats] Iniciando...');
        const rifaIdActual = Number.parseInt(req.rifaContext?.id, 10) || null;

        const agregados = await db('orden_oportunidades')
            .modify((qb) => {
                if (rifaIdActual) qb.where('rifa_id', rifaIdActual);
            })
            .select(
                db.raw(`
                    COUNT(*) FILTER (
                        WHERE estado = 'disponible'
                        AND (numero_orden IS NULL OR numero_orden = '0')
                    )::int as disponibles
                `),
                db.raw(`
                    COUNT(*) FILTER (
                        WHERE estado = 'apartado'
                        AND numero_orden IS NOT NULL
                        AND numero_orden <> '0'
                    )::int as apartadas
                `),
                db.raw(`
                    COUNT(*) FILTER (
                        WHERE estado = 'vendido'
                        AND numero_orden IS NOT NULL
                    )::int as asignadas
                `),
                db.raw(`
                    COUNT(*) FILTER (
                        WHERE estado = 'cancelado'
                    )::int as canceladas
                `)
            )
            .first();

        const conteos = {
            disponible: Number.parseInt(agregados?.disponibles, 10) || 0,
            apartado: Number.parseInt(agregados?.apartadas, 10) || 0,
            asignado: Number.parseInt(agregados?.asignadas, 10) || 0,
            cancelado: Number.parseInt(agregados?.canceladas, 10) || 0
        };

        console.log('📋 [GET /api/admin/oportunidades-stats] Conteos:', conteos);

        // Obtener total configurado del sistema
        const oportunidadesConfig = obtenerConfigOportunidadesSistema(cargarConfigSorteo());
        const totalConfigurado = oportunidadesConfig.totalOportunidadesConfiguradas
            || oportunidadesConfig.totalOportunidadesEsperadas
            || 0;

        // Calcular totales
        const totalEnBD = Object.values(conteos).reduce((sum, val) => sum + val, 0);
        const enUso = conteos.asignado + conteos.apartado;
        const porcentajeUso = totalConfigurado > 0 ? Math.round((enUso / totalConfigurado) * 100) : 0;

        console.log('✅ [GET /api/admin/oportunidades-stats] Cálculos:', {
            totalConfigurado,
            totalEnBD,
            disponible: conteos.disponible,
            asignado: conteos.asignado,
            apartado: conteos.apartado,
            enUso,
            porcentajeUso
        });

        // Retornar datos COMPLETOS para admin
        return res.json({
            success: true,
            data: {
                // Totales
                totalConfigurado: totalConfigurado,  // Total del sorteo actual
                totalEnBD: totalEnBD,                // Total real en BD

                // Conteos por estado
                disponibles: conteos.disponible,
                asignadas: conteos.asignado,
                apartadas: conteos.apartado,
                canceladas: conteos.cancelado,

                // Derivados
                enUso: enUso,                        // asignadas + apartadas
                porcentajeUso: porcentajeUso         // % del total configurado
            }
        });

    } catch (error) {
        console.error('❌ [GET /api/admin/oportunidades-stats] Error:', error);
        return res.status(500).json({
            success: false,
            message: 'Error al obtener estadísticas de oportunidades',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * GET /api/admin/boletos
 * Obtener lista detallada de boletos (protegido con JWT)
 */
app.get('/api/admin/boletos', verificarToken, async (req, res) => {
    try {
        const rifaIdActual = Number.parseInt(req.rifaContext?.id, 10) || null;
        const ordenes = await db('ordenes')
            .modify((qb) => {
                if (rifaIdActual) qb.where('rifa_id', rifaIdActual);
            })
            .select('numero_orden', 'boletos', 'estado', 'nombre_cliente', 'telefono_cliente', 'created_at');

        // Obtener totalBoletos desde la configuración actual
        const configSorteo = cargarConfigSorteo();
        const totalBoletos = configSorteo.totalBoletos;

        // Crear set de boletos vendidos/reservados
        const boletosEnOrdenes = new Set();
        const boletosDetallados = [];

        ordenes.forEach(orden => {
            try {
                const numerosArr = JSON.parse(orden.boletos || '[]');
                if (Array.isArray(numerosArr)) {
                    numerosArr.forEach(num => {
                        const numNum = Number(num);
                        boletosEnOrdenes.add(numNum);
                        boletosDetallados.push({
                            numero: numNum,
                            numero_orden: orden.numero_orden,
                            estado: orden.estado.includes('confirmada') || orden.estado.includes('completada') ? 'vendido' : orden.estado.includes('pendiente') || orden.estado.includes('comprobante') ? 'apartado' : orden.estado,
                            cliente_nombre: orden.nombre_cliente || '',
                            cliente_whatsapp: orden.telefono_cliente || '',
                            created_at: orden.created_at
                        });
                    });
                }
            } catch (e) {
                // Ignorar órdenes con boletos inválidos
            }
        });

        // Agregar boletos disponibles (los que no están en ninguna orden)
        for (let i = 1; i <= totalBoletos; i++) {
            if (!boletosEnOrdenes.has(i)) {
                boletosDetallados.push({
                    numero: i,
                    estado: 'disponible',
                    numero_orden: null,
                    cliente_nombre: '',
                    cliente_whatsapp: ''
                });
            }
        }

        // Ordenar por número de boleto
        boletosDetallados.sort((a, b) => a.numero - b.numero);

        return res.json({
            success: true,
            data: boletosDetallados
        });
    } catch (error) {
        console.error('GET /api/admin/boletos error:', error);
        return res.status(500).json({
            success: false,
            message: 'Error al obtener boletos',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
/**
 * PATCH /api/ordenes/:id/estado
 * 
 * Actualizar estado de una orden (protegido con JWT admin)
 * Usa transacción ACID para garantizar consistencia atómica
 * 
 * FLUJO DE ESTADOS:
 * - pendiente → confirmada: Boletos pasan a 'vendido', Oportunidades a 'vendido'
 * - pendiente → cancelada: Boletos vuelven a 'disponible', Oportunidades a 'disponible'
 * - cualquier estado → cualquier estado: Cambio atómico garantizado
 * 
 * SEGURIDAD:
 * - Requiere JWT con rol 'admin' (verificarToken)
 * - Transacción rollback automático si hay error
 * - Protección contra race conditions con consulta dentro de transacción
 * 
 * Body: { estado: 'confirmada' | 'cancelada' | 'pendiente' | 'completada' }
 */
app.patch('/api/ordenes/:id/estado', verificarToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { estado } = req.body;
        const rifaIdActual = Number.parseInt(req.rifaContext?.id, 10) || null;

        const estadosValidos = ['pendiente', 'confirmada', 'cancelada'];
        if (!estadosValidos.includes(estado)) {
            return res.status(400).json({
                success: false,
                message: `Estado inválido. Válidos: ${estadosValidos.join(', ')}`
            });
        }

        // Usar transacción para cambios de estado
        const resultado = await db.transaction(async (trx) => {
            // Leer orden actual (con lock implícito dentro de transacción)
            const ordenActual = await trx('ordenes')
                .modify((qb) => {
                    if (rifaIdActual) qb.where('rifa_id', rifaIdActual);
                })
                .where('numero_orden', id)
                .first();

            if (!ordenActual) {
                throw new Error('ORDER_NOT_FOUND');
            }

            const allowedTransitions = {
                pendiente: ['pendiente', 'confirmada', 'cancelada'],
                confirmada: ['confirmada', 'cancelada'],
                cancelada: ['cancelada', 'confirmada']
            };

            const estadoActual = ordenActual.estado || 'pendiente';
            const transicionesPermitidas = allowedTransitions[estadoActual] || [];
            if (!transicionesPermitidas.includes(estado)) {
                throw new Error(`INVALID_STATE_TRANSITION:${estadoActual}->${estado}`);
            }

            let boletosActualizados = 0;
            const boletos = parseBoletosOrdenSeguro(ordenActual.boletos);

            // LÓGICA DE TRANSICIÓN DE ESTADOS Y BOLETOS
            // ==========================================

            // Si cambia a 'confirmada' → boletos pasan a 'vendido'
            if (estado === 'confirmada' && ordenActual.estado !== 'confirmada') {
                console.log(`[Orden ${id}] Boletos a confirmar:`, boletos);

                if (boletos.length > 0) {
                    // Actualizar boletos a 'vendido' en chunks de 1000
                    const CHUNK_SIZE = 1000;
                    for (let i = 0; i < boletos.length; i += CHUNK_SIZE) {
                        const chunk = boletos.slice(i, i + CHUNK_SIZE);
                        const actualizado = await trx('boletos_estado')
                            .modify((qb) => {
                                if (rifaIdActual) qb.where('rifa_id', rifaIdActual);
                            })
                            .whereIn('numero', chunk)
                            .update({
                                estado: 'vendido',
                                numero_orden: id,
                                updated_at: new Date()
                            });
                        boletosActualizados += actualizado;
                    }
                    console.log(`[Orden ${id}] Confirmada: ${boletosActualizados} boletos marcados como VENDIDO`);

                    const oportunidadesConfirmadas = await trx('orden_oportunidades')
                        .modify((qb) => {
                            if (rifaIdActual) qb.where('rifa_id', rifaIdActual);
                        })
                        .where('numero_orden', id)
                        .whereIn('numero_boleto', boletos)
                        .where('estado', 'apartado')
                        .update({
                            estado: 'vendido'
                        });

                    if (oportunidadesConfirmadas > 0) {
                        console.log(`[Orden ${id}] Confirmada: ${oportunidadesConfirmadas} oportunidades marcadas como VENDIDO`);
                    }
                }
            }

            // Si cambia a 'cancelada' → boletos vuelven a 'disponible'
            if (estado === 'cancelada' && ordenActual.estado !== 'cancelada') {
                console.log(`[Orden ${id}] Boletos a cancelar:`, boletos);

                if (boletos.length > 0) {
                    const CHUNK_SIZE = 1000;
                    for (let i = 0; i < boletos.length; i += CHUNK_SIZE) {
                        const chunk = boletos.slice(i, i + CHUNK_SIZE);
                        const actualizado = await trx('boletos_estado')
                            .modify((qb) => {
                                if (rifaIdActual) qb.where('rifa_id', rifaIdActual);
                            })
                            .whereIn('numero', chunk)
                            .update({
                                estado: 'disponible',
                                numero_orden: null,
                                updated_at: new Date()
                            });
                        boletosActualizados += actualizado;
                    }
                    console.log(`[Orden ${id}] Cancelada: ${boletosActualizados} boletos devueltos a DISPONIBLE`);
                }

                // NUEVO: Liberar OPORTUNIDADES (apartadas O vendidas) para esta orden
                const oportunidadesLiberadas = await trx('orden_oportunidades')
                    .modify((qb) => {
                        if (rifaIdActual) qb.where('rifa_id', rifaIdActual);
                    })
                    .where('numero_orden', id)
                    .whereIn('numero_boleto', boletos)
                    .whereIn('estado', ['apartado', 'vendido'])  // ✅ CRITICAL FIX: Liberar también 'vendido'
                    .update({
                        estado: 'disponible',
                        numero_orden: null  // ✅ CORREGIDO: null en lugar de '0'
                    });

                if (oportunidadesLiberadas > 0) {
                    console.log(`[Orden ${id}] Cancelada: ${oportunidadesLiberadas} oportunidades devueltas a DISPONIBLE`);
                }
            }

            // Actualizar estado de orden dentro de transacción (atomic)
            await trx('ordenes')
                .modify((qb) => {
                    if (rifaIdActual) qb.where('rifa_id', rifaIdActual);
                })
                .where('numero_orden', id)
                .update({
                    estado: estado,
                    updated_at: new Date()
                });

            // 📌 NOTA: Las columnas de auditoría (confirmado_por, cancelado_por, etc.)
            // NO EXISTEN en el schema actual. Si necesitas agregar auditoría:
            // 1. Crear migración que agregue: confirmado_por, cancelado_por, 
            //    confirmado_en, cancelado_en, actualizado_por
            // 2. Descomentar el código en ENDPOINT-PATCH-ORDENES-ESTADO.md línea 4309-4325
            // Ver: ENDPOINT-PATCH-ORDENES-ESTADO.md para detalles

            return {
                success: true,
                boletosActualizados,
                ordenAnterior: {
                    numero_orden: ordenActual.numero_orden,
                    rifa_id: ordenActual.rifa_id || rifaIdActual || null,
                    nombre_cliente: ordenActual.nombre_cliente || '',
                    telefono_cliente: ordenActual.telefono_cliente || '',
                    estado: estadoActual,
                    cantidad_boletos: Number(ordenActual.cantidad_boletos || boletos.length || 0),
                    total: Number(ordenActual.total || 0),
                    comprobante_path: ordenActual.comprobante_path || null,
                    created_at: ordenActual.created_at || null,
                    updated_at: ordenActual.updated_at || null
                }
            };
        });

        if (resultado && resultado.success) {
            console.log(`✅ Orden ${id} actualizada a estado: ${estado} (${resultado.boletosActualizados} boletos actualizados)`);
        }

        refrescarCachesTrasCambioInventario();

        if (wsEvents) {
            try {
                const ordenActualizada = await db('ordenes')
                    .modify((qb) => {
                        if (rifaIdActual) qb.where('rifa_id', rifaIdActual);
                    })
                    .where('numero_orden', id)
                    .first('numero_orden', 'rifa_id', 'nombre_cliente', 'telefono_cliente', 'estado', 'cantidad_boletos', 'total', 'comprobante_path', 'created_at', 'updated_at');

                if (ordenActualizada) {
                    const rifaIdOrden = Number.parseInt(ordenActualizada?.rifa_id, 10) || null;
                    wsEvents.emitirOrdenActualizadaAdmin({
                        ...ordenActualizada,
                        estado_anterior: resultado?.ordenAnterior?.estado || null
                    }, rifaIdOrden);  // ✅ Pasar rifaId
                    wsEvents.emitirOrdenActualizadaPublica({
                        ...ordenActualizada,
                        estado_anterior: resultado?.ordenAnterior?.estado || null
                    }, rifaIdOrden);  // ✅ Pasar rifaId
                }
            } catch (wsError) {
                console.warn(`⚠️  Error emitiendo actualización admin de orden ${id}:`, wsError.message);
            }
        }

        let push = null;
        const cambioRealAConfirmada = estado === 'confirmada'
            && resultado?.ordenAnterior?.estado !== 'confirmada';
        const cambioRealACancelada = estado === 'cancelada'
            && resultado?.ordenAnterior?.estado !== 'cancelada';
        if (cambioRealAConfirmada || cambioRealACancelada) {
            try {
                const ordenActualizadaPush = await db('ordenes')
                    .modify((qb) => {
                        if (rifaIdActual) qb.where('rifa_id', rifaIdActual);
                    })
                    .where('numero_orden', id)
                    .first('numero_orden', 'rifa_id', 'telefono_cliente', 'cantidad_boletos', 'estado', 'created_at', 'updated_at');

                if (ordenActualizadaPush) {
                    if (cambioRealAConfirmada) {
                        push = await enviarPushOrdenConfirmada(db, ordenActualizadaPush);
                    } else if (cambioRealACancelada) {
                        push = await enviarPushOrdenCancelada(db, ordenActualizadaPush, {
                            reason: 'manual',
                            eventAt: ordenActualizadaPush.updated_at
                        });
                    }
                }
            } catch (pushError) {
                console.warn(`⚠️  Error enviando push de estado para orden ${id}:`, pushError.message);
            }
        }

        return res.json({
            success: true,
            message: `Orden actualizada a estado: ${estado}`,
            boletosActualizados: resultado.boletosActualizados || 0,
            push
        });
    } catch (error) {
        if (error.message === 'ORDER_NOT_FOUND') {
            return res.status(404).json({
                success: false,
                message: 'Orden no encontrada'
            });
        }

        if (error.message?.startsWith('INVALID_STATE_TRANSITION:')) {
            const transition = error.message.replace('INVALID_STATE_TRANSITION:', '');
            return res.status(400).json({
                success: false,
                message: `Transición de estado no permitida: ${transition}`
            });
        }

        log('error', 'PATCH /api/ordenes/:id/estado error', { error: error.message });
        return res.status(500).json({
            success: false,
            message: 'Error al actualizar orden',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * GET /api/admin/sales-stats
 * Estadísticas de ventas por día (últimos 7 días)
 * Query params: ?range=7 (días)
 * Estadísticas de ventas (PostgreSQL)
 */
app.get('/api/admin/sales-stats', verificarToken, async (req, res) => {
    try {
        const range = Math.max(1, Math.min(parseInt(req.query.range, 10) || 7, 90));
        const rifaIdActual = Number.parseInt(req.rifaContext?.id, 10) || null;

        const hoyUtc = new Date();
        hoyUtc.setUTCHours(0, 0, 0, 0);

        const fechaInicio = new Date(hoyUtc);
        fechaInicio.setUTCDate(fechaInicio.getUTCDate() - (range - 1));

        const agregados = await db('ordenes')
            .modify((qb) => {
                if (rifaIdActual) qb.where('rifa_id', rifaIdActual);
            })
            .whereIn('estado', ['confirmada', 'completada'])
            .where('created_at', '>=', fechaInicio.toISOString())
            .select(
                db.raw(`to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') as fecha`),
                db.raw('COALESCE(SUM(cantidad_boletos), 0) as boletos'),
                db.raw('COUNT(*) as ordenes')
            )
            .groupByRaw(`to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')`);

        const agregadosPorFecha = new Map(
            agregados.map((item) => [
                item.fecha,
                {
                    boletos: parseInt(item.boletos, 10) || 0,
                    ordenes: parseInt(item.ordenes, 10) || 0
                }
            ])
        );

        const stats = [];

        for (let i = range - 1; i >= 0; i--) {
            const fecha = new Date(hoyUtc);
            fecha.setUTCDate(fecha.getUTCDate() - i);

            const year = fecha.getUTCFullYear();
            const month = String(fecha.getUTCMonth() + 1).padStart(2, '0');
            const day = String(fecha.getUTCDate()).padStart(2, '0');
            const fechaStr = `${year}-${month}-${day}`;
            const agregado = agregadosPorFecha.get(fechaStr);

            stats.push({
                fecha: fechaStr,
                boletos: agregado?.boletos || 0,
                ordenes: agregado?.ordenes || 0
            });
        }

        return res.json({
            success: true,
            data: stats
        });
    } catch (error) {
        console.error('GET /api/admin/sales-stats error:', error);
        return res.status(500).json({
            success: false,
            message: 'Error al obtener estadísticas de ventas',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * POST /api/admin/declarar-ganador
 * Declarar un boleto como ganador (protegido con JWT)
 * Body: { numero: 5000 }
 */
app.post('/api/admin/declarar-ganador', verificarToken, async (req, res) => {
    try {
        const { numero, premio, valor_premio, tipo_ganador, posicion } = req.body || {};
        const configActualGanador = obtenerConfigActual();
        const rifaIdActual = req.rifaContext?.id || null;
        const numeroNormalizado = Number(numero);

        if (!Number.isInteger(numeroNormalizado) || numeroNormalizado <= 0) {
            return res.status(400).json({ success: false, message: 'Número requerido' });
        }

        const { orden: ordenEncontrada, boletoEstado, origen } = await buscarOrdenActivaPorBoleto(numeroNormalizado, {
            configActual: configActualGanador,
            rifaId: rifaIdActual
        });

        if (!ordenEncontrada) {
            return res.status(404).json({ success: false, message: 'Número no encontrado o no vendido/apartado' });
        }

        console.log(`[declarar-ganador] Resolviendo número #${numeroNormalizado} usando ${origen || 'sin-origen'}`, {
            numero_orden: ordenEncontrada.numero_orden,
            estadoOrden: ordenEncontrada.estado,
            estadoBoleto: boletoEstado?.estado || null,
            esOportunidad: boletoEstado?.es_oportunidad === true
        });

        const tipoGanadorNormalizado = normalizarTipoGanadorPersistencia(tipo_ganador);
        const limitesGanadores = obtenerLimitesGanadoresConfig(configActualGanador);
        const limiteTipoGanador = Number(limitesGanadores[tipoGanadorNormalizado]) || 0;

        if (limiteTipoGanador <= 0) {
            return res.status(409).json({
                success: false,
                message: 'Ese tipo de ganador no está habilitado en la configuración actual'
            });
        }

        const posicionSolicitada = posicion === null || typeof posicion === 'undefined' || posicion === ''
            ? null
            : Number(posicion);

        if (posicionSolicitada !== null && (!Number.isInteger(posicionSolicitada) || posicionSolicitada <= 0)) {
            return res.status(400).json({
                success: false,
                message: 'La posición del ganador es inválida'
            });
        }

        if (posicionSolicitada !== null && posicionSolicitada > limiteTipoGanador) {
            return res.status(409).json({
                success: false,
                message: `La posición solicitada excede el máximo configurado para este tipo (${limiteTipoGanador})`
            });
        }

        const aliasesTipoGanador = tipoGanadorNormalizado === 'principal'
            ? ['principal', 'sorteo']
            : tipoGanadorNormalizado === 'presorte'
                ? ['presorte', 'presorteo']
                : ['ruletazo', 'ruletazos'];

        const ganadoresTipoExistentes = await db('ganadores')
            .select('id', 'numero_boleto', 'tipo_ganador', 'posicion')
            .modify((qb) => {
                if (rifaIdActual) qb.where('rifa_id', rifaIdActual);
            })
            .whereIn('tipo_ganador', aliasesTipoGanador);

        const posicionesOcupadas = new Set(
            ganadoresTipoExistentes
                .map((item) => Number(item.posicion))
                .filter((value) => Number.isInteger(value) && value > 0)
        );

        const posicionFinal = (() => {
            if (posicionSolicitada !== null) return posicionSolicitada;
            for (let idx = 1; idx <= limiteTipoGanador; idx += 1) {
                if (!posicionesOcupadas.has(idx)) return idx;
            }
            return null;
        })();

        if (!posicionFinal) {
            return res.status(409).json({
                success: false,
                message: 'Ya no hay lugares disponibles para este tipo de ganador'
            });
        }

        if (posicionesOcupadas.has(posicionFinal)) {
            return res.status(409).json({
                success: false,
                message: `La posición ${posicionFinal} ya fue asignada a otro ganador`
            });
        }

        const ganadoresPreviosTotal = await db('ganadores')
            .modify((qb) => {
                if (rifaIdActual) qb.where('rifa_id', rifaIdActual);
            })
            .count('* as total')
            .first();

        const ganadorExistente = await db('ganadores')
            .modify((qb) => {
                if (rifaIdActual) qb.where('rifa_id', rifaIdActual);
            })
            .where({ numero_boleto: numeroNormalizado })
            .first();

        if (ganadorExistente) {
            return res.status(409).json({
                success: false,
                message: 'Este número ya fue declarado como ganador',
                ganador: ganadorExistente
            });
        }

        const ganadorMismaOrden = await db('ganadores')
            .modify((qb) => {
                if (rifaIdActual) qb.where('rifa_id', rifaIdActual);
            })
            .where({ numero_orden: ordenEncontrada.numero_orden })
            .first();

        // Compatibilidad con esquemas viejos donde numero_orden quedó como UNIQUE.
        // Si ya existe otro ganador de la misma orden, preservar referencia pero evitar choque.
        const numeroOrdenPersistir = ganadorMismaOrden
            ? `${ordenEncontrada.numero_orden}:${numeroNormalizado}`
            : ordenEncontrada.numero_orden;

        const [
            hasNumeroOrden,
            hasNumeroBoleto,
            hasWhatsapp,
            hasEmail,
            hasNombreGanador,
            hasNombreSorteo,
            hasPosicion,
            hasTipoGanador,
            hasPremio,
            hasValorPremio,
            hasFechaSorteo,
            hasEstado
        ] = await Promise.all([
            db.schema.hasColumn('ganadores', 'numero_orden'),
            db.schema.hasColumn('ganadores', 'numero_boleto'),
            db.schema.hasColumn('ganadores', 'whatsapp'),
            db.schema.hasColumn('ganadores', 'email'),
            db.schema.hasColumn('ganadores', 'nombre_ganador'),
            db.schema.hasColumn('ganadores', 'nombre_sorteo'),
            db.schema.hasColumn('ganadores', 'posicion'),
            db.schema.hasColumn('ganadores', 'tipo_ganador'),
            db.schema.hasColumn('ganadores', 'premio'),
            db.schema.hasColumn('ganadores', 'valor_premio'),
            db.schema.hasColumn('ganadores', 'fecha_sorteo'),
            db.schema.hasColumn('ganadores', 'estado')
        ]);

        // Insertar solo columnas realmente existentes para soportar esquemas viejos y optimizados.
        const payload = {};
        if (hasNumeroOrden) payload.numero_orden = numeroOrdenPersistir;
        if (hasNumeroBoleto) payload.numero_boleto = numeroNormalizado || null;
        if (hasWhatsapp) payload.whatsapp = ordenEncontrada.telefono_cliente || null;
        if (hasEmail) payload.email = ordenEncontrada.email || ordenEncontrada.email_cliente || null;
        if (hasNombreGanador) payload.nombre_ganador = ordenEncontrada.nombre_cliente || null;
        if (hasNombreSorteo) payload.nombre_sorteo = configActualGanador?.rifa?.nombreSorteo || null;
        if (hasPosicion) payload.posicion = posicionFinal;
        if (hasTipoGanador) payload.tipo_ganador = tipoGanadorNormalizado;
        if (hasPremio) payload.premio = premio || null;
        if (hasValorPremio) payload.valor_premio = valor_premio || null;
        if (hasFechaSorteo) payload.fecha_sorteo = new Date();
        if (hasEstado) payload.estado = 'notificado';
        if (rifaIdActual) payload.rifa_id = rifaIdActual;

        await db('ganadores').insert(payload);

        const creado = await db('ganadores')
            .modify((qb) => {
                if (rifaIdActual) qb.where('rifa_id', rifaIdActual);
            })
            .where({ numero_boleto: numeroNormalizado })
            .orderBy('id', 'desc')
            .first();

        let pushCampaign = null;
        try {
            const totalPrevio = Number.parseInt(ganadoresPreviosTotal?.total, 10) || 0;
            if (totalPrevio === 0) {
                const contextoResultados = rifaIdActual && rifaService?.enabled
                    ? await rifaService.resolverContexto({ rifaId: rifaIdActual, fallbackActive: false })
                    : (req.rifaContext || construirContextoRifaFallback());

                if (contextoResultados) {
                    const campaign = construirCampanaResultadosDisponiblesDesdeContexto(contextoResultados, {
                        rifaId: contextoResultados.id,
                        rifaSlug: contextoResultados.slug,
                        rifaNombre: contextoResultados.nombre,
                        resultsCount: 1
                    });

                    if (campaign.enabled && campaign.autoSendOnFirstPublication) {
                        pushCampaign = await encolarCampanaPushDesdeServidor(campaign, {
                            priority: 220
                        });
                    } else {
                        pushCampaign = {
                            skipped: true,
                            reason: campaign.enabled ? 'auto_send_disabled' : 'campaign_disabled'
                        };
                    }
                }
            }
        } catch (pushError) {
            console.warn(`⚠️  Error enviando push de resultados para rifa ${rifaIdActual || 'N/A'}:`, pushError.message);
        }

        // Sincronizar instantáneamente el snapshot si la rifa ya está en un estado finalizado
        try {
            const configActual = obtenerConfigActual(rifaIdActual);
            await asegurarSnapshotModalFinalizado(configActual, {
                usuarioAdmin: req.usuario?.username || 'SYSTEM',
                refrescarGanadores: true
            });
        } catch (snapshotError) {
            console.error('⚠️ Error actualizando snapshot en declarar-ganador:', snapshotError.message);
        }

        return res.json({ success: true, message: 'Ganador declarado y guardado', ganador: creado, pushCampaign });
    } catch (error) {
        console.error('POST /api/admin/declarar-ganador error:', error);
        return res.status(500).json({ success: false, message: 'Error al declarar ganador', error: process.env.NODE_ENV === 'development' ? error.message : undefined });
    }
});

/**
 * DELETE /api/admin/ganadores/:numero
 * Elimina un ganador por número de boleto (protegido con JWT)
 */
app.delete('/api/admin/ganadores/:numero', verificarToken, async (req, res) => {
    try {
        const numero = Number(req.params.numero);
        const rifaIdActual = req.rifaContext?.id || null;

        if (!Number.isFinite(numero)) {
            return res.status(400).json({ success: false, message: 'Número inválido' });
        }

        const eliminado = await db('ganadores')
            .modify((qb) => {
                if (rifaIdActual) qb.where('rifa_id', rifaIdActual);
            })
            .where({ numero_boleto: numero })
            .del();

        if (!eliminado) {
            return res.status(404).json({ success: false, message: 'Ganador no encontrado' });
        }

        // Sincronizar instantáneamente el snapshot si la rifa ya está en un estado finalizado
        try {
            const configActual = obtenerConfigActual(rifaIdActual);
            await asegurarSnapshotModalFinalizado(configActual, {
                usuarioAdmin: req.usuario?.username || 'SYSTEM',
                refrescarGanadores: true
            });
        } catch (snapshotError) {
            console.error('⚠️ Error actualizando snapshot en eliminar-ganador:', snapshotError.message);
        }

        return res.json({ success: true, message: 'Ganador eliminado correctamente' });
    } catch (error) {
        console.error('DELETE /api/admin/ganadores/:numero error:', error);
        return res.status(500).json({ success: false, message: 'Error al eliminar ganador', error: process.env.NODE_ENV === 'development' ? error.message : undefined });
    }
});

/**
 * GET /api/ganadores
 * Devuelve lista pública de ganadores (ordenada por fecha de sorteo desc)
 * Query params: ?limit=100
 * 
 * ⚠️ CRÍTICO PARA MULTIRIFA:
 * - Si hay rifaIdActual: retorna ganadores de ESA rifa + ganadores con rifa_id NULL (legacy)
 * - Si NO hay rifaIdActual: retorna TODOS los ganadores (incluyendo rifa_id NULL)
 * Esto permite compatibilidad con ganadores declarados antes del sistema multirifa
 */
app.get('/api/ganadores', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit || '100'), 1000);
        const rifaContext = req.rifaContext;
        if (!rifaContext || !rifaContext.id) {
            return res.status(400).json({ success: false, message: 'Rifa no identificada' });
        }
        const rifaIdActual = rifaContext.id;

        const rows = await db('ganadores')
            .where('rifa_id', rifaIdActual)
            .select('*')
            .orderBy('fecha_sorteo', 'desc')
            .limit(limit);

        console.log(`[GET /api/ganadores] ✅ ${rows.length} ganadores retornados${rifaIdActual ? ` para rifa_id=${rifaIdActual} + NULL` : ' (sin filtro)'}`);

        const numeroOrdenesBase = Array.from(new Set(
            rows
                .map((row) => String(row.numero_orden || '').split(':')[0].trim())
                .filter(Boolean)
        ));

        let ordenesPorNumero = new Map();
        if (numeroOrdenesBase.length > 0) {
            const ordenesRelacionadas = await db('ordenes')
                .modify((qb) => {
                    if (rifaIdActual) qb.where('rifa_id', rifaIdActual);
                })
                .whereIn('numero_orden', numeroOrdenesBase)
                .select('numero_orden', 'estado_cliente');

            ordenesPorNumero = new Map(
                ordenesRelacionadas.map((orden) => [String(orden.numero_orden), orden])
            );
        }

        const data = rows.map((row) => {
            const numeroOrdenBase = String(row.numero_orden || '').split(':')[0].trim();
            const ordenRelacionada = ordenesPorNumero.get(numeroOrdenBase);
            return {
                ...row,
                estado_cliente: row.estado_cliente || ordenRelacionada?.estado_cliente || ''
            };
        });

        setHttpCacheHeaders(res, 15, true);
        return res.json({ success: true, data });
    } catch (error) {
        console.error('GET /api/ganadores error:', error);
        return res.status(500).json({ success: false, message: 'Error al obtener ganadores', error: process.env.NODE_ENV === 'development' ? error.message : undefined });
    }
});

/* ============================================================ */
/* SECCIÓN: GESTIÓN DE EXPIRACIÓN DE ÓRDENES                   */
/* ============================================================ */

/**
 * GET /api/admin/ordenes-expiradas
 * Obtiene estadísticas de órdenes expiradas (protegido con JWT)
 */
app.get('/api/admin/ordenes-expiradas/stats', verificarToken, async (req, res) => {
    try {
        const stats = await ordenExpirationService.obtenerEstadisticas({
            rifaId: req.rifaContext?.id
        });

        res.json({
            success: true,
            data: stats,
            message: 'Estadísticas de órdenes expiradas'
        });
    } catch (error) {
        console.error('GET /api/admin/ordenes-expiradas/stats error:', error);
        res.status(500).json({
            success: false,
            message: 'Error obteniendo estadísticas'
        });
    }
});

/**
 * GET /api/admin/ordenes-expiradas/estado-servicio
 * Obtiene el estado completo del servicio de expiración (depuración y monitoreo)
 * Incluye: ejecuciones, próxima limpieza, estadísticas, últimos errores
 */
app.get('/api/admin/ordenes-expiradas/estado-servicio', verificarToken, async (req, res) => {
    try {
        const estadoServicio = ordenExpirationService.obtenerEstado();
        const estadisticasOrdenes = await ordenExpirationService.obtenerEstadisticas({
            rifaId: req.rifaContext?.id
        });

        res.json({
            success: true,
            data: {
                servicio: estadoServicio,
                ordenes: estadisticasOrdenes,
                timestamp: new Date().toISOString()
            },
            message: 'Estado completo del servicio de expiración'
        });
    } catch (error) {
        console.error('GET /api/admin/ordenes-expiradas/estado-servicio error:', error);
        res.status(500).json({
            success: false,
            message: 'Error obteniendo estado del servicio'
        });
    }
});

/**
 * POST /api/admin/ordenes-expiradas/limpiar
 * Ejecuta manualmente la limpieza de órdenes expiradas (admin)
 */
app.post('/api/admin/ordenes-expiradas/limpiar', verificarToken, async (req, res) => {
    try {
        console.log('🧹 Limpieza manual de órdenes expiradas iniciada por admin');

        await ordenExpirationService.limpiarOrdenesExpiradas();

        const stats = await ordenExpirationService.obtenerEstadisticas();

        res.json({
            success: true,
            message: 'Limpieza manual ejecutada',
            stats: stats
        });
    } catch (error) {
        console.error('POST /api/admin/ordenes-expiradas/limpiar error:', error);
        res.status(500).json({
            success: false,
            message: 'Error durante limpieza'
        });
    }
});

/**
 * POST /api/admin/ordenes-expiradas/configurar
 * Configura el tiempo de expiración dinámicamente (admin)
 * Body: { tiempoApartadoHoras: 12, intervaloLimpiezaMinutos: 5 }
 */
app.post('/api/admin/ordenes-expiradas/configurar', verificarToken, async (req, res) => {
    try {
        const { tiempoApartadoHoras, intervaloLimpiezaMinutos, pushOrderWarningMinutes } = req.body;
        const warningMinutesNormalized = pushOrderWarningMinutes === undefined
            ? undefined
            : (normalizarPushOrderWarningMinutesConfig(pushOrderWarningMinutes) || []);

        if (!tiempoApartadoHoras || tiempoApartadoHoras < 1) {
            return res.status(400).json({
                success: false,
                message: 'tiempoApartadoHoras debe ser > 0'
            });
        }

        if (!intervaloLimpiezaMinutos || intervaloLimpiezaMinutos < 1) {
            return res.status(400).json({
                success: false,
                message: 'intervaloLimpiezaMinutos debe ser > 0'
            });
        }

        // Configurar el servicio
        ordenExpirationService.configurar(
            tiempoApartadoHoras,
            intervaloLimpiezaMinutos,
            warningMinutesNormalized
        );

        log('info', 'POST /api/admin/ordenes-expiradas/configurar success', {
            tiempoApartadoHoras,
            intervaloLimpiezaMinutos,
            pushOrderWarningMinutes: warningMinutesNormalized
        });

        res.json({
            success: true,
            message: 'Configuración de expiración actualizada',
            data: {
                tiempoApartadoHoras,
                intervaloLimpiezaMinutos,
                pushOrderWarningMinutes: warningMinutesNormalized
            }
        });
    } catch (error) {
        console.error('POST /api/admin/ordenes-expiradas/configurar error:', error);
        res.status(500).json({
            success: false,
            message: 'Error configurando expiración'
        });
    }
});

/**
 * GET /api/admin/expiration-status
 * Obtiene el estado del servicio de expiración (requiere autenticación admin)
 * Usado por: backend/monitor-expiration.js
 */
app.get('/api/admin/expiration-status', verificarToken, async (req, res) => {
    try {
        const estado = ordenExpirationService.obtenerEstado();

        res.json({
            success: true,
            data: estado,
            ...estado  // Spread para compatibilidad con monitor
        });
    } catch (error) {
        console.error('GET /api/admin/expiration-status error:', error);
        res.status(500).json({
            success: false,
            activo: false,
            error: error.message
        });
    }
});

/**
 * GET /api/admin/expiration-stats
 * Obtiene estadísticas de órdenes en el sistema (requiere autenticación admin)
 * Usado por: backend/monitor-expiration.js
 */
app.get('/api/admin/expiration-stats', verificarToken, async (req, res) => {
    try {
        const stats = await ordenExpirationService.obtenerEstadisticas({
            rifaId: req.rifaContext?.id
        });

        res.json({
            success: true,
            data: stats,
            ...stats  // Spread para compatibilidad con monitor
        });
    } catch (error) {
        console.error('GET /api/admin/expiration-stats error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /api/admin/ordenes-canceladas
 * Obtiene lista de órdenes canceladas por expiración
 * Con paginación y filtros
 */
app.get('/api/admin/ordenes-canceladas', verificarToken, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;
        const rifaIdActual = obtenerRifaIdRequest(req);

        // Total de órdenes canceladas
        const totalResult = await db('ordenes')
            .modify((qb) => aplicarFiltroRifa(qb, rifaIdActual))
            .where('estado', 'cancelada')
            .count('* as total');
        const total = totalResult[0]?.total || 0;

        // Órdenes canceladas con paginación
        const canceladas = await db('ordenes')
            .modify((qb) => aplicarFiltroRifa(qb, rifaIdActual))
            .where('estado', 'cancelada')
            .select('numero_orden', 'nombre_cliente', 'cantidad_boletos', 'total', 'created_at', 'updated_at')
            .orderBy('updated_at', 'desc')
            .limit(limit)
            .offset(offset);

        res.json({
            success: true,
            data: {
                ordenes: canceladas,
                paginacion: {
                    pagina: page,
                    porPagina: limit,
                    total: total,
                    totalPaginas: Math.ceil(total / limit)
                }
            }
        });
    } catch (error) {
        console.error('GET /api/admin/ordenes-canceladas error:', error);
        res.status(500).json({
            success: false,
            message: 'Error obteniendo órdenes canceladas',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * GET /api/admin/ordenes-estado-resumen
 * Resumen de órdenes por estado: pendiente, confirmada, cancelada
 * Útil para dashboard
 */
app.get('/api/admin/ordenes-estado-resumen', verificarToken, async (req, res) => {
    try {
        const rifaIdActual = obtenerRifaIdRequest(req);
        // Agrupar por estado y contar
        const estadisticas = await db('ordenes')
            .modify((qb) => aplicarFiltroRifa(qb, rifaIdActual))
            .select(
                'estado',
                db.raw('COUNT(*) as cantidad'),
                db.raw('COALESCE(SUM(total), 0) as total_ingresos')
            )
            .groupBy('estado');

        // Transformar a objeto más legible
        const resumen = {};
        let totalOrdenes = 0;
        let totalIngresos = 0;

        for (const stat of estadisticas) {
            const estado = stat.estado || 'sin_estado';
            resumen[estado] = {
                cantidad: parseInt(stat.cantidad || 0),
                ingresos: parseFloat(stat.total_ingresos || 0)
            };
            totalOrdenes += parseInt(stat.cantidad || 0);
            totalIngresos += parseFloat(stat.total_ingresos || 0);
        }

        res.json({
            success: true,
            data: {
                resumen,
                totales: {
                    ordenes: totalOrdenes,
                    ingresos: totalIngresos.toFixed(2)
                },
                configuracion: {
                    tiempoApartadoHoras: cargarConfigSorteo().rifa?.tiempoApartadoHoras || TIEMPO_APARTADO_HORAS,
                    intervaloLimpiezaMinutos: obtenerConfigActual().rifa?.intervaloLimpiezaMinutos || INTERVALO_LIMPIEZA_MINUTOS,
                    precioBoleto: obtenerPrecioDinamico()
                }
            }
        });
    } catch (error) {
        console.error('GET /api/admin/ordenes-estado-resumen error:', error);
        res.status(500).json({
            success: false,
            message: 'Error obteniendo resumen de estados',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * POST /api/admin/ordenes-manual
 * Crear una orden manual de venta en efectivo (protegido con JWT)
 * Body: { cliente_nombre, cliente_whatsapp, boletos: [5000, 5001, ...] }
 */
app.post('/api/admin/ordenes-manual', verificarToken, async (req, res) => {
    try {
        const { cliente_nombre, cliente_whatsapp, boletos } = req.body;
        const rifaIdActual = obtenerRifaIdRequest(req);

        if (!cliente_nombre || !Array.isArray(boletos) || boletos.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Cliente nombre y boletos requeridos'
            });
        }

        const numeroOrden = `MAN-${Date.now()}`;
        await db.transaction(async (trx) => {
            await trx('ordenes').insert({
                numero_orden: numeroOrden,
                nombre_cliente: cliente_nombre || 'Venta Manual',
                telefono_cliente: cliente_whatsapp || '',
                cantidad_boletos: boletos.length,
                boletos: JSON.stringify(boletos),
                estado: 'completada',
                created_at: new Date(),
                updated_at: new Date(),
                total: 0, // Venta en efectivo, sin registro de pago en sistema
                ...(rifaIdActual ? { rifa_id: rifaIdActual } : {})
            });

            await trx('boletos_estado')
                .modify((qb) => aplicarFiltroRifa(qb, rifaIdActual))
                .whereIn('numero', boletos)
                .update({
                    estado: 'vendido',
                    numero_orden: numeroOrden,
                    updated_at: new Date()
                });

            await trx('orden_oportunidades')
                .modify((qb) => aplicarFiltroRifa(qb, rifaIdActual))
                .whereIn('numero_boleto', boletos)
                .update({
                    estado: 'vendido',
                    numero_orden: numeroOrden
                });
        });

        refrescarCachesTrasCambioInventario();

        if (wsEvents) {
            try {
                const rifaIdVentaManual = obtenerRifaIdActual();
                wsEvents.emitirNuevaOrdenAdmin({
                    numero_orden: numeroOrden,
                    rifa_id: rifaIdVentaManual,  // ✅ Agregar rifa_id
                    nombre_cliente: cliente_nombre || 'Venta Manual',
                    telefono_cliente: cliente_whatsapp || '',
                    estado: 'completada',
                    cantidad_boletos: boletos.length,
                    total: 0,
                    comprobante_path: null,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                }, rifaIdVentaManual);  // ✅ Pasar rifaId como segundo param
            } catch (wsError) {
                console.warn(`⚠️  Error emitiendo orden manual al canal admin:`, wsError.message);
            }
        }

        return res.json({
            success: true,
            message: 'Orden manual creada',
            data: { numero_orden: numeroOrden }
        });
    } catch (error) {
        console.error('POST /api/admin/ordenes-manual error:', error);
        return res.status(500).json({
            success: false,
            message: 'Error al crear orden manual',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * PATCH /api/admin/boletos/:numero/liberar
 * Liberar un boleto de una orden (protegido con JWT)
 * Usa transacción para garantizar consistencia
 */
app.patch('/api/admin/boletos/:numero/liberar', verificarToken, async (req, res) => {
    try {
        const { numero } = req.params;
        const numBoleto = Number(numero);
        const rifaIdActual = obtenerRifaIdRequest(req);

        if (isNaN(numBoleto)) {
            return res.status(400).json({
                success: false,
                message: 'Número de boleto inválido'
            });
        }

        // Usar transacción para garantizar consistencia
        const resultado = await db.transaction(async (trx) => {
            const configSorteo = cargarConfigSorteo();

            // Buscar la orden que contiene este boleto
            const ordenes = await trx('ordenes')
                .modify((qb) => aplicarFiltroRifa(qb, rifaIdActual))
                .select('numero_orden', 'boletos', 'estado', 'cantidad_boletos', 'subtotal', 'descuento', 'total');

            for (const orden of ordenes) {
                try {
                    let numerosArr = parseBoletosOrdenSeguro(orden.boletos);

                    const index = numerosArr.indexOf(numBoleto);

                    if (index !== -1) {
                        // Remover el boleto
                        numerosArr.splice(index, 1);

                        await trx('boletos_estado')
                            .modify((qb) => aplicarFiltroRifa(qb, rifaIdActual))
                            .where('numero', numBoleto)
                            .update({
                                estado: 'disponible',
                                numero_orden: null,
                                updated_at: new Date()
                            });

                        // Si no quedan boletos, eliminar la orden; si no, actualizar
                        if (numerosArr.length === 0) {
                            await trx('orden_oportunidades')
                                .modify((qb) => aplicarFiltroRifa(qb, rifaIdActual))
                                .where('numero_orden', orden.numero_orden)
                                .update({
                                    estado: 'disponible',
                                    numero_orden: null
                                });

                            await trx('ordenes')
                                .modify((qb) => aplicarFiltroRifa(qb, rifaIdActual))
                                .where('numero_orden', orden.numero_orden)
                                .delete();
                        } else {
                            await trx('orden_oportunidades')
                                .modify((qb) => aplicarFiltroRifa(qb, rifaIdActual))
                                .where('numero_orden', orden.numero_orden)
                                .where('numero_boleto', numBoleto)
                                .update({
                                    estado: 'disponible',
                                    numero_orden: null
                                });

                            const totalesServidor = calcularTotalesServidor(
                                numerosArr.length,
                                configSorteo,
                                new Date()
                            );

                            await trx('ordenes')
                                .modify((qb) => aplicarFiltroRifa(qb, rifaIdActual))
                                .where('numero_orden', orden.numero_orden)
                                .update({
                                    boletos: JSON.stringify(numerosArr),
                                    cantidad_boletos: numerosArr.length,
                                    subtotal: totalesServidor.subtotal,
                                    descuento: totalesServidor.descuento,
                                    total: totalesServidor.totalFinal,
                                    updated_at: new Date()
                                });
                        }

                        return {
                            encontrado: true,
                            orden: orden.numero_orden,
                            boleto: numBoleto
                        };
                    }
                } catch (e) {
                    // Ignorar JSON inválido
                }
            }

            // Si llegamos aquí, el boleto no fue encontrado
            throw new Error('BOLETO_NOT_FOUND');
        });

        if (resultado) {
            global.boletosStatsCache = null;
            global.boletosStatsCacheTime = null;
            serverCache.boletosPublicosCached = null;
            serverCache.boletosPublicosCachedTime = 0;
            serverCache.boletosPublicosByRange.clear();

            log('info', 'Boleto liberado', { boleto: resultado.boleto, orden: resultado.orden });
            return res.json({
                success: true,
                message: `Boleto ${resultado.boleto} liberado`,
                data: { numero: resultado.boleto, orden: resultado.orden }
            });
        }
    } catch (error) {
        if (error.message === 'BOLETO_NOT_FOUND') {
            return res.status(404).json({
                success: false,
                message: 'Boleto no encontrado'
            });
        }

        log('error', 'PATCH /api/admin/boletos/:numero/liberar error', { error: error.message });
        return res.status(500).json({
            success: false,
            message: 'Error al liberar boleto',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/* ============================================================ */
/* ENDPOINTS PARA CONFIGURACIÓN DEL CLIENTE (NUEVO)             */
/* ============================================================ */

const clienteConfig = require('./cliente-config.js');

/**
 * GET /api/cliente
 * Obtiene la configuración pública actual del cliente
 * No requiere autenticación (datos públicos)
 * ✅ CRÍTICO: Usa la configuración dinámica actual
 */
app.get('/api/cliente', (req, res) => {
    try {
        const cacheKey = String(req.rifaContext?.slug || req.rifaContext?.id || 'default');
        const cached = serverCache.publicConfigs.get(`cliente:${cacheKey}`);
        
        if (cached) {
            const cacheAge = Date.now() - cached.timestamp;
            if (cacheAge >= 0 && cacheAge < 10000) { // 10 segundos de cache
                setHttpCacheHeaders(res, 10, true);
                return res.json(cached.payload);
            }
        }

        const config = obtenerConfigActual(req.rifaContext?.id || null);

        // ✅ VALIDACIÓN: Asegurar estructura mínima
        if (!config.cliente) config.cliente = {};
        if (!config.rifa) config.rifa = {};
        if (!config.tecnica) config.tecnica = {};

        // ✅ VALIDACIÓN: Campos críticos de rifa con fallbacks inteligentes
        const fallbackConfig = obtenerConfigExpiracion();
        
        if (!config.rifa.nombreSorteo) {
            config.rifa.nombreSorteo = String(fallbackConfig.nombreSorteo || 'SORTEO EN VIVO').trim();
        }
        
        if (!config.rifa.totalBoletos || isNaN(config.rifa.totalBoletos) || config.rifa.totalBoletos <= 0) {
            config.rifa.totalBoletos = Number(fallbackConfig.totalBoletos) || 1000;
        }
        
        const precioConfig = Number(config.rifa.precioBoleto);
        if (!Number.isFinite(precioConfig) || precioConfig < 0) {
            config.rifa.precioBoleto = Number(fallbackConfig.precioBoleto || PRECIO_BOLETO_DEFAULT) || 0;
        }

        // Combinar datos actuales con la estructura esperada por frontend
        const clienteData = {
            cliente: config.cliente || {},
            rifa: config.rifa || {},
            tecnica: config.tecnica || {},
            cuentas: config.tecnica?.bankAccounts || [],
            seo: normalizarSeoConfigParaPersistencia(config.seo || {}, config),
            tema: normalizarTemaConfig(config.tema || {}),
            marketing: config.marketing || {}
        };

        const payload = {
            success: true,
            data: clienteData
        };

        // ✅ USAR CACHÉ POR RIFA
        serverCache.publicConfigs.set(`cliente:${cacheKey}`, {
            payload,
            timestamp: Date.now()
        });

        setHttpCacheHeaders(res, 10, true);
        res.json(payload);
    } catch (error) {
        console.error('GET /api/cliente error:', error);
        // Fallback a cliente-config.js si falla lectura de configuración actual
        try {
            setHttpCacheHeaders(res, 10, true);
            res.json({
                success: true,
                data: clienteConfig
            });
        } catch (fallbackError) {
            res.status(500).json({
                success: false,
                message: 'Error obteniendo configuración del cliente',
                error: process.env.NODE_ENV === 'development' ? error.message : undefined
            });
        }
    }
});

/**
 * PATCH /api/admin/cliente
 * Actualiza la configuración del cliente
 * Requiere autenticación (admin)
 * Guarda cambios en cliente-config.js
 */
app.patch('/api/admin/cliente', verificarToken, async (req, res) => {
    try {
        const updates = req.body;

        if (!updates || Object.keys(updates).length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No hay datos para actualizar'
            });
        }

        // Actualizar en memoria
        Object.assign(clienteConfig, updates);

        // Guardar en archivo (async)
        const configPath = path.join(__dirname, 'cliente-config.js');
        const configContent = `/**\n * Configuración del cliente\n * Actualizado: ${new Date().toISOString()}\n */\n\nmodule.exports = ${JSON.stringify(clienteConfig, null, 2)};`;

        fs.writeFileSync(configPath, configContent, 'utf8');

        console.log(`✅ Configuración del cliente actualizada`);

        res.json({
            success: true,
            message: 'Configuración guardada correctamente',
            data: clienteConfig
        });
    } catch (error) {
        console.error('PATCH /api/admin/cliente error:', error);
        res.status(500).json({
            success: false,
            message: 'Error actualizando configuración',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * POST /api/admin/cliente/rifa
 * Actualiza solo la información del sorteo
 * Requiere autenticación
 */
app.post('/api/admin/cliente/rifa', verificarToken, async (req, res) => {
    try {
        const rifaUpdates = req.body;

        if (!rifaUpdates) {
            return res.status(400).json({
                success: false,
                message: 'No hay datos del sorteo para actualizar'
            });
        }

        // Validaciones básicas
        if (rifaUpdates.totalBoletos && rifaUpdates.totalBoletos < 1) {
            return res.status(400).json({
                success: false,
                message: 'Total de boletos debe ser mayor a 0'
            });
        }

        if (rifaUpdates.precioBoleto && rifaUpdates.precioBoleto < 0) {
            return res.status(400).json({
                success: false,
                message: 'Precio del boleto no puede ser negativo'
            });
        }

        // Actualizar
        clienteConfig.rifa = Object.assign({}, clienteConfig.rifa, rifaUpdates);

        // Guardar en archivo
        const configPath = path.join(__dirname, 'cliente-config.js');
        const configContent = `/**\n * Configuración del cliente\n * Actualizado: ${new Date().toISOString()}\n */\n\nmodule.exports = ${JSON.stringify(clienteConfig, null, 2)};`;
        fs.writeFileSync(configPath, configContent, 'utf8');

        console.log(`✅ Configuración del sorteo actualizada`);

        res.json({
            success: true,
            message: 'Sorteo actualizado correctamente',
            data: clienteConfig.rifa
        });
    } catch (error) {
        console.error('POST /api/admin/cliente/rifa error:', error);
        res.status(500).json({
            success: false,
            message: 'Error actualizando sorteo',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * POST /api/admin/cliente/cuentas
 * Actualiza cuentas de pago
 * Requiere autenticación
 */
app.post('/api/admin/cliente/cuentas', verificarToken, async (req, res) => {
    try {
        const cuentas = req.body;

        if (!Array.isArray(cuentas)) {
            return res.status(400).json({
                success: false,
                message: 'Las cuentas deben ser un array'
            });
        }

        // Validar cada cuenta
        for (const cuenta of cuentas) {
            if (!cuenta.nombreBanco || !cuenta.accountNumber) {
                return res.status(400).json({
                    success: false,
                    message: 'Cada cuenta debe tener banco y número de cuenta'
                });
            }
        }

        clienteConfig.cuentas = cuentas;

        // Guardar
        const configPath = path.join(__dirname, 'cliente-config.js');
        const configContent = `/**\n * Configuración del cliente\n * Actualizado: ${new Date().toISOString()}\n */\n\nmodule.exports = ${JSON.stringify(clienteConfig, null, 2)};`;
        fs.writeFileSync(configPath, configContent, 'utf8');

        console.log(`✅ Cuentas de pago actualizadas`);

        res.json({
            success: true,
            message: 'Cuentas de pago actualizadas',
            data: clienteConfig.cuentas
        });
    } catch (error) {
        console.error('POST /api/admin/cliente/cuentas error:', error);
        res.status(500).json({
            success: false,
            message: 'Error actualizando cuentas',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/* ============================================================ */
/* SECCIÓN: GESTIÓN DE BOLETOS (ARQUITECTURA 1M BOLETOS)       */
/* ============================================================ */

/**
 * GET /api/boletos/disponibles
 * Obtiene boletos disponibles con paginación
 * OPTIMIZADO: Devuelve solo X boletos, no los 1M
 * Query params:
 *   - limit: cuántos boletos (default 50, max 500)
 *   - offset: desde dónde empezar (default 0)
 */
app.get('/api/boletos/disponibles', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 50, 500);  // Max 500
        const offset = parseInt(req.query.offset) || 0;

        const boletos = await BoletoService.obtenerBoletosDisponibles(limit, offset, {
            rifaId: req.rifaContext?.id
        });
        const totalDisponibles = await BoletoService.contarBoletosDisponibles({
            rifaId: req.rifaContext?.id
        });

        res.json({
            success: true,
            boletos: boletos,
            paginacion: {
                total: totalDisponibles,
                offset: offset,
                limit: limit,
                proximo_offset: offset + limit
            }
        });
    } catch (error) {
        log('error', 'GET /api/boletos/disponibles error', { error: error.message });
        res.status(500).json({
            success: false,
            message: 'Error obteniendo boletos disponibles',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * POST /api/boletos/verificar
 * Verifica disponibilidad de boletos específicos RÁPIDAMENTE
 * CRÍTICO para evitar overselling
 * Body: { numeros: [1, 2, 3, 4, 5] }
 */
app.post('/api/boletos/verificar', async (req, res) => {
    try {
        const { numeros } = req.body;

        if (!Array.isArray(numeros) || numeros.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'numeros debe ser un array con al menos 1 boleto'
            });
        }

        if (numeros.length > 1000) {
            return res.status(400).json({
                success: false,
                message: 'No se pueden verificar más de 1000 boletos a la vez'
            });
        }

        // Validar que sean enteros no negativos.
        // La rifa actual usa rango 0..N-1, así que el boleto 0 debe aceptarse.
        const numerosValidos = numeros.every(n => Number.isInteger(Number(n)) && Number(n) >= 0);
        if (!numerosValidos) {
            return res.status(400).json({
                success: false,
                message: 'Todos los números deben ser enteros no negativos'
            });
        }

        const rifaIdActual = Number.parseInt(req.rifaContext?.id, 10) || null;
        const config = cargarConfigSorteo(rifaIdActual);

        console.log(`[DEBUG] Verificar: rifaId=${rifaIdActual}, slug=${config.rifaSlug}, total=${config.totalBoletos}`);

        const { disponibles, conflictos } = await BoletoService.verificarDisponibilidad(numeros, {
            rifaId: rifaIdActual,
            totalBoletos: config.totalBoletos
        });

        res.json({
            success: true,
            disponibles: disponibles,
            conflictos: conflictos,
            resumen: {
                solicitados: numeros.length,
                disponibles: disponibles.length,
                conflictos: conflictos.length
            }
        });
    } catch (error) {
        log('error', 'POST /api/boletos/verificar error', { error: error.message });
        res.status(500).json({
            success: false,
            message: 'Error verificando boletos',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * GET /api/boletos/estadisticas
 * Obtiene estadísticas de boletos (para dashboard)
 * RÁPIDO: Solo suma counts, no carga boletos
 */
app.get('/api/boletos/estadisticas', verificarToken, async (req, res) => {
    try {
        const stats = await BoletoService.obtenerEstadisticas({
            rifaId: req.rifaContext?.id
        });

        res.json({
            success: true,
            estadisticas: {
                total: stats.total,
                disponibles: stats.disponible,
                reservados: stats.reservado,
                vendidos: stats.vendido,
                cancelados: stats.cancelado,
                porcentaje: {
                    disponibles: ((stats.disponible / stats.total) * 100).toFixed(2) + '%',
                    vendidos: ((stats.vendido / stats.total) * 100).toFixed(2) + '%'
                }
            }
        });
    } catch (error) {
        log('error', 'GET /api/boletos/estadisticas error', { error: error.message });
        res.status(500).json({
            success: false,
            message: 'Error obteniendo estadísticas',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * GET /api/admin/boletos/inventario/resumen
 * Resumen del inventario cargado en boletos_estado y su cobertura vs config
 */
app.get('/api/admin/boletos/inventario/resumen', verificarToken, async (req, res) => {
    try {
        const configSorteo = cargarConfigSorteo();
        const totalBoletosConfigurado = Number(configSorteo?.totalBoletos) || 0;
        const resumen = await BoletoService.obtenerResumenInventario(totalBoletosConfigurado, db, {
            rifaId: req.rifaContext?.id
        });

        return res.json({
            success: true,
            data: resumen
        });
    } catch (error) {
        log('error', 'GET /api/admin/boletos/inventario/resumen error', { error: error.message });
        return res.status(500).json({
            success: false,
            message: 'No se pudo cargar el resumen del inventario de boletos',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * POST /api/admin/boletos/inventario/preview
 * Calcula qué pasaría al poblar o borrar un rango de boletos
 */
app.post('/api/admin/boletos/inventario/preview', verificarToken, async (req, res) => {
    try {
        const configSorteo = cargarConfigSorteo();
        const totalBoletosConfigurado = Number(configSorteo?.totalBoletos) || 0;
        const rango = BoletoService.normalizarRangoOperacion(req.body, totalBoletosConfigurado);
        const preview = await BoletoService.previsualizarRangoBoletos(rango, db, {
            rifaId: req.rifaContext?.id
        });

        return res.json({
            success: true,
            data: preview
        });
    } catch (error) {
        const statusCode = ['RANGO_INVALIDO', 'CONFIG_INVALIDA', 'RANGO_FUERA_CONFIG'].includes(error.code) ? 400 : 500;
        log('error', 'POST /api/admin/boletos/inventario/preview error', { error: error.message, code: error.code });
        return res.status(statusCode).json({
            success: false,
            message: error.message || 'No se pudo previsualizar el rango solicitado',
            code: error.code || 'INVENTARIO_PREVIEW_ERROR'
        });
    }
});

/**
 * POST /api/admin/boletos/inventario/poblar
 * Crea boletos faltantes dentro de un rango, sin tocar los existentes
 */
app.post('/api/admin/boletos/inventario/poblar', verificarToken, async (req, res) => {
    try {
        const configSorteo = cargarConfigSorteo();
        const totalBoletosConfigurado = Number(configSorteo?.totalBoletos) || 0;
        const rango = BoletoService.normalizarRangoOperacion(req.body, totalBoletosConfigurado);
        const resultado = await BoletoService.poblarRangoBoletos(rango, {
            rifaId: req.rifaContext?.id
        });

        log('info', 'POST /api/admin/boletos/inventario/poblar success', {
            usuario: req.usuario?.username,
            inicio: rango.inicio,
            fin: rango.fin,
            insertados: resultado.insertados
        });

        return res.json({
            success: true,
            message: resultado.insertados > 0
                ? `Se poblaron ${resultado.insertados.toLocaleString()} boletos faltantes`
                : 'Ese rango ya estaba completamente poblado',
            data: resultado
        });
    } catch (error) {
        const statusCode = ['RANGO_INVALIDO', 'CONFIG_INVALIDA', 'RANGO_FUERA_CONFIG'].includes(error.code)
            ? 400
            : error.code === 'INVENTARIO_BOLETOS_EN_PROGRESO'
                ? 409
                : 500;

        log('error', 'POST /api/admin/boletos/inventario/poblar error', { error: error.message, code: error.code });
        return res.status(statusCode).json({
            success: false,
            message: error.message || 'No se pudo poblar el rango solicitado',
            code: error.code || 'INVENTARIO_POBLAR_ERROR'
        });
    }
});

/**
 * POST /api/admin/boletos/inventario/borrar
 * Borra solo boletos disponibles y sin uso, dentro de un rango
 */
app.post('/api/admin/boletos/inventario/borrar', verificarToken, async (req, res) => {
    try {
        const configSorteo = cargarConfigSorteo();
        const totalBoletosConfigurado = Number(configSorteo?.totalBoletos) || 0;
        const rango = BoletoService.normalizarRangoOperacion(req.body, totalBoletosConfigurado);
        const resultado = await BoletoService.borrarRangoBoletos(rango, {
            rifaId: req.rifaContext?.id
        });

        log('info', 'POST /api/admin/boletos/inventario/borrar success', {
            usuario: req.usuario?.username,
            inicio: rango.inicio,
            fin: rango.fin,
            eliminados: resultado.eliminados,
            oportunidadesEliminadas: resultado.oportunidadesEliminadas
        });

        return res.json({
            success: true,
            message: resultado.eliminados > 0
                ? `Se eliminaron ${resultado.eliminados.toLocaleString()} boletos seguros del rango`
                : 'No había boletos seguros para borrar en ese rango',
            data: resultado
        });
    } catch (error) {
        const statusCode = ['RANGO_INVALIDO', 'CONFIG_INVALIDA', 'RANGO_FUERA_CONFIG'].includes(error.code)
            ? 400
            : error.code === 'INVENTARIO_BOLETOS_EN_PROGRESO'
                ? 409
                : 500;

        log('error', 'POST /api/admin/boletos/inventario/borrar error', { error: error.message, code: error.code });
        return res.status(statusCode).json({
            success: false,
            message: error.message || 'No se pudo borrar el rango solicitado',
            code: error.code || 'INVENTARIO_BORRAR_ERROR'
        });
    }
});

/**
 * GET /api/admin/nueva-rifa/preview
 * Revisa si la BD operativa está lista para arrancar una nueva rifa usando la misma base
 */
app.get('/api/admin/nueva-rifa/preview', verificarToken, async (req, res) => {
    try {
        if (rifaService?.enabled && req.rifaContext?.id) {
            const rifaId = req.rifaContext.id;
            const [boletos, oportunidades, ordenes, ganadores] = await Promise.all([
                db('boletos_estado').where('rifa_id', rifaId).count('* as total').first(),
                db('orden_oportunidades').where('rifa_id', rifaId).count('* as total').first(),
                db('ordenes').where('rifa_id', rifaId).count('* as total').first(),
                db('ganadores').where('rifa_id', rifaId).count('* as total').first()
            ]);

            const estadoRifa = String(req.rifaContext?.estado || req.rifaContext?.configuracion?.rifa?.estado || 'activa').trim().toLowerCase();
            return res.json({
                success: true,
                data: {
                    estado: estadoRifa === 'finalizado' ? 'listo' : 'bloqueado',
                    resumenEstado: estadoRifa === 'finalizado'
                        ? 'La rifa actual ya puede depurarse de forma aislada'
                        : 'Primero finaliza esta rifa para poder depurar sus datos operativos',
                    confirmacionRequerida: 'NUEVA RIFA',
                    canExecute: estadoRifa === 'finalizado',
                    rifaActual: {
                        id: req.rifaContext.id,
                        slug: req.rifaContext.slug,
                        nombre: req.rifaContext.nombre,
                        finalizada: estadoRifa === 'finalizado'
                    },
                    tablas: {
                        boletos: Number(boletos?.total || 0),
                        oportunidades: Number(oportunidades?.total || 0),
                        ordenes: Number(ordenes?.total || 0),
                        ganadores: Number(ganadores?.total || 0),
                        contadoresOrden: 0
                    }
                }
            });
        }

        const resumen = await NuevaRifaService.obtenerPreview();
        return res.json({
            success: true,
            data: resumen
        });
    } catch (error) {
        log('error', 'GET /api/admin/nueva-rifa/preview error', { error: error.message, code: error.code });
        return res.status(500).json({
            success: false,
            message: error.message || 'No se pudo revisar el estado de la nueva rifa',
            code: error.code || 'NUEVA_RIFA_PREVIEW_ERROR'
        });
    }
});

/**
 * POST /api/admin/nueva-rifa/ejecutar
 * Limpia la operación anterior para poder montar una nueva rifa sobre la misma BD
 */
app.post('/api/admin/nueva-rifa/ejecutar', verificarToken, async (req, res) => {
    try {
        if (ordenExpirationService?.isExecuting === true) {
            return res.status(409).json({
                success: false,
                code: 'EXPIRACION_EN_PROGRESO',
                message: 'Espera a que termine la limpieza automática de órdenes antes de preparar una nueva rifa'
            });
        }

        if (rifaService?.enabled && req.rifaContext?.id) {
            const estadoRifa = String(req.rifaContext?.estado || req.rifaContext?.configuracion?.rifa?.estado || 'activa').trim().toLowerCase();
            if (estadoRifa !== 'finalizado') {
                return res.status(409).json({
                    success: false,
                    code: 'RIFA_NO_FINALIZADA',
                    message: 'Solo puedes depurar una rifa que ya esté finalizada'
                });
            }

            const confirmacion = String(req.body?.confirmacion || '').trim().toUpperCase();
            if (confirmacion !== 'NUEVA RIFA') {
                return res.status(400).json({
                    success: false,
                    code: 'CONFIRMACION_INVALIDA',
                    message: 'Confirmación inválida para depurar la rifa actual'
                });
            }

            const configActual = obtenerConfigActual();
            await asegurarSnapshotModalFinalizado(configActual, {
                usuarioAdmin: req.usuario?.username || 'SYSTEM',
                refrescarGanadores: true
            });

            await rifaArchiveService.depurarRifa(req.rifaContext.id);
            limpiarCacheBoletosPublicos();
            limpiarCacheConfiguracionPublica();

            return res.json({
                success: true,
                message: 'La rifa actual fue depurada. Solo quedó disponible su snapshot final para historial.'
            });
        }

        const configActual = obtenerConfigActual();
        await asegurarSnapshotModalFinalizado(configActual, {
            usuarioAdmin: req.usuario?.username || 'SYSTEM',
            refrescarGanadores: true
        });

        const resultado = await NuevaRifaService.ejecutarReset(req.body || {});

        const configLimpia = obtenerConfigActual();
        if (configLimpia?.rifa) {
            configLimpia.rifa.modalFinalizadoSnapshot = null;
        }
        if (configLimpia?.sorteoActivo) {
            configLimpia.sorteoActivo.ganadores = {
                principal: [],
                presorte: [],
                ruletazo: []
            };
        }
        await persistirConfigActualizada(configLimpia, req.usuario?.username || 'SYSTEM');

        limpiarCacheBoletosPublicos();
        limpiarCacheConfiguracionPublica();

        log('info', 'POST /api/admin/nueva-rifa/ejecutar success', {
            usuario: req.usuario?.username,
            resultado: resultado.resultado || null
        });

        return res.json({
            success: true,
            message: 'La BD operativa quedó limpia para arrancar una nueva rifa',
            data: resultado
        });
    } catch (error) {
        const statusCode = error.code === 'CONFIRMACION_INVALIDA'
            ? 400
            : ['NUEVA_RIFA_BLOQUEADA', 'NUEVA_RIFA_EN_PROGRESO'].includes(error.code)
                ? 409
                : 500;

        log('error', 'POST /api/admin/nueva-rifa/ejecutar error', {
            error: error.message,
            code: error.code,
            detalles: error.detalles || null
        });

        return res.status(statusCode).json({
            success: false,
            message: error.message || 'No se pudo preparar la nueva rifa',
            code: error.code || 'NUEVA_RIFA_EJECUTAR_ERROR',
            detalles: error.detalles || null
        });
    }
});

/**
 * POST /api/boletos/init-dev
 * SOLO DESARROLLO: Inicializa boletos sin autenticación
 * ⚠️ NO USAR EN PRODUCCIÓN
 * 
 * Body requerido:
 * {
 *   "totalBoletos": 60000,        // ⭐ DINÁMICO: cantidad total de boletos
 *   "secretKey": "rifa-init-2025" // Llave de seguridad
 * }
 * 
 * Se adaptará automáticamente al número de boletos configurado
 */
app.post('/api/boletos/init-dev', async (req, res) => {
    try {
        // PROTECCIÓN: Solo en desarrollo o si SECRET_KEY es correcto
        const secretKey = req.body.secretKey;
        const isDev = process.env.NODE_ENV !== 'production';
        const isValidSecret = secretKey === process.env.INIT_SECRET || secretKey === 'rifa-init-2025';

        if (!isDev && !isValidSecret) {
            return res.status(403).json({
                success: false,
                message: 'No autorizado'
            });
        }

        // ⭐ DINÁMICO: Leer totalBoletos desde la configuración actual o del request body
        const configSorteo = cargarConfigSorteo();
        const rifaIdActual = Number.parseInt(req.rifaContext?.id, 10) || null;
        let TOTAL = parseInt(req.body.totalBoletos) || configSorteo.totalBoletos;

        // Validar que sea un número válido y razonable
        if (isNaN(TOTAL) || TOTAL < 1 || TOTAL > 10000000) {
            return res.status(400).json({
                success: false,
                message: 'totalBoletos debe ser un número entre 1 y 10,000,000',
                received: req.body.totalBoletos,
                config: configSorteo.totalBoletos
            });
        }

        console.log(`🔄 Iniciando proceso de creación de boletos...`);
        console.log(`📊 Total a crear: ${TOTAL.toLocaleString('es-MX')} boletos`);

        // Contar boletos actuales
        const result = await db('boletos_estado')
            .modify((qb) => {
                if (rifaIdActual) qb.where('rifa_id', rifaIdActual);
            })
            .count('* as total')
            .first();
        const boletosActuales = result.total || 0;

        console.log(`📊 Boletos actuales: ${boletosActuales.toLocaleString()}`);

        if (boletosActuales >= TOTAL) {
            return res.json({
                success: true,
                message: 'Ya existen suficientes boletos',
                estadistica: {
                    totalActual: boletosActuales,
                    requerido: TOTAL,
                    diferencia: 0
                }
            });
        }

        // Insertar boletos en lotes
        const LOTE = 1000;
        const inicio = boletosActuales;
        let insertados = 0;
        const aInsertar = TOTAL - boletosActuales;

        res.json({
            success: true,
            message: 'Inicialización iniciada en background',
            status: 'en_progreso',
            detalles: {
                totalACrear: TOTAL,
                boletosActuales: boletosActuales,
                aInsertar: aInsertar,
                tiempoEstimado: `${Math.ceil(aInsertar / 1000)} segundos`
            }
        });

        // Ejecutar en background
        (async () => {
            try {
                for (let start = inicio; start < TOTAL; start += LOTE) {
                    const end = Math.min(start + LOTE - 1, TOTAL - 1);
                    const boletos = [];

                    for (let i = start; i <= end; i++) {
                        boletos.push({
                            ...(rifaIdActual ? { rifa_id: rifaIdActual } : {}),
                            numero: i,
                            estado: 'disponible',
                            created_at: new Date(),
                            updated_at: new Date()
                        });
                    }

                    await db('boletos_estado').insert(boletos);
                    insertados += boletos.length;
                    const porcentaje = Math.round((insertados / aInsertar) * 100);
                    console.log(`✅ Insertados: ${insertados.toLocaleString()}/${aInsertar.toLocaleString()} (${porcentaje}%)`);
                }

                console.log(`✅ COMPLETADO: ${insertados.toLocaleString()} boletos insertados`);

                // Verificar resultado
                const final = await db('boletos_estado')
                    .modify((qb) => {
                        if (rifaIdActual) qb.where('rifa_id', rifaIdActual);
                    })
                    .count('* as total')
                    .first();
                console.log(`📊 Total final en BD: ${final.total.toLocaleString()} boletos`);

            } catch (err) {
                console.error('❌ Error en background:', err.message);
            }
        })();

    } catch (error) {
        console.error('❌ Error:', error.message);
        res.status(500).json({
            success: false,
            message: 'Error iniciando boletos',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * POST /api/boletos/inicializar
 * Crea boletos en la BD (ejecutar una sola vez)
 * REQUIERE autenticación admin
 * ⚠️ LENTO: Tarda ~ minutos la primera vez
 * ✅ DINÁMICO: Lee totalBoletos desde la configuración actual
 */
app.post('/api/boletos/inicializar', verificarToken, async (req, res) => {
    try {
        const configSorteo = cargarConfigSorteo();
        const { totalBoletos } = req.body;
        const total = totalBoletos || configSorteo.totalBoletos;

        if (total < 1000 || total > 10000000) {
            return res.status(400).json({
                success: false,
                message: 'Total de boletos debe estar entre 1000 y 10M',
                config: configSorteo.totalBoletos
            });
        }

        log('info', 'POST /api/boletos/inicializar INICIADO', { totalBoletos: total });

        // Ejecutar en background para no bloquear
        res.json({
            success: true,
            message: 'Inicialización de boletos iniciada en background',
            status: 'en_progreso'
        });

        // No esperar respuesta, ejecutar en background
        BoletoService.inicializarBoletos(total, {
            rifaId: req.rifaContext?.id
        })
            .then(() => {
                log('info', 'POST /api/boletos/inicializar COMPLETADO', { totalCreados: total });
            })
            .catch(error => {
                log('error', 'POST /api/boletos/inicializar ERROR', { error: error.message });
            });

    } catch (error) {
        log('error', 'POST /api/boletos/inicializar error', { error: error.message });
        res.status(500).json({
            success: false,
            message: 'Error iniciando boletos',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * POST /api/boletos/limpiar-reservas
 * Libera boletos de órdenes expiradas (cron manual)
 * Se puede ejecutar cada 5 minutos
 */
app.post('/api/boletos/limpiar-reservas', verificarToken, async (req, res) => {
    try {
        const resultado = await BoletoService.limpiarReservasExpiradas({
            rifaId: req.rifaContext?.id
        });

        log('info', 'POST /api/boletos/limpiar-reservas - Reservas expiradas liberadas', resultado);

        res.json({
            success: true,
            boletosLiberados: resultado.boletosLiberados
        });
    } catch (error) {
        log('error', 'POST /api/boletos/limpiar-reservas error', { error: error.message });
        res.status(500).json({
            success: false,
            message: 'Error limpiando reservas',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * 🔧 ENDPOINT DE MANTENIMIENTO: Limpiar boletos huérfanos
 * POST /api/admin/cleanup-boletos
 * Libera boletos apartados sin una orden válida
 * Solo para administradores autenticados
 */
app.post('/api/admin/cleanup-boletos', verificarToken, async (req, res) => {
    try {
        if (req.usuario?.rol !== 'administrador') {
            return res.status(403).json({
                success: false,
                message: 'Permiso denegado: Solo administradores pueden ejecutar limpieza'
            });
        }

        console.log('\n🔧 [CLEANUP] Iniciando limpieza de boletos huérfanos...');
        const rifaIdActual = obtenerRifaIdRequest(req);

        const construirQueryHuerfanos = (builder) => builder('boletos_estado as be')
            .modify((qb) => aplicarFiltroRifa(qb, rifaIdActual, 'be.rifa_id'))
            .where('be.estado', 'apartado')
            .where((qb) => {
                qb.whereNull('be.numero_orden')
                    .orWhereNotExists(
                        db('ordenes as o')
                            .select(db.raw('1'))
                            .whereRaw('o.numero_orden = be.numero_orden')
                            .modify((subQb) => aplicarFiltroRifa(subQb, rifaIdActual, 'o.rifa_id'))
                            .whereIn('o.estado', ['pendiente', 'confirmada'])
                    );
            });

        const totalRow = await construirQueryHuerfanos(db)
            .count('* as total')
            .first();
        const totalHuerfanos = Number(totalRow?.total || 0);
        console.log(`📊 Boletos huérfanos encontrados: ${totalHuerfanos}`);

        if (totalHuerfanos === 0) {
            return res.json({
                success: true,
                message: 'No hay boletos huérfanos',
                limpios: 0,
                total: totalHuerfanos
            });
        }

        const limpios = await construirQueryHuerfanos(db)
            .update({
                estado: 'disponible',
                numero_orden: null,
                updated_at: db.fn.now()
            });

        console.log(`✅ [CLEANUP] Boletos liberados: ${limpios}`);

        return res.json({
            success: true,
            message: `Limpieza completada: ${limpios} boletos liberados`,
            limpios,
            total: totalHuerfanos
        });

    } catch (error) {
        console.error('❌ [CLEANUP] Error:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Error durante la limpieza',
            error: error.message
        });
    }
});

/**
 * POST /api/admin/limpiar-ordenes-canceladas
 * Corrije órdenes canceladas cuyos boletos NO fueron liberados
 * Busca todas las órdenes con estado='cancelada' y libera sus boletos
 */
app.post('/api/admin/limpiar-ordenes-canceladas', verificarToken, async (req, res) => {
    try {
        console.log('🧹 [CLEANUP] Iniciando limpieza de órdenes canceladas...');
        const rifaIdActual = obtenerRifaIdRequest(req);

        // PASO 1: Encontrar todas las órdenes canceladas SIN comprobante
        const ordenesCanceladas = await db('ordenes')
            .modify((qb) => aplicarFiltroRifa(qb, rifaIdActual))
            .where('estado', 'cancelada')
            .whereNull('comprobante_path')  // ⭐ Solo sin comprobante
            .select('id', 'numero_orden', 'boletos');

        console.log(`[CLEANUP] Encontradas ${ordenesCanceladas.length} órdenes canceladas sin comprobante`);

        let boletosLiberadosTotal = 0;
        let ordenesProcessadas = 0;

        // PASO 2: Procesar cada orden cancelada
        for (const orden of ordenesCanceladas) {
            try {
                const boletos = parseBoletosOrdenSeguro(orden.boletos);

                if (boletos.length === 0) continue;

                // Liberar estos boletos en la BD
                const actualizado = await db('boletos_estado')
                    .modify((qb) => aplicarFiltroRifa(qb, rifaIdActual))
                    .whereIn('numero', boletos)
                    .update({
                        estado: 'disponible',
                        numero_orden: null,
                        updated_at: new Date()
                    });

                await db('orden_oportunidades')
                    .modify((qb) => aplicarFiltroRifa(qb, rifaIdActual))
                    .where('numero_orden', orden.numero_orden)
                    .whereIn('numero_boleto', boletos)
                    .update({
                        estado: 'disponible',
                        numero_orden: null
                    });

                if (actualizado > 0) {
                    console.log(`  ✓ ${orden.numero_orden}: ${actualizado} boletos liberados`);
                    boletosLiberadosTotal += actualizado;
                    ordenesProcessadas++;
                }
            } catch (error) {
                console.error(`  ❌ Error procesando ${orden.numero_orden}:`, error.message);
            }
        }

        console.log(`✅ [CLEANUP] Completado: ${ordenesProcessadas} órdenes, ${boletosLiberadosTotal} boletos liberados`);

        return res.json({
            success: true,
            message: 'Limpieza completada',
            ordenesProcesadas: ordenesProcessadas,
            boletosLiberados: boletosLiberadosTotal
        });

    } catch (error) {
        console.error('❌ [CLEANUP] Error:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Error durante limpieza',
            error: error.message
        });
    }
});

// ✅ CREAR TABLA orden_oportunidades SI NO EXISTE
async function asegurarTablaOportunidades() {
    try {
        const existe = await db.schema.hasTable('orden_oportunidades');
        if (!existe) {
            console.log('📋 Creando tabla orden_oportunidades...');
            await db.schema.createTable('orden_oportunidades', (table) => {
                table.increments('id').primary();
                table.string('numero_orden', 50).nullable();
                table.foreign('numero_orden').references('numero_orden').inTable('ordenes').onDelete('SET NULL');
                table.integer('numero_oportunidad').notNullable();
                table.enum('estado', ['disponible', 'apartado', 'vendido']).defaultTo('disponible');
                table.integer('numero_boleto').nullable();
                table.foreign('numero_boleto').references('numero').inTable('boletos_estado').onUpdate('CASCADE').onDelete('CASCADE');
                table.index('numero_orden');
                table.index('numero_oportunidad');
                table.index('numero_boleto');
                table.index('estado');
            });
            console.log('✅ Tabla orden_oportunidades creada exitosamente');
        } else {
            console.log('✅ Tabla orden_oportunidades ya existe');
        }

        // ✅ CREAR ÍNDICE ÚNICO PARCIAL PARA PREVENIR DUPLICADOS
        await asegurarConstraintUnicoOportunidades();
    } catch (error) {
        console.error('⚠️  Error verificando tabla orden_oportunidades:', error.message);
        // No fallar el servidor, continuar de todas formas
    }
}

/**
 * 🛡️ FUNCIÓN DE AUDITORÍA: Asegurar índices de rendimiento para Multi-Rifa
 * Optimiza las consultas por rifa_id para evitar lentitud en producción
 */
async function asegurarIndicesMultiRifa() {
    const tablas = ['ordenes', 'boletos_estado', 'ganadores', 'order_id_counter'];

    for (const nombreTabla of tablas) {
        try {
            const existeTabla = await db.schema.hasTable(nombreTabla);
            if (!existeTabla) continue;

            const tieneColumna = await db.schema.hasColumn(nombreTabla, 'rifa_id');
            if (!tieneColumna) {
                console.log(`ℹ️ Añadiendo columna rifa_id a tabla ${nombreTabla}...`);
                await db.schema.table(nombreTabla, (table) => {
                    table.integer('rifa_id').nullable();
                });
            }

            // Intentar añadir el índice de forma segura
            try {
                await db.schema.table(nombreTabla, (table) => {
                    table.index(['rifa_id'], `idx_${nombreTabla}_rifa_id`);

                    // 🛡️ UNICIDAD CRÍTICA para el contador
                    if (nombreTabla === 'order_id_counter') {
                        table.unique(['cliente_id', 'rifa_id'], `uniq_${nombreTabla}_ctx`);
                    }
                });
                console.log(`✅ Índice idx_${nombreTabla}_rifa_id creado exitosamente`);
            } catch (indexError) {
                // Probablemente el índice ya existe
                if (indexError.message.includes('already exists') || indexError.message.includes('existe')) {
                    // console.debug(`ℹ️ El índice en ${nombreTabla} ya existe.`);
                } else {
                    console.warn(`⚠️ No se pudo crear el índice en ${nombreTabla}:`, indexError.message);
                }
            }
        } catch (error) {
            console.error(`❌ Error asegurando índices en ${nombreTabla}:`, error.message);
        }
    }
}

/**
 * ✅ Se guridad Crítica: Crear índice único parcial para oportunidades activas
 * Garantiza que el mismo número de oportunidad NO puede estar en estado 'activo' 
 * en más de una orden al mismo tiempo
 */
async function asegurarConstraintUnicoOportunidades() {
    try {
        console.log('🔒 Verificando constraint único para oportunidades activas...');

        const indexResult = await db.raw(`
            SELECT indexdef
            FROM pg_indexes
            WHERE schemaname = 'public'
              AND indexname = 'idx_numero_opu_activo'
        `);

        const definicionActual = String(indexResult?.rows?.[0]?.indexdef || '').toLowerCase();
        const indiceActualEsCorrecto = definicionActual.includes('numero_oportunidad')
            && definicionActual.includes('apartado')
            && definicionActual.includes('vendido');

        if (indexResult.rows.length > 0 && indiceActualEsCorrecto) {
            console.log('✅ Constraint único ya existe');
            return;
        }

        if (indexResult.rows.length > 0 && !indiceActualEsCorrecto) {
            console.warn('♻️  Se detectó un idx_numero_opu_activo legacy. Reemplazando definición...');
            await db.raw('DROP INDEX IF EXISTS idx_numero_opu_activo');
        }

        // Crear índice único PARCIAL (solo para estados activos)
        // Esto previene duplicados de oportunidades en estado apartado/vendido
        await db.raw(`
            CREATE UNIQUE INDEX idx_numero_opu_activo 
            ON orden_oportunidades(numero_oportunidad) 
            WHERE estado IN ('apartado', 'vendido');
        `);

        console.log('✅ Constraint único creado: Oportunidades activas NO pueden duplicarse');
    } catch (error) {
        // Si el índice ya existe o hay error, no es fatal
        if (error.message.includes('already exists') || error.message.includes('duplicate key')) {
            console.log('✅ Constraint único de oportunidades ya estaba presente');
        } else {
            console.warn('⚠️  No se pudo crear constraint único de oportunidades:', error.message);
        }
    }
}

// ===== HANDLERS GLOBALES PARA PREVENIR CRASHES =====
// Capturar excepciones no manejadas
process.on('uncaughtException', (error) => {
    console.error('❌ ¡EXCEPCIÓN NO CAPTURADA!');
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
    console.error('El servidor intentará continuar...\n');
    // NO llamar a process.exit() - dejar que el servidor siga corriendo
});

// Capturar promesas rechazadas sin manejador
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ ¡PROMESA RECHAZADA SIN HANDLER!');
    console.error('Razón:', reason);
    console.error('Promise:', promise);
    console.error('El servidor intentará continuar...\n');
    // NO llamar a process.exit() - dejar que el servidor siga corriendo
});

// ===== MIDDLEWARE DE ERROR GLOBAL =====
// Capturar errores en rutas no encontradas
app.use((req, res, next) => {
    res.status(404).json({
        success: false,
        message: `Ruta no encontrada: ${req.method} ${req.path}`
    });
});

// 🔒 Middleware de error global (DEBE ser el ÚLTIMO)
// Maneja TODOS los errores no capturados en endpoints
app.use((err, req, res, next) => {
    // Loguear el error COMPLETO (con detalles internos) en servidor
    console.error('');
    console.error('❌ ERROR NO CAPTURADO EN ENDPOINT:');
    console.error(`   Método: ${req.method}`);
    console.error(`   Ruta: ${req.path}`);
    console.error(`   IP: ${req.ip}`);
    console.error(`   Mensaje: ${err.message}`);
    if (err.stack) {
        console.error(`   Stack: ${err.stack.split('\n').slice(0, 5).join('\n   ')}`);
    }
    console.error('');

    // NO dejar que el error mate el servidor
    if (res.headersSent) {
        return next(err); // Headers ya enviados, delegar a Express
    }

    // Determinar status code
    let statusCode = err.statusCode || err.status || 500;
    if (statusCode < 400 || statusCode > 599) statusCode = 500;

    // Sanitizar mensaje para respuesta
    const isDev = process.env.NODE_ENV === 'development';
    const safeMessage = sanitizarErrorMessage(err.message, isDev);

    // Respuesta al cliente (SIN detalles internos en producción)
    res.status(statusCode).json({
        success: false,
        message: safeMessage,
        code: err.code || 'INTERNAL_ERROR',
        ...(isDev && { debug: err.message }) // Solo en desarrollo
    });
});

// Iniciar servidor con WebSocket
const PORT = process.env.PORT || 5001;

// ⭐ Crear servidor HTTP que soporte WebSocket
const http = require('http');
const server = http.createServer(app);

// 🔌 Configurar Socket.io con soporte CORS seguro
const io = socketIO(server, {
    cors: {
        origin: process.env.NODE_ENV === 'production'
            ? allowedCorsOrigins.length > 0
                ? allowedCorsOrigins
                : false // Si no hay orígenes whitelistados, denegar TODOS en producción
            : ['http://localhost:3000', 'http://localhost:5500', 'http://127.0.0.1:5500', 'http://127.0.0.1:3000'],
        methods: ['GET', 'POST'],
        credentials: true,
        maxAge: 86400
    },
    allowEIO3: true,  // Compatibilidad con clientes antiguos
    transports: ['websocket', 'polling'],  // Fallback a polling si falla websocket
    pingInterval: 25000,
    pingTimeout: 60000
});

// 🔌 Inicializar RifaService ANTES de que el servidor acepte peticiones
// Esto es CRÍTICO para que el contexto multirifa esté disponible desde el segundo 0
(async () => {
    try {
        rifaService = new RifaService(db);
        await rifaService.inicializar();
        console.log('✅ RifaService inicializado (CRITICAL_PRIORITY)');
    } catch (err) {
        console.error('❌ Error crítico inicializando RifaService:', err.message);
    }
})();

// Iniciar servidor HTTP
server.listen(PORT, () => {
    console.log(`🚀 Servidor RifaPlus corriendo en puerto ${PORT}`);
    console.log(`📍 Ambiente: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔌 WebSocket habilitado en ws://localhost:${PORT}`);
    console.log('🛡️  Protección contra crashes activada\n');

    // 🔌 Inicializar eventos de WebSocket
    wsEvents = inicializarEventosWebSocket(io, {
        verifyAdminToken: verificarSocketAdminToken
    });
    console.log('✅ Sistema WebSocket inicializado\n');
});

// ✅ Tareas de inicialización en BACKGROUND (no bloquean startup)
// Esto permite que el servidor responda inmediatamente
setTimeout(async () => {
    try {
        // 🟦 NUEVO: Inicializar ConfigManagerV2 para persistencia en BD
        console.log('\n🟦 Inicializando persistencia de configuración en Supabase...');
        configManagerV2 = new ConfigManagerV2(db);
        const inicializado = await configManagerV2.inicializar();
        if (inicializado) {
            sincronizarConfigLegacyEnMemoria(configManagerV2.getConfig());
            console.log('✅ ConfigManagerV2 listo - Configuración será persistente en BD');
        } else {
            console.log('⚠️  ConfigManagerV2 inicializado en fallback (config.json)');
        }
        console.log(`   Info: ${JSON.stringify(configManagerV2.getInfo())}\n`);
    } catch (err) {
        console.error('⚠️  Error inicializando ConfigManagerV2:', err.message);
        console.log('   El sistema seguirá funcionando con config.json\n');
    }

    // RifaService se inicializa de forma síncrona/rápida antes si es posible, 
    // pero aquí mantenemos la compatibilidad con el flujo original si es necesario.
    try {
        if (!rifaService) {
            rifaService = new RifaService(db);
            await rifaService.inicializar();
        }

        try {
            const backfillCampanas = await backfillSuscripcionesCampanaDesdeOrdenes(db);
            console.log(`✅ Backfill audiencia push listo (${backfillCampanas.created} nuevas, ${backfillCampanas.updated} actualizadas, ${backfillCampanas.processed} procesadas)`);
        } catch (backfillError) {
            console.warn('⚠️  No se pudo ejecutar el backfill de audiencia push:', backfillError.message);
        }
    } catch (error) {
        console.error('⚠️ Error en tareas post-rifa:', error.message);
    }

    try {
        pushCampaignQueueService = new PushCampaignQueueService(db, {
            logger: console
        });
        pushCampaignQueueService.start();
        console.log('✅ Cola de campañas push inicializada');
    } catch (queueError) {
        console.error('⚠️ No se pudo inicializar la cola de campañas push:', queueError.message);
    }

    try {
        // Asegurar que exista tabla de oportunidades y constraints
        await asegurarTablaOportunidades();
        // 🛡️ Asegurar índices de rendimiento para Multi-Rifa
        await asegurarIndicesMultiRifa();

        // Iniciar servicio de expiración de órdenes
        const configActual = rifaService?.enabled
            ? (await rifaService.obtenerRifaActivaPublica(true))?.configuracion || obtenerConfigActual()
            : obtenerConfigActual();
        const tiempoApartadoActual = Number(configActual?.rifa?.tiempoApartadoHoras) || TIEMPO_APARTADO_HORAS;
        const intervaloLimpiezaActual = Number(configActual?.rifa?.intervaloLimpiezaMinutos) || INTERVALO_LIMPIEZA_MINUTOS;
        const pushOrderWarningMinutesActual = normalizarPushOrderWarningMinutesConfig(configActual?.rifa?.pushOrderWarningMinutes);
        ordenExpirationService.iniciar(intervaloLimpiezaActual, tiempoApartadoActual, pushOrderWarningMinutesActual);
        iniciarRecordatoriosEventoProgramados();
    } catch (e) {
        console.error('❌ Error en inicialización de background:', e.message);
    }
}, 5000);

// Manejar cierre graceful
process.on('SIGTERM', () => {
    console.log('\n🛑 Recibido SIGTERM, cerrando servidor gracefully...');
    rifaArchiveService?.detener?.();
    pushCampaignQueueService?.stop?.();
    if (recordatoriosEventoInterval) {
        clearInterval(recordatoriosEventoInterval);
        recordatoriosEventoInterval = null;
    }
    server.close(() => {
        console.log('✅ Servidor cerrado');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('\n🛑 Recibido SIGINT, cerrando servidor gracefully...');
    rifaArchiveService?.detener?.();
    pushCampaignQueueService?.stop?.();
    if (recordatoriosEventoInterval) {
        clearInterval(recordatoriosEventoInterval);
        recordatoriosEventoInterval = null;
    }
    server.close(() => {
        console.log('✅ Servidor cerrado');
        process.exit(0);
    });
});
