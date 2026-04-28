const fs = require('fs');
const path = require('path');
const vm = require('vm');

function leerArchivo(relPath) {
    return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

function extraerBloque(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    if (start === -1) {
        throw new Error(`No se encontro el inicio: ${startMarker}`);
    }

    const end = source.indexOf(endMarker, start);
    if (end === -1) {
        throw new Error(`No se encontro el fin: ${endMarker}`);
    }

    return source.slice(start, end);
}

describe('Promociones en compra', () => {
    const compraPageSource = leerArchivo('js/compra-page.js');
    const bloquePromociones = extraerBloque(
        compraPageSource,
        'function formatearVigencia(fecha) {',
        '\n    function aplicarLayoutCards(contenedor) {'
    );

    test('usa la validacion horaria compartida antes de mostrar una promo por tiempo', () => {
        const RealDate = Date;
        const context = {
            window: {
                rifaplusConfig: {
                    esFechaPromocionActiva: jest.fn(() => false),
                    parseFechaPromocion: jest.fn((valor) => new RealDate(valor))
                }
            },
            Date: class extends RealDate {
                constructor(...args) {
                    if (args.length === 0) {
                        return new RealDate('2026-04-24T12:00:00Z');
                    }
                    return new RealDate(...args);
                }

                static now() {
                    return new RealDate('2026-04-24T12:00:00Z').getTime();
                }
            }
        };

        vm.createContext(context);
        vm.runInContext(
            `
            ${bloquePromociones}
            globalThis.resultado = resolverPromocionActiva({
                precioBoleto: 10,
                timeZone: 'America/Mexico_City',
                promocionPorTiempo: {
                    enabled: true,
                    precioProvisional: 5,
                    fechaInicio: '2026-04-24T00:00',
                    fechaFin: '2026-04-24T23:59'
                }
            });
            `,
            context
        );

        expect(context.window.rifaplusConfig.esFechaPromocionActiva).toHaveBeenCalledWith(
            '2026-04-24T00:00',
            '2026-04-24T23:59',
            expect.any(Date),
            'America/Mexico_City'
        );
        expect(context.resultado.activa).toBe(false);
        expect(context.resultado.tipo).toBe('ninguna');
        expect(context.resultado.precioFinal).toBe(10);
    });
});
