const db = require('../db');
const BoletoService = require('./boletoService');
const configDisco = require('../config.json');

class NuevaRifaService {
  static LOCK_KEY = BoletoService.INVENTARIO_LOCK_KEY;
  static CONFIRMACION_REQUERIDA = 'NUEVA RIFA';

  static _entero(valor) {
    return Number.parseInt(valor, 10) || 0;
  }

  static async _conLock(callback) {
    return db.transaction(async (trx) => {
      const lockResult = await trx.raw('SELECT pg_try_advisory_xact_lock(?) AS locked', [this.LOCK_KEY]);
      const locked = lockResult?.rows?.[0]?.locked === true;

      if (!locked) {
        const error = new Error('Ya hay otra operación crítica de inventario en progreso');
        error.code = 'NUEVA_RIFA_EN_PROGRESO';
        throw error;
      }

      return callback(trx);
    });
  }

  static _normalizarConfirmacion(valor) {
    return String(valor || '').trim().toUpperCase();
  }

  static _resolverEstadoResumen(bloqueos, totales) {
    if (
      bloqueos.rifaNoFinalizada
      && bloqueos.ordenesPendientes === 0
      && bloqueos.boletosApartados === 0
      && bloqueos.oportunidadesApartadas === 0
    ) {
      return {
        estado: 'bloqueado',
        resumenEstado: 'Bloqueado: la rifa actual aún no ha finalizado'
      };
    }

    if (
      bloqueos.rifaNoFinalizada
      || bloqueos.ordenesPendientes > 0
      || bloqueos.boletosApartados > 0
      || bloqueos.oportunidadesApartadas > 0
    ) {
      return {
        estado: 'bloqueado',
        resumenEstado: 'Bloqueado: hay operación activa de la rifa actual'
      };
    }

    if (
      (totales.boletos || 0) === 0
      && (totales.oportunidades || 0) === 0
      && (totales.ordenes || 0) === 0
      && (totales.ganadores || 0) === 0
      && (totales.contadoresOrden || 0) === 0
    ) {
      return {
        estado: 'limpio',
        resumenEstado: 'La BD operativa ya está limpia para una nueva rifa'
      };
    }

    return {
      estado: 'listo',
      resumenEstado: 'Listo para preparar una nueva rifa'
    };
  }

  static async _obtenerConfigActual(runner = db) {
    try {
      const hasRifas = await runner.schema.hasTable('rifas');
      if (hasRifas) {
        const rifaActiva = await runner('rifas')
          .whereNull('depurada_at')
          .where('activa_publica', true)
          .orderBy('id', 'asc')
          .first()
          || await runner('rifas')
            .whereNull('depurada_at')
            .where('es_predeterminada', true)
            .orderBy('id', 'asc')
            .first()
          || await runner('rifas')
            .whereNull('depurada_at')
            .orderBy('id', 'asc')
            .first();

        if (rifaActiva?.configuracion && typeof rifaActiva.configuracion === 'object') {
          return rifaActiva.configuracion;
        }
      }
    } catch (_) {
      // Fallback seguro más abajo
    }

    return configDisco || {};
  }

  static _resolverEstadoFinalizacionRifa(rifa = {}) {
    const estado = String(rifa?.estado || 'activo').trim().toLowerCase();
    const fechaSorteoRaw = rifa?.fechaSorteo || null;
    const fechaSorteo = fechaSorteoRaw ? new Date(fechaSorteoRaw) : null;
    const fechaSorteoValida = fechaSorteo instanceof Date && !Number.isNaN(fechaSorteo.getTime());
    const finalizadaPorEstado = estado === 'finalizado';
    const finalizadaPorFecha = fechaSorteoValida ? Date.now() >= fechaSorteo.getTime() : false;
    const finalizada = finalizadaPorEstado || finalizadaPorFecha;

    let detalle = 'La rifa actual está finalizada y ya se puede cerrar operativamente';
    if (!finalizada) {
      if (fechaSorteoValida) {
        detalle = `La rifa actual sigue vigente. Fecha programada del sorteo: ${fechaSorteo.toISOString()}`;
      } else {
        detalle = 'La rifa actual no está marcada como finalizada y no tiene una fecha de sorteo vencida';
      }
    }

    return {
      estado,
      fechaSorteo: fechaSorteoRaw,
      finalizada,
      finalizadaPorEstado,
      finalizadaPorFecha,
      detalle
    };
  }

