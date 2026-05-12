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

    // 🛡️ AUDITORÍA DE SEGURIDAD PARA PRODUCCIÓN:
    // Borrado incremental/loteado (Chunked Deletion) en lugar de una única transacción masiva.
    // Esto previene bloqueos globales en las tablas compartidas (como boletos_estado),
    // evita la saturación del WAL de PostgreSQL, previene timeouts de Gateway y no agota el pool de conexiones.
    console.log(`🧹 [RifaArchiveService] Iniciando depuración segura por lotes para la rifa ID: ${rifaId}`);

    try {
      // 1. Eliminar ganadores (suelen ser muy pocos, borrado directo)
      await this.db('ganadores').where('rifa_id', rifaId).del();

      // 2. Eliminar orden_oportunidades en lotes de 5,000 para no bloquear la BD
      let deletedOportunidades = 0;
      let totalOportunidades = 0;
      do {
        deletedOportunidades = await this.db('orden_oportunidades')
          .whereIn('id', (qb) => {
            qb.select('id')
              .from('orden_oportunidades')
              .where('rifa_id', rifaId)
              .limit(5000);
          })
          .del();
        totalOportunidades += deletedOportunidades;
        if (deletedOportunidades > 0) {
          // Pequeño descanso (delay) para permitir que otras peticiones operativas entren a la BD
          await new Promise(resolve => setTimeout(resolve, 40));
        }
      } while (deletedOportunidades > 0);
      console.log(`   ✓ [RifaArchiveService] Oportunidades depuradas: ${totalOportunidades.toLocaleString()}`);

      // 3. Eliminar boletos_estado en lotes de 5,000 (puede ser 1,000,000+ de registros)
      let deletedBoletos = 0;
      let totalBoletos = 0;
      do {
        deletedBoletos = await this.db('boletos_estado')
          .whereIn('id', (qb) => {
            qb.select('id')
              .from('boletos_estado')
              .where('rifa_id', rifaId)
              .limit(5000);
          })
          .del();
        totalBoletos += deletedBoletos;
        if (deletedBoletos > 0) {
          await new Promise(resolve => setTimeout(resolve, 40));
        }
      } while (deletedBoletos > 0);
      console.log(`   ✓ [RifaArchiveService] Boletos depurados: ${totalBoletos.toLocaleString()}`);

      // 4. Eliminar ordenes en lotes de 2,000
      let deletedOrdenes = 0;
      let totalOrdenes = 0;
      do {
        deletedOrdenes = await this.db('ordenes')
          .whereIn('id', (qb) => {
            qb.select('id')
              .from('ordenes')
              .where('rifa_id', rifaId)
              .limit(2000);
          })
          .del();
        totalOrdenes += deletedOrdenes;
        if (deletedOrdenes > 0) {
          await new Promise(resolve => setTimeout(resolve, 40));
        }
      } while (deletedOrdenes > 0);
      console.log(`   ✓ [RifaArchiveService] Órdenes depuradas: ${totalOrdenes.toLocaleString()}`);

      // 5. Marcar la rifa como depurada y persistir el snapshot final
      await this.db('rifas').where('id', rifaId).update({
        estado: 'depurada',
        configuracion: configuracionActual,
        snapshot_final: snapshot,
        depurada_at: this.db.fn.now(),
        updated_at: this.db.fn.now()
      });

      console.log(`✅ [RifaArchiveService] Rifa ${rifaId} depurada exitosamente en producción.`);
      return true;

    } catch (error) {
      console.error(`❌ [RifaArchiveService] Error crítico depurando la rifa ${rifaId}:`, error.message);
      throw error; // Propagar para que el backend maneje el log del error
    }
  }
}

module.exports = RifaArchiveService;
