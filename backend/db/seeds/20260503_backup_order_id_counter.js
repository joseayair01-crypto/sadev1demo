exports.seed = async function(knex) {
  const tableName = 'order_id_counter';
  const backupName = 'order_id_counter_backup_20260503';
  // Crear copia completa de la tabla para backup rápido cuando no hay pg_dump disponible
  await knex.raw(`CREATE TABLE IF NOT EXISTS ${backupName} AS TABLE ${tableName};`);
  // Insertar comentario de seguimiento (no rompe nada)
  await knex.raw(`COMMENT ON TABLE ${backupName} IS 'Backup antes de alterar columna ultima_secuencia - 2026-05-03';`);
  console.log('Backup seed executed, created (if not existed):', backupName);
};
