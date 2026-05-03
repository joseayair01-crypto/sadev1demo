/**
 * Normaliza el contexto de rifa a un objeto consistente
 * @param {Object} contexto - Contexto con rifaId
 * @returns {Object} - { rifaId: number|null }
 */
function normalizeRifaContext(contexto = {}) {
  const rifaId = Number.parseInt(contexto?.rifaId, 10);
  return Number.isInteger(rifaId) && rifaId > 0
    ? { rifaId }
    : { rifaId: null };
}

/**
 * Aplica filtro por rifa_id a una consulta Knex
 * @param {QueryBuilder} query - Query builder de Knex
 * @param {Object} contexto - Contexto con rifaId
 * @param {string} column - Nombre de la columna (default: 'rifa_id')
 * @returns {QueryBuilder} - Query con filtro aplicado
 */
function applyRifaScope(query, contexto = {}, column = 'rifa_id') {
  const { rifaId } = normalizeRifaContext(contexto);
  if (rifaId) {
    query.where(column, rifaId);
  }
  return query;
}

/**
 * Obtiene el rifa_id de una request (prioridad: rifaContext > header > null)
 * ⚠️ CRÍTICO PARA AISLAMIENTO MULTIRIFA
 * @param {Object} req - Request de Express
 * @returns {number|null} - rifaId o null si no está disponible
 */
function getRifaIdFromRequest(req) {
  // Prioridad 1: rifaContext (resuelto por middleware global)
  const rifaIdContext = Number.parseInt(req?.rifaContext?.id, 10);
  if (Number.isInteger(rifaIdContext) && rifaIdContext > 0) {
    return rifaIdContext;
  }
  
  // Prioridad 2: Header de Rifa (enviado por frontend admin)
  const rifaIdHeaderRaw = req.headers['x-rifaplus-rifa-id'] || req.headers['x-rifa-id'];
  const rifaIdHeader = rifaIdHeaderRaw ? Number.parseInt(rifaIdHeaderRaw, 10) : null;
  if (Number.isInteger(rifaIdHeader) && rifaIdHeader > 0) {
    return rifaIdHeader;
  }
  
  // Fallback: null (solo debería pasar en rutas públicas o mal configuradas)
  if (process.env.NODE_ENV === 'test' || process.env.DEBUG_RIFA_SCOPE) {
    console.log(`[DEBUG_RIFA_SCOPE] Headers: ${JSON.stringify(req.headers)}`);
    console.log(`[DEBUG_RIFA_SCOPE] Resolved ID: ${rifaIdHeader || rifaIdContext || 'null'}`);
  }
  return null;
}

module.exports = {
  normalizeRifaContext,
  applyRifaScope,
  getRifaIdFromRequest
};
