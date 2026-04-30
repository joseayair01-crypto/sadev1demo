/**
 * Servicio: Gestión de boletos para 1M+ registros
 * Maneja reservas, ventas y disponibilidad de forma optimizada
 * 
 * Características:
 * - Queries optimizadas con índices
 * - Transacciones para prevenir race conditions
 * - Reservas temporales durante checkout
 * - Expiración automática de reservas
 * - Retry automático con backoff exponencial
 */

const db = require('../db');
const retryService = require('./retryService');
const { normalizeRifaContext, applyRifaScope } = require('./rifaScope');

class BoletoService {
  static INVENTARIO_LOCK_KEY = 48200117;
  static TABLAS_CON_SECUENCIA_ID = new Set([
    'boletos_estado',
    'orden_oportunidades',
    'ordenes',
    'ganadores',
    'order_id_counter'
  ]);

  static _assertTablaConSecuencia(tableName) {
    if (!this.TABLAS_CON_SECUENCIA_ID.has(tableName)) {
      throw new Error(`La tabla ${tableName} no está permitida para ajuste de secuencia`);
    }
  }

  static _parseEnteroNoNegativo(valor) {
    const numero = Number.parseInt(valor, 10);
    return Number.isInteger(numero) && numero >= 0 ? numero : null;
  }

  static normalizarRangoOperacion(rango, totalBoletosConfigurado = 0) {
    const inicio = this._parseEnteroNoNegativo(rango?.inicio);
    const fin = this._parseEnteroNoNegativo(rango?.fin);
    const totalConfig = Number.parseInt(totalBoletosConfigurado, 10) || 0;

    if (!Number.isInteger(inicio) || !Number.isInteger(fin) || fin < inicio) {
      const error = new Error('Debes indicar un rango válido con inicio y fin mayores o iguales a 0');
      error.code = 'RANGO_INVALIDO';
      throw error;
    }

    if (totalConfig < 1) {
      const error = new Error('No hay un total de boletos configurado válido');
      error.code = 'CONFIG_INVALIDA';
      throw error;
    }

    if (fin >= totalConfig) {
      const error = new Error(`El rango debe quedar dentro del universo configurado: 0 - ${Math.max(0, totalConfig - 1)}`);
      error.code = 'RANGO_FUERA_CONFIG';
      throw error;
    }

    return {
      inicio,
      fin,
      cantidad: (fin - inicio) + 1,
      totalBoletosConfigurado: totalConfig
    };
  }

  static _enteroDesdeFila(valor) {
    return Number.parseInt(valor, 10) || 0;
  }

  static _normalizarContextoRifa(contexto = {}) {
    return normalizeRifaContext(contexto);
  }

  static _whereRifa(query, contexto = {}) {
    return applyRifaScope(query, contexto);
  }

  static async _conLockInventario(callback) {
    return db.transaction(async (trx) => {
      const lockResult = await trx.raw('SELECT pg_try_advisory_xact_lock(?) AS locked', [this.INVENTARIO_LOCK_KEY]);
      const locked = lockResult?.rows?.[0]?.locked === true;

      if (!locked) {
        const error = new Error('Ya hay otra operación de inventario de boletos en progreso');
        error.code = 'INVENTARIO_BOLETOS_EN_PROGRESO';
        throw error;
      }

      return callback(trx);
    });
  }

  static async reiniciarSecuenciaId(tableName, runner = db) {
    this._assertTablaConSecuencia(tableName);
    await runner.raw(`SELECT setval(pg_get_serial_sequence('${tableName}', 'id'), 1, false)`);
  }

  static async sincronizarSecuenciaId(tableName, runner = db) {
    this._assertTablaConSecuencia(tableName);
    const row = await runner(tableName).max('id as maxId').first();
    const maxId = Number.parseInt(row?.maxId ?? row?.maxid, 10) || 0;

    if (maxId > 0) {
      await runner.raw(`SELECT setval(pg_get_serial_sequence('${tableName}', 'id'), ?, true)`, [maxId]);
      return;
    }

    await this.reiniciarSecuenciaId(tableName, runner);
  }

