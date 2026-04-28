const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT_DIR = path.resolve(__dirname, '../..', '..');
const CONFIG_JS_PATH = path.join(ROOT_DIR, 'js', 'config.js');
const SERVER_JS_PATH = path.join(ROOT_DIR, 'backend', 'server.js');

function extraerBloque(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  if (start === -1) {
    throw new Error(`No se encontró inicio: ${startMarker}`);
  }

  const end = source.indexOf(endMarker, start);
  if (end === -1) {
    throw new Error(`No se encontró fin: ${endMarker}`);
  }

  return source.slice(start, end);
}

function cargarHelpersRifaUrl() {
  const source = fs.readFileSync(CONFIG_JS_PATH, 'utf8');
  const snippet = extraerBloque(
    source,
    "const RIFAPLUS_RIFA_SLUG_PARAM = 'rifa';",
    'function construirClaveLocalRifaPlus(baseKey) {'
  );

  const context = {
    window: {
      location: {
        href: 'https://rifa.test/compra.html?rifa=rifa-secundaria',
        search: '?rifa=rifa-secundaria'
      }
    },
    URL,
    URLSearchParams
  };

  vm.createContext(context);
  vm.runInContext(`
    ${snippet}
    globalThis.__helpers = {
      obtenerSlugRifaDesdeUrlRifaPlus,
      anexarSlugRifaARutaRifaPlus,
      construirUrlMisBoletosRifaPlus
    };
  `, context);

  return context.__helpers;
}

function cargarResolverErrorContextoAdmin() {
  const source = fs.readFileSync(SERVER_JS_PATH, 'utf8');
  const snippet = extraerBloque(
    source,
    'function resolverErrorContextoAdminRifa(req) {',
    'function clonarConfigSeguro(config) {'
  );

  const context = {
    rifaService: { enabled: true }
  };

  vm.createContext(context);
  vm.runInContext(`
    ${snippet}
    globalThis.__resolver = resolverErrorContextoAdminRifa;
  `, context);

  return {
    resolver: context.__resolver,
    context
  };
}

test('construirUrlMisBoletos conserva el slug actual de la rifa', () => {
  const helpers = cargarHelpersRifaUrl();

  const url = helpers.construirUrlMisBoletosRifaPlus({
    ordenId: 'ORD-123',
    autoOpen: true
  });

  const parsed = new URL(url);
  assert.equal(parsed.pathname, '/mis-boletos.html');
  assert.equal(parsed.searchParams.get('ordenId'), 'ORD-123');
  assert.equal(parsed.searchParams.get('autoOpen'), 'true');
  assert.equal(parsed.searchParams.get('rifa'), 'rifa-secundaria');
});

test('construirUrlMisBoletos no duplica el slug si la URL ya viene contextualizada', () => {
  const helpers = cargarHelpersRifaUrl();

  const url = helpers.anexarSlugRifaARutaRifaPlus(
    'https://rifa.test/mis-boletos.html?ordenId=ORD-123&rifa=rifa-existente'
  );

  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('rifa'), 'rifa-existente');
  assert.equal(parsed.searchParams.getAll('rifa').length, 1);
});

test('resolverErrorContextoAdminRifa bloquea admin sin rifa válida cuando multirifa está activo', () => {
  const { resolver } = cargarResolverErrorContextoAdmin();

  const error = resolver({
    rifaContext: {
      id: null
    }
  });

  assert.equal(error?.success, false);
  assert.equal(error?.code, 'ADMIN_RIFA_CONTEXT_REQUIRED');
  assert.equal(error?.message, 'Selecciona una rifa activa válida antes de continuar en el panel.');
});

test('resolverErrorContextoAdminRifa permite continuar cuando existe una rifa válida', () => {
  const { resolver } = cargarResolverErrorContextoAdmin();

  const result = resolver({
    rifaContext: {
      id: 7
    }
  });

  assert.equal(result, null);
});

test('resolverErrorContextoAdminRifa no bloquea cuando multirifa está desactivado', () => {
  const { resolver, context } = cargarResolverErrorContextoAdmin();
  context.rifaService.enabled = false;

  const result = resolver({
    rifaContext: {
      id: null
    }
  });

  assert.equal(result, null);
});
