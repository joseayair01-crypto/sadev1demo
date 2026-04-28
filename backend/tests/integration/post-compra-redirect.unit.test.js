const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT_DIR = path.resolve(__dirname, '../..', '..');
const CONFIG_JS_PATH = path.join(ROOT_DIR, 'js', 'config.js');
const MODAL_PATH = path.join(ROOT_DIR, 'js', 'modal-orden-confirmada.js');

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

function crearContextoCompra(urlActual = 'https://rifa.test/compra.html?rifa=slug-post-compra') {
  return {
    window: {
      location: {
        href: urlActual,
        search: new URL(urlActual).search
      },
      rifaplusConfig: {}
    },
    URL,
    URLSearchParams
  };
}

function instalarHelperConfig(context) {
  const source = fs.readFileSync(CONFIG_JS_PATH, 'utf8');
  const snippet = extraerBloque(
    source,
    "const RIFAPLUS_RIFA_SLUG_PARAM = 'rifa';",
    'function construirClaveLocalRifaPlus(baseKey) {'
  );

  vm.runInContext(`
    ${snippet}
    window.rifaplusConfig.construirUrlMisBoletos = construirUrlMisBoletosRifaPlus;
  `, context);
}

function cargarBuilderModal(context) {
  const source = fs.readFileSync(MODAL_PATH, 'utf8');
  const snippet = extraerBloque(
    source,
    'function construirUrlMisBoletosOrdenConfirmada(ordenId, whatsapp) {',
    'function notificarErrorModalOrdenConfirmada() {'
  );

  vm.runInContext(`
    ${snippet}
    globalThis.__builder = construirUrlMisBoletosOrdenConfirmada;
  `, context);

  return context.__builder;
}

test('modal de orden confirmada construye redirect contextualizado con slug y whatsapp', () => {
  const context = crearContextoCompra();
  vm.createContext(context);
  instalarHelperConfig(context);
  const builder = cargarBuilderModal(context);

  const url = builder('ORD-555', '5512345678');
  const parsed = new URL(url);

  assert.equal(parsed.pathname, '/mis-boletos.html');
  assert.equal(parsed.searchParams.get('ordenId'), 'ORD-555');
  assert.equal(parsed.searchParams.get('autoOpen'), 'true');
  assert.equal(parsed.searchParams.get('whatsapp'), '5512345678');
  assert.equal(parsed.searchParams.get('rifa'), 'slug-post-compra');
});

test('modal de orden confirmada no agrega whatsapp cuando viene vacío o placeholder', () => {
  const context = crearContextoCompra('https://rifa.test/compra.html?rifa=slug-sin-whatsapp');
  vm.createContext(context);
  instalarHelperConfig(context);
  const builder = cargarBuilderModal(context);

  const url = builder('ORD-999', '-');
  const parsed = new URL(url);

  assert.equal(parsed.searchParams.get('ordenId'), 'ORD-999');
  assert.equal(parsed.searchParams.get('rifa'), 'slug-sin-whatsapp');
  assert.equal(parsed.searchParams.has('whatsapp'), false);
});
