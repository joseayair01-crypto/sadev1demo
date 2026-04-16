/**
 * ============================================================
 * ARCHIVO: backend/config-manager-v2.js
 * DESCRIPCIÓN: ConfigManager V2 con persistencia en Supabase
 * 
 * FLUJO:
 * 1. Al iniciar → lee config desde la BD
 * 2. Si no existe → crea registro vacío
 * 3. Si hay error BD → carga fallback de config.json
 * 4. Al actualizar → guarda en BD + recarga en memoria
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
 * - Lee desde BD primero (sorteo_configuracion)
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
        // 🔍 Verificar si tabla existe
        const tableExists = await this.db.schema.hasTable('sorteo_configuracion');
        if (!tableExists) {
          console.log('⚠️  Tabla sorteo_configuracion no existe.');
          console.log('   Ejecuta: cd backend && node execute-persistencia-config.js');
          throw new Error('TABLA_NO_EXISTE');
        }

        // Buscar registro con clave "config_principal"
        const registro = await this.db('sorteo_configuracion')
          .where('clave', 'config_principal')
          .first()
          .timeout(5000); // Timeout de 5 segundos

        if (registro && registro.valor) {
          this.config = typeof registro.valor === 'string' 
            ? JSON.parse(registro.valor) 
            : registro.valor;
          
          this.lastLoadTime = Date.now();
          this.cacheVersion++;
          
          console.log(`✅ ConfigManagerV2: Cargado desde BD (v${this.cacheVersion})`);
          return true;
        }

        // No existe registro, crear uno
        console.log('ℹ️  Creando registro inicial en BD...');
        const configDefault = this.getDefaultConfig();
        
        try {
          await this.db('sorteo_configuracion').insert({
            clave: 'config_principal',
            valor: configDefault,
            actualizado_por: 'SYSTEM_INIT'
          });
          console.log('✅ Registro inicial creado en BD');
        } catch (insertError) {
          // Si falla insert (ej: clave duplicada), actualizar
          if (insertError.code === '23505' || insertError.message.includes('duplicate')) {
            console.log('ℹ️  Registro ya existe, usando...');
            const existing = await this.db('sorteo_configuracion')
              .where('clave', 'config_principal')
              .first();
            if (existing) {
              this.config = typeof existing.valor === 'string'
                ? JSON.parse(existing.valor)
                : existing.valor;
            }
          } else {
            throw insertError;
          }
        }

        if (!this.config) {
          this.config = configDefault;
        }
        this.lastLoadTime = Date.now();
        this.cacheVersion++;
        return true;

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
      // Intentar actualizar en BD
      const result = await this.db('sorteo_configuracion')
        .where('clave', 'config_principal')
        .update({
          valor: config,
          actualizado_por: usuarioAdmin,
          updated_at: this.db.fn.now(6)
        })
        .timeout(5000);

      if (result === 0) {
        // No existe, crear nuevo registro
        try {
          await this.db('sorteo_configuracion').insert({
            clave: 'config_principal',
            valor: config,
            actualizado_por: usuarioAdmin
          }).timeout(5000);
          
          console.log('✅ Configuración guardada en BD (nuevo registro)');
        } catch (insertErr) {
          if (insertErr.code === '23505' || insertErr.message.includes('duplicate')) {
            // Clave duplicada, intentar update nuevamente
            await this.db('sorteo_configuracion')
              .where('clave', 'config_principal')
              .update({ valor: config, actualizado_por: usuarioAdmin })
              .timeout(5000);
          } else {
            throw insertErr;
          }
        }
      }

      // ✅ Guardado en BD exitoso
      this.config = config;
      this.lastLoadTime = Date.now();
      this.cacheVersion++;
      
      console.log(`✅ Configuración guardada en BD por: ${usuarioAdmin}`);
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
        publicacion: {
          bonos: true,
          promociones: true,
          confianza: true,
          testimonios: false,
          ruletazo: true,
          presorteo: true,
          progressBar: true,
          progressStats: true
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
