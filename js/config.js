/**
 * ============================================================
 * ARCHIVO: js/config.js
 * VERSIÓN: 3.1.0 (REFACTORIZADA - Sin Duplicación)
 * 
 * ============================================================
 * ARQUITECTURA DE CONFIGURACIÓN
 * ============================================================
 * 
 * Este archivo es la SEGUNDA LÍNEA DE DEFENSA de configuración.
 * 
 * FUENTE ÚNICA DE VERDAD: /backend/config.json
 * ├─ Contiene: Todos los datos de cliente, rifa, técnica
 * ├─ Se sincroniza automáticamente via config-sync.js (~5 seg)
 * └─ Cambios SIEMPRE deben hacerse en config.json primero
 * 
 * ESTE ARCHIVO (config.js): Sistema de métodos y lógica
 * ├─ NO contiene datos duplicados (sin config innecesaria)
 * ├─ Contiene TODAS las funciones helper y getters dinámicos
 * ├─ Actúa como fallback y sistema de sincronización local
 * ├─ Contiene lógica de cálculos (descuentos, oportunidades)
 * └─ Gestiona localStorage y estado reactivo
 * 
 * FLUJO DE SINCRONIZACIÓN:
 * 1. Página carga: config.js define estructura base (vacía)
 * 2. backend/config.json se sincroniza (~200ms-5seg)
 * 3. config-sync.js popula window.rifaplusConfig con datos reales
 * 4. Todas las funciones aquí usan los datos sincronizados
 * 5. localStorage guarda SOLO datos de usuario (cliente, técnica)
 * 
 * ⚠️  IMPORTANTE:
 * - NO editar valores de DATOS aquí
 * - SOLO editar: funciones, getters, métodos, constantes
 * - Para cambiar datos: edita /backend/config.json
 * - Las funciones aquí asumen que data existe (fallback a vacío)
 * 
 * ============================================================
 */

let rifaplusLogoInicial = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 240 96'%3E%3Crect width='240' height='96' rx='20' fill='%230b2235'/%3E%3Ctext x='120' y='58' font-size='28' text-anchor='middle' fill='%23ffffff' font-family='Arial,sans-serif'%3ESorteo%3C/text%3E%3C/svg%3E";
const RIFAPLUS_RIFA_SLUG_PARAM = 'rifa';
// LEGACY: Clave antigua en localStorage — solo se usa para limpiarla
const RIFAPLUS_LAST_RIFA_SLUG_KEY = 'rifaplus_last_rifa_slug_v1';
// NUEVO: Clave en sessionStorage — aislada por pestaña, no contamina entre rifas
const RIFAPLUS_SESSION_SLUG_KEY   = 'rifaplus_session_slug_v1';

function obtenerSlugRifaDesdeUrlRifaPlus() {
    try {
        const params = new URLSearchParams(window.location.search);
        const slug = String(
            params.get(RIFAPLUS_RIFA_SLUG_PARAM)
            || params.get('slug')
            || ''
        ).trim();

        if (slug) {
            // ✅ Slug explícito en la URL → guardarlo en sessionStorage (aislado por pestaña).
            // sessionStorage no se comparte entre pestañas, por lo que cada pestaña
            // puede tener su propia rifa activa de forma independiente.
            try {
                sessionStorage.setItem(RIFAPLUS_SESSION_SLUG_KEY, slug);
                // Limpiar la clave legacy de localStorage para evitar contaminación futura
                localStorage.removeItem(RIFAPLUS_LAST_RIFA_SLUG_KEY);
            } catch (error) {}
            return slug;
        }

        // Sin ?rifa= en la URL — determinar si somos el home (rifa principal)
        try {
            const pathname = String(window.location.pathname || '').toLowerCase();
            const filename = pathname.split('/').pop() || '';
            const esHome = pathname === '/' || filename === 'index.html' || filename === '';

            if (esHome) {
                // ✅ Home sin ?rifa= = rifa principal. Limpiar cualquier slug residual
                // para que la navegación desde aquí NUNCA inyecte ?rifa= de otra sesión.
                try { sessionStorage.removeItem(RIFAPLUS_SESSION_SLUG_KEY); } catch (e) {}
                try { localStorage.removeItem(RIFAPLUS_LAST_RIFA_SLUG_KEY); } catch (e) {}
                return '';
            }
        } catch (error) {
            // Si falla la detección del home, continuar de forma segura.
        }

        // Página interna sin ?rifa= → recuperar el slug guardado en sessionStorage
        // de esta pestaña. NUNCA usar localStorage (contaminaría rifas distintas).
        try {
            return String(sessionStorage.getItem(RIFAPLUS_SESSION_SLUG_KEY) || '').trim();
        } catch (error) {
            return '';
        }
    } catch (error) {
        return '';
    }
}

function anexarSlugRifaARutaRifaPlus(url) {
    try {
        const resolvedUrl = new URL(String(url || ''), window.location.href);
        const slug = obtenerSlugRifaDesdeUrlRifaPlus();
        if (!slug || resolvedUrl.searchParams.has('rifa') || resolvedUrl.searchParams.has('slug')) {
            return resolvedUrl.toString();
        }

        resolvedUrl.searchParams.set(RIFAPLUS_RIFA_SLUG_PARAM, slug);
        return resolvedUrl.toString();
    } catch (error) {
        return String(url || '').trim();
    }
}

function construirUrlMisBoletosRifaPlus(opciones = {}) {
    try {
        const url = new URL('mis-boletos.html', window.location.href);
        const ordenId = String(opciones.ordenId || opciones.orden || '').trim();
        const whatsapp = String(opciones.whatsapp || '').trim();

        if (ordenId) {
            url.searchParams.set('ordenId', ordenId);
        }

        if (opciones.autoOpen !== false) {
            url.searchParams.set('autoOpen', 'true');
        }

        if (whatsapp && whatsapp !== '-') {
            url.searchParams.set('whatsapp', whatsapp);
        }

        return anexarSlugRifaARutaRifaPlus(url.toString());
    } catch (error) {
        const ordenId = String(opciones.ordenId || opciones.orden || '').trim();
        const query = [];
        if (ordenId) {
            query.push(`ordenId=${encodeURIComponent(ordenId)}`);
        }
        if (opciones.autoOpen !== false) {
            query.push('autoOpen=true');
        }
        const whatsapp = String(opciones.whatsapp || '').trim();
        if (whatsapp && whatsapp !== '-') {
            query.push(`whatsapp=${encodeURIComponent(whatsapp)}`);
        }
        const baseUrl = query.length ? `mis-boletos.html?${query.join('&')}` : 'mis-boletos.html';
        return anexarSlugRifaARutaRifaPlus(baseUrl);
    }
}

function construirClaveLocalRifaPlus(baseKey) {
    const slug = obtenerSlugRifaDesdeUrlRifaPlus();
    return slug ? `rifaplus:${slug}:${baseKey}` : baseKey;
}

function leerFlagLogoVerificadoTempranoRifaPlus() {
    const clavesSnapshot = [
        construirClaveLocalRifaPlus('rifaplus_public_snapshot_v1'),
        'rifaplus_public_snapshot_v1'
    ];
    const clavesConfig = [
        construirClaveLocalRifaPlus('config_actual_v2'),
        'rifaplus_config_actual_v2'
    ];

    for (const clave of clavesSnapshot) {
        try {
            const raw = localStorage.getItem(clave);
            if (!raw) continue;

            const parsed = JSON.parse(raw);
            const data = parsed?.data && typeof parsed.data === 'object' ? parsed.data : parsed;
            const valor = data?.rifa?.publicacion?.logoVerificadoHeader;
            if (valor !== undefined) {
                return valor !== false;
            }
        } catch (error) {
            // Ignorar errores de parseo para no romper el arranque temprano.
        }
    }

    for (const clave of clavesConfig) {
        try {
            const raw = localStorage.getItem(clave);
            if (!raw) continue;

            const parsed = JSON.parse(raw);
            const valor = parsed?.rifa?.publicacion?.logoVerificadoHeader;
            if (valor !== undefined) {
                return valor !== false;
            }
        } catch (error) {
            // Ignorar errores de parseo para no romper el arranque temprano.
        }
    }

    return true;
}

function aplicarClaseTempranaLogoVerificadoRifaPlus(mostrar) {
    try {
        document.documentElement.classList.toggle('rifaplus-logo-verified-off', mostrar === false);
    } catch (error) {
        // No hacer nada si el DOM aún no está listo.
    }
}

window.__RIFAPLUS_SET_LOGO_VERIFIED_VISIBILITY__ = function(mostrar) {
    aplicarClaseTempranaLogoVerificadoRifaPlus(mostrar !== false);
};

try {
    const logoCacheado = localStorage.getItem(construirClaveLocalRifaPlus('cached_logo'))
        || localStorage.getItem('rifaplus_cached_logo')
        || '';
    if (logoCacheado && logoCacheado !== 'images/placeholder-logo.svg') {
        rifaplusLogoInicial = logoCacheado;
    }
} catch (error) {
    // localStorage puede no estar disponible en algunos contextos
}

try {
    aplicarClaseTempranaLogoVerificadoRifaPlus(leerFlagLogoVerificadoTempranoRifaPlus());
} catch (error) {
    // localStorage puede no estar disponible o fallar en algunos contextos.
}

// Crear namespace global de configuración
window.rifaplusConfig = window.rifaplusConfig || {};