  static _construirChecklist(bloqueos, totales, estadoRifaActual) {
    return [
      {
        id: 'rifa-finalizada',
        titulo: 'Rifa actual finalizada',
        ok: estadoRifaActual.finalizada === true,
        detalle: estadoRifaActual.detalle
      },
      {
        id: 'ordenes-pendientes',
        titulo: 'Órdenes pendientes',
        ok: bloqueos.ordenesPendientes === 0,
        detalle: bloqueos.ordenesPendientes === 0
          ? 'No hay órdenes pendientes ni comprobantes por revisar'
          : `Hay ${bloqueos.ordenesPendientes.toLocaleString()} orden(es) pendiente(s) y primero deben cerrarse`
      },
      {
        id: 'boletos-apartados',
        titulo: 'Boletos apartados',
        ok: bloqueos.boletosApartados === 0,
        detalle: bloqueos.boletosApartados === 0
          ? 'No hay boletos apartados bloqueando el reinicio'
          : `Hay ${bloqueos.boletosApartados.toLocaleString()} boleto(s) apartados todavía`
      },
      {
        id: 'oportunidades-apartadas',
        titulo: 'Oportunidades apartadas',
        ok: bloqueos.oportunidadesApartadas === 0,
        detalle: bloqueos.oportunidadesApartadas === 0
          ? 'No hay oportunidades apartadas bloqueando el reinicio'
          : `Hay ${bloqueos.oportunidadesApartadas.toLocaleString()} oportunidad(es) apartadas todavía`
      },
      {
        id: 'tablas-operativas',
        titulo: 'Alcance del reset',
        ok: true,
        detalle: `Se limpiarán boletos (${totales.boletos.toLocaleString()}), oportunidades (${totales.oportunidades.toLocaleString()}), órdenes (${totales.ordenes.toLocaleString()}), ganadores (${totales.ganadores.toLocaleString()}) y contadores (${totales.contadoresOrden.toLocaleString()})`
      }
    ];
  }

  static _construirSiguientesPasos(estado) {
    if (estado === 'bloqueado') {
      return [
        'Cierra o cancela las órdenes pendientes que todavía siguen activas',
        'Verifica que ya no queden boletos ni oportunidades apartadas',
        'Vuelve a revisar el estado antes de intentar preparar la nueva rifa'
      ];
    }

    return [
      'Guardar la nueva configuración de la rifa en este panel',
      'Poblar boletos en la nueva escala configurada',
      'Si la nueva rifa usa oportunidades, poblarlas después de cargar los boletos'
    ];
  }