  static async obtenerResumenInventario(totalBoletosConfigurado = 0, runner = db, contexto = {}) {
    const totalConfig = Number.parseInt(totalBoletosConfigurado, 10) || 0;

    const [general, estados, oportunidades] = await Promise.all([
      this._whereRifa(runner('boletos_estado'), contexto)
        .select(
          runner.raw('COUNT(*)::int AS total'),
          runner.raw('COALESCE(MIN(numero), 0)::int AS minimo'),
          runner.raw('COALESCE(MAX(numero), 0)::int AS maximo')
        )
        .first(),
      this._whereRifa(runner('boletos_estado'), contexto)
        .select(
          'estado',
          runner.raw('COUNT(*)::int AS cantidad')
        )
        .groupBy('estado'),
      this._whereRifa(runner('orden_oportunidades'), contexto)
        .select(
          runner.raw('COUNT(*)::int AS total_oportunidades'),
          runner.raw('COUNT(DISTINCT numero_boleto)::int AS boletos_con_oportunidades')
        )
        .first()
    ]);

    const porEstado = {
      disponible: 0,
      apartado: 0,
      vendido: 0,
      cancelado: 0
    };

    estados.forEach((row) => {
      porEstado[row.estado] = this._enteroDesdeFila(row.cantidad);
    });

    const totalEnBD = this._enteroDesdeFila(general?.total);
    const faltantesConfigurados = totalConfig > 0
      ? Math.max(0, totalConfig - totalEnBD)
      : 0;

    return {
      totalBoletosConfigurado: totalConfig,
      totalEnBD,
      faltantesConfigurados,
      porcentajeCobertura: totalConfig > 0
        ? Math.min(100, Math.round((totalEnBD / totalConfig) * 100))
        : 0,
      minimo: totalEnBD > 0 ? this._enteroDesdeFila(general?.minimo) : null,
      maximo: totalEnBD > 0 ? this._enteroDesdeFila(general?.maximo) : null,
      estados: porEstado,
      oportunidadesLigadas: this._enteroDesdeFila(oportunidades?.total_oportunidades),
      boletosConOportunidades: this._enteroDesdeFila(oportunidades?.boletos_con_oportunidades)
    };
  }

