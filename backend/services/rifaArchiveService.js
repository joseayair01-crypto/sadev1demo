const SorteoFinalizadoSnapshotService = require('./sorteoFinalizadoSnapshotService');

class RifaArchiveService {
  constructor(db, rifaService) {
    this.db = db;
    this.rifaService = rifaService;
    this.interval = null;
    this.isRunning = false;
    this.isExecuting = false;
  }

  iniciar(intervaloMs = 60 * 60 * 1000) {
    if (this.isRunning) return;
    this.isRunning = true;

    setTimeout(() => {
      this.procesarPendientes().catch((error) => {
        console.error('[RifaArchiveService] Error en procesamiento inicial:', error.message);
      });
    }, 5000);

    this.interval = setInterval(() => {
      this.procesarPendientes().catch((error) => {
        console.error('[RifaArchiveService] Error en procesamiento programado:', error.message);
      });
    }, intervaloMs);
  }

  detener() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.isRunning = false;
  }

  async procesarPendientes() {
    if (this.isExecuting || !this.rifaService?.enabled) {
      return;
    }

    this.isExecuting = true;
    try {
      const pendientes = await this.db('rifas')
        .whereNull('depurada_at')
        .whereNotNull('depuracion_programada_at')
        .where('depuracion_programada_at', '<=', this.db.fn.now())
        .orderBy('depuracion_programada_at', 'asc');

      for (const rifa of pendientes) {
        await this.depurarRifa(rifa.id);
      }
    } finally {
      this.isExecuting = false;
    }
  }

  async depurarRifa(rifaId) {
    const contexto = await this.rifaService.resolverContexto({ rifaId, fallbackActive: false });
    if (!contexto) return false;

    let snapshot = contexto.snapshotFinal;
    const configuracionActual = JSON.parse(JSON.stringify(contexto.configuracion || {}));
    if (!configuracionActual.rifa || typeof configuracionActual.rifa !== 'object') {
      configuracionActual.rifa = {};
    }

    if (!snapshot) {
      const ganadoresRows = await this.db('ganadores')
        .where('rifa_id', rifaId)
        .select('*')
        .orderBy([{ column: 'tipo_ganador', order: 'asc' }, { column: 'posicion', order: 'asc' }, { column: 'id', order: 'asc' }]);
      snapshot = SorteoFinalizadoSnapshotService.construirSnapshot(contexto.configuracion, ganadoresRows);
      await this.rifaService.guardarSnapshotFinal(rifaId, snapshot, {
        estado: 'archivada'
      });
    }

    configuracionActual.rifa.modalFinalizadoSnapshot = snapshot || null;
    configuracionActual.rifa.estado = 'depurada';

    await this.db.transaction(async (trx) => {
      await trx('ganadores').where('rifa_id', rifaId).del();
      await trx('orden_oportunidades').where('rifa_id', rifaId).del();
      await trx('boletos_estado').where('rifa_id', rifaId).del();
      await trx('ordenes').where('rifa_id', rifaId).del();
      await trx('rifas').where('id', rifaId).update({
        estado: 'depurada',
        configuracion: configuracionActual,
        snapshot_final: snapshot,
        depurada_at: trx.fn.now(),
        updated_at: trx.fn.now()
      });
    });

    return true;
  }
}

module.exports = RifaArchiveService;
