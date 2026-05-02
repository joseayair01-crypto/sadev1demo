const os = require('os');

const {
    obtenerConfigPush,
    normalizarSubscriptionPush,
    crearTopicPushWeb,
    esEndpointPushApple,
    enviarNotificacionPushConRetry,
    resolverOrganizerKeyPush,
    registrarEventoCampanaPushEnviado,
    PUSH_CAMPAIGN_AUDIENCE_ACTIVE,
    construirPayloadPushNuevaRifaDisponible,
    construirPayloadPushRecordatorioEvento,
    construirPayloadPushResultadosDisponibles,
    PUSH_STATUS_ACTIVE,
    PUSH_STATUS_EXPIRED,
    PUSH_CAMPAIGN_EVENT_TYPE_NUEVA_RIFA,
    PUSH_CAMPAIGN_EVENT_TYPE_PRESORTEO_PROXIMO,
    PUSH_CAMPAIGN_EVENT_TYPE_SORTEO_PROXIMO,
    PUSH_CAMPAIGN_EVENT_TYPE_RESULTADOS_DISPONIBLES
} = require('./pushNotificationsService');

const JOB_STATUS_PENDING = 'pending';
const JOB_STATUS_RUNNING = 'running';
const JOB_STATUS_COMPLETED = 'completed';
const JOB_STATUS_FAILED = 'failed';
const JOB_STATUS_CANCELLED = 'cancelled';

const DEFAULT_POLL_MS = Math.max(1000, Number.parseInt(process.env.PUSH_CAMPAIGN_JOB_POLL_MS, 10) || 3000);
const DEFAULT_STALE_MS = Math.max(30000, Number.parseInt(process.env.PUSH_CAMPAIGN_JOB_STALE_MS, 10) || 120000);
const DEFAULT_BATCH_SIZE = Math.max(25, Math.min(1000, Number.parseInt(process.env.PUSH_CAMPAIGN_JOB_BATCH_SIZE, 10) || 250));
const DEFAULT_CONCURRENCY = Math.max(1, Math.min(50, Number.parseInt(process.env.PUSH_CAMPAIGN_JOB_CONCURRENCY, 10) || 20));
const DEFAULT_MAX_ACTIVE_JOBS = Math.max(1, Math.min(4, Number.parseInt(process.env.PUSH_CAMPAIGN_MAX_ACTIVE_JOBS, 10) || 1));
const DEFAULT_MARKETING_RECENCY_DAYS = Math.max(30, Number.parseInt(process.env.PUSH_CAMPAIGN_MARKETING_RECENCY_DAYS, 10) || 120);
const AUDIENCE_MODE_MARKETING = 'marketing';
const AUDIENCE_MODE_RIFA_PARTICIPANTS = 'rifa_participants';

function clampInteger(value, min, max, fallback) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }

    return Math.max(min, Math.min(max, parsed));
}

function mapWithConcurrency(items, concurrency, worker) {
    if (!Array.isArray(items) || !items.length) {
        return Promise.resolve([]);
    }

    const limit = Math.max(1, Math.min(Number(concurrency) || 1, items.length));
    const results = new Array(items.length);
    let cursor = 0;

    async function consume() {
        while (true) {
            const index = cursor;
            cursor += 1;
            if (index >= items.length) {
                return;
            }

            results[index] = await worker(items[index], index);
        }
    }

    return Promise.all(Array.from({ length: limit }, () => consume())).then(() => results);
}

function construirPayloadCampana(eventType, campaign) {
    if (eventType === PUSH_CAMPAIGN_EVENT_TYPE_NUEVA_RIFA) {
        return construirPayloadPushNuevaRifaDisponible(campaign);
    }

    if (eventType === PUSH_CAMPAIGN_EVENT_TYPE_RESULTADOS_DISPONIBLES) {
        return construirPayloadPushResultadosDisponibles(campaign);
    }

    if (eventType === PUSH_CAMPAIGN_EVENT_TYPE_PRESORTEO_PROXIMO || eventType === PUSH_CAMPAIGN_EVENT_TYPE_SORTEO_PROXIMO) {
        return construirPayloadPushRecordatorioEvento({
            ...campaign,
            eventType
        });
    }

    throw new Error(`UNSUPPORTED_PUSH_CAMPAIGN_EVENT_TYPE:${eventType}`);
}