  static async previsualizarRangoBoletos(rangoNormalizado, runner = db, contexto = {}) {
    const { inicio, fin, cantidad, totalBoletosConfigurado } = rangoNormalizado;
    const { rifaId } = this._normalizarContextoRifa(contexto);

    const query = await runner.raw(`
      SELECT
        COUNT(*)::int AS existentes,
        COALESCE(SUM(CASE WHEN boleto_borrable THEN 1 ELSE 0 END), 0)::int AS boletos_borrables,
        COALESCE(SUM(CASE WHEN NOT boleto_borrable THEN 1 ELSE 0 END), 0)::int AS boletos_bloqueados_total,
        COALESCE(SUM(CASE WHEN bloqueado_por_estado THEN 1 ELSE 0 END), 0)::int AS bloqueados_por_estado,
        COALESCE(SUM(CASE WHEN (NOT bloqueado_por_estado) AND bloqueado_por_oportunidades THEN 1 ELSE 0 END), 0)::int AS bloqueados_por_oportunidades,
        COALESCE(SUM(total_oportunidades), 0)::int AS oportunidades_ligadas,
        COALESCE(SUM(CASE WHEN boleto_borrable THEN total_oportunidades ELSE 0 END), 0)::int AS oportunidades_en_boletos_borrables,
        COALESCE(SUM(oportunidades_bloqueadas), 0)::int AS oportunidades_bloqueadas
      FROM (
        SELECT
          be.numero,
          (be.estado <> 'disponible' OR be.numero_orden IS NOT NULL) AS bloqueado_por_estado,
          (COALESCE(opp_stats.oportunidades_bloqueadas, 0) > 0) AS bloqueado_por_oportunidades,
          CASE
            WHEN be.estado <> 'disponible' OR be.numero_orden IS NOT NULL THEN FALSE
            WHEN COALESCE(opp_stats.oportunidades_bloqueadas, 0) > 0 THEN FALSE
            ELSE TRUE
          END AS boleto_borrable,
          COALESCE(opp_stats.total_oportunidades, 0) AS total_oportunidades,
          COALESCE(opp_stats.oportunidades_bloqueadas, 0) AS oportunidades_bloqueadas
        FROM boletos_estado be
        LEFT JOIN (
          SELECT
            numero_boleto,
            COUNT(*)::int AS total_oportunidades,
            SUM(CASE WHEN estado <> 'disponible' OR numero_orden IS NOT NULL THEN 1 ELSE 0 END)::int AS oportunidades_bloqueadas
          FROM orden_oportunidades
          WHERE (?::int IS NULL OR rifa_id = ?::int)
            AND numero_boleto BETWEEN ? AND ?
          GROUP BY numero_boleto
        ) opp_stats
          ON opp_stats.numero_boleto = be.numero
        WHERE (?::int IS NULL OR be.rifa_id = ?::int)
          AND be.numero BETWEEN ? AND ?
      ) inventario
    `, [rifaId, rifaId, inicio, fin, rifaId, rifaId, inicio, fin]);

    const row = query?.rows?.[0] || {};
    const existentes = this._enteroDesdeFila(row.existentes);

    return {
      inicio,
      fin,
      cantidadSolicitada: cantidad,
      totalBoletosConfigurado,
      existentes,
      faltantes: Math.max(0, cantidad - existentes),
      boletosBorrables: this._enteroDesdeFila(row.boletos_borrables),
      boletosBloqueadosTotal: this._enteroDesdeFila(row.boletos_bloqueados_total),
      boletosBloqueadosPorEstado: this._enteroDesdeFila(row.bloqueados_por_estado),
      boletosBloqueadosPorOportunidades: this._enteroDesdeFila(row.bloqueados_por_oportunidades),
      oportunidadesLigadas: this._enteroDesdeFila(row.oportunidades_ligadas),
      oportunidadesEnBoletosBorrables: this._enteroDesdeFila(row.oportunidades_en_boletos_borrables),
      oportunidadesBloqueadas: this._enteroDesdeFila(row.oportunidades_bloqueadas)
    };
  }

  static async poblarRangoBoletos(rangoNormalizado, contexto = {}) {
    const { rifaId } = this._normalizarContextoRifa(contexto);
    return this._conLockInventario(async (trx) => {
      const preview = await this.previsualizarRangoBoletos(rangoNormalizado, trx, { rifaId });
      const totalTablaAntes = await this._whereRifa(trx('boletos_estado'), { rifaId }).count('* as total').first();
      const tablaVaciaAntes = this._enteroDesdeFila(totalTablaAntes?.total) === 0;

      if (preview.faltantes <= 0) {
        return {
          ...preview,
          insertados: 0
        };
      }

      if (tablaVaciaAntes) {
        await this.reiniciarSecuenciaId('boletos_estado', trx);
      } else {
        await this.sincronizarSecuenciaId('boletos_estado', trx);
      }

      const maxIdRow = await trx('boletos_estado').max('id as maxId').first();
      const maxIdActual = this._enteroDesdeFila(maxIdRow?.maxId ?? maxIdRow?.maxid);

      const insertResult = await trx.raw(`
        WITH inserted AS (
          INSERT INTO boletos_estado (id, rifa_id, numero, estado, created_at, updated_at)
          SELECT (?::int + ROW_NUMBER() OVER (ORDER BY gs))::int, ?::int, gs::int, 'disponible', NOW(), NOW()
          FROM generate_series(?::int, ?::int) AS gs
          ON CONFLICT (rifa_id, numero) DO NOTHING
          RETURNING numero
        )
        SELECT COUNT(*)::int AS total FROM inserted
      `, [maxIdActual, rifaId, rangoNormalizado.inicio, rangoNormalizado.fin]);

      await this.sincronizarSecuenciaId('boletos_estado', trx);

      return {
        ...preview,
        insertados: this._enteroDesdeFila(insertResult?.rows?.[0]?.total)
      };
    });
  }

