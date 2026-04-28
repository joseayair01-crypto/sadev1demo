const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { startServer } = require('./helpers/serverHarness');
const db = require('../../db');

const BACKEND_DIR = path.resolve(__dirname, '../..');
const ADMIN_USERNAME = process.env.TEST_ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || 'admin123';
const TEST_PREFIX = `qa-int-${Date.now()}`;

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

async function poblarInventario(baseUrl, token, rifaId, inicio, fin) {
  const { response, payload } = await requestJson(baseUrl, 'POST', '/api/admin/boletos/inventario/poblar', {
    headers: jsonHeaders({
      Authorization: `Bearer ${token}`,
      'x-rifaplus-rifa-id': String(rifaId)
    }),
    body: { inicio, fin }
  });

  assert.equal(response.status, 200, `poblar inventario falló: ${JSON.stringify(payload)}`);
  assert.equal(payload?.success, true, 'poblar inventario debe regresar success=true');
  return payload.data;
}

async function crearOrdenPublica(baseUrl, rifaId, boletos) {
  const cantidad = boletos.length;
  const total = cantidad * 6;
  const { response, payload } = await requestJson(baseUrl, 'POST', '/api/ordenes', {
    headers: jsonHeaders({
      'x-rifaplus-rifa-id': String(rifaId)
    }),
    body: {
      cliente: {
        nombre: 'QA',
        apellidos: 'Integration',
        whatsapp: '5512345678',
        estado: 'CDMX',
        ciudad: 'CDMX'
      },
      boletos,
      totales: {
        subtotal: total,
        descuento: 0,
        totalFinal: total
      },
      metodoPago: 'transferencia',
      cuenta: {
        accountNumber: '1111222233334444',
        nombreBanco: 'Banco QA',
        beneficiary: 'QA Tester',
        numero_referencia: 'QA-REF-INTEGRATION'
      }
    }
  });

  assert.equal(response.status, 200, `crear orden pública falló: ${JSON.stringify(payload)}`);
  assert.equal(payload?.success, true, 'crear orden pública debe regresar success=true');
  assert.ok(payload?.ordenId, 'crear orden pública debe regresar ordenId');
  return payload;
}

async function subirComprobante(baseUrl, rifaId, numeroOrden) {
  const form = new FormData();
  const pngBuffer = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=',
    'base64'
  );

  form.append('whatsapp', '5512345678');
  form.append('comprobante', new Blob([pngBuffer], { type: 'image/png' }), 'proof.png');

  const response = await fetch(`${baseUrl}/api/public/ordenes-cliente/${numeroOrden}/comprobante`, {
    method: 'POST',
    headers: {
      'x-rifaplus-rifa-id': String(rifaId)
    },
    body: form
  });

  const payload = await response.json();
  assert.equal(response.status, 200, `subir comprobante falló: ${JSON.stringify(payload)}`);
  assert.equal(payload?.success, true, 'subir comprobante debe regresar success=true');
}

async function obtenerOrdenesAdmin(baseUrl, token, rifaId) {
  const response = await fetch(`${baseUrl}/api/ordenes?limit=10`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'x-rifaplus-rifa-id': String(rifaId)
    }
  });

  const payload = await response.json();
  assert.equal(response.status, 200, `listar órdenes admin falló: ${JSON.stringify(payload)}`);
  assert.equal(payload?.success, true, 'listar órdenes admin debe regresar success=true');
  return payload;
}

