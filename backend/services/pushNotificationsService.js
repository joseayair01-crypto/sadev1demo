const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const webPush = require('web-push');

const PUSH_STATUS_ACTIVE = 'active';
const PUSH_STATUS_REVOKED = 'revoked';
const PUSH_STATUS_EXPIRED = 'expired';
const PUSH_CAMPAIGN_AUDIENCE_ACTIVE = 'active';
const PUSH_CAMPAIGN_AUDIENCE_INACTIVE = 'inactive';
const RIFAPLUS_PUSH_TOPIC_PREFIX = 'rifaplus-orden-';
const PUSH_EVENT_TYPE_CONFIRMADA = 'orden_confirmada';
const PUSH_EVENT_TYPE_CANCELADA = 'orden_cancelada';
const PUSH_EVENT_TYPE_POR_VENCER = 'orden_por_vencer';
const PUSH_CAMPAIGN_EVENT_TYPE_NUEVA_RIFA = 'nueva_rifa_publicada';
const PUSH_CAMPAIGN_EVENT_TYPE_PRESORTEO_PROXIMO = 'presorteo_proximo';
const PUSH_CAMPAIGN_EVENT_TYPE_SORTEO_PROXIMO = 'sorteo_proximo';
const PUSH_CAMPAIGN_EVENT_TYPE_RESULTADOS_DISPONIBLES = 'resultados_disponibles';
const PUSH_RETRY_DELAYS_MS = [2000, 4000, 8000];
const PUSH_ORDER_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

let cachedConfigSignature = '';
const PUSH_PERMISSION_STATES = new Set(['granted', 'denied', 'default', 'prompt', 'unsupported']);

function esperarPush(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, Math.max(0, Number(ms) || 0));
    });
}

function base64UrlEncode(value) {
    return Buffer.from(String(value || ''), 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

function base64UrlDecode(value) {
    const normalized = String(value || '')
        .replace(/-/g, '+')
        .replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4 || 4)) % 4);
    return Buffer.from(padded, 'base64').toString('utf8');
}

function normalizarTelefonoPush(valor) {
    return String(valor || '').replace(/[^0-9]/g, '').trim();
}

function esBase64UrlValido(value) {
    const normalized = String(value || '').trim();
    if (!normalized || !/^[A-Za-z0-9_-]+$/.test(normalized)) {
        return false;
    }

    try {
        const padded = normalized + '='.repeat((4 - (normalized.length % 4 || 4)) % 4);
        const base64 = padded.replace(/-/g, '+').replace(/_/g, '/');
        return Buffer.from(base64, 'base64').length > 0;
    } catch (error) {
        return false;
    }
}

function normalizarPermissionStatePush(value, fallback = 'granted') {
    const normalized = String(value || '').trim().toLowerCase();
    if (PUSH_PERMISSION_STATES.has(normalized)) {
        return normalized;
    }

    const fallbackNormalized = String(fallback || 'granted').trim().toLowerCase();
    return PUSH_PERMISSION_STATES.has(fallbackNormalized) ? fallbackNormalized : 'granted';
}

function normalizarOrganizerKeyPush(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 120);
}

function emailEsValido(email) {
    const normalized = String(email || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(normalized)) {
        return false;
    }

    const domain = normalized.split('@')[1]?.toLowerCase() || '';
    if (!domain || domain.endsWith('.local') || domain === 'localhost') {
        return false;
    }

    return true;
}

function subjectPushEsValido(subject) {
    const normalized = String(subject || '').trim();
    if (!normalized) {
        return false;
    }

    if (normalized.startsWith('mailto:')) {
        return emailEsValido(normalized.slice('mailto:'.length));
    }

    try {
        const parsed = new URL(normalized);
        return ['https:', 'http:'].includes(parsed.protocol) && Boolean(parsed.hostname);
    } catch (error) {
        return false;
    }
}

function resolverFallbackSubjectDesdeConfig() {
    const candidatos = [
        process.env.PUSH_CONTACT_EMAIL,
        process.env.ADMIN_EMAIL,
        process.env.CLIENT_EMAIL,
        process.env.EMAIL_FROM
    ];

    try {
        const configPath = path.resolve(__dirname, '..', 'config.json');
        if (fs.existsSync(configPath)) {
            const configRaw = fs.readFileSync(configPath, 'utf8');
            const config = JSON.parse(configRaw);
            candidatos.push(
                config?.cliente?.email,
                config?.negocio?.email,
                config?.contacto?.email
            );
        }
    } catch (error) {
        // No bloquear el flujo push si config.json no está disponible.
    }

    const emailValido = candidatos.find(emailEsValido);
    return emailValido ? `mailto:${String(emailValido).trim()}` : 'mailto:admin@example.com';
}

function obtenerConfigPush() {
    const publicKey = String(process.env.PUSH_VAPID_PUBLIC_KEY || '').trim();
    const privateKey = String(process.env.PUSH_VAPID_PRIVATE_KEY || '').trim();
    const subjectRaw = String(process.env.PUSH_VAPID_SUBJECT || '').trim();
    const subject = subjectPushEsValido(subjectRaw)
        ? subjectRaw
        : resolverFallbackSubjectDesdeConfig();
    const tokenSecret = String(process.env.PUSH_TOKEN_SECRET || process.env.JWT_SECRET || '').trim();
    const enabled = Boolean(publicKey && privateKey && subject && tokenSecret);

    return {
        enabled,
        publicKey,
        privateKey,
        subject,
        subjectRaw,
        tokenSecret
    };
}

function asegurarConfiguracionWebPush() {
    const config = obtenerConfigPush();
    if (!config.enabled) {
        return config;
    }

    const signature = `${config.subject}|${config.publicKey}|${config.privateKey}`;
    if (cachedConfigSignature !== signature) {
        webPush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
        cachedConfigSignature = signature;
    }

    return config;
}

function normalizarSubscriptionPush(subscription = {}) {
    const endpoint = String(subscription?.endpoint || '').trim();
    const expirationTimeRaw = subscription?.expirationTime;
    const expirationTime = expirationTimeRaw === null || expirationTimeRaw === undefined
        ? null
        : Number(expirationTimeRaw);
    const p256dh = String(subscription?.keys?.p256dh || '').trim();
    const auth = String(subscription?.keys?.auth || '').trim();

    if (!endpoint || !p256dh || !auth) {
        return null;
    }

    if (endpoint.length > 2048 || p256dh.length > 512 || auth.length > 512) {
        return null;
    }

    if (!esBase64UrlValido(p256dh) || !esBase64UrlValido(auth)) {
        return null;
    }

    return {
        endpoint,
        expirationTime: Number.isFinite(expirationTime) ? expirationTime : null,
        keys: {
            p256dh,
            auth
        }
    };
}

function crearHashSubscriptionPush(subscription = {}) {
    const payload = `${subscription.endpoint || ''}|${subscription?.keys?.p256dh || ''}|${subscription?.keys?.auth || ''}`;
    return crypto.createHash('sha256').update(payload).digest('hex');
}

function crearTopicPushWeb(rawValue, fallback = 'rifaplus-push') {
    const normalized = String(rawValue || '').trim();
    if (normalized) {
        return crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 32);
    }

    return crypto.createHash('sha1').update(String(fallback || 'rifaplus-push')).digest('hex').slice(0, 32);
}

function esEndpointPushApple(endpoint) {
    const normalized = String(endpoint || '').trim().toLowerCase();
    return normalized.startsWith('https://web.push.apple.com/');
}

