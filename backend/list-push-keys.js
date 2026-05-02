require('dotenv').config();
const knex = require('knex');
const knexConfig = require('./knexfile');
const db = knex(knexConfig.development);

async function list() {
  try {
    const rows = await db('push_campaign_subscriptions').select('organizer_key').count('* as total').groupBy('organizer_key');
    console.log('--- ORGANIZER KEYS IN DB ---');
    console.log(JSON.stringify(rows, null, 2));
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

list();