function obtenerMetaDeploy(nombre) {
    try {
        const meta = document.querySelector(`meta[name="${nombre}"]`);
        return meta ? String(meta.content || '').trim() : '';
    } catch (error) {
        return '';
    }
}

function normalizarBaseUrl(url) {
    return String(url || '').trim().replace(/\/+$/, '');
}

const RIFAPLUS_PROMO_TIMEZONE = 'America/Mexico_City';
const RIFAPLUS_DEFAULT_TIMEZONE = 'America/Mexico_City';
const RIFAPLUS_PUBLIC_SNAPSHOT_KEY = 'rifaplus_public_snapshot_v1';
const RIFAPLUS_TIMEZONE_LABELS = {
    'America/Mexico_City': 'Hora Centro Mexico',
    'America/Monterrey': 'Hora Monterrey',
    'America/Chihuahua': 'Hora Chihuahua',
    'America/Mazatlan': 'Hora Pacifico Mexico',
    'America/Hermosillo': 'Hora Sonora',
    'America/Tijuana': 'Hora Tijuana',
    'America/Cancun': 'Hora Cancun'
};
const RIFAPLUS_TIMEZONE_ALIASES = {
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

function obtenerOffsetMinutosEnZonaRifaPlus(fecha, timeZone = RIFAPLUS_PROMO_TIMEZONE) {
    try {
        const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone,
            timeZoneName: 'shortOffset',
            hour: '2-digit',
            minute: '2-digit'
        });
        const offsetPart = formatter.formatToParts(fecha).find((part) => part.type === 'timeZoneName')?.value || 'GMT-6';
        const match = offsetPart.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/i);
        if (!match) return -360;

        const sign = match[1] === '-' ? -1 : 1;
        const hours = Number(match[2] || 0);
        const minutes = Number(match[3] || 0);
        return sign * ((hours * 60) + minutes);
    } catch (error) {
        return -360;
    }
}

function normalizarTimeZoneRifaPlus(timeZone) {
    const valor = String(timeZone || '').trim();
    if (RIFAPLUS_TIMEZONE_LABELS[valor]) {
        return valor;
    }
    return RIFAPLUS_TIMEZONE_ALIASES[valor] || RIFAPLUS_DEFAULT_TIMEZONE;
}

function obtenerEtiquetaTimeZoneRifaPlus(timeZone) {
    return RIFAPLUS_TIMEZONE_LABELS[normalizarTimeZoneRifaPlus(timeZone)] || RIFAPLUS_TIMEZONE_LABELS[RIFAPLUS_DEFAULT_TIMEZONE];
}

function parseFechaPromocionRifaPlus(valor, timeZone = RIFAPLUS_PROMO_TIMEZONE) {
    if (!valor) return null;
    if (valor instanceof Date) return Number.isNaN(valor.getTime()) ? null : valor;

    const texto = String(valor).trim();
    if (!texto) return null;

    const tieneZonaExplicita = /(?:Z|[+-]\d{2}:\d{2})$/i.test(texto);
    if (tieneZonaExplicita) {
        const fecha = new Date(texto);
        return Number.isNaN(fecha.getTime()) ? null : fecha;
    }

    const match = texto.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!match) {
        const fecha = new Date(texto);
        return Number.isNaN(fecha.getTime()) ? null : fecha;
    }

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6] || 0);

    const utcTentativo = Date.UTC(year, month - 1, day, hour, minute, second);
    const offsetMinutos = obtenerOffsetMinutosEnZonaRifaPlus(new Date(utcTentativo), timeZone);
    const fecha = new Date(utcTentativo - (offsetMinutos * 60 * 1000));

    return Number.isNaN(fecha.getTime()) ? null : fecha;
}

function parseFechaSorteoRifaPlus(valor, timeZone = RIFAPLUS_DEFAULT_TIMEZONE) {
    return parseFechaPromocionRifaPlus(valor, normalizarTimeZoneRifaPlus(timeZone));
}

function esFechaPromocionActivaRifaPlus(fechaInicio, fechaFin, ahora = new Date(), timeZone = RIFAPLUS_PROMO_TIMEZONE) {
    const inicio = parseFechaPromocionRifaPlus(fechaInicio, timeZone);
    const fin = parseFechaPromocionRifaPlus(fechaFin, timeZone);

    if (!inicio || !fin) return false;
    return ahora >= inicio && ahora <= fin;
}

window.rifaplusConfig.parseFechaPromocion = parseFechaPromocionRifaPlus;
window.rifaplusConfig.esFechaPromocionActiva = esFechaPromocionActivaRifaPlus;
window.rifaplusConfig.construirClaveLocal = construirClaveLocalRifaPlus;
window.rifaplusConfig.obtenerSlugRifaActual = obtenerSlugRifaDesdeUrlRifaPlus;

function resolverApiBaseRifaPlus() {
    const globalDeploy = window.__RIFAPLUS_DEPLOY__ || {};
    const metaApiBase = obtenerMetaDeploy('rifaplus-api-base');
    const explicitApiBase = normalizarBaseUrl(globalDeploy.apiBase || metaApiBase);

    // ⭐ OPTIMIZACIÓN PROFESIONAL: Detección de entorno
    const hostname = window.location.hostname;
    const isLocal = hostname === 'localhost' || hostname === '127.0.0.1';
    
    // Si estamos en producción (ej: pages.dev) y la URL meta dice 'localhost',
    // es un error de despliegue. Intentamos usar el origen actual como API base.
    if (!isLocal && explicitApiBase.includes('localhost')) {
        console.warn('⚠️ [Config] Se detectó API de desarrollo en ambiente de producción. Usando fallback de origen actual.');
        return normalizarBaseUrl(window.location.origin);
    }

    if (explicitApiBase) {
        return explicitApiBase;
    }

    const puerto = window.rifaplusConfig?.backend?.puerto || 5001;
    if (isLocal) {
        return `http://localhost:${puerto}`;
    }

    return normalizarBaseUrl(window.location.origin);
}

function resolverSocketScriptUrlRifaPlus() {
    const globalDeploy = window.__RIFAPLUS_DEPLOY__ || {};
    const metaSocketUrl = obtenerMetaDeploy('rifaplus-socket-url');
    const explicitSocketUrl = String(globalDeploy.socketScriptUrl || metaSocketUrl || '').trim();

    if (explicitSocketUrl) {
        return explicitSocketUrl;
    }

    const apiBase = resolverApiBaseRifaPlus();
    return `${apiBase}/socket.io/socket.io.js`;
}

function esObjetoPlanoRifaPlus(valor) {
    return Boolean(valor) && typeof valor === 'object' && !Array.isArray(valor);
}

function clonarValorSeguroRifaPlus(valor) {
    if (valor === null || valor === undefined) {
        return valor;
    }

    try {
        return JSON.parse(JSON.stringify(valor));
    } catch (error) {
        return Array.isArray(valor) ? valor.slice() : { ...valor };
    }
}

function mezclarConfigTempranaRifaPlus(destino, origen) {
    if (!esObjetoPlanoRifaPlus(destino) || !esObjetoPlanoRifaPlus(origen)) {
        return destino;
    }

    Object.keys(origen).forEach((clave) => {
        const valor = origen[clave];
        if (valor === undefined) {
            return;
        }

        if (Array.isArray(valor)) {
            destino[clave] = clonarValorSeguroRifaPlus(valor);
            return;
        }

        if (esObjetoPlanoRifaPlus(valor) && esObjetoPlanoRifaPlus(destino[clave])) {
            mezclarConfigTempranaRifaPlus(destino[clave], valor);
            return;
        }

        destino[clave] = valor;
    });

    return destino;
}

function leerSnapshotPublicoInicialRifaPlus() {
    try {
        const raw = localStorage.getItem(construirClaveLocalRifaPlus(RIFAPLUS_PUBLIC_SNAPSHOT_KEY))
            || localStorage.getItem(RIFAPLUS_PUBLIC_SNAPSHOT_KEY);
        if (!raw) return null;

        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;

        const data = parsed.data && typeof parsed.data === 'object'
            ? parsed.data
            : parsed;

        return data && typeof data === 'object' ? data : null;
    } catch (error) {
        return null;
    }
}

window.rifaplusConfig.obtenerApiBase = resolverApiBaseRifaPlus;
window.rifaplusConfig.obtenerSocketScriptUrl = resolverSocketScriptUrlRifaPlus;
window.rifaplusConfig.obtenerSlugRifaActual = obtenerSlugRifaDesdeUrlRifaPlus;
window.rifaplusConfig.anexarSlugRifaAUrl = anexarSlugRifaARutaRifaPlus;
window.rifaplusConfig.construirUrlMisBoletos = construirUrlMisBoletosRifaPlus;
window.rifaplusConfig.construirClaveLocal = construirClaveLocalRifaPlus;
window.rifaplusConfig._PUBLIC_SNAPSHOT_KEY = construirClaveLocalRifaPlus(RIFAPLUS_PUBLIC_SNAPSHOT_KEY);
window.rifaplusConfig.obtenerSnapshotPublicoLocal = function() {
    const data = leerSnapshotPublicoInicialRifaPlus();
    if (!data) {
        return null;
    }

    return {
        version: 1,
        data: clonarValorSeguroRifaPlus(data)
    };
};

