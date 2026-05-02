require('dotenv').config();
const knex = require('knex');
const knexConfig = require('./knexfile');
const db = knex(knexConfig.development);

async function check() {
  try {
    const rows = await db('push_campaign_subscriptions')
        .select('status', 'audience_status', 'last_error', 'last_error_at')
        .count('* as total')
        .groupBy('status', 'audience_status', 'last_error', 'last_error_at');
    console.log('--- SUBSCRIPTION STATUS ---');
    console.log(JSON.stringify(rows, null, 2));
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

check();
