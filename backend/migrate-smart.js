const path = require('path');
const knexFactory = require('knex');
const knexConfig = require('./knexfile');

const BASELINE_MIGRATION = '20260325_0001_baseline_schema.js';
const APP_TABLES = [
  'ordenes',
  'admin_users',
  'boletos_estado',
  'orden_oportunidades',
  'ganadores',
  'order_id_counter',
  'rifas'
];

const environment = process.env.NODE_ENV || 'development';
const config = knexConfig[environment];

if (!config) {
  throw new Error(`No existe configuración de Knex para el entorno "${environment}"`);
}

const db = knexFactory(config);

async function obtenerMigracionesAplicadas() {
  const hasMigrationsTable = await db.schema.hasTable('knex_migrations');
  if (!hasMigrationsTable) {
    return [];
  }

  const rows = await db('knex_migrations')
    .select('name')
    .orderBy('id', 'asc');

  return rows.map((row) => String(row.name || '').trim()).filter(Boolean);
}

async function obtenerTablasOperativas() {
  const checks = await Promise.all(
    APP_TABLES.map(async (table) => ({
      table,
      exists: await db.schema.hasTable(table)
    }))
  );

  return checks.filter((item) => item.exists).map((item) => item.table);
}

async function detectarModoMigracion() {
  const applied = await obtenerMigracionesAplicadas();
  const tablas = await obtenerTablasOperativas();

  if (tablas.length === 0) {
    if (applied.length > 0) {
      const error = new Error(
        'La BD no tiene tablas operativas, pero sí historial de migraciones. Aborto para evitar reconstruir sobre un historial inconsistente.'
      );
      error.code = 'DB_EMPTY_WITH_HISTORY';
      throw error;
    }

    return {
      mode: 'bootstrap',
      tablas,
      applied
    };
  }

  if (applied.length === 0) {
    const error = new Error(
      'La BD ya tiene tablas operativas pero no tiene historial de migraciones. Aborto para evitar asumir un estado incorrecto.'
    );
    error.code = 'DB_WITHOUT_HISTORY';
    throw error;
  }

  if (applied.includes(BASELINE_MIGRATION)) {
    return {
      mode: 'baseline-managed',
      tablas,
      applied
    };
  }

  return {
    mode: 'legacy',
    tablas,
    applied
  };
}

async function ejecutarMigraciones(directories, label) {
  const directoriesList = Array.isArray(directories) ? directories : [directories];
  const absoluteDirs = directoriesList.map((directory) => path.resolve(__dirname, directory));
  const [batchNo, log] = await db.migrate.latest({
    directory: absoluteDirs,
    sortDirsSeparately: true
  });

  console.log(`\n📦 ${label}`);
  console.log(`   Directorios: ${absoluteDirs.join(' | ')}`);
  console.log(`   Batch: ${batchNo}`);
  if (log.length === 0) {
    console.log('   Sin cambios pendientes');
  } else {
    log.forEach((name) => console.log(`   ✅ ${name}`));
  }
}

async function main() {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║  SMART MIGRATE - RifaPlus                                ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  try {
    const detection = await detectarModoMigracion();

    console.log(`Modo detectado: ${detection.mode}`);
    console.log(`Tablas operativas: ${detection.tablas.length > 0 ? detection.tablas.join(', ') : 'ninguna'}`);
    console.log(`Migraciones registradas: ${detection.applied.length}\n`);

    if (detection.mode === 'bootstrap') {
      await ejecutarMigraciones(
        ['./db/migrations_baseline', './db/migrations_postbaseline'],
        'Aplicando baseline completo para BD nueva'
      );
    } else if (detection.mode === 'baseline-managed') {
      await ejecutarMigraciones(
        ['./db/migrations_baseline', './db/migrations_postbaseline'],
        'Aplicando ajustes posteriores a baseline'
      );
    } else {
      await ejecutarMigraciones('./db/migrations', 'Aplicando historial incremental legacy');
    }

    console.log('\n✅ Migración completada sin sorpresas.\n');
  } catch (error) {
    console.error('\n❌ Error en smart migrate:', error.message);
    if (process.env.NODE_ENV === 'development') {
      console.error(error);
    }
    process.exitCode = 1;
  } finally {
    await db.destroy();
  }
}

main();
