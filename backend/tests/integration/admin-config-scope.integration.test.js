const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { startServer } = require('./helpers/serverHarness');
const db = require('../../db');

const BACKEND_DIR = path.resolve(__dirname, '../..');
const ADMIN_USERNAME = process.env.TEST_ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || 'admin123';
const TEST_PREFIX = `qa-config-scope-${Date.now()}`;

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

async function getAdminConfig(baseUrl, token, rifaId) {
  const { response, payload } = await requestJson(baseUrl, 'GET', '/api/admin/config', {
    headers: jsonHeaders({
      Authorization: `Bearer ${token}`,
      'x-rifaplus-rifa-id': String(rifaId)
    })
  });

  assert.equal(response.status, 200, `GET /api/admin/config falló: ${JSON.stringify(payload)}`);
  assert.equal(payload?.success, true, 'GET /api/admin/config debe regresar success=true');
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

test('PATCH /api/admin/config persiste cambios por rifa activa sin contaminar otra rifa', async () => {
  const port = Number(process.env.TEST_BACKEND_PORT || 5202);
  const server = await startServer({ cwd: BACKEND_DIR, port });

  try {
    await cleanupCreatedData(TEST_PREFIX);

    const token = await loginAdmin(server.baseUrl);
    const rifaA = await createRifa(server.baseUrl, token, `${TEST_PREFIX}-a`);
    const rifaB = await createRifa(server.baseUrl, token, `${TEST_PREFIX}-b`);

    const cambiosA = {
      cliente: {
        nombre: 'Cliente QA A'
      },
      rifa: {
        nombreSorteo: 'Rifa QA A',
        fechaSorteo: '2026-08-21T18:45:00',
        timeZone: 'America/Mexico_City',
        zonaHoraria: 'Hora Centro Mexico'
      },
      seo: {
        title: 'SEO QA A',
        description: 'Descripcion QA A'
      },
      tema: {
        preset: 'clasico',
        colorPrimario: '#123456'
      },
      marketing: {
        metaPixel: {
          enabled: true,
          pixelId: '123456789012345',
          trackPageView: true,
          trackViewContent: true,
          trackAddToCart: true,
          trackInitiateCheckout: true,
          trackPurchase: true
        }
      }
    };

    const cambiosB = {
      cliente: {
        nombre: 'Cliente QA B'
      },
      rifa: {
        nombreSorteo: 'Rifa QA B',
        fechaSorteo: '2026-09-15T21:10:00',
        timeZone: 'America/Tijuana',
        zonaHoraria: 'Hora Tijuana'
      },
      seo: {
        title: 'SEO QA B',
        description: 'Descripcion QA B'
      },
      tema: {
        preset: 'premium',
        colorPrimario: '#654321'
      },
      marketing: {
        metaPixel: {
          enabled: false,
          pixelId: '987654321098765',
          trackPageView: false,
          trackViewContent: false,
          trackAddToCart: false,
          trackInitiateCheckout: false,
          trackPurchase: false
        }
      }
    };

    await patchAdminConfig(server.baseUrl, token, rifaA.id, cambiosA);
    await patchAdminConfig(server.baseUrl, token, rifaB.id, cambiosB);

    const configA = await getAdminConfig(server.baseUrl, token, rifaA.id);
    const configB = await getAdminConfig(server.baseUrl, token, rifaB.id);

    assert.equal(configA?.data?.cliente?.nombre, cambiosA.cliente.nombre, 'rifa A debe conservar su cliente');
    assert.equal(configA?.data?.rifa?.nombreSorteo, cambiosA.rifa.nombreSorteo, 'rifa A debe conservar su nombre de sorteo');
    assert.equal(configA?.data?.rifa?.fechaSorteo, cambiosA.rifa.fechaSorteo, 'rifa A debe conservar su fechaSorteo');
    assert.equal(configA?.data?.rifa?.timeZone, cambiosA.rifa.timeZone, 'rifa A debe conservar su zona horaria');
    assert.equal(configA?.data?.seo?.title, cambiosA.seo.title, 'rifa A debe conservar su SEO');
    assert.equal(configA?.data?.tema?.colorPrimario, cambiosA.tema.colorPrimario, 'rifa A debe conservar su tema');
    assert.equal(configA?.data?.marketing?.metaPixel?.pixelId, cambiosA.marketing.metaPixel.pixelId, 'rifa A debe conservar su pixel');

    assert.equal(configB?.data?.cliente?.nombre, cambiosB.cliente.nombre, 'rifa B debe conservar su cliente');
    assert.equal(configB?.data?.rifa?.nombreSorteo, cambiosB.rifa.nombreSorteo, 'rifa B debe conservar su nombre de sorteo');
    assert.equal(configB?.data?.rifa?.fechaSorteo, cambiosB.rifa.fechaSorteo, 'rifa B debe conservar su fechaSorteo');
    assert.equal(configB?.data?.rifa?.timeZone, cambiosB.rifa.timeZone, 'rifa B debe conservar su zona horaria');
    assert.equal(configB?.data?.seo?.title, cambiosB.seo.title, 'rifa B debe conservar su SEO');
    assert.equal(configB?.data?.tema?.colorPrimario, cambiosB.tema.colorPrimario, 'rifa B debe conservar su tema');
    assert.equal(configB?.data?.marketing?.metaPixel?.pixelId, cambiosB.marketing.metaPixel.pixelId, 'rifa B debe conservar su pixel');

    assert.notEqual(configA?.data?.rifa?.fechaSorteo, configB?.data?.rifa?.fechaSorteo, 'cada rifa debe mantener su propia fecha');
    assert.notEqual(configA?.data?.seo?.title, configB?.data?.seo?.title, 'cada rifa debe mantener su propio SEO');
    assert.notEqual(configA?.data?.marketing?.metaPixel?.pixelId, configB?.data?.marketing?.metaPixel?.pixelId, 'cada rifa debe mantener su propio pixel');

    const rifasDb = await db('rifas')
      .select('id', 'configuracion')
      .whereIn('id', [rifaA.id, rifaB.id]);

    const byId = new Map(rifasDb.map((row) => [Number(row.id), row.configuracion || {}]));
    const configDbA = byId.get(rifaA.id) || {};
    const configDbB = byId.get(rifaB.id) || {};

    assert.equal(configDbA?.rifa?.fechaSorteo, cambiosA.rifa.fechaSorteo, 'BD debe persistir fechaSorteo de rifa A');
    assert.equal(configDbB?.rifa?.fechaSorteo, cambiosB.rifa.fechaSorteo, 'BD debe persistir fechaSorteo de rifa B');
    assert.equal(configDbA?.seo?.title, cambiosA.seo.title, 'BD debe persistir SEO de rifa A');
    assert.equal(configDbB?.seo?.title, cambiosB.seo.title, 'BD debe persistir SEO de rifa B');
    assert.equal(configDbA?.marketing?.metaPixel?.pixelId, cambiosA.marketing.metaPixel.pixelId, 'BD debe persistir pixel de rifa A');
    assert.equal(configDbB?.marketing?.metaPixel?.pixelId, cambiosB.marketing.metaPixel.pixelId, 'BD debe persistir pixel de rifa B');
  } finally {
    await cleanupCreatedData(TEST_PREFIX);
    await server.stop();
    await db.destroy();
  }
});

test('PATCH /api/admin/config normaliza promociones combo y regresa advertencias de compatibilidad', async () => {
  const port = Number(process.env.TEST_BACKEND_PORT || 5203);
  const server = await startServer({ cwd: BACKEND_DIR, port });

  try {
    await cleanupCreatedData(TEST_PREFIX);

    const token = await loginAdmin(server.baseUrl);
    const rifa = await createRifa(server.baseUrl, token, `${TEST_PREFIX}-combo`);

    const payload = await patchAdminConfig(server.baseUrl, token, rifa.id, {
      rifa: {
        descuentos: {
          enabled: true,
          reglas: [
            { cantidad: 10, total: 90 }
          ]
        },
        promocionesCombo: {
          enabled: true,
          reglas: [
            { cantidadRecibe: 2, cantidadPaga: 1, etiqueta: '2x1 lanzamiento' },
            { cantidadRecibe: 2, cantidadPaga: 1, etiqueta: 'duplicada' },
            { cantidadRecibe: 4, cantidadPaga: 2, etiqueta: '4x2' },
            { cantidadRecibe: 1, cantidadPaga: 1, etiqueta: 'invalida' }
          ]
        }
      }
    });

    assert.ok(Array.isArray(payload?.warnings), 'PATCH debe regresar warnings');
    assert.ok(
      payload.warnings.some((warning) => warning.includes('Combo y volumen no se acumulan')),
      'PATCH debe advertir que combo y volumen no se acumulan'
    );

    const config = await getAdminConfig(server.baseUrl, token, rifa.id);
    const reglasCombo = config?.data?.rifa?.promocionesCombo?.reglas || [];

    assert.equal(reglasCombo.length, 2, 'solo deben persistirse reglas combo válidas y únicas');
    assert.deepEqual(
      reglasCombo.map((regla) => [regla.cantidadRecibe, regla.cantidadPaga]),
      [[2, 1], [4, 2]],
      'las reglas combo deben quedar ordenadas y normalizadas'
    );
    assert.deepEqual(
      reglasCombo.map((regla) => regla.etiqueta),
      ['2x1', '4x2'],
      'las etiquetas deben normalizarse al formato canonico'
    );

    const rifaDb = await db('rifas').select('configuracion').where('id', rifa.id).first();
    const reglasDb = rifaDb?.configuracion?.rifa?.promocionesCombo?.reglas || [];
    assert.equal(reglasDb.length, 2, 'la BD debe persistir las reglas combo normalizadas');
  } finally {
    await cleanupCreatedData(TEST_PREFIX);
    await server.stop();
  }
});
