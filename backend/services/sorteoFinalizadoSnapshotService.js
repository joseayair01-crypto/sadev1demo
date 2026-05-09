const crypto = require('crypto');

class SorteoFinalizadoSnapshotService {
  static MENSAJE_AGRADECIMIENTO_DEFAULT = '¡Agradecemos tu participación en nuestro sorteo! Tu confianza es lo más importante para nosotros.';

  static DOCUMENTOS_DEFAULT = {
    actaURL: null,
    videoURL: null,
    certificado: 'Verificado por notario público'
  };

  static _texto(valor) {
    return String(valor || '').trim();
  }

  static _clonar(obj) {
    return JSON.parse(JSON.stringify(obj || {}));
  }

  static crearHuellaRifa(config = {}) {
    const rifa = config?.rifa || {};
    const payload = {
      edicionNombre: this._texto(rifa.edicionNombre),
      nombreSorteo: this._texto(rifa.nombreSorteo),
      fechaSorteo: this._texto(rifa.fechaSorteo),
      totalBoletos: Number(rifa.totalBoletos) || 0,
      precioBoleto: Number(rifa.precioBoleto) || 0
    };

    return crypto
      .createHash('sha1')
      .update(JSON.stringify(payload))
      .digest('hex');
  }

  static esRifaFinalizada(rifa = {}) {
    const fechaSorteo = this._texto(rifa.fechaSorteo);
    if (fechaSorteo) {
      const fecha = new Date(fechaSorteo);
      if (!Number.isNaN(fecha.getTime())) {
        // 🛡️ Si la fecha de cierre está en el futuro, jamás puede considerarse finalizada
        if (Date.now() < fecha.getTime()) {
          return false;
        }
      }
    }

    const estado = this._texto(rifa.estado).toLowerCase() || 'activo';
    if (estado === 'finalizado') return true;

    if (!fechaSorteo) return false;

    const fecha = new Date(fechaSorteo);
    if (Number.isNaN(fecha.getTime())) return false;

    return Date.now() >= fecha.getTime();
  }

  static obtenerSnapshot(config = {}) {
    const snapshot = config?.rifa?.modalFinalizadoSnapshot;
    return snapshot && typeof snapshot === 'object' ? snapshot : null;
  }

  static snapshotCorrespondeARifaActual(snapshot, config = {}) {
    if (!snapshot?.meta?.huellaRifa) return false;
    return snapshot.meta.huellaRifa === this.crearHuellaRifa(config);
  }

  static mapearGanadores(rows = []) {
    const mapped = { sorteo: [], presorteo: [], ruletazos: [] };

    rows.forEach((r, idx) => {
      const tipoRaw = this._texto(r?.tipo_ganador).toLowerCase();
      let key = 'sorteo';
      if (tipoRaw.includes('presorte')) key = 'presorteo';
      else if (tipoRaw.includes('rulet')) key = 'ruletazos';

      mapped[key].push({
        numero: String(r?.numero_boleto || r?.numero_orden || ''),
        numero_boleto: r?.numero_boleto ?? null,
        numero_orden: r?.numero_orden ?? null,
        posicion: r?.posicion || (idx + 1),
        nombre_ganador: r?.nombre_ganador || '',
        nombre_cliente: r?.nombre_cliente || '',
        apellido_cliente: r?.apellido_cliente || '',
        ciudad: r?.ciudad || '',
        ciudad_cliente: r?.ciudad_cliente || '',
        estado_cliente: r?.estado_cliente || '',
        fecha_sorteo: r?.fecha_sorteo || '',
        created_at: r?.created_at || ''
      });
    });

    Object.keys(mapped).forEach((key) => {
      mapped[key].sort((a, b) => (Number(a.posicion) || 999) - (Number(b.posicion) || 999));
    });

    return mapped;
  }

  static construirSnapshot(config = {}, ganadoresRows = []) {
    const rifa = config?.rifa || {};
    const cliente = config?.cliente || {};
    const sorteoActivo = config?.sorteoActivo || {};

    return {
      version: 1,
      capturedAt: new Date().toISOString(),
      meta: {
        huellaRifa: this.crearHuellaRifa(config)
      },
      cliente: {
        nombre: cliente.nombre || '',
        logo: cliente.logo || cliente.logotipo || '',
        logotipo: cliente.logotipo || cliente.logo || ''
      },
      rifa: {
        nombreSorteo: rifa.nombreSorteo || '',
        sistemaPremios: this._clonar(rifa.sistemaPremios || {})
      },
      tema: this._clonar(config?.tema || {}),
      sorteo: {
        estado: 'finalizado',
        nombre: rifa.nombreSorteo || sorteoActivo.nombre || 'Sorteo finalizado',
        fechaCierre: rifa.fechaSorteo || sorteoActivo.fechaCierre || null,
        fechaCierreFormato: rifa.fechaSorteoFormato || sorteoActivo.fechaCierreFormato || '',
        mensajeAgradecimiento: sorteoActivo.mensajeAgradecimiento || this.MENSAJE_AGRADECIMIENTO_DEFAULT,
        documentos: this._clonar(sorteoActivo.documentos || this.DOCUMENTOS_DEFAULT)
      },
      ganadores: this.mapearGanadores(ganadoresRows)
    };
  }

  static actualizarSoloGanadores(snapshot = {}, ganadoresRows = []) {
    return {
      ...this._clonar(snapshot),
      ganadores: this.mapearGanadores(ganadoresRows),
      refreshedAt: new Date().toISOString()
    };
  }

  static aplicarSnapshotEnConfig(config = {}, snapshot) {
    if (!config?.rifa || !snapshot) return config;
    config.rifa.modalFinalizadoSnapshot = this._clonar(snapshot);
    return config;
  }
}

module.exports = SorteoFinalizadoSnapshotService;