if (!window.__RIFAPLUS_PUBLIC_RIFA_FETCH_PATCHED__) {
    const originalFetchRifaPlus = window.fetch.bind(window);
    const resolveRifaScopedResource = (resource) => {
        try {
            const requestUrl = resource instanceof Request ? resource.url : resource;
            const resolvedUrl = new URL(String(requestUrl), window.location.href);
            const apiBase = resolverApiBaseRifaPlus();

            if (!apiBase) {
                return resource;
            }

            const apiUrl = new URL(String(apiBase), window.location.href);
            if (resolvedUrl.origin !== apiUrl.origin) {
                return resource;
            }

            const isApiRequest = resolvedUrl.pathname === '/api'
                || resolvedUrl.pathname.startsWith('/api/');

            if (!isApiRequest) {
                return resource;
            }

            if (resolvedUrl.pathname.startsWith('/api/admin/')) {
                return resource;
            }

            const slug = obtenerSlugRifaDesdeUrlRifaPlus();
            if (!slug || resolvedUrl.searchParams.has('rifa') || resolvedUrl.searchParams.has('slug')) {
                return resource;
            }

            resolvedUrl.searchParams.set('rifa', slug);

            if (resource instanceof Request) {
                return new Request(resolvedUrl.toString(), resource);
            }

            return resolvedUrl.toString();
        } catch (error) {
            return resource;
        }
    };

    window.fetch = function(resource, options = {}) {
        const scopedResource = resolveRifaScopedResource(resource);
        const finalOptions = { ...(options || {}) };
        
        // 🛡️ INYECCIÓN AUTOMÁTICA DE CABECERAS DE RIFA
        const slug = obtenerSlugRifaDesdeUrlRifaPlus();
        if (slug) {
            if (finalOptions.headers instanceof Headers) {
                finalOptions.headers.set('x-rifaplus-rifa-slug', slug);
                if (window.rifaplusConfig?.rifa?.id) {
                    finalOptions.headers.set('x-rifa-id', String(window.rifaplusConfig.rifa.id));
                }
            } else {
                finalOptions.headers = {
                    ...(finalOptions.headers || {}),
                    'x-rifaplus-rifa-slug': slug,
                    'x-rifa-id': window.rifaplusConfig?.rifa?.id || ''
                };
            }
        }
        
        return originalFetchRifaPlus(scopedResource, finalOptions);
    };
    window.__RIFAPLUS_PUBLIC_RIFA_FETCH_PATCHED__ = true;
}

// Versión de configuración
window.rifaplusConfig._VERSION = '3.1.0';  // v3.1.0 = Arquitectura limpia sin duplicación

// Valores iniciales mínimos (se sobrescriben con config.json)
Object.assign(window.rifaplusConfig, {
    
    /* ============================================================ */
    /* SECCIÓN 1: DATOS DEL CLIENTE                                */
    /* ============================================================ */
    /* 📡 TODOS estos datos provienen de /backend/config.json      */
    /* Se sincronizan automáticamente cada 5 segundos              */
    /* NO duplicar valores aquí - ver config-sync.js               */
    
    cliente: {
        id: "",      
        nombre: "",  // Fallback genérico hasta que sincronice desde config.json
        _prefijoOrdenManual: "",
        eslogan: "La mejor forma de ganar", // Fallback genérico
        email: "",   // Se sincroniza desde config.json
        telefono: "", // Se sincroniza desde config.json
        redesSociales: {
            whatsapp: "",
            facebook: "",
            facebookUsuario: "",
            instagram: "",
            instagramUsuario: "",
            tiktok: "",
            grupoWhatsapp: "",
            grupoWhatsappNombre: "",
            canalWhatsapp: "",
            canalWhatsappNombre: ""
        },
        
        // ✅ ESTRUCTURA LOCAL (no en config.json):
        logo: rifaplusLogoInicial,
        imagenPrincipal: "images/placeholder-cover.svg",
        colorPrimario: "#0b2238",
        colorSecundario: "#1fd1c2",
        colorAccento: "#1fd1c2",
        colorExito: "#1aa772",
        colorPeligro: "#f3a64a",
        colorAdvertencia: "#f3a64a",
        colorTexto: "#102132",
        colorTextoSecundario: "#5f7486",
        colorFondo: "#ffffff",
        colorFondoSecundario: "#f4f8fb",
        anioActual: 2026,
        
        /**
         * Getter dinámico: usa primero el prefijo configurado explícitamente.
         * Si no existe, genera uno automático desde cliente.nombre.
         */
        get prefijoOrden() {
            const prefijoManual = String(this._prefijoOrdenManual || '').trim().toUpperCase();
            if (prefijoManual) {
                return prefijoManual;
            }

            const nombre = this.nombre || 'ORDEN';
            const palabras = nombre.split(/\s+/).filter(p => p.trim().length > 0);
            const prefijo = palabras.map(p => p.charAt(0).toUpperCase()).join('');
            return prefijo.length > 0 ? prefijo : 'ORD';
        },

        set prefijoOrden(value) {
            this._prefijoOrdenManual = String(value || '').trim().toUpperCase();
        }
    },

    /* ============================================================ */
    /* SECCIÓN 2: CONFIGURACIÓN DE LA RIFA                         */
    /* ============================================================ */
    /* 📡 TODOS estos datos provienen de /backend/config.json      */
    
    rifa: {
        nombreSorteo: "",  // Se sincroniza desde config.json
        edicionNombre: "",  // Se sincroniza desde config.json
        descripcion: "",  // Se sincroniza desde config.json
        totalBoletos: "",  // Valor seguro de arranque (se sobrescribe desde config.json)
        precioBoleto: "",    // Valor por defecto (se sobrescribe desde config.json)
        tiempoApartadoHoras: 4,             // Se sincroniza desde config.json
        intervaloLimpiezaMinutos: 1,        // Se sincroniza desde config.json
        
        // Fechas del sorteo
        fechaSorteo: "",  // Se sincroniza desde config.json
        fechaSorteoFormato: "",  // Se sincroniza desde config.json
        horaSorteo: "",  // Se sincroniza desde config.json
        timeZone: "America/Mexico_City",  // Se sincroniza desde config.json
        zonaHoraria: "Hora Centro México",  // Se sincroniza desde config.json
        modalidadSorteo: "",  // Se sincroniza desde config.json
        modalidadEnlace: {
            tipo: "facebook"
        },  // Se sincroniza desde config.json
        fechaPresorteo: "",  // Se sincroniza desde config.json (opcional)
        fechaPresorteoFormato: "",  // Se sincroniza desde config.json (opcional)
        horaPresorteo: "",  // Se sincroniza desde config.json (opcional)
        
        // Colecciones
        rangos: [],  // Se sincroniza desde config.json
        galeria: {
            enabled: true,  // ✅ HABILITADA por defecto (se sobrescribe desde config.json)
            imagenes: [
                {url: "images/placeholder-cover.svg", titulo: "Vista Principal", descripcion: "Imagen temporal mientras sincroniza la galeria"},
                {url: "images/placeholder-cover.svg", titulo: "Vista Frontal", descripcion: "Contenido visual sincronizándose"},
                {url: "images/placeholder-cover.svg", titulo: "Vista Lateral", descripcion: "Contenido visual sincronizándose"}
            ]
        },  // Se sincroniza desde config.json
        oportunidades: {enabled: false, multiplicador: 1},  // Se sincroniza desde config.json
        descuentos: {
            enabled: false,
            reglas: []
        },  // Se sincroniza desde config.json
        promocionesOportunidades: {
            enabled: true,
            ejemplos: []
        },  // Se sincroniza desde config.json
        publicacion: {
            bonos: true,
            promociones: true,
            confianza: true,
            testimonios: false,
            ruletazo: true,
            presorteo: true,
            progressBar: true,
            progressStats: true,
            logoVerificadoHeader: true
        },  // Se sincroniza desde config.json
        bonos: {
            enabled: true,
            items: []
        },  // Se sincroniza desde config.json
        bonosCompra: {
            enabled: false,
            items: []
        },  // Se sincroniza desde config.json
        maquinaSuerte: {
            limiteBoletos: 500,
            quickPicks: [10, 20, 50, 100],
            mostrarNotaDisponibilidad: true
        },  // Se sincroniza desde config.json
        sistemaPremios: {
            enabled: false,
            mensaje: "",
            sorteo: [],
            presorteo: [],
            ruletazos: []
        },  // Se sincroniza desde config.json
        
        // Info auxiliar
        infoRifa: [
            { icono: '🗓️', titulo: 'Fecha y Hora del Sorteo', contenido: 'dinamico-fecha-hora' },
            { icono: '📍', titulo: 'Modalidad', contenido: 'dinamico-modalidad' },
            { icono: '🎯', titulo: 'Total de Emisiones', contenido: 'dinamico-emisiones' }
        ]
    },

    /* ============================================================ */
    /* SECCIÓN 3: ESTADO DEL SORTEO ACTUAL                        */
    /* ============================================================ */
    
    sorteoActivo: {
        estado: 'activo',           // 'activo' | 'proximo' | 'finalizado'
        id: '',
        nombre: '',  // ← Desde config.json
        
        /**
         * Getter dinámico: Lee fechaCierre desde rifa.fechaSorteo
         */
        get fechaCierre() {
            const timestamp = window.rifaplusConfig?.obtenerTimestampSorteo?.();
            if (timestamp) {
                return new Date(timestamp);
            }
            return new Date('2999-01-01T00:00:00');
        },
        
        ganadores: {
            principal: [],
            presorte: [],
            ruletazo: []
        },
        
        estadisticas: {
            // ⚠️ IMPORTANTE: "totalBoletos" SIEMPRE viene de rifa.totalBoletos (config.json)
            // NO duplicar este valor aquí. Usar: window.rifaplusConfig.rifa.totalBoletos
            totalVendidos: 0,
            participantes: 0,
            recaudacion: 0
        },
        
        documentos: {
            actaURL: null,
            videoURL: null,
            certificado: 'Verificado por notario público'
        },
        
        mensajeAgradecimiento: '¡Agradecemos tu participación en nuestro sorteo! Tu confianza es lo más importante para nosotros.'
    },

    permitirCompras: true,

    /* ============================================================ */
    /* SECCIÓN 4: CONFIGURACIÓN DEL BACKEND                        */
    /* ============================================================ */
    
    backend: {
        puerto: 5001,
        
        get apiBase() {
            return window.rifaplusConfig.obtenerApiBase();
        },
        
        endpoints: {
            ordenes: '/api/ordenes',
            boletos: '/api/public/boletos',
            stats: '/api/admin/stats',
            login: '/api/admin/login'
        },
        
        admin: {
            loginEnabled: true
        }
    },

    /* ============================================================ */
    /* SECCIÓN 5: CONFIGURACIÓN TÉCNICA                           */
    /* ============================================================ */
    /* 📡 bankAccounts se carga desde /backend/config.json         */
    
    tecnica: {
        numeroWhatsappOrganizador: '+52 4591153960',  // ← Desde config.json
        nombreOrganizador: 'SORTEOS TORRES',  // ← Desde config.json
        bankAccounts: [
            {id: 1, nombreBanco: "SANTANDER", accountNumber: "4456 1267 8989 1156", beneficiary: "Jose Luis Yepez Garcia", accountType: "Tarjeta", paymentType: "transferencia"},
            {id: 2, nombreBanco: "BBVA", accountNumber: "4589 1290 4589 3210", beneficiary: "Jose Ayair Lopez Perez", accountType: "Tarjeta", paymentType: "transferencia"},
            {id: 3, nombreBanco: "OXXO", accountNumber: "4489 4567 0121 89561", beneficiary: "Sortel Torres", accountType: "Tarjeta", paymentType: "efectivo", numero_referencia: "ST-0001"},
            {id: 4, nombreBanco: "Farmacias del Ahorro", accountNumber: "4489 4567 0121 89561", beneficiary: "Sortel Torres", accountType: "Tarjeta", paymentType: "efectivo", numero_referencia: "FDA-0001"},
            {id: 5, nombreBanco: "7-Eleven", accountNumber: "4489 4567 0121 89561", beneficiary: "Sortel Torres", accountType: "Tarjeta", paymentType: "efectivo", numero_referencia: "SEVEN-0001"}
        ]  // ← Desde config.json
    },

    /* ============================================================ */
    /* SECCIÓN 6: ESTADO DINÁMICO                                  */
    /* ============================================================ */
    
    estado: {
        boletosVendidos: 0,
        boletosApartados: 0,
        boletosDisponibles: 1000,
        porcentajeVendido: 0,
        ultimaActualizacion: null
    },

    /* ============================================================ */
    /* SECCIÓN 7: CONFIGURACIÓN DE TEMA Y COLORES                  */
    /* ============================================================ */
    
    tema: {
        colores: {
            colorPrimario: "#0b2238",
            colorSecundario: "#1fd1c2",
            colorAccento: "#1fd1c2",
            colorExito: "#1aa772",
            colorPeligro: "#f3a64a",
            colorAdvertencia: "#f3a64a",
            colorTexto: "#102132",
            colorTextoSecundario: "#5f7486",
            colorFondo: "#f4f8fb",
            colorFondoSecundario: "#ffffff"
        }
    },

    /* ============================================================ */
    /* SECCIÓN 8: CONFIGURACIÓN DE SEO                             */
    /* ============================================================ */
    
    seo: {
        title: "",
        titulo: "",
        description: "",
        descripcion: "",
        keywords: "",
        palabrasLlave: "",
        urlBase: "http://127.0.0.1:5500/",
        openGraph: {
            titulo: "",
            descripcion: "",
            imagen: "/images/placeholder-cover.svg",
            tipo: "website",
            locale: "es_MX"
        },
        twitter: {
            card: "summary_large_image",
            titulo: "",
            descripcion: "",
            imagen: "/images/placeholder-cover.svg",
            creador: "@joseayair"
        },
        author: "",
        autor: "",
        copyright: ""
    },

    /* ============================================================ */
    /* SECCIÓN 9: MARKETING Y ANALÍTICA                            */
    /* ============================================================ */

    marketing: {
        metaPixel: {
            enabled: false,
            pixelId: "",
            trackPageView: true,
            trackViewContent: true,
            trackAddToCart: true,
            trackInitiateCheckout: true,
            trackPurchase: true
        }
    }
});