function esErrorPushReintentable(error) {
    const statusCode = Number(error?.statusCode || error?.status || 0);
    if ([408, 425, 429, 500, 502, 503, 504].includes(statusCode)) {
        return true;
    }

    const code = String(error?.code || '').trim().toUpperCase();
    if (['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND'].includes(code)) {
        return true;
    }

    const message = String(error?.message || error?.body || '').toLowerCase();
    return message.includes('timeout')
        || message.includes('timed out')
        || message.includes('temporar')
        || message.includes('try again later');
}

async function enviarNotificacionPushConRetry(subscription, payload, pushOptions, options = {}) {
    const sendNotification = typeof options.sendNotification === 'function'
        ? options.sendNotification
        : webPush.sendNotification.bind(webPush);
    const sleep = typeof options.sleep === 'function'
        ? options.sleep
        : esperarPush;
    const retryDelaysMs = Array.isArray(options.retryDelaysMs) && options.retryDelaysMs.length
        ? options.retryDelaysMs
        : PUSH_RETRY_DELAYS_MS;

    let lastError = null;

    for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
        try {
            return await sendNotification(subscription, payload, pushOptions);
        } catch (error) {
            lastError = error;
            const shouldRetry = attempt < retryDelaysMs.length && esErrorPushReintentable(error);
            if (!shouldRetry) {
                throw error;
            }

            await sleep(retryDelaysMs[attempt]);
        }
    }

    throw lastError || new Error('Push delivery failed');
}

function crearTokenOrdenPush(orden = {}) {
    const config = obtenerConfigPush();
    if (!config.tokenSecret) {
        return null;
    }

    const issuedAtMs = Date.now();
    const payload = {
        orden: String(orden.numero_orden || orden.id || '').trim().toUpperCase(),
        rifaId: Number.parseInt(orden.rifa_id, 10) || null,
        telefono: normalizarTelefonoPush(orden.telefono_cliente || orden.whatsapp || ''),
        createdAt: orden.created_at ? new Date(orden.created_at).toISOString() : null,
        iat: new Date(issuedAtMs).toISOString(),
        exp: new Date(issuedAtMs + PUSH_ORDER_TOKEN_TTL_MS).toISOString()
    };
    const payloadEncoded = base64UrlEncode(JSON.stringify(payload));
    const signature = crypto
        .createHmac('sha256', config.tokenSecret)
        .update(payloadEncoded)
        .digest('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');

    return `${payloadEncoded}.${signature}`;
}

function verificarTokenOrdenPush(token, orden = {}) {
    const config = obtenerConfigPush();
    if (!config.tokenSecret) {
        return { valido: false, reason: 'missing_secret' };
    }

    const rawToken = String(token || '').trim();
    if (!rawToken || !rawToken.includes('.')) {
        return { valido: false, reason: 'invalid_format' };
    }

    const [payloadEncoded, signature] = rawToken.split('.');
    if (!payloadEncoded || !signature) {
        return { valido: false, reason: 'invalid_parts' };
    }

    const expected = crypto
        .createHmac('sha256', config.tokenSecret)
        .update(payloadEncoded)
        .digest('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');

    const signatureBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (signatureBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
        return { valido: false, reason: 'invalid_signature' };
    }

    try {
        const payload = JSON.parse(base64UrlDecode(payloadEncoded));
        const nowMs = Date.now();
        const ordenEsperada = String(orden.numero_orden || orden.id || '').trim().toUpperCase();
        const telefonoEsperado = normalizarTelefonoPush(orden.telefono_cliente || orden.whatsapp || '');
        const createdAtEsperado = orden.created_at ? new Date(orden.created_at).toISOString() : null;
        const rifaEsperada = Number.parseInt(orden.rifa_id, 10) || null;
        const expirationRaw = String(payload?.exp || '').trim();
        const expirationMs = expirationRaw ? new Date(expirationRaw).getTime() : NaN;
        const legacyCreatedAtMs = payload?.createdAt ? new Date(payload.createdAt).getTime() : NaN;

        if (expirationRaw) {
            if (!Number.isFinite(expirationMs)) {
                return { valido: false, reason: 'invalid_expiration' };
            }

            if (nowMs > expirationMs) {
                return { valido: false, reason: 'expired_token' };
            }
        } else if (Number.isFinite(legacyCreatedAtMs) && (nowMs - legacyCreatedAtMs) > PUSH_ORDER_TOKEN_TTL_MS) {
            return { valido: false, reason: 'expired_legacy_token' };
        }

        if (
            String(payload?.orden || '').trim().toUpperCase() !== ordenEsperada
            || String(payload?.telefono || '').trim() !== telefonoEsperado
            || String(payload?.createdAt || '') !== String(createdAtEsperado || '')
            || (Number.parseInt(payload?.rifaId, 10) || null) !== rifaEsperada
        ) {
            return { valido: false, reason: 'payload_mismatch' };
        }

        return { valido: true, payload };
    } catch (error) {
        return { valido: false, reason: 'invalid_payload' };
    }
}

function construirMetadatosOrdenPushPublica(orden = {}) {
    const config = obtenerConfigPush();
    const numeroOrden = String(orden.numero_orden || orden.id || '').trim().toUpperCase();
    const telefono = normalizarTelefonoPush(orden.telefono_cliente || orden.whatsapp || '');
    const estado = String(orden.estado || '').trim().toLowerCase();
    const canSubscribe = config.enabled
        && Boolean(numeroOrden)
        && Boolean(telefono)
        && estado !== 'cancelada'
        && estado !== 'confirmada';

    return {
        enabled: config.enabled,
        canSubscribe,
        requiresUserGesture: true,
        statusTarget: 'confirmada',
        token: canSubscribe ? crearTokenOrdenPush(orden) : null
    };
}

function resolverOrganizerKeyPush(input = {}) {
    const candidates = [
        input?.organizerKey,
        input?.clienteId,
        input?.cliente?.id,
        input?.configuracion?.cliente?.id,
        input?.config?.cliente?.id,
        process.env.PUSH_ORGANIZER_KEY,
        process.env.CLIENT_ID
    ];

    const raw = candidates.find((candidate) => String(candidate || '').trim());
    return normalizarOrganizerKeyPush(raw || 'rifaplus');
}

function resolverFechaActividadCampanaPush(value, fallback = null) {
    const raw = value || fallback || null;
    if (!raw) {
        return null;
    }

    const parsed = raw instanceof Date ? raw : new Date(raw);
    if (!(parsed instanceof Date) || Number.isNaN(parsed.getTime())) {
        return null;
    }

    return parsed.toISOString();
}

function aplicarPlantillaCampanaPush(template, variables = {}, fallback = '') {
    const source = String(template || fallback || '').trim();
    return source.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => {
        const value = variables[key];
        return value === undefined || value === null ? '' : String(value);
    }).trim();
}

