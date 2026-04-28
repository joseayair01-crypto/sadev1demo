const fs = require('fs');
const path = require('path');

function slugify(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

async function obtenerConfigActual(knex) {
  try {
    const hasTable = await knex.schema.hasTable('sorteo_configuracion');
    if (hasTable) {
      const row = await knex('sorteo_configuracion')
        .where('clave', 'config_principal')
        .first();

      if (row?.valor) {
        return typeof row.valor === 'string' ? JSON.parse(row.valor) : row.valor;
      }
    }
  } catch (error) {
    // fallback a disco debajo
  }

  try {
    const configPath = path.resolve(__dirname, '../../config.json');
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    return {};
  }
}

async function obtenerORCrearRifaBase(knex) {
  const existente = await knex('rifas').orderBy('id', 'asc').first();
  if (existente) return existente;

  const config = await obtenerConfigActual(knex);
  const nombre = String(config?.rifa?.nombreSorteo || config?.rifa?.edicionNombre || 'Rifa principal').trim();
  const slugBase = slugify(nombre) || 'rifa-principal';
  let slug = slugBase;
  let intento = 1;

  while (await knex('rifas').where('slug', slug).first()) {
    intento += 1;
    slug = `${slugBase}-${intento}`;
  }

  const [rifa] = await knex('rifas')
    .insert({
      slug,
      nombre,
      estado: String(config?.rifa?.estado || 'activa').trim() || 'activa',
      es_predeterminada: true,
      activa_publica: true,
      configuracion: config && typeof config === 'object' ? config : {},
      created_at: knex.fn.now(),
      updated_at: knex.fn.now()
    })
    .returning(['id', 'slug', 'nombre']);

  return rifa;
}

exports.up = async function up(knex) {
  const hasRifas = await knex.schema.hasTable('rifas');
  if (!hasRifas) {
    await knex.schema.createTable('rifas', (table) => {
      table.increments('id').primary();
      table.string('slug', 100).notNullable().unique();
      table.string('nombre', 255).notNullable();
      table.string('estado', 30).notNullable().defaultTo('activa');
      table.boolean('es_predeterminada').notNullable().defaultTo(false);
      table.boolean('activa_publica').notNullable().defaultTo(false);
      table.string('actualizado_por', 120).nullable();
      table.jsonb('configuracion').notNullable().defaultTo('{}');
      table.jsonb('snapshot_final').nullable();
      table.timestamp('finalizada_at').nullable();
      table.timestamp('depuracion_programada_at').nullable();
      table.timestamp('depurada_at').nullable();
      table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
      table.index(['estado', 'depurada_at']);
      table.index(['activa_publica', 'depurada_at']);
    });
  }

  const rifaBase = await obtenerORCrearRifaBase(knex);
  const rifaBaseId = Number(rifaBase.id);

  const tablasConRifa = [
    'ordenes',
    'boletos_estado',
    'orden_oportunidades',
    'ganadores'
  ];

  for (const tabla of tablasConRifa) {
    const hasTable = await knex.schema.hasTable(tabla);
    if (!hasTable) continue;

    const hasRifaId = await knex.schema.hasColumn(tabla, 'rifa_id');
    if (!hasRifaId) {
      await knex.schema.alterTable(tabla, (table) => {
        table.integer('rifa_id').nullable();
      });
    }

    await knex(tabla).whereNull('rifa_id').update({ rifa_id: rifaBaseId });
  }

  await knex.schema.alterTable('ordenes', (table) => {
    table.integer('rifa_id').notNullable().alter();
  }).catch(() => {});
  await knex.schema.alterTable('boletos_estado', (table) => {
    table.integer('rifa_id').notNullable().alter();
  }).catch(() => {});
  await knex.schema.alterTable('orden_oportunidades', (table) => {
    table.integer('rifa_id').notNullable().alter();
  }).catch(() => {});
  await knex.schema.alterTable('ganadores', (table) => {
    table.integer('rifa_id').notNullable().alter();
  }).catch(() => {});

  await knex.raw(`
    ALTER TABLE ordenes
    DROP CONSTRAINT IF EXISTS ordenes_rifa_id_foreign
  `);
  await knex.raw(`
    ALTER TABLE boletos_estado
    DROP CONSTRAINT IF EXISTS boletos_estado_rifa_id_foreign
  `);
  await knex.raw(`
    ALTER TABLE orden_oportunidades
    DROP CONSTRAINT IF EXISTS orden_oportunidades_rifa_id_foreign
  `);
  await knex.raw(`
    ALTER TABLE ganadores
    DROP CONSTRAINT IF EXISTS ganadores_rifa_id_foreign
  `);

  await knex.raw(`
    ALTER TABLE ordenes
    ADD CONSTRAINT ordenes_rifa_id_foreign
    FOREIGN KEY (rifa_id) REFERENCES rifas(id) ON DELETE CASCADE
  `);
  await knex.raw(`
    ALTER TABLE boletos_estado
    ADD CONSTRAINT boletos_estado_rifa_id_foreign
    FOREIGN KEY (rifa_id) REFERENCES rifas(id) ON DELETE CASCADE
  `);
  await knex.raw(`
    ALTER TABLE orden_oportunidades
    ADD CONSTRAINT orden_oportunidades_rifa_id_foreign
    FOREIGN KEY (rifa_id) REFERENCES rifas(id) ON DELETE CASCADE
  `);
  await knex.raw(`
    ALTER TABLE ganadores
    ADD CONSTRAINT ganadores_rifa_id_foreign
    FOREIGN KEY (rifa_id) REFERENCES rifas(id) ON DELETE CASCADE
  `);

  await knex.raw(`
    ALTER TABLE orden_oportunidades
    DROP CONSTRAINT IF EXISTS orden_oportunidades_numero_boleto_foreign
  `);
  await knex.raw(`
    ALTER TABLE boletos_estado
    DROP CONSTRAINT IF EXISTS boletos_estado_numero_unique
  `);
  await knex.raw(`
    DROP INDEX IF EXISTS boletos_estado_numero_unique
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_boletos_estado_rifa_numero_unique
    ON boletos_estado(rifa_id, numero)
  `);
  await knex.raw(`
    ALTER TABLE orden_oportunidades
    ADD CONSTRAINT orden_oportunidades_numero_boleto_foreign
    FOREIGN KEY (rifa_id, numero_boleto)
    REFERENCES boletos_estado(rifa_id, numero)
    ON UPDATE CASCADE
    ON DELETE CASCADE
  `);

  await knex.raw(`
    DROP INDEX IF EXISTS idx_numero_opu_activo
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_numero_opu_activo
    ON orden_oportunidades(rifa_id, numero_oportunidad)
    WHERE estado IN ('apartado', 'vendido')
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_ordenes_rifa_estado_created
    ON ordenes(rifa_id, estado, created_at DESC)
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_boletos_rifa_estado
    ON boletos_estado(rifa_id, estado)
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_boletos_rifa_numero_orden_estado
    ON boletos_estado(rifa_id, numero_orden, estado)
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_opp_rifa_numero_boleto
    ON orden_oportunidades(rifa_id, numero_boleto)
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_opp_rifa_estado_numero_orden
    ON orden_oportunidades(rifa_id, estado, numero_orden)
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_ganadores_rifa_fecha
    ON ganadores(rifa_id, fecha_sorteo DESC)
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_rifas_activa_publica_unica
    ON rifas(activa_publica)
    WHERE activa_publica = true
  `);

  const hasLegacyConfig = await knex.schema.hasTable('sorteo_configuracion');
  if (hasLegacyConfig) {
    await knex.schema.dropTable('sorteo_configuracion');
  }
};

exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_rifas_activa_publica_unica`);
  await knex.raw(`DROP INDEX IF EXISTS idx_ganadores_rifa_fecha`);
  await knex.raw(`DROP INDEX IF EXISTS idx_opp_rifa_estado_numero_orden`);
  await knex.raw(`DROP INDEX IF EXISTS idx_opp_rifa_numero_boleto`);
  await knex.raw(`DROP INDEX IF EXISTS idx_boletos_rifa_numero_orden_estado`);
  await knex.raw(`DROP INDEX IF EXISTS idx_boletos_rifa_estado`);
  await knex.raw(`DROP INDEX IF EXISTS idx_ordenes_rifa_estado_created`);
  await knex.raw(`DROP INDEX IF EXISTS idx_numero_opu_activo`);
  await knex.raw(`DROP INDEX IF EXISTS idx_boletos_estado_rifa_numero_unique`);
};
