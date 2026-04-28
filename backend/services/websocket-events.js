// backend/services/websocket-events.js
// Servicios de eventos WebSocket para actualización en tiempo real
// Emite a todos los clientes conectados cuando hay cambios en boletos/órdenes

/**
 * Inicializa los eventos de WebSocket
 * Se llama desde server.js una vez que socket.io está configurado
 * 
 * @param {Object} io - Instancia de socket.io
 * @returns {Object} Funciones públicas para emitir eventos
 */
function inicializarEventosWebSocket(io, options = {}) {
    console.log('🔌 [WebSocket] Inicializando eventos de tiempo real...');
    const verifyAdminToken = typeof options.verifyAdminToken === 'function'
        ? options.verifyAdminToken
        : null;

    // Namespace /boletos para eventos relacionados con boletos
    const boletosNamespace = io.of('/boletos');
    const adminOrdersNamespace = io.of('/admin-ordenes');

    // Rastrear clientes conectados (para debugging)
    let clientesConectados = 0;
    let adminsConectados = 0;

    boletosNamespace.on('connection', (socket) => {
        clientesConectados++;
        console.log(`✅ [WebSocket] Cliente conectado: ${socket.id} (Total: ${clientesConectados})`);

        // Escuchar heartbeat para detectar clientes "vivos"
        socket.on('ping', (callback) => {
            if (typeof callback === 'function') {
                callback('pong');
            }
        });

        // Limpiar contador al desconectar
        socket.on('disconnect', () => {
            clientesConectados--;
            console.log(`🔌 [WebSocket] Cliente desconectado: ${socket.id} (Total: ${clientesConectados})`);
        });

        // Manejar errores de conexión
        socket.on('error', (error) => {
            console.error(`❌ [WebSocket] Error en socket ${socket.id}:`, error);
        });
    });

    if (verifyAdminToken) {
        adminOrdersNamespace.use((socket, next) => verifyAdminToken(socket, next));
    }

    adminOrdersNamespace.on('connection', (socket) => {
        adminsConectados++;
        console.log(`✅ [WebSocket][Admin] Cliente admin conectado: ${socket.id} (Total: ${adminsConectados})`);

        socket.on('disconnect', () => {
            adminsConectados--;
            console.log(`🔌 [WebSocket][Admin] Cliente admin desconectado: ${socket.id} (Total: ${adminsConectados})`);
        });

        socket.on('error', (error) => {
            console.error(`❌ [WebSocket][Admin] Error en socket ${socket.id}:`, error);
        });
    });

    /**
     * Emitir evento cuando cambien los boletos disponibles
     * Se llama desde POST /api/ordenes después de guardar la orden
     * 
     * @param {Object} cambios - Objeto con cambios: { vendidos, apartados, disponibles, nuevosBoletos }
     */
    function emitirCambioBoletosDisponibles(cambios) {
        const evento = {
            timestamp: new Date().toISOString(),
            tipo: 'actualización',
            ...cambios
        };

        console.log(`📤 [WebSocket] Emitiendo cambio de boletos:`, {
            vendidos: cambios.vendidos,
            apartados: cambios.apartados,
            disponibles: cambios.disponibles,
            clientes: boletosNamespace.sockets.size
        });

        // Emitir a todos los clientes conectados al namespace /boletos
        boletosNamespace.emit('boletosActualizados', evento);
    }

    /**
     * Emitir evento cuando se crea una nueva orden
     * 
     * @param {Array} numerosApartados - Array de números que se acaban de apartar
     * @param {Object} metadatos - Info adicional (cantidad, cliente, etc)
     */
    function emitirNuevaOrden(numerosApartados = [], metadatos = {}) {
        const boletos = Array.isArray(numerosApartados)
            ? numerosApartados
            : [];
        const cantidad = Array.isArray(numerosApartados)
            ? numerosApartados.length
            : Number(numerosApartados) || 0;
        const evento = {
            timestamp: new Date().toISOString(),
            tipo: 'nuevaOrden',
            boletos,
            cantidad,
            metadatos // { clienteNombre, whatsapp, etc }
        };

        console.log(`📤 [WebSocket] Emitiendo nueva orden:`, {
            cantidad,
            clientes: boletosNamespace.sockets.size
        });

        boletosNamespace.emit('ordenCreada', evento);
    }

    function emitirNuevaOrdenAdmin(orden = {}) {
        const numeroOrden = orden.numero_orden || orden.ordenId || orden.id || null;
        if (!numeroOrden) {
            console.warn('⚠️ [WebSocket][Admin] Nueva orden sin numero_orden; evento omitido');
            return;
        }

        const evento = {
            timestamp: new Date().toISOString(),
            tipo: 'adminOrdenCreada',
            orden: {
                numero_orden: numeroOrden,
                rifa_id: Number.parseInt(orden.rifa_id, 10) || null,
                nombre_cliente: orden.nombre_cliente || '',
                telefono_cliente: orden.telefono_cliente || '',
                estado: orden.estado || 'pendiente',
                cantidad_boletos: Number(orden.cantidad_boletos || orden.cantidad || 0),
                total: Number(orden.total || orden.totalFinal || 0),
                comprobante_path: orden.comprobante_path || null,
                created_at: orden.created_at || new Date().toISOString(),
                updated_at: orden.updated_at || orden.created_at || new Date().toISOString()
            }
        };

        console.log(`📤 [WebSocket][Admin] Emitiendo nueva orden admin:`, {
            numero_orden: numeroOrden,
            admins: adminOrdersNamespace.sockets.size
        });

        adminOrdersNamespace.emit('adminOrdenCreada', evento);
    }

    function emitirOrdenActualizadaAdmin(orden = {}) {
        const numeroOrden = orden.numero_orden || orden.ordenId || orden.id || null;
        if (!numeroOrden) {
            console.warn('⚠️ [WebSocket][Admin] Orden actualizada sin numero_orden; evento omitido');
            return;
        }

        const evento = {
            timestamp: new Date().toISOString(),
            tipo: 'adminOrdenActualizada',
            orden: {
                numero_orden: numeroOrden,
                rifa_id: Number.parseInt(orden.rifa_id, 10) || null,
                nombre_cliente: orden.nombre_cliente || '',
                telefono_cliente: orden.telefono_cliente || '',
                estado: orden.estado || null,
                estado_anterior: orden.estado_anterior || null,
                cantidad_boletos: Number(orden.cantidad_boletos || orden.cantidad || 0),
                total: Number(orden.total || orden.totalFinal || 0),
                comprobante_path: orden.comprobante_path || null,
                created_at: orden.created_at || null,
                updated_at: orden.updated_at || new Date().toISOString()
            }
        };

        console.log(`📤 [WebSocket][Admin] Emitiendo orden actualizada:`, {
            numero_orden: numeroOrden,
            estado: evento.orden.estado,
            admins: adminOrdersNamespace.sockets.size
        });

        adminOrdersNamespace.emit('adminOrdenActualizada', evento);
    }

    function emitirOrdenActualizadaPublica(orden = {}) {
        const numeroOrden = orden.numero_orden || orden.ordenId || orden.id || null;
        if (!numeroOrden) {
            console.warn('⚠️ [WebSocket][Publico] Orden actualizada sin numero_orden; evento omitido');
            return;
        }

        const evento = {
            timestamp: new Date().toISOString(),
            tipo: 'ordenEstadoActualizadoPublico',
            orden: {
                numero_orden: numeroOrden,
                rifa_id: Number.parseInt(orden.rifa_id, 10) || null,
                estado: orden.estado || null,
                estado_anterior: orden.estado_anterior || null,
                updated_at: orden.updated_at || new Date().toISOString()
            }
        };

        console.log(`📤 [WebSocket][Publico] Emitiendo actualización pública de orden:`, {
            numero_orden: numeroOrden,
            estado: evento.orden.estado,
            clientes: boletosNamespace.sockets.size
        });

        boletosNamespace.emit('ordenEstadoActualizadoPublico', evento);
    }

    /**
     * Emitir evento cuando una orden se cancela/expira
     * 
     * @param {Array} numerosLiberados - Números que vuelven a quedar disponibles
     * @param {string} razon - Razón de la cancelación (expiración, usuario, etc)
     */
    function emitirOrdenCancelada(numerosLiberados = [], razon = 'cancelación') {
        const evento = {
            timestamp: new Date().toISOString(),
            tipo: 'ordenCancelada',
            boletos: numerosLiberados,
            cantidad: numerosLiberados.length,
            razon
        };

        console.log(`📤 [WebSocket] Emitiendo cancelación:`, {
            cantidad: numerosLiberados.length,
            razon,
            clientes: boletosNamespace.sockets.size
        });

        boletosNamespace.emit('ordenCancelada', evento);
    }

    /**
     * Obtener estadísticas de conexiones (para debugging)
     */
    function obtenerEstadisticas() {
        return {
            clientesConectados,
            adminsConectados,
            sockets: boletosNamespace.sockets.size,
            adminSockets: adminOrdersNamespace.sockets.size,
            timestamp: new Date().toISOString()
        };
    }

    // Retornar interfaz pública
    return {
        emitirCambioBoletosDisponibles,
        emitirNuevaOrden,
        emitirNuevaOrdenAdmin,
        emitirOrdenActualizadaAdmin,
        emitirOrdenActualizadaPublica,
        emitirOrdenCancelada,
        obtenerEstadisticas,
        boletosNamespace,
        adminOrdersNamespace
    };
}

module.exports = { inicializarEventosWebSocket };
