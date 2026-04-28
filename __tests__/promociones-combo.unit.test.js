const {
    calcularPromocionCombo,
    calcularTotalesServidor
} = require('../backend/calculo-precios-server');

describe('promociones combo', () => {
    test('aplica 2x1 cobrando solo los boletos pagados', () => {
        const resultado = calcularPromocionCombo(5, 10, [
            { cantidadRecibe: 2, cantidadPaga: 1, etiqueta: '2x1' }
        ]);

        expect(resultado.comboAplicado).toBe(true);
        expect(resultado.boletosEntregados).toBe(5);
        expect(resultado.boletosPagados).toBe(3);
        expect(resultado.boletosBonificados).toBe(2);
        expect(resultado.total).toBe(30);
        expect(resultado.descuento).toBe(20);
    });

    test('prioriza combo sobre descuento por volumen', () => {
        const config = {
            rifa: {
                precioBoleto: 10,
                descuentos: {
                    enabled: true,
                    reglas: [
                        { cantidad: 4, total: 28 }
                    ]
                },
                promocionesCombo: {
                    enabled: true,
                    reglas: [
                        { cantidadRecibe: 2, cantidadPaga: 1, etiqueta: '2x1' }
                    ]
                }
            }
        };

        const resultado = calcularTotalesServidor(4, config, new Date('2026-04-24T10:00:00-06:00'));

        expect(resultado.totalFinal).toBe(20);
        expect(resultado.descuentoCantidad).toBe(0);
        expect(resultado.descuentoCombo).toBe(20);
        expect(resultado.combo.applied).toBe(true);
        expect(resultado.combo.boletosPagados).toBe(2);
        expect(resultado.combo.boletosBonificados).toBe(2);
    });

    test('convive con descuento por porcentaje tomando el precio por boleto activo', () => {
        const config = {
            rifa: {
                precioBoleto: 10,
                descuentoPorcentaje: {
                    enabled: true,
                    porcentaje: 20,
                    fechaInicio: '2026-04-24T00:00',
                    fechaFin: '2026-04-25T23:59'
                },
                descuentos: {
                    enabled: false,
                    reglas: []
                },
                promocionesCombo: {
                    enabled: true,
                    reglas: [
                        { cantidadRecibe: 3, cantidadPaga: 1, etiqueta: '3x1' }
                    ]
                }
            }
        };

        const resultado = calcularTotalesServidor(3, config, new Date('2026-04-24T10:00:00-06:00'));

        expect(resultado.precioUnitario).toBe(8);
        expect(resultado.subtotal).toBe(30);
        expect(resultado.descuentoPromocion).toBe(6);
        expect(resultado.descuentoCombo).toBe(16);
        expect(resultado.descuento).toBe(22);
        expect(resultado.totalFinal).toBe(8);
        expect(resultado.combo.applied).toBe(true);
        expect(resultado.combo.boletosPagados).toBe(1);
    });
});
