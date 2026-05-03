#!/usr/bin/env node

const DEFAULTS = {
    baseUrl: process.env.BASE_URL || 'http://localhost:5001',
    durationSec: 30,
    concurrency: 2,
    ticketStart: 100000,
    ticketsPerOrder: 3,
    clienteId: process.env.CLIENTE_ID || '',
    pricePerTicket: Number(process.env.PRICE_PER_TICKET || 6),
    allowRemote: false,
    allowProduction: false,
    useAvailablePool: true,
    delayMs: 0,
    respectRetryAfter: true,
    refreshTicketsOnConflict: true
};

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const PRODUCTION_HOST_PATTERNS = [
    /pages\.dev$/i,
    /railway\.app$/i,
    /up\.railway\.app$/i,
    /vercel\.app$/i,
    /netlify\.app$/i,
    /onrender\.com$/i,
    /herokuapp\.com$/i
];

function parseArgs(argv) {
    const config = { ...DEFAULTS };

    argv.forEach((arg) => {
        const [rawKey, rawValue] = arg.split('=');
        const key = rawKey.replace(/^--/, '');
        const value = rawValue ?? '';

        if (key === 'baseUrl' && value) config.baseUrl = value;
        if (key === 'duration' && value) config.durationSec = Number(value);
        if (key === 'concurrency' && value) config.concurrency = Number(value);
        if (key === 'ticketStart' && value) config.ticketStart = Number(value);
        if (key === 'ticketsPerOrder' && value) config.ticketsPerOrder = Number(value);
        if (key === 'clienteId' && value) config.clienteId = value;
        if (key === 'pricePerTicket' && value) config.pricePerTicket = Number(value);
        if (key === 'allowRemote') config.allowRemote = value !== 'false';
        if (key === 'allowProduction') config.allowProduction = value !== 'false';
        if (key === 'useAvailablePool') config.useAvailablePool = value !== 'false';
        if (key === 'delayMs' && value) config.delayMs = Number(value);
        if (key === 'respectRetryAfter') config.respectRetryAfter = value !== 'false';
        if (key === 'refreshTicketsOnConflict') config.refreshTicketsOnConflict = value !== 'false';
    });

    return config;
}

function sleep(ms) {
    const duration = Number(ms);
    if (!Number.isFinite(duration) || duration <= 0) {
        return Promise.resolve();
    }

    return new Promise((resolve) => setTimeout(resolve, duration));
}

function ensureSafeTarget(baseUrl, options) {
    let url;
    try {
        url = new URL(baseUrl);
    } catch (error) {
        throw new Error(`BASE_URL inválida: ${baseUrl}`);
    }

    const hostname = (url.hostname || '').toLowerCase();
    const isLocalHost = LOCAL_HOSTS.has(hostname);
    const isProductionLike = PRODUCTION_HOST_PATTERNS.some((pattern) => pattern.test(hostname));

    if (!isLocalHost && !options.allowRemote) {
        throw new Error(
            `Refusando correr contra host remoto (${hostname}). Usa --allowRemote=true solo si es staging aislado.`
        );
    }

    if (isProductionLike && !options.allowProduction) {
        throw new Error(
            `Refusando correr contra host tipo producción (${hostname}). Si de verdad quieres hacerlo, usa --allowProduction=true y hazlo bajo ventana controlada.`
        );
    }

    return url.toString().replace(/\/$/, '');
}

function buildOrderPayload({ orderId = '', orderIndex, tickets, pricePerTicket }) {
    const subtotal = tickets.length * pricePerTicket;
    return {
        ordenId: orderId,
        cliente: {
            nombre: 'Load',
            apellidos: `Test${orderIndex}`,
            whatsapp: `4499${String(100000 + orderIndex).slice(-6)}`,
            estado: 'Querétaro',
            ciudad: 'Queretaro'
        },
        cuenta: {
            id: 1,
            bank: 'Santander',
            accountNumber: '4444 5555 6666 7777',
            accountType: 'Tarjeta',
            beneficiary: 'Carga Controlada',
            phone: ''
        },
        boletos: tickets,
        totales: {
            subtotal,
            descuento: 0,
            totalFinal: subtotal
        },
        metodoPago: 'transferencia',
        fecha: new Date().toISOString(),
        referencia: orderId
    };
}

