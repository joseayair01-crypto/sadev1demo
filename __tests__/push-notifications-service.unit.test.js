const {
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
    obtenerConfigPush,
    construirPayloadPushOrdenCancelada,
    construirPayloadPushOrdenPorVencer,
    construirPayloadPushNuevaRifaDisponible,
    construirPayloadPushResultadosDisponibles,
    resolverOrganizerKeyPush,
    resolverFechaActividadCampanaPush,
    resolverEstadoSuscripcionCampana,
    upsertSuscripcionPush
} = require('../backend/services/pushNotificationsService');

function crearKnexMockUpsert({ insertResult = [], updateResult = 1 } = {}) {
    const state = {
        insertRows: [],
        conflicts: [],
        updates: []
    };

    const tableApi = {
        insert: jest.fn((row) => {
            state.insertRows.push(row);
            return {
                onConflict: jest.fn((columns) => {
                    state.conflicts.push(columns);
                    return {
                        ignore: jest.fn(() => ({
                            returning: jest.fn(async () => insertResult)
                        }))
                    };
                })
            };
        }),
        where: jest.fn((criteria) => ({
            update: jest.fn(async (payload) => {
                state.updates.push({ criteria, payload });
                return updateResult;
            })
        }))
    };

    const knex = jest.fn((tableName) => {
        if (tableName !== 'push_subscriptions') {
            throw new Error(`Tabla inesperada: ${tableName}`);
        }
        return tableApi;
    });

    knex.fn = {
        now: jest.fn(() => 'NOW()')
    };

    return { knex, state };
}