const rifaplusSnapshotInicial = leerSnapshotPublicoInicialRifaPlus();
if (rifaplusSnapshotInicial) {
    if (esObjetoPlanoRifaPlus(rifaplusSnapshotInicial.cliente)) {
        mezclarConfigTempranaRifaPlus(window.rifaplusConfig.cliente, rifaplusSnapshotInicial.cliente);
    }

    if (esObjetoPlanoRifaPlus(rifaplusSnapshotInicial.rifa)) {
        const infoRifaLocal = Array.isArray(window.rifaplusConfig.rifa?.infoRifa)
            ? window.rifaplusConfig.rifa.infoRifa
            : [];
        mezclarConfigTempranaRifaPlus(window.rifaplusConfig.rifa, rifaplusSnapshotInicial.rifa);
        if (infoRifaLocal.length > 0) {
            window.rifaplusConfig.rifa.infoRifa = infoRifaLocal;
        }
    }

    if (esObjetoPlanoRifaPlus(rifaplusSnapshotInicial.seo)) {
        mezclarConfigTempranaRifaPlus(window.rifaplusConfig.seo, rifaplusSnapshotInicial.seo);
    }

    if (esObjetoPlanoRifaPlus(rifaplusSnapshotInicial.tema)) {
        mezclarConfigTempranaRifaPlus(window.rifaplusConfig.tema, rifaplusSnapshotInicial.tema);
    }

    if (esObjetoPlanoRifaPlus(rifaplusSnapshotInicial.marketing)) {
        mezclarConfigTempranaRifaPlus(window.rifaplusConfig.marketing, rifaplusSnapshotInicial.marketing);
    }

    if (Array.isArray(rifaplusSnapshotInicial.cuentas)) {
        window.rifaplusConfig.tecnica.bankAccounts = clonarValorSeguroRifaPlus(rifaplusSnapshotInicial.cuentas);
    }
}

// ====================================
// ALIAS Y PROPIEDADES DINÁMICAS
// ====================================

/**
 * Alias legible para compatibilidad: exponer `bankAccounts` en raíz
 */
Object.defineProperty(window.rifaplusConfig, 'bankAccounts', {
    get: function() {
        return (this.tecnica && Array.isArray(this.tecnica.bankAccounts)) 
            ? this.tecnica.bankAccounts 
            : [];
    },
    set: function(value) {
        if (!this.tecnica) this.tecnica = {};
        this.tecnica.bankAccounts = value;
    },
    enumerable: true,
    configurable: true
});

// Alias para debugging
window.config = window.rifaplusConfig;

// ====================================
// SISTEMA REACTIVO PARA CAMBIOS
// ====================================

window.rifaplusConfig._changeListeners = [];

/**
 * Registra un listener para cambios en configuración
 */
window.rifaplusConfig.onChange = function(callback) {
    this._changeListeners.push(callback);
};

/**
 * Notifica a listeners sobre cambios
 * @private
 */
window.rifaplusConfig._notifyListeners = function(seccion, campo, valorAnterior, valorNuevo) {
    this._changeListeners.forEach(callback => {
        try {
            callback({ seccion, campo, valorAnterior, valorNuevo });
        } catch (e) {
            console.error('Error en listener:', e);
        }
    });
    
    this._actualizarDOM(seccion, campo, valorNuevo);
};

/**
 * Actualiza cualquier valor en la configuración dinámicamente
 * 
 * @param {string} seccion - 'cliente', 'rifa', 'backend', 'tecnica'
 * @param {string} campo - El campo específico
 * @param {*} valorNuevo - El nuevo valor
 */
window.rifaplusConfig.set = function(seccion, campo, valorNuevo) {
    if (!this[seccion]) {
        console.error(`❌ Sección "${seccion}" no existe`);
        return false;
    }
    
    const valorAnterior = this[seccion][campo];
    
    if (valorAnterior === valorNuevo) {
        return true;
    }
    
    this[seccion][campo] = valorNuevo;
    console.log(`📝 Config actualizada: ${seccion}.${campo}`);
    
    this._guardarEnLocal();
    this._notifyListeners(seccion, campo, valorAnterior, valorNuevo);
    
    return true;
};

/**
 * Actualiza elementos del DOM que usan datos
 * @private
 */
