/**
 * Baseline schema para bases nuevas.
 *
 * Objetivo:
 * - Crear la estructura operativa actual sin depender del historial completo
 * - Evitar tablas muertas y columnas obsoletas
 * - Dejar una BD vacia, lista para poblar boletos/oportunidades despues
 */

exports.up = async function up(knex) {
  const hasOrdenes = await knex.schema.hasTable('ordenes');
  if (!hasOrdenes) {
    await knex.schema.createTable('ordenes', (table) => {
      table.increments('id').primary();
      table.string('numero_orden', 50).notNullable().unique();
      table.integer('cantidad_boletos').notNullable();
      table.decimal('precio_unitario', 10, 2).notNullable();
      table.decimal('subtotal', 10, 2).notNullable();
      table.decimal('descuento', 10, 2).notNullable().defaultTo(0);
      table.decimal('total', 10, 2).notNullable();
      table.string('nombre_cliente', 255).notNullable();
      table.string('estado_cliente', 100).nullable();
      table.string('ciudad_cliente', 100).nullable();
      table.string('telefono_cliente', 20).notNullable();
      table.string('metodo_pago', 50).nullable();
      table.text('detalles_pago').nullable();
      table.string('estado', 50).notNullable().defaultTo('pendiente');
      table.jsonb('boletos').notNullable().defaultTo('[]');
      table.string('comprobante_path', 255).nullable();
      table.boolean('comprobante_recibido').notNullable().defaultTo(false);
      table.timestamp('comprobante_fecha').nullable();
      table.string('nombre_banco', 100).nullable();
      table.string('numero_referencia', 100).nullable();
      table.string('nombre_beneficiario', 150).nullable();
      table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    });
  }

  const hasAdminUsers = await knex.schema.hasTable('admin_users');
  if (!hasAdminUsers) {
    await knex.schema.createTable('admin_users', (table) => {
      table.increments('id').primary();
      table.string('username', 100).notNullable().unique();
      table.string('password_hash', 255).notNullable();
      table.string('email', 255).notNullable();
      table.string('rol', 50).notNullable().defaultTo('operador');
      table.boolean('activo').notNullable().defaultTo(true);
      table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    });
  }

  const hasBoletosEstado = await knex.schema.hasTable('boletos_estado');
  if (!hasBoletosEstado) {
    await knex.schema.createTable('boletos_estado', (table) => {
      table.increments('id').primary();
      table.integer('numero').notNullable().unique();
      table.string('estado', 50).notNullable().defaultTo('disponible');
      table.string('numero_orden', 50).nullable();
      table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    });
  }

  const hasOrdenOportunidades = await knex.schema.hasTable('orden_oportunidades');
  if (!hasOrdenOportunidades) {
    await knex.schema.createTable('orden_oportunidades', (table) => {
      table.increments('id').primary();
      table.string('numero_orden', 50).nullable();
      table.integer('numero_oportunidad').notNullable();
      table.string('estado', 50).notNullable().defaultTo('disponible');
      table.integer('numero_boleto').nullable();
    });
  }

  const hasGanadores = await knex.schema.hasTable('ganadores');
  if (!hasGanadores) {
    await knex.schema.createTable('ganadores', (table) => {
      table.increments('id').primary();
      table.string('numero_orden', 50).nullable();
      table.integer('numero_boleto').nullable();
      table.string('email', 100).nullable();
      table.string('whatsapp', 20).nullable();
      table.string('nombre_ganador', 100).nullable();
      table.string('nombre_sorteo', 255).nullable();
      table.integer('posicion').nullable();
      table.string('tipo_ganador', 50).nullable();
      table.string('premio', 255).nullable();
      table.decimal('valor_premio', 10, 2).nullable();
      table.timestamp('fecha_sorteo').nullable();
      table.string('estado', 50).nullable();
      table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    });
  }

  const hasOrderIdCounter = await knex.schema.hasTable('order_id_counter');
  if (!hasOrderIdCounter) {
    await knex.schema.createTable('order_id_counter', (table) => {
      table.increments('id').primary();
      table.string('cliente_id', 100).notNullable().unique();
      table.string('ultima_secuencia', 2).notNullable().defaultTo('AA');
      table.integer('ultimo_numero').notNullable().defaultTo(0);
      table.integer('proximo_numero').notNullable().defaultTo(1);
      table.integer('contador_total').notNullable().defaultTo(0);
      table.timestamp('fecha_ultimo_reset').notNullable().defaultTo(knex.fn.now());
      table.boolean('activo').notNullable().defaultTo(true);
      table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    });
  }

  await knex.raw(`
    ALTER TABLE boletos_estado
    DROP CONSTRAINT IF EXISTS boletos_estado_numero_orden_fk
  `);
  await knex.raw(`
    ALTER TABLE boletos_estado
    ADD CONSTRAINT boletos_estado_numero_orden_fk
    FOREIGN KEY (numero_orden)
    REFERENCES ordenes(numero_orden)
    ON UPDATE CASCADE
    ON DELETE SET NULL
  `);

  await knex.raw(`
    ALTER TABLE orden_oportunidades
    DROP CONSTRAINT IF EXISTS fk_orden_oportunidades_numero_orden
  `);
  await knex.raw(`
    ALTER TABLE orden_oportunidades
    ADD CONSTRAINT fk_orden_oportunidades_numero_orden
    FOREIGN KEY (numero_orden)
    REFERENCES ordenes(numero_orden)
    ON UPDATE CASCADE
    ON DELETE SET NULL
  `);

  await knex.raw(`
    ALTER TABLE orden_oportunidades
    DROP CONSTRAINT IF EXISTS orden_oportunidades_numero_boleto_foreign
  `);
  await knex.raw(`
    ALTER TABLE orden_oportunidades
    ADD CONSTRAINT orden_oportunidades_numero_boleto_foreign
    FOREIGN KEY (numero_boleto)
    REFERENCES boletos_estado(numero)
    ON UPDATE CASCADE
    ON DELETE CASCADE
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_ordenes_numero_orden
    ON ordenes(numero_orden)
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_ordenes_estado_created
    ON ordenes(estado, created_at DESC)
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_ordenes_created
    ON ordenes(created_at DESC)
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_ordenes_telefono
    ON ordenes(telefono_cliente)
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_admin_email
    ON admin_users(email)
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_admin_rol
    ON admin_users(rol)
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_boletos_estado
    ON boletos_estado(estado)
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_boletos_estado_updated
    ON boletos_estado(estado, updated_at DESC)
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_boletos_numero_orden
    ON boletos_estado(numero_orden)
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_boletos_numero_orden_estado
    ON boletos_estado(numero_orden, estado)
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_boletos_disponibles_para_seleccion
    ON boletos_estado(numero)
    WHERE estado = 'disponible' AND numero_orden IS NULL
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_boletos_vendidos_fecha
    ON boletos_estado(estado, updated_at DESC)
    WHERE estado = 'vendido'
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_opp_numero_boleto_oportunidad
    ON orden_oportunidades(numero_boleto, numero_oportunidad)
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_opp_numero_boleto_disponibles
    ON orden_oportunidades(numero_boleto)
    WHERE estado = 'disponible' AND numero_orden IS NULL
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_opp_numero_oportunidad
    ON orden_oportunidades(numero_oportunidad)
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_opp_numero_orden_oportunidad
    ON orden_oportunidades(numero_orden, numero_oportunidad)
    WHERE numero_orden IS NOT NULL
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_opp_disponibles
    ON orden_oportunidades(numero_oportunidad)
    WHERE estado = 'disponible' AND numero_orden IS NULL
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_numero_opu_activo
    ON orden_oportunidades(numero_oportunidad)
    WHERE estado IN ('apartado', 'vendido')
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_ordenes_expiracion
    ON ordenes(estado, created_at DESC)
    WHERE estado = 'pendiente' AND comprobante_recibido = false
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_ganadores_numero_orden
    ON ganadores(numero_orden)
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_ganadores_fecha_sorteo
    ON ganadores(fecha_sorteo DESC)
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_ganadores_tipo
    ON ganadores(tipo_ganador)
  `);

  await knex.raw(`
    ALTER TABLE ordenes
    DROP CONSTRAINT IF EXISTS check_ordenes_estado_valido
  `);
  await knex.raw(`
    ALTER TABLE ordenes
    ADD CONSTRAINT check_ordenes_estado_valido
    CHECK (estado IN ('pendiente', 'confirmada', 'cancelada'))
  `);
  await knex.raw(`
    ALTER TABLE ordenes
    DROP CONSTRAINT IF EXISTS check_ordenes_timestamps
  `);
  await knex.raw(`
    ALTER TABLE ordenes
    ADD CONSTRAINT check_ordenes_timestamps
    CHECK (updated_at >= created_at)
  `);
  await knex.raw(`
    ALTER TABLE boletos_estado
    DROP CONSTRAINT IF EXISTS check_boletos_estado_valido
  `);
  await knex.raw(`
    ALTER TABLE boletos_estado
    ADD CONSTRAINT check_boletos_estado_valido
    CHECK (estado IN ('disponible', 'apartado', 'vendido', 'cancelado'))
  `);
  await knex.raw(`
    ALTER TABLE orden_oportunidades
    DROP CONSTRAINT IF EXISTS check_oportunidades_estado_valido
  `);
  await knex.raw(`
    ALTER TABLE orden_oportunidades
    ADD CONSTRAINT check_oportunidades_estado_valido
    CHECK (estado IN ('disponible', 'apartado', 'vendido'))
  `);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('ganadores');
  await knex.schema.dropTableIfExists('orden_oportunidades');
  await knex.schema.dropTableIfExists('boletos_estado');
  await knex.schema.dropTableIfExists('order_id_counter');
  await knex.schema.dropTableIfExists('admin_users');
  await knex.schema.dropTableIfExists('ordenes');
};
