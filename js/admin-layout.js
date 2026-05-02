/* ================================================================ */
/* ARCHIVO: admin-layout.js                                         */
/* DESCRIPCIÓN: Lógica compartida para todas las páginas admin      */
/*              - Gestión de autenticación                          */
/*              - Menú lateral                                      */
/*              - Navegación entre páginas                          */
/* ================================================================ */

// 🚀 OPTIMIZACIÓN: Solo bloquear visibilidad si NO hay un token local
(function() {
    const token = localStorage.getItem('rifaplus_token') || 
                  localStorage.getItem('rifaplus_admin_token') ||
                  localStorage.getItem('admin_token') ||
                  localStorage.getItem('token');
    
    if (!token) {
        document.documentElement.classList.add('admin-auth-checking');
    } else {
        // Si hay token, permitimos visibilidad inmediata
        document.documentElement.classList.remove('admin-auth-checking');
    }
})();

function debugAdminLayout() {
    let enabled = window.RIFAPLUS_DEBUG_ADMIN === true;

    if (!enabled) {
        try {
            enabled = localStorage.getItem('rifaplus_debug_admin') === 'true';
        } catch (error) {
            enabled = false;
        }
    }

    if (enabled && typeof console !== 'undefined' && typeof console.debug === 'function') {
        console.debug('[AdminLayout]', ...arguments);
    }
}