function construirOpcionesPushCampana(job, endpoint) {
    const eventType = String(job?.event_type || '').trim();
    const targetValue = job?.target_rifa_id || job?.target_rifa_slug || 'campaign';
    const options = {
        TTL: eventType === PUSH_CAMPAIGN_EVENT_TYPE_NUEVA_RIFA ? 60 * 60 * 24 : 60 * 60 * 12,
        urgency: 'high',
        timeout: 10000
    };

    if (!esEndpointPushApple(endpoint)) {
        const rawTopic = eventType === PUSH_CAMPAIGN_EVENT_TYPE_NUEVA_RIFA
            ? `campaign:${targetValue}`
            : `${eventType}:${job?.event_key || targetValue}:${targetValue}`;
        options.topic = crearTopicPushWeb(rawTopic, `campaign:${eventType}:${targetValue}`);
    }

    return options;
}

function resolverPoliticaAudienciaCampana(campaign = {}) {
    const raw = campaign?.audiencePolicy || {};
    return {
        marketingRecencyDays: clampInteger(raw.marketingRecencyDays, 30, 3650, DEFAULT_MARKETING_RECENCY_DAYS)
    };
}

function resolverModoAudienciaJob(job = {}) {
    const eventType = String(job?.event_type || '').trim();
    return eventType === PUSH_CAMPAIGN_EVENT_TYPE_NUEVA_RIFA
        ? AUDIENCE_MODE_MARKETING
        : AUDIENCE_MODE_RIFA_PARTICIPANTS;
}

class PushCampaignQueueService {
    constructor(knex, options = {}) {
        this.knex = knex;
        this.logger = options.logger || console;
        this.pollMs = clampInteger(options.pollMs, 1000, 60000, DEFAULT_POLL_MS);
        this.staleMs = clampInteger(options.staleMs, 30000, 15 * 60 * 1000, DEFAULT_STALE_MS);
        this.defaultBatchSize = clampInteger(options.defaultBatchSize, 25, 1000, DEFAULT_BATCH_SIZE);
        this.defaultConcurrency = clampInteger(options.defaultConcurrency, 1, 50, DEFAULT_CONCURRENCY);
        this.maxActiveJobs = clampInteger(options.maxActiveJobs, 1, 4, DEFAULT_MAX_ACTIVE_JOBS);
        this.instanceId = `${os.hostname()}:${process.pid}`;
        this.interval = null;
        this.running = false;
        this.inFlightJobs = 0;
        this.tickPromise = null;
    }

    start() {
        if (this.interval) {
            return;
        }

        this.interval = setInterval(() => {
            this.tick().catch((error) => {
                this.logger.warn('[PushCampaignQueue] Error en ciclo de procesamiento:', error?.message || error);
            });
        }, this.pollMs);

        this.tick().catch((error) => {
            this.logger.warn('[PushCampaignQueue] Error al iniciar procesamiento:', error?.message || error);
        });
    }

