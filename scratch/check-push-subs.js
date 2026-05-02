const knex = require('knex');
const knexConfig = require('./backend/knexfile');
const db = knex(knexConfig.development);

async function check() {
  try {
    const subs = await db('push_campaign_subscriptions').select('organizer_key', 'status', 'marketing_opt_in', 'audience_status', 'last_purchase_at').limit(5);
    console.log('--- SUBSCRIPTIONS ---');
    console.log(JSON.stringify(subs, null, 2));
    
    const count = await db('push_campaign_subscriptions').count('* as total').first();
    console.log('Total subscriptions:', count.total);

    const activeCount = await db('push_campaign_subscriptions').where({ audience_status: 'active' }).count('* as total').first();
    console.log('Active audience:', activeCount.total);

    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

check();