  static async borrarRangoBoletos(rangoNormalizado, contexto = {}) {
    const { rifaId } = this._normalizarContextoRifa(contexto);
    return this._conLockInventario(async (trx) => {
      const preview = await this.previsualizarRangoBoletos(rangoNormalizado, trx, { rifaId });

      if (preview.boletosBorrables <= 0) {
        return {
          ...preview,
          eliminados: 0,
          oportunidadesEliminadas: 0
        };
      }

      const eliminados = await this._whereRifa(trx('boletos_estado'), { rifaId })
        .whereBetween('numero', [rangoNormalizado.inicio, rangoNormalizado.fin])
        .where('estado', 'disponible')
        .whereNull('numero_orden')
        .whereNotExists(function () {
          this.select(trx.raw('1'))
            .from('orden_oportunidades as oo')
            .whereRaw('oo.numero_boleto = boletos_estado.numero')
            .whereRaw('?::int IS NULL OR oo.rifa_id = ?::int', [rifaId, rifaId])
            .where(function () {
              this.whereNot('oo.estado', 'disponible').orWhereNotNull('oo.numero_orden');
            });
        })
        .del();

      return {
        ...preview,
        eliminados: Number(eliminados) || 0,
        oportunidadesEliminadas: preview.oportunidadesEnBoletosBorrables
      };
    });
  }

  static _barajarNumeros(numeros) {
    const copia = Array.isArray(numeros) ? [...numeros] : [];
    for (let i = copia.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [copia[i], copia[j]] = [copia[j], copia[i]];
    }
    return copia;
  }

  static _maximoComunDivisor(a, b) {
    let x = Math.abs(Number(a) || 0);
    let y = Math.abs(Number(b) || 0);

    while (y !== 0) {
      const temporal = y;
      y = x % y;
      x = temporal;
    }

    return x || 1;
  }

  static _construirPasoCoprimo(totalBoletos) {
    if (totalBoletos <= 1) return 1;

    let intentos = 0;
    const limiteIntentos = 32;

    while (intentos < limiteIntentos) {
      intentos += 1;
      const candidato = Math.floor(Math.random() * (totalBoletos - 1)) + 1;
      if (this._maximoComunDivisor(candidato, totalBoletos) === 1) {
        return candidato;
      }
    }

    for (let candidato = 1; candidato < totalBoletos; candidato += 1) {
      if (this._maximoComunDivisor(candidato, totalBoletos) === 1) {
        return candidato;
      }
    }

    return 1;
  }

  static _obtenerTotalBoletosConfig(contexto = {}) {
    // Si el contexto ya trae el total, usarlo (es lo más seguro y rápido)
    if (contexto && typeof contexto.totalBoletos === 'number' && contexto.totalBoletos > 0) {
      return contexto.totalBoletos;
    }

    // Si no, intentar obtenerlo del ConfigManagerV2 por rifaId
    const rifaId = contexto?.rifaId || null;
    try {
        const configManagerV2 = require('../config-manager-v2').getInstance ? require('../config-manager-v2').getInstance() : null;
        if (configManagerV2) {
            const config = configManagerV2.getConfig(rifaId);
            if (config?.rifa?.totalBoletos) {
                return Number(config.rifa.totalBoletos);
            }
        }
    } catch (e) {
        console.warn('⚠️ [BoletoService] Error accediendo a ConfigManagerV2:', e.message);
    }

    // Fallback legacy (solo si todo lo anterior falla)
    const configManagerLegacy = require('../config-manager').getInstance();
    return Number(configManagerLegacy.totalBoletos) || 0;
  }

  static _normalizarExclusiones(excludeNumbers, totalBoletos) {
    const exclusivos = Array.isArray(excludeNumbers) ? excludeNumbers : [];
    return new Set(
      exclusivos
        .map((n) => Number(n))
        .filter((n) => Number.isInteger(n) && n >= 0 && n < totalBoletos)
    );
  }

  static _queryBoletosDisponibles(contexto = {}) {
    return this._whereRifa(db('boletos_estado'), contexto)
      .where('estado', 'disponible')
      .whereNull('numero_orden');
  }

