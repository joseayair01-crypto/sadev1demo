/**
 * ============================================================
 * ARCHIVO: js/modal-sorteo-finalizado.js
 * DESCRIPCIÓN: Modal de cierre profesional del sorteo
 * VERSION: 2.0 - PRODUCCIÓN ROBUSTA
 * ============================================================
 */

class ModalSorteoFinalizado {
    constructor() {
        this.modalCreado = false;
        this.verificacionActiva = false;
        this.navegacionBloqueada = false;
        this.logEnabled = ['localhost', '127.0.0.1'].includes(window.location.hostname);
        this.verificacionTimeoutId = null;
        this._eventosRegistrados = false;
        
        // Log de inicialización
        this.log('🎉 ModalSorteoFinalizado inicializado', 'constructor');
    }

    esEstadoTerminal(estado) {
        const valor = String(estado || '').trim().toLowerCase();
        return valor === 'finalizado' || valor === 'archivada' || valor === 'depurada';
    }

    puedeAsignarPropiedad(objeto, propiedad) {
        if (!objeto || typeof objeto !== 'object') {
            return false;
        }

        let actual = objeto;
        while (actual && actual !== Object.prototype) {
            const descriptor = Object.getOwnPropertyDescriptor(actual, propiedad);
            if (descriptor) {
                return Boolean(descriptor.writable || descriptor.set);
            }
            actual = Object.getPrototypeOf(actual);
        }

        return true;
    }

    /**
     * MÉTODO PRINCIPAL - Inicializa el sistema
     */
    inicializar() {
        this.log('Iniciando verificación del estado del sorteo...', 'inicializar');
        this.registrarEventosDeVerificacion();
        this.programarVerificacionEstado(100);
    }

    /**
     * Verifica el estado ACTUAL del sorteo
     */
    verificarEstadoSorteo() {
        try {
            // Si hay una supresión temporal desde otra navegación, no mostrar modal
            try {
                const suppressUntil = parseInt(sessionStorage.getItem('rifaplus_modal_suppressed_until') || '0', 10);
                if (suppressUntil && Date.now() < suppressUntil) {
                    this.log('Supresión de modal activa; omitiendo verificación temporalmente', 'info');
                    return;
                }
            } catch (e) {
                // ignore sessionStorage errors
            }

            const config = window.rifaplusConfig;
            
            if (!config) {
                this.log('❌ CRÍTICO: window.rifaplusConfig no existe', 'error');
                return;
            }

            const sorteoActivo = config.sorteoActivo;
            
            if (!sorteoActivo) {
                this.log('❌ CRÍTICO: sorteoActivo no existe en config', 'error');
                return;
            }

            const estadoRifa = String(config?.rifa?.estado || '').trim().toLowerCase();
            const estado = estadoRifa || sorteoActivo.estado || 'activo';
            const ahora = Date.now();
            const fechaReferencia = config?.rifa?.fechaSorteo || sorteoActivo.fechaCierre;
            const fechaCierre = new Date(fechaReferencia).getTime();
            const tiempoRestante = fechaCierre - ahora;

            if (!this.esEstadoTerminal(estadoRifa) && Number.isFinite(fechaCierre) && ahora < fechaCierre) {
                if (config.sorteoActivo) {
                    config.sorteoActivo.estado = 'activo';
                    if (this.puedeAsignarPropiedad(config.sorteoActivo, 'fechaCierre')) {
                        config.sorteoActivo.fechaCierre = config?.rifa?.fechaSorteo || config.sorteoActivo.fechaCierre;
                    }
                    config.sorteoActivo.fechaCierreFormato = config?.rifa?.fechaSorteoFormato || config.sorteoActivo.fechaCierreFormato || '';
                }
                if (config.rifa) {
                    config.rifa.modalFinalizadoSnapshot = null;
                }
                config.permitirCompras = true;
                return;
            }

            // CONDICIÓN 1: La rifa ya está en un estado terminal
            if (this.esEstadoTerminal(estado)) {
                config.permitirCompras = false;
                if (config.sorteoActivo) {
                    config.sorteoActivo.estado = 'finalizado';
                }
                if (config.rifa) {
                    config.rifa.estado = 'finalizado';
                }

                this.log(`✅ Estado terminal detectado (${estado}) - Mostrando modal`, 'verificacion');
                this.mostrarModal();
                this.verificacionActiva = false;
                return;
            }

            // CONDICIÓN 2: Hora de cierre alcanzada
            if (ahora >= fechaCierre && estado === 'activo') {
                this.log('⏰ Hora de cierre ALCANZADA - Finalizando sorteo', 'verificacion');
                
                // Cambiar estado automáticamente
                config.sorteoActivo.estado = 'finalizado';
                if (config.rifa) {
                    config.rifa.estado = 'finalizado';
                }
                config.permitirCompras = false;
                
                this.log('✅ Estado actualizado a FINALIZADO', 'actualizacion');
                this.mostrarModal();
                this.verificacionActiva = false;
                return;
            }

            // El sorteo aún está activo (no loguear para evitar spam de consola)

        } catch (error) {
            this.log(`❌ Error en verificarEstadoSorteo: ${error.message}`, 'error');
            console.error(error);
        }
    }

    /**
     * Inicia verificación continua
     */
    iniciarVerificacionContinua() {
        this.programarVerificacionEstado();
    }

    programarVerificacionEstado(delayMs = null) {
        if (this.modalCreado) return;

        if (this.verificacionTimeoutId) {
            clearTimeout(this.verificacionTimeoutId);
            this.verificacionTimeoutId = null;
        }

        const config = window.rifaplusConfig;
        const sorteoActivo = config?.sorteoActivo;
        const estado = config?.rifa?.estado || sorteoActivo?.estado || 'activo';

        if (this.esEstadoTerminal(estado)) {
            this.verificarEstadoSorteo();
            return;
        }

        const fechaCierre = new Date(sorteoActivo?.fechaCierre || '').getTime();
        const ahora = Date.now();
        let siguienteRevision = Number.isFinite(delayMs) ? delayMs : 1000;

        if (!Number.isFinite(delayMs) && Number.isFinite(fechaCierre) && fechaCierre > ahora) {
            // Revisa justo al cierre o antes si el plazo es demasiado largo.
            siguienteRevision = Math.min(Math.max(fechaCierre - ahora + 50, 250), 60000);
        }

        this.verificacionActiva = true;
        this.verificacionTimeoutId = setTimeout(() => {
            this.verificacionTimeoutId = null;
            this.verificarEstadoSorteo();
            if (!this.modalCreado) {
                this.programarVerificacionEstado();
            } else {
                this.verificacionActiva = false;
            }
        }, siguienteRevision);
    }