    stop() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
    }

    async enqueueCampaign(campaign = {}, options = {}) {
        const config = obtenerConfigPush();
        const organizerKey = resolverOrganizerKeyPush(campaign);
        const eventType = String(campaign.eventType || PUSH_CAMPAIGN_EVENT_TYPE_NUEVA_RIFA).trim();
        let eventKey = String(campaign.eventKey || '').trim()
            || (eventType === PUSH_CAMPAIGN_EVENT_TYPE_NUEVA_RIFA
                ? `${eventType}:rifa:${Number.parseInt(campaign.rifaId, 10) || String(campaign.rifaSlug || 'sin-id').trim() || 'sin-id'}`
                : '');

        if (options.force && eventKey) {
            eventKey = `${eventKey}:manual:${Date.now()}`;
        }

        if (!config.enabled) {
            return {
                queued: false,
                enabled: false,
                skipped: true,
                reason: 'push_not_configured',
                job: null
            };
        }

        if (!campaign?.enabled || !organizerKey || !eventType || !eventKey) {
            return {
                queued: false,
                enabled: false,
                skipped: true,
                reason: 'campaign_disabled_or_invalid',
                job: null
            };
        }

        const hasJobsTable = await this.knex.schema.hasTable('push_campaign_jobs');
        if (!hasJobsTable) {
            return {
                queued: false,
                enabled: false,
                skipped: true,
                reason: 'campaign_queue_unavailable',
                job: null
            };
        }

        const audienceMeta = await this.obtenerMetadatosAudiencia({
            organizerKey,
            eventType,
            campaign
        });

        const totalTargets = Number.parseInt(audienceMeta?.totalTargets, 10) || 0;
        const maxTargetSubscriptionId = Number.parseInt(audienceMeta?.maxTargetSubscriptionId, 10) || 0;

        if (!totalTargets || !maxTargetSubscriptionId) {
            return {
                queued: false,
                enabled: true,
                skipped: true,
                reason: audienceMeta?.reason || 'no_active_audience',
                job: null,
                totalTargets: 0
            };
        }

        const jobPayload = {
            organizer_key: organizerKey,
            event_type: eventType,
            event_key: eventKey,
            target_rifa_id: Number.parseInt(campaign.rifaId, 10) || null,
            target_rifa_slug: String(campaign.rifaSlug || '').trim().slice(0, 120) || null,
            campaign: {
                ...campaign,
                organizerKey,
                eventType,
                eventKey
            },
            status: JOB_STATUS_PENDING,
            priority: clampInteger(options.priority, 1, 1000, 100),
            batch_size: clampInteger(options.batchSize, 25, 1000, this.defaultBatchSize),
            concurrency: clampInteger(options.concurrency, 1, 50, this.defaultConcurrency),
            max_target_subscription_id: maxTargetSubscriptionId,
            total_targets: totalTargets,
            created_by_user_id: Number.parseInt(options.createdByUserId, 10) || null,
            created_by_email: String(options.createdByEmail || '').trim().slice(0, 255) || null,
            updated_at: this.knex.fn.now(),
            created_at: this.knex.fn.now()
        };

        const inserted = await this.knex('push_campaign_jobs')
            .insert(jobPayload)
            .onConflict(['organizer_key', 'event_key'])
            .ignore()
            .returning('*');

        const job = Array.isArray(inserted) && inserted.length > 0
            ? inserted[0]
            : await this.knex('push_campaign_jobs')
                .where({
                    organizer_key: organizerKey,
                    event_key: eventKey
                })
                .first();

        if (!job) {
            throw new Error('PUSH_CAMPAIGN_JOB_ENQUEUE_FAILED');
        }

        if (!(Array.isArray(inserted) && inserted.length > 0) && [JOB_STATUS_FAILED, JOB_STATUS_CANCELLED].includes(String(job.status || '').trim())) {
            const retried = await this.knex('push_campaign_jobs')
                .where({ id: job.id })
                .update({
                    status: JOB_STATUS_PENDING,
                    locked_by: null,
                    locked_at: null,
                    heartbeat_at: null,
                    completed_at: null,
                    last_error: null,
                    updated_at: this.knex.fn.now()
                })
                .returning('*');

            const retriedJob = Array.isArray(retried) && retried.length > 0 ? retried[0] : job;
            this.tick().catch(() => {});
            return {
                queued: true,
                enabled: true,
                skipped: false,
                existing: true,
                retried: true,
                job: retriedJob
            };
        }

        this.tick().catch(() => {});

        return {
            queued: Array.isArray(inserted) && inserted.length > 0,
            enabled: true,
            skipped: false,
            existing: !(Array.isArray(inserted) && inserted.length > 0),
            job
        };
    }

    async getJobById(jobId) {
        const id = Number.parseInt(jobId, 10) || 0;
        if (!id) return null;

        const hasJobsTable = await this.knex.schema.hasTable('push_campaign_jobs');
        if (!hasJobsTable) {
            return null;
        }

        return this.knex('push_campaign_jobs')
            .where({ id })
            .first();
    }

    async tick() {
        if (this.running) {
            return;
        }

        this.running = true;
        try {
            while (this.inFlightJobs < this.maxActiveJobs) {
                const job = await this.claimNextJob();
                if (!job) {
                    break;
                }

                this.inFlightJobs += 1;
                this.processClaimedJob(job)
                    .catch((error) => {
                        this.logger.warn(`[PushCampaignQueue] Error procesando job #${job.id}:`, error?.message || error);
                    })
                    .finally(() => {
                        this.inFlightJobs = Math.max(0, this.inFlightJobs - 1);
                    });
            }
        } finally {
            this.running = false;
        }
    }

    async claimNextJob() {
        const hasJobsTable = await this.knex.schema.hasTable('push_campaign_jobs');
        if (!hasJobsTable) {
            return null;
        }

        const staleBefore = new Date(Date.now() - this.staleMs).toISOString();
        return this.knex.transaction(async (trx) => {
            const row = await trx('push_campaign_jobs')
                .where((builder) => {
                    builder
                        .where('status', JOB_STATUS_PENDING)
                        .orWhere((inner) => {
                            inner
                                .where('status', JOB_STATUS_RUNNING)
                                .andWhere((heartbeat) => {
                                    heartbeat
                                        .whereNull('heartbeat_at')
                                        .orWhere('heartbeat_at', '<', staleBefore);
                                });
                        });
                })
                .orderBy('priority', 'desc')
                .orderBy('created_at', 'asc')
                .forUpdate()
                .skipLocked()
                .first('*');

            if (!row?.id) {
                return null;
            }

            const updated = await trx('push_campaign_jobs')
                .where({ id: row.id })
                .update({
                    status: JOB_STATUS_RUNNING,
                    locked_by: this.instanceId,
                    locked_at: trx.fn.now(),
                    heartbeat_at: trx.fn.now(),
                    started_at: row.started_at || trx.fn.now(),
                    attempts: Number.parseInt(row.attempts, 10) + 1,
                    last_error: null,
                    updated_at: trx.fn.now()
                })
                .returning('*');

            return Array.isArray(updated) && updated.length > 0 ? updated[0] : null;
        });
    }

    async processClaimedJob(job) {
        try {
            await this.processJob(job);
        } catch (error) {
            await this.knex('push_campaign_jobs')
                .where({ id: job.id })
                .update({
                    status: JOB_STATUS_FAILED,
                    last_error: String(error?.stack || error?.message || error || 'Unknown queue error').slice(0, 12000),
                    completed_at: this.knex.fn.now(),
                    heartbeat_at: this.knex.fn.now(),
                    updated_at: this.knex.fn.now()
                });
            throw error;
        }
    }

    async processJob(job) {
        const campaign = job?.campaign || {};
        const payloadData = construirPayloadCampana(job.event_type, campaign);
        const payload = JSON.stringify(payloadData);
        const batchSize = clampInteger(job.batch_size, 25, 1000, this.defaultBatchSize);
        const concurrency = clampInteger(job.concurrency, 1, 50, this.defaultConcurrency);
        let lastSubscriptionId = Number.parseInt(job.last_subscription_id, 10) || 0;
        const maxSubscriptionId = Number.parseInt(job.max_target_subscription_id, 10) || null;
        let delivered = Number.parseInt(job.delivered_count, 10) || 0;
        let failed = Number.parseInt(job.failed_count, 10) || 0;
        let expired = Number.parseInt(job.expired_count, 10) || 0;
        let processed = Number.parseInt(job.processed_count, 10) || 0;

        while (true) {
            const rows = await this.obtenerLoteAudiencia(job, {
                lastSubscriptionId,
                maxSubscriptionId,
                batchSize
            });

            if (!rows.length) {
                break;
            }

            const batchSummary = {
                delivered: 0,
                failed: 0,
                expired: 0
            };

            await mapWithConcurrency(rows, concurrency, async (row) => {
                const result = await this.enviarSuscripcionCampana(job, row, payload);
                if (result === 'delivered') batchSummary.delivered += 1;
                if (result === 'failed') batchSummary.failed += 1;
                if (result === 'expired') batchSummary.expired += 1;
            });

            lastSubscriptionId = Number.parseInt(rows[rows.length - 1]?.id, 10) || lastSubscriptionId;
            delivered += batchSummary.delivered;
            failed += batchSummary.failed;
            expired += batchSummary.expired;
            processed += rows.length;

            await this.knex('push_campaign_jobs')
                .where({ id: job.id })
                .update({
                    last_subscription_id: lastSubscriptionId,
                    processed_count: processed,
                    delivered_count: delivered,
                    failed_count: failed,
                    expired_count: expired,
                    heartbeat_at: this.knex.fn.now(),
                    updated_at: this.knex.fn.now()
                });
        }

        await this.knex('push_campaign_jobs')
            .where({ id: job.id })
            .update({
                status: JOB_STATUS_COMPLETED,
                last_subscription_id: lastSubscriptionId,
                processed_count: processed,
                delivered_count: delivered,
                failed_count: failed,
                expired_count: expired,
                completed_at: this.knex.fn.now(),
                heartbeat_at: this.knex.fn.now(),
                updated_at: this.knex.fn.now()
            });

        await registrarEventoCampanaPushEnviado(this.knex, {
            organizerKey: job.organizer_key,
            eventType: job.event_type,
            eventKey: job.event_key,
            targetRifaId: job.target_rifa_id,
            targetRifaSlug: job.target_rifa_slug,
            payload: payloadData,
            totalTargets: Number.parseInt(job.total_targets, 10) || processed,
            deliveredCount: delivered,
            failedCount: failed,
            expiredCount: expired
        });

        this.logger.info?.(`[PushCampaignQueue] Job #${job.id} completado (${delivered} entregadas, ${failed} fallidas, ${expired} expiradas de ${processed} procesadas)`);
    }

    async obtenerMetadatosAudiencia({ organizerKey, eventType, campaign = {} }) {
        const audienceMode = resolverModoAudienciaJob({ event_type: eventType });

        if (audienceMode === AUDIENCE_MODE_MARKETING) {
            const hasSubscriptionsTable = await this.knex.schema.hasTable('push_campaign_subscriptions');
            if (!hasSubscriptionsTable) {
                return { totalTargets: 0, maxTargetSubscriptionId: 0, reason: 'campaign_queue_unavailable' };
            }

            await this.refrescarAudienciaMarketing(organizerKey, campaign);

            const audienceQuery = this.knex('push_campaign_subscriptions')
                .where({
                    organizer_key: organizerKey,
                    status: PUSH_STATUS_ACTIVE,
                    marketing_opt_in: true,
                    audience_status: PUSH_CAMPAIGN_AUDIENCE_ACTIVE
                });

            const [countRow, maxRow] = await Promise.all([
                audienceQuery.clone().count('* as total').first(),
                audienceQuery.clone().max('id as max_id').first()
            ]);

            return {
                totalTargets: Number.parseInt(countRow?.total, 10) || 0,
                maxTargetSubscriptionId: Number.parseInt(maxRow?.max_id, 10) || 0,
                reason: 'no_recent_marketing_audience'
            };
        }

        const targetRifaId = Number.parseInt(campaign?.rifaId, 10) || 0;
        const hasOrderSubscriptionsTable = await this.knex.schema.hasTable('push_subscriptions');
        if (!hasOrderSubscriptionsTable || !targetRifaId) {
            return { totalTargets: 0, maxTargetSubscriptionId: 0, reason: 'no_current_rifa_audience' };
        }

        const [countRow, maxRow] = await Promise.all([
            this.knex('push_subscriptions')
                .where({
                    rifa_id: targetRifaId,
                    status: PUSH_STATUS_ACTIVE
                })
                .countDistinct('subscription_hash as total')
                .first(),
            this.knex('push_subscriptions')
                .where({
                    rifa_id: targetRifaId,
                    status: PUSH_STATUS_ACTIVE
                })
                .max('id as max_id')
                .first()
        ]);

        return {
            totalTargets: Number.parseInt(countRow?.total, 10) || 0,
            maxTargetSubscriptionId: Number.parseInt(maxRow?.max_id, 10) || 0,
            reason: 'no_current_rifa_audience'
        };
    }

    async refrescarAudienciaMarketing(organizerKey, campaign = {}) {
        const policy = resolverPoliticaAudienciaCampana(campaign);
        const cutoffDate = new Date(Date.now() - (policy.marketingRecencyDays * 24 * 60 * 60 * 1000)).toISOString();

        await this.knex('push_campaign_subscriptions')
            .where({ organizer_key: organizerKey })
            .whereNot({
                status: PUSH_STATUS_EXPIRED
            })
            .update({
                audience_status: this.knex.raw(`
                    CASE
                        WHEN status = ? AND marketing_opt_in = true 
                             AND (
                                COALESCE(last_purchase_at, created_at) >= ?
                                OR updated_at >= ?
                             )
                            THEN ?
                        ELSE 'inactive'
                    END
                `, [PUSH_STATUS_ACTIVE, cutoffDate, cutoffDate, PUSH_CAMPAIGN_AUDIENCE_ACTIVE]),
                updated_at: this.knex.fn.now()
            });
    }

    async obtenerLoteAudiencia(job, options = {}) {
        const audienceMode = resolverModoAudienciaJob(job);
        const lastSubscriptionId = Number.parseInt(options.lastSubscriptionId, 10) || 0;
        const maxSubscriptionId = Number.parseInt(options.maxSubscriptionId, 10) || null;
        const batchSize = clampInteger(options.batchSize, 25, 1000, this.defaultBatchSize);

        if (audienceMode === AUDIENCE_MODE_MARKETING) {
            return this.knex('push_campaign_subscriptions')
                .select('id', 'subscription_hash', 'subscription', 'endpoint')
                .where({
                    organizer_key: job.organizer_key,
                    status: PUSH_STATUS_ACTIVE,
                    marketing_opt_in: true,
                    audience_status: PUSH_CAMPAIGN_AUDIENCE_ACTIVE
                })
                .andWhere('id', '>', lastSubscriptionId)
                .modify((query) => {
                    if (maxSubscriptionId) {
                        query.andWhere('id', '<=', maxSubscriptionId);
                    }
                })
                .orderBy('id', 'asc')
                .limit(batchSize);
        }

        const targetRifaId = Number.parseInt(job.target_rifa_id, 10) || 0;
        if (!targetRifaId) {
            return [];
        }

        return this.knex('push_subscriptions')
            .select(
                this.knex.raw('MAX(id)::int as id'),
                'subscription_hash',
                'subscription',
                'endpoint'
            )
            .where({
                rifa_id: targetRifaId,
                status: PUSH_STATUS_ACTIVE
            })
            .andWhere('id', '>', lastSubscriptionId)
            .modify((query) => {
                if (maxSubscriptionId) {
                    query.andWhere('id', '<=', maxSubscriptionId);
                }
            })
            .groupBy('subscription_hash', 'subscription', 'endpoint')
            .orderBy('id', 'asc')
            .limit(batchSize);
    }

    async enviarSuscripcionCampana(job, subscriptionRow, payload) {
        const subscription = normalizarSubscriptionPush(subscriptionRow.subscription);
        if (!subscription) {
            await this.marcarSuscripcionCampanaInvalida(job, subscriptionRow, 'Suscripcion inválida');
            return 'expired';
        }

        try {
            const pushOptions = construirOpcionesPushCampana(job, subscription.endpoint);
            console.log(`[PushCampaignQueue] 🚀 Envíando a ${subscriptionRow.endpoint.substring(0, 50)}... (Key: ${job.organizer_key})`);
            
            await enviarNotificacionPushConRetry(subscription, payload, pushOptions);
            
            console.log(`[PushCampaignQueue] ✅ Entregado a ${subscriptionRow.endpoint.substring(0, 50)}...`);
            await this.marcarSuscripcionCampanaEntregada(job, subscriptionRow);
            return 'delivered';
        } catch (error) {
            const statusCode = Number(error?.statusCode || error?.status || 0);
            const message = String(error?.body || error?.message || 'Push delivery failed').slice(0, 2000);
            
            console.log(`[PushCampaignQueue] ❌ Fallo (${statusCode}): ${message.substring(0, 100)}`);
            if (statusCode === 404 || statusCode === 410) {
                await this.marcarSuscripcionCampanaInvalida(job, subscriptionRow, message);
                return 'expired';
            }

            await this.marcarSuscripcionCampanaConError(job, subscriptionRow, message);
            return 'failed';
        }
    }

    async marcarSuscripcionCampanaEntregada(job, subscriptionRow) {
        const audienceMode = resolverModoAudienciaJob(job);
        if (audienceMode === AUDIENCE_MODE_MARKETING) {
            await this.knex('push_campaign_subscriptions')
                .where({ id: subscriptionRow.id })
                .update({
                    last_notified_at: this.knex.fn.now(),
                    last_error: null,
                    last_error_at: null,
                    updated_at: this.knex.fn.now()
                });
            return;
        }

        await Promise.all([
            this.knex('push_subscriptions')
                .where({
                    rifa_id: job.target_rifa_id,
                    subscription_hash: subscriptionRow.subscription_hash
                })
                .update({
                    last_notified_at: this.knex.fn.now(),
                    last_error: null,
                    last_error_at: null,
                    updated_at: this.knex.fn.now()
                }),
            this.knex('push_campaign_subscriptions')
                .where({
                    organizer_key: job.organizer_key,
                    subscription_hash: subscriptionRow.subscription_hash
                })
                .update({
                    last_notified_at: this.knex.fn.now(),
                    last_error: null,
                    last_error_at: null,
                    updated_at: this.knex.fn.now()
                })
        ]);
    }

    async marcarSuscripcionCampanaInvalida(job, subscriptionRow, message) {
        const audienceMode = resolverModoAudienciaJob(job);
        if (audienceMode === AUDIENCE_MODE_MARKETING) {
            await this.knex('push_campaign_subscriptions')
                .where({ id: subscriptionRow.id })
                .update({
                    status: PUSH_STATUS_EXPIRED,
                    audience_status: 'inactive',
                    revoked_at: this.knex.fn.now(),
                    last_error: String(message || '').slice(0, 2000) || null,
                    last_error_at: this.knex.fn.now(),
                    updated_at: this.knex.fn.now()
                });
            return;
        }

        await Promise.all([
            this.knex('push_subscriptions')
                .where({
                    rifa_id: job.target_rifa_id,
                    subscription_hash: subscriptionRow.subscription_hash
                })
                .update({
                    status: PUSH_STATUS_EXPIRED,
                    revoked_at: this.knex.fn.now(),
                    last_error: String(message || '').slice(0, 2000) || null,
                    last_error_at: this.knex.fn.now(),
                    updated_at: this.knex.fn.now()
                }),
            this.knex('push_campaign_subscriptions')
                .where({
                    organizer_key: job.organizer_key,
                    subscription_hash: subscriptionRow.subscription_hash
                })
                .update({
                    status: PUSH_STATUS_EXPIRED,
                    audience_status: 'inactive',
                    revoked_at: this.knex.fn.now(),
                    last_error: String(message || '').slice(0, 2000) || null,
                    last_error_at: this.knex.fn.now(),
                    updated_at: this.knex.fn.now()
                })
        ]);
    }

    async marcarSuscripcionCampanaConError(job, subscriptionRow, message) {
        const audienceMode = resolverModoAudienciaJob(job);
        if (audienceMode === AUDIENCE_MODE_MARKETING) {
            await this.knex('push_campaign_subscriptions')
                .where({ id: subscriptionRow.id })
                .update({
                    last_error: message,
                    last_error_at: this.knex.fn.now(),
                    updated_at: this.knex.fn.now()
                });
            return;
        }

        await Promise.all([
            this.knex('push_subscriptions')
                .where({
                    rifa_id: job.target_rifa_id,
                    subscription_hash: subscriptionRow.subscription_hash
                })
                .update({
                    last_error: message,
                    last_error_at: this.knex.fn.now(),
                    updated_at: this.knex.fn.now()
                }),
            this.knex('push_campaign_subscriptions')
                .where({
                    organizer_key: job.organizer_key,
                    subscription_hash: subscriptionRow.subscription_hash
                })
                .update({
                    last_error: message,
                    last_error_at: this.knex.fn.now(),
                    updated_at: this.knex.fn.now()
                })
        ]);
    }
}

module.exports = {
    PushCampaignQueueService,
    JOB_STATUS_PENDING,
    JOB_STATUS_RUNNING,
    JOB_STATUS_COMPLETED,
    JOB_STATUS_FAILED,
    JOB_STATUS_CANCELLED,
    AUDIENCE_MODE_MARKETING,
    AUDIENCE_MODE_RIFA_PARTICIPANTS,
    resolverPoliticaAudienciaCampana,
    resolverModoAudienciaJob
};