  static async _obtenerDisponiblesPorNumeros(numeros, contexto = {}) {
    const lista = Array.isArray(numeros)
      ? numeros.map((numero) => Number(numero)).filter((numero) => Number.isInteger(numero))
      : [];

    if (lista.length === 0) {
      return [];
    }

    return this._queryBoletosDisponibles(contexto)
      .whereIn('numero', lista)
      .select('numero');
  }

  static async _obtenerVentanaDisponiblesDesde(pivote, limite, contexto = {}) {
    return this._queryBoletosDisponibles(contexto)
      .where('numero', '>=', pivote)
      .select('numero')
      .orderBy('numero', 'asc')
      .limit(limite);
  }

  static async _obtenerVentanaDisponiblesAntesDe(pivote, limite, contexto = {}) {
    return this._queryBoletosDisponibles(contexto)
      .where('numero', '<', pivote)
      .select('numero')
      .orderBy('numero', 'asc')
      .limit(limite);
  }

  /**
   * Obtiene X boletos disponibles para mostrar en UI
   * OPTIMIZADO: No carga 1M registros, solo pagina actual
   * @param {number} limit - Cuántos boletos devolver
   * @param {number} offset - Desde dónde empezar (para pagination)
   * @returns {Promise<Array>}
   */
  static async obtenerBoletosDisponibles(limit = 50, offset = 0, contexto = {}) {
    try {
      const boletos = await this._queryBoletosDisponibles(contexto)
        .orderBy('numero', 'asc')
        .limit(limit)
        .offset(offset)
        .select('numero');

      // Retornar solo los números
      return boletos.map(b => b.numero);
    } catch (error) {
      console.error('Error obtenerBoletosDisponibles:', error.message);
      throw error;
    }
  }

  /**
   * Cuenta cuántos boletos disponibles hay (sin cargarlos todos)
   * @returns {Promise<number>}
   */
  static async contarBoletosDisponibles(contexto = {}) {
    try {
      const resultado = await this._queryBoletosDisponibles(contexto)
        .count('* as total')
        .first();

      return resultado.total || 0;
    } catch (error) {
      console.error('Error contarBoletosDisponibles:', error.message);
      throw error;
    }
  }

  /**
   * Obtiene el estado de boletos no disponibles dentro de un rango.
   * Pensado para la vista pública paginada/rangos, evitando cargar el universo completo.
   * @param {number} inicio
   * @param {number} fin
   * @returns {Promise<{sold: number[], reserved: number[]}>}
   */
  static async obtenerEstadoNoDisponibleEnRango(inicio, fin, contexto = {}) {
    try {
      const rangoInicio = Number(inicio);
      const rangoFin = Number(fin);

      if (!Number.isInteger(rangoInicio) || !Number.isInteger(rangoFin) || rangoInicio < 0 || rangoFin < rangoInicio) {
        throw new Error('Rango inválido para obtener estado de boletos');
      }

      const rows = await this._whereRifa(db('boletos_estado'), contexto)
        .whereIn('estado', ['vendido', 'apartado'])
        .whereBetween('numero', [rangoInicio, rangoFin])
        .select('numero', 'estado')
        .orderBy('numero', 'asc');

      const sold = [];
      const reserved = [];

      rows.forEach((row) => {
        const numero = Number(row.numero);
        if (!Number.isInteger(numero)) return;

        if (row.estado === 'vendido') {
          sold.push(numero);
        } else if (row.estado === 'apartado') {
          reserved.push(numero);
        }
      });

      return { sold, reserved };
    } catch (error) {
      console.error('Error obtenerEstadoNoDisponibleEnRango:', error.message);
      throw error;
    }
  }

