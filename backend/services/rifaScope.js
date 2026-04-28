function normalizeRifaContext(contexto = {}) {
  const rifaId = Number.parseInt(contexto?.rifaId, 10);
  return Number.isInteger(rifaId) && rifaId > 0
    ? { rifaId }
    : { rifaId: null };
}

function applyRifaScope(query, contexto = {}, column = 'rifa_id') {
  const { rifaId } = normalizeRifaContext(contexto);
  if (rifaId) {
    query.where(column, rifaId);
  }
  return query;
}

function getRifaIdFromRequest(req) {
  const rifaId = Number.parseInt(req?.rifaContext?.id, 10);
  return Number.isInteger(rifaId) && rifaId > 0 ? rifaId : null;
}

module.exports = {
  normalizeRifaContext,
  applyRifaScope,
  getRifaIdFromRequest
};
