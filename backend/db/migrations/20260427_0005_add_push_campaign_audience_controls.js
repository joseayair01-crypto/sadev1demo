exports.up = async function up(knex) {
    const hasSubscriptionsTable = await knex.schema.hasTable('push_campaign_subscriptions');
    if (!hasSubscriptionsTable) {
        return;
    }

    const hasAudienceStatus = await knex.schema.hasColumn('push_campaign_subscriptions', 'audience_status');
    if (!hasAudienceStatus) {
        await knex.schema.alterTable('push_campaign_subscriptions', (table) => {
            table.string('audience_status', 20).notNullable().defaultTo('active');
        });
    }

    const hasLastPurchaseAt = await knex.schema.hasColumn('push_campaign_subscriptions', 'last_purchase_at');
    if (!hasLastPurchaseAt) {
        await knex.schema.alterTable('push_campaign_subscriptions', (table) => {
            table.timestamp('last_purchase_at').nullable();
        });
    }

    const hasLastPurchaseRifaId = await knex.schema.hasColumn('push_campaign_subscriptions', 'last_purchase_rifa_id');
    if (!hasLastPurchaseRifaId) {
        await knex.schema.alterTable('push_campaign_subscriptions', (table) => {
            table.integer('last_purchase_rifa_id').nullable();
        });
    }

    const hasLastPurchaseRifaSlug = await knex.schema.hasColumn('push_campaign_subscriptions', 'last_purchase_rifa_slug');
    if (!hasLastPurchaseRifaSlug) {
        await knex.schema.alterTable('push_campaign_subscriptions', (table) => {
            table.string('last_purchase_rifa_slug', 120).nullable();
        });
    }

    await knex.raw(`
        UPDATE push_campaign_subscriptions
        SET audience_status = CASE
            WHEN status = 'active' AND marketing_opt_in = true THEN 'active'
            ELSE 'inactive'
        END
        WHERE audience_status IS NULL
           OR TRIM(COALESCE(audience_status, '')) = ''
    `);

    await knex.raw(`
        UPDATE push_campaign_subscriptions
        SET last_purchase_rifa_id = COALESCE(last_purchase_rifa_id, source_rifa_id),
            last_purchase_rifa_slug = COALESCE(NULLIF(TRIM(last_purchase_rifa_slug), ''), NULLIF(TRIM(source_rifa_slug), ''))
        WHERE source_rifa_id IS NOT NULL
           OR NULLIF(TRIM(source_rifa_slug), '') IS NOT NULL
    `);

    await knex.raw(`
        CREATE INDEX IF NOT EXISTS push_campaign_subscriptions_marketing_audience_idx
        ON push_campaign_subscriptions (organizer_key, status, marketing_opt_in, audience_status, last_purchase_at DESC, id DESC)
    `);
};

exports.down = async function down(knex) {
    const hasSubscriptionsTable = await knex.schema.hasTable('push_campaign_subscriptions');
    if (!hasSubscriptionsTable) {
        return;
    }

    await knex.raw('DROP INDEX IF EXISTS push_campaign_subscriptions_marketing_audience_idx');

    const hasLastPurchaseRifaSlug = await knex.schema.hasColumn('push_campaign_subscriptions', 'last_purchase_rifa_slug');
    if (hasLastPurchaseRifaSlug) {
        await knex.schema.alterTable('push_campaign_subscriptions', (table) => {
            table.dropColumn('last_purchase_rifa_slug');
        });
    }

    const hasLastPurchaseRifaId = await knex.schema.hasColumn('push_campaign_subscriptions', 'last_purchase_rifa_id');
    if (hasLastPurchaseRifaId) {
        await knex.schema.alterTable('push_campaign_subscriptions', (table) => {
            table.dropColumn('last_purchase_rifa_id');
        });
    }

    const hasLastPurchaseAt = await knex.schema.hasColumn('push_campaign_subscriptions', 'last_purchase_at');
    if (hasLastPurchaseAt) {
        await knex.schema.alterTable('push_campaign_subscriptions', (table) => {
            table.dropColumn('last_purchase_at');
        });
    }

    const hasAudienceStatus = await knex.schema.hasColumn('push_campaign_subscriptions', 'audience_status');
    if (hasAudienceStatus) {
        await knex.schema.alterTable('push_campaign_subscriptions', (table) => {
            table.dropColumn('audience_status');
        });
    }
};