  /**
   * Genera boletos aleatorios DISPONIBLES en todo el universo del sorteo.
   * No depende del rango visible en UI.
   * @param {number} cantidad
   * @param {Array<number>} excludeNumbers
   * @returns {Promise<number[]>}
   */
  static async obtenerBoletosAleatoriosDisponibles(cantidad, excludeNumbers = [], contexto = {}) {
    try {
      const cantidadSolicitada = Number(cantidad);
      if (!Number.isInteger(cantidadSolicitada) || cantidadSolicitada < 1) {
        throw new Error('cantidad debe ser un entero mayor a 0');
      }

      const totalBoletos = this._obtenerTotalBoletosConfig(contexto);
      if (totalBoletos < 1) {
        throw new Error('No hay totalBoletos configurado');
      }

      const excludeSet = this._normalizarExclusiones(excludeNumbers, totalBoletos);

      const disponiblesTotales = Number(await this.contarBoletosDisponibles(contexto)) || 0;
      if (disponiblesTotales <= 0) {
        return [];
      }

      const objetivo = Math.min(cantidadSolicitada, disponiblesTotales);
      const seleccionados = [];
      const seleccionadosSet = new Set();
      const desplazamiento = Math.floor(Math.random() * totalBoletos);
      const paso = this._construirPasoCoprimo(totalBoletos);
      const loteBase = objetivo >= 250 ? 512 : 256;
      const tamanoLote = Math.min(1024, Math.max(loteBase, objetivo * 4));
      let indicePermutacion = 0;

      while (seleccionados.length < objetivo && indicePermutacion < totalBoletos) {
        const lote = [];

        while (lote.length < tamanoLote && indicePermutacion < totalBoletos) {
          const candidato = (desplazamiento + (indicePermutacion * paso)) % totalBoletos;
          indicePermutacion += 1;

          if (excludeSet.has(candidato) || seleccionadosSet.has(candidato)) {
            continue;
          }

          lote.push(candidato);
        }

        if (lote.length === 0) {
          continue;
        }

        const disponibles = await this._obtenerDisponiblesPorNumeros(lote, contexto);
        const disponiblesSet = new Set(
          disponibles
            .map((row) => Number(row.numero))
            .filter((numero) => Number.isInteger(numero))
        );

        if (disponiblesSet.size === 0) {
          continue;
        }

        // Mantener el orden del lote respeta la permutación aleatoria del universo.
        lote.forEach((numero) => {
          if (seleccionados.length >= objetivo) return;
          if (!disponiblesSet.has(numero)) return;
          if (excludeSet.has(numero) || seleccionadosSet.has(numero)) return;

          seleccionados.push(numero);
          seleccionadosSet.add(numero);
        });
      }

      return this._barajarNumeros(seleccionados).slice(0, objetivo);
    } catch (error) {
      console.error('Error obtenerBoletosAleatoriosDisponibles:', error.message);
      throw error;
    }
  }

  /**
   * Verifica si boletos específicos están disponibles
   * CRÍTICO: Rápido incluso con 1M registros gracias a índices
   * @param {Array<number>} numeros - Números de boletos a verificar
   * @returns {Promise<{disponibles: Array, conflictos: Array}>}
   */
  static async verificarDisponibilidad(numeros, contexto = {}) {
    try {
      // Validar que numeros sea un array
      if (!Array.isArray(numeros)) {
        console.error('verificarDisponibilidad recibió no-array:', { type: typeof numeros, value: numeros });
        throw new Error(`verificarDisponibilidad: boletos debe ser un array, recibido ${typeof numeros}`);
      }

      if (numeros.length === 0) {
        return { disponibles: [], conflictos: [] };
      }

      // ===== VALIDAR RANGO DE NÚMEROS =====
      // Obtener totalBoletos desde config manager (cachea en memoria)
      const totalBoletos = this._obtenerTotalBoletosConfig(contexto);

      const boletosInvalidos = numeros.filter(num => {
        const n = Number(num);
        return isNaN(n) || n < 0 || n >= totalBoletos;
      });

      if (boletosInvalidos.length > 0) {
        console.warn(`⚠️ [BoletoService] Boletos fuera de rango (total=${totalBoletos}):`, boletosInvalidos);
        // En lugar de lanzar error (que causa 500), los devolvemos como conflictos
        return {
          disponibles: [],
          conflictos: boletosInvalidos.map(n => ({
            numero: Number(n),
            estado: 'invalido',
            mensaje: `Fuera de rango (máximo permitido: ${totalBoletos - 1})`
          }))
        };
      }

      // Query optimizada: busca solo los boletos solicitados
      const boletos = await this._whereRifa(db('boletos_estado'), contexto)
        .whereIn('numero', numeros)
        .select('numero', 'estado', 'numero_orden');

      // Separar disponibles y conflictos
      const disponibles = [];
      const conflictos = [];
      const boletosPorNumero = new Map(
        boletos.map((boleto) => [Number(boleto.numero), {
          estado: boleto.estado,
          numeroOrden: boleto.numero_orden ?? null
        }])
      );

      numeros.forEach((num) => {
        const numeroNormalizado = Number(num);
        const boleto = boletosPorNumero.get(numeroNormalizado);
        const estado = boleto?.estado;
        const numeroOrden = boleto?.numeroOrden ?? null;

        if (estado === undefined) {
          // No existe = disponible (se creará)
          disponibles.push(numeroNormalizado);
        } else if (estado === 'disponible' && numeroOrden === null) {
          // SOLO estado 'disponible' puede comprarse
          disponibles.push(numeroNormalizado);
        } else {
          // CUALQUIER otro estado (apartado, vendido, cancelado) = conflicto
          conflictos.push({
            numero: numeroNormalizado,
            estado,
            razon: estado === 'vendido'
              ? 'Ya fue pagado y vendido'
              : (numeroOrden !== null ? 'Ya está asignado a otra orden' : `Estado: ${estado}`)
          });
        }
      });

      return { disponibles, conflictos };
    } catch (error) {
      console.error('Error verificarDisponibilidad:', error.message);
      throw error;
    }
  }