describe('pushNotificationsService', () => {
    const subscriptionValida = {
        endpoint: 'https://example.com/push/123',
        expirationTime: null,
        keys: {
            p256dh: 'BEl62iUYgUivWQczU7jvbOW0m0FQx_tT6rwLQx9Y6sgn4Z9mM4WkJdN3F4f6hQ8Lr4T3bY8Jx8mX2wY8aBcD9A',
            auth: 'c2VjcmV0LWF1dGg'
        }
    };

    const previousJwtSecret = process.env.JWT_SECRET;
    const previousPushVapidPublicKey = process.env.PUSH_VAPID_PUBLIC_KEY;
    const previousPushVapidPrivateKey = process.env.PUSH_VAPID_PRIVATE_KEY;
    const previousPushVapidSubject = process.env.PUSH_VAPID_SUBJECT;
    const previousPushContactEmail = process.env.PUSH_CONTACT_EMAIL;

    beforeAll(() => {
        process.env.JWT_SECRET = 'secret-super-largo-para-pruebas-de-push-notifications';
    });

    afterAll(() => {
        process.env.JWT_SECRET = previousJwtSecret;
        process.env.PUSH_VAPID_PUBLIC_KEY = previousPushVapidPublicKey;
        process.env.PUSH_VAPID_PRIVATE_KEY = previousPushVapidPrivateKey;
        process.env.PUSH_VAPID_SUBJECT = previousPushVapidSubject;
        process.env.PUSH_CONTACT_EMAIL = previousPushContactEmail;
    });

    test('normaliza una suscripcion valida', () => {
        const normalized = normalizarSubscriptionPush(subscriptionValida);

        expect(normalized).toEqual({
            endpoint: 'https://example.com/push/123',
            expirationTime: null,
            keys: {
                p256dh: subscriptionValida.keys.p256dh,
                auth: subscriptionValida.keys.auth
            }
        });
        expect(crearHashSubscriptionPush(normalized)).toHaveLength(64);
    });

    test('rechaza una suscripcion incompleta', () => {
        expect(normalizarSubscriptionPush({ endpoint: 'https://example.com' })).toBeNull();
    });

    test('rechaza una suscripcion con keys invalidas', () => {
        expect(normalizarSubscriptionPush({
            ...subscriptionValida,
            keys: {
                p256dh: '***',
                auth: 'no es base64'
            }
        })).toBeNull();
    });

    test('normaliza permission states desconocidos a un valor permitido', () => {
        expect(normalizarPermissionStatePush('GRANTED')).toBe('granted');
        expect(normalizarPermissionStatePush('  denied ')).toBe('denied');
        expect(normalizarPermissionStatePush('cualquier-cosa', 'default')).toBe('default');
    });

    test('reintenta errores transitorios y termina entregando la notificacion', async () => {
        const sendNotification = jest.fn()
            .mockRejectedValueOnce({ statusCode: 503, message: 'Service unavailable' })
            .mockResolvedValueOnce({ statusCode: 201 });
        const sleep = jest.fn().mockResolvedValue();

        await expect(enviarNotificacionPushConRetry(
            { endpoint: 'https://example.com/push/123' },
            '{"ok":true}',
            { TTL: 60 },
            {
                retryDelaysMs: [1],
                sendNotification,
                sleep
            }
        )).resolves.toEqual({ statusCode: 201 });

        expect(sendNotification).toHaveBeenCalledTimes(2);
        expect(sleep).toHaveBeenCalledTimes(1);
        expect(esErrorPushReintentable({ statusCode: 503 })).toBe(true);
    });

    test('no reintenta errores permanentes de suscripcion', async () => {
        const sendNotification = jest.fn()
            .mockRejectedValue({ statusCode: 410, message: 'Gone' });
        const sleep = jest.fn().mockResolvedValue();

        await expect(enviarNotificacionPushConRetry(
            { endpoint: 'https://example.com/push/123' },
            '{"ok":true}',
            { TTL: 60 },
            {
                retryDelaysMs: [1, 2],
                sendNotification,
                sleep
            }
        )).rejects.toMatchObject({ statusCode: 410 });

        expect(sendNotification).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
        expect(esErrorPushReintentable({ statusCode: 410 })).toBe(false);
    });

    test('detecta endpoints de Apple Push para omitir topic incompatible', () => {
        expect(esEndpointPushApple('https://web.push.apple.com/abc123')).toBe(true);
        expect(esEndpointPushApple('https://fcm.googleapis.com/fcm/send/demo')).toBe(false);
    });

    test('genera topics estables y distintos por evento push', () => {
        const topicA = crearTopicPushWeb('orden_por_vencer:15:RIFA-100');
        const topicB = crearTopicPushWeb('orden_cancelada:expired:RIFA-100');

        expect(topicA).toHaveLength(32);
        expect(topicA).toBe(crearTopicPushWeb('orden_por_vencer:15:RIFA-100'));
        expect(topicA).not.toBe(topicB);
    });

    test('firma y valida token por orden', () => {
        const orden = {
            numero_orden: 'RIFA-1234',
            rifa_id: 7,
            telefono_cliente: '5512345678',
            created_at: '2026-04-25T12:00:00.000Z',
            estado: 'pendiente',
            comprobante_path: '/comprobantes/demo.jpg'
        };

        const token = crearTokenOrdenPush(orden);
        const verificacion = verificarTokenOrdenPush(token, orden);

        expect(typeof token).toBe('string');
        expect(verificacion.valido).toBe(true);
    });

    test('rechaza tokens de orden expirados', () => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-04-25T12:00:00.000Z'));

        const orden = {
            numero_orden: 'RIFA-1234',
            rifa_id: 7,
            telefono_cliente: '5512345678',
            created_at: '2026-04-25T12:00:00.000Z',
            estado: 'pendiente'
        };

        const token = crearTokenOrdenPush(orden);

        jest.setSystemTime(new Date('2026-04-26T12:00:00.001Z'));
        const verificacion = verificarTokenOrdenPush(token, orden);

        expect(verificacion.valido).toBe(false);
        expect(verificacion.reason).toBe('expired_token');
        jest.useRealTimers();
    });

    test('mantiene compatibilidad transitoria con tokens legacy dentro de la ventana valida', () => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-04-25T18:00:00.000Z'));

        const orden = {
            numero_orden: 'RIFA-1234',
            rifa_id: 7,
            telefono_cliente: '5512345678',
            created_at: '2026-04-25T12:00:00.000Z',
            estado: 'pendiente'
        };

        const tokenActual = crearTokenOrdenPush(orden);
        const [payloadEncoded, signature] = tokenActual.split('.');
        const payload = JSON.parse(Buffer.from(
            payloadEncoded.replace(/-/g, '+').replace(/_/g, '/'),
            'base64'
        ).toString('utf8'));
        delete payload.iat;
        delete payload.exp;

        const legacyPayloadEncoded = Buffer.from(JSON.stringify(payload), 'utf8')
            .toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/g, '');
        const legacySignature = require('crypto')
            .createHmac('sha256', process.env.JWT_SECRET)
            .update(legacyPayloadEncoded)
            .digest('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/g, '');
        const legacyToken = `${legacyPayloadEncoded}.${legacySignature}`;

        const verificacion = verificarTokenOrdenPush(legacyToken, orden);

        expect(verificacion.valido).toBe(true);
        jest.useRealTimers();
    });

    test('construye metadatos publicos aunque la orden siga pendiente sin comprobante', () => {
        process.env.PUSH_VAPID_PUBLIC_KEY = 'public-key';
        process.env.PUSH_VAPID_PRIVATE_KEY = 'private-key';
        process.env.PUSH_VAPID_SUBJECT = 'mailto:test@example.com';

        const metadata = construirMetadatosOrdenPushPublica({
            numero_orden: 'RIFA-9999',
            rifa_id: 1,
            telefono_cliente: '5512345678',
            created_at: '2026-04-25T12:00:00.000Z',
            estado: 'pendiente'
        });

        expect(metadata.enabled).toBe(true);
        expect(metadata.canSubscribe).toBe(true);
        expect(typeof metadata.token).toBe('string');

        delete process.env.PUSH_VAPID_PUBLIC_KEY;
        delete process.env.PUSH_VAPID_PRIVATE_KEY;
        delete process.env.PUSH_VAPID_SUBJECT;
    });

    test('construye payload de cancelacion con razon expirada', () => {
        const payload = construirPayloadPushOrdenCancelada({
            numero_orden: 'RIFA-9999'
        }, {
            reason: 'expired'
        });

        expect(payload.type).toBe('orden_cancelada');
        expect(payload.body).toContain('venció');
        expect(payload.data.reason).toBe('expired');
    });

    test('construye payload de recordatorio por vencer', () => {
        const payload = construirPayloadPushOrdenPorVencer({
            numero_orden: 'RIFA-1234'
        }, {
            warningMinutes: 15
        });

        expect(payload.type).toBe('orden_por_vencer');
        expect(payload.body).toContain('15 minuto');
        expect(payload.data.warningMinutes).toBe(15);
    });

    test('construye payload de nueva rifa con slug publico', () => {
        const payload = construirPayloadPushNuevaRifaDisponible({
            organizerName: 'Sorteos El Trebol',
            rifaNombre: 'Rifa Mayo',
            rifaId: 9,
            rifaSlug: 'rifa-mayo',
            publicUrl: '/'
        });

        expect(payload.type).toBe('nueva_rifa_publicada');
        expect(payload.body).toContain('Rifa Mayo');
        expect(payload.url).toContain('rifa=rifa-mayo');
    });

    test('construye payload de resultados disponibles con slug publico', () => {
        const payload = construirPayloadPushResultadosDisponibles({
            organizerName: 'Sorteos El Trebol',
            rifaNombre: 'Rifa Mayo',
            rifaId: 9,
            rifaSlug: 'rifa-mayo',
            publicUrl: '/',
            resultsCount: 3
        });

        expect(payload.type).toBe('resultados_disponibles');
        expect(payload.body).toContain('3 resultado');
        expect(payload.url).toContain('rifa=rifa-mayo');
    });

    test('resuelve organizer key normalizado desde configuracion', () => {
        const organizerKey = resolverOrganizerKeyPush({
            configuracion: {
                cliente: {
                    id: 'Sorteos El Trebol'
                }
            }
        });

        expect(organizerKey).toBe('sorteos-el-trebol');
    });

    test('normaliza fechas de actividad de campaña a ISO cuando son válidas', () => {
        expect(resolverFechaActividadCampanaPush('2026-04-27T12:30:00.000Z')).toBe('2026-04-27T12:30:00.000Z');
        expect(resolverFechaActividadCampanaPush('fecha-invalida')).toBeNull();
        expect(resolverFechaActividadCampanaPush(null, '2026-04-27T12:30:00.000Z')).toBe('2026-04-27T12:30:00.000Z');
    });

    test('resuelve un subject valido cuando el configurado es invalido', () => {
        process.env.PUSH_VAPID_PUBLIC_KEY = 'public-key';
        process.env.PUSH_VAPID_PRIVATE_KEY = 'private-key';
        process.env.PUSH_VAPID_SUBJECT = 'mailto:admin@rifaplus.local';
        process.env.PUSH_CONTACT_EMAIL = 'soporte@example.com';

        const config = obtenerConfigPush();

        expect(config.enabled).toBe(true);
        expect(config.subjectRaw).toBe('mailto:admin@rifaplus.local');
        expect(config.subject).toBe('mailto:soporte@example.com');

        delete process.env.PUSH_VAPID_PUBLIC_KEY;
        delete process.env.PUSH_VAPID_PRIVATE_KEY;
        delete process.env.PUSH_VAPID_SUBJECT;
        delete process.env.PUSH_CONTACT_EMAIL;
    });

    test('preserva el opt-out de campañas durante el backfill', () => {
        const state = resolverEstadoSuscripcionCampana({
            status: 'revoked',
            marketing_opt_in: false,
            revoked_at: '2026-04-26T00:00:00.000Z'
        }, {
            marketingOptIn: true,
            preserveOptOut: true
        });

        expect(state).toEqual({
            status: 'revoked',
            marketingOptIn: false,
            preserveRevokedAt: true
        });
    });

    test('permite reactivar campañas cuando el opt-in es explicito', () => {
        const state = resolverEstadoSuscripcionCampana({
            status: 'revoked',
            marketing_opt_in: false,
            revoked_at: '2026-04-26T00:00:00.000Z'
        }, {
            marketingOptIn: true
        });

        expect(state).toEqual({
            status: 'active',
            marketingOptIn: true,
            preserveRevokedAt: false
        });
    });

    test('upsert de suscripcion actualiza cuando la fila ya existe por conflicto unico', async () => {
        const { knex, state } = crearKnexMockUpsert({ insertResult: [] });

        const result = await upsertSuscripcionPush(knex, {
            rifaId: 7,
            numeroOrden: 'RIFA-1234',
            telefonoCliente: '5512345678',
            subscription: {
                ...subscriptionValida
            },
            permissionState: 'algo-raro'
        });

        expect(result).toEqual(expect.objectContaining({
            created: false
        }));
        expect(state.conflicts).toEqual([['rifa_id', 'numero_orden', 'subscription_hash']]);
        expect(state.updates).toHaveLength(1);
        expect(state.updates[0].criteria).toEqual(expect.objectContaining({
            rifa_id: 7,
            numero_orden: 'RIFA-1234'
        }));
        expect(state.updates[0].payload.permission_estado).toBe('granted');
    });
});