window.rifaplusConfig._actualizarDOM = function(seccion, campo, valor) {
    try {
        if (seccion === 'rifa' && campo === 'totalBoletos') {
            const elementos = ['rifaTotal', 'statTotalBoletos', 'total-boletos-info', 'totalTickets'];
            elementos.forEach(id => {
                const el = document.getElementById(id);
                if (el) el.textContent = valor.toLocaleString('es-MX');
            });
            
            if (window.loadCurrentRifa && typeof window.loadCurrentRifa === 'function') {
                window.loadCurrentRifa();
            }
            
            window.dispatchEvent(new CustomEvent('totalBoletosActualizado', { detail: { valor } }));
        }
        
        if (seccion === 'rifa' && campo === 'precioBoleto') {
            if (window.actualizarPrecioBoleto && typeof window.actualizarPrecioBoleto === 'function') {
                window.actualizarPrecioBoleto(valor);
            }
        }
    } catch (error) {
        console.warn('Error actualizando DOM:', error);
    }
};

/**
 * Guarda configuración en localStorage (solo datos de usuario)
 * @private
 */
window.rifaplusConfig._guardarEnLocal = function() {
    try {
        const configUserOnly = {
            cliente: this.cliente,
            backend: this.backend,
            tecnica: this.tecnica,
            _version: this._VERSION
        };
        
        localStorage.setItem(construirClaveLocalRifaPlus('config_actual_v2'), JSON.stringify(configUserOnly));
        localStorage.setItem('rifaplus_config_actual_v2', JSON.stringify(configUserOnly));
        localStorage.removeItem('rifaplus_config_actual');
        
    } catch (e) {
        console.warn('⚠️ No se pudo guardar en localStorage:', e);
    }
};

/**
 * Carga configuración desde localStorage (solo datos de usuario)
 */
window.rifaplusConfig.cargarDelLocal = function() {
    try {
        const guardada = localStorage.getItem(construirClaveLocalRifaPlus('config_actual_v2'))
            || localStorage.getItem('rifaplus_config_actual_v2');
        if (!guardada) {
            localStorage.removeItem('rifaplus_config_actual');
            return false;
        }
        
        const config = JSON.parse(guardada);
        
        if (config.cliente) Object.assign(this.cliente, config.cliente);
        if (config.backend) Object.assign(this.backend, config.backend);
        if (config.tecnica) Object.assign(this.tecnica, config.tecnica);
        
        console.log('✅ Configuración de usuario cargada');
        return true;
    } catch (e) {
        console.error('❌ Error cargando configuración:', e);
        return false;
    }
};

/**
 * Valida integridad del sistema de configuración
 * @private
 */
window.rifaplusConfig._validarIntegridadSorteo = function() {
    const errores = [];
    
    if (!this.rifa || !this.rifa.fechaSorteo) {
        errores.push('❌ CRÍTICO: rifa.fechaSorteo no definida');
    }
    
    if (errores.length > 0) {
        console.error('🚨 ERRORES DE INTEGRIDAD:');
        errores.forEach(e => console.error(e));
        return false;
    }
    
    console.log('✅ Validación de integridad: EXITOSA');
    return true;
};

/**
 * Limpia localStorage para nuevo sorteo
 */
window.rifaplusConfig.limpiarParaNuevoSorteo = function() {
    try {
        console.log('🧹 Limpiando localStorage para nuevo sorteo...');
        localStorage.removeItem(construirClaveLocalRifaPlus('config_actual_v2'));
        localStorage.removeItem('rifaplus_config_actual_v2');
        localStorage.removeItem('rifaplus_config_actual');
        console.log('✅ localStorage limpiado');
        return true;
    } catch (e) {
        console.error('❌ Error limpiando localStorage:', e);
        return false;
    }
};

/**
 * Reset completo de localStorage
 */
window.rifaplusConfig.resetCompletoStorage = function() {
    try {
        console.log('🔥 RESET COMPLETO de localStorage...');
        const keys = Object.keys(localStorage);
        keys.forEach(key => {
            if (key.startsWith('rifaplus_') || key.startsWith('admin_')) {
                localStorage.removeItem(key);
            }
        });
        console.log('✅ localStorage completamente limpio');
        return true;
    } catch (e) {
        console.error('❌ Error en reset:', e);
        return false;
    }
};

/**
 * Obtiene diagnóstico del sistema
 */
window.rifaplusConfig.diagnostico = function() {
    const diag = {
        version: this._VERSION,
        timestamp: new Date().toISOString(),
        rifa: {
            nombreSorteo: this.rifa?.nombreSorteo,
            fechaSorteo: this.rifa?.fechaSorteo,
            totalBoletos: this.rifa?.totalBoletos,
            precioBoleto: this.rifa?.precioBoleto
        },
        timestamps: {
            sorteo: this.obtenerTimestampSorteo?.(),
            ahora: Date.now()
        },
        validacion: this._validarIntegridadSorteo?.()
    };
    
    console.table(diag);
    return diag;
};

/**
 * Obtiene un valor dinámicamente
 */
window.rifaplusConfig.get = function(ruta) {
    const partes = ruta.split('.');
    let valor = this;
    for (const parte of partes) {
        valor = valor[parte];
        if (valor === undefined) return null;
    }
    return valor;
};

/**
 * Exporta configuración como JSON
 */
window.rifaplusConfig.exportarConfiguracion = function() {
    const config = {
        cliente: this.cliente,
        rifa: this.rifa,
        tecnica: this.tecnica
    };
    return JSON.stringify(config, null, 2);
};

/**
 * Descarga configuración como archivo
 */
window.rifaplusConfig.descargarConfiguracion = function() {
    const config = this.exportarConfiguracion();
    const element = document.createElement('a');
    element.setAttribute('href', 'data:application/json;charset=utf-8,' + encodeURIComponent(config));
    element.setAttribute('download', `config-${this.cliente.id}-${Date.now()}.json`);
    element.style.display = 'none';
    document.body.appendChild(element);
    element.click();
    document.body.removeChild(element);
};

/**
 * Importa configuración desde JSON
 */
window.rifaplusConfig.importarConfiguracion = function(jsonString) {
    try {
        const config = JSON.parse(jsonString);
        if (config.cliente) this.cliente = Object.assign({}, this.cliente, config.cliente);
        if (config.rifa) this.rifa = Object.assign({}, this.rifa, config.rifa);
        if (config.tecnica) this.tecnica = Object.assign({}, this.tecnica, config.tecnica);
        this.emitirEvento?.('configuracionActualizada', { cliente: this.cliente, rifa: this.rifa });
        return true;
    } catch (error) {
        console.error('Error importando:', error);
        return false;
    }
};

// ====================================
// FUNCIONES PARA GESTIÓN DE FECHA
// ====================================

/**
 * Obtiene fecha ISO del sorteo
 */
window.rifaplusConfig.obtenerFechaSorteo = function() {
    if (!this.rifa) return null;
    return this.rifa.fechaSorteo || null;
};

/**
 * Obtiene time zone IANA de la rifa
 */
window.rifaplusConfig.obtenerTimeZoneRifa = function() {
    if (!this.rifa) return RIFAPLUS_DEFAULT_TIMEZONE;
    return normalizarTimeZoneRifaPlus(this.rifa.timeZone || this.rifa.zonaHoraria);
};

/**
 * Obtiene etiqueta legible de la zona horaria de la rifa
 */
window.rifaplusConfig.obtenerZonaHorariaLabel = function() {
    return obtenerEtiquetaTimeZoneRifaPlus(this.obtenerTimeZoneRifa?.());
};

/**
 * Obtiene timestamp en ms del sorteo
 */
window.rifaplusConfig.obtenerTimestampSorteo = function() {
    const fechaISO = this.obtenerFechaSorteo();
    const timeZone = this.obtenerTimeZoneRifa?.();

    if (!fechaISO) {
        return null;
    }

    try {
        const fecha = parseFechaSorteoRifaPlus(fechaISO, timeZone);
        const timestamp = fecha?.getTime?.() || null;
        if (!timestamp || Number.isNaN(timestamp)) {
            console.error('❌ No se pudo parsear fechaSorteo:', { fechaISO, timeZone });
            return null;
        }
        return timestamp;
    } catch (error) {
        console.error('❌ Error calculando timestamp:', error);
        return null;
    }
};

/**
 * Valida la fecha del sorteo
 */
window.rifaplusConfig.validarFechaSorteo = function() {
    const fechaISO = this.obtenerFechaSorteo();

    if (!fechaISO) {
        return {
            valida: false,
            mensaje: '⏳ Sincronizando fecha desde servidor...',
            timestamp: null,
            pendiente: true
        };
    }

    const timestamp = this.obtenerTimestampSorteo();
    if (!timestamp) {
        return {
            valida: false,
            mensaje: `No se pudo parsear fechaSorteo: "${fechaISO}"`,
            timestamp: null
        };
    }

    const ahora = new Date().getTime();
    const sorteoYaPaso = timestamp <= ahora;

    return {
        valida: true,
        mensaje: sorteoYaPaso ? 'El sorteo ya ha ocurrido' : 'Fecha válida',
        timestamp,
        sorteoYaPaso,
        diasRestantes: Math.floor((timestamp - ahora) / (1000 * 60 * 60 * 24))
    };
};

/**
 * Formatea una fecha ISO (ej: "2026-03-21T20:00:00") a formato legible (ej: "21 de Marzo del 2026")
 * @param {string} fechaISO - Fecha en formato ISO
 * @returns {string} Fecha formateada en español
 */