const ADMIN_LAYOUT = {
    tokenKey: 'rifaplus_admin_token',
    activeRifaKey: 'rifaplus_admin_rifa_id',
    rifas: [],
    get apiUrl() {
        return window.rifaplusConfig?.backend?.apiBase
            || window.rifaplusConfig?.obtenerApiBase?.()
            || window.location.origin;
    },
    authPromise: null,

    get fallbackLogo() {
        return "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 240 96'%3E%3Crect width='240' height='96' rx='20' fill='%230b2235'/%3E%3Ctext x='120' y='58' font-size='34' text-anchor='middle' fill='%23ffffff' font-family='Arial,sans-serif'%3ESorteo%3C/text%3E%3C/svg%3E";
    },

    get publicBaseUrl() {
        const deployConfig = window.__RIFAPLUS_DEPLOY__ || {};
        const explicitPublicBase = String(deployConfig.publicBase || '').trim();
        if (explicitPublicBase) {
            return explicitPublicBase.replace(/\/+$/, '');
        }

        return window.location.origin.replace(/\/+$/, '');
    },

    normalizarMarcaAdmin(valor) {
        const texto = String(valor || '').trim();
        if (!texto) return '';
        if (/^aqu[ií]\s+va\b/i.test(texto)) return '';

        return texto
            .replace(/^sorteos?\s+/i, '')
            .replace(/\s+-\s+admin$/i, '')
            .trim();
    },

    obtenerMarcaAdmin(config) {
        const candidatos = [
            config?.cliente?.id,
            config?.cliente?.nombre,
            config?.cliente?.eslogan,
            'SaDev'
        ];

        for (const candidato of candidatos) {
            const marca = this.normalizarMarcaAdmin(candidato);
            if (marca) {
                return marca;
            }
        }

        return 'SaDev';
    },

    esPaginaLoginAdmin() {
        const rawPath = window.location.pathname || '';
        const paginaActual = rawPath.split('/').pop() || 'admin-dashboard.html';
        const paginaNormalizada = String(paginaActual).trim().toLowerCase();

        return paginaNormalizada === 'admin-dashboard.html'
            || paginaNormalizada === 'admin-dashboard';
    },
    
    /**
     * Inicializar el layout del admin
     * Debe llamarse en el evento load de cada página
     */
    init() {
        this.instalarFetchContextoRifa();
        // Verificar token
        this.authPromise = this.verificarAutenticacion();

        this.configurarViewportHeightSync();
        
        // Configurar logo
        this.configurarLogo();
        
        // Configurar botón logout
        this.configurarLogout();
        
        // Configurar menú sidebar
        this.configurarSidebar();
        this.configurarHeaderMobile();
        this.configurarHeaderHeightSync();
        
        // Establecer página activa en el menú
        this.establecerPaginaActiva();
        
        // ✅ ESCUCHAR cambios de configuración para actualizar header dinámicamente
        this.escucharCambiosConfig();
        this.cargarSelectorRifas().catch((error) => {
            debugAdminLayout('No se pudo cargar selector de rifas', error?.message || error);
        });
    },

    configurarViewportHeightSync() {
        if (this._viewportHeightSyncBound) {
            this.sincronizarViewportHeight();
            return;
        }

        this._viewportHeightSyncBound = true;
        this._syncViewportHeight = () => this.sincronizarViewportHeight();

        window.addEventListener('resize', this._syncViewportHeight, { passive: true });
        window.addEventListener('orientationchange', this._syncViewportHeight, { passive: true });
        window.addEventListener('pageshow', this._syncViewportHeight, { passive: true });

        requestAnimationFrame(() => this.sincronizarViewportHeight());
    },

    sincronizarViewportHeight() {
        const viewportHeight = Math.max(
            Math.ceil(window.innerHeight || 0),
            Math.ceil(document.documentElement?.clientHeight || 0),
            0
        );

        if (!viewportHeight) {
            return;
        }

        const siguienteValor = `${viewportHeight}px`;
        const valorActual = document.documentElement.style.getPropertyValue('--admin-viewport-height');

        if (valorActual !== siguienteValor) {
            document.documentElement.style.setProperty('--admin-viewport-height', siguienteValor);
            debugAdminLayout('Viewport height sincronizada', siguienteValor);
        }
    },

    configurarHeaderMobile() {
        if (this._headerMobileSyncBound) return;

        this._headerMobileSyncBound = true;
        this._syncHeaderMobile = () => this.sincronizarHeaderMobile();
        window.addEventListener('resize', this._syncHeaderMobile, { passive: true });
        this.sincronizarHeaderMobile();
    },

    configurarHeaderHeightSync() {
        if (this._headerHeightSyncBound) {
            this.sincronizarHeaderHeight();
            return;
        }

        this._headerHeightSyncBound = true;
        this._syncHeaderHeight = () => this.sincronizarHeaderHeight();

        window.addEventListener('resize', this._syncHeaderHeight, { passive: true });
        window.addEventListener('load', this._syncHeaderHeight, { once: true });

        if (typeof ResizeObserver !== 'undefined') {
            const header = document.querySelector('.admin-header');
            if (header) {
                this._headerResizeObserver = new ResizeObserver(() => {
                    if (this._headerHeightFrameId) {
                        cancelAnimationFrame(this._headerHeightFrameId);
                    }

                    this._headerHeightFrameId = requestAnimationFrame(() => {
                        this._headerHeightFrameId = 0;
                        this.sincronizarHeaderHeight();
                    });
                });
                this._headerResizeObserver.observe(header);
            }
        }

        requestAnimationFrame(() => this.sincronizarHeaderHeight());
    },

    sincronizarHeaderHeight() {
        const header = document.querySelector('.admin-header');
        if (!header) {
            return;
        }

        const measuredHeight = Math.max(
            Math.ceil(header.getBoundingClientRect().height || 0),
            Math.ceil(header.offsetHeight || 0),
            0
        );

        if (!measuredHeight) {
            return;
        }

        const valorActual = document.documentElement.style.getPropertyValue('--header-offset');
        const siguienteValor = `${measuredHeight}px`;

        if (valorActual !== siguienteValor) {
            document.documentElement.style.setProperty('--header-offset', siguienteValor);
            debugAdminLayout('Header height sincronizada', siguienteValor);
        }
    },

    sincronizarHeaderMobile() {
        const headerContent = document.querySelector('.admin-header-content');
        const headerRight = document.querySelector('.admin-header-right');
        const toggleBtn = document.querySelector('.admin-sidebar-toggle');
        const userInfo = document.getElementById('userInfoContainer');
        const logoutBtn = document.querySelector('.admin-logout-btn');

        if (!headerContent || !headerRight || !toggleBtn) {
            return;
        }

        const isMobile = window.matchMedia('(max-width: 900px)').matches;

        if (isMobile) {
            if (toggleBtn.parentElement !== headerRight) {
                if (userInfo && userInfo.parentElement === headerRight) {
                    headerRight.insertBefore(toggleBtn, userInfo);
                } else if (logoutBtn && logoutBtn.parentElement === headerRight) {
                    headerRight.insertBefore(toggleBtn, logoutBtn);
                } else {
                    headerRight.prepend(toggleBtn);
                }
            }
            return;
        }

        if (toggleBtn.parentElement !== headerContent) {
            headerContent.prepend(toggleBtn);
        }

        this.sincronizarHeaderHeight();
    },

    getActiveRifaId() {
        try {
            const value = localStorage.getItem(this.activeRifaKey);
            const parsed = Number.parseInt(value, 10);
            return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
        } catch (error) {
            return null;
        }
    },

    setActiveRifaId(rifaId) {
        const normalizedRifaId = Number.parseInt(rifaId, 10);
        const activeRifaId = Number.isInteger(normalizedRifaId) && normalizedRifaId > 0
            ? normalizedRifaId
            : null;

        try {
            if (activeRifaId) {
                localStorage.setItem(this.activeRifaKey, String(activeRifaId));
            } else {
                localStorage.removeItem(this.activeRifaKey);
            }
        } catch (error) {
            debugAdminLayout('No se pudo persistir la rifa activa', error?.message || error);
        }

        window.dispatchEvent(new CustomEvent('rifaplus:admin-rifa-activa-cambiada', {
            detail: {
                rifaId: activeRifaId
            }
        }));
    },

    getRifaById(rifaId) {
        const id = Number.parseInt(rifaId, 10);
        if (!Number.isInteger(id) || id <= 0) {
            return null;
        }

        return this.rifas.find((rifa) => Number.parseInt(rifa?.id, 10) === id) || null;
    },

    esRifaActiva(rifa) {
        if (!rifa || rifa.depurada_at) {
            return false;
        }

        const estado = String(rifa.estado || '').trim().toLowerCase();
        return estado === 'activo';
    },

    esRifaOperable(rifa) {
        if (!rifa || rifa.depurada_at) {
            return false;
        }

        const estado = String(rifa.estado || '').trim().toLowerCase();
        // Las rifas finalizadas siguen siendo operables para permitir declarar ganadores
        return estado === 'activo' || estado === 'borrador' || estado === 'finalizado';
    },

    esRifaHistorial(rifa) {
        if (!rifa) {
            return false;
        }

        const estado = String(rifa.estado || '').trim().toLowerCase();
        // Las rifas finalizadas ya no van al historial, siguen siendo operables
        return estado === 'archivada' || estado === 'depurada';
    },

    obtenerRifasActivas() {
        return this.rifas.filter((rifa) => this.esRifaActiva(rifa));
    },

    obtenerRifasOperables() {
        return this.rifas.filter((rifa) => this.esRifaOperable(rifa));
    },

    obtenerRifasHistorial() {
        // Incluir TODAS las rifas fuera de operación: archivadas Y depuradas
        return this.rifas.filter((rifa) => {
            if (!rifa) return false;
            const estado = String(rifa.estado || '').trim().toLowerCase();
            return estado === 'archivada' || estado === 'depurada';
        });
    },

    escapeHtml(valor) {
        return String(valor ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    },

    formatearFechaRifa(valor) {
        if (!valor) return 'Sin fecha';

        try {
            return new Intl.DateTimeFormat('es-MX', {
                dateStyle: 'medium',
                timeStyle: 'short'
            }).format(new Date(valor));
        } catch (error) {
            return 'Sin fecha';
        }
    },

    construirChipEstadoRifa(rifa) {
        const estado = String(rifa?.estado || 'sin estado').trim().toLowerCase();
        const mapa = {
            activo: { label: 'Activa', bg: '#dcfce7', color: '#166534' },
            borrador: { label: 'Borrador', bg: '#e0f2fe', color: '#075985' },
            finalizado: { label: 'Finalizada', bg: '#fef3c7', color: '#92400e' },
            archivada: { label: 'Archivada', bg: '#ede9fe', color: '#6d28d9' },
            depurada: { label: 'Depurada', bg: '#fee2e2', color: '#991b1b' }
        };

        return mapa[estado] || { label: estado || 'Sin estado', bg: '#e5e7eb', color: '#334155' };
    },

    construirUrlPublicaRifa(rifa) {
        const slug = String(rifa?.slug || '').trim();
        if (!rifa) {
            throw new Error('Selecciona una rifa válida');
        }

        if (!slug) {
            throw new Error('La rifa no tiene slug público disponible todavía');
        }

        const baseUrl = new URL(`${this.publicBaseUrl}/`);
        if (rifa.activa_publica === true) {
            return baseUrl.toString();
        }

        baseUrl.searchParams.set('rifa', slug);
        return baseUrl.toString();
    },

    async copiarTextoAlPortapapeles(texto) {
        const value = String(texto || '');
        if (!value) {
            throw new Error('No hay contenido para copiar');
        }

        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(value);
            return true;
        }

        const textarea = document.createElement('textarea');
        textarea.value = value;
        textarea.setAttribute('readonly', 'readonly');
        textarea.style.position = 'fixed';
        textarea.style.top = '-9999px';
        textarea.style.left = '-9999px';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);

        try {
            textarea.focus();
            textarea.select();
            textarea.setSelectionRange(0, textarea.value.length);
            const copiado = document.execCommand('copy');
            if (!copiado) {
                throw new Error('COPY_COMMAND_FAILED');
            }
            return true;
        } finally {
            textarea.remove();
        }
    },

    puedeDepurarRifa(rifa) {
        if (!rifa || rifa.depurada_at) {
            return false;
        }

        if (rifa.activa_publica === true) {
            return false;
        }

        const estado = String(rifa.estado || '').trim().toLowerCase();
        return estado === 'finalizado' || estado === 'archivada' || Boolean(rifa.snapshot_final);
    },

    obtenerMotivoNoDepurable(rifa) {
        if (!rifa) {
            return 'Selecciona una rifa válida';
        }

        if (rifa.depurada_at) {
            return 'Esta rifa ya fue depurada';
        }

        if (rifa.activa_publica === true) {
            return 'Activa otra rifa pública antes de depurar esta';
        }

        const estado = String(rifa.estado || '').trim().toLowerCase();
        if (!(estado === 'finalizado' || estado === 'archivada' || Boolean(rifa.snapshot_final))) {
            return 'Solo se pueden depurar rifas finalizadas';
        }

        return '';
    },

    instalarFetchContextoRifa() {
        if (window.__RIFAPLUS_ADMIN_RIFA_FETCH_PATCHED__) return;
        const originalFetch = window.fetch.bind(window);
        const self = this;
        const isAuthEndpoint = (pathname) => (
            pathname === '/api/admin/login'
            || pathname === '/api/admin/logout'
            || pathname.startsWith('/api/admin/auth/')
        );
        const shouldAttachAdminRifaHeader = (resource) => {
            try {
                const requestUrl = resource instanceof Request ? resource.url : resource;
                const resolvedUrl = new URL(String(requestUrl), window.location.href);
                const apiBase = self.apiUrl;

                if (!apiBase) {
                    return false;
                }

                const apiUrl = new URL(String(apiBase), window.location.href);
                if (resolvedUrl.origin !== apiUrl.origin) {
                    return false;
                }

                if (!(resolvedUrl.pathname === '/api' || resolvedUrl.pathname.startsWith('/api/'))) {
                    return false;
                }

                if (resolvedUrl.pathname.startsWith('/api/public/')) {
                    return false;
                }

                if (isAuthEndpoint(resolvedUrl.pathname)) {
                    return false;
                }

                return true;
            } catch (error) {
                return false;
            }
        };

        window.fetch = function(resource, options = {}) {
            const finalOptions = { ...(options || {}) };
            const headers = new Headers(finalOptions.headers || {});
            const activeRifaId = self.getActiveRifaId();
            const hasAuthorization = headers.has('Authorization');
            if (
                activeRifaId
                && hasAuthorization
                && shouldAttachAdminRifaHeader(resource)
                && !headers.has('x-rifaplus-rifa-id')
            ) {
                headers.set('x-rifaplus-rifa-id', String(activeRifaId));
            }
            finalOptions.headers = headers;
            return originalFetch(resource, finalOptions);
        };

        window.__RIFAPLUS_ADMIN_RIFA_FETCH_PATCHED__ = true;
    },

    async cargarSelectorRifas() {
        const token = await this.esperarAutenticacion();
        if (!token) return;

        // ✅ INCLUIR DEPURADAS para que el historial las muestre
        const response = await this.fetchAutenticado(`${this.apiUrl}/api/admin/rifas?incluirDepuradas=true`, {
            method: 'GET',
            cache: 'no-store'
        });

        if (!response || !response.ok) {
            return;
        }

        const payload = await response.json().catch(() => null);
        this.rifas = Array.isArray(payload?.data) ? payload.data : [];

        const rifasOperables = this.obtenerRifasOperables();

        const activeFromStorage = this.getActiveRifaId();
        const activeFromServer = Number.parseInt(payload?.activeRifaId, 10);
        const activeFromStorageValido = this.esRifaOperable(this.getRifaById(activeFromStorage))
            ? activeFromStorage
            : null;
        const activeFromServerValido = this.esRifaOperable(this.getRifaById(activeFromServer))
            ? activeFromServer
            : null;
        const activeRifaId = activeFromStorageValido
            || activeFromServerValido
            || (Number.parseInt(rifasOperables?.[0]?.id, 10) || null);

        if (activeRifaId) {
            this.setActiveRifaId(activeRifaId);
        }
        if (!activeRifaId) {
            this.setActiveRifaId(null);
        }

        this.renderSelectorRifas(activeRifaId);
    },

    renderSelectorRifas(activeRifaId) {
        const headerRight = document.querySelector('.admin-header-right');
        if (!headerRight) return;

        let wrap = document.getElementById('adminRifaSwitcher');
        if (!wrap) {
            wrap = document.createElement('div');
            wrap.id = 'adminRifaSwitcher';
            wrap.className = 'admin-rifa-toolbar';
            headerRight.prepend(wrap);
        }

        const rifasOperables = this.obtenerRifasOperables();
        const rifasHistorial = this.obtenerRifasHistorial();
        const totalHistorial = rifasHistorial.length;
        const options = rifasOperables.map((rifa) => {
            const estado = String(rifa?.estado || '').trim();
            const selected = Number(rifa?.id) === Number(activeRifaId) ? 'selected' : '';
            const suffix = estado ? ` (${estado})` : '';
            return `<option value="${rifa.id}" ${selected}>${String(rifa.nombre || rifa.slug || 'Rifa').trim()}${suffix}</option>`;
        }).join('');

        const rifaActiva = rifasOperables.find((rifa) => Number(rifa?.id) === Number(activeRifaId)) || null;
        const tieneLinkPublico = Boolean(String(rifaActiva?.slug || '').trim());
        const sinRifaActiva = !rifaActiva;
        const tituloCopiarLink = tieneLinkPublico
            ? (rifaActiva?.activa_publica === true
                ? 'Copiar link público principal'
                : 'Copiar link público de esta rifa')
            : 'La rifa aún no tiene slug público';
        const descripcionContexto = rifaActiva
            ? `Editando ${this.escapeHtml(String(rifaActiva.nombre || rifaActiva.slug || 'Rifa').trim())}`
            : 'No hay una rifa operable seleccionada';

        wrap.innerHTML = `
            <div class="admin-rifa-toolbar__context">
                <label for="adminRifaSelect" class="admin-rifa-toolbar__label">Rifa activa</label>
                <div class="admin-rifa-toolbar__hint">${descripcionContexto}</div>
            </div>
            <div class="admin-rifa-toolbar__select-wrap">
                <select id="adminRifaSelect" class="admin-rifa-toolbar__select" ${rifasOperables.length ? '' : 'disabled'}>
                    ${rifasOperables.length ? options : '<option value="">Sin rifas operables</option>'}
                </select>
            </div>
            ${sinRifaActiva ? '<div id="adminRifaWarning" class="admin-rifa-toolbar__warning">Selecciona o crea una rifa operable antes de guardar cambios.</div>' : ''}
        `;

        const select = document.getElementById('adminRifaSelect');

        select?.addEventListener('change', () => {
            const value = Number.parseInt(select.value, 10);
            this.setActiveRifaId(value);
            window.location.reload();
        });

        this.renderPanelAccionesRifa({
            totalHistorial,
            tieneLinkPublico,
            tituloCopiarLink,
            rifaActiva,
            activeRifaId
        });
        this.sincronizarHeaderMobile();
    },

    renderPanelAccionesRifa(contexto = {}) {
        const mount = document.getElementById('adminRifaActionsMount');
        const existingPanel = document.getElementById('adminRifaActionsPanel');

        if (!mount) {
            existingPanel?.remove();
            return;
        }

        const {
            totalHistorial = 0,
            tieneLinkPublico = false,
            tituloCopiarLink = 'La rifa aún no tiene slug público',
            rifaActiva = null,
            activeRifaId = null
        } = contexto;

        let panel = existingPanel;
        if (!panel) {
            panel = document.createElement('section');
            panel.id = 'adminRifaActionsPanel';
            panel.className = 'admin-page-toolbar';
            mount.appendChild(panel);
        }

        panel.innerHTML = `
            <div class="admin-page-toolbar__intro">
                <div class="admin-page-toolbar__eyebrow">Acciones de la rifa</div>
                <div class="admin-page-toolbar__title">Herramientas rápidas para la rifa activa</div>
                <div class="admin-page-toolbar__text">${
                    rifaActiva
                        ? `Trabajando sobre ${this.escapeHtml(String(rifaActiva.nombre || rifaActiva.slug || 'la rifa activa').trim())}.`
                        : 'Selecciona o crea una rifa para habilitar estas acciones.'
                }</div>
            </div>
            <div class="admin-page-toolbar__actions">
                <button type="button" class="admin-rifa-btn admin-rifa-btn--primary" data-rifa-action="nueva">Nueva</button>
                <button type="button" class="admin-rifa-btn admin-rifa-btn--secondary" data-rifa-action="historial" title="Ver rifas fuera de operación">Historial${totalHistorial > 0 ? ` (${totalHistorial})` : ''}</button>
                <button type="button" class="admin-rifa-btn admin-rifa-btn--accent" data-rifa-action="copiar" title="${tituloCopiarLink}" ${tieneLinkPublico ? '' : 'disabled'}>Copiar link</button>
                ${rifaActiva?.estado === 'finalizado' ? `<button type="button" class="admin-rifa-btn admin-rifa-btn--warning" data-rifa-action="archivar" title="Archivar esta rifa (la moverá al historial)" style="background:#f59e0b;color:#fff;font-weight:800;">📦 Archivar Rifa</button>` : ''}
            </div>
        `;

        const select = document.getElementById('adminRifaSelect');
        const btnNueva = panel.querySelector('[data-rifa-action="nueva"]');
        const btnHistorial = panel.querySelector('[data-rifa-action="historial"]');
        const btnCopiarLink = panel.querySelector('[data-rifa-action="copiar"]');
        const btnArchivar = panel.querySelector('[data-rifa-action="archivar"]');

        btnNueva?.addEventListener('click', async () => {
            const nombre = window.prompt('Nombre de la nueva rifa');
            if (!nombre || !String(nombre).trim()) return;

            const response = await this.fetchAutenticado(`${this.apiUrl}/api/admin/rifas`, {
                method: 'POST',
                body: JSON.stringify({ nombre: String(nombre).trim() })
            });

            if (!response || !response.ok) {
                const errorPayload = await response?.json?.().catch(() => null);
                alert(errorPayload?.message || 'No se pudo crear la rifa');
                return;
            }

            const payload = await response.json().catch(() => null);
            const nuevaId = Number.parseInt(payload?.data?.id, 10);
            if (nuevaId) {
                this.setActiveRifaId(nuevaId);
            }
            window.location.reload();
        });

        btnCopiarLink?.addEventListener('click', async () => {
            const rifaSeleccionada = this.getRifaById(select?.value || activeRifaId);
            try {
                const urlPublica = this.construirUrlPublicaRifa(rifaSeleccionada);
                await this.copiarTextoAlPortapapeles(urlPublica);
                window.alert(
                    rifaSeleccionada?.activa_publica === true
                        ? `Link público principal copiado:\n${urlPublica}`
                        : `Link público de la rifa copiado:\n${urlPublica}`
                );
            } catch (error) {
                const urlFallback = (() => {
                    try {
                        return this.construirUrlPublicaRifa(rifaSeleccionada);
                    } catch (buildError) {
                        return '';
                    }
                })();

                if (urlFallback) {
                    window.prompt('No se pudo copiar automáticamente. Copia este link manualmente:', urlFallback);
                    return;
                }

                window.alert(error?.message || 'No se pudo generar el link público de la rifa');
            }
        });

        btnHistorial?.addEventListener('click', () => {
            this.mostrarModalHistorialRifas();
        });

        btnArchivar?.addEventListener('click', async () => {
            const rifaSeleccionada = this.getRifaById(select?.value || activeRifaId);
            if (rifaSeleccionada) {
                await this.archivarRifaDesdeUI(rifaSeleccionada, btnArchivar);
            }
        });
    },

    async depurarRifaDesdeUI(rifaSeleccionada, boton = null) {
        if (!this.puedeDepurarRifa(rifaSeleccionada)) {
            window.alert(this.obtenerMotivoNoDepurable(rifaSeleccionada) || 'Esta rifa todavía no se puede depurar');
            return false;
        }

        const nombreRifa = String(rifaSeleccionada?.nombre || rifaSeleccionada?.slug || 'esta rifa').trim();
        const confirmacion = window.prompt(
            `Esta acción eliminará los datos operativos de "${nombreRifa}" y solo dejará su historial.\n\nEscribe ELIMINAR RIFA para continuar.`
        );

        if (String(confirmacion || '').trim().toUpperCase() !== 'ELIMINAR RIFA') {
            return false;
        }

        if (boton) {
            boton.disabled = true;
        }

        try {
            const response = await this.fetchAutenticado(`${this.apiUrl}/api/admin/rifas/${rifaSeleccionada.id}/depurar`, {
                method: 'POST',
                body: JSON.stringify({ confirmacion: 'ELIMINAR RIFA' })
            });

            const payload = await response?.json?.().catch(() => null);
            if (!response || !response.ok || payload?.success === false) {
                window.alert(payload?.message || 'No se pudo depurar la rifa');
                return false;
            }

            const siguienteRifa = this.obtenerRifasActivas().find((rifa) => (
                Number.parseInt(rifa?.id, 10) !== Number.parseInt(rifaSeleccionada.id, 10)
            ));

            if (siguienteRifa?.id) {
                this.setActiveRifaId(siguienteRifa.id);
            } else {
                this.setActiveRifaId(null);
            }

            window.alert(payload?.message || 'La rifa fue depurada correctamente');
            window.location.reload();
            return true;
        } finally {
            if (boton) {
                boton.disabled = false;
            }
        }
    },

    async archivarRifaDesdeUI(rifaSeleccionada, boton = null) {
        // Verificar que la rifa esté finalizada
        if (rifaSeleccionada?.estado !== 'finalizado') {
            window.alert('⚠️ Solo se pueden archivar rifas que estén finalizadas.\n\nEstado actual: ' + (rifaSeleccionada?.estado || 'desconocido'));
            return false;
        }

        const nombreRifa = String(rifaSeleccionada?.nombre || rifaSeleccionada?.slug || 'esta rifa').trim();
        const confirmacion = window.confirm(
            `📦 ¿Archivar "${nombreRifa}"?\n\n` +
            `✅ La rifa se moverá al historial\n` +
            `✅ Ya no aparecerá en el selector de rifas activas\n` +
            `✅ Podrás verla en el historial\n` +
            `⚠️ Esta acción se puede deshacer desde la base de datos\n\n` +
            `¿Continuar?`
        );

        if (!confirmacion) {
            return false;
        }

        if (boton) {
            boton.disabled = true;
            boton.textContent = '⏳ Archivando...';
        }

        try {
            // Obtener API base directamente de rifaplusConfig
            const apiBase = window.rifaplusConfig?.backend?.apiBase
                || window.rifaplusConfig?.obtenerApiBase?.();
            
            if (!apiBase) {
                throw new Error('No se pudo determinar la URL del backend');
            }
            
            const token = this.getToken();
            if (!token) {
                throw new Error('No hay token de autenticación');
            }
            
            const url = `${apiBase}/api/admin/rifas/${rifaSeleccionada.id}/archivar`;
            console.log('📡 [Archivar] Enviando petición a:', url);
            
            const response = await window.fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            });

            console.log('📥 [Archivar] Response status:', response.status);
            
            const payload = await response.json().catch(() => null);
            console.log('📦 [Archivar] Response payload:', payload);
            
            if (!response.ok) {
                const errorCode = payload?.code;
                
                // Manejar errores específicos
                if (errorCode === 'NOT_FINALIZED') {
                    throw new Error('⚠️ La rifa debe estar finalizada para poder archivarla.\n\nEstado actual: ' + (payload.currentStatus || 'desconocido'));
                } else if (errorCode === 'ACTIVE_PUBLIC_RIFA') {
                    throw new Error('⚠️ No se puede archivar la rifa pública activa.\n\nPrimero activa otra rifa como pública.');
                } else if (errorCode === 'ALREADY_PURGED') {
                    throw new Error('ℹ️ Esta rifa ya fue depurada anteriormente.');
                } else if (errorCode === 'UNAUTHORIZED') {
                    throw new Error('🔒 No tienes permisos para archivar rifas.\n\nSolo administradores pueden realizar esta acción.');
                } else if (errorCode === 'LAST_OPERABLE_RIFA') {
                    throw new Error(
                        '⚠️ No puedes archivar la última rifa operable.\n\n' +
                        `📊 Rifas operables actuales: ${payload.totalOperables || 1}\n\n` +
                        '💡 Solución:\n' +
                        '1. Crea una nueva rifa desde el botón "Nueva"\n' +
                        '2. Luego podrás archivar esta rifa\n\n' +
                        '📝 Esto evita que el admin quede sin rifas disponibles.'
                    );
                }
                
                throw new Error(payload?.message || 'Error al archivar la rifa');
            }

            // Éxito
            console.log('✅ [Archivar] Rifa archivada exitosamente');
            
            const data = payload?.data || {};
            const mensaje = payload?.message || 'La rifa fue archivada exitosamente';
            
            // Mostrar mensaje informativo
            window.alert(
                `✅ ${mensaje}\n\n` +
                `📦 Rifa: ${data.rifaNombre || nombreRifa}\n` +
                `📊 Estado: ${data.anteriorEstado || 'finalizado'} → ${data.nuevoEstado || 'archivada'}\n` +
                `👤 Archivado por: ${data.archivadoPor || 'Admin'}`
            );
            
            // Limpiar caché y recargar
            try {
                localStorage.removeItem('rifas_cache');
                sessionStorage.clear();
            } catch (e) {}
            
            console.log('🔄 Recargando página para actualizar lista de rifas...');
            // Forzar recarga completa sin caché
            window.location.href = window.location.pathname + '?t=' + Date.now();
            return true;
            
        } catch (error) {
            console.error('❌ [Archivar Rifa] Error:', error);
            
            // Mostrar error amigable
            const errorMessage = error.message || 'Verifica tu conexión e intenta de nuevo';
            window.alert('❌ Error al archivar:\n\n' + errorMessage);
            return false;
        } finally {
            if (boton) {
                boton.disabled = false;
                boton.textContent = '📦 Archivar Rifa';
            }
        }
    },

    cerrarModalHistorialRifas() {
        if (this._historialEscapeHandler) {
            document.removeEventListener('keydown', this._historialEscapeHandler);
            this._historialEscapeHandler = null;
        }

        const overlay = document.getElementById('adminRifasHistorialModal');
        if (overlay) {
            overlay.remove();
        }
    },

    construirTarjetaHistorialRifa(rifa) {
        const chip = this.construirChipEstadoRifa(rifa);
        const nombre = this.escapeHtml(String(rifa?.nombre || rifa?.slug || 'Rifa').trim());
        const slug = this.escapeHtml(String(rifa?.slug || '').trim() || 'sin-slug');
        const detalleFecha = rifa?.depurada_at
            ? `Depurada: ${this.formatearFechaRifa(rifa.depurada_at)}`
            : rifa?.finalizada_at
                ? `Finalizada: ${this.formatearFechaRifa(rifa.finalizada_at)}`
                : `Actualizada: ${this.formatearFechaRifa(rifa.updated_at)}`;
        const etiquetaPublica = rifa?.activa_publica === true
            ? '<span style="display:inline-flex;align-items:center;padding:0.2rem 0.45rem;border-radius:999px;background:#dbeafe;color:#1d4ed8;font-size:0.72rem;font-weight:700;">Publica</span>'
            : '';
        const tieneLinkPublico = Boolean(String(rifa?.slug || '').trim());
        const puedeDepurar = this.puedeDepurarRifa(rifa);
        const tituloDepurar = this.escapeHtml(this.obtenerMotivoNoDepurable(rifa) || 'Depurar rifa');
        // Las rifas finalizadas pueden acceder al admin para declarar ganadores
        const puedeAccederAdmin = rifa?.estado === 'finalizado' || rifa?.estado === 'borrador';
        // Las rifas finalizadas se pueden archivar (las depuradas ya lo están)
        const puedeArchivar = rifa?.estado === 'finalizado' && !rifa?.depurada_at;
        
        // Rifas depuradas tienen estilo atenuado
        const esDepurada = rifa?.depurada_at !== null && rifa?.depurada_at !== undefined;
        const opacityStyle = esDepurada ? 'opacity:0.65;' : '';
        const bordeDepurada = esDepurada ? 'border:2px dashed #cbd5e1;' : '';

        return `
            <article data-rifa-id="${Number.parseInt(rifa?.id, 10) || ''}" style="border:1px solid #e2e8f0;${bordeDepurada}border-radius:18px;padding:1rem;background:linear-gradient(180deg,#ffffff 0%,#f8fafc 100%);box-shadow:0 10px 30px rgba(15,23,42,0.06);${opacityStyle}">
                ${esDepurada ? '<div style="margin-bottom:0.75rem;padding:0.5rem;background:#f1f5f9;border-radius:0.5rem;text-align:center;font-size:0.75rem;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;">🗄️ Rifa Depurada (Solo consulta)</div>' : ''}
                <div style="display:flex;justify-content:space-between;gap:0.75rem;align-items:flex-start;margin-bottom:0.8rem;">
                    <div style="min-width:0;">
                        <h3 style="margin:0;font-size:1rem;font-weight:800;color:#0f172a;line-height:1.25;">${nombre}</h3>
                        <div style="margin-top:0.28rem;font-size:0.82rem;color:#64748b;word-break:break-word;">Slug: ${slug}</div>
                    </div>
                    <div style="display:flex;gap:0.45rem;flex-wrap:wrap;justify-content:flex-end;">
                        <span style="display:inline-flex;align-items:center;padding:0.2rem 0.55rem;border-radius:999px;background:${chip.bg};color:${chip.color};font-size:0.72rem;font-weight:800;">${this.escapeHtml(chip.label)}</span>
                        ${etiquetaPublica}
                    </div>
                </div>
                <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:0.7rem;margin-bottom:0.95rem;">
                    <div style="padding:0.65rem 0.75rem;border-radius:14px;background:#fff;border:1px solid #e2e8f0;">
                        <div style="font-size:0.72rem;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.04em;">Estado</div>
                        <div style="margin-top:0.2rem;font-size:0.92rem;font-weight:700;color:#0f172a;">${this.escapeHtml(String(rifa?.estado || 'sin estado'))}</div>
                    </div>
                    <div style="padding:0.65rem 0.75rem;border-radius:14px;background:#fff;border:1px solid #e2e8f0;">
                        <div style="font-size:0.72rem;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.04em;">Referencia</div>
                        <div style="margin-top:0.2rem;font-size:0.92rem;font-weight:700;color:#0f172a;">#${Number.parseInt(rifa?.id, 10) || '-'}</div>
                    </div>
                    <div style="padding:0.65rem 0.75rem;border-radius:14px;background:#fff;border:1px solid #e2e8f0;">
                        <div style="font-size:0.72rem;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.04em;">Movimiento</div>
                        <div style="margin-top:0.2rem;font-size:0.88rem;font-weight:700;color:#0f172a;">${this.escapeHtml(detalleFecha)}</div>
                    </div>
                </div>
                <div style="display:flex;flex-wrap:wrap;gap:0.55rem;">
                    <button type="button" data-action="copy-link" ${tieneLinkPublico ? '' : 'disabled'} style="padding:0.58rem 0.8rem;border:none;border-radius:12px;background:${tieneLinkPublico ? '#1d4ed8' : '#cbd5e1'};color:#fff;font-weight:800;cursor:${tieneLinkPublico ? 'pointer' : 'not-allowed'};opacity:${tieneLinkPublico ? '1' : '.78'};">Copiar link</button>
                    ${puedeAccederAdmin ? `<button type="button" data-action="acceder-admin" style="padding:0.58rem 0.8rem;border:none;border-radius:12px;background:#7C3AED;color:#fff;font-weight:800;cursor:pointer;">Acceder al admin</button>` : ''}
                    ${puedeArchivar ? `<button type="button" data-action="archivar" style="padding:0.58rem 0.8rem;border:none;border-radius:12px;background:#f59e0b;color:#fff;font-weight:800;cursor:pointer;" title="Archivar esta rifa (la moverá al historial)">📦 Archivar</button>` : ''}
                    <button type="button" data-action="depurar" title="${tituloDepurar}" ${puedeDepurar ? '' : 'disabled'} style="padding:0.58rem 0.8rem;border:none;border-radius:12px;background:${puedeDepurar ? '#b91c1c' : '#cbd5e1'};color:#fff;font-weight:800;cursor:${puedeDepurar ? 'pointer' : 'not-allowed'};opacity:${puedeDepurar ? '1' : '.78'};">${esDepurada ? '✓ Depurada' : 'Depurar'}</button>
                </div>
            </article>
        `;
    },

    mostrarModalHistorialRifas() {
        this.cerrarModalHistorialRifas();

        const rifasHistorial = this.obtenerRifasHistorial();
        const overlay = document.createElement('div');
        overlay.id = 'adminRifasHistorialModal';
        overlay.style.cssText = `
            position:fixed;
            inset:0;
            background:rgba(15,23,42,0.55);
            backdrop-filter:blur(10px);
            z-index:9999;
            display:flex;
            align-items:center;
            justify-content:center;
            padding:1.25rem;
        `;

        const contenido = document.createElement('div');
        contenido.style.cssText = `
            width:min(1040px, 100%);
            max-height:min(88vh, 920px);
            overflow:auto;
            border-radius:24px;
            background:linear-gradient(180deg,#f8fafc 0%,#ffffff 100%);
            box-shadow:0 30px 80px rgba(15,23,42,0.28);
            border:1px solid rgba(226,232,240,0.95);
        `;

        const listado = rifasHistorial.length
            ? rifasHistorial.map((rifa) => this.construirTarjetaHistorialRifa(rifa)).join('')
            : `
                <div style="padding:2.3rem 1.2rem;border:1px dashed #cbd5e1;border-radius:18px;background:#fff;text-align:center;color:#475569;">
                    <div style="font-size:1rem;font-weight:800;color:#0f172a;margin-bottom:0.35rem;">No hay rifas en historial</div>
                    <div style="font-size:0.92rem;">Cuando cierres, archives o depures una rifa aparecerá aquí.</div>
                </div>
            `;

        contenido.innerHTML = `
            <div style="position:sticky;top:0;z-index:1;background:linear-gradient(180deg,rgba(248,250,252,0.98) 0%,rgba(248,250,252,0.92) 100%);backdrop-filter:blur(8px);padding:1.2rem 1.2rem 1rem;border-bottom:1px solid #e2e8f0;">
                <div style="display:flex;justify-content:space-between;gap:1rem;align-items:flex-start;">
                    <div>
                        <div style="display:inline-flex;align-items:center;padding:0.28rem 0.6rem;border-radius:999px;background:#e2e8f0;color:#334155;font-size:0.74rem;font-weight:800;letter-spacing:0.03em;text-transform:uppercase;">Historial de rifas</div>
                        <h2 style="margin:0.65rem 0 0.2rem;font-size:1.35rem;line-height:1.1;color:#0f172a;">Rifas fuera de operación</h2>
                        <p style="margin:0;font-size:0.94rem;color:#475569;max-width:720px;">Aquí se concentran las rifas archivadas o depuradas. Las rifas finalizadas siguen operables desde el selector principal para declarar ganadores.</p>
                    </div>
                    <button type="button" data-action="close-modal" style="padding:0.6rem 0.85rem;border:none;border-radius:12px;background:#0f172a;color:#fff;font-weight:800;cursor:pointer;">Cerrar</button>
                </div>
            </div>
            <div style="padding:1.15rem;display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1rem;">
                ${listado}
            </div>
        `;

        overlay.appendChild(contenido);
        document.body.appendChild(overlay);

        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) {
                this.cerrarModalHistorialRifas();
            }
        });

        contenido.querySelector('[data-action="close-modal"]')?.addEventListener('click', () => {
            this.cerrarModalHistorialRifas();
        });

        contenido.querySelectorAll('[data-rifa-id]').forEach((card) => {
            const rifaId = Number.parseInt(card.getAttribute('data-rifa-id'), 10);
            const rifa = this.getRifaById(rifaId);
            const btnCopy = card.querySelector('[data-action="copy-link"]');
            const btnDepurar = card.querySelector('[data-action="depurar"]');
            const btnAccederAdmin = card.querySelector('[data-action="acceder-admin"]');
            const btnArchivar = card.querySelector('[data-action="archivar"]');

            btnCopy?.addEventListener('click', async () => {
                try {
                    const urlPublica = this.construirUrlPublicaRifa(rifa);
                    await this.copiarTextoAlPortapapeles(urlPublica);
                    window.alert(`Link público de la rifa copiado:\n${urlPublica}`);
                } catch (error) {
                    window.alert(error?.message || 'No se pudo generar el link público de la rifa');
                }
            });

            btnDepurar?.addEventListener('click', async () => {
                await this.depurarRifaDesdeUI(rifa, btnDepurar);
            });

            btnAccederAdmin?.addEventListener('click', () => {
                // Cambiar la rifa activa y recargar para acceder al admin de esta rifa
                this.setActiveRifaId(rifaId);
                this.cerrarModalHistorialRifas();
                window.location.reload();
            });

            btnArchivar?.addEventListener('click', async () => {
                await this.archivarRifaDesdeUI(rifa);
            });
        });

        this._historialEscapeHandler = (event) => {
            if (event.key === 'Escape') {
                this.cerrarModalHistorialRifas();
            }
        };

        document.addEventListener('keydown', this._historialEscapeHandler);
    },
    
    /**
     * Escuchar cambios de configuración y actualizar header automáticamente
     * Previene conflictos cuando config se sincroniza múltiples veces
     */
    escucharCambiosConfig() {
        // Escuchar evento de config actualizada
        window.addEventListener('configuracionActualizada', () => {
            debugAdminLayout('configuracionActualizada detectado; reconfigurando header');
            this.configurarLogo();
        });
        
        // También escuchar a través del sistema de listeners de rifaplusConfig
        if (window.rifaplusConfig && typeof window.rifaplusConfig.escucharEvento === 'function') {
            window.rifaplusConfig.escucharEvento('configuracionActualizada', () => {
                debugAdminLayout('configuracionActualizada interno detectado; reconfigurando header');
                this.configurarLogo();
            });
        }
    },
    
    /**
     * Verificar que el usuario esté autenticado
     * Si no, redirigir al dashboard solo si estamos en una página que NO es admin-dashboard.html
     */
    async verificarAutenticacion() {
        // Buscar token de múltiples fuentes para garantizar consistencia
        const token = localStorage.getItem('rifaplus_token') || 
                     localStorage.getItem('rifaplus_admin_token') ||
                     localStorage.getItem('admin_token') ||
                     localStorage.getItem('token');
        
        const paginaActual = window.location.pathname.split('/').pop() || 'admin-dashboard.html';
        const esPaginaLogin = this.esPaginaLoginAdmin();
        
        // Si hay token, asegurar que está en todas las claves
        if (token) {
            localStorage.setItem('rifaplus_token', token);
            localStorage.setItem('rifaplus_admin_token', token);
        }
        
        // Si no hay token y NO estamos en admin-dashboard, redirigir
        if (!token && !esPaginaLogin) {
            console.warn('⚠️  [AdminLayout] Sin token, redirigiendo al login...');
            localStorage.setItem('redirectAfterLogin', paginaActual);
            this.finalizarChequeoVisual();
            window.location.href = 'admin-dashboard.html';
            return false;
        }

        if (!token) {
            this.finalizarChequeoVisual();
            return false;
        }

        try {
            const response = await fetch(`${this.apiUrl}/api/admin/verify-token`, {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${token}` },
                cache: 'no-store'
            });

            if (!response.ok) {
                throw new Error(`Token inválido (${response.status})`);
            }

            return token;
        } catch (error) {
            console.warn('⚠️  [AdminLayout] Token no válido o no verificable:', error.message);
            localStorage.removeItem(this.tokenKey);
            localStorage.removeItem('rifaplus_token');
            localStorage.removeItem('admin_token');
            localStorage.removeItem('token');

            if (!esPaginaLogin) {
                localStorage.setItem('redirectAfterLogin', paginaActual);
                this.finalizarChequeoVisual();
                window.location.href = 'admin-dashboard.html';
                return false;
            }

            return false;
        } finally {
            this.finalizarChequeoVisual();
        }
    },

    async esperarAutenticacion() {
        if (!this.authPromise) {
            this.authPromise = this.verificarAutenticacion();
        }
        return this.authPromise;
    },

    finalizarChequeoVisual() {
        document.documentElement.classList.remove('admin-auth-checking');
    },
    
    /**
     * Configurar el logo y título del header
     */
    configurarLogo() {
        const config = window.rifaplusConfig || {};
        const nombreCliente = String(config.cliente?.nombre || '').trim() || 'Sorteo';
        const marcaAdmin = this.obtenerMarcaAdmin(config);
        const logoCliente = config.cliente?.logo || config.cliente?.logotipo || this.fallbackLogo;
        
        debugAdminLayout('Actualizando header admin', {
            nombreClienteAUsar: nombreCliente,
            nombreSorteoEnConfig: config.rifa?.nombreSorteo || '(vacio)',
            cliente: {
                nombre: config.cliente?.nombre,
                eslogan: config.cliente?.eslogan,
                id: config.cliente?.id
            }
        });
        
        // Buscar elementos del header
        const logoImg = document.querySelector('.admin-logo-container img');
        const titleSub = document.querySelector('.admin-header-title-sub');
        
        if (logoImg) {
            logoImg.src = logoCliente;
        }
        
        if (titleSub) {
            titleSub.textContent = nombreCliente;
        }

        const loginTitle = document.getElementById('loginTitle');
        if (loginTitle) {
            loginTitle.textContent = `Panel Admin - ${marcaAdmin}`;
        }

        const loginLogo = document.getElementById('loginLogo');
        if (loginLogo) {
            loginLogo.src = logoCliente;
            loginLogo.alt = `Logo de ${nombreCliente}`;
        }

        const dashboardLogo = document.getElementById('dashboardLogo');
        if (dashboardLogo) {
            dashboardLogo.src = logoCliente;
            dashboardLogo.alt = `Logo de ${nombreCliente}`;
        }

        this.configurarMetadatosBranding(marcaAdmin, logoCliente, nombreCliente);
    },

    configurarMetadatosBranding(marcaAdmin, logoCliente, nombreCliente) {
        document.title = `Panel Admin - ${marcaAdmin}`;

        document.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"], link[rel="preload"][as="image"]').forEach((link) => {
            link.href = logoCliente;
        });

        const logoHeader = document.querySelector('.admin-logo-img');
        if (logoHeader) {
            logoHeader.src = logoCliente;
            logoHeader.alt = `Logo de ${nombreCliente}`;
        }
    },
    
    /**
     * Configurar el botón de logout
     */
    configurarLogout() {
        const logoutBtn = document.querySelector('.admin-logout-btn');
        
        if (logoutBtn) {
            logoutBtn.addEventListener('click', () => {
                this.logout();
            });
        }
    },
    
    /**
     * Cerrar sesión
     */
    logout() {
        if (confirm('¿Estás seguro de que deseas cerrar sesión?')) {
            // Limpiar nombre antes de borrar el token
            const nombreDisplay = document.getElementById('userDisplayName');
            const rolDisplay = document.getElementById('userDisplayRole');
            if (nombreDisplay) nombreDisplay.textContent = '-';
            if (rolDisplay) rolDisplay.textContent = '-';
            
            localStorage.removeItem(this.tokenKey);
            localStorage.removeItem('rifaplus_token');
            localStorage.removeItem('admin_token');
            localStorage.removeItem('token');
            window.location.href = 'admin-dashboard.html';
        }
    },
    
    /**
     * Configurar el menú sidebar
     */
    configurarSidebar() {
        const toggleBtn = document.querySelector('.admin-sidebar-toggle');
        const sidebar = document.querySelector('.admin-sidebar');
        const mainContent = document.querySelector('.admin-main');
        const navBtns = document.querySelectorAll('.admin-nav-btn');
        let overlayMenu = document.getElementById('overlayMenu');
        let overlayClose = document.getElementById('overlayClose');

        if (toggleBtn) {
            const headerContent = document.querySelector('.admin-header-content');
            if (headerContent && toggleBtn.parentElement !== headerContent) {
                headerContent.prepend(toggleBtn);
            }

            toggleBtn.classList.add('hamburger');
            toggleBtn.setAttribute('aria-label', 'Abrir menú');
            toggleBtn.setAttribute('aria-expanded', 'false');

            if (!toggleBtn.querySelector('.hamburger-box')) {
                toggleBtn.innerHTML = `
                    <span class="hamburger-box">
                        <span class="hamburger-inner"></span>
                    </span>
                `;
            }
        }

        if (!overlayMenu) {
            const linksHtml = Array.from(navBtns).map((btn) => {
                const href = btn.getAttribute('href') || '#';
                const label = btn.querySelector('span')?.textContent?.trim() || btn.textContent.trim() || 'Sección';
                return `<a href="${href}" class="overlay-link">${label}</a>`;
            }).join('');

            document.body.insertAdjacentHTML('beforeend', `
                <div class="overlay-menu admin-overlay-menu" id="overlayMenu" inert>
                    <div class="overlay-inner">
                        <button class="overlay-close" id="overlayClose" aria-label="Cerrar menú">×</button>
                        ${linksHtml}
                    </div>
                </div>
            `);

            overlayMenu = document.getElementById('overlayMenu');
            overlayClose = document.getElementById('overlayClose');
        }

        const toggleInner = toggleBtn?.querySelector('.hamburger-inner');

        const abrirOverlay = () => {
            overlayMenu?.classList.add('show');
            overlayMenu?.removeAttribute('inert');
            toggleBtn?.classList.add('is-active');
            toggleBtn?.setAttribute('aria-expanded', 'true');
            document.body.classList.add('admin-sidebar-open');

            if (toggleInner) {
                toggleInner.style.transform = 'rotate(45deg)';
                toggleInner.style.backgroundColor = 'var(--primary-light)';
            }
        };

        const cerrarOverlay = () => {
            overlayMenu?.classList.remove('show');
            overlayMenu?.setAttribute('inert', '');
            toggleBtn?.classList.remove('is-active');
            toggleBtn?.setAttribute('aria-expanded', 'false');
            document.body.classList.remove('admin-sidebar-open');

            if (toggleInner) {
                toggleInner.style.transform = 'rotate(0)';
                toggleInner.style.backgroundColor = 'white';
            }
        };
        
        // Toggle button (móvil)
        if (toggleBtn && overlayMenu) {
            toggleBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const estaAbierto = overlayMenu.classList.contains('show');
                if (estaAbierto) {
                    cerrarOverlay();
                } else {
                    abrirOverlay();
                }
            });
            
            const enlacesOverlay = overlayMenu.querySelectorAll('.overlay-link');
            enlacesOverlay.forEach(btn => {
                btn.addEventListener('click', () => {
                    cerrarOverlay();
                });
            });

            if (overlayClose) {
                overlayClose.addEventListener('click', cerrarOverlay);
            }

            overlayMenu.addEventListener('click', (e) => {
                if (e.target === overlayMenu) {
                    cerrarOverlay();
                }
            });

            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && overlayMenu.classList.contains('show')) {
                    cerrarOverlay();
                }
            });
        }
        
        // Toggle de collapse (desktop)
        const collapseBtn = document.querySelector('.admin-sidebar-collapse-btn');
        if (collapseBtn && sidebar && mainContent) {
            collapseBtn.addEventListener('click', () => {
                sidebar.classList.toggle('collapsed');
                mainContent.classList.toggle('sidebar-collapsed');
                
                // Guardar preferencia
                const isCollapsed = sidebar.classList.contains('collapsed');
                localStorage.setItem('admin-sidebar-collapsed', isCollapsed ? 'true' : 'false');
            });
            
            // Restaurar preferencia guardada
            const wasCollapsed = localStorage.getItem('admin-sidebar-collapsed') === 'true';
            if (wasCollapsed) {
                sidebar.classList.add('collapsed');
                mainContent.classList.add('sidebar-collapsed');
            }
        }
    },
    
    /**
     * Establecer la página actual como activa en el menú
     */
    establecerPaginaActiva() {
        const paginaActual = window.location.pathname.split('/').pop() || 'admin-dashboard.html';
        const navBtns = document.querySelectorAll('.admin-nav-btn');
        
        navBtns.forEach(btn => {
            const href = btn.getAttribute('href');
            if (href === paginaActual || (paginaActual === '' && href === 'admin-dashboard.html')) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });
    },
    
    /**
     * Obtener el token de autenticación
     */
    getToken() {
        return localStorage.getItem(this.tokenKey);
    },
    
    /**
     * Hacer una petición autenticada al API
     */
    async fetchAutenticado(url, opciones = {}) {
        const token = this.getToken();
        
        if (!token) {
            throw new Error('No hay token de autenticación');
        }
        
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            ...opciones.headers
        };
        
        const response = await fetch(url, {
            ...opciones,
            headers
        });
        
        // Si recibimos 401, significa que el token expiró
        if (response.status === 401) {
            console.warn('[AdminLayout] Token expirado; cerrando sesion');
            this.logout();
            return;
        }
        
        return response;
    }
};

// Inicializar cuando el DOM está listo
document.addEventListener('DOMContentLoaded', () => {
    ADMIN_LAYOUT.init();
});
