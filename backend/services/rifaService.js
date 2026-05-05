const fs = require('fs');
const path = require('path');
const SorteoFinalizadoSnapshotService = require('./sorteoFinalizadoSnapshotService');

class RifaService {
  constructor(db) {
    this.db = db;
    this.enabled = false;
    this.defaultCache = null;
    this.defaultCacheAt = 0;
    this.defaultCacheTtlMs = 10000;
    // 🔒 Evita condiciones de carrera al cambiar la rifa pública principal.
    // Un solo cambio de "activa_publica" debe ejecutarse a la vez.
    this.PUBLIC_ACTIVATION_LOCK_KEY = 982341; // Número constante (advisory lock)
  }

  async inicializar() {
    this.enabled = await this.db.schema.hasTable('rifas');
    if (!this.enabled) {
      return false;
    }

    await this.asegurarRifaPredeterminada();
    return true;
  }

  async asegurarRifaPredeterminada() {
    const existente = await this.db('rifas').orderBy('id', 'asc').first();
    if (existente) {
      await this.db('rifas')
        .where('id', existente.id)
        .update({
          es_predeterminada: true,
          activa_publica: existente.activa_publica !== false,
          updated_at: this.db.fn.now()
        });
      this.defaultCache = existente;
      this.defaultCacheAt = Date.now();
      return existente;
    }

    const config = this._leerConfigDesdeDisco();
    const nombre = String(config?.rifa?.nombreSorteo || config?.rifa?.edicionNombre || 'Rifa principal').trim() || 'Rifa principal';
    const slug = await this._generarSlugDisponible(nombre);

    const [rifa] = await this.db('rifas')
      .insert({
        slug,
        nombre,
        estado: String(config?.rifa?.estado || 'activa').trim() || 'activa',
        es_predeterminada: true,
        activa_publica: true,
        configuracion: config && typeof config === 'object' ? config : {},
        created_at: this.db.fn.now(),
        updated_at: this.db.fn.now()
      })
      .returning('*');

    this.defaultCache = rifa;
    this.defaultCacheAt = Date.now();
    return rifa;
  }

  _leerConfigDesdeDisco() {
    try {
      const configPath = path.resolve(__dirname, '../config.json');
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (error) {
      return {};
    }
  }

  _slugify(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80);
  }

  async _generarSlugDisponible(nombre) {
    const base = this._slugify(nombre) || 'rifa';
    let slug = base;
    let intento = 1;
    while (await this.db('rifas').where('slug', slug).first()) {
      intento += 1;
      slug = `${base}-${intento}`;
    }
    return slug;
  }

  _clonar(config) {
    return JSON.parse(JSON.stringify(config || {}));
  }

  _prepararConfigNuevaRifa(config = {}, payload = {}) {
    const nuevaConfig = this._resolverEstadoConfiguracion(this._clonar(config), this._leerConfigDesdeDisco());
    const nombre = String(payload.nombre || payload.nombreSorteo || nuevaConfig?.rifa?.nombreSorteo || 'Nueva rifa').trim() || 'Nueva rifa';
    const edicionNombre = String(payload.edicionNombre || nombre).trim() || nombre;

    nuevaConfig.rifa = {
      ...(nuevaConfig.rifa || {}),
      nombreSorteo: nombre,
      edicionNombre,
      estado: 'borrador',
      fechaSorteo: '',
      fechaSorteoFormato: '',
      horaSorteo: '',
      fechaPresorteo: '',
      horaPresorteo: '',
      modalFinalizadoSnapshot: null
    };

    nuevaConfig.sorteoActivo = {
      ...(nuevaConfig.sorteoActivo || {}),
      estado: 'activo',
      fechaCierre: null,
      fechaCierreFormato: '',
      ganadores: {
        principal: [],
        presorte: [],
        ruletazo: []
      }
    };

    return nuevaConfig;
  }

  _resolverEstadoConfiguracion(config = {}, fallback = {}) {
    const base = this._clonar(config);
    if (!base.cliente) base.cliente = this._clonar(fallback.cliente || {});
    if (!base.rifa) base.rifa = this._clonar(fallback.rifa || {});
    if (!base.tecnica) base.tecnica = this._clonar(fallback.tecnica || {});
    if (!base.tema) base.tema = this._clonar(fallback.tema || {});
    if (!base.seo) base.seo = this._clonar(fallback.seo || {});
    if (!base.marketing) base.marketing = this._clonar(fallback.marketing || {});
    return base;
  }

