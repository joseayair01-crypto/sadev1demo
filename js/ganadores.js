/**
 * ============================================================
 * ARCHIVO: js/ganadores.js
 * DESCRIPCIÓN: Sistema completo de gestión de ganadores
 * Maneja almacenamiento, validación y sincronización de ganadores
 * ============================================================
 */

// Namespace para evitar conflictos
window.ganadesoresManager = window.ganadesoresManager || {};

const GanadoresManager = {
    // Clave base para localStorage (ahora incluye rifaId dinámicamente)
    STORAGE_KEY_BASE: 'rifaplus_ganadores',
    SERVER_CACHE_KEY: 'rifaplus_ganadores_server_cache',

    /**
     * 🔐 Obtiene y valida el ID de la rifa seleccionada con máxima robustez
     */
    obtenerRifaIdSeleccionada() {
        let rifaId = null;
        const selectElement = document.getElementById('adminRifaSelect');
        
        // 1️⃣ Fuente más confiable: el selector DOM
        if (selectElement?.value) {
            rifaId = String(selectElement.value).trim();
            if (rifaId && /^\d+$/.test(rifaId)) {
                return Number.parseInt(rifaId, 10);
            }
        }
        
        // 2️⃣ Fuente secundaria: adminLayout API
        if (window.adminLayout?.getActiveRifaId || window.ADMIN_LAYOUT?.getActiveRifaId) {
            try {
                const layoutObj = window.adminLayout || window.ADMIN_LAYOUT;
                rifaId = layoutObj.getActiveRifaId?.();
                if (rifaId && /^\d+$/.test(String(rifaId))) {
                    return Number.parseInt(String(rifaId), 10);
                }
            } catch (e) {
                // ignorar errores
            }
        }
        
        // 3️⃣ Fuente de último recurso: localStorage
        if (!rifaId) {
            rifaId = localStorage.getItem('rifaplus_rifa_activa');
            if (rifaId && /^\d+$/.test(String(rifaId))) {
                return Number.parseInt(String(rifaId), 10);
            }
        }
        
        // 4️⃣ Fallback final
        return 1;
    },

    /**
     * 🔑 Obtener la clave de storage específica para la rifa actual
     */
    obtenerStorageKey() {
        if (typeof window.rifaplusConfig?.construirClaveLocal === 'function') {
            return window.rifaplusConfig.construirClaveLocal(this.STORAGE_KEY_BASE);
        }
        // Fallback robusto por slug
        const slug = window.rifaplusConfig?.obtenerSlugRifaActual?.() || 'global';
        return `rifaplus:${slug}:${this.STORAGE_KEY_BASE}`;
    },

    getApiBase() {
        return (window.rifaplusConfig?.backend?.apiBase)
            || window.rifaplusConfig?.obtenerApiBase?.()
            || window.location.origin;
    },

    normalizarTipoDesdeServidor(tipoRaw) {
        const tipo = String(tipoRaw || '').toLowerCase().trim();
        if (tipo.includes('presorte')) return 'presorteo';
        if (tipo.includes('rulet')) return 'ruletazos';
        return 'sorteo';
    },

    mapearGanadorServidor(row = {}) {
        return {
            numero: String(row.numero_boleto ?? row.numero ?? row.numero_orden ?? '').trim(),
            numero_boleto: row.numero_boleto ?? null,
            numero_orden: row.numero_orden ?? null,
            tipo: this.normalizarTipoDesdeServidor(row.tipo_ganador),
            nombre_cliente: row.nombre_ganador || row.nombre_cliente || '',
            apellido_cliente: row.apellido_cliente || '',
            ciudad: row.ciudad || row.ciudad_cliente || '',
            estado_cliente: row.estado_cliente || '',
            posicion: row.posicion || null,
            lugarGanado: row.posicion || null,
            fechaRegistro: row.fecha_sorteo || row.created_at || new Date().toISOString(),
            source: 'server'
        };
    },

    construirEstructuraVacia() {
        return { sorteo: [], presorteo: [], ruletazos: [] };
    },
    
    /**
     * Obtener la configuración de ganadores desde config.js
     * @returns {Object} Configuración de ganadores
     */
    getConfig() {
        if (!window.rifaplusConfig || !window.rifaplusConfig.rifa) {
            return { sorteo: 0, presorteo: 0, ruletazos: 0 };
        }

        if (window.rifaplusConfig.rifa.ganadores) {
            return window.rifaplusConfig.rifa.ganadores;
        }

        const sistemaPremios = window.rifaplusConfig.rifa.sistemaPremios || {};
        return {
            sorteo: Array.isArray(sistemaPremios.sorteo) ? sistemaPremios.sorteo.length : 0,
            presorteo: Array.isArray(sistemaPremios.presorteo) ? sistemaPremios.presorteo.length : 0,
            ruletazos: Array.isArray(sistemaPremios.ruletazos) ? sistemaPremios.ruletazos.length : 0
        };
    },

    /**
     * Obtener tipos de ganadores habilitados (con cantidad > 0)
     * @returns {Array} Array con tipos habilitados
     */
    getTiposHabilitados() {
        const config = this.getConfig();
        const tipos = [];
        
        if (config.sorteo > 0) tipos.push('sorteo');
        if (config.presorteo > 0) tipos.push('presorteo');
        if (config.ruletazos > 0) tipos.push('ruletazos');
        
        return tipos;
    },

    /**
     * Obtener etiqueta amigable para cada tipo de ganador
     * @param {String} tipo - Tipo de ganador (sorteo, presorteo, ruletazos)
     * @returns {String} Etiqueta formateada
     */
    getEtiquetaTipo(tipo) {
        const etiquetas = {
            sorteo: '🏆 Ganador del Sorteo',
            presorteo: '🎁 Ganador Presorteo',
            ruletazos: '🎰 Ganador Ruletazo'
        };
        return etiquetas[tipo] || tipo;
    },

    /**
     * Obtener icono para cada tipo de ganador
     * @param {String} tipo - Tipo de ganador
     * @returns {String} Icono emoji
     */
    getIconoTipo(tipo) {
        const iconos = {
            sorteo: '🏆',
            presorteo: '🎁',
            ruletazos: '🎰'
        };
        return iconos[tipo] || '⭐';
    },

    /**
     * Cargar ganadores desde localStorage (ESPECÍFICOS DE LA RIFA ACTUAL)
     * @returns {Object} Ganadores registrados para la rifa seleccionada
     */
    cargarGanadores() {
        try {
            const storageKey = this.obtenerStorageKey();
            const data = localStorage.getItem(storageKey);
            if (!data) return this.construirEstructuraVacia();
            
            const ganadores = JSON.parse(data);
            
            // Validar estructura
            if (!ganadores.sorteo) ganadores.sorteo = [];
            if (!ganadores.presorteo) ganadores.presorteo = [];
            if (!ganadores.ruletazos) ganadores.ruletazos = [];
            
            return ganadores;
        } catch (error) {
            return this.construirEstructuraVacia();
        }
    },

    /**
     * Guardar ganadores en localStorage (ESPECÍFICOS DE LA RIFA ACTUAL)
     * @param {Object} ganadores - Objeto con ganadores por tipo
     * @returns {Boolean} Éxito de la operación
     */
    guardarGanadores(ganadores) {
        try {
            const storageKey = this.obtenerStorageKey();
            localStorage.setItem(storageKey, JSON.stringify(ganadores));
            // Disparar evento para sincronización entre pestañas
            window.dispatchEvent(new CustomEvent('ganadesoresActualizados', { detail: ganadores }));
            return true;
        } catch (error) {
            return false;
        }
    },

    eliminarGanadorDeTodosLosTipos(numero, ganadores = null) {
        const numeroStr = String(numero).trim();
        const data = ganadores || this.cargarGanadores();
        ['sorteo', 'presorteo', 'ruletazos'].forEach((tipoExistente) => {
            data[tipoExistente] = (data[tipoExistente] || []).filter(g => String(g.numero) !== numeroStr);
        });
        return data;
    },

    /**
     * 🔐 Obtiene y valida el ID de la rifa seleccionada con máxima robustez
     * Prioridad: Selector DOM > adminLayout > localStorage > fallback
     */
    obtenerRifaIdSeleccionada() {
        let rifaId = null;
        const selectElement = document.getElementById('adminRifaSelect');
        
        // 1️⃣ Fuente más confiable: el selector DOM (lo que el usuario seleccionó)
        if (selectElement?.value) {
            rifaId = String(selectElement.value).trim();
            if (rifaId && /^\d+$/.test(rifaId)) {
                return Number.parseInt(rifaId, 10);
            }
        }
        
        // 2️⃣ Fuente secundaria: adminLayout API
        if (window.adminLayout?.getActiveRifaId || window.ADMIN_LAYOUT?.getActiveRifaId) {
            try {
                const layoutObj = window.adminLayout || window.ADMIN_LAYOUT;
                rifaId = layoutObj.getActiveRifaId?.();
                if (rifaId && /^\d+$/.test(String(rifaId))) {
                    return Number.parseInt(String(rifaId), 10);
                }
            } catch (e) {
                // ignorar errores
            }
        }
        
        // 3️⃣ Fuente de último recurso: localStorage
        if (!rifaId) {
            rifaId = localStorage.getItem('rifaplus_rifa_activa');
            if (rifaId && /^\d+$/.test(String(rifaId))) {
                return Number.parseInt(String(rifaId), 10);
            }
        }
        
        // 4️⃣ Fallback final
        return 1;
    },

    async obtenerGanadoresServidor(limit = 500) {
        const leerCacheServidor = () => {
            try {
                const cached = sessionStorage.getItem(this.SERVER_CACHE_KEY);
                return cached ? JSON.parse(cached) : [];
            } catch (e) {
                return [];
            }
        };

        try {
            // ✅ Obtener rifa seleccionada de forma ROBUSTA
            const rifaIdSeleccionada = this.obtenerRifaIdSeleccionada();
            
            const headers = {};
            if (rifaIdSeleccionada && rifaIdSeleccionada > 0) {
                headers['X-Rifa-Id'] = String(rifaIdSeleccionada);
            }

            const url = `${this.getApiBase()}/api/ganadores?limit=${limit}`;
            // ℹ️ Debug: Solo mostrar estos logs en modo debug
            console.debug(`[GanadoresManager] Obteniendo ganadores para rifa ${rifaIdSeleccionada}...`);

            const resp = await fetch(url, { headers });
            if (!resp.ok) {
                console.warn(`[GanadoresManager] ⚠️ API error ${resp.status} obteniendo ganadores`);
                return leerCacheServidor();
            }
            const payload = await resp.json().catch(() => ({}));
            const rows = Array.isArray(payload?.data) ? payload.data : [];
            
            console.debug(`[GanadoresManager] ✅ ${rows.length} ganadores sincronizados`);
            if (rows.length > 0) {
                console.debug(`[GanadoresManager] Tipos encontrados:`, rows.map(r => r.tipo_ganador).filter((v, i, a) => a.indexOf(v) === i));
            }
            
            try {
                sessionStorage.setItem(this.SERVER_CACHE_KEY, JSON.stringify(rows));
            } catch (e) {
                // ignorar cache
            }
            return rows;
        } catch (error) {
            console.warn('[GanadoresManager] Error obteniendo ganadores:', error);
            return leerCacheServidor();
        }
    },

    async refrescarDesdeServidor() {
        const rows = await this.obtenerGanadoresServidor();
        if (!Array.isArray(rows) || rows.length === 0) {
            return this.cargarGanadores();
        }

        const ganadores = this.construirEstructuraVacia();
        rows.forEach((row) => {
            const mapped = this.mapearGanadorServidor(row);
            if (!mapped.numero) return;
            const tipo = mapped.tipo || 'sorteo';
            ganadores[tipo].push(mapped);
        });

        Object.keys(ganadores).forEach((tipo) => {
            ganadores[tipo].sort((a, b) => (Number(a.posicion) || 999) - (Number(b.posicion) || 999));
        });

        this.guardarGanadores(ganadores);
        return ganadores;
    },

    async obtenerGanadorPersistido(numero) {
        const numeroStr = String(numero).trim();
        const rows = await this.obtenerGanadoresServidor();
        
        console.debug(`[GanadoresManager] Buscando ganador #${numeroStr}...`);
        
        const row = rows.find((item) => {
            const numeroBoleto = String(item.numero_boleto ?? item.numero ?? item.numero_orden ?? '').trim();
            const match = numeroBoleto === numeroStr;
            if (match) {
                console.debug(`[GanadoresManager] Ganador encontrado: #${numeroStr}`);
            }
            return match;
        });
        
        if (!row) {
            console.debug(`[GanadoresManager] Ganador NO encontrado: #${numeroStr}`);
        }
        
        return row ? this.mapearGanadorServidor(row) : null;
    },

    async obtenerGanadorActual(numero, opciones = {}) {
        const { preferServer = true, syncLocal = true } = opciones;
        const numeroStr = String(numero).trim();

        if (preferServer) {
            const ganadorServidor = await this.obtenerGanadorPersistido(numeroStr);
            if (ganadorServidor) {
                if (syncLocal) {
                    const ganadores = this.eliminarGanadorDeTodosLosTipos(numeroStr, this.cargarGanadores());
                    const tipo = ganadorServidor.tipo || 'sorteo';
                    ganadores[tipo].push(ganadorServidor);
                    ganadores[tipo].sort((a, b) => (Number(a.posicion) || 999) - (Number(b.posicion) || 999));
                    this.guardarGanadores(ganadores);
                }
                return ganadorServidor;
            }
        }

        return this.verificarGanador(numeroStr);
    },

    /**
     * Agregar un ganador nuevo
     * @param {String} numero - Número del boleto ganador
     * @param {String} tipo - Tipo de ganador (sorteo, presorteo, ruletazos)
     * @param {Object} datosCliente - Datos opcionales del cliente {nombre, apellido, ciudad, estado}
     * @param {Number} lugarGanado - Lugar en que ganó (1, 2, 3, etc) - opcional
     * @returns {Object} {exito: Boolean, mensaje: String}
     */
    agregarGanador(numero, tipo, datosCliente = {}, lugarGanado = null) {
        // Validar que tipo esté habilitado
        const config = this.getConfig();
        if (config[tipo] === 0) {
            return { exito: false, mensaje: `❌ El tipo "${tipo}" no está habilitado en la configuración` };
        }

        // Validar número
        numero = String(numero).trim();
        if (!numero || isNaN(numero)) {
            return { exito: false, mensaje: '❌ El número debe ser válido' };
        }

        const ganadores = this.eliminarGanadorDeTodosLosTipos(numero, this.cargarGanadores());
        
        // Validar que no sea duplicado
        if (ganadores[tipo].some(g => g.numero === numero)) {
            return { exito: false, mensaje: `❌ El número ${numero} ya está registrado como ganador de ${tipo}` };
        }

        // Validar cantidad de ganadores del tipo
        if (ganadores[tipo].length >= config[tipo]) {
            return { exito: false, mensaje: `❌ Ya tienes el máximo de ganadores (${config[tipo]}) para ${tipo}` };
        }

        // Agregar ganador con datos del cliente opcionales
        const ganador = {
            numero: numero,
            tipo: tipo,
            fechaRegistro: new Date().toISOString(),
            posicion: ganadores[tipo].length + 1
        };

        // Agregar lugar ganado si se proporciona
        if (lugarGanado !== null && lugarGanado !== undefined) {
            ganador.lugarGanado = Number(lugarGanado);
        }

        // Agregar datos del cliente si se proporcionan
        if (datosCliente && typeof datosCliente === 'object') {
            if (datosCliente.nombre) ganador.nombre_cliente = datosCliente.nombre;
            if (datosCliente.apellido) ganador.apellido_cliente = datosCliente.apellido;
            if (datosCliente.ciudad) ganador.ciudad = datosCliente.ciudad;
            if (datosCliente.estado_cliente) ganador.estado_cliente = datosCliente.estado_cliente;
        }

        ganadores[tipo].push(ganador);

        // Guardar
        if (this.guardarGanadores(ganadores)) {
            return { exito: true, mensaje: `✅ Ganador ${numero} registrado como ${this.getEtiquetaTipo(tipo)}` };
        } else {
            return { exito: false, mensaje: '❌ Error al guardar el ganador' };
        }
    },

    /**
     * Eliminar un ganador
     * @param {String} numero - Número del ganador
     * @param {String} tipo - Tipo de ganador
     * @returns {Boolean} Éxito de la operación
     */
    eliminarGanador(numero, tipo) {
        const ganadores = this.cargarGanadores();
        
        const indexAnterior = ganadores[tipo].length;
        ganadores[tipo] = ganadores[tipo].filter(g => g.numero !== numero);
        
        if (ganadores[tipo].length < indexAnterior) {
            // Actualizar posiciones
            ganadores[tipo].forEach((g, idx) => {
                g.posicion = idx + 1;
            });
            
            return this.guardarGanadores(ganadores);
        }
        
        return false;
    },

    /**
     * Obtener todos los ganadores
     * @returns {Object} Todos los ganadores registrados
     */
    obtenerTodos() {
        return this.cargarGanadores();
    },

    /**
     * Obtener ganadores de un tipo específico
     * @param {String} tipo - Tipo de ganador
     * @returns {Array} Ganadores del tipo especificado
     */
    obtenerPorTipo(tipo) {
        const ganadores = this.cargarGanadores();
        return ganadores[tipo] || [];
    },

    /**
     * Verificar si existe un ganador
     * @param {String} numero - Número a verificar
     * @returns {Object|null} Ganador encontrado o null
     */
    verificarGanador(numero) {
        const ganadores = this.cargarGanadores();
        numero = String(numero).trim();
        
        for (const tipo of ['sorteo', 'presorteo', 'ruletazos']) {
            const ganador = ganadores[tipo].find(g => g.numero === numero);
            if (ganador) return ganador;
        }
        
        return null;
    },

    /**
     * Contar ganadores registrados
     * @returns {Object} Conteo por tipo
     */
    contar() {
        const ganadores = this.cargarGanadores();
        return {
            sorteo: ganadores.sorteo.length,
            presorteo: ganadores.presorteo.length,
            ruletazos: ganadores.ruletazos.length,
            total: ganadores.sorteo.length + ganadores.presorteo.length + ganadores.ruletazos.length
        };
    },

    /**
     * Verificar si hay ganadores registrados
     * @returns {Boolean} True si hay al menos 1 ganador
     */
    hayGanadores() {
        const conteo = this.contar();
        return conteo.total > 0;
    },

    /**
     * Limpiar todos los ganadores (útil para reiniciar sorteo)
     * @returns {Boolean} Éxito de la operación
     */
    limpiarTodos() {
        return this.guardarGanadores(this.construirEstructuraVacia());
    },

    /**
     * Obtener ganadores formateados para mostrar
     * @returns {Object} Ganadores con información formateada
     */
    obtenerFormateados() {
        const ganadores = this.cargarGanadores();
        const config = this.getConfig();
        const resultado = {};

        for (const tipo of ['sorteo', 'presorteo', 'ruletazos']) {
            if (config[tipo] > 0) {
                resultado[tipo] = ganadores[tipo].map((g, idx) => ({
                    ...g,
                    icono: this.getIconoTipo(tipo),
                    etiqueta: this.getEtiquetaTipo(tipo),
                    numeroFormateado: window.rifaplusConfig.formatearNumeroBoleto(g.numero)
                }));
            }
        }

        return resultado;
    }
};

// Hacer disponible globalmente
window.GanadoresManager = GanadoresManager;

// Log de inicialización y diagnóstico
(function() {
    const conteo = GanadoresManager.contar();
    const datos = GanadoresManager.cargarGanadores();
    console.log('✅ GanadoresManager inicializado');
    console.log(`   Ganadores cargados: ${conteo.sorteo + conteo.presorteo + conteo.ruletazos} total (${conteo.sorteo} sorteo, ${conteo.presorteo} presorteo, ${conteo.ruletazos} ruletazos)`);
})();

// Escuchar cambios de ganadores desde otras pestañas
window.addEventListener('storage', function(e) {
    if (e.key === GanadoresManager.STORAGE_KEY) {
        // Los ganadores cambiaron en otra pestaña
        window.dispatchEvent(new CustomEvent('ganadesoresActualizados', { detail: GanadoresManager.cargarGanadores() }));
    }
});
