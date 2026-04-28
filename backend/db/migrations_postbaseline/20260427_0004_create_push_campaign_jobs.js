exports.up = async function up(knex) {
    const hasJobsTable = await knex.schema.hasTable('push_campaign_jobs');
    if (!hasJobsTable) {
        await knex.schema.createTable('push_campaign_jobs', (table) => {
            table.increments('id').primary();
            table.string('organizer_key', 120).notNullable();
            table.string('event_type', 80).notNullable();
            table.string('event_key', 180).notNullable();
            table.integer('target_rifa_id').nullable();
            table.string('target_rifa_slug', 120).nullable();
            table.jsonb('campaign').notNullable();
            table.string('status', 20).notNullable().defaultTo('pending');
            table.integer('priority').notNullable().defaultTo(100);
            table.integer('batch_size').notNullable().defaultTo(250);
            table.integer('concurrency').notNullable().defaultTo(20);
            table.integer('max_target_subscription_id').nullable();
            table.integer('last_subscription_id').notNullable().defaultTo(0);
            table.integer('total_targets').notNullable().defaultTo(0);
            table.integer('processed_count').notNullable().defaultTo(0);
            table.integer('delivered_count').notNullable().defaultTo(0);
            table.integer('failed_count').notNullable().defaultTo(0);
            table.integer('expired_count').notNullable().defaultTo(0);
            table.integer('attempts').notNullable().defaultTo(0);
            table.integer('created_by_user_id').nullable();
            table.string('created_by_email', 255).nullable();
            table.string('locked_by', 180).nullable();
            table.timestamp('locked_at').nullable();
            table.timestamp('heartbeat_at').nullable();
            table.timestamp('started_at').nullable();
            table.timestamp('completed_at').nullable();
            table.text('last_error').nullable();
            table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
            table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

            table.unique(['organizer_key', 'event_key'], {
                indexName: 'push_campaign_jobs_unique_event_key'
            });
            table.index(['status', 'priority', 'created_at'], 'push_campaign_jobs_status_priority_idx');
            table.index(['organizer_key', 'created_at'], 'push_campaign_jobs_organizer_idx');
            table.index(['heartbeat_at'], 'push_campaign_jobs_heartbeat_idx');
        });
    }
};

exports.down = async function down(knex) {
    const hasJobsTable = await knex.schema.hasTable('push_campaign_jobs');
    if (hasJobsTable) {
        await knex.schema.dropTable('push_campaign_jobs');
    }
};
