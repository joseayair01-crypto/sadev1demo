(() => {
    const HERO_SUBTITULO = 'Elige tus boletos y participa ahora';
    const HERO_TITULO_DEFAULT = 'Estás a un paso de ser el próximo ganador';
    const FOOTER_ESLOGAN_DEFAULT = 'Rifas 100% Transparentes y Seguras';
    const REMOTE_PRICE_TTL_MS = 15000;

    function obtenerPrecioCacheLocalKey() {
        const slug = typeof window.rifaplusConfig?.obtenerSlugRifaActual === 'function'
            ? window.rifaplusConfig.obtenerSlugRifaActual()
            : (typeof obtenerSlugRifaDesdeUrlRifaPlus === 'function' ? obtenerSlugRifaDesdeUrlRifaPlus() : '');
        return slug ? `rifaplus_compra_precio_cache_v1__${slug}` : 'rifaplus_compra_precio_cache_v1';
    }

    let promocionesSnapshot = '';
    let bonosSnapshot = '';
    let footerSnapshot = '';
    let remotePriceCache = {};
    let remotePriceFetchedAt = {};
    let remotePricePromise = {};
    let renderPublicoPendiente = false;
    let renderFooterPendiente = false;
    let pageReadyCompraEmitida = false;

    function notificarPaginaListaCompra() {
        window.dispatchEvent(new CustomEvent('rifaplus:page-ready', {
            detail: { page: 'compra' }
        }));
    }

    function esHeroCompraListo() {
        const hero = document.querySelector('.compra-hero');
        const title = document.getElementById('compraHeroTitle');
        const subtitle = document.getElementById('compraHeroSub');

        if (!hero || !title || !subtitle) {
            return false;
        }

        return Boolean(String(title.textContent || '').trim())
            && Boolean(String(subtitle.textContent || '').trim());
    }

    function esCardPrecioCompraLista() {
        const card = document.getElementById('precioCardCompra');
        const precio = document.getElementById('precioDinamico');

        if (!card || !precio) {
            return false;
        }

        return !card.classList.contains('loading')
            && card.getAttribute('aria-busy') !== 'true'
            && Boolean(String(precio.textContent || '').trim());
    }

    function evaluarPaginaListaCompra() {
        if (pageReadyCompraEmitida) {
            return;
        }

        if (!esHeroCompraListo() || !esCardPrecioCompraLista()) {
            return;
        }

        pageReadyCompraEmitida = true;
        requestAnimationFrame(() => {
            notificarPaginaListaCompra();
        });
    }

    function cuandoDomEsteListo(callback) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', callback, { once: true });
            return;
        }

        callback();
    }

    function obtenerConfigCompra() {
        return window.rifaplusConfig && typeof window.rifaplusConfig === 'object'
            ? window.rifaplusConfig
            : {};
    }

    function obtenerUtilidadesHeroCompra() {
        const heroUtils = window.__RIFAPLUS_COMPRA_HERO_UTILS__;
        if (heroUtils?.resolverNombreSorteo && heroUtils?.construirTitulo) {
            return heroUtils;
        }

        return {
            normalizarTexto(valor) {
                return String(valor || '').replace(/\s+/g, ' ').trim();
            },
            limpiarEmojis(valor) {
                return this.normalizarTexto(valor)
                    .replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\uFE0F\u200D]/gu, '')
                    .replace(/\s+/g, ' ')
                    .trim();
            },
            resolverNombreSorteo(...candidatos) {
                for (const candidato of candidatos) {
                    const nombre = this.limpiarEmojis(candidato);
                    if (nombre) {
                        return nombre;
                    }
                }

                return '';
            },
            construirTitulo(nombreSorteo, fallback = HERO_TITULO_DEFAULT) {
                const nombre = this.resolverNombreSorteo(nombreSorteo);
                return nombre
                    ? `Estás a un paso de ser el próximo ganador de ${nombre}`
                    : fallback;
            },
            construirEstadoHero(nombreSorteo, subtitulo = HERO_SUBTITULO) {
                const nombre = this.resolverNombreSorteo(nombreSorteo);
                return {
                    nombreSorteo: nombre,
                    titulo: this.construirTitulo(nombre, HERO_TITULO_DEFAULT),
                    subtitulo,
                    tieneNombreSorteo: Boolean(nombre)
                };
            },
            debeActualizarHero(actual, siguiente) {
                const actualNombre = this.resolverNombreSorteo(actual?.nombreSorteo);
                const siguienteNombre = this.resolverNombreSorteo(siguiente?.nombreSorteo);
                const actualTitulo = this.normalizarTexto(actual?.titulo);

                if (!actualTitulo) {
                    return true;
                }

                if (!actualNombre && siguienteNombre) {
                    return true;
                }

                if (actualNombre && siguienteNombre && actualNombre !== siguienteNombre) {
                    return true;
                }

                return !this.normalizarTexto(actual?.subtitulo) && Boolean(this.normalizarTexto(siguiente?.subtitulo));
            }
        };
    }

    function obtenerConfigLocalCompartida() {
        try {
            return JSON.parse(localStorage.getItem('rifaplus_config_actual_v2') || '{}');
        } catch (error) {
            return {};
        }
    }

    function leerPrecioCompraCacheLocal() {
        try {
            const clave = obtenerPrecioCacheLocalKey();
            const payload = JSON.parse(localStorage.getItem(clave) || 'null');
            const precio = Number(payload?.precio);
            if (!Number.isFinite(precio) || precio <= 0) {
                return null;
            }

            return {
                precio,
                timestamp: Number(payload?.timestamp) || 0
            };
        } catch (error) {
            return null;
        }
    }

    function guardarPrecioCompraCacheLocal(precio) {
        const numero = Number(precio);
        if (!Number.isFinite(numero) || numero <= 0) {
            return;
        }

        try {
            const clave = obtenerPrecioCacheLocalKey();
            localStorage.setItem(clave, JSON.stringify({
                precio: numero,
                timestamp: Date.now()
            }));
        } catch (error) {
            // Ignorar errores de almacenamiento para no frenar la UI.
        }
    }

    function hidratarPrecioCompraDesdeSnapshot(config) {
        if (!config?.rifa) {
            return;
        }

        const snapshot = window.__RIFAPLUS_COMPRA_PRICE_SNAPSHOT__;
        const precioSnapshot = Number(snapshot?.precioBoleto);
        const precioVisibleSnapshot = Number(snapshot?.precioVisible);

        if (Number.isFinite(precioSnapshot) && precioSnapshot > 0) {
            config.rifa.precioBoleto = precioSnapshot;
        } else if (Number.isFinite(precioVisibleSnapshot) && precioVisibleSnapshot > 0) {
            config.rifa.precioBoleto = precioVisibleSnapshot;
        }

        if (snapshot?.promocionPorTiempo) {
            config.rifa.promocionPorTiempo = snapshot.promocionPorTiempo;
        }

        if (snapshot?.descuentoPorcentaje) {
            config.rifa.descuentoPorcentaje = snapshot.descuentoPorcentaje;
        }
    }

    function obtenerNombreSorteoInicialCompra() {
        const heroUtils = obtenerUtilidadesHeroCompra();
        const config = obtenerConfigCompra();
        try {
            return heroUtils.resolverNombreSorteo(
                config?.rifa?.nombreSorteo,
                obtenerConfigLocalCompartida()?.rifa?.nombreSorteo,
                window.__RIFAPLUS_COMPRA_HERO__?.nombreSorteo,
                localStorage.getItem('rifaplus_compra_hero_sorteo')
            );
        } catch (error) {
            return '';
        }
    }

    function actualizarHeroCompraDesdeConfig() {
        const title = document.getElementById('compraHeroTitle');
        const subtitle = document.getElementById('compraHeroSub');

        if (!title) {
            return;
        }

        const heroUtils = obtenerUtilidadesHeroCompra();
        const nombreSorteo = obtenerNombreSorteoInicialCompra();
        const estadoSiguiente = heroUtils.construirEstadoHero(nombreSorteo, HERO_SUBTITULO);
        const estadoActual = {
            nombreSorteo: window.__RIFAPLUS_COMPRA_HERO__?.nombreSorteo,
            titulo: title.textContent,
            subtitulo: subtitle?.textContent || ''
        };

        if (!heroUtils.debeActualizarHero(estadoActual, estadoSiguiente)) {
            if (subtitle && !subtitle.textContent.trim()) {
                subtitle.textContent = estadoSiguiente.subtitulo;
            }
            evaluarPaginaListaCompra();
            return;
        }

        title.textContent = estadoSiguiente.titulo;

        if (subtitle) {
            subtitle.textContent = estadoSiguiente.subtitulo;
        }

        if (!estadoSiguiente.nombreSorteo) {
            return;
        }

        try {
            localStorage.setItem('rifaplus_compra_hero_sorteo', estadoSiguiente.nombreSorteo);
        } catch (error) {
            // Ignorar errores de storage para no romper la UI.
        }

        if (window.__RIFAPLUS_COMPRA_HERO__) {
            window.__RIFAPLUS_COMPRA_HERO__ = {
                ...window.__RIFAPLUS_COMPRA_HERO__,
                ...estadoSiguiente
            };
        }

        evaluarPaginaListaCompra();
    }

    async function obtenerPrecioBoletoRemoto() {
        const config = obtenerConfigCompra();
        const slug = typeof window.rifaplusConfig?.obtenerSlugRifaActual === 'function'
            ? window.rifaplusConfig.obtenerSlugRifaActual()
            : '';
        const cacheKey = slug || '__default__';
        const precioLocal = Number(config?.rifa?.precioBoleto);
        const precioCacheado = leerPrecioCompraCacheLocal()?.precio;

        if (Date.now() - (remotePriceFetchedAt[cacheKey] || 0) < REMOTE_PRICE_TTL_MS
            && Number.isFinite(remotePriceCache[cacheKey])) {
            return remotePriceCache[cacheKey];
        }

        if (typeof config?.obtenerConfigPublicaCompartida !== 'function') {
            return Number.isFinite(precioLocal) ? precioLocal : (Number.isFinite(precioCacheado) ? precioCacheado : null);
        }

        if (remotePricePromise[cacheKey]) {
            return remotePricePromise[cacheKey];
        }

        remotePricePromise[cacheKey] = config.obtenerConfigPublicaCompartida()
            .then((configPublica) => {
                const precioRemoto = Number(configPublica?.rifa?.precioBoleto ?? configPublica?.precioBoleto);
                remotePriceFetchedAt[cacheKey] = Date.now();

                if (!Number.isFinite(precioRemoto) || precioRemoto <= 0) {
                    return Number.isFinite(precioLocal) ? precioLocal : (Number.isFinite(precioCacheado) ? precioCacheado : null);
                }

                remotePriceCache[cacheKey] = precioRemoto;
                guardarPrecioCompraCacheLocal(precioRemoto);
                if (config.rifa) {
                    config.rifa.precioBoleto = precioRemoto;
                }
                return precioRemoto;
            })
            .catch(() => (Number.isFinite(precioLocal) ? precioLocal : (Number.isFinite(precioCacheado) ? precioCacheado : null)))
            .finally(() => {
                remotePricePromise[cacheKey] = null;
            });

        return remotePricePromise[cacheKey];
    }

    function formatearMoneda(valor) {
        const numero = Number(valor);
        return `$${Number.isFinite(numero) ? numero.toFixed(2) : '0.00'}`;
    }

    function formatearVigencia(fecha) {
        const valorFecha = new Date(fecha);
        if (Number.isNaN(valorFecha.getTime())) {
            return '';
        }

        const dia = String(valorFecha.getDate()).padStart(2, '0');
        const mes = String(valorFecha.getMonth() + 1).padStart(2, '0');
        const anio = valorFecha.getFullYear();
        let hora = valorFecha.getHours();
        const minutos = String(valorFecha.getMinutes()).padStart(2, '0');
        const ampm = hora >= 12 ? 'PM' : 'AM';

        hora = hora % 12;
        hora = hora || 12;

        return `Vigencia hasta: ${dia}/${mes}/${anio} a las ${String(hora).padStart(2, '0')}:${minutos} ${ampm}`;
    }

    function resolverVentanaPromocion(rifa, fechaInicio, fechaFin, ahora = new Date()) {
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
            inicio,
            fin
        };
    }

    function resolverPromocionActiva(rifa) {
        const precioBase = Number(rifa?.precioBoleto);
        if (!Number.isFinite(precioBase) || precioBase <= 0) {
            return {
                activa: false,
                precioBase: 0,
                precioFinal: 0,
                etiqueta: 'OFERTA',
                vigencia: '',
                precioRegularReferencia: 0,
                tipo: 'ninguna',
                kicker: 'Promocion activa',
                titulo: 'Precio Especial',
                caption: 'Aprovecha este precio antes de que termine'
            };
        }

        const ahora = new Date();
        const promoTiempo = rifa?.promocionPorTiempo;
        const descuentoPorcentaje = rifa?.descuentoPorcentaje;
        const combos = Array.isArray(rifa?.promocionesCombo?.reglas) ? rifa.promocionesCombo.reglas : [];
        let mejorPrecio = precioBase;
        let precioRegularReferencia = precioBase;
        let etiqueta = 'OFERTA';
        let vigencia = '';
        let activa = false;
        let tipo = 'ninguna';
        let kicker = 'Promocion activa';
        let titulo = 'Precio Especial';
        let caption = 'Aprovecha este precio antes de que termine';

        if (promoTiempo?.enabled && promoTiempo?.precioProvisional !== null && promoTiempo?.precioProvisional !== undefined) {
            const ventanaPromoTiempo = resolverVentanaPromocion(rifa, promoTiempo.fechaInicio, promoTiempo.fechaFin, ahora);
            const fin = ventanaPromoTiempo.fin;

            if (ventanaPromoTiempo.activa && !Number.isNaN(fin.getTime())) {
                const precioTiempo = Number(promoTiempo.precioProvisional);
                if (Number.isFinite(precioTiempo) && precioTiempo >= 0 && precioTiempo < mejorPrecio) {
                    mejorPrecio = precioTiempo;
                    precioRegularReferencia = precioBase;
                    activa = true;
                    etiqueta = 'OFERTA';
                    vigencia = formatearVigencia(fin);
                    tipo = 'tiempo';
                }
            }
        }

        if (descuentoPorcentaje?.enabled && descuentoPorcentaje?.porcentaje) {
            const ventanaDescuento = resolverVentanaPromocion(rifa, descuentoPorcentaje.fechaInicio, descuentoPorcentaje.fechaFin, ahora);
            const fin = ventanaDescuento.fin;

            if (ventanaDescuento.activa && !Number.isNaN(fin.getTime())) {
                const porcentaje = Number(descuentoPorcentaje.porcentaje);
                const precioConDescuento = precioBase - ((precioBase * porcentaje) / 100);
                if (Number.isFinite(precioConDescuento) && precioConDescuento >= 0 && precioConDescuento < mejorPrecio) {
                    mejorPrecio = precioConDescuento;
                    precioRegularReferencia = precioBase;
                    activa = true;
                    etiqueta = `${Math.round(((precioBase - precioConDescuento) / precioBase) * 100)}% OFF`;
                    vigencia = formatearVigencia(fin);
                    tipo = 'porcentaje';
                }
            }
        }

        if (rifa?.promocionesCombo?.enabled === true && combos.length > 0) {
            const comboDestacado = combos
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
                activa = true;
                tipo = 'combo';
                etiqueta = comboDestacado.etiqueta;
                precioRegularReferencia = comboDestacado.cantidadRecibe * precioBase;
                mejorPrecio = comboDestacado.cantidadPaga * precioBase;
                vigencia = '';
                kicker = '';
                titulo = comboDestacado.etiqueta;
                caption = `Aprovecha super promocion ${comboDestacado.etiqueta}. Recibe ${comboDestacado.cantidadRecibe} boletos y paga ${comboDestacado.cantidadPaga}`;
            }
        }

        return {
            activa,
            precioBase,
            precioFinal: mejorPrecio,
            etiqueta,
            vigencia,
            precioRegularReferencia,
            tipo,
            kicker,
            titulo,
            caption
        };
    }

    function aplicarLayoutCards(contenedor) {
        if (!contenedor) {
            return;
        }

        contenedor.classList.remove(
            'cards-layout--1',
            'cards-layout--2',
            'cards-layout--3',
            'cards-layout--4',
            'cards-layout--many'
        );

        const total = contenedor.children.length;
        if (total === 1) contenedor.classList.add('cards-layout--1');
        else if (total === 2) contenedor.classList.add('cards-layout--2');
        else if (total === 3) contenedor.classList.add('cards-layout--3');
        else if (total === 4) contenedor.classList.add('cards-layout--4');
        else if (total > 4) contenedor.classList.add('cards-layout--many');
    }

    function vaciarNodo(nodo) {
        if (!nodo) {
            return;
        }

        while (nodo.firstChild) {
            nodo.removeChild(nodo.firstChild);
        }
    }

    function crearPromoCard({ tag, simple, operator, strong, desc, className }) {
        const card = document.createElement('div');
        card.className = `promo-card ${className}`.trim();

        if (tag) {
            const tagEl = document.createElement('span');
            tagEl.className = 'promo-tag';
            tagEl.textContent = tag;
            card.appendChild(tagEl);
        }

        const simpleEl = document.createElement('p');
        simpleEl.className = 'promo-simple';
        simpleEl.textContent = simple;
        card.appendChild(simpleEl);

        const operatorEl = document.createElement('p');
        operatorEl.className = 'promo-operator';
        operatorEl.textContent = operator;
        card.appendChild(operatorEl);

        const strongEl = document.createElement('p');
        strongEl.className = 'promo-strong';
        strongEl.textContent = strong;
        card.appendChild(strongEl);

        if (desc) {
            const descEl = document.createElement('span');
            descEl.className = 'promo-desc';
            descEl.textContent = desc;
            card.appendChild(descEl);
        }

        return card;
    }

    function renderizarPromociones(rifa) {
        const promocionesPanel = document.getElementById('promocionesPanel');
        const promocionesHeader = document.getElementById('promocionesHeader');
        const promosCards = document.getElementById('promosCards');
        const descuentosBlock = document.getElementById('descuentosBlock');
        const descuentosSubText = document.getElementById('descuentosSubText');
        const oportunidadesBlock = document.getElementById('oportunidadesBlock');
        const oportunidadesSubText = document.getElementById('oportunidadesSubText');
        const oportunidadesCards = document.getElementById('oportunidadesCards');

        if (!promocionesPanel || !promosCards || !descuentosBlock || !oportunidadesBlock || !oportunidadesCards) {
            return;
        }

        const descuentosConfig = rifa?.descuentos;
        const combosConfig = rifa?.promocionesCombo;
        const oportunidadesConfig = rifa?.oportunidades;
        const promosOportunidadesConfig = rifa?.promocionesOportunidades;
        const oportunidadesActivas = oportunidadesConfig?.enabled === true &&
            promosOportunidadesConfig?.enabled === true &&
            Array.isArray(promosOportunidadesConfig?.ejemplos) &&
            promosOportunidadesConfig.ejemplos.length > 0;

        const promocionesDescuento = [];
        const tarjetasOportunidades = [];

        if (descuentosConfig?.enabled && Array.isArray(descuentosConfig.reglas)) {
            descuentosConfig.reglas.forEach((regla) => {
                const cantidad = Number(regla?.cantidad);
                const totalPaquete = Number(regla?.total ?? regla?.precio);

                if (!Number.isFinite(cantidad) || cantidad <= 0 || !Number.isFinite(totalPaquete) || totalPaquete <= 0) {
                    return;
                }

                promocionesDescuento.push({
                    sortKey: cantidad,
                    tag: 'Promocion',
                    simple: `${cantidad} Boletos`,
                    operator: 'Solo por:',
                    strong: formatearMoneda(totalPaquete),
                    desc: '',
                    className: 'promo-card--paquete'
                });
            });

            promocionesDescuento.sort((a, b) => {
                return (a.sortKey || 0) - (b.sortKey || 0);
            });
        }

        if (oportunidadesActivas) {
            promosOportunidadesConfig.ejemplos.forEach((ejemplo) => {
                const boletos = Number(ejemplo?.boletos);
                const oportunidades = Number(ejemplo?.oportunidades);

                if (!Number.isFinite(boletos) || boletos <= 0 || !Number.isFinite(oportunidades) || oportunidades <= 0) {
                    return;
                }

                tarjetasOportunidades.push({
                    sortKey: boletos,
                    tag: '',
                    simple: `${boletos} Boleto${boletos === 1 ? '' : 's'}`,
                    operator: '=',
                    strong: `${oportunidades} Oportunidade${oportunidades === 1 ? '' : 's'}`,
                    desc: '',
                    className: 'promo-card--oportunidad'
                });
            });

            tarjetasOportunidades.sort((a, b) => {
                return (a.sortKey || 0) - (b.sortKey || 0);
            });
        }

        const tieneDescuentos = promocionesDescuento.length > 0;
        const tieneOportunidades = tarjetasOportunidades.length > 0;

        if (descuentosSubText) {
            descuentosSubText.textContent = 'Llevate mas boletos por un mejor precio.';
        }

        if (oportunidadesSubText) {
            oportunidadesSubText.textContent = 'Cada boleto multiplica tus posibilidades de ganar.';
        }

        const snapshot = JSON.stringify({
            promocionesDescuento,
            tarjetasOportunidades
        });
        if (snapshot === promocionesSnapshot) {
            promocionesPanel.style.display = (tieneDescuentos || tieneOportunidades) ? '' : 'none';
            promocionesHeader.style.display = (tieneDescuentos || tieneOportunidades) ? '' : 'none';
            descuentosBlock.style.display = tieneDescuentos ? '' : 'none';
            oportunidadesBlock.style.display = tieneOportunidades ? '' : 'none';
            promosCards.style.display = tieneDescuentos ? 'grid' : 'none';
            oportunidadesCards.style.display = tieneOportunidades ? 'grid' : 'none';
            return;
        }

        promocionesSnapshot = snapshot;
        vaciarNodo(promosCards);
        vaciarNodo(oportunidadesCards);

        if (!tieneDescuentos && !tieneOportunidades) {
            promocionesPanel.style.display = 'none';
            promocionesHeader.style.display = 'none';
            descuentosBlock.style.display = 'none';
            oportunidadesBlock.style.display = 'none';
            promosCards.style.display = 'none';
            oportunidadesCards.style.display = 'none';
            return;
        }

        if (tieneDescuentos) {
            const descuentosFragment = document.createDocumentFragment();
            promocionesDescuento.forEach((tarjeta) => {
                descuentosFragment.appendChild(crearPromoCard(tarjeta));
            });
            promosCards.appendChild(descuentosFragment);
            promosCards.style.display = 'grid';
            descuentosBlock.style.display = '';
            aplicarLayoutCards(promosCards);
        } else {
            descuentosBlock.style.display = 'none';
            promosCards.style.display = 'none';
        }

        if (tieneOportunidades) {
            const oportunidadesFragment = document.createDocumentFragment();
            tarjetasOportunidades.forEach((tarjeta) => {
                oportunidadesFragment.appendChild(crearPromoCard(tarjeta));
            });
            oportunidadesCards.appendChild(oportunidadesFragment);
            oportunidadesCards.style.display = 'grid';
            oportunidadesBlock.style.display = '';
            aplicarLayoutCards(oportunidadesCards);
        } else {
            oportunidadesBlock.style.display = 'none';
            oportunidadesCards.style.display = 'none';
        }

        promocionesPanel.style.display = '';
        promocionesHeader.style.display = '';
    }

    function renderizarBonosCompra(rifa) {
        const bonosCompraSection = document.getElementById('bonosCompraSection');
        const bonosCompraCards = document.getElementById('bonosCompraCards');
        const items = Array.isArray(rifa?.bonosCompra?.items) ? rifa.bonosCompra.items : [];
        const bonosActivos = rifa?.bonosCompra?.enabled === true;

        if (!bonosCompraSection || !bonosCompraCards) {
            return;
        }

        if (!bonosActivos || items.length === 0) {
            bonosCompraSection.style.display = 'none';
            bonosSnapshot = '';
            return;
        }

        const bonosValidos = items
            .map((item) => ({
                titulo: String(item?.titulo || '').trim(),
                descripcion: String(item?.descripcion || '').trim(),
                emoji: String(item?.emoji || '🎁').trim() || '🎁'
            }))
            .filter((item) => item.titulo && item.descripcion);

        const snapshot = JSON.stringify(bonosValidos);
        if (snapshot === bonosSnapshot) {
            bonosCompraSection.style.display = bonosValidos.length > 0 ? 'block' : 'none';
            return;
        }

        bonosSnapshot = snapshot;
        vaciarNodo(bonosCompraCards);

        if (bonosValidos.length === 0) {
            bonosCompraSection.style.display = 'none';
            return;
        }

        const fragment = document.createDocumentFragment();
        bonosValidos.forEach((item) => {
            const card = document.createElement('article');
            card.className = 'bono-compra-card';

            const titulo = document.createElement('h4');
            titulo.className = 'bono-compra-titulo';
            titulo.textContent = item.titulo;
            card.appendChild(titulo);

            const emoji = document.createElement('div');
            emoji.className = 'bono-compra-emoji';
            emoji.setAttribute('aria-hidden', 'true');
            emoji.textContent = item.emoji;
            card.appendChild(emoji);

            const descripcion = document.createElement('p');
            descripcion.className = 'bono-compra-descripcion';
            descripcion.textContent = item.descripcion;
            card.appendChild(descripcion);

            fragment.appendChild(card);
        });

        bonosCompraCards.appendChild(fragment);
        aplicarLayoutCards(bonosCompraCards);
        bonosCompraSection.style.display = 'block';
    }

    function actualizarCardPrecio(rifa) {
        const precioCardCompra = document.getElementById('precioCardCompra');
        const precioDinamico = document.getElementById('precioDinamico');
        const precioNormalCompra = document.getElementById('precioNormalCompra');
        const precioOfertaCompra = document.getElementById('precioOfertaCompra');
        const ofertaVigenciaCompra = document.getElementById('ofertaVigenciaCompra');
        const precioBadgeCompra = document.getElementById('precioBadgeCompra');
        const precioBadgeCompraText = document.getElementById('precioBadgeCompraText');
        const precioSuperBadgeCompra = document.getElementById('precioSuperBadgeCompra');
        const precioNormalOfertaCompra = document.getElementById('precioNormalOfertaCompra');
        const precioEspecialOfertaCompra = document.getElementById('precioEspecialOfertaCompra');
        const badgeText = document.querySelector('.oferta-badge-text');
        const vigenciaOfertaCompra = document.getElementById('vigenciaOfertaCompra');
        const kickerOferta = precioOfertaCompra?.querySelector('.precio-kicker');
        const tituloOferta = precioOfertaCompra?.querySelector('.oferta-precio-destacado h3');
        const subtituloNormal = precioOfertaCompra?.querySelector('.oferta-precio-normal h4');
        const captionOferta = precioOfertaCompra?.querySelector('.precio-caption');

        if (!precioDinamico) {
            return;
        }

        const promo = resolverPromocionActiva(rifa);
        const precioFinal = Number(promo.precioFinal);
        const snapshotPrecio = Number(window.__RIFAPLUS_COMPRA_PRICE_SNAPSHOT__?.precioVisible);
        const precioExistente = Number(String(precioDinamico.textContent || '').replace(/[^0-9.]+/g, ''));
        const precioRespaldo = Number.isFinite(snapshotPrecio) && snapshotPrecio > 0
            ? snapshotPrecio
            : (Number.isFinite(precioExistente) && precioExistente > 0 ? precioExistente : null);

        if (!Number.isFinite(precioFinal) || precioFinal <= 0) {
            if (Number.isFinite(precioRespaldo) && precioRespaldo > 0) {
                precioDinamico.textContent = formatearMoneda(precioRespaldo);
            }
            return;
        }

        precioDinamico.textContent = formatearMoneda(promo.tipo === 'combo' ? (promo.precioBase || precioFinal) : precioFinal);
        if (precioCardCompra) {
            precioCardCompra.classList.remove('loading');
            precioCardCompra.setAttribute('aria-busy', 'false');
        }
        evaluarPaginaListaCompra();

        if (!promo.activa) {
            if (precioNormalCompra) precioNormalCompra.style.display = 'flex';
            if (precioOfertaCompra) precioOfertaCompra.style.display = 'none';
            if (ofertaVigenciaCompra) ofertaVigenciaCompra.style.display = 'none';
            if (precioBadgeCompra) precioBadgeCompra.style.display = 'none';
            if (precioSuperBadgeCompra) precioSuperBadgeCompra.style.display = 'none';
            return;
        }

        if (promo.tipo === 'combo') {
            if (precioNormalCompra) precioNormalCompra.style.display = 'flex';
            if (precioOfertaCompra) precioOfertaCompra.style.display = 'none';
            if (ofertaVigenciaCompra) ofertaVigenciaCompra.style.display = 'none';
            if (precioBadgeCompra) precioBadgeCompra.style.display = 'flex';
            if (precioBadgeCompraText) precioBadgeCompraText.textContent = promo.titulo || promo.etiqueta || 'PROMO';
            if (precioSuperBadgeCompra) precioSuperBadgeCompra.style.display = 'inline-flex';
            return;
        }

        if (precioBadgeCompra) precioBadgeCompra.style.display = 'none';
        if (precioSuperBadgeCompra) precioSuperBadgeCompra.style.display = 'none';
        if (precioNormalCompra) precioNormalCompra.style.display = 'none';
        if (precioOfertaCompra) precioOfertaCompra.style.display = 'flex';
        if (precioNormalOfertaCompra) precioNormalOfertaCompra.textContent = formatearMoneda(promo.precioRegularReferencia || promo.precioBase);
        if (precioEspecialOfertaCompra) precioEspecialOfertaCompra.textContent = formatearMoneda(promo.precioFinal);
        if (badgeText) badgeText.textContent = promo.etiqueta;
        if (kickerOferta) {
            kickerOferta.textContent = promo.kicker || '';
            kickerOferta.style.display = promo.kicker ? '' : 'none';
        }
        if (tituloOferta) tituloOferta.textContent = promo.titulo || 'Precio Especial';
        if (subtituloNormal) {
            subtituloNormal.textContent = 'Precio Regular';
            subtituloNormal.style.display = '';
        }
        if (captionOferta) captionOferta.textContent = promo.caption || 'Aprovecha este precio antes de que termine';

        if (ofertaVigenciaCompra && vigenciaOfertaCompra && promo.vigencia) {
            ofertaVigenciaCompra.style.display = 'flex';
            vigenciaOfertaCompra.textContent = promo.vigencia;
        } else if (ofertaVigenciaCompra) {
            ofertaVigenciaCompra.style.display = 'none';
        }
    }

    function animarBotonFlotanteSiExiste() {
        const boton = document.querySelector('.btn-flotante-comprobante');
        if (!boton) {
            return;
        }

        boton.classList.add('bounce-animate');
        window.setTimeout(() => {
            boton.classList.remove('bounce-animate');
        }, 1800);
    }

    async function renderizarCompraPublica() {
        const config = obtenerConfigCompra();
        if (!config?.rifa) {
            return;
        }

        pageReadyCompraEmitida = false;

        hidratarPrecioCompraDesdeSnapshot(config);
        actualizarHeroCompraDesdeConfig();
        actualizarCardPrecio(config.rifa);
        renderizarPromociones(config.rifa);
        renderizarBonosCompra(config.rifa);
        animarBotonFlotanteSiExiste();
        evaluarPaginaListaCompra();

        const precioAntes = Number(config.rifa.precioBoleto);
        const precioRemoto = await obtenerPrecioBoletoRemoto();
        if (Number.isFinite(precioRemoto) && precioRemoto > 0 && precioRemoto !== precioAntes) {
            actualizarCardPrecio(config.rifa);
            renderizarPromociones(config.rifa);
        }

        evaluarPaginaListaCompra();
    }

    function programarRenderCompraPublica() {
        if (renderPublicoPendiente) {
            return;
        }

        renderPublicoPendiente = true;
        requestAnimationFrame(() => {
            renderPublicoPendiente = false;
            renderizarCompraPublica().catch(() => {
                // Ignorar errores para no frenar la pagina.
            });
        });
    }

    function construirRedSocial({ href, title, iconClass }) {
        const anchor = document.createElement('a');
        anchor.href = href;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        anchor.title = title;

        const icon = document.createElement('i');
        icon.className = iconClass;
        anchor.appendChild(icon);
        return anchor;
    }

    function renderizarFooterCompra() {
        const config = obtenerConfigCompra();
        const cliente = config?.cliente || {};
        const redes = cliente?.redesSociales || {};
        const socialData = {
            whatsapp: redes?.whatsapp ? `https://wa.me/${String(redes.whatsapp).replace(/[^0-9]/g, '')}` : '',
            facebook: String(redes?.facebook || '').trim(),
            instagram: String(redes?.instagram || '').trim()
        };

        const snapshot = JSON.stringify({
            nombre: String(cliente?.nombre || '').trim(),
            eslogan: String(cliente?.eslogan || '').trim(),
            email: String(cliente?.email || '').trim(),
            telefono: String(cliente?.telefono || '').trim(),
            redes: socialData
        });

        if (snapshot === footerSnapshot) {
            return;
        }

        footerSnapshot = snapshot;

        if (typeof config?.actualizarNombreClienteEnUI === 'function') {
            config.actualizarNombreClienteEnUI();
        }

        const footerEslogan = document.getElementById('footerEslogan');
        if (footerEslogan) {
            footerEslogan.textContent = cliente?.eslogan || FOOTER_ESLOGAN_DEFAULT;
        }

        const footerEmail = document.getElementById('footerEmail');
        if (footerEmail && cliente?.email) {
            footerEmail.href = `mailto:${cliente.email}`;
            footerEmail.textContent = cliente.email;
        }

        const footerTelefono = document.getElementById('footerTelefono');
        if (footerTelefono && cliente?.telefono) {
            footerTelefono.href = `tel:${String(cliente.telefono).replace(/[^0-9+]/g, '')}`;
            footerTelefono.textContent = cliente.telefono;
        }

        const footerSocial = document.getElementById('footerSocial');
        if (!footerSocial) {
            return;
        }

        vaciarNodo(footerSocial);

        if (socialData.whatsapp) {
            footerSocial.appendChild(construirRedSocial({
                href: socialData.whatsapp,
                title: 'WhatsApp',
                iconClass: 'fab fa-whatsapp'
            }));
        }

        if (socialData.facebook) {
            footerSocial.appendChild(construirRedSocial({
                href: socialData.facebook,
                title: 'Facebook',
                iconClass: 'fab fa-facebook-f'
            }));
        }

        if (socialData.instagram) {
            footerSocial.appendChild(construirRedSocial({
                href: socialData.instagram,
                title: 'Instagram',
                iconClass: 'fab fa-instagram'
            }));
        }
    }

    function programarRenderFooter() {
        if (renderFooterPendiente) {
            return;
        }

        renderFooterPendiente = true;
        requestAnimationFrame(() => {
            renderFooterPendiente = false;
            renderizarFooterCompra();
        });
    }

    function actualizarDisponibilidadFallback() {
        if (typeof window.actualizarNotaDisponibilidad === 'function') {
            window.actualizarNotaDisponibilidad();
            return;
        }

        const note = document.getElementById('availabilityNote');
        const disponibles = Number(obtenerConfigCompra()?.estado?.boletosDisponibles);
        if (!note || !Number.isFinite(disponibles) || disponibles < 0) {
            return;
        }

        note.textContent = `${disponibles} boletos disponibles`;
        note.style.visibility = 'visible';
        note.style.opacity = '1';
        note.style.display = 'inline-block';
    }

    function sincronizarCompraPublica() {
        programarRenderCompraPublica();
        programarRenderFooter();
        actualizarDisponibilidadFallback();
    }

    cuandoDomEsteListo(() => {
        sincronizarCompraPublica();

        window.addEventListener('configSyncCompleto', sincronizarCompraPublica);
        window.addEventListener('configuracionActualizada', sincronizarCompraPublica);
        window.addEventListener('configActualizada', sincronizarCompraPublica);
        window.addEventListener('boletosListos', actualizarDisponibilidadFallback);
    });
})();