async function upsertSuscripcionPush(knex, data = {}) {
    const normalizedSubscription = normalizarSubscriptionPush(data.subscription);
    if (!normalizedSubscription) {
        throw new Error('INVALID_PUSH_SUBSCRIPTION');
    }

    const numeroOrden = String(data.numeroOrden || '').trim().toUpperCase();
    const rifaId = Number.parseInt(data.rifaId, 10) || null;
    if (!numeroOrden || !rifaId) {
        throw new Error('INVALID_PUSH_ORDER_CONTEXT');
    }

    const subscriptionHash = crearHashSubscriptionPush(normalizedSubscription);
    const payload = {
        rifa_id: rifaId,
        numero_orden: numeroOrden,
        telefono_cliente: normalizarTelefonoPush(data.telefonoCliente || ''),
        subscription_hash: subscriptionHash,
        endpoint: normalizedSubscription.endpoint,
        subscription: normalizedSubscription,
        user_agent: String(data.userAgent || '').slice(0, 2000) || null,
        permission_estado: normalizarPermissionStatePush(data.permissionState, 'granted'),
        status: PUSH_STATUS_ACTIVE,
        revoked_at: null,
        last_error: null,
        last_error_at: null,
        updated_at: knex.fn.now()
    };

    const lookup = {
        rifa_id: rifaId,
        numero_orden: numeroOrden,
        subscription_hash: subscriptionHash
    };
    const inserted = await knex('push_subscriptions')
        .insert({
            ...payload,
            created_at: knex.fn.now()
        })
        .onConflict(['rifa_id', 'numero_orden', 'subscription_hash'])
        .ignore()
        .returning('id');

    if (Array.isArray(inserted) && inserted.length > 0) {
        return { created: true, subscriptionHash };
    }

    await knex('push_subscriptions')
        .where(lookup)
        .update(payload);

    return { created: false, subscriptionHash };
}

async function desactivarSuscripcionPush(knex, data = {}) {
    const numeroOrden = String(data.numeroOrden || '').trim().toUpperCase();
    const rifaId = Number.parseInt(data.rifaId, 10) || null;
    const normalizedSubscription = normalizarSubscriptionPush(data.subscription || {});
    if (!numeroOrden || !rifaId || !normalizedSubscription) {
        throw new Error('INVALID_PUSH_UNSUBSCRIBE_CONTEXT');
    }

    const subscriptionHash = crearHashSubscriptionPush(normalizedSubscription);
    const updated = await knex('push_subscriptions')
        .where({
            rifa_id: rifaId,
            numero_orden: numeroOrden,
            subscription_hash: subscriptionHash
        })
        .where('status', PUSH_STATUS_ACTIVE)
        .update({
            status: PUSH_STATUS_REVOKED,
            revoked_at: knex.fn.now(),
            updated_at: knex.fn.now()
        });

    return { updated, subscriptionHash };
}

async function upsertSuscripcionCampanaPush(knex, data = {}) {
    const normalizedSubscription = normalizarSubscriptionPush(data.subscription);
    if (!normalizedSubscription) {
        throw new Error('INVALID_PUSH_CAMPAIGN_SUBSCRIPTION');
    }

    const organizerKey = resolverOrganizerKeyPush(data);
    const subscriptionHash = crearHashSubscriptionPush(normalizedSubscription);
    const existing = await knex('push_campaign_subscriptions')
        .where({
            organizer_key: organizerKey,
            subscription_hash: subscriptionHash
        })
        .first(
            'id',
            'status',
            'marketing_opt_in',
            'revoked_at',
            'last_purchase_at',
            'last_purchase_rifa_id',
            'last_purchase_rifa_slug',
            'audience_status'
        );
    const subscriptionState = resolverEstadoSuscripcionCampana(existing, data);
    const lastPurchaseAt = resolverFechaActividadCampanaPush(data.lastPurchaseAt, existing?.last_purchase_at);
    const lastPurchaseRifaId = Number.parseInt(data.lastPurchaseRifaId || data.sourceRifaId, 10)
        || Number.parseInt(existing?.last_purchase_rifa_id, 10)
        || null;
    const lastPurchaseRifaSlug = String(data.lastPurchaseRifaSlug || data.sourceRifaSlug || existing?.last_purchase_rifa_slug || '')
        .trim()
        .slice(0, 120) || null;
    const audienceStatus = subscriptionState.status === PUSH_STATUS_ACTIVE
        && subscriptionState.marketingOptIn !== false
        && (lastPurchaseAt || lastPurchaseRifaId || lastPurchaseRifaSlug)
        ? PUSH_CAMPAIGN_AUDIENCE_ACTIVE
        : (existing?.audience_status || PUSH_CAMPAIGN_AUDIENCE_INACTIVE);
    const payload = {
        organizer_key: organizerKey,
        telefono_cliente: normalizarTelefonoPush(data.telefonoCliente || ''),
        subscription_hash: subscriptionHash,
        endpoint: normalizedSubscription.endpoint,
        subscription: normalizedSubscription,
        user_agent: String(data.userAgent || '').slice(0, 2000) || null,
        permission_estado: normalizarPermissionStatePush(data.permissionState, 'granted'),
        status: subscriptionState.status,
        marketing_opt_in: subscriptionState.marketingOptIn,
        source_rifa_id: Number.parseInt(data.sourceRifaId, 10) || null,
        source_rifa_slug: String(data.sourceRifaSlug || '').trim().slice(0, 120) || null,
        source_numero_orden: String(data.sourceNumeroOrden || '').trim().toUpperCase().slice(0, 80) || null,
        audience_status: audienceStatus,
        last_purchase_at: lastPurchaseAt,
        last_purchase_rifa_id: lastPurchaseRifaId,
        last_purchase_rifa_slug: lastPurchaseRifaSlug,
        revoked_at: subscriptionState.preserveRevokedAt
            ? (existing?.revoked_at || knex.fn.now())
            : null,
        last_error: null,
        last_error_at: null,
        updated_at: knex.fn.now()
    };

    if (existing?.id) {
        await knex('push_campaign_subscriptions')
            .where({ id: existing.id })
            .update(payload);
        return { created: false, subscriptionHash, organizerKey };
    }

    const inserted = await knex('push_campaign_subscriptions')
        .insert({
            ...payload,
            created_at: knex.fn.now()
        })
        .onConflict(['organizer_key', 'subscription_hash'])
        .ignore()
        .returning('id');

    if (Array.isArray(inserted) && inserted.length > 0) {
        return { created: true, subscriptionHash, organizerKey };
    }

    await knex('push_campaign_subscriptions')
        .where({
            organizer_key: organizerKey,
            subscription_hash: subscriptionHash
        })
        .update(payload);

    return { created: false, subscriptionHash, organizerKey };
}

async function desactivarSuscripcionCampanaPush(knex, data = {}) {
    const organizerKey = resolverOrganizerKeyPush(data);
    const normalizedSubscription = normalizarSubscriptionPush(data.subscription || {});
    if (!organizerKey || !normalizedSubscription) {
        throw new Error('INVALID_PUSH_CAMPAIGN_UNSUBSCRIBE_CONTEXT');
    }

    const subscriptionHash = crearHashSubscriptionPush(normalizedSubscription);
    const updated = await knex('push_campaign_subscriptions')
        .where({
            organizer_key: organizerKey,
            subscription_hash: subscriptionHash
        })
        .where('status', PUSH_STATUS_ACTIVE)
        .update({
            status: PUSH_STATUS_REVOKED,
            marketing_opt_in: false,
            revoked_at: knex.fn.now(),
            updated_at: knex.fn.now()
        });

    return { updated, subscriptionHash, organizerKey };
}

function resolverEstadoSuscripcionCampana(existing = null, data = {}) {
    const requestedMarketingOptIn = data.marketingOptIn !== false;
    const preserveOptOut = data.preserveOptOut === true;
    const existingRevoked = String(existing?.status || '').trim().toLowerCase() === PUSH_STATUS_REVOKED;
    const existingOptedOut = existingRevoked || existing?.marketing_opt_in === false;

    if (preserveOptOut && existingOptedOut) {
        return {
            status: PUSH_STATUS_REVOKED,
            marketingOptIn: false,
            preserveRevokedAt: true
        };
    }

    return {
        status: PUSH_STATUS_ACTIVE,
        marketingOptIn: requestedMarketingOptIn,
        preserveRevokedAt: false
    };
}

