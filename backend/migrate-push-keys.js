require('dotenv').config();
const knex = require('knex');
const knexConfig = require('./knexfile');
const db = knex(knexConfig.development);

async function migrate() {
  try {
    console.log('🚀 Iniciando migracion de audiencia push...');
    const targetKey = 'sorteos-sadev';
    const oldKey = 'rifaplus';
    
    const count = await db('push_campaign_subscriptions').where('organizer_key', oldKey).count('* as total').first();
    console.log(`Encontrados ${count.total} suscriptores con clave "${oldKey}"`);

    if (count.total > 0) {
        const updated = await db('push_campaign_subscriptions')
            .where('organizer_key', oldKey)
            .update({ organizer_key: targetKey });
        console.log(`✅ Actualizados ${updated} suscriptores a la clave "${targetKey}"`);
    } else {
        console.log('ℹ️ No hay suscriptores antiguos para migrar.');
    }

    // Opcional: Migrar tambien los eventos para que el historial sea consistente
    const eventsUpdated = await db('push_campaign_events')
        .where('organizer_key', oldKey)
        .update({ organizer_key: targetKey });
    if (eventsUpdated > 0) console.log(`✅ Actualizados ${eventsUpdated} eventos de campaña.`);

    process.exit(0);
  } catch (err) {
    console.error('❌ Error en migracion:', err);
    process.exit(1);
  }
}

migrate();