  _normalizarRegistroRifa(rifa = {}) {
    const fallback = this._leerConfigDesdeDisco();
    const configuracion = this._resolverEstadoConfiguracion(rifa?.configuracion || {}, fallback);
    const estadoPersistido = String(configuracion?.rifa?.estado || rifa?.estado || 'activa').trim().toLowerCase() || 'activa';
    const snapshotFinal = rifa?.snapshot_final || configuracion?.rifa?.modalFinalizadoSnapshot || null;

    let estado = estadoPersistido;

    if (rifa?.depurada_at) {
      estado = 'depurada';
    } else if (estado !== 'archivada' && SorteoFinalizadoSnapshotService.esRifaFinalizada(configuracion?.rifa || {})) {
      estado = 'finalizado';
    }

    return {
      ...rifa,
      estado,
      configuracion,
      snapshot_final: snapshotFinal
    };
  }

  async obtenerRifaActivaPublica(force = false) {
    if (!this.enabled) return null;
    if (!force && this.defaultCache && (Date.now() - this.defaultCacheAt) < this.defaultCacheTtlMs) {
      return this.defaultCache;
    }

    const rifa = await this.db('rifas')
      .whereNull('depurada_at')
      .where('activa_publica', true)
      .orderBy('id', 'asc')
      .first()
      || await this.db('rifas').whereNull('depurada_at').orderBy('id', 'asc').first();

    this.defaultCache = rifa || null;
    this.defaultCacheAt = Date.now();
    return rifa || null;
  }

  async obtenerPorId(id) {
    if (!this.enabled || !id) return null;
    return this.db('rifas').where('id', id).first();
  }

  async obtenerPorSlug(slug) {
    if (!this.enabled || !slug) return null;
    return this.db('rifas').where('slug', String(slug).trim()).first();
  }

  async obtenerPorDominio(dominio) {
    if (!this.enabled || !dominio) return null;
    return this.db('rifas').where('dominio', String(dominio).trim().toLowerCase()).first();
  }

  async resolverContexto(options = {}) {
    if (!this.enabled) return null;

    const rifaId = Number.parseInt(options.rifaId, 10);
    const slug = String(options.slug || '').trim();
    const hostname = String(options.hostname || '').trim().toLowerCase();

    let rifa = null;
    if (Number.isInteger(rifaId) && rifaId > 0) {
      rifa = await this.obtenerPorId(rifaId);
    }

    if (!rifa && slug) {
      rifa = await this.obtenerPorSlug(slug);
    }

    if (!rifa && hostname && !['localhost', '127.0.0.1'].includes(hostname)) {
      rifa = await this.obtenerPorDominio(hostname);
    }

    // Si se proporcionó un ID, Slug o Hostname explícito, NO debemos hacer fallback a la rifa activa
    // por defecto si no se encontró lo solicitado, para evitar contaminación de datos.
    const hasExplicitRequest = (Number.isInteger(rifaId) && rifaId > 0) || slug || (hostname && !['localhost', '127.0.0.1'].includes(hostname));

    if (!rifa && !hasExplicitRequest && options.fallbackActive !== false) {
      rifa = await this.obtenerRifaActivaPublica();
    }

    if (!rifa) return null;

    const rifaNormalizada = this._normalizarRegistroRifa(rifa);

    return {
      id: Number(rifaNormalizada.id),
      slug: String(rifaNormalizada.slug || '').trim(),
      dominio: rifaNormalizada.dominio ? String(rifaNormalizada.dominio).trim() : null,
      nombre: String(rifaNormalizada.nombre || '').trim(),
      estado: String(rifaNormalizada.estado || 'activa').trim(),
      configuracion: rifaNormalizada.configuracion,
      snapshotFinal: rifaNormalizada.snapshot_final || null,
      finalizadaAt: rifaNormalizada.finalizada_at || null,
      depuracionProgramadaAt: rifaNormalizada.depuracion_programada_at || null,
      depuradaAt: rifaNormalizada.depurada_at || null,
      raw: rifaNormalizada
    };
  }