function construirUrlMisBoletosPush(orden = {}, opciones = {}) {
    const numeroOrden = String(orden.numero_orden || orden.id || '').trim().toUpperCase();
    const autoOpen = opciones.autoOpen !== false;
    const rifaSlug = String(
        orden.rifa_slug
        || orden.rifaSlug
        || opciones.rifaSlug
        || ''
    ).trim();
    const rifaId = Number.parseInt(
        orden.rifa_id
        || orden.rifaId
        || opciones.rifaId,
        10
    ) || null;

    const query = [];
    if (numeroOrden) query.push(`ordenId=${encodeURIComponent(numeroOrden)}`);
    if (autoOpen) query.push('autoOpen=true');
    if (rifaSlug) {
        query.push(`rifa=${encodeURIComponent(rifaSlug)}`);
    } else if (rifaId) {
        query.push(`rifa_id=${encodeURIComponent(String(rifaId))}`);
    }

    return `/mis-boletos.html${query.length ? `?${query.join('&')}` : ''}`;
}

function construirPayloadPushOrdenConfirmada(orden = {}) {
    const numeroOrden = String(orden.numero_orden || orden.id || '').trim().toUpperCase();
    const cantidadBoletos = Number(orden.cantidad_boletos || 0) || 0;
    const logoUrl = String(orden.logo || orden.logotipo || '/images/placeholder-logo.svg').trim() || '/images/placeholder-logo.svg';
    const destinationUrl = construirUrlMisBoletosPush(orden, { autoOpen: true });

    return {
        type: PUSH_EVENT_TYPE_CONFIRMADA,
        orderId: numeroOrden,
        title: 'Pago confirmado',
        body: cantidadBoletos > 0
            ? `Tu orden ${numeroOrden} fue confirmada. Tus ${cantidadBoletos} boletos ya están listos.`
            : `Tu orden ${numeroOrden} fue confirmada. Tus boletos ya están listos.`,
        url: destinationUrl,
        tag: `${RIFAPLUS_PUSH_TOPIC_PREFIX}${numeroOrden}`,
        requireInteraction: true,
        renotify: true,
        silent: false,
        icon: logoUrl,
        badge: '/images/placeholder-logo.svg',
        data: {
            orderId: numeroOrden,
            status: 'confirmada'
        }
    };
}

function construirPayloadPushOrdenCancelada(orden = {}, options = {}) {
    const numeroOrden = String(orden.numero_orden || orden.id || '').trim().toUpperCase();
    const logoUrl = String(orden.logo || orden.logotipo || '/images/placeholder-logo.svg').trim() || '/images/placeholder-logo.svg';
    const destinationUrl = construirUrlMisBoletosPush(orden, { autoOpen: true });
    const cancelReason = String(options.reason || 'manual').trim().toLowerCase();
    const reasonLabel = cancelReason === 'expired'
        ? 'Tu orden venció porque no recibimos tu pago a tiempo.'
        : 'Tu orden fue cancelada por el organizador.';

    return {
        type: PUSH_EVENT_TYPE_CANCELADA,
        orderId: numeroOrden,
        title: 'Orden cancelada',
        body: `${reasonLabel} Si todavía te interesa participar, puedes generar una nueva orden.`,
        url: destinationUrl,
        tag: `${RIFAPLUS_PUSH_TOPIC_PREFIX}${numeroOrden}-cancelada`,
        requireInteraction: true,
        renotify: true,
        silent: false,
        icon: logoUrl,
        badge: '/images/placeholder-logo.svg',
        data: {
            orderId: numeroOrden,
            status: 'cancelada',
            reason: cancelReason
        }
    };
}

function construirPayloadPushOrdenPorVencer(orden = {}, options = {}) {
    const numeroOrden = String(orden.numero_orden || orden.id || '').trim().toUpperCase();
    const logoUrl = String(orden.logo || orden.logotipo || '/images/placeholder-logo.svg').trim() || '/images/placeholder-logo.svg';
    const destinationUrl = construirUrlMisBoletosPush(orden, { autoOpen: true });
    const warningMinutes = Math.max(1, Number.parseInt(options.warningMinutes, 10) || 0);
    const plural = warningMinutes === 1 ? '' : 's';

    return {
        type: PUSH_EVENT_TYPE_POR_VENCER,
        orderId: numeroOrden,
        title: 'Tu orden está por vencer',
        body: `A tu orden ${numeroOrden} le quedan menos de ${warningMinutes} minuto${plural}. Completa tu pago para no perder tus boletos.`,
        url: destinationUrl,
        tag: `${RIFAPLUS_PUSH_TOPIC_PREFIX}${numeroOrden}-por-vencer-${warningMinutes}`,
        requireInteraction: warningMinutes <= 15,
        renotify: true,
        silent: false,
        icon: logoUrl,
        badge: '/images/placeholder-logo.svg',
        data: {
            orderId: numeroOrden,
            status: 'pendiente',
            warningMinutes
        }
    };
}

function construirPayloadPushNuevaRifaDisponible(campaign = {}) {
    const organizerName = String(campaign.organizerName || 'tu organizador').trim();
    const rifaNombre = String(campaign.rifaNombre || 'un nuevo sorteo').trim();
    const rifaSlug = String(campaign.rifaSlug || '').trim();
    const baseUrl = String(campaign.customUrl || campaign.publicUrl || '').trim() || '/';
    const destinationUrl = rifaSlug && !/[?&](rifa|slug)=/i.test(baseUrl)
        ? `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}rifa=${encodeURIComponent(rifaSlug)}`
        : baseUrl;
    const icon = String(campaign.logo || campaign.logotipo || '/images/placeholder-logo.svg').trim() || '/images/placeholder-logo.svg';
    const variables = {
        organizerName,
        rifaNombre,
        rifaSlug
    };
    const defaultTitle = 'Nuevo sorteo disponible';
    const defaultBody = `${organizerName} ya abrió ${rifaNombre}. Entra ahora y aparta tus boletos.`;
    const title = aplicarPlantillaCampanaPush(campaign.title, variables, defaultTitle) || defaultTitle;
    const body = aplicarPlantillaCampanaPush(campaign.body, variables, defaultBody) || defaultBody;

    return {
        type: PUSH_CAMPAIGN_EVENT_TYPE_NUEVA_RIFA,
        title,
        body,
        url: destinationUrl,
        tag: `rifaplus-campaign-${String(campaign.rifaId || rifaSlug || 'nueva-rifa')}`,
        requireInteraction: true,
        renotify: true,
        silent: false,
        icon,
        badge: '/images/placeholder-logo.svg',
        data: {
            rifaId: Number.parseInt(campaign.rifaId, 10) || null,
            rifaSlug,
            campaignType: PUSH_CAMPAIGN_EVENT_TYPE_NUEVA_RIFA
        }
    };
}