async function fetchJson(url, options = {}) {
    const response = await fetch(url, options);
    const text = await response.text();

    let json = null;
    try {
        json = text ? JSON.parse(text) : null;
    } catch (error) {
        json = { raw: text };
    }

    return { response, json };
}

function normalizeTicketList(items) {
    if (!Array.isArray(items)) return [];

    return items
        .map((item) => {
            if (typeof item === 'number') return item;
            if (typeof item === 'string') return Number(item);
            if (item && typeof item === 'object') {
                if (item.numero !== undefined) return Number(item.numero);
                if (item.number !== undefined) return Number(item.number);
            }
            return NaN;
        })
        .filter((value) => Number.isInteger(value) && value >= 0);
}

async function preloadAvailableTickets(baseUrl, options) {
    if (!options.useAvailablePool) {
        return [];
    }

    const estimatedOrders = Math.max(
        options.concurrency * options.durationSec * 4,
        options.concurrency * 10
    );
    const estimatedTickets = Math.max(
        200,
        estimatedOrders * options.ticketsPerOrder
    );

    const tickets = [];
    let offset = 0;
    const limit = 500;

    while (tickets.length < estimatedTickets) {
        // Intento principal: GET /api/boletos/disponibles
        const result = await fetchJson(`${baseUrl}/api/boletos/disponibles?limit=${limit}&offset=${offset}`, {
            headers: { accept: 'application/json' }
        });

        // Si GET falla con 404 o devuelve formato inesperado, intentamos el endpoint alternativo POST /disponibles-aleatorios
        if (!result.response.ok || result.json?.success !== true) {
            // Si el servidor indica Not Found o la ruta no está expuesta, intentar POST alternativo
            if (result.response.status === 404 || result.response.status === 403 || result.response.status === 401) {
                // fallback: pedir bloques aleatorios hasta completar estimatedTickets
                const remaining = Math.max(estimatedTickets - tickets.length, options.ticketsPerOrder);
                const tryLimit = Math.min(limit, remaining);
                const fallbackResult = await fetchJson(`${baseUrl}/api/boletos/disponibles-aleatorios`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', accept: 'application/json' },
                    body: JSON.stringify({ cantidad: tryLimit, excludeNumbers: [] })
                });

                if (!fallbackResult.response.ok || fallbackResult.json?.success !== true) {
                    console.warn(`Precarga: ambos endpoints GET y POST fallaron (GET ${result.response.status}, POST ${fallbackResult.response.status}). Cambiando a modo secuencial (--useAvailablePool=false).`);
                    // Forzamos al caller a generar tickets secuenciales
                    options.useAvailablePool = false;
                    return [];
                }

                const pageTickets = normalizeTicketList(fallbackResult.json?.boletos);
                if (pageTickets.length === 0) break;
                tickets.push(...pageTickets);
                // no cambia offset cuando usamos fallback; continuamos hasta llenar
                continue;
            }

            console.warn(`Precarga GET /api/boletos/disponibles falló (status ${result.response.status}). Cambiando a modo secuencial (--useAvailablePool=false).`);
            options.useAvailablePool = false;
            return [];
        }

        const pageTickets = normalizeTicketList(result.json?.boletos);
        if (pageTickets.length === 0) {
            break;
        }

        tickets.push(...pageTickets);

        const nextOffset = Number(result.json?.paginacion?.proximo_offset);
        if (!Number.isInteger(nextOffset) || nextOffset <= offset) {
            offset += limit;
        } else {
            offset = nextOffset;
        }
    }

    return tickets;
}

function takeNextTicketBlock(state, options, orderIndex) {
    if (!options.useAvailablePool) {
        const ticketBase = options.ticketStart + (orderIndex * options.ticketsPerOrder);
        return Array.from({ length: options.ticketsPerOrder }, (_, idx) => ticketBase + idx);
    }

    if (Array.isArray(state.recycledTicketBlocks) && state.recycledTicketBlocks.length > 0) {
        return state.recycledTicketBlocks.pop();
    }

    const start = state.nextTicketIndex;
    const end = start + options.ticketsPerOrder;

    if (!Array.isArray(state.availableTickets) || end > state.availableTickets.length) {
        return null;
    }

    state.nextTicketIndex = end;
    return state.availableTickets.slice(start, end);
}

