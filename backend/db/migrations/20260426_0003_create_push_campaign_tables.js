exports.up = async function up(knex) {
    const hasSubscriptionsTable = await knex.schema.hasTable('push_campaign_subscriptions');
    if (!hasSubscriptionsTable) {
        await knex.schema.createTable('push_campaign_subscriptions', (table) => {
            table.increments('id').primary();
            table.string('organizer_key', 120).notNullable();
            table.string('telefono_cliente', 30).nullable();
            table.string('subscription_hash', 64).notNullable();
            table.text('endpoint').notNullable();
            table.jsonb('subscription').notNullable();
            table.string('user_agent', 2000).nullable();
            table.string('permission_estado', 20).notNullable().defaultTo('granted');
            table.string('status', 20).notNullable().defaultTo('active');
            table.boolean('marketing_opt_in').notNullable().defaultTo(true);
            table.integer('source_rifa_id').nullable();
            table.string('source_rifa_slug', 120).nullable();
            table.string('source_numero_orden', 80).nullable();
            table.timestamp('last_notified_at').nullable();
            table.text('last_error').nullable();
            table.timestamp('last_error_at').nullable();
            table.timestamp('revoked_at').nullable();
            table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
            table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

            table.unique(['organizer_key', 'subscription_hash'], {
                indexName: 'push_campaign_subscriptions_unique_endpoint'
            });
            table.index(['organizer_key', 'status', 'marketing_opt_in'], 'push_campaign_subscriptions_status_idx');
        });
    }

    const hasEventsTable = await knex.schema.hasTable('push_campaign_events');
    if (!hasEventsTable) {
        await knex.schema.createTable('push_campaign_events', (table) => {
            table.increments('id').primary();
            table.string('organizer_key', 120).notNullable();
            table.string('event_type', 80).notNullable();
            table.string('event_key', 180).notNullable();
            table.integer('target_rifa_id').nullable();
            table.string('target_rifa_slug', 120).nullable();
            table.jsonb('payload').nullable();
            table.integer('total_targets').notNullable().defaultTo(0);
            table.integer('delivered_count').notNullable().defaultTo(0);
            table.integer('failed_count').notNullable().defaultTo(0);
            table.integer('expired_count').notNullable().defaultTo(0);
            table.timestamp('sent_at').notNullable().defaultTo(knex.fn.now());
            table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
            table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

            table.unique(['organizer_key', 'event_key'], {
                indexName: 'push_campaign_events_unique_event_key'
            });
            table.index(['organizer_key', 'event_type'], 'push_campaign_events_type_idx');
            table.index(['sent_at'], 'push_campaign_events_sent_at_idx');
        });
    }
};

exports.down = async function down(knex) {
    const hasEventsTable = await knex.schema.hasTable('push_campaign_events');
    if (hasEventsTable) {
        await knex.schema.dropTable('push_campaign_events');
    }

    const hasSubscriptionsTable = await knex.schema.hasTable('push_campaign_subscriptions');
    if (hasSubscriptionsTable) {
        await knex.schema.dropTable('push_campaign_subscriptions');
    }
};