function construirPayloadPushRecordatorioEvento(campaign = {}) {
    const eventType = String(campaign.eventType || PUSH_CAMPAIGN_EVENT_TYPE_SORTEO_PROXIMO).trim();
    const organizerName = String(campaign.organizerName || 'tu organizador').trim();
    const rifaNombre = String(campaign.rifaNombre || 'tu sorteo').trim();
    const rifaSlug = String(campaign.rifaSlug || '').trim();
    const eventLabel = eventType === PUSH_CAMPAIGN_EVENT_TYPE_PRESORTEO_PROXIMO ? 'presorteo' : 'sorteo';
    const minutes = Math.max(1, Number.parseInt(campaign.warningMinutes, 10) || 0);
    const plural = minutes === 1 ? '' : 's';
    const baseUrl = String(campaign.customUrl || campaign.publicUrl || '').trim() || '/';
    const destinationUrl = rifaSlug && !/[?&](rifa|slug)=/i.test(baseUrl)
        ? `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}rifa=${encodeURIComponent(rifaSlug)}`
        : baseUrl;
    const icon = String(campaign.logo || campaign.logotipo || '/images/placeholder-logo.svg').trim() || '/images/placeholder-logo.svg';
    const eventDate = campaign.eventDate ? new Date(campaign.eventDate) : null;
    const eventDateLabel = eventDate instanceof Date && !Number.isNaN(eventDate.getTime())
        ? eventDate.toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' })
        : '';

    const defaultTitle = eventType === PUSH_CAMPAIGN_EVENT_TYPE_PRESORTEO_PROXIMO
        ? 'Tu presorteo está por iniciar'
        : 'Tu sorteo está por iniciar';
    const defaultBody = eventDateLabel
        ? `${organizerName} arranca ${eventLabel === 'presorteo' ? 'el presorteo' : 'el sorteo'} de ${rifaNombre} en menos de ${minutes} minuto${plural}. Entra para estar al pendiente de los resultados (${eventDateLabel}).`
        : `${organizerName} arranca ${eventLabel === 'presorteo' ? 'el presorteo' : 'el sorteo'} de ${rifaNombre} en menos de ${minutes} minuto${plural}. Entra para estar al pendiente de los resultados.`;

    return {
        type: eventType,
        title: defaultTitle,
        body: defaultBody,
        url: destinationUrl,
        tag: `rifaplus-campaign-${eventType}-${String(campaign.rifaId || rifaSlug || 'evento')}`,
        requireInteraction: minutes <= 15,
        renotify: true,
        silent: false,
        icon,
        badge: '/images/placeholder-logo.svg',
        data: {
            rifaId: Number.parseInt(campaign.rifaId, 10) || null,
            rifaSlug,
            campaignType: eventType,
            warningMinutes: minutes,
            eventDate: campaign.eventDate || null
        }
    };
}

function construirPayloadPushResultadosDisponibles(campaign = {}) {
    const organizerName = String(campaign.organizerName || 'tu organizador').trim();
    const rifaNombre = String(campaign.rifaNombre || 'tu sorteo').trim();
    const rifaSlug = String(campaign.rifaSlug || '').trim();
    const baseUrl = String(campaign.customUrl || campaign.publicUrl || '').trim() || '/';
    const destinationUrl = rifaSlug && !/[?&](rifa|slug)=/i.test(baseUrl)
        ? `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}rifa=${encodeURIComponent(rifaSlug)}`
        : baseUrl;
    const icon = String(campaign.logo || campaign.logotipo || '/images/placeholder-logo.svg').trim() || '/images/placeholder-logo.svg';
    const resultsCount = Math.max(0, Number.parseInt(campaign.resultsCount, 10) || 0);
    const defaultTitle = 'Resultados disponibles';
    const defaultBody = resultsCount > 0
        ? `${organizerName} ya publicó ${resultsCount} resultado${resultsCount === 1 ? '' : 's'} de ${rifaNombre}. Entra a revisar si ganaste.`
        : `${organizerName} ya publicó los resultados de ${rifaNombre}. Entra a revisar si ganaste.`;

    return {
        type: PUSH_CAMPAIGN_EVENT_TYPE_RESULTADOS_DISPONIBLES,
        title: defaultTitle,
        body: defaultBody,
        url: destinationUrl,
        tag: `rifaplus-campaign-resultados-${String(campaign.rifaId || rifaSlug || 'evento')}`,
        requireInteraction: true,
        renotify: true,
        silent: false,
        icon,
        badge: '/images/placeholder-logo.svg',
        data: {
            rifaId: Number.parseInt(campaign.rifaId, 10) || null,
            rifaSlug,
            campaignType: PUSH_CAMPAIGN_EVENT_TYPE_RESULTADOS_DISPONIBLES,
            resultsCount
        }
    };
}

function construirPayloadEventoPushOrden(eventType, orden = {}, options = {}) {
    switch (eventType) {
    case PUSH_EVENT_TYPE_CONFIRMADA:
        return construirPayloadPushOrdenConfirmada(orden);
    case PUSH_EVENT_TYPE_CANCELADA:
        return construirPayloadPushOrdenCancelada(orden, options);
    case PUSH_EVENT_TYPE_POR_VENCER:
        return construirPayloadPushOrdenPorVencer(orden, options);
    default:
        throw new Error(`UNKNOWN_PUSH_EVENT_TYPE:${eventType}`);
    }
}

async function buscarEventoPushEnviado(knex, { rifaId, numeroOrden, eventKey }) {
    if (!rifaId || !numeroOrden || !eventKey) {
        return null;
    }

    return knex('push_notification_events')
        .where({
            rifa_id: rifaId,
            numero_orden: numeroOrden,
            event_key: eventKey
        })
        .first('id', 'event_type', 'event_key', 'sent_at', 'delivered_count');
}

async function registrarEventoPushEnviado(knex, data = {}) {
    const payload = {
        rifa_id: Number.parseInt(data.rifaId, 10) || null,
        numero_orden: String(data.numeroOrden || '').trim().toUpperCase(),
        event_type: String(data.eventType || '').trim(),
        event_key: String(data.eventKey || '').trim(),
        payload: data.payload || null,
        total_targets: Number.parseInt(data.totalTargets, 10) || 0,
        delivered_count: Number.parseInt(data.deliveredCount, 10) || 0,
        failed_count: Number.parseInt(data.failedCount, 10) || 0,
        expired_count: Number.parseInt(data.expiredCount, 10) || 0,
        sent_at: data.sentAt || knex.fn.now(),
        updated_at: knex.fn.now()
    };

    if (!payload.rifa_id || !payload.numero_orden || !payload.event_type || !payload.event_key) {
        throw new Error('INVALID_PUSH_EVENT_RECORD');
    }

    const inserted = await knex('push_notification_events')
        .insert({
            ...payload,
            created_at: knex.fn.now()
        })
        .onConflict(['rifa_id', 'numero_orden', 'event_key'])
        .ignore()
        .returning('id');

    if (Array.isArray(inserted) && inserted.length > 0) {
        return {
            created: true,
            id: inserted[0]?.id || inserted[0]
        };
    }

    const existing = await buscarEventoPushEnviado(knex, {
        rifaId: payload.rifa_id,
        numeroOrden: payload.numero_orden,
        eventKey: payload.event_key
    });

    if (existing?.id) {
        await knex('push_notification_events')
            .where({ id: existing.id })
            .update(payload);
        return { created: false, id: existing.id };
    }

    return {
        created: false,
        id: null
    };
}

async function buscarEventoCampanaPushEnviado(knex, { organizerKey, eventKey }) {
    if (!organizerKey || !eventKey) {
        return null;
    }

    return knex('push_campaign_events')
        .where({
            organizer_key: organizerKey,
            event_key: eventKey
        })
        .first('id', 'event_type', 'event_key', 'sent_at', 'delivered_count');
}

