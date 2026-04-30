# Auditoría de Concurrencia y Soporte Multi-Rifa (1M+ Boletos)

He realizado una auditoría exhaustiva de la arquitectura del backend (`BoletoService`, base de datos, `POST /api/ordenes`, websockets y sistema de caché) para validar su viabilidad en escenarios de alta concurrencia con sorteos de más de 1 millón de boletos y múltiples rifas operando simultáneamente.

A continuación presento los hallazgos y el plan de mitigación.

## ✅ Lo que ya es altamente robusto (No requiere cambios)

1. **Gestión de Concurrencia en Compras (`POST /api/ordenes`)**:
   - El sistema NO usa bloqueos a nivel de tabla. Utiliza **Actualizaciones Atómicas Optimistas** (`UPDATE boletos_estado SET estado='apartado' WHERE numero IN (...) AND estado='disponible'`).
   - Verifica inmediatamente si los `boletosActualizados` coinciden con los solicitados. Si alguien más compró el mismo boleto una fracción de segundo antes, la base de datos aborta la transacción sin causar corrupción de datos.
   - Existe un índice único `UNIQUE(rifa_id, numero)` a nivel de base de datos que garantiza 100% que un boleto no puede venderse dos veces en la misma rifa.
2. **Máquina de la Suerte (Aleatorización masiva)**:
   - En lugar de cargar 1 millón de registros en la memoria RAM, utiliza una función matemática de desplazamientos con números coprimos (`_construirPasoCoprimo`). 
   - Esto significa que la RAM del servidor no colapsará sin importar si la rifa tiene 10 mil o 10 millones de boletos.

## ⚠️ Puntos Críticos Encontrados (Requieren intervención)

### 1. Fuga de Configuración (Multi-Rifa)
Actualmente, el archivo `config-manager-v2.js` es un *Singleton* (una única instancia global) que lee de la base de datos la configuración de la **rifa principal**.
**El Problema:** Cuando el backend calcula el precio a pagar, el total de boletos disponibles o las oportunidades para la "Rifa B" (Ej. Cybertruck), el sistema consulta el `ConfigManager` y este le devuelve los precios y límites de la "Rifa A" (la principal). 
**Consecuencia:** Los usuarios podrían pagar el precio equivocado, o el sistema podría colapsar si la Rifa A tiene 1000 boletos y la Rifa B tiene 1 Millón, ya que el validador limitaría la Rifa B a 1000 boletos.

### 2. Contaminación de Websockets (Tiempo Real)
El archivo `websocket-events.js` emite eventos (`boletosActualizados`, `ordenCreada`) a **todos los clientes conectados** en el canal general `/boletos`.
**El Problema:** Si 500 personas están viendo la rifa de la Cybertruck y 500 personas están viendo la rifa de un iPhone, cuando alguien compra el boleto #5 de la Cybertruck, el servidor le avisará a las 1000 personas.
**Consecuencia:** A los usuarios del iPhone se les marcará el boleto #5 como "ocupado" en sus pantallas en tiempo real, causando pánico e inconsistencias visuales severas.

---

## User Review Required

> [!IMPORTANT]
> El sistema actual soportará fácilmente 1 millón de boletos gracias a sus actualizaciones atómicas, pero **fallará catastróficamente si corres 2 rifas al mismo tiempo** con precios o tamaños diferentes debido al caché global de configuración.

¿Apruebas que proceda con las siguientes implementaciones para blindar el sistema?

## Proposed Changes

### Backend: Aislamiento de Caché de Configuración

#### [MODIFY] backend/config-manager-v2.js
- Refactorizar para soportar una memoria en caché por `rifa_id` (Ej. `this.configs = new Map()`).
- Modificar el método `cargarDesdeBD()` para cargar todas las rifas activas en la memoria.

#### [MODIFY] backend/server.js
- Actualizar `cargarConfigSorteo()` para que acepte un `rifaId` y devuelva la configuración exacta de esa rifa.
- En `POST /api/ordenes` y `GET /api/public/boletos`, pasar el `req.rifaContext.id` a `cargarConfigSorteo(rifaId)`.

### Backend & Frontend: Aislamiento de Websockets por Salas (Rooms)

#### [MODIFY] backend/services/websocket-events.js
- Modificar `emitirCambioBoletosDisponibles` y `emitirNuevaOrden` para que acepten un `rifaId` como parámetro.
- En lugar de emitir a todo el *namespace* global, emitir únicamente a una "sala" (room) específica: `boletosNamespace.to('rifa_' + rifaId).emit(...)`.
- Crear un manejador para que los clientes se suscriban a una sala al conectarse.

#### [MODIFY] js/socket-handler.js
- Al iniciar la conexión, leer el `slug` o `rifaId` de la URL actual.
- Enviar un mensaje `joinRoom` al servidor con el identificador de la rifa para recibir únicamente los eventos que le importan a esa página.

## Verification Plan

### Automated Tests
- Validar mediante el archivo de pruebas y peticiones directas que `POST /api/ordenes` respete el precio individual por rifa.

### Manual Verification
- Iniciar el servidor y verificar que los clientes en la página de "Rifa A" no reciban eventos WebSocket cuando se venden boletos en la "Rifa B".