    registrarEventosDeVerificacion() {
        if (this._eventosRegistrados) return;
        this._eventosRegistrados = true;

        const revalidar = () => {
            if (this.modalCreado) return;
            this.programarVerificacionEstado(80);
        };

        window.addEventListener('configSyncCompleto', revalidar);
        window.addEventListener('configuracionActualizada', revalidar);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                revalidar();
            }
        });
        window.addEventListener('pageshow', revalidar);
    }

    /**
     * Crea y muestra el modal
     */
    async mostrarModal() {
        try {
            if (this.modalCreado) {
                this.log('Modal ya fue creado, omitiendo...', 'warning');
                return;
            }

            if (this.verificacionTimeoutId) {
                clearTimeout(this.verificacionTimeoutId);
                this.verificacionTimeoutId = null;
            }

            this.log('Creando modal...', 'modal');

            const config = window.rifaplusConfig;
            const { snapshot, configModal, sorteoModal } = await this.resolverContextoModal(config);

            // Obtener ganadores (usa GanadoresManager, servidor, o snapshot en ese orden)
            const ganadoresReales = await this.obtenerGanadoresReales(snapshot);

            const tieneGanadores = ganadoresReales && Object.keys(ganadoresReales).some(tipo =>
                ganadoresReales[tipo] && ganadoresReales[tipo].length > 0
            );
            if (!tieneGanadores) {
                this.log('No hay ganadores persistidos todavía; se mostrará modal de cierre con estado pendiente', 'warning');
            }

            // Crear overlay fullscreen
            const overlay = document.createElement('div');
            overlay.id = 'modalSorteoFinalizadoOverlay';
            overlay.className = 'modal-sorteo-overlay';
            overlay.innerHTML = this.generarHTMLModal(sorteoModal, configModal, ganadoresReales);
            this.aplicarTemaSnapshotAlOverlay(overlay, snapshot);

            // Agregar al DOM
            document.body.appendChild(overlay);
            window.rifaplusModalScrollLock?.sync?.();
            this.activarModoRestringido();

            // Agregar estilos CSS
            this.inyectarCSS();

            // Configurar event listeners
            this.configurarEventListeners();
            this.bloquearNavegacion();

            // Animación de entrada
            setTimeout(() => {
                overlay.classList.add('modal-visible');
                this.mostrarConfeti();
                this.log('Modal mostrado correctamente', 'exito');
            }, 100);

            this.modalCreado = true;

        } catch (error) {
            this.log(`❌ Error en mostrarModal: ${error.message}`, 'error');
            console.error(error);
        }
    }

    async obtenerSnapshotFinalizado(config) {
        const estado = config?.rifa?.estado || config?.sorteoActivo?.estado || 'activo';
        let snapshot = config?.rifa?.modalFinalizadoSnapshot;
        
        // ✅ CRÍTICO: Para rifas DEPURADAS, si no hay snapshot en config, obtenerlo del backend
        if (estado === 'depurada' && (!snapshot || typeof snapshot !== 'object')) {
            this.log('⚠️ Rifa depurada sin snapshot en config, obteniendo del backend...', 'warning');
            
            const apiBase = config?.backend?.apiBase
                || (typeof config?.obtenerApiBase === 'function' ? config.obtenerApiBase() : '')
                || window.location.origin;
            const slug = config?.rifa?.slug || (typeof config?.obtenerSlugRifaActual === 'function' ? config.obtenerSlugRifaActual() : '') || '';
            
            if (slug) {
                try {
                    const resp = await fetch(`${apiBase}/api/public/rifas-pasadas/${slug}`);
                    if (resp.ok) {
                        const resJson = await resp.json();
                        if (resJson?.success && resJson?.data?.snapshot) {
                            snapshot = resJson.data.snapshot;
                            this.log('✅ Snapshot obtenido exitosamente desde el backend público para rifa depurada', 'exito');
                        }
                    }
                } catch (e) {
                    this.log('⚠️ Error obteniendo snapshot desde el backend: ' + e.message, 'warning');
                }
            }

            // Fallback secundario: usar ganadores de localStorage si están disponibles
            if (!snapshot && window.GanadoresManager) {
                const ganadoresLocales = window.GanadoresManager.cargarGanadores();
                if (ganadoresLocales && (ganadoresLocales.sorteo?.length > 0 || ganadoresLocales.presorteo?.length > 0 || ganadoresLocales.ruletazos?.length > 0)) {
                    this.log('✅ Usando ganadores de localStorage como fallback para rifa depurada', 'exito');
                    return {
                        meta: { huellaRifa: config?.rifa?.huella || '' },
                        ganadores: ganadoresLocales
                    };
                }
            }
        }
        
        if (!this.esEstadoTerminal(estado)) return null;
        if (!snapshot || typeof snapshot !== 'object') return null;
        return await this.snapshotCorrespondeARifaActual(snapshot, config) ? snapshot : null;
    }

    async crearHuellaRifaActual(config = {}) {
        const rifa = config?.rifa || {};
        const payload = {
            edicionNombre: String(rifa.edicionNombre || '').trim(),
            nombreSorteo: String(rifa.nombreSorteo || '').trim(),
            fechaSorteo: String(rifa.fechaSorteo || '').trim(),
            totalBoletos: Number(rifa.totalBoletos) || 0,
            precioBoleto: Number(rifa.precioBoleto) || 0
        };
        const text = JSON.stringify(payload);
        
        try {
            // Calcular hash SHA-1 usando Web Crypto API nativa de forma robusta y compatible
            const encoder = new TextEncoder();
            const data = encoder.encode(text);
            const hashBuffer = await window.crypto.subtle.digest('SHA-1', data);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
            return hashHex;
        } catch (error) {
            console.error('Error calculando SHA-1 en frontend:', error);
            return text; // Fallback defensivo si subtle crypto no está disponible
        }
    }

    async snapshotCorrespondeARifaActual(snapshot, config = {}) {
        const huellaSnapshot = String(snapshot?.meta?.huellaRifa || '').trim();
        if (!huellaSnapshot) return false;
        
        // Generar la huella esperada tanto en formato hash SHA-1 como en formato plano (fallback)
        const hashEsperado = await this.crearHuellaRifaActual(config);
        
        // Comparación flexible: soporta hash SHA-1 o JSON plano para retrocompatibilidad total
        if (huellaSnapshot === hashEsperado) return true;
        
        const payloadPlano = {
            edicionNombre: String(config?.rifa?.edicionNombre || '').trim(),
            nombreSorteo: String(config?.rifa?.nombreSorteo || '').trim(),
            fechaSorteo: String(config?.rifa?.fechaSorteo || '').trim(),
            totalBoletos: Number(config?.rifa?.totalBoletos) || 0,
            precioBoleto: Number(config?.rifa?.precioBoleto) || 0
        };
        const stringPlano = JSON.stringify(payloadPlano);
        if (huellaSnapshot === stringPlano) return true;

        // Fallback defensivo final: si la huella no coincide pero el ID de la rifa coincide plenamente,
        // confiamos en el contexto para no dejar vacía la pantalla bajo ninguna circunstancia.
        const snapshotId = Number(snapshot?.id || snapshot?.rifa_id);
        const configId = Number(config?.rifa_id || config?.rifa?.id);
        if (snapshotId && configId && snapshotId === configId) {
            return true;
        }

        return false;
    }

    async resolverContextoModal(config) {
        const snapshot = await this.obtenerSnapshotFinalizado(config);
        if (!snapshot) {
            return {
                snapshot: null,
                configModal: config,
                sorteoModal: config?.sorteoActivo
            };
        }

        const configModal = {
            ...config,
            cliente: {
                ...(config?.cliente || {}),
                ...(snapshot?.cliente || {})
            },
            rifa: {
                ...(config?.rifa || {}),
                ...(snapshot?.rifa || {}),
                sistemaPremios: snapshot?.rifa?.sistemaPremios || config?.rifa?.sistemaPremios || {}
            }
        };

        const sorteoModal = {
            ...(config?.sorteoActivo || {}),
            ...(snapshot?.sorteo || {}),
            ganadores: snapshot?.ganadores || (config?.sorteoActivo?.ganadores || {})
        };

        return {
            snapshot,
            configModal,
            sorteoModal
        };
    }

    aplicarTemaSnapshotAlOverlay(overlay, snapshot) {
        if (!overlay || !snapshot?.tema) return;

        const tema = snapshot.tema || {};
        const colores = tema.colores || {};

        const asignaciones = {
            '--modal-primary': colores.primary || colores.colorPrimario || tema.colorPrimario || '',
            '--modal-primary-dark': colores.primaryDark || tema.colorPrimarioOscuro || '',
            '--modal-secondary': colores.secondary || colores.colorSecundario || tema.colorSecundario || '',
            '--modal-secondary-dark': colores.secondaryDark || '',
            '--modal-surface': colores.surface || colores.colorSuperficie || '',
            '--modal-surface-accent': colores.surfaceAccent || '',
            '--modal-text': colores.textDark || colores.colorTexto || '',
            '--modal-text-muted': colores.textMuted || colores.colorTextoSecundario || ''
        };

        Object.entries(asignaciones).forEach(([variable, valor]) => {
            if (typeof valor === 'string' && valor.trim()) {
                overlay.style.setProperty(variable, valor.trim());
            }
        });
    }

    /**
     * Espera a que GanadoresManager esté disponible
     * @param {Function} callback - Función a ejecutar cuando esté disponible
     * @param {number} timeout - Timeout en ms (default 2000)
     */
    esperarGanadoresManager(callback, timeout = 2000) {
        const inicio = Date.now();
        
        const verificar = () => {
            if (window.GanadoresManager) {
                this.log('✅ GanadoresManager está disponible, continuando...', 'exito');
                callback();
                return;
            }

            if (Date.now() - inicio > timeout) {
                this.log('⏱️ Timeout esperando GanadoresManager (2s), continuando sin él...', 'warning');
                callback();
                return;
            }

            setTimeout(verificar, 50); // Reintentar cada 50ms
        };

        verificar();
    }

    /**
     * Genera el HTML del modal
     */
    generarHTMLModal(sorteo, config, ganadoresReales = null) {
        // Usar ganadores reales si están disponibles; sino, caer en el fallback de sorteo.ganadores
        // Normalizamos las claves al formato esperado: `sorteo`, `presorteo`, `ruletazos`
        const ganadoresAUsar = (function() {
            if (ganadoresReales) {
                // Si vienen de la función interna, pueden tener claves variadas; intentar mapear
                if (ganadoresReales.sorteo || ganadoresReales.presorteo || ganadoresReales.ruletazos) {
                    return ganadoresReales;
                }
                // soportar versiones antiguas con `principal`/`presorte`/`ruletazo`
                return {
                    sorteo: ganadoresReales.principal || [],
                    presorteo: ganadoresReales.presorte || [],
                    ruletazos: ganadoresReales.ruletazo || []
                };
            }

            // Fallback desde sorteo.ganadores (estructura antigua)
            return {
                sorteo: (sorteo.ganadores && (sorteo.ganadores.principal || sorteo.ganadores.sorteo)) || [],
                presorteo: (sorteo.ganadores && (sorteo.ganadores.presorte || sorteo.ganadores.presorteo)) || [],
                ruletazos: (sorteo.ganadores && (sorteo.ganadores.ruletazo || sorteo.ganadores.ruletazos)) || []
            };
        })();

        const hayGanadores = ['sorteo', 'presorteo', 'ruletazos'].some((tipo) =>
            Array.isArray(ganadoresAUsar[tipo]) && ganadoresAUsar[tipo].length > 0
        );
        const sistemaPremios = config?.rifa?.sistemaPremios || {};
        const tiposEsperados = [
            { key: 'sorteo', cantidad: Array.isArray(sistemaPremios.sorteo) ? sistemaPremios.sorteo.length : 0 },
            { key: 'presorteo', cantidad: Array.isArray(sistemaPremios.presorteo) ? sistemaPremios.presorteo.length : 0 },
            { key: 'ruletazos', cantidad: Array.isArray(sistemaPremios.ruletazos) ? sistemaPremios.ruletazos.length : 0 }
        ].filter((tipo) => tipo.cantidad > 0);
        const faltanGanadoresPorPublicar = tiposEsperados.length > 0 && tiposEsperados.some((tipo) => {
            const actuales = Array.isArray(ganadoresAUsar[tipo.key]) ? ganadoresAUsar[tipo.key].length : 0;
            return actuales < tipo.cantidad;
        });
        const nombreSorteo = (
            (typeof config?.obtenerNombreSorteo === 'function' ? config.obtenerNombreSorteo() : '') ||
            config?.rifa?.nombreSorteo ||
            sorteo?.nombre ||
            'Sorteo finalizado'
        );
        const nombreOrganizador = (
            (typeof config?.cliente?.nombre === 'string' && config.cliente.nombre.trim()) ||
            'SORTEO'
        );
        const seccionesGanadores = [
            this.generarSeccionGanadores('principal', ganadoresAUsar),
            this.generarSeccionGanadores('presorte', ganadoresAUsar),
            this.generarSeccionGanadores('ruletazo', ganadoresAUsar)
        ].filter(Boolean).join('');

        return `
            <div class="modal-sorteo-finalizado">
                <!-- CONFETI DE FONDO -->
                <canvas id="confeti-canvas" class="confeti-canvas"></canvas>

                <!-- CONTENIDO PRINCIPAL -->
                <div class="sorteo-finalizado-content">
                    
                    <!-- HEADER CON LOGO -->
                    <div class="sorteo-header">
                        <div class="sorteo-logo-container">
                            <img src="${config.cliente.logo}" alt="${config.cliente.nombre}" class="sorteo-logo">
                        </div>
                        <h1 class="sorteo-titulo">SORTEO FINALIZADO</h1>
                    </div>

                    <!-- INFORMACIÓN DEL SORTEO -->
                    <div class="sorteo-info-principal">
                        <h2 class="sorteo-nombre">${nombreSorteo}</h2>
                        <p class="sorteo-organizador">Organizado por <strong>${nombreOrganizador}</strong></p>
                        <p class="sorteo-fecha-cierre">Finalizado: ${sorteo.fechaCierreFormato || new Date(sorteo.fechaCierre).toLocaleString('es-MX', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</p>
                    </div>

                    <!-- MENSAJE DE AGRADECIMIENTO -->
                    <div class="sorteo-agradecimiento">
                        <p>${sorteo.mensajeAgradecimiento}</p>
                    </div>

                    ${faltanGanadoresPorPublicar ? `
                        <div class="sorteo-estado-pendiente">
                            <p>El sorteo ya finalizó. Aún estamos completando la publicación oficial de todos los ganadores configurados.</p>
                        </div>
                    ` : ''}

                    ${seccionesGanadores}

                    <!-- REDES SOCIALES -->
                    ${this.generarSeccionRedes(config)}

                    <!-- BOTONES DE ACCIÓN -->
                            <div class="sorteo-acciones">
                                <a id="btnVerMisBoletos" class="btn btn-verificar" href="mis-boletos-restringido.html">
                                    <span>VERIFICAR MIS BOLETOS</span>
                                    <span class="btn-verificar-arrow" aria-hidden="true">→</span>
                                </a>
                        ${sorteo.documentos.actaURL ? `
                            <a href="${sorteo.documentos.actaURL}" download class="btn btn-descargar">
                                <i class="fas fa-download"></i> Descargar Acta
                            </a>
                        ` : ''}
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * Genera la sección de ganadores - IDÉNTICO AL INDEX.HTML
     */
    generarSeccionGanadores(tipo, ganadores) {
        const colorPaleta = {
            'principal': {
                color: 'var(--modal-primary)',
                headerColor1: 'var(--modal-primary)',
                headerColor2: 'var(--modal-primary-dark)',
                titulo: 'GANADORES DEL SORTEO',
                icono: ''
            },
            'presorte': {
                color: 'var(--modal-primary)',
                headerColor1: 'var(--modal-primary)',
                headerColor2: 'var(--modal-primary-dark)',
                titulo: 'GANADORES DEL PRESORTEO',
                icono: ''
            },
            'ruletazo': {
                color: 'var(--modal-primary)',
                headerColor1: 'var(--modal-primary)',
                headerColor2: 'var(--modal-primary-dark)',
                titulo: 'GANADORES DE RULETAZOS',
                icono: ''
            }
        };

        const tiposMap = {
            'principal': 'sorteo',
            'presorte': 'presorteo',
            'ruletazo': 'ruletazos'
        };

        const listaGanadores = ganadores[tiposMap[tipo]] || [];
        
        if (!listaGanadores || listaGanadores.length === 0) {
            return '';
        }

        const paleta = colorPaleta[tipo] || colorPaleta.principal;
        
        // Ordenar por lugarGanado
        let ganadoresOrdenados = [...listaGanadores].sort((a, b) => {
            const lugarA = Number(a.lugarGanado || a.posicion) || 999;
            const lugarB = Number(b.lugarGanado || b.posicion) || 999;
            return lugarA - lugarB;
        });

        let html = `
            <div class="sorteo-seccion">
                <div class="sorteo-seccion-header" style="--ganadores-header-start: ${paleta.headerColor1}; --ganadores-header-end: ${paleta.headerColor2};">
                    <h3 class="sorteo-seccion-heading">
                        <span>${paleta.titulo}</span>
                        <span class="sorteo-seccion-badge">${ganadoresOrdenados.length}</span>
                    </h3>
                </div>
                <div class="sorteo-ganadores-lista sorteo-ganadores-lista--${Math.min(ganadoresOrdenados.length, 3)}">
        `;

        ganadoresOrdenados.forEach((ganador, idx) => {
            const nombreCompleto = [
                ganador.nombre_ganador,
                ganador.nombre_cliente,
                ganador.apellido_cliente
            ].filter(Boolean).join(' ').trim() || ganador.nombre || 'Ganador confirmado';

            const estado = (ganador.estado_cliente || '').trim();
            const metaPartes = [estado].filter(Boolean);
            const numeroGanador = ganador.numero_boleto || ganador.numero || ganador.numero_orden || '';
            const numeroFormateado = numeroGanador !== ''
                ? this.formatearNumero(numeroGanador)
                : 'N/A';

            // Formatear fecha
            let fechaFormato = '';
            const fechaFuente = ganador.fechaRegistro || ganador.fecha_sorteo || ganador.created_at;
            if (fechaFuente) {
                try {
                    const fecha = new Date(fechaFuente);
                    if (!isNaN(fecha.getTime())) {
                        fechaFormato = fecha.toLocaleDateString('es-ES', { 
                            year: 'numeric', 
                            month: '2-digit', 
                            day: '2-digit' 
                        });
                    }
                } catch (e) {
                    console.warn('Error formateando fecha:', e);
                }
            }

            // Lugar / etiqueta
            const lugarNumero = ganador.lugarGanado || ganador.posicion || (idx + 1);
            const lugarTexto = (tipo === 'principal') ? this.getNombrePosicion(lugarNumero) : (tipo === 'presorte' ? `Lugar ${lugarNumero}` : `Ruletazo ${lugarNumero}`);

            html += `
                <div class="tarjeta-ganador">
                    <div class="tarjeta-header">
                        <div class="tarjeta-numero"><span class="numero-caja">${numeroFormateado}</span></div>
                        <div class="tarjeta-lugar">${lugarTexto}</div>
                    </div>
                    <div class="tarjeta-body">
                        <div class="tarjeta-nombre">${nombreCompleto}</div>
                        ${metaPartes.length > 0 ? `
                            <div class="tarjeta-meta">
                                ${metaPartes.map((parte) => `<span>${parte}</span>`).join('<span>·</span>')}
                            </div>
                        ` : ''}
                    </div>
                    ${fechaFormato ? `<div class="tarjeta-fecha">${fechaFormato}</div>` : ''}
                </div>
            `;
        });

        html += `
                </div>
            </div>
        `;

        return html;
    }

    /**
     * Obtiene el nombre de la posición
     */
    getNombrePosicion(posicion) {
        const nombres = {
            1: '1° LUGAR',
            2: '2° LUGAR',
            3: '3° LUGAR',
            4: '4° LUGAR',
            5: '5° LUGAR'
        };
        return nombres[posicion] || `${posicion}° LUGAR`;
    }

    /**
     * Genera estadísticas
     */
    generarSeccionEstadisticas(sorteo) {
        const stats = sorteo.estadisticas;
        return `
            <div class="sorteo-seccion">
                <h3 class="sorteo-seccion-titulo">ESTADÍSTICAS DEL SORTEO</h3>
                <div class="sorteo-stats-grid">
                    <div class="stat-item">
                        <div class="stat-label">Boletos Totales</div>
                        <div class="stat-value">${this.formatearNumero(stats.totalBoletos)}</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-label">Vendidos</div>
                        <div class="stat-value">${this.formatearNumero(stats.totalVendidos)}</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-label">Participantes</div>
                        <div class="stat-value">${this.formatearNumero(stats.participantes)}</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-label">Recaudación</div>
                        <div class="stat-value">$${this.formatearMoneda(stats.recaudacion)}</div>
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * Genera sección de transparencia
     */
    generarSeccionTransparencia(sorteo) {
        const docs = sorteo.documentos;
        return `
            <div class="sorteo-seccion">
                <h3 class="sorteo-seccion-titulo">TRANSPARENCIA Y VERIFICACIÓN</h3>
                <div class="sorteo-transparencia">
                    <p class="transparencia-texto">✓ ${docs.certificado}</p>
                    ${docs.videoURL ? `
                        <a href="${docs.videoURL}" target="_blank" class="btn btn-small">
                            <i class="fas fa-video"></i> Ver Transmisión en Vivo
                        </a>
                    ` : ''}
                </div>
            </div>
        `;
    }

    /**
     * Obtener ganadores reales desde GanadoresManager, snapshot o localStorage
     * Retorna objeto con claves: principal, presorte, ruletazo
     * 
     * ⚠️ CRÍTICO: Para rifas DEPURADAS, usar SIEMPRE el snapshot_final
     * ya que la tabla 'ganadores' fue vaciada durante la depuración.
     */
    async obtenerGanadoresReales(snapshot = null, config = window.rifaplusConfig || {}) {
        try {
            this.log('🔍 Intentando obtener ganadores...', 'info');

            // ✅ PRIORIDAD 1: Si GanadoresManager está disponible y tiene datos, USARLO
            // Esto es CRÍTICO para rifas depuradas donde el snapshot no se cargó en config
            if (window.GanadoresManager) {
                const ganadoresLocal = window.GanadoresManager.cargarGanadores();
                if (ganadoresLocal && (ganadoresLocal.sorteo?.length > 0 || ganadoresLocal.presorteo?.length > 0 || ganadoresLocal.ruletazos?.length > 0)) {
                    this.log('✅ Usando GanadoresManager como fuente de ganadores', 'exito');
                    return {
                        sorteo: ganadoresLocal.sorteo || [],
                        presorteo: ganadoresLocal.presorteo || [],
                        ruletazos: ganadoresLocal.ruletazos || []
                    };
                }
            }

            // PRIORIDAD 2: Para rifas NO depuradas, intentar fuente de verdad: servidor
            const rifaEstado = String(config?.rifa?.estado || config?.sorteo?.estado || '').toLowerCase();
            const esRifaDepurada = rifaEstado === 'depurada';
            
            if (!esRifaDepurada) {
                try {
                    const apiBase = window.rifaplusConfig?.backend?.apiBase
                        || window.rifaplusConfig?.obtenerApiBase?.()
                        || window.location.origin;
                    const resp = await fetch(`${apiBase}/api/ganadores?limit=500`);
                    if (resp.ok) {
                        const payload = await resp.json();
                        const rows = payload && payload.data ? payload.data : [];
                        if (Array.isArray(rows) && rows.length > 0) {
                            this.log('✅ Ganadores obtenidos desde servidor', 'exito');
                            // Mapear a estructura esperada
                            const mapped = { sorteo: [], presorteo: [], ruletazos: [] };
                            rows.forEach((r, idx) => {
                                const tipoRaw = (r.tipo_ganador || '').toString().toLowerCase();
                                let key = 'sorteo';
                                if (tipoRaw.includes('presorte')) key = 'presorteo';
                                else if (tipoRaw.includes('rulet')) key = 'ruletazos';
                                mapped[key].push({
                                    numero: String(r.numero_boleto || r.numero_orden || ''),
                                    numero_boleto: r.numero_boleto,
                                    numero_orden: r.numero_orden,
                                    posicion: r.posicion || (idx + 1),
                                    nombre_ganador: r.nombre_ganador || '',
                                    nombre_cliente: r.nombre_cliente || '',
                                    apellido_cliente: r.apellido_cliente || '',
                                    ciudad: r.ciudad || '',
                                    ciudad_cliente: r.ciudad_cliente || '',
                                    estado_cliente: r.estado_cliente || '',
                                    fecha_sorteo: r.fecha_sorteo || '',
                                    created_at: r.created_at || ''
                                });
                            });
                            Object.keys(mapped).forEach((key) => {
                                mapped[key].sort((a, b) => (Number(a.posicion) || 999) - (Number(b.posicion) || 999));
                            });

                            return mapped;
                        }
                    }
                } catch (e) {
                    this.log('⚠️ Error al consultar /api/ganadores: ' + (e && e.message), 'warning');
                }
            }

            // PRIORIDAD 3: Fallback al snapshot
            if (snapshot?.ganadores && await this.snapshotCorrespondeARifaActual(snapshot, config)) {
                this.log('ℹ️ Usando snapshot persistido de ganadores', 'info');
                return {
                    sorteo: snapshot.ganadores.sorteo || [],
                    presorteo: snapshot.ganadores.presorteo || [],
                    ruletazos: snapshot.ganadores.ruletazos || []
                };
            }

            this.log('ℹ️ Sin ganadores oficiales para la rifa actual; se mostrará estado pendiente', 'info');
            return { sorteo: [], presorteo: [], ruletazos: [] };

        } catch (error) {
            this.log('❌ Error obteniendo ganadores: ' + error.message, 'error');
            return { sorteo: [], presorteo: [], ruletazos: [] };
        }
    }

    /**
     * Genera redes sociales
     */
    generarSeccionRedes(config) {
        const redes = config?.cliente?.redesSociales || {};
        const redesDisponibles = [
            redes.facebook ? {
                href: redes.facebook,
                clase: 'facebook',
                titulo: 'Facebook',
                icono: 'fab fa-facebook-f',
                texto: 'Facebook'
            } : null,
            redes.instagram ? {
                href: redes.instagram,
                clase: 'instagram',
                titulo: 'Instagram',
                icono: 'fab fa-instagram',
                texto: 'Instagram'
            } : null,
            redes.tiktok ? {
                href: redes.tiktok,
                clase: 'tiktok',
                titulo: 'TikTok',
                icono: 'fab fa-tiktok',
                texto: 'TikTok'
            } : null,
            redes.canalWhatsapp ? {
                href: redes.canalWhatsapp,
                clase: 'whatsapp',
                titulo: 'Canal de WhatsApp',
                icono: 'fab fa-whatsapp',
                texto: 'Canal WhatsApp'
            } : null
        ].filter(Boolean);

        if (redesDisponibles.length === 0) {
            return '';
        }

        let html = `
            <div class="sorteo-seccion">
                <p class="sorteo-redes-mensaje">Felicidades a todos los ganadores. Síguenos en nuestras redes sociales para ver la transmisión en vivo del sorteo y mantenerte al tanto de futuros sorteos. Gracias por la confianza.</p>
                <div class="sorteo-redes">
        `;

        redesDisponibles.forEach((red) => {
            html += `
                <a href="${red.href}" target="_blank" rel="noopener noreferrer" class="red-btn ${red.clase}" title="${red.titulo}">
                    <i class="${red.icono}"></i> ${red.texto}
                </a>
            `;
        });

        html += `</div></div>`;
        return html;
    }

    /**
     * Configura event listeners
     */
    navegarAMisBoletosRestringido() {
        try {
            sessionStorage.setItem('rifaplus_modal_suppressed_until', String(Date.now() + 10000));
            sessionStorage.setItem('rifaplus_allow_restricted', '1');
        } catch (err) {
            console.warn('No se pudo setear suppression/allow en sessionStorage', err);
        }

        const overlay = document.getElementById('modalSorteoFinalizadoOverlay');
        if (overlay && overlay.parentNode) {
            overlay.parentNode.removeChild(overlay);
        }

        this.desactivarModoRestringido();
        window.rifaplusModalScrollLock?.sync?.();

        this.log('Redirigiendo a mis-boletos-restringido.html (supresión activa)', 'navegacion');
        window.location.href = 'mis-boletos-restringido.html';
    }

    configurarEventListeners() {
        try {
            const overlay = document.getElementById('modalSorteoFinalizadoOverlay');
            if (overlay) {
                const btnVerMisBoletos = overlay.querySelector('#btnVerMisBoletos');

                if (btnVerMisBoletos) {
                    btnVerMisBoletos.addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        this.navegarAMisBoletosRestringido();
                    }, { once: true });
                }

                overlay.addEventListener('click', (e) => {
                    const btn = e.target.closest && e.target.closest('#btnVerMisBoletos');
                    if (btn) {
                        e.preventDefault();
                        e.stopPropagation();
                        this.navegarAMisBoletosRestringido();
                    }
                });
            }
        } catch (error) {
            this.log(`Error en configurarEventListeners: ${error.message}`, 'error');
        }
    }

    /**
     * Muestra confeti
     */
    mostrarConfeti() {
        try {
            const canvas = document.getElementById('confeti-canvas');
            if (!canvas) return;

            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;

            const ctx = canvas.getContext('2d');
            const confetis = [];

            for (let i = 0; i < 100; i++) {
                confetis.push({
                    x: Math.random() * canvas.width,
                    y: Math.random() * canvas.height - canvas.height,
                    velocityX: (Math.random() - 0.5) * 8,
                    velocityY: Math.random() * 5 + 5,
                    size: Math.random() * 5 + 2,
                    color: ['#e8553b', '#0F3A7D', '#10B981', '#F59E0B', '#8B5CF6'][
                        Math.floor(Math.random() * 5)
                    ]
                });
            }

            const animate = () => {
                ctx.clearRect(0, 0, canvas.width, canvas.height);

                confetis.forEach((conf) => {
                    conf.y += conf.velocityY;
                    conf.x += conf.velocityX;
                    conf.velocityY += 0.2;

                    ctx.fillStyle = conf.color;
                    ctx.fillRect(conf.x, conf.y, conf.size, conf.size);
                });

                if (confetis.some(c => c.y < canvas.height)) {
                    requestAnimationFrame(animate);
                }
            };

            animate();
        } catch (error) {
            this.log(`Error en mostrarConfeti: ${error.message}`, 'error');
        }
    }

    /**
     * Bloquea navegación
     */
    bloquearNavegacion() {
        try {
            if (this.navegacionBloqueada) return;

            document.addEventListener('click', (e) => {
                if (!this.modalCreado) return;

                const target = e.target.closest('a');
                if (!target) return;

                const href = target.getAttribute('href');
                
                if (href && !href.includes('mis-boletos') && 
                    !href.includes('facebook') && 
                    !href.includes('instagram') && 
                    !href.includes('whatsapp') &&
                    !href.includes('youtube') &&
                    !href.includes('.pdf') &&
                    !href.startsWith('#')) {
                    
                    e.preventDefault();
                    e.stopPropagation();
                    
                    const modal = document.getElementById('modalSorteoFinalizadoOverlay');
                    if (modal) {
                        const alerta = document.createElement('div');
                        alerta.className = 'sorteo-alerta';
                        alerta.innerHTML = `
                            <div class="alerta-contenido">
                                <p>Durante el cierre del sorteo solo puedes acceder a <strong>"Mis Boletos"</strong></p>
                                <button class="btn btn-small" onclick="this.parentElement.parentElement.remove()">Entendido</button>
                            </div>
                        `;
                        modal.appendChild(alerta);
                        
                        setTimeout(() => alerta.remove(), 4000);
                    }
                }
            }, true);

            this.navegacionBloqueada = true;
        } catch (error) {
            this.log(`Error en bloquearNavegacion: ${error.message}`, 'error');
        }
    }

    activarModoRestringido() {
        try {
            document.body.classList.add('sorteo-finalizado-activo');

            document.querySelectorAll('.nav-link, .overlay-link').forEach((link) => {
                const href = (link.getAttribute('href') || '').toLowerCase();
                const permiteMisBoletos = href.includes('mis-boletos');

                if (!permiteMisBoletos) {
                    link.classList.add('link-restringido');
                    link.setAttribute('aria-disabled', 'true');
                    link.setAttribute('tabindex', '-1');
                    link.dataset.restrictedByFinalized = 'true';
                }
            });

            const carritoNav = document.getElementById('carritoNav');
            if (carritoNav) {
                carritoNav.classList.add('carrito-restringido');
                carritoNav.setAttribute('aria-disabled', 'true');
                carritoNav.dataset.restrictedByFinalized = 'true';
            }
        } catch (error) {
            this.log(`Error en activarModoRestringido: ${error.message}`, 'error');
        }
    }

    desactivarModoRestringido() {
        try {
            document.body.classList.remove('sorteo-finalizado-activo');

            document.querySelectorAll('[data-restricted-by-finalized="true"]').forEach((element) => {
                element.classList.remove('link-restringido', 'carrito-restringido');
                element.removeAttribute('aria-disabled');
                element.removeAttribute('tabindex');
                delete element.dataset.restrictedByFinalized;
            });
        } catch (error) {
            this.log(`Error en desactivarModoRestringido: ${error.message}`, 'error');
        }
    }

    /**
     * Utilidades
     */
    formatearNumero(num) {
        return num.toLocaleString('es-MX');
    }

    formatearMoneda(num) {
        return num.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    /**
     * Sistema de logging robusto
     */
    log(mensaje, tipo = 'info') {
        if (!this.logEnabled) return;

        const timestamp = new Date().toLocaleTimeString('es-MX');
        const prefijo = {
            'info': 'ℹ️',
            'exito': '✅',
            'error': '❌',
            'warning': '⚠️',
            'constructor': '🎉',
            'inicializar': '🚀',
            'estado': '📊',
            'hora': '⏰',
            'fecha': '📅',
            'tiempo': '⏱️',
            'verificacion': '🔍',
            'actualizacion': '🔄',
            'cambio': '⚡',
            'modal': '🎭',
            'navegacion': '🔗'
        }[tipo] || '•';

        console.log(`[${timestamp}] ${prefijo} [SorteoFinalizado] ${mensaje}`);
    }

    /**
     * Inyecta CSS
     */
    inyectarCSS() {
        if (document.getElementById('modal-sorteo-finalizado-css')) return;

        const style = document.createElement('style');
        style.id = 'modal-sorteo-finalizado-css';
        style.textContent = `
            /* ===== MODAL SORTEO FINALIZADO ===== */
            
            .modal-sorteo-overlay {
                --modal-primary: var(--primary, #0F3A7D);
                --modal-primary-dark: var(--primary-dark, #082860);
                --modal-secondary: var(--secondary, #e8553b);
                --modal-secondary-dark: var(--secondary-dark, #D64520);
                --modal-surface: var(--surface, #f7f9fc);
                --modal-surface-accent: var(--surface-accent, #eef3f9);
                --modal-text: var(--text-dark, #1F2937);
                --modal-text-muted: var(--text-muted, #6B7280);
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background:
                    radial-gradient(circle at top, rgba(255, 255, 255, 0.2), transparent 38%),
                    linear-gradient(135deg, color-mix(in srgb, var(--modal-primary) 32%, transparent) 0%, color-mix(in srgb, var(--modal-primary-dark) 42%, transparent) 100%);
                backdrop-filter: blur(6px);
                z-index: 9999;
                display: flex;
                align-items: center;
                justify-content: center;
                overflow-x: hidden;
                overflow-y: auto;
                overscroll-behavior: contain;
                -webkit-overflow-scrolling: touch;
                padding:
                    max(24px, env(safe-area-inset-top))
                    max(16px, env(safe-area-inset-right))
                    max(24px, env(safe-area-inset-bottom))
                    max(16px, env(safe-area-inset-left));
                opacity: 0;
                transition: opacity 0.3s ease;
            }

            .modal-sorteo-overlay.modal-visible {
                opacity: 1;
            }

            .confeti-canvas {
                position: absolute;
                top: 0;
                left: 0;
                pointer-events: none;
            }

            .modal-sorteo-finalizado {
                position: relative;
                width: min(100%, 860px);
                max-width: 860px;
                max-height: min(90dvh, 920px);
                background: white;
                border-radius: 28px;
                box-shadow: 0 28px 80px rgba(0, 0, 0, 0.32);
                border: 1px solid rgba(255, 255, 255, 0.26);
                display: flex;
                flex-direction: column;
                animation: slideUp 0.6s cubic-bezier(0.34, 1.56, 0.64, 1);
                overflow: hidden;
                margin: auto;
            }

            @keyframes slideUp {
                from {
                    transform: translateY(100px);
                    opacity: 0;
                }
                to {
                    transform: translateY(0);
                    opacity: 1;
                }
            }

            .sorteo-finalizado-content {
                display: flex;
                flex-direction: column;
                height: 100%;
                min-height: 0;
                overflow-y: auto;
                overflow-x: hidden;
                scroll-behavior: smooth;
                background: linear-gradient(180deg, #ffffff 0%, var(--modal-surface) 100%);
                scrollbar-width: thin;
                scrollbar-color: color-mix(in srgb, var(--modal-primary) 45%, white) transparent;
                overscroll-behavior: contain;
                -webkit-overflow-scrolling: touch;
                scrollbar-gutter: stable;
            }

            .sorteo-header {
                text-align: center;
                padding: 28px 24px 20px;
                background:
                    radial-gradient(circle at top, rgba(255, 255, 255, 0.12), transparent 38%),
                    linear-gradient(135deg, var(--modal-primary) 0%, var(--modal-primary-dark) 100%);
                color: white;
                border-radius: 28px 28px 0 0;
                flex-shrink: 0;
                position: relative;
            }

            .sorteo-logo-container {
                margin-bottom: 12px;
            }

            .sorteo-logo {
                max-width: 92px;
                height: auto;
                filter: drop-shadow(0 10px 24px rgba(0, 0, 0, 0.22));
            }

            .sorteo-titulo {
                font-size: 2rem;
                font-weight: 800;
                letter-spacing: 0.04em;
                margin: 0;
                text-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
            }

            .sorteo-info-principal {
                text-align: center;
                padding: 20px 24px 18px;
                background: linear-gradient(180deg, #ffffff 0%, #f7f9fc 100%);
                border-bottom: 1px solid #e5e7eb;
                flex-shrink: 0;
            }

            .sorteo-nombre {
                font-size: 1.4rem;
                margin: 0 0 8px 0;
                color: var(--modal-text);
                font-weight: 800;
            }

            .sorteo-organizador {
                color: var(--modal-text-muted);
                margin: 4px 0;
                font-size: 0.98rem;
                letter-spacing: 0.01em;
                line-height: 1.45;
            }

            .sorteo-organizador strong {
                color: var(--modal-primary);
                font-weight: 800;
            }

            .sorteo-fecha-cierre {
                color: var(--modal-secondary);
                font-weight: 700;
                margin: 4px 0 0 0;
                font-size: 0.95rem;
            }

            .sorteo-agradecimiento {
                margin: 18px 24px 4px;
                padding: 14px 16px;
                background: linear-gradient(135deg, #fff7db 0%, #fff1c2 100%);
                border: 1px solid #f4d46b;
                border-left: 4px solid #FCD34D;
                border-radius: 16px;
                text-align: center;
                color: #856404;
                font-size: 0.94rem;
                line-height: 1.6;
                flex-shrink: 0;
            }

            .sorteo-estado-pendiente {
                margin: 10px 24px 0;
                padding: 14px 16px;
                border-radius: 16px;
                background: linear-gradient(180deg, color-mix(in srgb, var(--modal-primary) 10%, white) 0%, #f8fbff 100%);
                border: 1px solid color-mix(in srgb, var(--modal-primary) 22%, white);
                color: color-mix(in srgb, var(--modal-primary-dark) 70%, #1f2937);
                text-align: center;
                font-size: 0.92rem;
                line-height: 1.55;
            }

            .sorteo-estado-pendiente p {
                margin: 0;
            }

            .sorteo-scroll-container {
                display: contents;
            }

            .sorteo-scroll-container::-webkit-scrollbar {
                width: 8px;
            }

            .sorteo-scroll-container::-webkit-scrollbar-track {
                background: #f0f0f0;
            }

            .sorteo-scroll-container::-webkit-scrollbar-thumb {
                background: var(--modal-primary);
                border-radius: 4px;
            }

            .sorteo-seccion {
                margin: 18px 0;
                padding: 0 24px;
            }

            .sorteo-seccion-header {
                background: linear-gradient(135deg, var(--ganadores-header-start, var(--modal-primary)) 0%, var(--ganadores-header-end, var(--modal-primary-dark)) 100%);
                padding: 10px 14px;
                border-radius: 14px;
                color: #ffffff;
                margin-bottom: 10px;
                box-shadow: 0 12px 24px rgba(var(--primary-rgb, 15, 58, 125), 0.16);
            }

            .sorteo-seccion-heading {
                margin: 0;
                font-size: 0.98rem;
                font-weight: 700;
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 12px;
            }

            .sorteo-seccion-badge {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                min-width: 32px;
                padding: 4px 10px;
                border-radius: 999px;
                background: rgba(255, 255, 255, 0.18);
                color: #ffffff;
                font-size: 0.78rem;
                font-weight: 800;
                line-height: 1;
                box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.14);
            }

            .sorteo-seccion-titulo {
                font-size: 1.02rem;
                color: var(--modal-primary);
                margin: 0 0 10px 0;
                padding-bottom: 8px;
                border-bottom: 2px solid #e5e7eb;
                font-weight: 800;
                letter-spacing: 0.01em;
            }

            .sorteo-ganadores-lista {
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
                gap: 12px;
            }

            .sorteo-ganadores-lista--1 {
                grid-template-columns: minmax(280px, 420px);
                justify-content: center;
            }

            .sorteo-ganadores-lista--2 {
                grid-template-columns: repeat(2, minmax(240px, 320px));
                justify-content: center;
            }

            .sorteo-ganadores-lista--3 {
                grid-template-columns: repeat(3, minmax(200px, 1fr));
            }

            .sorteo-ganador-card {
                background: linear-gradient(135deg, #f8f9fa 0%, #f0f0f0 100%);
                border: 1px solid #e5e7eb;
                border-radius: 8px;
                padding: 8px;
                text-align: center;
                transition: transform 0.12s, box-shadow 0.12s;
                font-size: 0.85rem;
            }

            .sorteo-ganador-card:hover {
                transform: translateY(-2px);
                box-shadow: 0 8px 16px rgba(0, 0, 0, 0.1);
            }

            .ganador-medalla {
                font-size: 1.4rem;
                margin-bottom: 4px;
            }

            .ganador-posicion {
                font-size: 0.9rem;
                font-weight: 700;
                color: #0F3A7D;
                margin-bottom: 4px;
            }

            /* Tarjeta compacta nueva */
            .tarjeta-ganador {
                background: linear-gradient(180deg, #ffffff 0%, color-mix(in srgb, var(--modal-primary) 4%, white) 100%);
                border: 1px solid #dbe3ef;
                border-radius: 18px;
                padding: 14px;
                display: flex;
                flex-direction: column;
                gap: 10px;
                min-height: 132px;
                box-sizing: border-box;
                box-shadow: 0 12px 26px rgba(15, 23, 42, 0.07);
            }

            .tarjeta-header { display:flex; justify-content:space-between; align-items:center; }
            .tarjeta-numero { font-weight:700; color: var(--ganador-color, var(--modal-primary)); font-size:0.98rem; }
            .tarjeta-lugar { font-size:0.82rem; color:var(--modal-text-muted); font-weight:600; }
            .tarjeta-nombre { font-weight:800; font-size:0.98rem; color:var(--modal-text); line-height:1.38; }
            .tarjeta-meta { color:var(--modal-text-muted); font-size:0.82rem; display:flex; gap:6px; flex-wrap:wrap; line-height:1.45; }
            .tarjeta-fecha { color:#9CA3AF; font-size:0.78rem; text-align:right; margin-top:auto; }

            .ganador-divider {
                height: 2px;
                background: #e8553b;
                margin: 5px 0;
            }

            .ganador-premio {
                font-size: 0.95rem;
                font-weight: 600;
                color: #1F2937;
                margin-bottom: 4px;
            }

            .ganador-numero {
                color: #6B7280;
                font-size: 0.8rem;
                margin-bottom: 6px;
            }

            .ganador-numero strong {
                color: var(--modal-primary);
                font-weight: 700;
            }

            .ganador-persona {
                background: white;
                padding: 6px;
                border-radius: 6px;
                margin-top: 5px;
            }

            .ganador-nombre {
                font-size: 0.9rem;
                font-weight: 600;
                color: var(--modal-primary);
            }

            .ganador-ubicacion {
                color: #6B7280;
                font-size: 0.75rem;
                margin-top: 3px;
            }

            .sorteo-ganador-simple {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 8px;
                background: white;
                border: 1px solid #e5e7eb;
                border-radius: 6px;
                font-size: 0.85rem;
            }

            .simple-numero strong {
                color: #0F3A7D;
                font-weight: 700;
            }

            .simple-premio {
                color: #e8553b;
                font-weight: 600;
            }

            .sorteo-stats-grid {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 8px;
                padding: 0 15px;
                margin: 8px 0;
            }

            .stat-item {
                background: white;
                border: 1px solid #e5e7eb;
                border-radius: 6px;
                padding: 10px;
                text-align: center;
            }

            .stat-label {
                color: #6B7280;
                font-size: 0.75rem;
                margin-bottom: 3px;
            }

            .stat-value {
                font-size: 1rem;
                font-weight: 700;
                color: #0F3A7D;
            }

            .sorteo-transparencia {
                background: white;
                border: 1px solid #10B981;
                border-radius: 6px;
                padding: 10px;
                text-align: center;
                margin: 8px 15px;
            }

            .transparencia-texto {
                color: #10B981;
                font-weight: 600;
                margin: 0 0 8px 0;
                font-size: 0.9rem;
            }

            .sorteo-redes-mensaje {
                text-align: center;
                color: var(--modal-text);
                font-size: 0.96rem;
                margin: 6px 24px 4px;
                line-height: 1.55;
                font-weight: 700;
            }

            .sorteo-redes {
                display: flex;
                gap: 10px;
                justify-content: center;
                flex-wrap: wrap;
                padding: 0 24px;
                margin: 10px 0 0;
            }

            .red-btn {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                padding: 9px 14px;
                border-radius: 999px;
                font-size: 0.84rem;
                font-weight: 600;
                text-decoration: none;
                transition: transform 0.2s, box-shadow 0.2s, opacity 0.2s;
                color: white;
            }

            .red-btn:hover {
                transform: translateY(-2px);
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
            }

            .red-btn.whatsapp { background: #25D366; }
            .red-btn.facebook { background: #1877F2; }
            .red-btn.instagram { background: linear-gradient(45deg, #feda75 0%, #fa7e1e 20%, #d62976 40%, #962fbf 60%, #4f5bd5 80%); }
            .red-btn.tiktok { background: linear-gradient(135deg, #111111 0%, #2f2f2f 100%); }

            /* Número en recuadro dentro de la tarjeta de ganador */
            .numero-caja {
                display: inline-block;
                background: var(--ganador-color, var(--modal-primary));
                color: #ffffff;
                padding: 7px 11px;
                border-radius: 10px;
                font-weight: 700;
                font-size: 0.95rem;
                line-height: 1;
                box-shadow: 0 10px 16px color-mix(in srgb, var(--modal-primary) 22%, transparent);
            }

            .sorteo-acciones {
                padding: 18px 24px 22px;
                background: linear-gradient(180deg, #f8fafc 0%, var(--modal-surface-accent) 100%);
                border-top: 1px solid #dde5f0;
                display: flex;
                gap: 12px;
                flex-wrap: wrap;
                justify-content: center;
                border-radius: 0 0 28px 28px;
                flex-shrink: 0;
                position: relative;
                z-index: 2;
            }

            .btn-verificar {
                background: linear-gradient(135deg, var(--modal-secondary) 0%, var(--modal-secondary-dark) 100%);
                color: white;
                padding: 13px 18px;
                border: none;
                border-radius: 14px;
                font-weight: 700;
                font-size: 0.9rem;
                letter-spacing: 0.02em;
                cursor: pointer;
                transition: transform 0.2s, box-shadow 0.2s;
                flex: 1;
                min-width: 220px;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                gap: 10px;
                position: relative;
                z-index: 3;
                overflow: hidden;
                pointer-events: auto;
            }

            .btn-verificar:hover {
                transform: translateY(-2px);
                box-shadow: 0 8px 16px rgba(16, 185, 129, 0.3);
            }

            .btn-verificar-arrow {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                font-size: 1.02rem;
                line-height: 1;
                animation: btnVerificarArrowPulse 1.3s ease-in-out infinite;
            }

            @keyframes btnVerificarArrowPulse {
                0%, 100% {
                    transform: translateX(0);
                }
                50% {
                    transform: translateX(4px);
                }
            }

            .btn-descargar {
                background: white;
                color: var(--modal-primary);
                border: 1px solid #c8d3e2;
                padding: 12px 16px;
                border-radius: 14px;
                font-weight: 600;
                font-size: 0.88rem;
                text-decoration: none;
                cursor: pointer;
                transition: all 0.2s;
            }

            .btn-descargar:hover {
                background: var(--modal-primary);
                color: white;
            }

            .btn-small {
                display: inline-block;
                padding: 6px 12px;
                background: #0F3A7D;
                color: white;
                border: none;
                border-radius: 4px;
                font-size: 0.8rem;
                text-decoration: none;
                cursor: pointer;
                margin-top: 6px;
            }

            .sorteo-alerta {
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                background: white;
                padding: 24px;
                border-radius: 18px;
                box-shadow: 0 20px 48px rgba(0, 0, 0, 0.24);
                border: 1px solid #e5e7eb;
                z-index: 10000;
                animation: fadeInScale 0.3s ease;
                width: min(92vw, 420px);
            }

            @keyframes fadeInScale {
                from {
                    opacity: 0;
                    transform: translate(-50%, -50%) scale(0.9);
                }
                to {
                    opacity: 1;
                    transform: translate(-50%, -50%) scale(1);
                }
            }

            .alerta-contenido {
                text-align: center;
            }

            .alerta-contenido p {
                color: #1F2937;
                margin: 0 0 15px 0;
                font-size: 0.98rem;
                line-height: 1.55;
            }

            .alerta-contenido .btn-small {
                margin-top: 0;
            }

            body.sorteo-finalizado-activo .nav-link.link-restringido,
            body.sorteo-finalizado-activo .overlay-link.link-restringido {
                opacity: 0.42;
                filter: grayscale(0.35);
                pointer-events: none;
            }

            body.sorteo-finalizado-activo #carritoNav.carrito-restringido {
                opacity: 0.38;
                filter: grayscale(0.45);
                pointer-events: none;
            }

            @media (max-width: 768px) {
                .modal-sorteo-overlay {
                    align-items: center;
                    justify-content: center;
                    padding:
                        max(14px, env(safe-area-inset-top))
                        max(12px, env(safe-area-inset-right))
                        max(14px, env(safe-area-inset-bottom))
                        max(12px, env(safe-area-inset-left));
                }
                .modal-sorteo-finalizado {
                    width: 100%;
                    max-height: min(calc(100dvh - 28px), 860px);
                    border-radius: 24px;
                }
                .sorteo-finalizado-content {
                    overscroll-behavior: contain;
                }
                .sorteo-header {
                    padding: 22px 18px 16px;
                    border-radius: 24px 24px 0 0;
                }
                .sorteo-logo {
                    max-width: 78px;
                }
                .sorteo-titulo { font-size: 1.55rem; line-height: 1.05; }
                .sorteo-info-principal {
                    padding: 16px 18px 14px;
                }
                .sorteo-nombre { font-size: 1.12rem; line-height: 1.25; }
                .sorteo-organizador,
                .sorteo-fecha-cierre {
                    font-size: 0.9rem;
                }
                .sorteo-agradecimiento,
                .sorteo-estado-pendiente {
                    margin-left: 18px;
                    margin-right: 18px;
                    padding: 12px 14px;
                    border-radius: 14px;
                    font-size: 0.88rem;
                }
                .sorteo-seccion,
                .sorteo-acciones {
                    padding-left: 18px;
                    padding-right: 18px;
                }
                .sorteo-seccion {
                    margin: 16px 0;
                }
                .sorteo-seccion-titulo {
                    font-size: 0.96rem;
                    margin-bottom: 8px;
                    padding-bottom: 6px;
                }
                .sorteo-seccion-header {
                    padding: 9px 12px;
                    border-radius: 12px;
                    margin-bottom: 8px;
                }
                .sorteo-seccion-heading {
                    font-size: 0.9rem;
                    gap: 10px;
                }
                .sorteo-seccion-badge {
                    min-width: 28px;
                    padding: 4px 8px;
                    font-size: 0.74rem;
                }
                .sorteo-stats-grid { grid-template-columns: 1fr; }
                .sorteo-ganadores-lista {
                    grid-template-columns: 1fr;
                    gap: 10px;
                }
                .sorteo-ganadores-lista--1,
                .sorteo-ganadores-lista--2,
                .sorteo-ganadores-lista--3 {
                    grid-template-columns: 1fr;
                    justify-content: stretch;
                }
                .tarjeta-ganador {
                    min-height: 0;
                    padding: 12px;
                    border-radius: 16px;
                    gap: 8px;
                }
                .tarjeta-numero {
                    font-size: 0.93rem;
                }
                .tarjeta-lugar,
                .tarjeta-meta,
                .tarjeta-fecha {
                    font-size: 0.78rem;
                }
                .tarjeta-nombre {
                    font-size: 0.92rem;
                }
                .sorteo-redes-mensaje,
                .sorteo-redes { padding-left: 18px; padding-right: 18px; }
                .sorteo-redes-mensaje {
                    font-size: 0.9rem;
                    margin-top: 4px;
                }
                .sorteo-redes {
                    gap: 8px;
                }
                .red-btn {
                    flex: 1 1 calc(50% - 8px);
                    min-width: 135px;
                    justify-content: center;
                    padding: 10px 12px;
                    font-size: 0.82rem;
                }
                .sorteo-acciones {
                    flex-direction: column;
                    gap: 10px;
                    padding-top: 16px;
                    padding-bottom: 18px;
                }
                .btn-verificar,
                .btn-descargar {
                    width: 100%;
                    min-width: 0;
                    justify-content: center;
                    text-align: center;
                }
            }

            @media (max-width: 420px) {
                .modal-sorteo-overlay {
                    padding:
                        max(10px, env(safe-area-inset-top))
                        max(8px, env(safe-area-inset-right))
                        max(10px, env(safe-area-inset-bottom))
                        max(8px, env(safe-area-inset-left));
                }
                .modal-sorteo-finalizado {
                    max-height: min(calc(100dvh - 20px), 820px);
                    border-radius: 20px;
                }
                .sorteo-header {
                    padding: 18px 14px 14px;
                    border-radius: 20px 20px 0 0;
                }
                .sorteo-logo {
                    max-width: 68px;
                }
                .sorteo-titulo {
                    font-size: 1.34rem;
                }
                .sorteo-info-principal {
                    padding: 14px 14px 12px;
                }
                .sorteo-nombre {
                    font-size: 1.02rem;
                }
                .sorteo-organizador,
                .sorteo-fecha-cierre,
                .sorteo-agradecimiento,
                .sorteo-estado-pendiente,
                .sorteo-redes-mensaje {
                    font-size: 0.84rem;
                }
                .sorteo-seccion,
                .sorteo-acciones,
                .sorteo-redes {
                    padding-left: 14px;
                    padding-right: 14px;
                }
                .sorteo-agradecimiento,
                .sorteo-estado-pendiente {
                    margin-left: 14px;
                    margin-right: 14px;
                }
                .tarjeta-header {
                    gap: 8px;
                }
                .tarjeta-numero {
                    font-size: 0.9rem;
                }
                .tarjeta-lugar {
                    font-size: 0.74rem;
                }
                .tarjeta-nombre {
                    font-size: 0.88rem;
                }
                .tarjeta-meta,
                .tarjeta-fecha {
                    font-size: 0.74rem;
                }
                .red-btn {
                    flex-basis: 100%;
                    min-width: 0;
                }
                .btn-verificar,
                .btn-descargar {
                    padding: 12px 14px;
                    border-radius: 12px;
                    font-size: 0.84rem;
                }
            }
        `;

        document.head.appendChild(style);
    }
}

// ============================================================
// INSTANCIA GLOBAL Y EXPORTACIÓN
// ============================================================

const modalSorteoFinalizado = new ModalSorteoFinalizado();
window.ModalSorteoFinalizado = ModalSorteoFinalizado;
window.modalSorteoFinalizado = modalSorteoFinalizado;
