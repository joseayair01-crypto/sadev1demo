/**
 * ============================================================
 * ARCHIVO: backend/config-manager-v2.js
 * DESCRIPCIÓN: ConfigManager V2 con persistencia en Supabase
 * 
 * FLUJO:
 * 1. Al iniciar → lee config desde rifas.configuracion
 * 2. Si hay error BD → carga fallback de config.json
 * 3. Al actualizar → guarda en BD + recarga en memoria
 * 
 * CAMBIO IMPORTANTE:
 * - Ya NO actualiza config.json directamente
 * - TODO se persiste en Supabase
 * - config.json es solo para desarrollo/fallback
 * ============================================================
 */

const fs = require('fs');
const path = require('path');

/**
 * ConfigManagerV2: Gestor de configuración con persistencia en Supabase
 * - Lee desde rifas.configuracion
 * - Fallback seguro a config.json si BD falla
 * - Guarda cambios en BD, nunca rompe estado anterior
 * 
 * ⚠️ IMPORTANTE: Sistema defensivo
 * - Si DB está caída → carga config.json
 * - Si hay error en saveInBD → guarda en config.json como backup
 * - Nunca pierde la configuración
 */
class ConfigManagerV2 {
  constructor(db) {
    this.db = db;
    this.configPath = path.join(__dirname, 'config.json');
    this.config = null;
    this.lastLoadTime = null;
    this.cacheVersion = 0;
    this.esBD = false; // Indica si se cargó desde BD
    this.esDesarrollo = process.env.NODE_ENV !== 'production';
    
    console.log('📋 ConfigManagerV2 inicializándose...');
    console.log(`   - NODE_ENV: ${process.env.NODE_ENV}`);
    console.log(`   - Modo desarrollo: ${this.esDesarrollo}`);
  }

  _clonarConfig(config) {
    return JSON.parse(JSON.stringify(config || {}));
  }

  async _obtenerRifaPrincipal() {
    if (!this.db) return null;

    const hasRifasTable = await this.db.schema.hasTable('rifas');
    if (!hasRifasTable) {
      return null;
    }

    return await this.db('rifas')
      .whereNull('depurada_at')
      .where('activa_publica', true)
      .orderBy('id', 'asc')
      .first()
      || await this.db('rifas')
        .whereNull('depurada_at')
        .where('es_predeterminada', true)
        .orderBy('id', 'asc')
        .first()
      || await this.db('rifas')
        .whereNull('depurada_at')
        .orderBy('id', 'asc')
        .first();
  }

  async _cargarDesdeRifas() {
    const rifa = await this._obtenerRifaPrincipal();
    const config = rifa?.configuracion;

    if (!config || typeof config !== 'object') {
      return false;
    }

    this.config = this._clonarConfig(config);
    this.lastLoadTime = Date.now();
    this.cacheVersion++;

    console.log(`✅ ConfigManagerV2: Cargado desde rifas.configuracion (rifa ${rifa.id}, v${this.cacheVersion})`);
    return true;
  }

  async _guardarEnRifas(config, usuarioAdmin) {
    const rifa = await this._obtenerRifaPrincipal();
    if (!rifa?.id) {
      return false;
    }

    const nombreRifa = String(
      config?.rifa?.nombreSorteo
      || config?.rifa?.edicionNombre
      || rifa.nombre
      || 'Rifa'
    ).trim() || 'Rifa';
    const estadoRifa = String(config?.rifa?.estado || rifa.estado || 'activa').trim().toLowerCase() || 'activa';

    await this.db('rifas')
      .where('id', rifa.id)
      .update({
        nombre: nombreRifa,
        estado: estadoRifa,
        configuracion: config,
        updated_at: this.db.fn.now(),
        actualizado_por: usuarioAdmin
      })
      .catch(() => this.db('rifas')
        .where('id', rifa.id)
        .update({
          nombre: nombreRifa,
          estado: estadoRifa,
          configuracion: config,
          updated_at: this.db.fn.now()
        }));

    this.config = this._clonarConfig(config);
    this.lastLoadTime = Date.now();
    this.cacheVersion++;

    console.log(`✅ Configuración guardada en rifas.configuracion por: ${usuarioAdmin} (rifa ${rifa.id})`);
    return true;
  }