async function registrarEventoCampanaPushEnviado(knex, data = {}) {
    const payload = {
        organizer_key: resolverOrganizerKeyPush(data),
        event_type: String(data.eventType || '').trim(),
        event_key: String(data.eventKey || '').trim(),
        target_rifa_id: Number.parseInt(data.targetRifaId, 10) || null,
        target_rifa_slug: String(data.targetRifaSlug || '').trim().slice(0, 120) || null,
        payload: data.payload || null,
        total_targets: Number.parseInt(data.totalTargets, 10) || 0,
        delivered_count: Number.parseInt(data.deliveredCount, 10) || 0,
        failed_count: Number.parseInt(data.failedCount, 10) || 0,
        expired_count: Number.parseInt(data.expiredCount, 10) || 0,
        sent_at: data.sentAt || knex.fn.now(),
        updated_at: knex.fn.now()
    };

    if (!payload.organizer_key || !payload.event_type || !payload.event_key) {
        throw new Error('INVALID_PUSH_CAMPAIGN_EVENT_RECORD');
    }

    const inserted = await knex('push_campaign_events')
        .insert({
            ...payload,
            created_at: knex.fn.now()
        })
        .onConflict(['organizer_key', 'event_key'])
        .ignore()
        .returning('id');

    if (Array.isArray(inserted) && inserted.length > 0) {
        return {
            created: true,
            id: inserted[0]?.id || inserted[0]
        };
    }

    const existing = await buscarEventoCampanaPushEnviado(knex, {
        organizerKey: payload.organizer_key,
        eventKey: payload.event_key
    });

    if (existing?.id) {
        await knex('push_campaign_events')
            .where({ id: existing.id })
            .update(payload);
        return { created: false, id: existing.id };
    }

    return {
        created: false,
        id: null
    };
}

async function marcarSuscripcionComoInvalida(knex, subscriptionId, status, errorMessage) {
    if (!subscriptionId) return;
    await knex('push_subscriptions')
        .where({ id: subscriptionId })
        .update({
            status,
            revoked_at: knex.fn.now(),
            last_error: String(errorMessage || '').slice(0, 2000) || null,
            last_error_at: knex.fn.now(),
            updated_at: knex.fn.now()
        });
}

async function marcarSuscripcionNotificada(knex, subscriptionId) {
    if (!subscriptionId) return;
    await knex('push_subscriptions')
        .where({ id: subscriptionId })
        .update({
            last_notified_at: knex.fn.now(),
            last_error: null,
            last_error_at: null,
            updated_at: knex.fn.now()
        });
}

async function registrarErrorSuscripcion(knex, subscriptionId, errorMessage) {
    if (!subscriptionId) return;
    await knex('push_subscriptions')
        .where({ id: subscriptionId })
        .update({
            last_error: String(errorMessage || '').slice(0, 2000) || null,
            last_error_at: knex.fn.now(),
            updated_at: knex.fn.now()
        });
}

async function enviarPushOrdenConfirmada(knex, orden = {}) {
    const options = arguments[2] || {};
    const eventAt = options.eventAt || orden.updated_at || new Date().toISOString();
    const eventKeyBase = `${PUSH_EVENT_TYPE_CONFIRMADA}:${new Date(eventAt).toISOString()}`;
    return enviarPushEventoOrden(knex, orden, PUSH_EVENT_TYPE_CONFIRMADA, {
        ...options,
        eventKey: options.eventKey || (options.testMode
            ? `${eventKeyBase}:test:${Date.now()}`
            : eventKeyBase)
    });
}

async function enviarPushOrdenCancelada(knex, orden = {}, options = {}) {
    const reason = String(options.reason || 'manual').trim().toLowerCase();
    const eventAt = options.eventAt || orden.updated_at || new Date().toISOString();
    const eventKeyBase = `${PUSH_EVENT_TYPE_CANCELADA}:${reason}:${new Date(eventAt).toISOString()}`;
    return enviarPushEventoOrden(knex, orden, PUSH_EVENT_TYPE_CANCELADA, {
        ...options,
        reason,
        eventKey: options.eventKey || (options.testMode
            ? `${eventKeyBase}:test:${Date.now()}`
            : eventKeyBase)
    });
}

async function enviarPushOrdenPorVencer(knex, orden = {}, options = {}) {
    const warningMinutes = Math.max(1, Number.parseInt(options.warningMinutes, 10) || 0);
    if (!warningMinutes) {
        throw new Error('INVALID_PUSH_WARNING_MINUTES');
    }

    return enviarPushEventoOrden(knex, orden, PUSH_EVENT_TYPE_POR_VENCER, {
        ...options,
        warningMinutes,
        eventKey: options.eventKey || (options.testMode
            ? `${PUSH_EVENT_TYPE_POR_VENCER}:${warningMinutes}:test:${Date.now()}`
            : `${PUSH_EVENT_TYPE_POR_VENCER}:${warningMinutes}`)
    });
}

async function enviarPushNuevaRifaDisponible(knex, campaign = {}) {
    const config = asegurarConfiguracionWebPush();
    const organizerKey = resolverOrganizerKeyPush(campaign);
    const targetRifaId = Number.parseInt(campaign.rifaId, 10) || null;
    const targetRifaSlug = String(campaign.rifaSlug || '').trim();
    const eventKey = `${PUSH_CAMPAIGN_EVENT_TYPE_NUEVA_RIFA}:rifa:${targetRifaId || targetRifaSlug || 'sin-id'}`;

    if (!config.enabled || !organizerKey) {
        return {
            enabled: false,
            eventType: PUSH_CAMPAIGN_EVENT_TYPE_NUEVA_RIFA,
            organizerKey,
            delivered: 0,
            failed: 0,
            expired: 0,
            total: 0
        };
    }

    const previo = await buscarEventoCampanaPushEnviado(knex, { organizerKey, eventKey });
    if (previo?.id) {
        return {
            enabled: true,
            eventType: PUSH_CAMPAIGN_EVENT_TYPE_NUEVA_RIFA,
            organizerKey,
            eventKey,
            skipped: true,
            reason: 'already_sent',
            delivered: Number.parseInt(previo.delivered_count, 10) || 0,
            failed: 0,
            expired: 0,
            total: 0
        };
    }

    const subscriptions = await knex('push_campaign_subscriptions')
        .select('id', 'subscription', 'endpoint')
        .where({
            organizer_key: organizerKey,
            status: PUSH_STATUS_ACTIVE,
            marketing_opt_in: true
        });

    if (!subscriptions.length) {
        return {
            enabled: true,
            eventType: PUSH_CAMPAIGN_EVENT_TYPE_NUEVA_RIFA,
            organizerKey,
            eventKey,
            delivered: 0,
            failed: 0,
            expired: 0,
            total: 0
        };
    }

    const payloadData = construirPayloadPushNuevaRifaDisponible(campaign);
    const payload = JSON.stringify(payloadData);
    const summary = {
        enabled: true,
        eventType: PUSH_CAMPAIGN_EVENT_TYPE_NUEVA_RIFA,
        organizerKey,
        eventKey,
        delivered: 0,
        failed: 0,
        expired: 0,
        total: subscriptions.length
    };

    for (const subscriptionRow of subscriptions) {
        const subscription = normalizarSubscriptionPush(subscriptionRow.subscription);
        if (!subscription) {
            await knex('push_campaign_subscriptions')
                .where({ id: subscriptionRow.id })
                .update({
                    status: PUSH_STATUS_EXPIRED,
                    revoked_at: knex.fn.now(),
                    last_error: 'Suscripcion inválida',
                    last_error_at: knex.fn.now(),
                    updated_at: knex.fn.now()
                });
            summary.expired += 1;
            continue;
        }

        try {
            const pushOptions = {
                TTL: 60 * 60 * 24,
                urgency: 'high',
                timeout: 10000
            };

            if (!esEndpointPushApple(subscription.endpoint)) {
                pushOptions.topic = `rifaplus-campaign-${String(targetRifaId || targetRifaSlug || 'nueva-rifa')}`.slice(0, 32);
            }

            await enviarNotificacionPushConRetry(subscription, payload, pushOptions, {
                retryDelaysMs: campaign.retryDelaysMs,
                sendNotification: campaign.sendNotification,
                sleep: campaign.sleep
            });
            await knex('push_campaign_subscriptions')
                .where({ id: subscriptionRow.id })
                .update({
                    last_notified_at: knex.fn.now(),
                    last_error: null,
                    last_error_at: null,
                    updated_at: knex.fn.now()
                });
            summary.delivered += 1;
        } catch (error) {
            const statusCode = Number(error?.statusCode || error?.status || 0);
            const message = error?.body || error?.message || 'Push delivery failed';
            if (statusCode === 404 || statusCode === 410) {
                await knex('push_campaign_subscriptions')
                    .where({ id: subscriptionRow.id })
                    .update({
                        status: PUSH_STATUS_EXPIRED,
                        revoked_at: knex.fn.now(),
                        last_error: String(message).slice(0, 2000),
                        last_error_at: knex.fn.now(),
                        updated_at: knex.fn.now()
                    });
                summary.expired += 1;
            } else {
                await knex('push_campaign_subscriptions')
                    .where({ id: subscriptionRow.id })
                    .update({
                        last_error: String(message).slice(0, 2000),
                        last_error_at: knex.fn.now(),
                        updated_at: knex.fn.now()
                    });
                summary.failed += 1;
            }
        }
    }

    if (summary.delivered > 0) {
        await registrarEventoCampanaPushEnviado(knex, {
            organizerKey,
            eventType: PUSH_CAMPAIGN_EVENT_TYPE_NUEVA_RIFA,
            eventKey,
            targetRifaId,
            targetRifaSlug,
            payload: payloadData,
            totalTargets: summary.total,
            deliveredCount: summary.delivered,
            failedCount: summary.failed,
            expiredCount: summary.expired
        });
    }

    return summary;
}

