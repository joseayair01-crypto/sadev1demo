const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { startServer } = require('./helpers/serverHarness');
const db = require('../../db');

const BACKEND_DIR = path.resolve(__dirname, '../..');
const ADMIN_USERNAME = process.env.TEST_ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || 'admin123';
const TEST_PREFIX = `qa-order-counter-${Date.now()}`;

function jsonHeaders(headers = {}) {
  return {
    'Content-Type': 'application/json',
    ...headers
  };
}

async function requestJson(baseUrl, method, pathname, { headers = {}, body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const text = await response.text();
  let payload = null;

  try {
    payload = text ? JSON.parse(text) : null;
  } catch (error) {
    payload = { raw: text };
  }

  return { response, payload };
}

async function loginAdmin(baseUrl) {
  const { response, payload } = await requestJson(baseUrl, 'POST', '/api/admin/login', {
    headers: jsonHeaders(),
    body: {
      username: ADMIN_USERNAME,
      password: ADMIN_PASSWORD
    }
  });

  assert.equal(response.status, 200, `login admin falló: ${JSON.stringify(payload)}`);
  assert.equal(payload?.success, true, 'login admin debe regresar success=true');
  assert.ok(payload?.token, 'login admin debe regresar token');
  return payload.token;
}

async function createRifa(baseUrl, token, nombre) {
  const { response, payload } = await requestJson(baseUrl, 'POST', '/api/admin/rifas', {
    headers: jsonHeaders({
      Authorization: `Bearer ${token}`
    }),
    body: { nombre }
  });

  assert.equal(response.status, 201, `crear rifa falló: ${JSON.stringify(payload)}`);
  assert.equal(payload?.success, true, 'crear rifa debe regresar success=true');
  assert.ok(payload?.data?.id, 'crear rifa debe regresar id');
  return payload.data;
}

async function obtenerSiguienteOrdenId(baseUrl, rifaId) {
  const { response, payload } = await requestJson(baseUrl, 'POST', '/api/public/order-counter/next', {
    headers: jsonHeaders({
      'x-rifaplus-rifa-id': String(rifaId)
    })
  });

  assert.equal(response.status, 200, `order-counter next falló: ${JSON.stringify(payload)}`);
  assert.equal(payload?.success, true, 'order-counter next debe regresar success=true');
  assert.ok(payload?.orden_id, 'order-counter next debe regresar orden_id');
  return payload.orden_id;
}

async function cleanupCreatedData(slugPrefix) {
  const rifas = await db('rifas')
    .select('id')
    .where('slug', 'like', `${slugPrefix}%`);

  const rifaIds = rifas.map((row) => row.id).filter(Boolean);
  if (rifaIds.length === 0) return;

  await db.transaction(async (trx) => {
    await trx('order_id_counter').whereIn('rifa_id', rifaIds).del();
    await trx('ganadores').whereIn('rifa_id', rifaIds).del();
    await trx('orden_oportunidades').whereIn('rifa_id', rifaIds).del();
    await trx('boletos_estado').whereIn('rifa_id', rifaIds).del();
    await trx('ordenes').whereIn('rifa_id', rifaIds).del();
    await trx('rifas').whereIn('id', rifaIds).del();
  });
}

test('order-counter multirifa inicia en AA000 y avanza aislado por rifa', async () => {
  const port = Number(process.env.TEST_BACKEND_PORT || 5202);
  const server = await startServer({ cwd: BACKEND_DIR, port });

  try {
    await cleanupCreatedData(TEST_PREFIX);

    const token = await loginAdmin(server.baseUrl);
    const rifaA = await createRifa(server.baseUrl, token, `${TEST_PREFIX}-a`);
    const rifaB = await createRifa(server.baseUrl, token, `${TEST_PREFIX}-b`);

    const ordenA1 = await obtenerSiguienteOrdenId(server.baseUrl, rifaA.id);
    const ordenA2 = await obtenerSiguienteOrdenId(server.baseUrl, rifaA.id);
    const ordenB1 = await obtenerSiguienteOrdenId(server.baseUrl, rifaB.id);

    assert.equal(ordenA1, `S${rifaA.id}-AA000`, 'la primera orden de la rifa A debe iniciar en AA000');
    assert.equal(ordenA2, `S${rifaA.id}-AA001`, 'la segunda orden de la rifa A debe avanzar a AA001');
    assert.equal(ordenB1, `S${rifaB.id}-AA000`, 'la primera orden de la rifa B debe iniciar en AA000 sin contaminarse');

    const counters = await db('order_id_counter')
      .select('rifa_id', 'cliente_id', 'ultima_secuencia', 'ultimo_numero', 'proximo_numero', 'contador_total')
      .whereIn('rifa_id', [rifaA.id, rifaB.id])
      .orderBy('rifa_id', 'asc');

    const map = new Map(counters.map((row) => [Number(row.rifa_id), row]));
    assert.equal(counters.length, 2, 'deben existir dos contadores aislados por rifa');

    assert.equal(map.get(rifaA.id)?.cliente_id, `rifa_${rifaA.id}`, 'la clave interna del contador de rifa A debe ser estable');
    assert.equal(map.get(rifaA.id)?.ultimo_numero, 1, 'la rifa A debe dejar como último número el 001');
    assert.equal(map.get(rifaA.id)?.proximo_numero, 2, 'la rifa A debe preparar el siguiente número 002');
    assert.equal(map.get(rifaA.id)?.contador_total, 2, 'la rifa A debe registrar dos IDs generados');

    assert.equal(map.get(rifaB.id)?.cliente_id, `rifa_${rifaB.id}`, 'la clave interna del contador de rifa B debe ser estable');
    assert.equal(map.get(rifaB.id)?.ultimo_numero, 0, 'la rifa B debe dejar como último número el 000');
    assert.equal(map.get(rifaB.id)?.proximo_numero, 1, 'la rifa B debe preparar el siguiente número 001');
    assert.equal(map.get(rifaB.id)?.contador_total, 1, 'la rifa B debe registrar un ID generado');
  } finally {
    await cleanupCreatedData(TEST_PREFIX);
    await server.stop();
    await db.destroy();
  }
});
