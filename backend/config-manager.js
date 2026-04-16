/**
 * ============================================================
 * ARCHIVO: backend/config-manager.js
 * DESCRIPCIÓN: Gestor centralizado de configuración de producción
 * 
 * Características:
 * - Carga config.json en memoria (no filesystem en cada request)
 * - Proporciona getters centralizados
 * - Soporta recargar sin reiniciar (para cambios en runtime)
 * - Cachea valores para máxima performance
 * ============================================================
 */

const fs = require('fs');
const path = require('path');

class ConfigManager {
  constructor() {
    this.configPath = path.join(__dirname, 'config.json');
    this.config = null;
    this.lastLoadTime = null;
    this.cacheVersion = 0;
    
    // Cargar configuración inicial
    this.load();
    
    console.log('✅ ConfigManager inicializado');
  }

  /**
   * Cargar configuration.json desde disco
   */
  load() {
    try {
      const raw = fs.readFileSync(this.configPath, 'utf8');
      this.config = JSON.parse(raw);
      this.lastLoadTime = Date.now();
      this.cacheVersion++;
      
      console.log(`📝 Config cargado desde config.json (versión: ${this.cacheVersion})`);
      return true;
    } catch (err) {
      console.error(`❌ Error al cargar config.json: ${err.message}`);
      
      // Valores por defecto en caso de error
      this.config = this.getDefaultConfig();
      return false;
    }
  }

  /**
   * Obtener configuración por defecto
   */
  getDefaultConfig() {
    return {
      // ✅ CRÍTICO: Información del cliente con prefijo de orden
      cliente: {
        id: 'Sorteos_El_Trebol',
        nombre: 'SORTEOS TORRES',
        prefijoOrden: 'SS',  // ✅ Fallback: SIEMPRE debe tener al menos 2 caracteres
        email: '',
        telefono: ''
      },
      rifa: {
        totalBoletos: 1000000,
        precioBoleto: 4,
        tiempoApartadoHoras: 4,
        intervaloLimpiezaMinutos: 1
      },
      cache: {
        enableRedis: false,
        ttlSeconds: 300
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
            peakStartHour: 20,
            peakEndHour: 23
          }
        }
      },
      database: {
        pool: { min: 5, max: 50 },  // ✅ AUMENTADO: 10 → 50 para escala
        queryTimeout: 30000,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000
      },
      server: {
        port: 5001,
        compression: true,
        trustProxy: true
      }
    };
  }

  /**
   * Getters centralizados para acceso rápido
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

  get tiempoApartadoHoras() {
    return this.config?.rifa?.tiempoApartadoHoras || 4;
  }

  get rateLimitConfig() {
    const env = process.env.NODE_ENV === 'production' ? 'production' : 'development';
    return this.config?.rate_limits?.[env] || this.getDefaultConfig().rate_limits[env];
  }

  get databaseConfig() {
    return this.config?.database || this.getDefaultConfig().database;
  }

  /**
   * Recargar configuración desde disco
   * Útil para cambios en runtime sin reiniciar servidor
   */
  reload() {
    return this.load();
  }

  /**
   * Exportar configuración completa
   */
  getAll() {
    return { ...this.config };
  }

  /**
   * Obtener valor anidado con fallback seguro
   * getPath('rifa.totalBoletos') → 1000000
   */
  getPath(path, defaultValue = null) {
    const keys = path.split('.');
    let current = this.config;

    for (const key of keys) {
      current = current?.[key];
      if (current === undefined) {
        return defaultValue;
      }
    }

    return current;
  }
}

// Singleton
let instance = null;

module.exports = {
  /**
   * Obtener instancia de ConfigManager (singleton)
   */
  getInstance() {
    if (!instance) {
      instance = new ConfigManager();
    }
    return instance;
  },

  /**
   * Exportar la clase para testing
   */
  ConfigManager
};