async function enviarPushEventoCampana(knex, campaign = {}) {
    const config = asegurarConfiguracionWebPush();
    const organizerKey = resolverOrganizerKeyPush(campaign);
    const targetRifaId = Number.parseInt(campaign.rifaId, 10) || null;
    const targetRifaSlug = String(campaign.rifaSlug || '').trim();
    const eventType = String(campaign.eventType || '').trim();
    const eventKey = String(campaign.eventKey || '').trim();

    if (!config.enabled || !organizerKey || !eventType || !eventKey) {
        return {
            enabled: false,
            eventType,
            organizerKey,
            delivered: 0,
            failed: 0,
            expired: 0,
            total: 0
        };
    }

    const previo = await buscarEventoCampanaPushEnviado(knex, { organizerKey, eventKey });
    if (previo?.id) {
        return {
            enabled: true,
            eventType,
            organizerKey,
            eventKey,
            skipped: true,
            reason: 'already_sent',
            delivered: Number.parseInt(previo.delivered_count, 10) || 0,
            failed: 0,
            expired: 0,
            total: 0
        };
    }

    const subscriptions = await knex('push_campaign_subscriptions')
        .select('id', 'subscription', 'endpoint')
        .where({
            organizer_key: organizerKey,
            status: PUSH_STATUS_ACTIVE,
            marketing_opt_in: true
        });

    if (!subscriptions.length) {
        return {
            enabled: true,
            eventType,
            organizerKey,
            eventKey,
            delivered: 0,
            failed: 0,
            expired: 0,
            total: 0
        };
    }

    const payloadData = eventType === PUSH_CAMPAIGN_EVENT_TYPE_RESULTADOS_DISPONIBLES
        ? construirPayloadPushResultadosDisponibles(campaign)
        : construirPayloadPushRecordatorioEvento(campaign);
    const payload = JSON.stringify(payloadData);
    const summary = {
        enabled: true,
        eventType,
        organizerKey,
        eventKey,
        delivered: 0,
        failed: 0,
        expired: 0,
        total: subscriptions.length
    };

    for (const subscriptionRow of subscriptions) {
        const subscription = normalizarSubscriptionPush(subscriptionRow.subscription);
        if (!subscription) {
            await knex('push_campaign_subscriptions')
                .where({ id: subscriptionRow.id })
                .update({
                    status: PUSH_STATUS_EXPIRED,
                    revoked_at: knex.fn.now(),
                    last_error: 'Suscripcion inválida',
                    last_error_at: knex.fn.now(),
                    updated_at: knex.fn.now()
                });
            summary.expired += 1;
            continue;
        }

        try {
            const pushOptions = {
                TTL: 60 * 60 * 12,
                urgency: 'high',
                timeout: 10000
            };

            if (!esEndpointPushApple(subscription.endpoint)) {
                pushOptions.topic = crearTopicPushWeb(`${eventType}:${eventKey}:${targetRifaId || targetRifaSlug}`, `${eventType}:${targetRifaId || targetRifaSlug}`);
            }

            await enviarNotificacionPushConRetry(subscription, payload, pushOptions, {
                retryDelaysMs: campaign.retryDelaysMs,
                sendNotification: campaign.sendNotification,
                sleep: campaign.sleep
            });
            await knex('push_campaign_subscriptions')
                .where({ id: subscriptionRow.id })
                .update({
                    last_notified_at: knex.fn.now(),
                    last_error: null,
                    last_error_at: null,
                    updated_at: knex.fn.now()
                });
            summary.delivered += 1;
        } catch (error) {
            const statusCode = Number(error?.statusCode || error?.status || 0);
            const message = error?.body || error?.message || 'Push delivery failed';
            if (statusCode === 404 || statusCode === 410) {
                await knex('push_campaign_subscriptions')
                    .where({ id: subscriptionRow.id })
                    .update({
                        status: PUSH_STATUS_EXPIRED,
                        revoked_at: knex.fn.now(),
                        last_error: String(message).slice(0, 2000),
                        last_error_at: knex.fn.now(),
                        updated_at: knex.fn.now()
                    });
                summary.expired += 1;
            } else {
                await knex('push_campaign_subscriptions')
                    .where({ id: subscriptionRow.id })
                    .update({
                        last_error: String(message).slice(0, 2000),
                        last_error_at: knex.fn.now(),
                        updated_at: knex.fn.now()
                    });
                summary.failed += 1;
            }
        }
    }

    if (summary.delivered > 0) {
        await registrarEventoCampanaPushEnviado(knex, {
            organizerKey,
            eventType,
            eventKey,
            targetRifaId,
            targetRifaSlug,
            payload: payloadData,
            totalTargets: summary.total,
            deliveredCount: summary.delivered,
            failedCount: summary.failed,
            expiredCount: summary.expired
        });
    }

    return summary;
}

async function backfillSuscripcionesCampanaDesdeOrdenes(knex) {
    const hasCampaignTable = await knex.schema.hasTable('push_campaign_subscriptions');
    const hasRifasTable = await knex.schema.hasTable('rifas');
    if (!hasCampaignTable || !hasRifasTable) {
        return { processed: 0, created: 0, updated: 0 };
    }

    const rows = await knex('push_subscriptions as ps')
        .join('rifas as r', 'r.id', 'ps.rifa_id')
        .join('ordenes as o', function joinOrdenes() {
            this.on('o.rifa_id', '=', 'ps.rifa_id')
                .andOn('o.numero_orden', '=', 'ps.numero_orden');
        })
        .select(
            'ps.rifa_id',
            'ps.numero_orden',
            'ps.telefono_cliente',
            'ps.subscription',
            'ps.user_agent',
            'ps.permission_estado',
            'ps.status',
            'r.slug as rifa_slug',
            'r.configuracion as rifa_configuracion',
            'o.created_at as orden_created_at',
            'o.updated_at as orden_updated_at'
        )
        .where('ps.status', PUSH_STATUS_ACTIVE);

    let created = 0;
    let updated = 0;

    for (const row of rows) {
        try {
            const before = await upsertSuscripcionCampanaPush(knex, {
                organizerKey: resolverOrganizerKeyPush({
                    configuracion: row.rifa_configuracion || {}
                }),
                telefonoCliente: row.telefono_cliente,
                subscription: row.subscription,
                userAgent: row.user_agent,
                permissionState: row.permission_estado,
                sourceRifaId: row.rifa_id,
                sourceRifaSlug: row.rifa_slug,
                sourceNumeroOrden: row.numero_orden,
                lastPurchaseAt: row.orden_created_at || row.orden_updated_at,
                lastPurchaseRifaId: row.rifa_id,
                lastPurchaseRifaSlug: row.rifa_slug,
                marketingOptIn: true,
                preserveOptOut: true
            });

            if (before.created) {
                created += 1;
            } else {
                updated += 1;
            }
        } catch (error) {
            // Continuar con las demás filas; el backfill es best-effort.
        }
    }

    return {
        processed: rows.length,
        created,
        updated
    };
}