async function obtenerStatsPublicos(baseUrl, rifaId) {
  const response = await fetch(`${baseUrl}/api/public/boletos/stats`, {
    headers: {
      'x-rifaplus-rifa-id': String(rifaId)
    }
  });

  const payload = await response.json();
  assert.equal(response.status, 200, `stats públicos fallaron: ${JSON.stringify(payload)}`);
  assert.equal(payload?.success, true, 'stats públicos deben regresar success=true');
  return payload.data;
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

test('multi-rifa aísla inventario, órdenes, comprobantes y resumen admin', async () => {
  const port = Number(process.env.TEST_BACKEND_PORT || 5201);
  const server = await startServer({ cwd: BACKEND_DIR, port });

  try {
    await cleanupCreatedData(TEST_PREFIX);

    const token = await loginAdmin(server.baseUrl);
    const rifaA = await createRifa(server.baseUrl, token, `${TEST_PREFIX}-a`);
    const rifaB = await createRifa(server.baseUrl, token, `${TEST_PREFIX}-b`);

    await poblarInventario(server.baseUrl, token, rifaA.id, 0, 9);
    await poblarInventario(server.baseUrl, token, rifaB.id, 0, 9);

    const ordenPayload = await crearOrdenPublica(server.baseUrl, rifaA.id, [0, 1]);
    const numeroOrden = ordenPayload.ordenId;

    let statsA = await obtenerStatsPublicos(server.baseUrl, rifaA.id);
    let statsB = await obtenerStatsPublicos(server.baseUrl, rifaB.id);

    assert.equal(statsA.apartados, 2, 'rifa A debe tener 2 boletos apartados');
    assert.equal(statsB.apartados, 0, 'rifa B no debe verse afectada por la orden de rifa A');

    await subirComprobante(server.baseUrl, rifaA.id, numeroOrden);

    const ordenesAdminA = await obtenerOrdenesAdmin(server.baseUrl, token, rifaA.id);
    const ordenesAdminB = await obtenerOrdenesAdmin(server.baseUrl, token, rifaB.id);

    assert.equal(ordenesAdminA.data.length, 1, 'admin debe ver 1 orden en rifa A');
    assert.equal(ordenesAdminB.data.length, 0, 'admin no debe ver órdenes en rifa B');
    assert.equal(ordenesAdminA.data[0].numero_orden, numeroOrden, 'admin debe ver la orden correcta');
    assert.equal(ordenesAdminA.data[0].comprobante_recibido, true, 'la orden de rifa A debe marcar comprobante');
    assert.ok(ordenesAdminA.data[0].comprobante_path, 'la orden de rifa A debe tener URL de comprobante');
    assert.equal(ordenesAdminA.summary.totalBoletos, 2, 'summary de rifa A debe sumar 2 boletos');
    assert.equal(ordenesAdminA.summary.pendiente, 1, 'summary de rifa A debe reflejar la orden pendiente');
    assert.equal(ordenesAdminA.summary.comprobante_recibido, 1, 'summary de rifa A debe reflejar comprobante recibido');
    assert.equal(ordenesAdminA.summary.pendienteTotal, 12, 'summary de rifa A debe reflejar el total pendiente correcto');

    const ordenDb = await db('ordenes')
      .select('numero_orden', 'rifa_id', 'estado', 'comprobante_recibido', 'comprobante_path')
      .where('numero_orden', numeroOrden)
      .first();

    assert.equal(ordenDb?.rifa_id, rifaA.id, 'la orden debe persistirse en la rifa correcta');
    assert.equal(ordenDb?.comprobante_recibido, true, 'la BD debe marcar comprobante recibido');
    assert.ok(ordenDb?.comprobante_path, 'la BD debe persistir la URL del comprobante');

    const boletosApartados = await db('boletos_estado')
      .select('rifa_id')
      .count('* as total')
      .where('estado', 'apartado')
      .groupBy('rifa_id');

    const mapaApartados = new Map(
      boletosApartados.map((row) => [Number(row.rifa_id), Number(row.total)])
    );

    assert.equal(mapaApartados.get(rifaA.id) || 0, 2, 'rifa A debe conservar 2 apartados en BD');
    assert.equal(mapaApartados.get(rifaB.id) || 0, 0, 'rifa B debe conservar 0 apartados en BD');

    statsA = await obtenerStatsPublicos(server.baseUrl, rifaA.id);
    statsB = await obtenerStatsPublicos(server.baseUrl, rifaB.id);

    assert.equal(statsA.apartados, 2, 'stats públicos de rifa A deben seguir reflejando 2 apartados');
    assert.equal(statsB.apartados, 0, 'stats públicos de rifa B deben seguir en 0 apartados');
  } finally {
    await cleanupCreatedData(TEST_PREFIX);
    await server.stop();
    await db.destroy();
  }
});
