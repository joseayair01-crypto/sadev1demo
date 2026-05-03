const path = require('path');
const knexConfig = require(path.resolve(__dirname, '..', 'knexfile')).production;
const knex = require('knex')(knexConfig);

const RIFA_ID = Number(process.argv[2] || process.env.RIFA_ID || 1);
const CLIENTE_KEY = `rifa_${RIFA_ID}`;

function timestamp() {
  const d = new Date();
  return d.toISOString().replace(/[:.]/g, '-');
}

(async () => {
  try {
    const counter = await knex('order_id_counter')
      .where({ cliente_id: CLIENTE_KEY, rifa_id: RIFA_ID })
      .first();

    const backupTable = `order_id_counter_backup_${timestamp()}`;

    console.log('Found counter row:', !!counter);
    console.log('Creating backup table:', backupTable);

    // Create backup table with same structure as order_id_counter (best-effort)
    const exists = await knex.schema.hasTable('order_id_counter');
    if (!exists) {
      throw new Error('Table order_id_counter does not exist');
    }

    // Create backup table and copy row (if exists)
    await knex.raw(`CREATE TABLE IF NOT EXISTS "${backupTable}" AS TABLE order_id_counter WITH NO DATA`);
    if (counter) {
      await knex(backupTable).insert(counter);
      console.log('Backed up current counter row to', backupTable);
    } else {
      console.log('No existing counter row to backup');
    }

    // Prepare reset values
    const reset = {
      cliente_id: CLIENTE_KEY,
      rifa_id: RIFA_ID,
      ultima_secuencia: 'AA',
      ultimo_numero: 0,
      proximo_numero: 1,
      contador_total: 0,
      activo: true,
      fecha_ultimo_reset: new Date(),
      updated_at: new Date()
    };

    if (counter) {
      // Update existing row
      await knex('order_id_counter')
        .where({ id: counter.id })
        .update(reset);
      console.log('Updated existing counter row id=', counter.id);
    } else {
      // Insert new row
      await knex('order_id_counter').insert({
        ...reset,
        created_at: new Date()
      });
      console.log('Inserted new counter row for', CLIENTE_KEY);
    }

    console.log('Counter reset complete. New state:');
    const nowRow = await knex('order_id_counter')
      .where({ cliente_id: CLIENTE_KEY, rifa_id: RIFA_ID })
      .first();
    console.log(JSON.stringify(nowRow, null, 2));

    process.exit(0);
  } catch (err) {
    console.error('Error resetting counter:', err && (err.message || err));
    process.exit(1);
  } finally {
    await knex.destroy();
  }
})();
