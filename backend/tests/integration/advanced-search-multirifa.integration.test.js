const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { startServer } = require('./helpers/serverHarness');
const db = require('../../db');

const BACKEND_DIR = path.resolve(__dirname, '../..');
const ADMIN_USERNAME = process.env.TEST_ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || 'admin123';
const TEST_PREFIX = `qa-search-scope-${Date.now()}`;

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
  assert.ok(payload?.data?.slug, 'crear rifa debe regresar slug');
  return payload.data;
}

async function patchAdminConfig(baseUrl, token, rifaId, body) {
  const { response, payload } = await requestJson(baseUrl, 'PATCH', '/api/admin/config', {
    headers: jsonHeaders({
      Authorization: `Bearer ${token}`,
      'x-rifaplus-rifa-id': String(rifaId)
    }),
    body
  });

  assert.equal(response.status, 200, `PATCH /api/admin/config falló: ${JSON.stringify(payload)}`);
  assert.equal(payload?.success, true, 'PATCH /api/admin/config debe regresar success=true');
  return payload;
}

async function cleanupCreatedData(slugPrefix) {
  const rifas = await db('rifas')
    .select('id')
    .where('slug', 'like', `${slugPrefix}%`);

  const rifaIds = rifas.map((row) => row.id).filter(Boolean);
  if (rifaIds.length === 0) return;

  await db.transaction(async (trx) => {
    await trx('ganadores').whereIn('rifa_id', rifaIds).del();
    await trx('orden_oportunidades').whereIn('rifa_id', rifaIds).del();
    await trx('boletos_estado').whereIn('rifa_id', rifaIds).del();
    await trx('ordenes').whereIn('rifa_id', rifaIds).del();
    await trx('rifas').whereIn('id', rifaIds).del();
  });
}

test('búsqueda avanzada respeta slug, rangos por rifa y elimina duplicados de estado', async () => {
  const port = Number(process.env.TEST_BACKEND_PORT || 5204);
  const server = await startServer({ cwd: BACKEND_DIR, port });

  try {
    await cleanupCreatedData(TEST_PREFIX);

    const token = await loginAdmin(server.baseUrl);
    const rifaA = await createRifa(server.baseUrl, token, `${TEST_PREFIX}-a`);
    const rifaB = await createRifa(server.baseUrl, token, `${TEST_PREFIX}-b`);

    await patchAdminConfig(server.baseUrl, token, rifaA.id, {
      rifa: {
        totalBoletos: 120,
        rangos: [
          { nombre: 'Bloque A', inicio: 10, fin: 19 },
          { nombre: 'Bloque B', inicio: 30, fin: 35 }
        ],
        busquedaBoletos: {
          modoAvanzado: true
        }
      }
    });

    await patchAdminConfig(server.baseUrl, token, rifaB.id, {
      rifa: {
        totalBoletos: 120,
        rangos: [
          { nombre: 'Bloque C', inicio: 0, fin: 9 }
        ],
        busquedaBoletos: {
          modoAvanzado: true
        }
      }
    });

    await db('boletos_estado').insert([
      { rifa_id: rifaA.id, numero: 12, estado: 'apartado' },
      { rifa_id: rifaA.id, numero: 12, estado: 'vendido' },
      { rifa_id: rifaA.id, numero: 13, estado: 'apartado' },
      { rifa_id: rifaA.id, numero: 31, estado: 'vendido' },
      { rifa_id: rifaB.id, numero: 12, estado: 'vendido' }
    ]);

    const contiene = await fetch(`${server.baseUrl}/api/public/boletos/busqueda?rifa=${encodeURIComponent(rifaA.slug)}&modo=contiene&q=1&limite=50`);
    const contienePayload = await contiene.json();

    assert.equal(contiene.status, 200, `búsqueda contiene falló: ${JSON.stringify(contienePayload)}`);
    assert.equal(contienePayload?.success, true, 'búsqueda contiene debe regresar success=true');

    const numerosContiene = (contienePayload?.data?.items || []).map((item) => Number(item.numero));
    assert.deepEqual(
      numerosContiene,
      [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 31],
      'la búsqueda contiene debe limitarse a los rangos de la rifa A y no repetir números'
    );
    assert.equal(new Set(numerosContiene).size, numerosContiene.length, 'la respuesta no debe contener números duplicados');
    assert.equal(contienePayload?.data?.items?.find((item) => Number(item.numero) === 12)?.estado, 'vendido', 'el estado debe priorizar vendido sobre apartado');
    assert.equal(contienePayload?.data?.items?.find((item) => Number(item.numero) === 13)?.estado, 'apartado', 'el estado apartado debe mantenerse');
    assert.deepEqual(
      contienePayload?.data?.rangoBusqueda?.segmentos,
      [{ inicio: 10, fin: 19 }, { inicio: 30, fin: 35 }],
      'la API debe exponer los segmentos configurados de la rifa activa'
    );

    const rango = await fetch(`${server.baseUrl}/api/public/boletos/busqueda?rifa=${encodeURIComponent(rifaA.slug)}&modo=rango&inicio=15&fin=32&limite=50`);
    const rangoPayload = await rango.json();

    assert.equal(rango.status, 200, `búsqueda por rango falló: ${JSON.stringify(rangoPayload)}`);
    assert.deepEqual(
      (rangoPayload?.data?.items || []).map((item) => Number(item.numero)),
      [15, 16, 17, 18, 19, 30, 31, 32],
      'la búsqueda por rango debe intersectar con los segmentos configurados sin colarse a huecos'
    );

    const exactaInvalida = await fetch(`${server.baseUrl}/api/public/boletos/busqueda?rifa=${encodeURIComponent(rifaA.slug)}&modo=exacto&q=25`);
    const exactaInvalidaPayload = await exactaInvalida.json();

    assert.equal(exactaInvalida.status, 400, 'la búsqueda exacta fuera de rango debe rechazarse');
    assert.equal(exactaInvalidaPayload?.success, false, 'la búsqueda exacta inválida debe regresar success=false');

    const contieneRifaB = await fetch(`${server.baseUrl}/api/public/boletos/busqueda?rifa=${encodeURIComponent(rifaB.slug)}&modo=contiene&q=1&limite=50`);
    const contieneRifaBPayload = await contieneRifaB.json();

    assert.equal(contieneRifaB.status, 200, `búsqueda contiene de rifa B falló: ${JSON.stringify(contieneRifaBPayload)}`);
    assert.deepEqual(
      (contieneRifaBPayload?.data?.items || []).map((item) => Number(item.numero)),
      [1],
      'la búsqueda debe respetar el slug y la configuración de la rifa B'
    );
  } finally {
    await cleanupCreatedData(TEST_PREFIX);
    await server.stop();
    await db.destroy();
  }
});