function shouldRecycleTickets(result) {
    const status = Number(result?.status || 0);
    return status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;
}

function recycleTicketBlock(state, tickets) {
    if (!Array.isArray(tickets) || tickets.length === 0) {
        return;
    }

    state.recycledTicketBlocks.push(tickets);
}

async function fetchFreshTicketBlock(baseUrl, options, excludeNumbers = []) {
    if (!options.useAvailablePool || !options.refreshTicketsOnConflict) {
        return [];
    }

    const result = await fetchJson(`${baseUrl}/api/boletos/disponibles-aleatorios`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            accept: 'application/json'
        },
        body: JSON.stringify({
            cantidad: options.ticketsPerOrder,
            excludeNumbers
        })
    });

    if (!result.response.ok || result.json?.success !== true) {
        return [];
    }

    return normalizeTicketList(result.json?.boletos);
}

function resolveRetryDelayMs(result, options) {
    if (!options.respectRetryAfter) {
        return Math.max(0, Number(options.delayMs) || 0);
    }

    const retryAfterSeconds = Number(
        result?.body?.retryAfterSeconds
        || result?.responseHeaders?.get?.('retry-after')
        || 0
    );

    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
        return retryAfterSeconds * 1000;
    }

    return Math.max(0, Number(options.delayMs) || 0);
}

async function createOrder(baseUrl, options, orderIndex, tickets) {
    if (!Array.isArray(tickets) || tickets.length !== options.ticketsPerOrder) {
        return {
            ok: false,
            stage: 'ticket-pool',
            status: 0,
            body: {
                success: false,
                message: 'No hay suficientes boletos disponibles precargados para continuar la prueba'
            }
        };
    }
    const payload = buildOrderPayload({
        orderId: '',
        orderIndex,
        tickets,
        pricePerTicket: options.pricePerTicket
    });

    const orderResult = await fetchJson(`${baseUrl}/api/ordenes`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            accept: 'application/json'
        },
        body: JSON.stringify(payload)
    });

    return {
        ok: orderResult.response.ok && orderResult.json?.success === true,
        stage: 'create-order',
        status: orderResult.response.status,
        orderId: orderResult.json?.ordenId || orderResult.json?.data?.ordenId || '',
        tickets,
        body: orderResult.json,
        responseHeaders: orderResult.response.headers
    };
}

async function runWorker(state, baseUrl, options, stopAt, workerIndex) {
    while (Date.now() < stopAt) {
        if (state.stopRequested) {
            return;
        }

        const orderIndex = state.nextOrderIndex++;
        const startedAt = Date.now();
        const tickets = takeNextTicketBlock(state, options, orderIndex);

        if (!Array.isArray(tickets) || tickets.length !== options.ticketsPerOrder) {
            state.stopRequested = true;
            state.stopReason = 'ticket-pool-exhausted';
            state.stopMessage = 'Se agotó el pool de boletos precargados antes de terminar la ventana de prueba';
            return;
        }

        try {
            const result = await createOrder(baseUrl, options, orderIndex, tickets);
            const durationMs = Date.now() - startedAt;
            state.total += 1;
            state.durations.push(durationMs);
            state.statuses[result.status] = (state.statuses[result.status] || 0) + 1;

            if (!result.ok) {
                state.failures += 1;
                if (result.status === 409 && options.refreshTicketsOnConflict) {
                    const freshTickets = await fetchFreshTicketBlock(baseUrl, options, tickets);
                    if (freshTickets.length === options.ticketsPerOrder) {
                        recycleTicketBlock(state, freshTickets);
                    }
                } else if (shouldRecycleTickets(result)) {
                    recycleTicketBlock(state, tickets);
                }
                state.failureSamples.push({
                    workerIndex,
                    orderIndex,
                    status: result.status,
                    stage: result.stage,
                    body: result.body
                });

                const retryDelayMs = resolveRetryDelayMs(result, options);
                if (retryDelayMs > 0) {
                    await sleep(retryDelayMs);
                    continue;
                }
            } else if (options.delayMs > 0) {
                await sleep(options.delayMs);
            }
        } catch (error) {
            state.total += 1;
            state.failures += 1;
            state.errors[error.message] = (state.errors[error.message] || 0) + 1;
            state.durations.push(Date.now() - startedAt);
            recycleTicketBlock(state, tickets);

            if (options.delayMs > 0) {
                await sleep(options.delayMs);
            }
        }
    }
}

