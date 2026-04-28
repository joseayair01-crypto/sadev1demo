(function inicializarIndexPublico() {
    const INDEX_DEBUG = ['localhost', '127.0.0.1'].includes(window.location.hostname);
    const indexLog = (...args) => {
        if (INDEX_DEBUG) console.log(...args);
    };
    const indexWarn = (...args) => {
        if (INDEX_DEBUG) console.warn(...args);
    };

    function notificarPaginaListaIndex() {
        window.dispatchEvent(new CustomEvent('rifaplus:page-ready', {
            detail: { page: 'index' }
        }));
    }

    const state = window.__RIFAPLUS_INDEX_STATE__ = window.__RIFAPLUS_INDEX_STATE__ || {
        firmas: {},
        precioRefreshTimeoutId: 0,
        secondaryRenderFrameId: 0,
        secondaryRenderIdleId: 0,
        sectionObservers: {},
        activatedSections: {},
        footerBounceTimerId: 0,
        boletosObserver: null,
        initialized: false,
        pageReadyEmitida: false
    };

    function esHeroIndexListo() {
        const hero = document.querySelector('.hero');
        const titleEl = document.getElementById('heroTitle');
        const descEl = document.getElementById('heroDescription');

        if (!hero || !titleEl || !descEl) {
            return false;
        }

        return Boolean(String(titleEl.textContent || '').trim())
            && Boolean(String(descEl.textContent || '').trim());
    }

    function esCarruselIndexListo() {
        const carruselSection = document.querySelector('.carrusel-section');
        if (!carruselSection) {
            return true;
        }

        const style = window.getComputedStyle(carruselSection);
        if (style.display === 'none' || carruselSection.hidden) {
            return true;
        }

        const slides = Array.isArray(window.carruselState?.slides) ? window.carruselState.slides : [];
        if (slides.length === 0) {
            return false;
        }

        const slideActivo = slides[window.carruselState?.currentIndex || 0] || slides[0];
        const imagenActiva = slideActivo?.querySelector('img');

        return Boolean(imagenActiva)
            && imagenActiva.complete
            && imagenActiva.naturalWidth > 0;
    }

    function evaluarPaginaListaIndex() {
        if (state.pageReadyEmitida) {
            return;
        }

        if (!esHeroIndexListo() || !esCarruselIndexListo()) {
            return;
        }

        state.pageReadyEmitida = true;
        requestAnimationFrame(() => {
            notificarPaginaListaIndex();
        });
    }

    function obtenerRifaPublica() {
        return window.rifaplusConfig?.rifa || window.config?.rifa || null;
    }

    function obtenerClientePublico() {
        return window.rifaplusConfig?.cliente || window.config?.cliente || null;
    }

    function serializarFirmaIndex(valor) {
        try {
            return JSON.stringify(valor) || '';
        } catch (error) {
            return String(valor ?? '');
        }
    }

    function actualizarFirmaIndex(clave, valor) {
        const firma = serializarFirmaIndex(valor);
        if (state.firmas[clave] === firma) {
            return false;
        }

        state.firmas[clave] = firma;
        return true;
    }

    function persistirDatoHero(clave, valor, campoEstado) {
        if (!valor) return;

        try {
            localStorage.setItem(clave, valor);
            if (window.__RIFAPLUS_INDEX_HERO__) {
                window.__RIFAPLUS_INDEX_HERO__[campoEstado] = valor;
            }
        } catch (error) {
            indexWarn(`No se pudo cachear ${campoEstado} del hero:`, error?.message || error);
        }
    }

    function esViewportMovil() {
        return window.matchMedia('(max-width: 768px)').matches;
    }

    function activarRenderDiferidoEnMovil(sectionId, renderFn, options = {}) {
        const section = document.getElementById(sectionId);
        if (!section || typeof renderFn !== 'function') return;

        const stateKey = options.stateKey || sectionId;
        if (state.activatedSections[stateKey]) {
            renderFn();
            return;
        }

        const activar = () => {
            state.activatedSections[stateKey] = true;
            if (state.sectionObservers[stateKey]) {
                state.sectionObservers[stateKey].disconnect();
                delete state.sectionObservers[stateKey];
            }
            renderFn();
        };

        if (!esViewportMovil() || !('IntersectionObserver' in window)) {
            activar();
            return;
        }

        if (section.getBoundingClientRect().top <= window.innerHeight + 240) {
            activar();
            return;
        }

        if (state.sectionObservers[stateKey]) return;

        state.sectionObservers[stateKey] = new IntersectionObserver((entries, observer) => {
            if (!entries.some((entry) => entry.isIntersecting)) return;
            observer.disconnect();
            delete state.sectionObservers[stateKey];
            activar();
        }, {
            rootMargin: options.rootMargin || '240px 0px'
        });

        state.sectionObservers[stateKey].observe(section);
    }

    function formatearNumero(num) {
        return String(num).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }

    function normalizarTipoModalidadEnlace(tipo) {
        const valor = String(tipo || '').trim().toLowerCase();
        const tiposValidos = ['facebook', 'grupo_whatsapp', 'canal_whatsapp', 'whatsapp_personal', 'sin_enlace'];
        return tiposValidos.includes(valor) ? valor : 'facebook';
    }

    function construirUrlWhatsapp(valor) {
        const contenido = String(valor || '').trim();
        if (!contenido) return '';
        if (/^https?:\/\//i.test(contenido)) return contenido;

        const numero = contenido.replace(/\D/g, '');
        return numero ? `https://wa.me/${numero}` : '';
    }

    function normalizarUrlExterna(valor) {
        const contenido = String(valor || '').trim();
        if (!/^https?:\/\//i.test(contenido)) return '';

        try {
            return new URL(contenido).toString();
        } catch (error) {
            return '';
        }
    }

    function obtenerConfigModalidadInfo(config) {
        const redes = config?.cliente?.redesSociales || {};
        const tipo = normalizarTipoModalidadEnlace(config?.rifa?.modalidadEnlace?.tipo);
        const configuraciones = {
            facebook: {
                iconoHtml: '<i class="fab fa-facebook-f" style="color: #1877F2;"></i>',
                url: normalizarUrlExterna(redes.facebook),
                textoBoton: 'Ir a Facebook',
                color: '#1877F2',
                claseBoton: 'facebook'
            },
            grupo_whatsapp: {
                iconoHtml: '<i class="fab fa-whatsapp" style="color: #25D366;"></i>',
                url: normalizarUrlExterna(redes.grupoWhatsapp || redes.canalWhatsapp),
                textoBoton: 'Ir a WhatsApp',
                color: '#25D366',
                claseBoton: 'whatsapp'
            },
            canal_whatsapp: {
                iconoHtml: '<i class="fab fa-whatsapp" style="color: #25D366;"></i>',
                url: normalizarUrlExterna(redes.canalWhatsapp || redes.grupoWhatsapp),
                textoBoton: 'Ir a WhatsApp',
                color: '#25D366',
                claseBoton: 'whatsapp'
            },
            whatsapp_personal: {
                iconoHtml: '<i class="fab fa-whatsapp" style="color: #25D366;"></i>',
                url: construirUrlWhatsapp(redes.whatsapp),
                textoBoton: 'Ir a WhatsApp',
                color: '#25D366',
                claseBoton: 'whatsapp'
            },
            sin_enlace: {
                iconoHtml: '📡',
                url: '',
                textoBoton: '',
                color: 'var(--primary)',
                claseBoton: 'neutral'
            }
        };

        return {
            tipo,
            ...(configuraciones[tipo] || configuraciones.facebook)
        };
    }

    function renderizarTarjetasInfo() {
        const infoGrid = document.getElementById('infoRifaGrid');
        const config = window.rifaplusConfig;
        if (!infoGrid || !config?.rifa) {
            return false;
        }

        const rifa = config.rifa;
        const firmaTarjetas = {
            infoRifa: Array.isArray(rifa.infoRifa) ? rifa.infoRifa : [],
            fechaSorteoFormato: config.obtenerFechaSorteoFormato?.() || rifa.fechaSorteoFormato || '',
            fechaPresorteoFormato: config.obtenerFechaPresorteoFormato?.() || rifa.fechaPresorteoFormato || '',
            horaSorteo: rifa.horaSorteo || '',
            horaPresorteo: rifa.horaPresorteo || '',
            totalBoletos: rifa.totalBoletos || 0,
            modalidadSorteo: rifa.modalidadSorteo || '',
            modalidadEnlaceTipo: rifa.modalidadEnlace?.tipo || '',
            zonaHoraria: config.obtenerZonaHorariaLabel?.() || rifa.zonaHoraria || '',
            presorteo: Array.isArray(rifa.sistemaPremios?.presorteo) ? rifa.sistemaPremios.presorteo.length : 0,
            facebook: config.cliente?.redesSociales?.facebook || '',
            whatsapp: config.cliente?.redesSociales?.whatsapp || '',
            grupoWhatsapp: config.cliente?.redesSociales?.grupoWhatsapp || '',
            canalWhatsapp: config.cliente?.redesSociales?.canalWhatsapp || ''
        };

        if (!actualizarFirmaIndex('tarjetasInfoIndex', firmaTarjetas)) {
            return true;
        }

        infoGrid.innerHTML = '';

        let infoItems = [];
        const configItems = Array.isArray(rifa.infoRifa) ? rifa.infoRifa : [];
        const itemsSinFechaPrincipal = configItems.filter((item, index) => {
            if (index === 0) return false;
            const contenido = String(item?.contenido || '').trim();
            return !['dinamico-fecha-hora', 'dinamico-fecha', 'dinamico-hora'].includes(contenido);
        });

        const tarjetaFechaSorteo = {
            titulo: 'Fecha del Sorteo',
            icono: '🗓️',
            contenido: 'dinamico-fecha'
        };

        const tarjetaHoraSorteo = {
            titulo: 'Hora del Sorteo',
            icono: '⏰',
            contenido: 'dinamico-hora'
        };

        const tarjetaFechaHoraSorteo = {
            titulo: 'Fecha y Hora del Sorteo',
            icono: '🗓️',
            contenido: 'dinamico-fecha-hora'
        };

        const zonaHorariaLabel = config.obtenerZonaHorariaLabel?.() || rifa.zonaHoraria || '';
        const formatearFechaHoraPublica = (fechaFormateada, horaFormateada) => {
            const fechaTexto = String(fechaFormateada || '').trim();
            const horaTexto = String(horaFormateada || '').trim();
            const zonaTexto = String(zonaHorariaLabel || '').trim();

            if (fechaTexto && horaTexto && zonaTexto) return `${fechaTexto} a las ${horaTexto} (${zonaTexto})`;
            if (fechaTexto && horaTexto) return `${fechaTexto} a las ${horaTexto}`;
            if (horaTexto && zonaTexto) return `${horaTexto} (${zonaTexto})`;
            if (fechaTexto) return fechaTexto;
            if (horaTexto) return horaTexto;
            return zonaTexto || '';
        };

        const presorteoActivo = Array.isArray(rifa.sistemaPremios?.presorteo) && rifa.sistemaPremios.presorteo.length > 0;
        if (presorteoActivo) {
            const fechaPresorteoTexto = (() => {
                const fechaFormateada = config.obtenerFechaPresorteoFormato?.() || rifa.fechaPresorteoFormato;
                const horaFormateada = rifa.horaPresorteo;

                if (fechaFormateada && horaFormateada) return formatearFechaHoraPublica(fechaFormateada, horaFormateada);
                if (fechaFormateada) return fechaFormateada;
                if (horaFormateada) return `Hora por confirmar: ${formatearFechaHoraPublica('', horaFormateada)}`;
                return 'Fecha y hora por confirmar';
            })();

            infoItems = [
                tarjetaFechaHoraSorteo,
                { titulo: 'Presorteo', icono: '🎊', contenido: fechaPresorteoTexto },
                ...itemsSinFechaPrincipal.slice(0, 2)
            ];
        } else {
            infoItems = [
                tarjetaFechaSorteo,
                tarjetaHoraSorteo,
                ...itemsSinFechaPrincipal.slice(0, 2)
            ];
        }

        infoItems.forEach((item) => {
            const infoItem = document.createElement('div');
            infoItem.className = 'info-item';

            let contenido = item.contenido;
            if (contenido === 'dinamico-fecha') {
                contenido = config.obtenerFechaSorteoFormato?.() || config.rifa.fechaSorteoFormato;
            } else if (contenido === 'dinamico-hora') {
                contenido = formatearFechaHoraPublica('', config.rifa.horaSorteo);
            } else if (contenido === 'dinamico-fecha-hora') {
                contenido = formatearFechaHoraPublica(
                    config.obtenerFechaSorteoFormato?.() || config.rifa.fechaSorteoFormato,
                    config.rifa.horaSorteo
                );
            } else if (contenido === 'dinamico-modalidad') {
                contenido = config.rifa.modalidadSorteo;
            } else if (contenido === 'dinamico-boletos') {
                contenido = `<span id="total-boletos-info">${config.rifa.totalBoletos}</span> disponibles`;
            } else if (contenido === 'dinamico-emisiones') {
                contenido = `<span id="total-emisiones-info">${formatearNumero(config.rifa.totalBoletos)}</span>`;
            }

            const esModalidad = item.titulo === 'Modalidad del Sorteo' || item.titulo === 'Modalidad';
            if (esModalidad) {
                const modalidad = obtenerConfigModalidadInfo(config);
                const contenidoModalidad = contenido || 'Modalidad por confirmar';
                const ctaHtml = modalidad.url
                    ? `
                        <a
                            href="${modalidad.url}"
                            target="_blank"
                            rel="noopener noreferrer"
                            class="info-item-action-link info-item-action-link--${modalidad.claseBoton}"
                            style="--info-action-color: ${modalidad.color};"
                            aria-label="${modalidad.textoBoton}"
                        >
                            <span class="info-item-action-text">${modalidad.textoBoton}</span>
                        </a>
                    `
                    : '';
                infoItem.innerHTML = `
                    <span class="info-icon" aria-hidden="true">${modalidad.iconoHtml}</span>
                    <h3>${item.titulo}</h3>
                    <p>${contenidoModalidad}</p>
                    ${ctaHtml}
                `;
            } else {
                infoItem.innerHTML = `
                    <span class="info-icon" aria-hidden="true">${item.icono}</span>
                    <h3>${item.titulo}</h3>
                    <p>${contenido}</p>
                `;
            }

            infoGrid.appendChild(infoItem);
        });

        indexLog(`✅ [index-public] Tarjetas renderizadas: ${infoItems.length} items`);
        return true;
    }

    function cargarNombreEdicion() {
        const edicionEl = document.getElementById('edicionNombre');
        const rifa = obtenerRifaPublica();
        const edicionNombre = String(rifa?.edicionNombre || '').trim();

        if (!edicionEl || !edicionNombre) return;
        if (edicionEl.innerHTML === edicionNombre) return;

        edicionEl.innerHTML = edicionNombre;
        persistirDatoHero('rifaplus_index_hero_edicion', edicionNombre, 'edicion');
    }

    function cargarHeroContent() {
        const titleEl = document.getElementById('heroTitle');
        const descEl = document.getElementById('heroDescription');
        const rifa = obtenerRifaPublica();

        if (!titleEl || !descEl || !rifa) return;

        const nombreCompleto = String(rifa.nombreSorteo || '').trim();
        const descripcion = String(rifa.descripcion || '').trim();

        if (descripcion && descEl.textContent !== descripcion) {
            descEl.textContent = descripcion;
            persistirDatoHero('rifaplus_index_hero_descripcion', descripcion, 'descripcion');
        }

        if (nombreCompleto) {
            const tituloFinal = `<span class="highlight" id="heroHighlight">${nombreCompleto}</span>`;
            if (titleEl.innerHTML !== tituloFinal) {
                titleEl.innerHTML = tituloFinal;
                persistirDatoHero('rifaplus_index_hero_nombre', nombreCompleto, 'nombre');
            }
        }

        evaluarPaginaListaIndex();
    }

    function cancelarActualizacionPrecioUnitario() {
        if (state.precioRefreshTimeoutId) {
            clearTimeout(state.precioRefreshTimeoutId);
            state.precioRefreshTimeoutId = 0;
        }
    }

    function programarActualizacionPrecioUnitario(delay = 1000) {
        cancelarActualizacionPrecioUnitario();
        if (document.hidden) return;

        state.precioRefreshTimeoutId = window.setTimeout(() => {
            state.precioRefreshTimeoutId = 0;
            cargarPrecioUnitario();
        }, delay);
    }

    function cargarPrecioUnitario() {
        const precioEl = document.getElementById('precioDinamicoIndex');
        const textoOportunidadesEl = document.getElementById('oportunidadesTexto');
        const precioNormalDiv = document.getElementById('precioNormal');
        const precioOfertaDiv = document.getElementById('precioOferta');
        const ofertaVigenciaDiv = document.getElementById('ofertaVigencia');
        const precioBadgeIndex = document.getElementById('precioBadgeIndex');
        const precioBadgeIndexText = document.getElementById('precioBadgeIndexText');
        const precioSuperBadgeIndex = document.getElementById('precioSuperBadgeIndex');
        if (!precioEl) return;

        const rifa = obtenerRifaPublica();
        const precioBoleto = Number(window.rifaplusConfig?.obtenerPrecioBoleto?.() || rifa?.precioBoleto || 0);
        const ahora = new Date();
        let hayPromocionActiva = false;
        let precioEspecial = precioBoleto;
        let precioRegularReferencia = precioBoleto;
        let fechaFin = null;
        let tipoPromo = null;
        let badgePromo = 'OFERTA';
        let tituloPromo = 'Precio Especial';
        let kickerPromo = 'Promocion activa';
        let captionPromo = 'Aprovecha este precio antes de que termine';
        const resolverVentanaPromocion = (fechaInicio, fechaFin) => {
            const timeZone = String(rifa?.timeZone || rifa?.zonaHoraria || 'America/Mexico_City').trim() || 'America/Mexico_City';
            const validarRango = typeof window.rifaplusConfig?.esFechaPromocionActiva === 'function'
                ? window.rifaplusConfig.esFechaPromocionActiva
                : null;
            const parsearFecha = typeof window.rifaplusConfig?.parseFechaPromocion === 'function'
                ? window.rifaplusConfig.parseFechaPromocion
                : null;

            const inicio = parsearFecha ? parsearFecha(fechaInicio, timeZone) : new Date(fechaInicio);
            const fin = parsearFecha ? parsearFecha(fechaFin, timeZone) : new Date(fechaFin);
            const activa = validarRango
                ? validarRango(fechaInicio, fechaFin, ahora, timeZone)
                : !Number.isNaN(inicio.getTime()) && !Number.isNaN(fin.getTime()) && ahora >= inicio && ahora <= fin;

            return {
                activa: Boolean(activa),
                fin
            };
        };

        const promoTiempo = rifa?.promocionPorTiempo;
        if (promoTiempo?.enabled && promoTiempo?.precioProvisional) {
            const ventanaPromoTiempo = resolverVentanaPromocion(promoTiempo.fechaInicio, promoTiempo.fechaFin);
            const fechaFinPromo = ventanaPromoTiempo.fin;
            if (ventanaPromoTiempo.activa && !Number.isNaN(fechaFinPromo.getTime())) {
                precioEspecial = promoTiempo.precioProvisional;
                precioRegularReferencia = precioBoleto;
                fechaFin = fechaFinPromo;
                tipoPromo = 'tiempo';
                hayPromocionActiva = true;
            }
        }

        const descuentoPorcentaje = rifa?.descuentoPorcentaje;
        if (descuentoPorcentaje?.enabled && descuentoPorcentaje?.porcentaje) {
            const ventanaDescuento = resolverVentanaPromocion(descuentoPorcentaje.fechaInicio, descuentoPorcentaje.fechaFin);
            const fechaFinPorcentaje = ventanaDescuento.fin;
            if (ventanaDescuento.activa && !Number.isNaN(fechaFinPorcentaje.getTime())) {
                const descuento = (precioBoleto * descuentoPorcentaje.porcentaje) / 100;
                const precioConPorcentaje = precioBoleto - descuento;
                if (!hayPromocionActiva || precioConPorcentaje < precioEspecial) {
                    precioEspecial = precioConPorcentaje;
                    precioRegularReferencia = precioBoleto;
                    fechaFin = fechaFinPorcentaje;
                    tipoPromo = 'porcentaje';
                    hayPromocionActiva = true;
                    badgePromo = `${Math.round(((precioBoleto - precioEspecial) / precioBoleto) * 100)}% OFF`;
                }
            }
        }

        if (rifa?.promocionesCombo?.enabled === true && Array.isArray(rifa.promocionesCombo.reglas) && rifa.promocionesCombo.reglas.length > 0) {
            const comboDestacado = rifa.promocionesCombo.reglas
                .map((regla) => {
                    const cantidadRecibe = Number(regla?.cantidadRecibe ?? regla?.cantidadEntrega ?? regla?.cantidad ?? 0);
                    const cantidadPaga = Number(regla?.cantidadPaga ?? regla?.paga ?? regla?.compra ?? 0);
                    if (!Number.isFinite(cantidadRecibe) || !Number.isFinite(cantidadPaga) || cantidadRecibe <= 1 || cantidadPaga <= 0 || cantidadPaga >= cantidadRecibe) {
                        return null;
                    }
                    return {
                        cantidadRecibe,
                        cantidadPaga,
                        bonificados: cantidadRecibe - cantidadPaga,
                        etiqueta: `${cantidadRecibe}x${cantidadPaga}`
                    };
                })
                .filter(Boolean)
                .sort((a, b) => {
                    if (b.bonificados !== a.bonificados) return b.bonificados - a.bonificados;
                    if (a.cantidadPaga !== b.cantidadPaga) return a.cantidadPaga - b.cantidadPaga;
                    return b.cantidadRecibe - a.cantidadRecibe;
                })[0];

            if (comboDestacado) {
                hayPromocionActiva = true;
                tipoPromo = 'combo';
                precioRegularReferencia = comboDestacado.cantidadRecibe * precioBoleto;
                precioEspecial = comboDestacado.cantidadPaga * precioBoleto;
                fechaFin = null;
                kickerPromo = '';
                tituloPromo = comboDestacado.etiqueta;
                captionPromo = `Aprovecha super promocion ${comboDestacado.etiqueta}. Recibe ${comboDestacado.cantidadRecibe} boletos y paga ${comboDestacado.cantidadPaga}`;
            }
        }

        if (hayPromocionActiva) {
            if (tipoPromo === 'combo') {
                if (precioNormalDiv) precioNormalDiv.style.display = 'flex';
                if (precioOfertaDiv) precioOfertaDiv.style.display = 'none';
                if (ofertaVigenciaDiv) ofertaVigenciaDiv.style.display = 'none';
                if (precioBadgeIndex) precioBadgeIndex.style.display = 'flex';
                if (precioBadgeIndexText) precioBadgeIndexText.textContent = tituloPromo || 'PROMO';
                if (precioSuperBadgeIndex) precioSuperBadgeIndex.style.display = 'inline-flex';
                precioEl.innerHTML = `$${precioBoleto.toFixed(2)}`;
                programarActualizacionPrecioUnitario();
                return;
            }

            if (precioBadgeIndex) precioBadgeIndex.style.display = 'none';
            if (precioSuperBadgeIndex) precioSuperBadgeIndex.style.display = 'none';
            if (precioNormalDiv) precioNormalDiv.style.display = 'none';
            if (precioOfertaDiv) precioOfertaDiv.style.display = 'flex';

            const precioNormalOfertaEl = document.getElementById('precioNormalOferta');
            const precioEspecialOfertaEl = document.getElementById('precioEspecialOferta');
            const badgeText = document.querySelector('.oferta-badge-text');
            const kickerEl = precioOfertaDiv?.querySelector('.precio-kicker');
            const tituloEl = precioOfertaDiv?.querySelector('.oferta-precio-destacado h3');
            const precioRegularTituloEl = precioOfertaDiv?.querySelector('.oferta-precio-normal h4');
            const captionEl = document.querySelector('#precioCardMain .precio-caption');

            if (precioNormalOfertaEl) precioNormalOfertaEl.textContent = `$${precioRegularReferencia.toFixed(2)}`;
            if (precioEspecialOfertaEl) precioEspecialOfertaEl.textContent = `$${precioEspecial.toFixed(2)}`;
            if (badgeText) badgeText.textContent = badgePromo;
            if (kickerEl) {
                kickerEl.textContent = kickerPromo || '';
                kickerEl.style.display = kickerPromo ? '' : 'none';
            }
            if (tituloEl) tituloEl.textContent = tituloPromo;
            if (precioRegularTituloEl) {
                precioRegularTituloEl.textContent = 'Precio Regular';
                precioRegularTituloEl.style.display = '';
            }
            if (captionEl) captionEl.textContent = captionPromo;

            if (ofertaVigenciaDiv && fechaFin) {
                ofertaVigenciaDiv.style.display = 'flex';
                const vigenciaEl = document.getElementById('vigenciaOferta');
                if (vigenciaEl) {
                    const fechaFinal = new Date(fechaFin);
                    const dia = String(fechaFinal.getDate()).padStart(2, '0');
                    const mes = String(fechaFinal.getMonth() + 1).padStart(2, '0');
                    const anio = fechaFinal.getFullYear();
                    let hora = fechaFinal.getHours();
                    const minuto = String(fechaFinal.getMinutes()).padStart(2, '0');
                    const ampm = hora >= 12 ? 'PM' : 'AM';
                    hora = hora % 12 || 12;
                    const horaFormato = String(hora).padStart(2, '0');
                    vigenciaEl.textContent = `Vigencia hasta: ${dia}/${mes}/${anio} a las ${horaFormato}:${minuto} ${ampm}`;
                }
            }

            precioEl.innerHTML = `$${precioEspecial.toFixed(2)}`;
            programarActualizacionPrecioUnitario();
        } else {
            cancelarActualizacionPrecioUnitario();
            if (precioBadgeIndex) precioBadgeIndex.style.display = 'none';
            if (precioSuperBadgeIndex) precioSuperBadgeIndex.style.display = 'none';
            if (precioNormalDiv) precioNormalDiv.style.display = 'flex';
            if (precioOfertaDiv) precioOfertaDiv.style.display = 'none';
            if (ofertaVigenciaDiv) ofertaVigenciaDiv.style.display = 'none';
            precioEl.innerHTML = `$${precioBoleto.toFixed(2)}`;
        }

        if (rifa?.oportunidades?.enabled && rifa?.promocionesOportunidades?.enabled && textoOportunidadesEl) {
            const oportunidadesPorBoleto = Number(rifa.oportunidades?.multiplicador) > 0
                ? Number(rifa.oportunidades.multiplicador)
                : 1;
            textoOportunidadesEl.style.display = 'block';
            textoOportunidadesEl.textContent = `Cada boleto que compres te regala ${oportunidadesPorBoleto} oportunidades EXTRA de ganar`;
        } else if (textoOportunidadesEl) {
            textoOportunidadesEl.style.display = 'none';
        }
    }

    window.carruselState = window.carruselState || {
        currentIndex: 0,
        isInitialized: false,
        controlsBound: false,
        slides: [],
        autoAdvanceId: 0,
        resumeTimeoutId: 0,
        interactionBound: false,
        swipeState: {
            pointerId: null,
            pointerType: '',
            startX: 0,
            startY: 0,
            deltaX: 0,
            deltaY: 0,
            tracking: false
        }
    };

    function actualizarModoCarrusel(slideActivo) {
        const carrusel = document.querySelector('.carrusel');
        if (!carrusel || !slideActivo) return;
        carrusel.classList.toggle('carrusel--vertical-active', slideActivo.dataset.orientation === 'vertical');
    }

    function detenerAutoAdvanceCarrusel() {
        if (window.carruselState.resumeTimeoutId) {
            clearTimeout(window.carruselState.resumeTimeoutId);
            window.carruselState.resumeTimeoutId = 0;
        }

        if (window.carruselState.autoAdvanceId) {
            clearInterval(window.carruselState.autoAdvanceId);
            window.carruselState.autoAdvanceId = 0;
        }
    }

    function reanudarAutoAdvanceCarrusel(delay = 1200) {
        detenerAutoAdvanceCarrusel();
        if (document.hidden || window.carruselState.slides.length <= 1) return;

        window.carruselState.resumeTimeoutId = window.setTimeout(() => {
            window.carruselState.resumeTimeoutId = 0;
            reiniciarAutoAdvanceCarrusel();
        }, delay);
    }

    function resetearSwipeCarrusel() {
        window.carruselState.swipeState.pointerId = null;
        window.carruselState.swipeState.pointerType = '';
        window.carruselState.swipeState.startX = 0;
        window.carruselState.swipeState.startY = 0;
        window.carruselState.swipeState.deltaX = 0;
        window.carruselState.swipeState.deltaY = 0;
        window.carruselState.swipeState.tracking = false;
    }

    function mostrarSlideCarrusel(index) {
        const slides = window.carruselState.slides;
        if (!slides || slides.length === 0) return;

        if (index >= slides.length) index = 0;
        if (index < 0) index = slides.length - 1;

        window.carruselState.currentIndex = index;
        slides.forEach((slide) => slide.classList.remove('active'));
        slides[index].classList.add('active');
        actualizarModoCarrusel(slides[index]);
    }

    function reiniciarAutoAdvanceCarrusel() {
        detenerAutoAdvanceCarrusel();
        if (document.hidden || window.carruselState.slides.length <= 1) return;

        window.carruselState.autoAdvanceId = window.setInterval(() => {
            mostrarSlideCarrusel(window.carruselState.currentIndex + 1);
        }, 5000);
    }

    function inicializarCarruselControles() {
        const prevBtn = document.querySelector('.carrusel-prev');
        const nextBtn = document.querySelector('.carrusel-next');
        if (!prevBtn || !nextBtn || window.carruselState.slides.length === 0) return;

        if (!window.carruselState.controlsBound) {
            prevBtn.addEventListener('click', () => {
                mostrarSlideCarrusel(window.carruselState.currentIndex - 1);
                reiniciarAutoAdvanceCarrusel();
            });
            nextBtn.addEventListener('click', () => {
                mostrarSlideCarrusel(window.carruselState.currentIndex + 1);
                reiniciarAutoAdvanceCarrusel();
            });
            window.carruselState.controlsBound = true;
        }

        mostrarSlideCarrusel(0);
        window.carruselState.isInitialized = true;
        reiniciarAutoAdvanceCarrusel();
    }

    function inicializarInteraccionesCarrusel() {
        const carrusel = document.querySelector('.carrusel');
        if (!carrusel || window.carruselState.interactionBound) return;

        window.carruselState.interactionBound = true;

        carrusel.addEventListener('mouseenter', detenerAutoAdvanceCarrusel);
        carrusel.addEventListener('mouseleave', () => {
            reanudarAutoAdvanceCarrusel(250);
        });

        if (!window.PointerEvent) {
            carrusel.addEventListener('touchstart', detenerAutoAdvanceCarrusel, { passive: true });
            carrusel.addEventListener('touchend', () => {
                reanudarAutoAdvanceCarrusel(1800);
            }, { passive: true });
            carrusel.addEventListener('touchcancel', () => {
                reanudarAutoAdvanceCarrusel(1800);
            }, { passive: true });
            return;
        }

        carrusel.addEventListener('pointerdown', (event) => {
            if (event.pointerType === 'mouse' && event.button !== 0) {
                return;
            }

            window.carruselState.swipeState.pointerId = event.pointerId;
            window.carruselState.swipeState.pointerType = event.pointerType || 'mouse';
            window.carruselState.swipeState.startX = event.clientX;
            window.carruselState.swipeState.startY = event.clientY;
            window.carruselState.swipeState.deltaX = 0;
            window.carruselState.swipeState.deltaY = 0;
            window.carruselState.swipeState.tracking = true;

            detenerAutoAdvanceCarrusel();
        });

        carrusel.addEventListener('pointermove', (event) => {
            if (!window.carruselState.swipeState.tracking || event.pointerId !== window.carruselState.swipeState.pointerId) {
                return;
            }

            window.carruselState.swipeState.deltaX = event.clientX - window.carruselState.swipeState.startX;
            window.carruselState.swipeState.deltaY = event.clientY - window.carruselState.swipeState.startY;
        });

        const finalizarInteraccion = (event) => {
            if (!window.carruselState.swipeState.tracking || event.pointerId !== window.carruselState.swipeState.pointerId) {
                return;
            }

            const { deltaX, deltaY, pointerType } = window.carruselState.swipeState;
            const esSwipe = pointerType !== 'mouse'
                && Math.abs(deltaX) >= 40
                && Math.abs(deltaX) > Math.abs(deltaY) * 1.15;

            if (esSwipe) {
                mostrarSlideCarrusel(window.carruselState.currentIndex + (deltaX < 0 ? 1 : -1));
                reanudarAutoAdvanceCarrusel(4200);
            } else {
                reanudarAutoAdvanceCarrusel(pointerType === 'mouse' ? 250 : 1800);
            }

            resetearSwipeCarrusel();
        };

        carrusel.addEventListener('pointerup', finalizarInteraccion);
        carrusel.addEventListener('pointercancel', finalizarInteraccion);
        carrusel.addEventListener('pointerleave', (event) => {
            if (!window.carruselState.swipeState.tracking || event.pointerId !== window.carruselState.swipeState.pointerId) {
                return;
            }

            reanudarAutoAdvanceCarrusel(window.carruselState.swipeState.pointerType === 'mouse' ? 250 : 1800);
            resetearSwipeCarrusel();
        });
    }

    function cargarGaleria() {
        const imageDelivery = window.RifaPlusImageDelivery;
        const carruselInner = document.querySelector('.carrusel-inner');
        const carrusel = document.querySelector('.carrusel');
        const carruselSection = document.querySelector('.carrusel-section');
        const galeria = obtenerRifaPublica()?.galeria;

        if (!carruselInner || !carruselSection || !galeria) return;
        if (!galeria.enabled || !Array.isArray(galeria.imagenes) || galeria.imagenes.length === 0) {
            carruselSection.style.display = 'none';
            detenerAutoAdvanceCarrusel();
            evaluarPaginaListaIndex();
            return;
        }

        const firmaCarrusel = {
            enabled: galeria.enabled,
            imagenes: galeria.imagenes.map((imagen) => ({ url: imagen.url, titulo: imagen.titulo || '' }))
        };

        if (!actualizarFirmaIndex('galeriaIndex', firmaCarrusel)) {
            if (!document.hidden && window.carruselState.isInitialized) {
                reiniciarAutoAdvanceCarrusel();
            }
            evaluarPaginaListaIndex();
            return;
        }

        carruselSection.style.display = 'block';
        carruselInner.innerHTML = '';
        galeria.imagenes.forEach((imagen, index) => {
            const slide = document.createElement('div');
            slide.className = 'carrusel-item';
            if (index === 0) slide.classList.add('active');

            const img = document.createElement('img');
            img.alt = imagen.titulo || `Imagen ${index + 1}`;
            if (imageDelivery?.aplicarImagenOptimizada) {
                imageDelivery.aplicarImagenOptimizada(img, {
                    originalUrl: imagen.url,
                    profile: index === 0 ? 'carouselPreload' : 'carousel',
                    widths: [480, 768, 960, 1280, 1600],
                    sizes: '(max-width: 768px) 100vw, min(92vw, 1200px)',
                    loading: index === 0 ? 'eager' : 'lazy',
                    fetchPriority: index === 0 ? 'high' : 'low',
                    decoding: 'async'
                });
            } else {
                img.src = imagen.url;
                img.loading = index === 0 ? 'eager' : 'lazy';
                img.fetchPriority = index === 0 ? 'high' : 'low';
                img.decoding = 'async';
            }
            img.onload = () => {
                slide.dataset.orientation = img.naturalHeight > img.naturalWidth ? 'vertical' : 'horizontal';
                if (slide.classList.contains('active')) {
                    actualizarModoCarrusel(slide);
                }
                evaluarPaginaListaIndex();
            };

            slide.appendChild(img);
            carruselInner.appendChild(slide);
        });

        if (carrusel) {
            carrusel.classList.remove('carrusel--vertical-active');
        }

        window.carruselState.slides = Array.from(carruselInner.querySelectorAll('.carrusel-item'));
        window.carruselState.currentIndex = 0;
        inicializarInteraccionesCarrusel();
        inicializarCarruselControles();
        evaluarPaginaListaIndex();

        try {
            const galleryCache = galeria.imagenes
                .map((imagen) => ({
                    url: String(imagen?.url || '').trim(),
                    titulo: String(imagen?.titulo || '').trim()
                }))
                .filter((imagen) => imagen.url)
                .slice(0, 6);

            if (galleryCache.length > 0) {
                localStorage.setItem('rifaplus_cached_gallery_v1', JSON.stringify(galleryCache));
                window.__RIFAPLUS_CACHED_GALERIA__ = galleryCache;
            }
        } catch (error) {
            indexWarn('No se pudo cachear la galeria para carga rapida:', error);
        }
    }

    function cargarPreciosYDescuentos() {
        const panel = document.getElementById('preciosPromosPanel');
        const preciosGrid = document.getElementById('preciosGrid');
        const oportunidadesGrid = document.getElementById('indexOportunidadesGrid');
        const descuentosBlock = document.getElementById('indexDescuentosBlock');
        const oportunidadesBlock = document.getElementById('indexOportunidadesBlock');
        const descuentosSub = document.getElementById('indexDescuentosSub');
        const oportunidadesSub = document.getElementById('indexOportunidadesSub');
        const config = obtenerRifaPublica();
        if (!panel || !preciosGrid || !oportunidadesGrid || !descuentosBlock || !oportunidadesBlock || !config) return;

        const firmaPromociones = {
            descuentos: config.descuentos || null,
            promocionesCombo: config.promocionesCombo || null,
            promocionesOportunidades: config.promocionesOportunidades || null,
            oportunidades: config.oportunidades || null
        };
        if (!actualizarFirmaIndex('preciosYDescuentosIndex', firmaPromociones)) return;

        preciosGrid.innerHTML = '';
        oportunidadesGrid.innerHTML = '';
        let tarjetasDescuento = 0;
        let tarjetasOportunidad = 0;
        const oportunidadesPromosActivas = config.oportunidades?.enabled === true
            && config.promocionesOportunidades?.enabled === true
            && Array.isArray(config.promocionesOportunidades?.ejemplos)
            && config.promocionesOportunidades.ejemplos.length > 0;

        const aplicarLayoutPreciosGrid = (grid) => {
            if (!grid) return;
            grid.classList.remove(
                'precios-grid-promos--1',
                'precios-grid-promos--2',
                'precios-grid-promos--3',
                'precios-grid-promos--4',
                'precios-grid-promos--many'
            );
            const totalCards = grid.children.length;
            if (totalCards === 1) grid.classList.add('precios-grid-promos--1');
            else if (totalCards === 2) grid.classList.add('precios-grid-promos--2');
            else if (totalCards === 3) grid.classList.add('precios-grid-promos--3');
            else if (totalCards === 4) grid.classList.add('precios-grid-promos--4');
            else if (totalCards > 4) grid.classList.add('precios-grid-promos--many');
        };

        if (config.descuentos?.enabled && config.descuentos?.reglas?.length > 0) {
            const reglasOrdenadas = [...config.descuentos.reglas]
                .map((regla) => ({
                    cantidad: Number(regla?.cantidad),
                    total: Number(regla?.total ?? regla?.precio ?? 0)
                }))
                .filter((regla) => Number.isFinite(regla.cantidad) && regla.cantidad > 0 && Number.isFinite(regla.total) && regla.total > 0)
                .sort((a, b) => a.cantidad - b.cantidad);

            reglasOrdenadas.forEach((regla) => {
                const precioCard = document.createElement('div');
                precioCard.className = 'promo-card-grande descuento-card';
                const totalPaquete = Number(regla.total ?? regla.precio ?? 0);
                precioCard.innerHTML = `
                    <div class="promo-card-body">
                        <span class="promo-card-tag">Promocion</span>
                        <div class="promo-card-cantidad">${regla.cantidad} Boletos</div>
                        <div class="promo-card-label">Solo por:</div>
                        <div class="promo-card-precio">$${totalPaquete}</div>
                    </div>
                    <button class="btn btn-secondary promo-card-btn" onclick="window.location.href='compra.html'">Comprar Ahora</button>
                `;
                preciosGrid.appendChild(precioCard);
                tarjetasDescuento++;
            });
        }

        if (oportunidadesPromosActivas) {
            const ejemplosOrdenados = [...config.promocionesOportunidades.ejemplos]
                .map((ejemplo) => ({
                    boletos: Number(ejemplo?.boletos),
                    oportunidades: Number(ejemplo?.oportunidades)
                }))
                .filter((ejemplo) => Number.isFinite(ejemplo.boletos) && ejemplo.boletos > 0 && Number.isFinite(ejemplo.oportunidades) && ejemplo.oportunidades > 0)
                .sort((a, b) => a.boletos - b.boletos);

            ejemplosOrdenados.forEach((ejemplo) => {
                const oportunidadCard = document.createElement('div');
                oportunidadCard.className = 'promo-card-grande oportunidad-card';
                oportunidadCard.innerHTML = `
                    <div class="promo-card-body">
                        <div class="promo-card-cantidad">${ejemplo.boletos} Boleto${ejemplo.boletos > 1 ? 's' : ''}</div>
                        <div class="promo-card-equals">=</div>
                        <div class="promo-card-precio promo-card-precio--dark">${ejemplo.oportunidades} Oportunidade${ejemplo.oportunidades > 1 ? 's' : ''}</div>
                    </div>
                    <button class="btn btn-secondary promo-card-btn" onclick="window.location.href='compra.html'">Comprar Ahora</button>
                `;
                oportunidadesGrid.appendChild(oportunidadCard);
                tarjetasOportunidad++;
            });
        }

        const multiplicador = Number(config.oportunidades?.multiplicador) > 0
            ? Number(config.oportunidades.multiplicador)
            : 1;

        if (descuentosSub) {
            descuentosSub.textContent = 'Llevate mas boletos por un mejor precio.';
        }

        if (oportunidadesSub) {
            oportunidadesSub.textContent = 'Cada boleto multiplica tus posibilidades de ganar.';
        }

        if (tarjetasDescuento === 0 && tarjetasOportunidad === 0) {
            panel.style.display = 'none';
            descuentosBlock.style.display = 'none';
            oportunidadesBlock.style.display = 'none';
            preciosGrid.style.display = 'none';
            oportunidadesGrid.style.display = 'none';
            return;
        }

        panel.style.display = '';

        if (tarjetasOportunidad > 0) {
            oportunidadesBlock.style.display = '';
            oportunidadesGrid.style.display = 'grid';
            aplicarLayoutPreciosGrid(oportunidadesGrid);
        } else {
            oportunidadesBlock.style.display = 'none';
            oportunidadesGrid.style.display = 'none';
        }

        if (tarjetasDescuento > 0) {
            descuentosBlock.style.display = '';
            preciosGrid.style.display = 'grid';
            aplicarLayoutPreciosGrid(preciosGrid);
        } else {
            descuentosBlock.style.display = 'none';
            preciosGrid.style.display = 'none';
        }
    }

    function renderizarBonos() {
        const bonosSection = document.getElementById('bonosSection');
        const bonosGrid = document.getElementById('bonosGrid');
        const config = obtenerRifaPublica()?.bonos;
        if (!bonosSection || !bonosGrid || !config) return;

        const firmaBonos = {
            enabled: config.enabled === true,
            items: Array.isArray(config.items) ? config.items : []
        };
        if (!actualizarFirmaIndex('bonosIndex', firmaBonos)) return;

        if (!config.enabled) {
            bonosSection.style.display = 'none';
            return;
        }

        bonosSection.style.display = 'block';
        bonosGrid.innerHTML = '';

        const esBonoCanalWhatsappPrimario = (bono) => {
            const texto = `${bono?.titulo || ''} ${bono?.descripcion || ''}`.toLowerCase();
            const color = String(bono?.color || 'primary').trim().toLowerCase();
            const mencionaWhatsapp = texto.includes('whatsapp');
            const mencionaCanal = texto.includes('canal');
            return color === 'primary' && mencionaWhatsapp && mencionaCanal;
        };

        if (Array.isArray(config.items)) {
            config.items.forEach((bono) => {
                const colorMap = {
                    success: 'bono-success',
                    warning: 'bono-warning',
                    info: 'bono-info',
                    primary: 'bono-primary'
                };

                const bonoCard = document.createElement('div');
                bonoCard.className = `bono-card ${colorMap[bono.color] || 'bono-primary'}`;
                let contenido = `
                    <div class="bono-icono">${bono.emoji || '✔️'}</div>
                    <div class="bono-header">
                        <span class="bono-badge">Bono especial</span>
                        <p class="bono-titulo">${bono.titulo}</p>
                        <p class="bono-descripcion">${bono.descripcion}</p>
                    </div>
                `;

                const whatsappUrl = normalizarUrlExterna(obtenerClientePublico()?.redesSociales?.canalWhatsapp);
                const esBonoWhatsappPrimario = esBonoCanalWhatsappPrimario(bono);
                const mostrarBotonCanalWhatsapp = Boolean(whatsappUrl) && esBonoWhatsappPrimario;

                if (mostrarBotonCanalWhatsapp) {
                    contenido += `
                        <div class="bono-accion">
                            <a href="${whatsappUrl}" target="_blank" rel="noopener noreferrer" class="bono-btn-whatsapp bono-btn-whatsapp--compact">
                                <i class="fab fa-whatsapp"></i>
                                Unirse
                            </a>
                        </div>
                    `;
                }

                bonoCard.innerHTML = contenido;
                bonosGrid.appendChild(bonoCard);
            });
        }
    }

    function renderizarInformacionDelSorteo() {
        const container = document.getElementById('descripcionTextoDinamico');
        const informacion = obtenerRifaPublica()?.informacionSorteo;
        if (!container || !Array.isArray(informacion)) return;
        if (!actualizarFirmaIndex('informacionSorteoIndex', informacion)) return;

        container.innerHTML = '';
        informacion.forEach((item) => {
            try {
                const titulo = String(item.titulo || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                const descripcion = String(item.descripcion || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                container.insertAdjacentHTML('beforeend', `
                    <div class="descripcion-seccion">
                        <h3>${titulo}</h3>
                        <p>${descripcion}</p>
                    </div>
                `);
            } catch (error) {
                indexWarn('Error renderizando elemento:', error);
            }
        });
    }

    function renderizarInformacionSorteoIntro() {
        const container = document.getElementById('descripcionIntro');
        const introText = obtenerRifaPublica()?.informacionSorteoIntro;
        if (!container || !introText) return;
        if (!actualizarFirmaIndex('informacionSorteoIntroIndex', introText)) return;

        try {
            container.innerHTML = `<p>${String(introText).replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`;
        } catch (error) {
            indexWarn('Error renderizando intro del sorteo:', error);
        }
    }

    function aplicarVisibilidadConfianza() {
        const section = document.getElementById('confianzaSection');
        if (!section) return;

        const publicacion = obtenerRifaPublica()?.publicacion || {};
        section.style.display = publicacion.confianza !== false ? '' : 'none';
    }

    function actualizarMensajeCompras() {
        const el = document.getElementById('compras-mensaje');
        const rifa = window.rifaplusConfig?.rifa;
        if (!el || !rifa) return;

        const boletosVendidosTexto = document.getElementById('boletos-vendidos')?.textContent || '0';
        const boletosVendidos = parseInt(boletosVendidosTexto.replace(/[^\d]/g, ''), 10) || 0;
        const totalBoletos = typeof window.rifaplusConfig?.obtenerTotalBoletos === 'function'
            ? window.rifaplusConfig.obtenerTotalBoletos()
            : (rifa.totalBoletos || 0);

        let mensaje = 'Miles de personas confían en nosotros cada día';
        if (boletosVendidos > 0) {
            const porcentaje = totalBoletos > 0 ? (boletosVendidos / totalBoletos * 100).toFixed(0) : '0';
            if (boletosVendidos < 10) mensaje = `¡${boletosVendidos} personas ya compraron hoy! ¿Será tu día de suerte?`;
            else if (boletosVendidos < 50) mensaje = `¡${boletosVendidos} compradores ya participan! Únete ahora`;
            else if (boletosVendidos < 100) mensaje = `🔥 ¡${boletosVendidos} personas compradas y contando! La emoción sube`;
            else mensaje = `🎉 ¡Más de ${boletosVendidos} personas ya participan! (${porcentaje}% del total)`;
        }

        el.textContent = mensaje;
    }

    const actualizarMensajeComprasDebounced = (() => {
        let frameId = 0;
        return () => {
            if (frameId) cancelAnimationFrame(frameId);
            frameId = requestAnimationFrame(() => {
                frameId = 0;
                actualizarMensajeCompras();
            });
        };
    })();

    function obtenerPaletaGanadoresIndex(tipo) {
        const paletas = {
            sorteo: {
                titulo: 'Ganadores del sorteo',
                resumen: 'Resultados principales confirmados oficialmente.',
                icono: '<i class="fas fa-trophy" aria-hidden="true"></i>',
                headerColor1: 'var(--primary)',
                color: 'var(--primary)'
            },
            presorteo: {
                titulo: 'Ganadores del presorteo',
                resumen: 'Premios previos ya declarados y visibles para todos.',
                icono: '<i class="fas fa-gift" aria-hidden="true"></i>',
                headerColor1: 'var(--primary)',
                color: 'var(--primary)'
            },
            ruletazos: {
                titulo: 'Ganadores de ruletazos',
                resumen: 'Dinámicas activas resueltas antes del cierre final.',
                icono: '<i class="fas fa-star" aria-hidden="true"></i>',
                headerColor1: 'var(--primary)',
                color: 'var(--primary)'
            }
        };

        return paletas[tipo] || paletas.sorteo;
    }

    function formatearFechaDeclaracionGanadorIndex(fechaFuente) {
        if (!fechaFuente) return '';
        try {
            const fecha = new Date(fechaFuente);
            if (Number.isNaN(fecha.getTime())) return '';
            return fecha.toLocaleDateString('es-MX', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit'
            });
        } catch (error) {
            return '';
        }
    }

    function formatearNumeroGanadorIndex(numero) {
        if (numero === null || numero === undefined || numero === '') return 'N/A';
        if (typeof window.rifaplusConfig?.formatearNumeroBoleto === 'function') {
            const numeroNormalizado = Number(numero);
            if (Number.isFinite(numeroNormalizado)) {
                return window.rifaplusConfig.formatearNumeroBoleto(numeroNormalizado);
            }
        }
        return String(numero);
    }

    function obtenerLugarGanadorIndex(tipo, ganador, idx) {
        const posicion = Number(ganador.lugarGanado || ganador.posicion) || (idx + 1);
        if (tipo === 'sorteo') {
            return `${posicion}° lugar`;
        }
        if (tipo === 'presorteo') {
            return `Lugar ${posicion}`;
        }
        return `Ruletazo ${posicion}`;
    }

    function construirNombreGanadorIndex(ganador) {
        return [
            ganador.nombre_ganador,
            ganador.nombre_cliente,
            ganador.apellido_cliente
        ].filter(Boolean).join(' ').trim() || ganador.nombre || 'Ganador confirmado';
    }

    function construirMetaGanadorIndex(ganador) {
        const ciudad = String(ganador.ciudad || ganador.ciudad_cliente || '').trim();
        const estado = String(ganador.estado_cliente || '').trim();
        return [ciudad, estado].filter(Boolean);
    }

    function mapearGanadorServidorIndex(row = {}, idx = 0) {
        return {
            numero: String(row.numero_boleto || row.numero || row.numero_orden || ''),
            numero_boleto: row.numero_boleto ?? row.numero ?? row.numero_orden ?? '',
            posicion: row.posicion || (idx + 1),
            lugarGanado: row.posicion || null,
            nombre_ganador: row.nombre_ganador || '',
            nombre_cliente: row.nombre_cliente || '',
            apellido_cliente: row.apellido_cliente || '',
            ciudad: row.ciudad || '',
            ciudad_cliente: row.ciudad_cliente || '',
            estado_cliente: row.estado_cliente || '',
            fechaDeclaracion: row.fecha_sorteo || row.created_at || ''
        };
    }

    function tipoGanadorVisibleEnIndex(tipo) {
        const publicacion = obtenerRifaPublica()?.publicacion || {};
        if (tipo === 'presorteo') return publicacion.presorteo !== false;
        if (tipo === 'ruletazos') return publicacion.ruletazo !== false;
        return true;
    }

    async function renderizarSeccionGanadores() {
        const seccion = document.getElementById('seccionGanadores');
        const contenedor = document.getElementById('ganadoresContenedor');
        const lead = document.getElementById('ganadoresLead');
        if (!seccion || !contenedor) return;

        try {
            let rows = [];
            if (window.GanadoresManager?.obtenerGanadoresServidor) {
                rows = await window.GanadoresManager.obtenerGanadoresServidor(500);
            } else {
                const apiBase = window.rifaplusConfig?.backend?.apiBase
                    || window.rifaplusConfig?.obtenerApiBase?.()
                    || window.location.origin;
                const res = await fetch(`${apiBase}/api/ganadores?limit=500`);
                if (!res.ok) throw new Error('no_server');
                const payload = await res.json();
                rows = payload?.data || [];
            }

            if (!Array.isArray(rows) || rows.length === 0) {
                seccion.style.display = 'none';
                return;
            }

            const mapped = { sorteo: [], presorteo: [], ruletazos: [] };
            rows.forEach((row, idx) => {
                const tipoRaw = String(row.tipo_ganador || '').toLowerCase();
                let key = 'sorteo';
                if (tipoRaw.includes('presorte')) key = 'presorteo';
                else if (tipoRaw.includes('rulet')) key = 'ruletazos';
                mapped[key].push(mapearGanadorServidorIndex(row, idx));
            });

            Object.keys(mapped).forEach((tipo) => {
                mapped[tipo].sort((a, b) => {
                    const lugarA = Number(a.lugarGanado || a.posicion) || 999;
                    const lugarB = Number(b.lugarGanado || b.posicion) || 999;
                    return lugarA - lugarB;
                });
            });

            if (!actualizarFirmaIndex('ganadoresIndex', mapped)) return;

            contenedor.innerHTML = '';
            let totalVisibles = 0;

            ['sorteo', 'presorteo', 'ruletazos'].forEach((tipo) => {
                if (!tipoGanadorVisibleEnIndex(tipo)) return;
                const arr = mapped[tipo];
                if (!arr || arr.length === 0) return;
                totalVisibles += arr.length;

                const paleta = obtenerPaletaGanadoresIndex(tipo);

                const tipoSeccion = document.createElement('div');
                tipoSeccion.className = 'ganadores-por-tipo';
                tipoSeccion.style.setProperty('--header-color-1', paleta.headerColor1);
                tipoSeccion.style.setProperty('--header-color-2', paleta.headerColor2);
                tipoSeccion.style.setProperty('--ganador-color', paleta.color);
                tipoSeccion.innerHTML = `
                    <div class="ganadores-tipo-header">
                        <h3>
                            <span class="ganadores-tipo-icono">${paleta.icono}</span>
                            <span>${paleta.titulo}</span>
                        </h3>
                        <div class="ganadores-tipo-counter">${arr.length} confirmado${arr.length > 1 ? 's' : ''}</div>
                    </div>
                    <div class="ganadores-lista">
                        ${arr.map((ganador, idx) => {
                            const numeroFormateado = formatearNumeroGanadorIndex(ganador.numero_boleto || ganador.numero);
                            const lugar = obtenerLugarGanadorIndex(tipo, ganador, idx);
                            const nombre = construirNombreGanadorIndex(ganador);
                            const meta = construirMetaGanadorIndex(ganador);
                            const fechaDeclaracion = formatearFechaDeclaracionGanadorIndex(ganador.fechaDeclaracion);

                            return `
                                <div class="ganador-card">
                                    <div class="ganador-header">
                                        <div class="ganador-numero-badge"><i class="fas fa-ticket-alt" aria-hidden="true"></i><span>${numeroFormateado}</span></div>
                                        <div class="ganador-lugar">${lugar}</div>
                                    </div>
                                    <div class="ganador-body">
                                        <p class="ganador-nombre">${nombre}</p>
                                        ${meta.length > 0 ? `
                                            <div class="ganador-meta">
                                                ${meta.map((parte) => `<span>${parte}</span>`).join('<span>·</span>')}
                                            </div>
                                        ` : `<div class="ganador-meta"><span>${paleta.resumen}</span></div>`}
                                    </div>
                                    ${fechaDeclaracion ? `<div class="ganador-fecha">${fechaDeclaracion}</div>` : ''}
                                </div>
                            `;
                        }).join('')}
                    </div>
                `;
                contenedor.appendChild(tipoSeccion);
            });

            if (totalVisibles === 0) {
                seccion.style.display = 'none';
                return;
            }

            if (lead) {
                lead.textContent = totalVisibles === 1
                    ? 'Ya hay un ganador confirmado publicado oficialmente en este sorteo.'
                    : `Ya hay ${totalVisibles} ganadores confirmados publicados oficialmente en este sorteo.`;
            }

            seccion.style.display = 'block';
        } catch (error) {
            indexWarn('[index] Error fetching ganadores from server, hiding section', error);
            seccion.style.display = 'none';
        }
    }

    function renderizarRedesSociales() {
        const contactoGrid = document.getElementById('contactoGrid');
        const footerSocial = document.getElementById('footerSocial');
        const redes = obtenerClientePublico()?.redesSociales || null;

        if ((!contactoGrid && !footerSocial) || !redes) return;
        if (!actualizarFirmaIndex('redesSocialesIndex', redes)) return;

        if (contactoGrid) {
            contactoGrid.innerHTML = '';

            if (redes.canalWhatsapp) {
                const whatsappCard = document.createElement('div');
                whatsappCard.className = 'contacto-icono-btn';
                whatsappCard.innerHTML = `
                    <i class="fab fa-whatsapp contacto-icon-grande"></i>
                    <span class="contacto-nombre-usuario">Canal ${redes.canalWhatsappNombre || 'WhatsApp'}</span>
                    <a href="${redes.canalWhatsapp}" class="btn btn-contacto" target="_blank">Unirte</a>
                `;
                contactoGrid.appendChild(whatsappCard);
            }

            if (redes.facebook) {
                const facebookCard = document.createElement('div');
                facebookCard.className = 'contacto-icono-btn';
                facebookCard.innerHTML = `
                    <i class="fab fa-facebook-f contacto-icon-grande"></i>
                    <span class="contacto-nombre-usuario">${redes.facebookUsuario || 'Facebook'}</span>
                    <a href="${redes.facebook}" class="btn btn-contacto" target="_blank">Seguir</a>
                `;
                contactoGrid.appendChild(facebookCard);
            }

            if (redes.instagram) {
                const instagramCard = document.createElement('div');
                instagramCard.className = 'contacto-icono-btn';
                instagramCard.innerHTML = `
                    <i class="fab fa-instagram contacto-icon-grande"></i>
                    <span class="contacto-nombre-usuario">${redes.instagramUsuario || 'Instagram'}</span>
                    <a href="${redes.instagram}" class="btn btn-contacto" target="_blank">Seguir</a>
                `;
                contactoGrid.appendChild(instagramCard);
            }
        }

        if (footerSocial) {
            footerSocial.innerHTML = '';

            if (redes.facebook) {
                const facebookLink = document.createElement('a');
                facebookLink.href = redes.facebook;
                facebookLink.target = '_blank';
                facebookLink.title = 'Facebook';
                facebookLink.innerHTML = '<i class="fab fa-facebook-f"></i>';
                footerSocial.appendChild(facebookLink);
            }
            if (redes.instagram) {
                const instagramLink = document.createElement('a');
                instagramLink.href = redes.instagram;
                instagramLink.target = '_blank';
                instagramLink.title = 'Instagram';
                instagramLink.innerHTML = '<i class="fab fa-instagram"></i>';
                footerSocial.appendChild(instagramLink);
            }
            if (redes.whatsapp) {
                const whatsappLink = document.createElement('a');
                whatsappLink.href = `https://wa.me/${redes.whatsapp.replace(/\D/g, '')}`;
                whatsappLink.target = '_blank';
                whatsappLink.title = 'WhatsApp';
                whatsappLink.innerHTML = '<i class="fab fa-whatsapp"></i>';
                footerSocial.appendChild(whatsappLink);
            }
            if (redes.tiktok) {
                const tiktokLink = document.createElement('a');
                tiktokLink.href = redes.tiktok;
                tiktokLink.target = '_blank';
                tiktokLink.title = 'TikTok';
                tiktokLink.innerHTML = '<i class="fab fa-tiktok"></i>';
                footerSocial.appendChild(tiktokLink);
            }
        }
    }

    function actualizarFooterPublico() {
        const cliente = obtenerClientePublico();
        if (!cliente) return;

        if (typeof window.rifaplusConfig?.actualizarNombreClienteEnUI === 'function') {
            window.rifaplusConfig.actualizarNombreClienteEnUI();
        }

        const footerEslogan = document.getElementById('footerEslogan');
        if (footerEslogan) {
            footerEslogan.textContent = cliente.eslogan || 'Rifas 100% Transparentes y Seguras';
        }

        const logoLink = document.getElementById('logoLink');
        if (logoLink) {
            logoLink.href = './index.html';
            logoLink.target = '_self';
            logoLink.setAttribute('aria-label', 'Ir a la página de inicio');
        }

        const footerEmail = document.getElementById('footerEmail');
        if (footerEmail && cliente.email) {
            footerEmail.href = `mailto:${cliente.email}`;
            footerEmail.textContent = cliente.email;
        }

        const footerTelefono = document.getElementById('footerTelefono');
        if (footerTelefono && cliente.telefono) {
            footerTelefono.href = `tel:${cliente.telefono.replace(/[^0-9+]/g, '')}`;
            footerTelefono.textContent = cliente.telefono;
        }

        renderizarRedesSociales();
    }

    function animarEntradaBotonFlotante() {
        const btnFlotante = document.querySelector('.btn-flotante-comprobante');
        if (!btnFlotante) return;

        btnFlotante.classList.add('bounce-animate');
        if (state.footerBounceTimerId) {
            clearTimeout(state.footerBounceTimerId);
        }
        state.footerBounceTimerId = window.setTimeout(() => {
            btnFlotante.classList.remove('bounce-animate');
            state.footerBounceTimerId = 0;
        }, 2000);
    }

    function actualizarContenidoIndexCritico() {
        renderizarTarjetasInfo();
        cargarNombreEdicion();
        cargarHeroContent();
        cargarPrecioUnitario();
        cargarPreciosYDescuentos();
    }

    function actualizarContenidoIndexSecundario() {
        renderizarInformacionDelSorteo();
        renderizarInformacionSorteoIntro();
        cargarGaleria();
        aplicarVisibilidadConfianza();
        renderizarRedesSociales();
        actualizarFooterPublico();
        activarRenderDiferidoEnMovil('bonosSection', renderizarBonos, { stateKey: 'bonos' });
        activarRenderDiferidoEnMovil('seccionGanadores', renderizarSeccionGanadores, { stateKey: 'ganadores', rootMargin: '340px 0px' });
    }

    function cancelarRenderSecundarioIndex() {
        if (state.secondaryRenderFrameId) {
            cancelAnimationFrame(state.secondaryRenderFrameId);
            state.secondaryRenderFrameId = 0;
        }
        if (state.secondaryRenderIdleId) {
            const cancelIdle = window.cancelIdleCallback || clearTimeout;
            cancelIdle(state.secondaryRenderIdleId);
            state.secondaryRenderIdleId = 0;
        }
    }

    function programarActualizacionIndexSecundaria() {
        cancelarRenderSecundarioIndex();
        state.secondaryRenderFrameId = requestAnimationFrame(() => {
            state.secondaryRenderFrameId = 0;
            const idle = window.requestIdleCallback || ((cb) => setTimeout(cb, 180));
            state.secondaryRenderIdleId = idle(() => {
                state.secondaryRenderIdleId = 0;
                actualizarContenidoIndexSecundario();
            }, { timeout: 1200 });
        });
    }

    function configurarObservadorBoletos() {
        if (state.boletosObserver) return;

        state.boletosObserver = new MutationObserver(() => {
            actualizarMensajeCompras();
        });

        const boletosVendidosEl = document.getElementById('boletos-vendidos');
        if (boletosVendidosEl) {
            state.boletosObserver.observe(boletosVendidosEl, { childList: true, characterData: true, subtree: true });
        }
    }

    function manejarVisibilidadPagina() {
        if (document.hidden) {
            cancelarActualizacionPrecioUnitario();
            detenerAutoAdvanceCarrusel();
            return;
        }

        cargarPrecioUnitario();
        reiniciarAutoAdvanceCarrusel();
        programarActualizacionIndexSecundaria();
    }

    function onConfigRefresh() {
        state.pageReadyEmitida = false;
        actualizarContenidoIndexCritico();
        programarActualizacionIndexSecundaria();
        actualizarMensajeComprasDebounced();
        evaluarPaginaListaIndex();
    }

    function inicializar() {
        if (state.initialized) {
            onConfigRefresh();
            return;
        }

        state.initialized = true;
        actualizarContenidoIndexCritico();
        programarActualizacionIndexSecundaria();
        actualizarFooterPublico();
        animarEntradaBotonFlotante();
        actualizarMensajeComprasDebounced();
        configurarObservadorBoletos();
        evaluarPaginaListaIndex();

        window.addEventListener('configSyncCompleto', onConfigRefresh);
        window.addEventListener('configuracionActualizada', onConfigRefresh);
        window.addEventListener('boletosListos', actualizarMensajeComprasDebounced);
        window.addEventListener('estadoActualizado', actualizarMensajeComprasDebounced);
        document.addEventListener('visibilitychange', manejarVisibilidadPagina);
        window.addEventListener('ganadoresActualizados', () => activarRenderDiferidoEnMovil('seccionGanadores', renderizarSeccionGanadores, { stateKey: 'ganadores', rootMargin: '340px 0px' }));
        window.addEventListener('ganadesoresActualizados', () => activarRenderDiferidoEnMovil('seccionGanadores', renderizarSeccionGanadores, { stateKey: 'ganadores', rootMargin: '340px 0px' }));
        window.addEventListener('storage', (event) => {
            try {
                const expected = window.GanadoresManager?.STORAGE_KEY;
                if (event.key && expected && event.key === expected) {
                    activarRenderDiferidoEnMovil('seccionGanadores', renderizarSeccionGanadores, { stateKey: 'ganadores', rootMargin: '340px 0px' });
                }
            } catch (error) {
                indexWarn('No se pudo sincronizar ganadores desde storage:', error);
            }
        });
    }

    window.renderizarTarjetasInfo = renderizarTarjetasInfo;
    window.renderizarBonos = renderizarBonos;
    window.renderizarInformacionDelSorteo = renderizarInformacionDelSorteo;
    window.renderizarInformacionSorteoIntro = renderizarInformacionSorteoIntro;
    window.renderizarSeccionGanadores = renderizarSeccionGanadores;
    window.renderizarRedesSociales = renderizarRedesSociales;
    window.actualizarFooterPublico = actualizarFooterPublico;
    window.actualizarMensajeCompras = actualizarMensajeCompras;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', inicializar, { once: true });
    } else {
        inicializar();
    }
})();
