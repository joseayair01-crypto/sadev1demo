exports.up = async function up(knex) {
    const hasTable = await knex.schema.hasTable('push_notification_events');
    if (hasTable) {
        return;
    }

    await knex.schema.createTable('push_notification_events', (table) => {
        table.increments('id').primary();
        table.integer('rifa_id').notNullable();
        table.string('numero_orden', 80).notNullable();
        table.string('event_type', 80).notNullable();
        table.string('event_key', 180).notNullable();
        table.jsonb('payload').nullable();
        table.integer('total_targets').notNullable().defaultTo(0);
        table.integer('delivered_count').notNullable().defaultTo(0);
        table.integer('failed_count').notNullable().defaultTo(0);
        table.integer('expired_count').notNullable().defaultTo(0);
        table.timestamp('sent_at').notNullable().defaultTo(knex.fn.now());
        table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
        table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

        table.unique(['rifa_id', 'numero_orden', 'event_key'], {
            indexName: 'push_notification_events_unique_event_key'
        });
        table.index(['rifa_id', 'numero_orden', 'event_type'], 'push_notification_events_order_type_idx');
        table.index(['sent_at'], 'push_notification_events_sent_at_idx');
    });

    await knex.raw(`
        ALTER TABLE push_notification_events
        ADD CONSTRAINT push_notification_events_rifa_id_foreign
        FOREIGN KEY (rifa_id) REFERENCES rifas(id) ON DELETE CASCADE
    `);
};

exports.down = async function down(knex) {
    const hasTable = await knex.schema.hasTable('push_notification_events');
    if (!hasTable) {
        return;
    }

    await knex.raw(`
        ALTER TABLE push_notification_events
        DROP CONSTRAINT IF EXISTS push_notification_events_rifa_id_foreign
    `);

    await knex.schema.dropTable('push_notification_events');
};