  /**
   * TRANSACCIÓN CRÍTICA: Reservar boletos y crear orden
   * Todo ocurre en una transacción para evitar race conditions
  /**
   * Confirmar venta: cambiar boletos de RESERVADO a VENDIDO
   * @param {string} ordenId - ID de la orden
   * @returns {Promise<{success: boolean}>}
   */
  static async confirmarVenta(ordenId, contexto = {}) {
    try {
      const resultado = await this._whereRifa(db('boletos_estado'), contexto)
        .where('numero_orden', ordenId)
        .where('estado', 'apartado')
        .update({
          estado: 'vendido',
          updated_at: new Date()
        });

      return {
        success: true,
        boletosActualizados: resultado
      };
    } catch (error) {
      console.error('Error confirmarVenta:', error.message);
      throw error;
    }
  }

  /**
   * Cancelar orden: volver boletos a disponibles
   * ✅ MEJORADO: Triple validación para evitar boletos huérfanos
   * @param {string} ordenId - ID de la orden
   * @returns {Promise<{success: boolean, boletosLiberados: number}>}
   */
  static async cancelarOrden(ordenId, contexto = {}) {
    return db.transaction(async (trx) => {
      try {
        // PASO 1: Cambiar boletos a disponibles (por numero_orden)
        const boletosQuery = this._whereRifa(trx('boletos_estado'), contexto);
        const ordenesQuery = this._whereRifa(trx('ordenes'), contexto);

        const actualizado = await boletosQuery.clone()
          .where('numero_orden', ordenId)
          .update({
            estado: 'disponible',
            numero_orden: null,
            updated_at: new Date()
          });

        console.log(`[BoletoService.cancelarOrden] PASO 1: ${actualizado} boletos liberados`);

        // PASO 2: PROTECCIÓN: Verificar que NO haya quedado ningún boleto en estado 'apartado' con esta orden
        const huerfanos = await this._whereRifa(trx('boletos_estado'), contexto)
          .where('numero_orden', ordenId)
          .where('estado', 'apartado')
          .count('* as cnt');

        if (huerfanos[0].cnt > 0) {
          console.warn(`⚠️  [PROTECCIÓN] ${huerfanos[0].cnt} boletos apartados aún vinculados a orden ${ordenId}`);
          // Limpiar los que quedaron
          await this._whereRifa(trx('boletos_estado'), contexto)
            .where('numero_orden', ordenId)
            .update({
              estado: 'disponible',
              numero_orden: null,
              updated_at: new Date()
            });
        }

        // PASO 3: Cambiar orden a cancelada
        await ordenesQuery
          .where('numero_orden', ordenId)
          .update({
            estado: 'cancelada',
            updated_at: new Date()
          });

        console.log(`[BoletoService.cancelarOrden] Orden ${ordenId} cancelada`);

        return { success: true, boletosLiberados: actualizado };
      } catch (error) {
        throw error;
      }
    });
  }