window.rifaplusConfig.formatearFechaISO = function(fechaISO) {
    if (!fechaISO) return '';
    
    try {
        const timeZone = this.obtenerTimeZoneRifa?.();
        const fecha = parseFechaSorteoRifaPlus(fechaISO, timeZone);
        if (!fecha || isNaN(fecha.getTime())) {
            console.warn('⚠️ Fecha ISO inválida:', fechaISO);
            return '';
        }
        
        const formatter = new Intl.DateTimeFormat('es-MX', {
            timeZone,
            day: 'numeric',
            month: 'long',
            year: 'numeric'
        });
        const parts = formatter.formatToParts(fecha);
        const day = parts.find((part) => part.type === 'day')?.value || '';
        const monthRaw = parts.find((part) => part.type === 'month')?.value || '';
        const year = parts.find((part) => part.type === 'year')?.value || '';
        const month = monthRaw ? monthRaw.charAt(0).toUpperCase() + monthRaw.slice(1) : '';

        return day && month && year ? `${day} de ${month} del ${year}` : formatter.format(fecha);
    } catch (error) {
        console.error('Error formateando fecha:', error);
        return '';
    }
};

/**
 * Obtiene fecha formateada - dinámicamente basada en fechaSorteo
 */
window.rifaplusConfig.obtenerFechaSorteoFormato = function() {
    if (!this.rifa) return '';
    
    // ✅ Si fecha ISO existe, formatear dinámicamente (siempre recalcula)
    if (this.rifa.fechaSorteo) {
        return this.formatearFechaISO(this.rifa.fechaSorteo);
    }
    
    // ⚠️ Fallback a valor estático si existe
    return this.rifa.fechaSorteoFormato || '';
};

/**
 * Obtiene fecha formateada del presorteo - dinámicamente basada en fechaPresorteo
 */
window.rifaplusConfig.obtenerFechaPresorteoFormato = function() {
    if (!this.rifa) return '';
    
    // ✅ Si fecha ISO existe, formatear dinámicamente (siempre recalcula)
    if (this.rifa.fechaPresorteo) {
        return this.formatearFechaISO(this.rifa.fechaPresorteo);
    }
    
    // ⚠️ Fallback a valor estático si existe
    return this.rifa.fechaPresorteoFormato || '';
};

// ====================================
// FUNCIONES DE SINCRONIZACIÓN
// ====================================

/**
 * Sincroniza ganadores desde localStorage
 */
window.rifaplusConfig.sincronizarGanadores = function() {
    if (!window.GanadoresManager) {
        console.debug('⚠️ GanadoresManager no disponible');
        return false;
    }

    try {
        const ganadoresDelStorage = window.GanadoresManager.obtenerTodos();
        
        if (!ganadoresDelStorage || Object.keys(ganadoresDelStorage).length === 0) {
            console.debug('ℹ️ No hay ganadores registrados');
            return false;
        }

        const ganadesTransformados = {
            principal: this._transformarGanadoresTipo(ganadoresDelStorage.sorteo || []),
            presorte: this._transformarGanadoresTipo(ganadoresDelStorage.presorteo || []),
            ruletazo: this._transformarGanadoresTipo(ganadoresDelStorage.ruletazos || [])
        };

        this.sorteoActivo.ganadores = ganadesTransformados;
        console.log('✅ Ganadores sincronizados');
        return true;

    } catch (error) {
        console.warn('⚠️ Error sincronizando ganadores:', error);
        return false;
    }
};

/**
 * Transforma ganadores para el modal
 * @private
 */
window.rifaplusConfig._transformarGanadoresTipo = function(ganadores) {
    if (!Array.isArray(ganadores)) return [];

    return ganadores.map((ganador, index) => ({
        posicion: ganador.posicion || (index + 1),
        numeroOrden: this.formatearNumeroBoleto(ganador.numero),
        nombre: ganador.nombre_cliente || '-',
        apellido: ganador.apellido_cliente || '',
        nombreParcial: this._generarNombreParcial(ganador.nombre_cliente, ganador.apellido_cliente),
        ciudad: ganador.ciudad || '-',
        estado: ganador.estado_cliente || '-'
    }));
};

/**
 * Genera nombre parcial (iniciales)
 * @private
 */
window.rifaplusConfig._generarNombreParcial = function(nombre, apellido) {
    const partes = [];
    
    if (nombre && nombre.trim()) {
        const palabrasNombre = nombre.trim().split(/\s+/);
        partes.push(palabrasNombre[0][0].toUpperCase());
        if (palabrasNombre.length > 1) {
            partes.push(palabrasNombre[1][0].toUpperCase());
        }
    }
    
    if (apellido && apellido.trim()) {
        const palabrasApellido = apellido.trim().split(/\s+/);
        partes.push(palabrasApellido[0][0].toUpperCase());
    }
    
    return partes.join('.');
};

// ====================================
// FUNCIONES DE CÁLCULO (CRÍTICAS)
// ====================================

/**
 * Calcula descuento por cantidad de boletos
 */
window.rifaplusConfig.calcularDescuento = function(cantidadBoletos, precioUnitario = null) {
    precioUnitario = precioUnitario || this.rifa.precioBoleto;
    
    if (!this.rifa.descuentos || !this.rifa.descuentos.enabled) {
        return {
            descuentoAplicable: false,
            monto: 0,
            porcentaje: 0,
            subtotal: cantidadBoletos * precioUnitario,
            total: cantidadBoletos * precioUnitario
        };
    }

    const subtotal = cantidadBoletos * precioUnitario;
    const reglasNormalizadas = (this.rifa.descuentos.reglas || [])
        .map((regla) => {
            const cantidad = parseInt(regla?.cantidad, 10);
            const total = Number(regla?.total ?? regla?.precio);

            if (!Number.isFinite(cantidad) || cantidad <= 0 || !Number.isFinite(total) || total <= 0) {
                return null;
            }

            return {
                cantidad,
                total,
                precio: total
            };
        })
        .filter(Boolean);

    if (cantidadBoletos <= 0 || reglasNormalizadas.length === 0) {
        return {
            descuentoAplicable: false,
            monto: 0,
            porcentaje: 0,
            subtotal: subtotal,
            total: subtotal,
            regla: null,
            desglose: []
        };
    }

    const costoRegular = Number(precioUnitario);
    const dp = Array(cantidadBoletos + 1).fill(Infinity);
    const ruta = Array(cantidadBoletos + 1).fill(null);
    dp[0] = 0;

    const debePreferirNuevaRuta = (costoNuevo, costoActual, rutaActual, nuevaCantidad) => {
        if (costoNuevo < costoActual - 0.000001) return true;
        if (Math.abs(costoNuevo - costoActual) > 0.000001) return false;
        if (!rutaActual) return true;
        if (rutaActual.tipo !== 'regla') return true;
        return nuevaCantidad > (rutaActual.cantidad || 0);
    };

    for (let boletos = 1; boletos <= cantidadBoletos; boletos++) {
        const costoUnitario = dp[boletos - 1] + costoRegular;
        dp[boletos] = costoUnitario;
        ruta[boletos] = {
            previo: boletos - 1,
            tipo: 'regular',
            cantidad: 1,
            total: costoRegular
        };

        for (const regla of reglasNormalizadas) {
            if (boletos < regla.cantidad) continue;

            const costoConRegla = dp[boletos - regla.cantidad] + regla.total;
            if (debePreferirNuevaRuta(costoConRegla, dp[boletos], ruta[boletos], regla.cantidad)) {
                dp[boletos] = costoConRegla;
                ruta[boletos] = {
                    previo: boletos - regla.cantidad,
                    tipo: 'regla',
                    cantidad: regla.cantidad,
                    total: regla.total,
                    regla
                };
            }
        }
    }

    const totalConDescuento = Math.round(dp[cantidadBoletos] * 100) / 100;
    const montoDescuento = Math.round((subtotal - totalConDescuento) * 100) / 100;

    if (montoDescuento > 0) {
        const desglose = [];
        let cursor = cantidadBoletos;

        while (cursor > 0 && ruta[cursor]) {
            const paso = ruta[cursor];
            if (paso.tipo === 'regla' && paso.regla) {
                const existente = desglose.find((item) => item.cantidad === paso.regla.cantidad && item.total === paso.regla.total);
                if (existente) {
                    existente.veces += 1;
                } else {
                    desglose.push({
                        tipo: 'regla',
                        cantidad: paso.regla.cantidad,
                        total: paso.regla.total,
                        veces: 1
                    });
                }
            } else {
                const existente = desglose.find((item) => item.tipo === 'regular');
                if (existente) {
                    existente.cantidad += 1;
                    existente.total += costoRegular;
                } else {
                    desglose.push({
                        tipo: 'regular',
                        cantidad: 1,
                        total: costoRegular,
                        veces: 1
                    });
                }
            }
            cursor = paso.previo;
        }

        const reglasUsadas = desglose
            .filter((item) => item.tipo === 'regla')
            .sort((a, b) => b.cantidad - a.cantidad);

        return {
            descuentoAplicable: true,
            monto: montoDescuento,
            porcentaje: Math.round((montoDescuento / subtotal) * 100),
            subtotal: subtotal,
            total: totalConDescuento,
            regla: reglasUsadas[0] || null,
            desglose
        };
    }

    return {
        descuentoAplicable: false,
        monto: 0,
        porcentaje: 0,
        subtotal: subtotal,
        total: subtotal,
        regla: null,
        desglose: []
    };
};

/**
 * Calcula oportunidades (boletos sorpresa)
 */
