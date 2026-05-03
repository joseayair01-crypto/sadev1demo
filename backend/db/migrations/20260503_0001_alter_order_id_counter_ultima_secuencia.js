/**
 * Migración: Aumentar longitud de `ultima_secuencia` en `order_id_counter`.
 * - Evita errores al pasar de 'ZZ' a 'AAA' y soporta secuencias más largas.
 */
exports.up = async function(knex) {
  // Hacemos ALTER TYPE a varchar(10) para soportar secuencias como 'AAA'
  await knex.raw(`ALTER TABLE order_id_counter ALTER COLUMN ultima_secuencia TYPE varchar(10);`);
};

exports.down = async function(knex) {
  // Revertir a 2 caracteres (puede fallar si existen valores mayores a 2 chars)
  await knex.raw(`ALTER TABLE order_id_counter ALTER COLUMN ultima_secuencia TYPE varchar(2);`);
};