function percentile(values, p) {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[index];
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const baseUrl = ensureSafeTarget(options.baseUrl, options);
    const availableTickets = await preloadAvailableTickets(baseUrl, options);
    const stopAt = Date.now() + (options.durationSec * 1000);
    const state = {
        total: 0,
        failures: 0,
        statuses: {},
        errors: {},
        durations: [],
        nextOrderIndex: 0,
        failureSamples: [],
        availableTickets,
        recycledTicketBlocks: [],
        nextTicketIndex: 0,
        stopRequested: false,
        stopReason: '',
        stopMessage: ''
    };

    console.log(`Order load test -> ${baseUrl}/api/ordenes`);
    console.log(`Duración -> ${options.durationSec}s`);
    console.log(`Concurrencia -> ${options.concurrency}`);
    console.log(`Boletos por orden -> ${options.ticketsPerOrder}`);
    console.log(`Ticket inicial -> ${options.ticketStart}`);
    console.log(`Modo pool disponible -> ${options.useAvailablePool ? 'sí' : 'no'}`);
    console.log(`Delay entre intentos -> ${options.delayMs}ms`);
    console.log(`Respeta Retry-After -> ${options.respectRetryAfter ? 'sí' : 'no'}`);
    console.log(`Refresca boletos en conflicto -> ${options.refreshTicketsOnConflict ? 'sí' : 'no'}`);
    if (options.useAvailablePool) console.log(`Boletos precargados -> ${availableTickets.length}`);
    if (options.allowRemote) console.log('Modo remoto -> habilitado');
    if (options.allowProduction) console.log('Modo producción -> habilitado');

    const startedAt = Date.now();
    const workers = Array.from(
        { length: options.concurrency },
        (_, index) => runWorker(state, baseUrl, options, stopAt, index)
    );

    await Promise.all(workers);

    const elapsedSec = Math.max(1, (Date.now() - startedAt) / 1000);
    const avgMs = state.durations.length
        ? Math.round(state.durations.reduce((sum, value) => sum + value, 0) / state.durations.length)
        : 0;

    console.log('');
    console.log(`Ordenes intentadas -> ${state.total}`);
    console.log(`TPS aprox -> ${(state.total / elapsedSec).toFixed(2)}`);
    console.log(`Fallos -> ${state.failures}`);
    console.log(`Latencia promedio -> ${avgMs}ms`);
    console.log(`P95 -> ${percentile(state.durations, 95)}ms`);
    console.log(`P99 -> ${percentile(state.durations, 99)}ms`);
    console.log(`Status -> ${JSON.stringify(state.statuses)}`);
    if (state.stopReason) {
        console.log(`Corte controlado -> ${state.stopReason}`);
        console.log(`Detalle -> ${state.stopMessage}`);
    }

    if (state.failureSamples.length > 0) {
        console.log('Muestras de fallo ->');
        state.failureSamples.slice(0, 5).forEach((sample) => {
            console.log(JSON.stringify(sample, null, 2));
        });
    }

    if (Object.keys(state.errors).length > 0) {
        console.log(`Errores -> ${JSON.stringify(state.errors, null, 2)}`);
    }

    if (state.stopReason && state.failures === 0 && Object.keys(state.errors).length === 0) {
        process.exit(0);
    }

    if (state.failures > 0 || Object.keys(state.errors).length > 0) {
        process.exit(1);
    }
}

main().catch((error) => {
    console.error('Order load test falló:', error.message);
    process.exit(1);
});