async function enviarPushEventoOrden(knex, orden = {}, eventType, options = {}) {
    const config = asegurarConfiguracionWebPush();
    const numeroOrden = String(orden.numero_orden || orden.id || '').trim().toUpperCase();
    const rifaId = Number.parseInt(orden.rifa_id, 10) || null;

    if (!config.enabled || !numeroOrden || !rifaId) {
        return {
            enabled: false,
            eventType,
            delivered: 0,
            failed: 0,
            expired: 0,
            total: 0
        };
    }

    const eventKey = String(options.eventKey || eventType || '').trim();
    if (!eventKey) {
        throw new Error('INVALID_PUSH_EVENT_KEY');
    }

    const eventoPrevio = await buscarEventoPushEnviado(knex, {
        rifaId,
        numeroOrden,
        eventKey
    });
    if (eventoPrevio?.id) {
        return {
            enabled: true,
            eventType,
            eventKey,
            skipped: true,
            reason: 'already_sent',
            delivered: Number.parseInt(eventoPrevio.delivered_count, 10) || 0,
            failed: 0,
            expired: 0,
            total: 0
        };
    }

    const subscriptions = await knex('push_subscriptions')
        .select('id', 'subscription', 'status')
        .where({
            rifa_id: rifaId,
            numero_orden: numeroOrden,
            status: PUSH_STATUS_ACTIVE
        });

    if (!subscriptions.length) {
        return {
            enabled: true,
            eventType,
            eventKey,
            delivered: 0,
            failed: 0,
            expired: 0,
            total: 0
        };
    }

    let rifaSlug = String(orden?.rifa_slug || orden?.rifaSlug || '').trim();
    if (!rifaSlug) {
        try {
            const rifa = await knex('rifas')
                .where('id', rifaId)
                .first('slug');
            rifaSlug = String(rifa?.slug || '').trim();
        } catch (error) {
            rifaSlug = '';
        }
    }

    const ordenConContexto = {
        ...orden,
        rifa_id: rifaId,
        rifa_slug: rifaSlug
    };

    const payloadData = construirPayloadEventoPushOrden(eventType, ordenConContexto, options);
    const payload = JSON.stringify(payloadData);
    const summary = {
        enabled: true,
        eventType,
        eventKey,
        delivered: 0,
        failed: 0,
        expired: 0,
        total: subscriptions.length
    };

    for (const subscriptionRow of subscriptions) {
        const subscription = normalizarSubscriptionPush(subscriptionRow.subscription);
        if (!subscription) {
            await marcarSuscripcionComoInvalida(knex, subscriptionRow.id, PUSH_STATUS_EXPIRED, 'Suscripcion inválida');
            summary.expired += 1;
            continue;
        }

        try {
            const pushOptions = {
                TTL: 60 * 60 * 12,
                urgency: 'high',
                timeout: 10000
            };

            if (!esEndpointPushApple(subscription.endpoint)) {
                pushOptions.topic = crearTopicPushWeb(`${eventType}:${eventKey}:${numeroOrden}`, `${eventType}:${numeroOrden}`);
            }

            await enviarNotificacionPushConRetry(subscription, payload, pushOptions, {
                retryDelaysMs: options.retryDelaysMs,
                sendNotification: options.sendNotification,
                sleep: options.sleep
            });
            await marcarSuscripcionNotificada(knex, subscriptionRow.id);
            summary.delivered += 1;
        } catch (error) {
            const statusCode = Number(error?.statusCode || error?.status || 0);
            const message = error?.body || error?.message || 'Push delivery failed';
            if (statusCode === 404 || statusCode === 410) {
                await marcarSuscripcionComoInvalida(knex, subscriptionRow.id, PUSH_STATUS_EXPIRED, message);
                summary.expired += 1;
            } else {
                await registrarErrorSuscripcion(knex, subscriptionRow.id, message);
                summary.failed += 1;
            }
        }
    }

    if (summary.delivered > 0) {
        await registrarEventoPushEnviado(knex, {
            rifaId,
            numeroOrden,
            eventType,
            eventKey,
            payload: payloadData,
            totalTargets: summary.total,
            deliveredCount: summary.delivered,
            failedCount: summary.failed,
            expiredCount: summary.expired
        });
    }

    return summary;
}

module.exports = {
    PUSH_STATUS_ACTIVE,
    PUSH_STATUS_EXPIRED,
    PUSH_STATUS_REVOKED,
    PUSH_CAMPAIGN_AUDIENCE_ACTIVE,
    PUSH_CAMPAIGN_AUDIENCE_INACTIVE,
    obtenerConfigPush,
    asegurarConfiguracionWebPush,
    normalizarSubscriptionPush,
    normalizarPermissionStatePush,
    crearHashSubscriptionPush,
    crearTopicPushWeb,
    esEndpointPushApple,
    esErrorPushReintentable,
    enviarNotificacionPushConRetry,
    crearTokenOrdenPush,
    verificarTokenOrdenPush,
    construirMetadatosOrdenPushPublica,
    upsertSuscripcionPush,
    desactivarSuscripcionPush,
    upsertSuscripcionCampanaPush,
    desactivarSuscripcionCampanaPush,
    resolverOrganizerKeyPush,
    resolverFechaActividadCampanaPush,
    resolverEstadoSuscripcionCampana,
    PUSH_EVENT_TYPE_CONFIRMADA,
    PUSH_EVENT_TYPE_CANCELADA,
    PUSH_EVENT_TYPE_POR_VENCER,
    PUSH_CAMPAIGN_EVENT_TYPE_NUEVA_RIFA,
    PUSH_CAMPAIGN_EVENT_TYPE_PRESORTEO_PROXIMO,
    PUSH_CAMPAIGN_EVENT_TYPE_SORTEO_PROXIMO,
    PUSH_CAMPAIGN_EVENT_TYPE_RESULTADOS_DISPONIBLES,
    construirPayloadPushOrdenConfirmada,
    construirPayloadPushOrdenCancelada,
    construirPayloadPushOrdenPorVencer,
    construirPayloadPushNuevaRifaDisponible,
    construirPayloadPushRecordatorioEvento,
    construirPayloadPushResultadosDisponibles,
    aplicarPlantillaCampanaPush,
    registrarEventoCampanaPushEnviado,
    enviarPushEventoOrden,
    enviarPushOrdenConfirmada,
    enviarPushOrdenCancelada,
    enviarPushOrdenPorVencer,
    enviarPushNuevaRifaDisponible,
    enviarPushEventoCampana,
    backfillSuscripcionesCampanaDesdeOrdenes
};