  static async obtenerPreview(runner = db) {
    const configActual = await this._obtenerConfigActual(runner);
    const estadoRifaActual = this._resolverEstadoFinalizacionRifa(configActual?.rifa || {});

    const [ordenesPorEstado, conteosTablas, boletosAgg, oportunidadesAgg] = await Promise.all([
      runner('ordenes')
        .select('estado', runner.raw('COUNT(*)::int AS cantidad'))
        .groupBy('estado'),
      Promise.all([
        runner('boletos_estado').count('* as total').first(),
        runner('orden_oportunidades').count('* as total').first(),
        runner('ordenes').count('* as total').first(),
        runner('ganadores').count('* as total').first(),
        runner('order_id_counter').count('* as total').first()
      ]),
      runner('boletos_estado')
        .select(
          runner.raw('COUNT(*)::int AS total'),
          runner.raw(`SUM(CASE WHEN estado = 'apartado' THEN 1 ELSE 0 END)::int AS apartados`),
          runner.raw(`SUM(CASE WHEN estado = 'vendido' THEN 1 ELSE 0 END)::int AS vendidos`)
        )
        .first(),
      runner('orden_oportunidades')
        .select(
          runner.raw('COUNT(*)::int AS total'),
          runner.raw(`SUM(CASE WHEN estado = 'apartado' THEN 1 ELSE 0 END)::int AS apartadas`),
          runner.raw(`SUM(CASE WHEN estado = 'vendido' THEN 1 ELSE 0 END)::int AS vendidas`)
        )
        .first()
    ]);

    const ordenesMapa = {};
    ordenesPorEstado.forEach((row) => {
      ordenesMapa[String(row.estado || 'desconocido')] = this._entero(row.cantidad);
    });

    const totales = {
      boletos: this._entero(conteosTablas?.[0]?.total),
      oportunidades: this._entero(conteosTablas?.[1]?.total),
      ordenes: this._entero(conteosTablas?.[2]?.total),
      ganadores: this._entero(conteosTablas?.[3]?.total),
      contadoresOrden: this._entero(conteosTablas?.[4]?.total)
    };

    const bloqueos = {
      rifaNoFinalizada: estadoRifaActual.finalizada !== true,
      ordenesPendientes: this._entero(ordenesMapa.pendiente),
      boletosApartados: this._entero(boletosAgg?.apartados),
      oportunidadesApartadas: this._entero(oportunidadesAgg?.apartadas)
    };

    const estadoResumen = this._resolverEstadoResumen(bloqueos, totales);
    const checklist = this._construirChecklist(bloqueos, totales, estadoRifaActual);

    return {
      ...estadoResumen,
      confirmacionRequerida: this.CONFIRMACION_REQUERIDA,
      canExecute: estadoResumen.estado === 'listo',
      rifaActual: estadoRifaActual,
      tablas: totales,
      bloqueos,
      ordenes: {
        total: totales.ordenes,
        pendientes: this._entero(ordenesMapa.pendiente),
        confirmadas: this._entero(ordenesMapa.confirmada),
        canceladas: this._entero(ordenesMapa.cancelada),
        otras: Math.max(
          0,
          totales.ordenes
            - this._entero(ordenesMapa.pendiente)
            - this._entero(ordenesMapa.confirmada)
            - this._entero(ordenesMapa.cancelada)
        )
      },
      boletos: {
        total: this._entero(boletosAgg?.total),
        apartados: this._entero(boletosAgg?.apartados),
        vendidos: this._entero(boletosAgg?.vendidos)
      },
      oportunidades: {
        total: this._entero(oportunidadesAgg?.total),
        apartadas: this._entero(oportunidadesAgg?.apartadas),
        vendidas: this._entero(oportunidadesAgg?.vendidas)
      },
      checklist,
      siguientesPasos: this._construirSiguientesPasos(estadoResumen.estado)
    };
  }

  static async ejecutarReset({ confirmacion } = {}) {
    const confirmacionNormalizada = this._normalizarConfirmacion(confirmacion);
    if (confirmacionNormalizada !== this.CONFIRMACION_REQUERIDA) {
      const error = new Error(`Debes escribir exactamente "${this.CONFIRMACION_REQUERIDA}" para continuar`);
      error.code = 'CONFIRMACION_INVALIDA';
      throw error;
    }

    return this._conLock(async (trx) => {
      const preview = await this.obtenerPreview(trx);

      if (!preview.canExecute) {
        const error = new Error('No se puede preparar una nueva rifa mientras existan órdenes u apartados activos');
        error.code = 'NUEVA_RIFA_BLOQUEADA';
        error.detalles = preview.bloqueos;
        throw error;
      }

      const eliminados = {
        ganadores: Number(await trx('ganadores').del()) || 0,
        oportunidades: Number(await trx('orden_oportunidades').del()) || 0,
        boletos: Number(await trx('boletos_estado').del()) || 0,
        ordenes: Number(await trx('ordenes').del()) || 0,
        contadoresOrden: Number(await trx('order_id_counter').del()) || 0
      };

      await BoletoService.reiniciarSecuenciaId('ganadores', trx);
      await BoletoService.reiniciarSecuenciaId('orden_oportunidades', trx);
      await BoletoService.reiniciarSecuenciaId('boletos_estado', trx);
      await BoletoService.reiniciarSecuenciaId('ordenes', trx);
      await BoletoService.reiniciarSecuenciaId('order_id_counter', trx);

      const resultadoFinal = await this.obtenerPreview(trx);

      return {
        ...resultadoFinal,
        estado: 'completado',
        resumenEstado: 'Reset operativo completado. La BD quedó lista para montar la siguiente rifa',
        canExecute: false,
        resultado: {
          ...eliminados,
          secuenciasReiniciadas: 5
        }
      };
    });
  }
}

module.exports = NuevaRifaService;
