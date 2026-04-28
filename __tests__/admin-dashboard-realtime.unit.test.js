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

describe('admin-dashboard realtime helpers', () => {
    const dashboardSource = leerArchivo('admin-dashboard.html');
    const helpersSource = extraerBloque(
        dashboardSource,
        'const DASHBOARD_REFRESH_POLICY',
        '\n        function requestStatsRefreshTiempoReal'
    );

    function crearContexto() {
        document.body.innerHTML = `
            <div id="statsGrid" data-stats-ready="true"></div>
            <div id="statAvailable">0</div>
            <div id="statSold">0</div>
            <div id="statReserved">0</div>
            <div id="statRevenue">$0</div>
            <div id="statTotalOrders">0</div>
            <div id="totalTickets">0</div>
            <div id="progressSold">0</div>
            <div id="progressReserved">0</div>
            <div id="progressRemaining">0</div>
            <div id="progressPercentage">0%</div>
            <div id="progressBar"></div>
            <div id="statPending">0</div>
            <div id="pendingCount">0</div>
            <div id="pendingBadge" style="display:none"></div>
            <div id="ordersContainer"></div>
        `;

        const context = {
            console: {
                warn: jest.fn(),
                error: jest.fn(),
                log: jest.fn(),
                debug: jest.fn()
            },
            document,
            window: {},
            URL_API: 'https://api.test',
            setTimeout,
            clearTimeout,
            Date,
            Map,
            Number,
            Math,
            String,
            Array,
            parseFloat,
            escapeHtmlAdmin: (value) => String(value),
            escapeJsSingleQuote: (value) => String(value),
            actualizarResumenPendientesDashboard: jest.fn((total) => {
                const pending = document.getElementById('statPending');
                const count = document.getElementById('pendingCount');
                if (pending) pending.textContent = String(total);
                if (count) count.textContent = String(total);
            }),
            actualizarResumenEjecutivo: jest.fn(),
            calcularPronosticoVentas: jest.fn(),
            obtenerClaveRifaDashboard: () => 'rifa:test',
            obtenerRifaActivaDashboard: () => 1
        };
        context.window = context;

        vm.createContext(context);
        vm.runInContext(helpersSource, context);
        return context;
    }

    test('aplica delta de orden confirmada sobre snapshot local sin recargar todo', () => {
        const context = crearContexto();

        context.actualizarSnapshotEstadisticasDashboard({
            totalBoletos: 100,
            vendidos: 10,
            apartados: 3,
            pendientes: 2,
            ingresosConfirmados: 600,
            totalOrdenes: 5,
            disponibles: 87
        });

        const aplicado = context.aplicarDeltaOrdenAStatsSnapshot({
            numero_orden: 'ORD-100',
            estado: 'confirmada',
            cantidad_boletos: 2,
            total: 120
        }, 'pendiente');

        expect(aplicado).toBe(true);
        expect(document.getElementById('statSold').textContent).toBe('12');
        expect(document.getElementById('statReserved').textContent).toBe('1');
        expect(document.getElementById('statPending').textContent).toBe('1');
        expect(document.getElementById('statRevenue').textContent).toBe('$720');
        expect(document.getElementById('statAvailable').textContent).toBe('87');
        expect(context.actualizarResumenEjecutivo).toHaveBeenCalled();
        expect(context.calcularPronosticoVentas).toHaveBeenCalled();
    });

    test('deduplica eventos admin repetidos del mismo socket', () => {
        const context = crearContexto();
        const orden = {
            numero_orden: 'ORD-200',
            estado: 'pendiente',
            updated_at: '2026-04-23T12:00:00.000Z'
        };

        expect(context.marcarEventoAdminOrdenProcesado('create', orden, null)).toBe(true);
        expect(context.marcarEventoAdminOrdenProcesado('create', orden, null)).toBe(false);
        expect(context.marcarEventoAdminOrdenProcesado('update', {
            ...orden,
            estado: 'confirmada'
        }, 'pendiente')).toBe(true);
    });
});