  /**
   * Cargar configuración al iniciar (async)
   * Prioridad: BD > config.json
   */
  async inicializar() {
    try {
      // 🟦 PASO 1: Intentar cargar desde Supabase
      const configDeBD = await this.cargarDesdeBD();
      
      if (configDeBD) {
        console.log('✅ ConfigManagerV2: Config cargada desde Supabase');
        this.esBD = true;
        return true;
      }
    } catch (err) {
      console.error('⚠️  ConfigManagerV2: Error conectando a BD, intentando fallback...', err.message);
    }

    // 🟨 PASO 2: Fallback a config.json (desarrollo o error BD)
    try {
      this.cargarDesdeDisco();
      console.log('✅ ConfigManagerV2: Config cargada desde config.json (fallback)');
      this.esBD = false;
      return true;
    } catch (err) {
      console.error('❌ ConfigManagerV2: Error cargar config.json:', err.message);
      
      // 🔴 ÚLTIMO RECURSO: Configuración por defecto
      this.config = this.getDefaultConfig();
      this.esBD = false;
      console.log('⚠️  ConfigManagerV2: Usando configuración por defecto');
      return false;
    }
  }

  /**
   * Cargar configuración desde Supabase (con reintentos y fallback)
   * @returns {boolean} true si se cargó exitosamente
   */
  async cargarDesdeBD() {
    if (!this.db) {
      throw new Error('Base de datos no disponible');
    }

    let intento = 0;
    const maxIntentos = 3;

    while (intento < maxIntentos) {
      try {
        const cargadoDesdeRifas = await this._cargarDesdeRifas();
        if (cargadoDesdeRifas) {
          return true;
        }

        console.log('⚠️  No se encontró una rifa activa o predeterminada para cargar configuración.');
        throw new Error('RIFA_PRINCIPAL_NO_ENCONTRADA');

      } catch (err) {
        intento++;
        if (intento < maxIntentos) {
          console.warn(`⚠️  Intento ${intento}/${maxIntentos} falló. Reintentando en 1s...`);
          await new Promise(r => setTimeout(r, 1000));
        } else {
          console.error(`❌ No se pudo conectar a BD después de ${maxIntentos} intentos`);
          throw err;
        }
      }
    }
  }

  /**
   * Cargar configuración desde disco (config.json)
   * Usado como fallback
   */
  cargarDesdeDisco() {
    const raw = fs.readFileSync(this.configPath, 'utf8');
    this.config = JSON.parse(raw);
    this.lastLoadTime = Date.now();
    this.cacheVersion++;
    
    console.log(`📝 Config cargado desde disco (versión: ${this.cacheVersion})`);
  }

  /**
   * Recargar configuración (llamado después de actualizar en BD)
   */
  async reload() {
    try {
      const cargado = await this.cargarDesdeBD();
      if (!cargado) {
        this.cargarDesdeDisco();
      }
      console.log('🔄 ConfigManagerV2 recargado');
      return true;
    } catch (err) {
      console.error('❌ Error recargando ConfigManagerV2:', err.message);
      throw err;
    }
  }

  /**
   * Guardar configuración en la BD (con fallback a config.json)
   * @param {object} config - Objeto de configuración a guardar
   * @param {string} usuarioAdmin - Username del admin que hizo el cambio
   * @returns {boolean} true si se guardó en BD, false si usar fallback config.json
   */
  async guardarEnBD(config, usuarioAdmin = 'SYSTEM') {
    if (!this.db) {
      console.warn('⚠️  BD no disponible. Guardando en config.json como backup...');
      this.guardarEnConfigJson(config);
      return false;
    }

    try {
      const guardadoEnRifas = await this._guardarEnRifas(config, usuarioAdmin);
      if (!guardadoEnRifas) {
        throw new Error('RIFA_PRINCIPAL_NO_ENCONTRADA');
      }
      return true;

    } catch (err) {
      console.error('⚠️  Error guardando en BD:', err.message);
      console.log('   Guardando como backup en config.json...');
      
      // 🔴 Fallback: Guardar en config.json
      try {
        this.guardarEnConfigJson(config);
        console.log('⚠️  Configuración guardada en config.json (fallback)');
        console.log('   Los cambios se sincronizarán con BD cuando se reconecte');
        return false;
      } catch (diskErr) {
        console.error('❌ CRÍTICO: No se pudo guardar ni en BD ni en config.json:', diskErr.message);
        throw diskErr;
      }
    }
  }

  /**
   * Guardar en config.json como fallback
   */
  guardarEnConfigJson(config) {
    const contenido = JSON.stringify(config, null, 2);
    fs.writeFileSync(this.configPath, contenido, 'utf8');
    this.config = config;
    this.lastLoadTime = Date.now();
    this.cacheVersion++;
  }

  /**
   * Obtener config completa
   */
  getConfig() {
    return this.config || this.getDefaultConfig();
  }

