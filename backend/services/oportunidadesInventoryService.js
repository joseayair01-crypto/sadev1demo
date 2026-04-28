const db = require('../db');
const { randomInt } = require('crypto');
const { resolverConfigOportunidades } = require('../oportunidades-config');
const BoletoService = require('./boletoService');
const { normalizeRifaContext, applyRifaScope } = require('./rifaScope');

class OportunidadesInventoryService {
  static _normalizarContextoRifa(contexto = {}) {
    return normalizeRifaContext(contexto);
  }

  static _whereRifa(query, contexto = {}) {
    return applyRifaScope(query, contexto);
  }

  static _barajarEnSitio(array) {
    const copia = [...array];
    for (let i = copia.length - 1; i > 0; i -= 1) {
      const j = randomInt(i + 1);
      [copia[i], copia[j]] = [copia[j], copia[i]];
    }
    return copia;
  }

  static _parseIntSeguro(valor) {
    return Number.parseInt(valor, 10) || 0;
  }

  static async _conLockInventario(callback) {
    return db.transaction(async (trx) => {
      const lockResult = await trx.raw('SELECT pg_try_advisory_xact_lock(?) AS locked', [BoletoService.INVENTARIO_LOCK_KEY]);
      const locked = lockResult?.rows?.[0]?.locked === true;

      if (!locked) {
        const error = new Error('Ya hay otra operación de inventario en progreso');
        error.code = 'INVENTARIO_EN_PROGRESO';
        throw error;
      }

      return callback(trx);
    });
  }

  static _resolverConfig(configBase) {
    return resolverConfigOportunidades(configBase, {
      validarComoActivas: true
    });
  }

  static _construirOportunidades(rangoOculto) {
    const numeros = [];
    for (let numero = rangoOculto.inicio; numero <= rangoOculto.fin; numero += 1) {
      numeros.push(numero);
    }
    return numeros;
  }

  static _construirAsignaciones(boletosVisibles, oportunidadesOcultas, multiplicador, shuffle = true) {
    const pool = shuffle ? this._barajarEnSitio(oportunidadesOcultas) : [...oportunidadesOcultas];
    const asignaciones = [];
    let cursor = 0;

    boletosVisibles.forEach((numeroBoleto) => {
      for (let i = 0; i < multiplicador; i += 1) {
        const numeroOportunidad = pool[cursor];
        if (!Number.isInteger(numeroOportunidad)) {
          const error = new Error(`No hay suficientes oportunidades para asignar al boleto ${numeroBoleto}`);
          error.code = 'OPORTUNIDADES_INSUFICIENTES';
          throw error;
        }

        asignaciones.push({
          numero_oportunidad: numeroOportunidad,
          numero_boleto: numeroBoleto,
          estado: 'disponible',
          numero_orden: null
        });
        cursor += 1;
      }
    });

    return asignaciones;
  }

  static async _obtenerBoletosVisibles(rangoVisible, totalEsperado, runner = db, contexto = {}) {
    const boletos = await this._whereRifa(runner('boletos_estado'), contexto)
      .whereBetween('numero', [rangoVisible.inicio, rangoVisible.fin])
      .select('numero')
      .orderBy('numero', 'asc');

    const numeros = boletos.map((row) => Number(row.numero));
    const faltantes = [];

    for (let numero = rangoVisible.inicio; numero <= rangoVisible.fin; numero += 1) {
      if (numeros[numero - rangoVisible.inicio] !== numero) {
        faltantes.push(numero);
        if (faltantes.length >= 10) break;
      }
    }

    return {
      numeros,
      encontrados: numeros.length,
      esperados: totalEsperado,
      completos: numeros.length === totalEsperado && faltantes.length === 0,
      faltantes: Math.max(0, totalEsperado - numeros.length),
      ejemplosFaltantes: faltantes
    };
  }

