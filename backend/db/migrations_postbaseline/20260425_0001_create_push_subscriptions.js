exports.up = async function up(knex) {
    const hasTable = await knex.schema.hasTable('push_subscriptions');
    if (hasTable) {
        return;
    }

    await knex.schema.createTable('push_subscriptions', (table) => {
        table.increments('id').primary();
        table.integer('rifa_id').notNullable();
        table.string('numero_orden', 80).notNullable();
        table.string('telefono_cliente', 20).nullable();
        table.string('subscription_hash', 64).notNullable();
        table.text('endpoint').notNullable();
        table.jsonb('subscription').notNullable();
        table.text('user_agent').nullable();
        table.string('permission_estado', 20).notNullable().defaultTo('granted');
        table.string('status', 20).notNullable().defaultTo('active');
        table.timestamp('last_notified_at').nullable();
        table.text('last_error').nullable();
        table.timestamp('last_error_at').nullable();
        table.timestamp('revoked_at').nullable();
        table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
        table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

        table.unique(['rifa_id', 'numero_orden', 'subscription_hash'], {
            indexName: 'push_subscriptions_unique_order_endpoint'
        });
        table.index(['rifa_id', 'numero_orden', 'status'], 'push_subscriptions_order_status_idx');
        table.index(['status', 'updated_at'], 'push_subscriptions_status_updated_idx');
    });

    await knex.raw(`
        ALTER TABLE push_subscriptions
        ADD CONSTRAINT push_subscriptions_rifa_id_foreign
        FOREIGN KEY (rifa_id) REFERENCES rifas(id) ON DELETE CASCADE
    `);
};

exports.down = async function down(knex) {
    const hasTable = await knex.schema.hasTable('push_subscriptions');
    if (!hasTable) {
        return;
    }

    await knex.raw(`
        ALTER TABLE push_subscriptions
        DROP CONSTRAINT IF EXISTS push_subscriptions_rifa_id_foreign
    `);

    await knex.schema.dropTable('push_subscriptions');
};
