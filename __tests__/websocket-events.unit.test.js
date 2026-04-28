const { inicializarEventosWebSocket } = require('../backend/services/websocket-events.js');

function crearNamespace() {
    return {
        sockets: new Map(),
        emit: jest.fn(),
        use: jest.fn(),
        on: jest.fn()
    };
}

describe('websocket-events admin payload', () => {
    test('emite contexto enriquecido para orden actualizada admin', () => {
        const boletosNamespace = crearNamespace();
        const adminNamespace = crearNamespace();
        const io = {
            of: jest.fn((namespace) => {
                if (namespace === '/boletos') return boletosNamespace;
                if (namespace === '/admin-ordenes') return adminNamespace;
                throw new Error(`Namespace inesperado: ${namespace}`);
            })
        };

        const eventos = inicializarEventosWebSocket(io);

        eventos.emitirOrdenActualizadaAdmin({
            numero_orden: 'ORD-500',
            rifa_id: 9,
            nombre_cliente: 'Cliente Demo',
            telefono_cliente: '5551234567',
            estado: 'confirmada',
            estado_anterior: 'pendiente',
            cantidad_boletos: 4,
            total: 240,
            comprobante_path: '/tmp/comprobante.png',
            created_at: '2026-04-23T10:00:00.000Z',
            updated_at: '2026-04-23T10:05:00.000Z'
        });

        expect(adminNamespace.emit).toHaveBeenCalledTimes(1);
        expect(adminNamespace.emit).toHaveBeenCalledWith(
            'adminOrdenActualizada',
            expect.objectContaining({
                tipo: 'adminOrdenActualizada',
                orden: expect.objectContaining({
                    numero_orden: 'ORD-500',
                    rifa_id: 9,
                    nombre_cliente: 'Cliente Demo',
                    telefono_cliente: '5551234567',
                    estado: 'confirmada',
                    estado_anterior: 'pendiente',
                    cantidad_boletos: 4,
                    total: 240,
                    comprobante_path: '/tmp/comprobante.png',
                    created_at: '2026-04-23T10:00:00.000Z',
                    updated_at: '2026-04-23T10:05:00.000Z'
                })
            })
        );
    });

    test('emite payload publico minimo para actualizar mis boletos en vivo', () => {
        const boletosNamespace = crearNamespace();
        const adminNamespace = crearNamespace();
        const io = {
            of: jest.fn((namespace) => {
                if (namespace === '/boletos') return boletosNamespace;
                if (namespace === '/admin-ordenes') return adminNamespace;
                throw new Error(`Namespace inesperado: ${namespace}`);
            })
        };

        const eventos = inicializarEventosWebSocket(io);

        eventos.emitirOrdenActualizadaPublica({
            numero_orden: 'ORD-501',
            rifa_id: 11,
            estado: 'confirmada',
            estado_anterior: 'pendiente',
            updated_at: '2026-04-26T08:40:00.000Z'
        });

        expect(boletosNamespace.emit).toHaveBeenCalledWith(
            'ordenEstadoActualizadoPublico',
            expect.objectContaining({
                tipo: 'ordenEstadoActualizadoPublico',
                orden: expect.objectContaining({
                    numero_orden: 'ORD-501',
                    rifa_id: 11,
                    estado: 'confirmada',
                    estado_anterior: 'pendiente',
                    updated_at: '2026-04-26T08:40:00.000Z'
                })
            })
        );
    });
});