  async guardarConfiguracion(rifaId, config, usuarioAdmin = 'SYSTEM') {
    if (!this.enabled) return false;

    const configNormalizada = this._resolverEstadoConfiguracion(config, this._leerConfigDesdeDisco());
    const rifa = await this.obtenerPorId(rifaId);
    if (!rifa) {
      throw new Error(`Rifa ${rifaId} no encontrada`);
    }

    const estadoSolicitado = String(configNormalizada?.rifa?.estado || rifa.estado || 'activa').trim().toLowerCase() || 'activa';
    const estadoRifa = (
      estadoSolicitado !== 'archivada'
      && estadoSolicitado !== 'depurada'
      && SorteoFinalizadoSnapshotService.esRifaFinalizada(configNormalizada?.rifa || {})
    )
      ? 'finalizado'
      : estadoSolicitado;
    const fechaFinalizada = estadoRifa === 'finalizado'
      ? (rifa.finalizada_at || new Date().toISOString())
      : null;
    // La depuracion de una rifa finalizada ahora es exclusivamente manual desde admin.
    const depuracionProgramada = null;

    await this.db('rifas')
      .where('id', rifaId)
      .update({
        nombre: String(configNormalizada?.rifa?.nombreSorteo || configNormalizada?.rifa?.edicionNombre || rifa.nombre || 'Rifa').trim() || 'Rifa',
        slug: String(configNormalizada?.rifa?.slug || rifa.slug).trim().toLowerCase(),
        dominio: configNormalizada?.rifa?.dominio ? String(configNormalizada.rifa.dominio).trim().toLowerCase() : rifa.dominio,
        estado: estadoRifa,
        configuracion: configNormalizada,
        finalizada_at: fechaFinalizada,
        depuracion_programada_at: depuracionProgramada,
        updated_at: this.db.fn.now(),
        actualizado_por: usuarioAdmin
      })
      .catch(() => this.db('rifas')
        .where('id', rifaId)
        .update({
          nombre: String(configNormalizada?.rifa?.nombreSorteo || configNormalizada?.rifa?.edicionNombre || rifa.nombre || 'Rifa').trim() || 'Rifa',
          slug: String(configNormalizada?.rifa?.slug || rifa.slug).trim().toLowerCase(),
          dominio: configNormalizada?.rifa?.dominio ? String(configNormalizada.rifa.dominio).trim().toLowerCase() : rifa.dominio,
          estado: estadoRifa,
          configuracion: configNormalizada,
          finalizada_at: fechaFinalizada,
          depuracion_programada_at: depuracionProgramada,
          updated_at: this.db.fn.now()
        }));

    this.defaultCacheAt = 0;
    return true;
  }

  async guardarSnapshotFinal(rifaId, snapshot, extra = {}) {
    if (!this.enabled) return false;

    await this.db('rifas')
      .where('id', rifaId)
      .update({
        snapshot_final: snapshot || null,
        estado: extra.estado || this.db.raw('estado'),
        finalizada_at: extra.finalizadaAt || this.db.raw('COALESCE(finalizada_at, NOW())'),
        // Solo se agenda si una accion manual lo solicita expresamente.
        depuracion_programada_at: extra.depuracionProgramadaAt || null,
        updated_at: this.db.fn.now()
      });

    this.defaultCacheAt = 0;
    return true;
  }

  async listarRifas(options = {}) {
    if (!this.enabled) return [];
    const incluirDepuradas = options.incluirDepuradas === true;
    let query = this.db('rifas')
      .select('id', 'slug', 'nombre', 'estado', 'activa_publica', 'es_predeterminada', 'finalizada_at', 'depuracion_programada_at', 'depurada_at', 'snapshot_final', 'configuracion', 'updated_at', 'created_at')
      .orderBy('created_at', 'desc');

    if (!incluirDepuradas) {
      query = query.whereNull('depurada_at');
    }

    const rifas = await query;
    return rifas.map((rifa) => this._normalizarRegistroRifa(rifa));
  }