  /**
   * Limpiar reservas expiradas (cron job)
   * Se ejecuta cada 5 minutos para liberar boletos no vendidos
   * @returns {Promise<{boletosLiberados: number}>}
   */
  static async limpiarReservasExpiradas(contexto = {}) {
    return db.transaction(async (trx) => {
      try {
        // Buscar órdenes pendientes más viejas que 4 horas
        const ordenesExpiradas = await this._whereRifa(trx('ordenes'), contexto)
          .where('estado', 'pendiente')
          .where('created_at', '<', new Date(Date.now() - 4 * 60 * 60 * 1000))
          .select('numero_orden');

        if (ordenesExpiradas.length === 0) {
          return { boletosLiberados: 0 };
        }

        const ordenIds = ordenesExpiradas.map(o => o.numero_orden);

        // Liberar boletos
        const resultado = await this._whereRifa(trx('boletos_estado'), contexto)
          .whereIn('numero_orden', ordenIds)
          .update({
            estado: 'disponible',
            numero_orden: null,
            updated_at: new Date()
          });

        // Marcar órdenes como expiradas
        await this._whereRifa(trx('ordenes'), contexto)
          .whereIn('numero_orden', ordenIds)
          .update({
            estado: 'expirada',
            updated_at: new Date()
          });

        return { boletosLiberados: resultado };
      } catch (error) {
        console.error('Error limpiarReservasExpiradas:', error.message);
        throw error;
      }
    });
  }

  /**
   * Inicializar todos los boletos (se ejecuta una sola vez)
   * Crea 1M registros de boletos disponibles
   * @param {number} totalBoletos - Cuántos crear (default 1000000)
   * @returns {Promise<{creados: number}>}
   */
  static async inicializarBoletos(totalBoletos = 1000000, contexto = {}) {
    try {
      console.log(`🚀 Inicializando ${totalBoletos} boletos...`);

      // Verificar cuántos existen
      const existentes = await this._whereRifa(db('boletos_estado'), contexto).count('* as total').first();

      if (existentes.total > 0) {
        console.log(`ℹ️  Ya existen ${existentes.total} boletos en la BD`);
        return { creados: 0, existentes: existentes.total };
      }

      // Crear en batches de 10K para no saturar memoria
      const batchSize = 10000;
      let creados = 0;

      for (let inicio = 0; inicio < totalBoletos; inicio += batchSize) {
        const fin = Math.min(inicio + batchSize - 1, totalBoletos - 1);
        const batch = [];

        for (let i = inicio; i <= fin; i++) {
          batch.push({
            ...(contexto?.rifaId ? { rifa_id: contexto.rifaId } : {}),
            numero: i,
            estado: 'disponible',
            created_at: new Date(),
            updated_at: new Date()
          });
        }

        await db('boletos_estado').insert(batch);
        creados = fin + 1;

        // Log de progreso
        if (creados % 100000 === 0) {
          console.log(`✅ ${creados}/${totalBoletos} boletos creados`);
        }
      }

      console.log(`✅ ${creados} boletos inicializados exitosamente`);
      return { creados };

    } catch (error) {
      console.error('Error inicializarBoletos:', error.message);
      throw error;
    }
  }

  /**
   * Obtener estadísticas de boletos
   * Para dashboard admin
   * @returns {Promise<Object>}
   */
  static async obtenerEstadisticas(contexto = {}) {
    try {
      const stats = await this._whereRifa(db('boletos_estado'), contexto)
        .select(
          db.raw('estado, COUNT(*) as cantidad')
        )
        .groupBy('estado');

      const resultado = {
        total: 0,
        disponible: 0,
        reservado: 0,
        vendido: 0,
        cancelado: 0
      };

      stats.forEach(s => {
        resultado[s.estado] = s.cantidad;
        resultado.total += s.cantidad;
      });

      return resultado;
    } catch (error) {
      console.error('Error obtenerEstadisticas:', error.message);
      throw error;
    }
  }
}

module.exports = BoletoService;