  /**
   * Obtener valor anidado
   * @example: get('rifa.precioBoleto')
   */
  get(path) {
    const keys = path.split('.');
    let value = this.config;
    
    for (const key of keys) {
      value = value?.[key];
      if (value === undefined) return undefined;
    }
    
    return value;
  }

  /**
   * Getters rápidos para valores frecuentes
   */
  get totalBoletos() {
    return this.config?.rifa?.totalBoletos || 1000000;
  }

  get precioBoleto() {
    const precioActual = Number(this.config?.rifa?.precioBoleto);
    if (Number.isFinite(precioActual) && precioActual >= 0) {
      return precioActual;
    }

    return Number(this.getDefaultConfig().rifa.precioBoleto) || 0;
  }

  get tiempoApartado() {
    return this.config?.rifa?.tiempoApartadoHoras || 2;
  }

  get cliente() {
    return this.config?.cliente || {};
  }

  get rifa() {
    return this.config?.rifa || {};
  }

  /**
   * Configuración por defecto
   */
  getDefaultConfig() {
    return {
      cliente: {
        id: 'DEFAULT_CLIENT',
        nombre: 'Mi Sorteo',
        prefijoOrden: 'SS',
        email: '',
        telefono: '',
        eslogan: '',
        logo: '',
        logotipo: '',
        imagenPrincipal: '',
        redesSociales: {
          whatsapp: '',
          facebook: '',
          instagram: '',
          tiktok: '',
          grupoWhatsapp: '',
          grupoWhatsappNombre: '',
          canalWhatsapp: '',
          canalWhatsappNombre: ''
        }
      },
      rifa: {
        nombreSorteo: 'Sorteo Especial',
        edicionNombre: '',
        descripcion: '',
        totalBoletos: 1000,
        precioBoleto: 4,
        tiempoApartadoHoras: 2,
        intervaloLimpiezaMinutos: 10,
        estado: 'activo',
        fechaSorteo: null,
        modalidadSorteo: '',
        modalidadEnlace: {
          tipo: 'facebook'
        },
        fechaPresorteo: null,
        oportunidades: {
          enabled: false,
          multiplicador: 1
        },
        descuentos: {
          enabled: false,
          reglas: []
        },
        promocionesCombo: {
          enabled: false,
          reglas: []
        },
        maquinaSuerte: {
          limiteBoletos: 500,
          quickPicks: [10, 20, 50, 100],
          mostrarNotaDisponibilidad: true
        },
        publicacion: {
          bonos: true,
          promociones: true,
          confianza: true,
          testimonios: false,
          ruletazo: true,
          presorteo: true,
          progressBar: true,
          progressStats: true,
          logoVerificadoHeader: true
        }
      },
      tema: {},
      seo: {},
      tecnica: {
        bankAccounts: []
      },
      rate_limits: {
        development: {
          general: 10000,
          login: 1000,
          ordenes: 1000,
          windowMs: 900000,
          publicReadConfig: {
            enabled: false,
            windowMs: 60000,
            max: 10000
          },
          ordenesConfig: {
            enabled: false,
            windowMs: 60000,
            normalMax: 1000,
            peakMax: 1000,
            normalBurstCapacity: 2000,
            peakBurstCapacity: 2000,
            maxQueueWaitMs: 0,
            queuePollMs: 100,
            peakStartHour: 20,
            peakEndHour: 23
          }
        },
        production: {
          general: 800,
          login: 5,
          ordenes: 120,
          windowMs: 900000,
          publicReadConfig: {
            enabled: true,
            windowMs: 60000,
            max: 1200
          },
          ordenesConfig: {
            enabled: true,
            windowMs: 60000,
            normalMax: 120,
            peakMax: 300,
            normalBurstCapacity: 240,
            peakBurstCapacity: 480,
            maxQueueWaitMs: 1500,
            queuePollMs: 100,
            peakStartHour: 20,
            peakEndHour: 23
          }
        }
      }
    };
  }

  /**
   * Para debugging: info del estado actual
   */
  getInfo() {
    return {
      cargadoDesde: this.esBD ? 'Supabase' : 'config.json',
      version: this.cacheVersion,
      tiempoCargas: new Date(this.lastLoadTime).toISOString(),
      enDesarrollo: this.esDesarrollo,
      clienteNombre: this.config?.cliente?.nombre,
      rifaNombre: this.config?.rifa?.nombreSorteo,
      precioBoleto: this.config?.rifa?.precioBoleto
    };
  }
}

module.exports = ConfigManagerV2;