  static async _obtenerEstadisticasTabla(config, runner = db, contexto = {}) {
    const subqueryBoletosConCantidadCorrecta = config.rangoVisible
      ? this._whereRifa(runner('orden_oportunidades'), contexto)
        .whereBetween('numero_boleto', [config.rangoVisible.inicio, config.rangoVisible.fin])
        .select('numero_boleto')
        .count('* as oportunidades')
        .groupBy('numero_boleto')
        .havingRaw('COUNT(*) = ?', [config.multiplicador])
      : null;

    const [global, hidden, visibleAgg, visiblesConCantidadCorrecta] = await Promise.all([
      this._whereRifa(runner('orden_oportunidades'), contexto)
        .select(
          runner.raw('COUNT(*)::int AS total'),
          runner.raw('COUNT(DISTINCT numero_oportunidad)::int AS distinct_oportunidades'),
          runner.raw(`SUM(CASE WHEN estado = 'disponible' AND numero_orden IS NULL THEN 1 ELSE 0 END)::int AS disponibles`),
          runner.raw(`SUM(CASE WHEN estado = 'apartado' THEN 1 ELSE 0 END)::int AS apartadas`),
          runner.raw(`SUM(CASE WHEN estado = 'vendido' THEN 1 ELSE 0 END)::int AS vendidas`),
          runner.raw(`SUM(CASE WHEN numero_orden IS NOT NULL THEN 1 ELSE 0 END)::int AS con_numero_orden`)
        )
        .first(),
      config.rangoOculto
        ? this._whereRifa(runner('orden_oportunidades'), contexto)
          .whereBetween('numero_oportunidad', [config.rangoOculto.inicio, config.rangoOculto.fin])
          .select(
            runner.raw('COUNT(*)::int AS total'),
            runner.raw('COUNT(DISTINCT numero_oportunidad)::int AS distinct_oportunidades')
          )
          .first()
        : Promise.resolve({ total: 0, distinct_oportunidades: 0 }),
      config.rangoVisible
        ? this._whereRifa(runner('orden_oportunidades'), contexto)
          .whereBetween('numero_boleto', [config.rangoVisible.inicio, config.rangoVisible.fin])
          .select(
            runner.raw('COUNT(DISTINCT numero_boleto)::int AS boletos_con_oportunidades'),
            runner.raw(`SUM(CASE WHEN numero_oportunidad < ? OR numero_oportunidad > ? THEN 1 ELSE 0 END)::int AS oportunidades_fuera_rango`, [
              config.rangoOculto?.inicio ?? 0,
              config.rangoOculto?.fin ?? -1
            ])
          )
          .first()
        : Promise.resolve({ boletos_con_oportunidades: 0, oportunidades_fuera_rango: 0 }),
      subqueryBoletosConCantidadCorrecta
        ? runner
          .select(runner.raw('COUNT(*)::int AS total'))
          .from(subqueryBoletosConCantidadCorrecta.as('por_boleto_ok'))
          .first()
        : Promise.resolve({ total: 0 })
    ]);

    const totalGlobal = this._parseIntSeguro(global?.total);
    const totalHidden = this._parseIntSeguro(hidden?.total);
    const distinctGlobal = this._parseIntSeguro(global?.distinct_oportunidades);
    const distinctHidden = this._parseIntSeguro(hidden?.distinct_oportunidades);
    const boletosConOportunidades = this._parseIntSeguro(visibleAgg?.boletos_con_oportunidades);
    const boletosConCantidadCorrecta = this._parseIntSeguro(visiblesConCantidadCorrecta?.total);

    return {
      totalGlobal,
      totalHidden,
      totalFueraRango: Math.max(0, totalGlobal - totalHidden),
      distinctGlobal,
      distinctHidden,
      disponibles: this._parseIntSeguro(global?.disponibles),
      apartadas: this._parseIntSeguro(global?.apartadas),
      vendidas: this._parseIntSeguro(global?.vendidas),
      conNumeroOrden: this._parseIntSeguro(global?.con_numero_orden),
      boletosConOportunidades,
      boletosConCantidadCorrecta,
      boletosConCantidadIncorrecta: Math.max(0, boletosConOportunidades - boletosConCantidadCorrecta),
      boletosSinOportunidades: Math.max(0, (config.totalBoletosVisibles || 0) - boletosConOportunidades),
      oportunidadesFueraRangoVisible: this._parseIntSeguro(visibleAgg?.oportunidades_fuera_rango)
    };
  }

  static _construirPrerequisitos(config, boletosBase, stats) {
    const checklist = [
      {
        id: 'enabled',
        titulo: 'Oportunidades habilitadas',
        ok: config.enabled === true,
        detalle: config.enabled === true
          ? 'La asignación de oportunidades está activa'
          : 'Activa primero el toggle de oportunidades'
      },
      {
        id: 'config',
        titulo: 'Configuración consistente',
        ok: config.configuracionConsistente === true,
        detalle: config.configuracionConsistente === true
          ? 'Rangos y multiplicador cuadran correctamente'
          : (config.errores || []).join(' | ') || 'La configuración actual no es válida'
      },
      {
        id: 'boletos',
        titulo: 'Boletos base cargados',
        ok: boletosBase.completos === true,
        detalle: boletosBase.completos === true
          ? `${boletosBase.encontrados.toLocaleString()} boletos base listos`
          : `Esperados ${boletosBase.esperados.toLocaleString()} y encontrados ${boletosBase.encontrados.toLocaleString()}`
      },
      {
        id: 'tabla',
        titulo: 'Tabla de oportunidades lista para poblar',
        ok: stats.totalGlobal === 0,
        detalle: stats.totalGlobal === 0
          ? 'La tabla orden_oportunidades está vacía'
          : `${stats.totalGlobal.toLocaleString()} oportunidades ya existen en BD`
      }
    ];

    return checklist;
  }