  async listarSorteosPasados() {
    if (!this.enabled) return [];
    const rifas = await this.db('rifas')
      .select('id', 'slug', 'nombre', 'estado', 'snapshot_final', 'configuracion', 'finalizada_at', 'depuracion_programada_at', 'depurada_at', 'updated_at', 'created_at')
      .orderByRaw('COALESCE(finalizada_at, updated_at, created_at) DESC');

    return rifas
      .map((rifa) => this._normalizarRegistroRifa(rifa))
      .filter((rifa) => {
        return ['finalizado', 'archivada', 'depurada'].includes(String(rifa.estado || '').trim().toLowerCase())
          || Boolean(rifa.snapshot_final);
      });
  }

  async crearRifa(payload = {}, usuarioAdmin = 'SYSTEM') {
    if (!this.enabled) {
      throw new Error('Servicio de rifas no disponible');
    }

    const baseContext = await this.obtenerRifaActivaPublica();
    const baseConfig = this._resolverEstadoConfiguracion(baseContext?.configuracion || this._leerConfigDesdeDisco(), this._leerConfigDesdeDisco());
    const nuevaConfig = this._prepararConfigNuevaRifa(baseConfig, payload);

    const nombre = String(payload.nombre || payload.nombreSorteo || nuevaConfig?.rifa?.nombreSorteo || 'Nueva rifa').trim() || 'Nueva rifa';
    const slug = payload.slug ? this._slugify(payload.slug) : await this._generarSlugDisponible(nombre);

    const [creada] = await this.db('rifas')
      .insert({
        slug,
        nombre,
        estado: 'borrador',
        es_predeterminada: false,
        activa_publica: false,
        configuracion: nuevaConfig,
        created_at: this.db.fn.now(),
        updated_at: this.db.fn.now(),
        actualizado_por: usuarioAdmin
      })
      .returning('*');

    return creada;
  }

  async activarPublica(rifaId) {
    if (!this.enabled) return false;
    const id = Number.parseInt(rifaId, 10);
    if (!Number.isInteger(id) || id <= 0) {
      const error = new Error('ID de rifa inválido para activar pública');
      error.code = 'RIFA_ID_INVALIDO';
      throw error;
    }

    await this.db.transaction(async (trx) => {
      // Advisory lock transaccional (Postgres): garantiza exclusión mutua en este cambio.
      await trx.raw('SELECT pg_advisory_xact_lock(?)', [this.PUBLIC_ACTIVATION_LOCK_KEY]);

      const existe = await trx('rifas').where('id', id).whereNull('depurada_at').first();
      if (!existe) {
        const error = new Error(`Rifa ${id} no encontrada o depurada`);
        error.code = 'RIFA_NO_ENCONTRADA';
        throw error;
      }

      // Mantener la unicidad: primero apagar todas, luego prender solo la seleccionada.
      await trx('rifas').update({ activa_publica: false, updated_at: trx.fn.now() });
      await trx('rifas').where('id', id).update({ activa_publica: true, updated_at: trx.fn.now() });
    });
    this.defaultCacheAt = 0;
    return true;
  }

  async marcarDepurada(rifaId) {
    if (!this.enabled) return false;
    await this.db('rifas')
      .where('id', rifaId)
      .update({
        estado: 'depurada',
        depurada_at: this.db.fn.now(),
        updated_at: this.db.fn.now()
      });
    this.defaultCacheAt = 0;
    return true;
  }

  async obtenerSnapshotPublico(rifaIdOrSlug) {
    if (!this.enabled || !rifaIdOrSlug) return null;

    const contexto = typeof rifaIdOrSlug === 'number' || /^\d+$/.test(String(rifaIdOrSlug))
      ? await this.resolverContexto({ rifaId: Number(rifaIdOrSlug), fallbackActive: false })
      : await this.resolverContexto({ slug: String(rifaIdOrSlug), fallbackActive: false });

    if (!contexto?.snapshotFinal) {
      return null;
    }

    return {
      id: contexto.id,
      slug: contexto.slug,
      nombre: contexto.nombre,
      estado: contexto.estado,
      snapshot: this._clonar(contexto.snapshotFinal),
      finalizadaAt: contexto.finalizadaAt,
      depuracionProgramadaAt: contexto.depuracionProgramadaAt,
      depuradaAt: contexto.depuradaAt
    };
  }
}

module.exports = RifaService;