window.rifaplusConfig.calcularOportunidades = function(cantidadBoletos) {
    if (!this.rifa.oportunidades || !this.rifa.oportunidades.enabled) {
        return {
            cantidad: 0,
            esValido: true,
            mensaje: 'Oportunidades deshabilitadas'
        };
    }

    const cantidadNormalizada = Number.parseInt(cantidadBoletos, 10);
    if (!Number.isInteger(cantidadNormalizada) || cantidadNormalizada < 1) {
        return {
            cantidad: 0,
            esValido: false,
            mensaje: 'Cantidad de boletos inválida'
        };
    }

    const multiplicador = Number.parseInt(this.rifa.oportunidades.multiplicador, 10);
    if (!Number.isInteger(multiplicador) || multiplicador < 1) {
        return {
            cantidad: 0,
            esValido: false,
            mensaje: 'Multiplicador de oportunidades inválido'
        };
    }

    const cantidadOportunidades = cantidadNormalizada * multiplicador;
    const rangoOculto = this.rifa.oportunidades.rango_oculto;
    if (rangoOculto && Number.isInteger(Number(rangoOculto.inicio)) && Number.isInteger(Number(rangoOculto.fin))) {
        const rangoDisponible = (Number(rangoOculto.fin) - Number(rangoOculto.inicio)) + 1;
        if (cantidadOportunidades > rangoDisponible) {
            return {
                cantidad: 0,
                esValido: false,
                mensaje: 'No hay suficientes oportunidades configuradas para esta compra'
            };
        }
    }

    return {
        cantidad: cantidadOportunidades,
        esValido: true,
        tipo: 'multiplicador'
    };
};

/**
 * Calcula resumen COMPLETO de compra
 */
window.rifaplusConfig.calcularResumenCompra = function(cantidadBoletos, precioUnitario = null) {
    precioUnitario = precioUnitario || this.rifa.precioBoleto;
    
    const descuento = this.calcularDescuento(cantidadBoletos, precioUnitario);
    const oportunidades = this.calcularOportunidades(cantidadBoletos);
    
    return {
        cantidadBoletos: cantidadBoletos,
        precioUnitario: precioUnitario,
        subtotal: descuento.subtotal,
        descuento: {
            aplicado: descuento.descuentoAplicable,
            monto: descuento.monto,
            porcentaje: descuento.porcentaje
        },
        total: descuento.total,
        oportunidades: {
            cantidad: oportunidades.cantidad,
            aplicado: oportunidades.cantidad > 0,
            tipo: oportunidades.tipo,
            esValido: oportunidades.esValido
        }
    };
};

/**
 * Valida que una compra sea válida
 */
window.rifaplusConfig.validarCompra = function(cantidadBoletos) {
    const errores = [];
    const advertencias = [];

    if (!cantidadBoletos || cantidadBoletos < 1) {
        errores.push('Debes seleccionar al menos 1 boleto');
    }

    if (cantidadBoletos > 10000) {
        advertencias.push('Compras muy grandes pueden requerir aprobación especial');
    }

    const oportunidades = this.calcularOportunidades(cantidadBoletos);
    if (!oportunidades.esValido) {
        errores.push(oportunidades.mensaje);
    }

    return {
        esValido: errores.length === 0,
        errores: errores,
        advertencias: advertencias
    };
};

// ====================================
// FUNCIONES AUXILIARES
// ====================================

/**
 * Obtiene rango máximo de boletos
 */
window.rifaplusConfig.obtenerRangoMaximoBoletos = function() {
    if (this.rifa.oportunidades && this.rifa.oportunidades.enabled && this.rifa.oportunidades.rango_visible) {
        return this.rifa.oportunidades.rango_visible.fin;
    }
    const total = this.obtenerTotalBoletos();
    return Math.max(0, total - 1);
};

/**
 * Obtiene rango mínimo de boletos
 */
window.rifaplusConfig.obtenerRangoMinimoBoletos = function() {
    if (this.rifa.oportunidades && this.rifa.oportunidades.enabled && this.rifa.oportunidades.rango_visible) {
        return this.rifa.oportunidades.rango_visible.inicio;
    }
    return 0;
};

/**
 * Obtiene el número máximo real a considerar para formateo
 * Incluye universo visible y oculto cuando oportunidades está habilitada
 */
window.rifaplusConfig.obtenerNumeroMaximoFormateo = function() {
    const candidatos = [];
    const total = Number(this.obtenerTotalBoletos());

    if (Number.isFinite(total) && total > 0) {
        candidatos.push(total - 1);
    }

    const rangoVisible = this.rifa?.oportunidades?.rango_visible;
    if (rangoVisible) {
        const finVisible = Number(rangoVisible.fin);
        if (Number.isFinite(finVisible) && finVisible >= 0) {
            candidatos.push(finVisible);
        }
    }

    const rangoOculto = this.rifa?.oportunidades?.rango_oculto;
    if (this.rifa?.oportunidades?.enabled === true && rangoOculto) {
        const finOculto = Number(rangoOculto.fin);
        if (Number.isFinite(finOculto) && finOculto >= 0) {
            candidatos.push(finOculto);
        }
    }

    return candidatos.length > 0 ? Math.max(...candidatos) : 0;
};

/**
 * Obtiene los dígitos dinámicos del universo real de numeración
 */
window.rifaplusConfig.obtenerDigitosNumeracion = function() {
    return Math.max(1, String(this.obtenerNumeroMaximoFormateo()).length);
};

/**
 * Formatea número de boleto con dígitos dinámicos
 */
window.rifaplusConfig.formatearNumeroBoleto = function(numero) {
    const digitos = this.obtenerDigitosNumeracion();
    const num = parseInt(numero, 10);
    
    if (isNaN(num) || num < 0) {
        console.warn(`⚠️ Número inválido: ${numero}`);
        return '?'.repeat(digitos);
    }
    
    return String(num).padStart(digitos, '0');
};

/**
 * Obtiene prefijo de orden
 */
window.rifaplusConfig.obtenerPrefijoOrden = function() {
    const rifaId = Number(this.rifa?.id || this._activeRifaId || 0);
    if (Number.isInteger(rifaId) && rifaId > 0) {
        return `S${rifaId}`;
    }
    return this.cliente.prefijoOrden;
};

window.rifaplusConfig.esOrdenIdOficial = function(ordenId) {
    const valor = String(ordenId || '').trim().toUpperCase();
    return /^[A-Z0-9]+(?:-[A-Z0-9]+)*-[A-Z]{2}\d{3}$/.test(valor);
};

window.rifaplusConfig.ordenIdTienePrefijoActual = function(ordenId) {
    const valor = String(ordenId || '').trim().toUpperCase();
    const prefijoActual = String(this.obtenerPrefijoOrden?.() || this.cliente.prefijoOrden || '').trim().toUpperCase();

    if (!valor || !prefijoActual) return false;
    return valor.startsWith(`${prefijoActual}-`);
};

/**
 * Reconstruye ID de orden con prefijo actual
 */
window.rifaplusConfig.reconstruirIdOrdenConPrefijoActual = function(ordenId) {
    const prefijoActual = String(this.obtenerPrefijoOrden?.() || this.cliente.prefijoOrden || '').trim().toUpperCase();
    if (!ordenId) return `${prefijoActual}-AA000`;
    
    if (!prefijoActual) return String(ordenId || '').trim().toUpperCase();
    
    if (ordenId.startsWith(prefijoActual + '-')) {
        return ordenId;
    }
    
    const secuenciaMatch = ordenId.match(/-(.+)$|^([A-Z0-9]+)$/);
    let secuencia = 'AA000';
    
    if (secuenciaMatch) {
        if (secuenciaMatch[1]) {
            secuencia = secuenciaMatch[1];
        } else if (secuenciaMatch[2]) {
            secuencia = secuenciaMatch[2];
        }
    }
    
    return `${prefijoActual}-${secuencia}`;
};

/**
 * Obtiene cuentas formateadas
 */
window.rifaplusConfig.obtenerCuentasFormateadas = function() {
    if (!Array.isArray(this.tecnica.bankAccounts) || this.tecnica.bankAccounts.length === 0) {
        return [];
    }
    return this.tecnica.bankAccounts.map(cuenta => ({
        ...cuenta,
        numeroMascarado: `****${cuenta.accountNumber.slice(-4)}`,
        enlaceWhatsapp: cuenta.phone ? `https://wa.me/${cuenta.phone.replace(/[^0-9]/g, '')}` : ''
    }));
};

/**
 * Genera URL para compartir orden
 */
window.rifaplusConfig.generarURLCompartir = function(ordenId) {
    const baseURL = window.location.origin;
    return `${baseURL}/mis-boletos.html?orden=${ordenId}`;
};

// ====================================
// INICIALIZACIÓN Y LOGGING
// ====================================

/**
 * ============================================================
 * GETTERS SEGUROS - Acceso robusta a valores críticos
 * Garantizan que siempre devuelvan valores válidos
 * ============================================================
 */

/**
 * Obtiene nombreSorteo de forma robusta
 * @returns {string} Nombre del sorteo (con fallback)
 */
window.rifaplusConfig.obtenerNombreSorteo = function() {
    const nombre = this.rifa?.nombreSorteo;
    if (nombre && typeof nombre === 'string' && nombre.trim().length > 0) {
        return nombre.trim();
    }
    return 'SORTEO EN VIVO';
};

/**
 * Obtiene totalBoletos de forma robusta
 * @returns {number} Total de boletos (con fallback)
 */