  static async obtenerResumen(configBase, runner = db, contexto = {}) {
    const config = this._resolverConfig(configBase);
    const boletosBase = config.rangoVisible
      ? await this._obtenerBoletosVisibles(config.rangoVisible, config.totalBoletosVisibles, runner, contexto)
      : {
        numeros: [],
        encontrados: 0,
        esperados: 0,
        completos: false,
        faltantes: 0,
        ejemplosFaltantes: []
      };

    const stats = await this._obtenerEstadisticasTabla(config, runner, contexto);
    const prerequisitos = this._construirPrerequisitos(config, boletosBase, stats);
    const prerequisitosOk = prerequisitos.every((item) => item.ok === true);

    const alreadyPopulated = Boolean(
      config.configuracionConsistente
      && boletosBase.completos
      && stats.totalGlobal === config.totalOportunidadesEsperadas
      && stats.totalHidden === config.totalOportunidadesEsperadas
      && stats.totalFueraRango === 0
      && stats.distinctGlobal === config.totalOportunidadesEsperadas
      && stats.distinctHidden === config.totalOportunidadesEsperadas
      && stats.boletosConCantidadIncorrecta === 0
      && stats.boletosSinOportunidades === 0
      && stats.oportunidadesFueraRangoVisible === 0
    );

    let estado = 'bloqueado';
    let resumenEstado = 'No listo para poblar';
    if (alreadyPopulated) {
      estado = 'poblado';
      resumenEstado = 'Inventario ya poblado';
    } else if (prerequisitosOk) {
      estado = 'listo';
      resumenEstado = 'Listo para poblar';
    } else if (stats.totalGlobal > 0) {
      resumenEstado = 'Bloqueado: ya existen oportunidades y no están en un estado reinicializable desde admin';
    }

    return {
      enabled: config.enabled === true,
      configuracion: {
        multiplicador: config.multiplicador,
        rangoVisible: config.rangoVisible,
        rangoOculto: config.rangoOculto,
        totalBoletosVisibles: config.totalBoletosVisibles,
        totalOportunidadesEsperadas: config.totalOportunidadesEsperadas,
        totalOportunidadesConfiguradas: config.totalOportunidadesConfiguradas
      },
      erroresConfig: config.errores || [],
      prerequisitos,
      boletosBase: {
        encontrados: boletosBase.encontrados,
        esperados: boletosBase.esperados,
        completos: boletosBase.completos,
        faltantes: boletosBase.faltantes,
        ejemplosFaltantes: boletosBase.ejemplosFaltantes
      },
      oportunidades: stats,
      canPopulate: prerequisitosOk,
      alreadyPopulated,
      estado,
      resumenEstado
    };
  }

  static async poblarDesdeConfig(configBase, options = {}) {
    const shuffle = options.shuffle !== false;
    const contexto = this._normalizarContextoRifa(options);

    return this._conLockInventario(async (trx) => {
      const resumen = await this.obtenerResumen(configBase, trx, contexto);

      if (resumen.alreadyPopulated) {
        return {
          ...resumen,
          insertadas: 0
        };
      }

      if (!resumen.canPopulate) {
        const errores = resumen.prerequisitos
          .filter((item) => item.ok !== true)
          .map((item) => item.detalle);
        const error = new Error(errores.join(' | ') || 'La secuencia previa no está lista para poblar oportunidades');
        error.code = 'OPORTUNIDADES_NO_LISTAS';
        throw error;
      }

      const config = this._resolverConfig(configBase);
      const boletosBase = await this._obtenerBoletosVisibles(config.rangoVisible, config.totalBoletosVisibles, trx, contexto);
      const oportunidadesOcultas = this._construirOportunidades(config.rangoOculto);
      if ((resumen?.oportunidades?.totalGlobal || 0) === 0) {
        await BoletoService.reiniciarSecuenciaId('orden_oportunidades', trx);
      }
      const asignaciones = this._construirAsignaciones(
        boletosBase.numeros,
        oportunidadesOcultas,
        config.multiplicador,
        shuffle
      ).map((item) => ({
        ...item,
        rifa_id: contexto.rifaId
      }));

      const batchSize = 10000;
      for (let inicio = 0; inicio < asignaciones.length; inicio += batchSize) {
        const batch = asignaciones.slice(inicio, inicio + batchSize);
        await trx('orden_oportunidades').insert(batch);
      }

      await BoletoService.sincronizarSecuenciaId('orden_oportunidades', trx);

      const resumenFinal = await this.obtenerResumen(configBase, trx, contexto);
      if (!resumenFinal.alreadyPopulated) {
        const error = new Error('La validación final del poblado de oportunidades falló');
        error.code = 'VALIDACION_FINAL_OPORTUNIDADES';
        throw error;
      }

      return {
        ...resumenFinal,
        insertadas: asignaciones.length
      };
    });
  }
}

module.exports = OportunidadesInventoryService;