window.rifaplusConfig.obtenerTotalBoletos = function() {
    const total = this.rifa?.totalBoletos;
    if (typeof total === 'number' && !Number.isNaN(total) && total > 0) {
        return Math.floor(total);
    }

    try {
        const cacheKey = typeof construirClaveLocalRifaPlus === 'function' 
            ? construirClaveLocalRifaPlus('total_boletos_cache') 
            : 'rifaplus_total_boletos_cache';
        const cached = Number(localStorage.getItem(cacheKey) || localStorage.getItem('rifaplus_total_boletos_cache') || 0);
        if (Number.isFinite(cached) && cached > 0) {
            return Math.floor(cached);
        }
    } catch (error) {
        console.debug('ℹ️ No se pudo leer cache de totalBoletos:', error.message);
    }

    return 1000;
};

/**
 * Obtiene precioBoleto de forma robusta
 * @returns {number} Precio unitario (con fallback)
 */
window.rifaplusConfig.obtenerPrecioBoleto = function() {
    const slug = typeof obtenerSlugRifaDesdeUrlRifaPlus === 'function'
        ? obtenerSlugRifaDesdeUrlRifaPlus()
        : '';
    const cacheKey = slug || '__default__';
    const cache = this._configPublicaCache?.[cacheKey] || this._configPublicaCache;

    const candidatos = [
        this.rifa?.precioBoleto,
        cache?.rifa?.precioBoleto,
        cache?.precioBoleto
    ];

    for (const valor of candidatos) {
        const precio = Number(valor);
        if (Number.isFinite(precio) && precio > 0) {
            return precio;
        }
    }

    return 0;
};

/**
 * Obtiene edicionNombre de forma robusta
 * @returns {string} Nombre de la edición (con fallback)
 */
window.rifaplusConfig.obtenerEdicionNombre = function() {
    const edicion = this.rifa?.edicionNombre;
    if (edicion && typeof edicion === 'string' && edicion.trim().length > 0) {
        return edicion.trim();
    }
    return '';
};

/**
 * ============================================================
 * ACTUALIZADOR CENTRALIZADO - Nombre del Cliente
 * Actualiza TODOS los elementos que muestran cliente.nombre
 * Se llama automáticamente cuando sincroniza config
 * ============================================================
 */

window.rifaplusConfig.actualizarNombreClienteEnUI = function() {
    // ⚠️ IMPORTANTE: Usar el valor ACTUAL de this.cliente.nombre, no un fallback
    const nombreCliente = this.cliente?.nombre ? this.cliente.nombre.trim() : 'SORTEO';
    const sincronizacionCompleta = Boolean(this.cliente?.nombre && this.cliente.nombre.trim());
    
    // Si el nombre cambió, registrar en logs
    if (sincronizacionCompleta) {
        console.log('🔄 [UI-Update] Actualizando nombre del cliente en TODOS los elementos:', nombreCliente);
    } else {
        console.info('ℹ️ [UI-Update] Nombre aún no sincronizado; usando fallback temporal:', nombreCliente);
    }
    
    // 1️⃣ FOOTER - Todos los HTML que tienen id="footerNombre"
    const footerNombre = document.getElementById('footerNombre');
    if (footerNombre) {
        const anterior = footerNombre.textContent;
        footerNombre.textContent = nombreCliente;
        if (anterior !== nombreCliente) {
            console.log(`✅ [UI-Update] #footerNombre: "${anterior}" → "${nombreCliente}"`);
        }
    }
    
    // 2️⃣ FOOTER COPYRIGHT - Actualizar el copyright con el nombre
    const footerCopyright = document.getElementById('footerCopyright');
    if (footerCopyright) {
        const anio = this.cliente?.anioActual || new Date().getFullYear();
        const nuevoValor = `&copy; ${anio} <strong>${nombreCliente}</strong>. Todos los derechos reservados.`;
        if (footerCopyright.innerHTML !== nuevoValor) {
            footerCopyright.innerHTML = nuevoValor;
            console.log(`✅ [UI-Update] #footerCopyright actualizado`);
        }
    }
    
    // 3️⃣ ADMIN HEADER - admin-header-title-sub en cualquier página admin
    const adminHeaderTitle = document.querySelector('.admin-header-title-sub');
    if (adminHeaderTitle) {
        const anterior = adminHeaderTitle.textContent;
        adminHeaderTitle.textContent = nombreCliente;
        if (anterior !== nombreCliente) {
            console.log(`✅ [UI-Update] .admin-header-title-sub: "${anterior}" → "${nombreCliente}"`);
        }
    }
    
    // 4️⃣ ORDEN FORMAL - Si existe el elemento orden-organizador
    const ordenOrganizador = document.querySelector('.orden-organizador');
    if (ordenOrganizador) {
        const anterior = ordenOrganizador.textContent;
        ordenOrganizador.textContent = nombreCliente;
        if (anterior !== nombreCliente) {
            console.log(`✅ [UI-Update] .orden-organizador: "${anterior}" → "${nombreCliente}"`);
        }
    }
    
    // 5️⃣ FOOTER-BOTTOM - Si tiene el nombre del organizador
    const footerTextos = document.querySelectorAll('.footer-bottom p, .footer-bottom strong');
    footerTextos.forEach(el => {
        if (el.textContent.includes('SORTEO') || el.textContent.includes('SORTEOS') || el.textContent.includes('Sorteos')) {
            // Mantener el texto pero actualizar si es necesario
            if (el.textContent.includes('©')) {
                // Contiene copyright, actualizar solo el nombre
                const anterior = el.textContent;
                el.textContent = el.textContent.replace(/SORTEO\w*|SORTEOS\s+\w+|Sorteos\s+\w+/g, nombreCliente);
                if (anterior !== el.textContent) {
                    console.log(`✅ [UI-Update] Footer text actualizado`);
                }
            }
        }
    });

    // 6️⃣ HERO DE COMPRA - mantener sincronizado el nombre actual del sorteo
    const compraHeroTitle = document.getElementById('compraHeroTitle');
    if (compraHeroTitle) {
        const heroUtils = window.__RIFAPLUS_COMPRA_HERO_UTILS__;
        const fallbackTitulo = 'Estás a un paso de ser el próximo ganador';
        const compraHeroSub = document.getElementById('compraHeroSub');
        let nombreSorteoCache = '';

        try {
            nombreSorteoCache = String(
                localStorage.getItem(construirClaveLocalRifaPlus('compra_hero_sorteo'))
                || localStorage.getItem('rifaplus_compra_hero_sorteo')
                || ''
            ).trim();
        } catch (error) {
            // Ignorar errores de storage para no romper la UI.
        }

        const nombreSorteoHero = heroUtils?.resolverNombreSorteo
            ? heroUtils.resolverNombreSorteo(this.rifa?.nombreSorteo, window.__RIFAPLUS_COMPRA_HERO__?.nombreSorteo, nombreSorteoCache)
            : String(this.rifa?.nombreSorteo || '').trim();
        const estadoSiguiente = heroUtils?.construirEstadoHero
            ? heroUtils.construirEstadoHero(nombreSorteoHero, 'Elige tus boletos y participa ahora')
            : {
                nombreSorteo: nombreSorteoHero,
                titulo: fallbackTitulo,
                subtitulo: 'Elige tus boletos y participa ahora'
            };
        const estadoActual = {
            nombreSorteo: window.__RIFAPLUS_COMPRA_HERO__?.nombreSorteo,
            titulo: compraHeroTitle.textContent,
            subtitulo: compraHeroSub?.textContent || ''
        };
        const debeActualizarHero = heroUtils?.debeActualizarHero
            ? heroUtils.debeActualizarHero(estadoActual, estadoSiguiente)
            : !compraHeroTitle.textContent.trim();

        if (debeActualizarHero && compraHeroTitle.textContent !== estadoSiguiente.titulo) {
            compraHeroTitle.textContent = estadoSiguiente.titulo;
            console.log('✅ [UI-Update] #compraHeroTitle actualizado');
        }

        if (compraHeroSub && (!compraHeroSub.textContent.trim() || debeActualizarHero)) {
            compraHeroSub.textContent = estadoSiguiente.subtitulo;
        }

        if (estadoSiguiente.nombreSorteo) {
            try {
                localStorage.setItem(construirClaveLocalRifaPlus('compra_hero_sorteo'), estadoSiguiente.nombreSorteo);
                localStorage.setItem('rifaplus_compra_hero_sorteo', estadoSiguiente.nombreSorteo);
            } catch (error) {
                // Ignorar errores de storage para no romper la UI.
            }

            if (window.__RIFAPLUS_COMPRA_HERO__) {
                window.__RIFAPLUS_COMPRA_HERO__ = {
                    ...window.__RIFAPLUS_COMPRA_HERO__,
                    ...estadoSiguiente
                };
            }
        } else if (!compraHeroTitle.textContent.trim()) {
            compraHeroTitle.textContent = fallbackTitulo;
        }
    }
};

// Event listener para ganadores
window.addEventListener('ganadesoresActualizados', function() {
    console.debug('🔄 Sincronizando ganadores...');
    if (window.rifaplusConfig && typeof window.rifaplusConfig.sincronizarGanadores === 'function') {
        window.rifaplusConfig.sincronizarGanadores();
    }
});

console.log('✅ [SaDev Config v3.1.0] Inicializado (arquitectura sin duplicación)');
console.log('✅ [SaDev Config] Funciones, getters y métodos registrados');
console.log('✅ [SaDev Config] Datos se sincronizan desde /backend/config.json');
