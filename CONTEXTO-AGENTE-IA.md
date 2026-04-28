# 🤖 DOCUMENTO DE CONTEXTO PARA AGENTE DE CÓDIGO - RifaPlus

**Última actualización:** 27 de abril de 2026  
**Versión del proyecto:** 2.3.0  
**Estado:** Producción  
**Ubicación:** `/Users/ayair/Desktop/rifas-web`

---

## 📌 RESUMEN EJECUTIVO

**RifaPlus** es una plataforma profesional de rifas (loterías) con sistema de compra online, pagos integrados, WebSockets en tiempo real, notificaciones push y panel de administración. Es una aplicación full-stack con backend Node.js/Express y frontend HTML5/Vanilla JS, desplegada en Vercel con BD PostgreSQL (Supabase).

**Casos de uso principales:**
- 🎟️ Compra de boletos de rifa online
- 💳 Procesamiento de pagos y comprobantes
- 📱 Notificaciones push en tiempo real
- 🎰 Sorteos con máquina de la suerte
- 👨‍💼 Panel administrativo para gestión
- 📊 Estadísticas y reportes

---

## 🏗️ ARQUITECTURA GENERAL

```
┌─────────────────────────────────────────────────────────────┐
│                    FRONTEND (Cliente)                        │
│  HTML5 + Vanilla JavaScript + CSS3                          │
│  - Compra de boletos (carrito dinámico)                    │
│  - Gestión de órdenes                                      │
│  - WebSockets en tiempo real                               │
│  - Notificaciones push                                     │
│  - Admin dashboard                                         │
└────────────────────┬────────────────────────────────────────┘
                     │ HTTP/WebSocket
                     ↓
┌─────────────────────────────────────────────────────────────┐
│                    BACKEND (API)                             │
│  Node.js + Express                                          │
│  - REST API (/api/*)                                        │
│  - WebSocket Server (Socket.io)                            │
│  - Autenticación JWT                                        │
│  - Rate limiting & validaciones                            │
│  - Integración Cloudinary                                  │
│  - Push notifications                                       │
└────────────────────┬────────────────────────────────────────┘
                     │ PostgreSQL
                     ↓
┌─────────────────────────────────────────────────────────────┐
│              DATABASE (Supabase PostgreSQL)                  │
│  - Tablas: ordenes, boletos_estado, admin_users, etc.      │
│  - Índices parciales optimizados                           │
│  - Triggers y funciones                                    │
└─────────────────────────────────────────────────────────────┘
```

---

## 🛠️ STACK TECNOLÓGICO

### Frontend
- **HTML5** - Estructura
- **Vanilla JavaScript (ES6+)** - Sin frameworks
- **CSS3** - Estilos
- **Socket.io Client** - WebSockets
- **LocalStorage** - Estado local
- **Service Workers** - Push notifications

### Backend
- **Node.js** (v18+)
- **Express.js** - Web framework
- **PostgreSQL** - Base de datos (Supabase)
- **Knex.js** - Query builder & migrations
- **JWT** - Autenticación
- **bcryptjs** - Hash de contraseñas
- **Socket.io** - WebSockets en tiempo real
- **Cloudinary** - Storage de imágenes/comprobantes
- **express-rate-limit** - Rate limiting
- **helmet** - Seguridad headers
- **CORS** - Cross-origin requests
- **compression** - Gzip

### Testing
- **Jest** - Unit & integration tests
- **Playwright** - E2E tests
- **ESLint** - Linting
- **Prettier** - Code formatting

### DevOps
- **Vercel** - Hosting
- **Railway** - Base de datos (opcional)
- **GitHub** - Version control
- **Docker** - Containerización (opcional)

---

## 📁 ESTRUCTURA DE CARPETAS

```
rifas-web/
├── index.html                          # Página principal (compra)
├── admin-*.html                        # Páginas admin (dashboard, órdenes, etc.)
├── mis-boletos.html                    # Mis boletos del usuario
├── ayuda.html                          # Página de ayuda
│
├── js/                                 # Frontend JavaScript
│   ├── compra.js                       # Lógica de compra principal
│   ├── carrito-global.js               # Estado global del carrito
│   ├── carrito-oportunidades.js        # Boletos especiales ("oportunidades")
│   ├── admin-dashboard.js              # Dashboard admin
│   ├── socket-handler.js               # WebSocket client
│   ├── push-notifications-client.js    # Push notifications client
│   ├── config.js                       # Configuración frontend
│   ├── modules/                        # Módulos reutilizables
│   └── vendor/                         # Librerías externas
│
├── css/                                # Estilos
│
├── backend/                            # Backend Node.js/Express
│   ├── server.js                       # Servidor principal
│   ├── db.js                           # Conexión Knex
│   ├── knexfile.js                     # Config Knex
│   ├── package.json                    # Dependencias backend
│   ├── .env.example                    # Variables de entorno
│   │
│   ├── services/                       # Servicios core
│   │   ├── rifaService.js              # Lógica de rifas
│   │   ├── boletoService.js            # Lógica de boletos
│   │   ├── ordenExpirationService.js   # Expiración de órdenes
│   │   ├── oportunidadesOrdenService.js  # Boletos especiales
│   │   ├── pushNotificationsService.js # Notificaciones push
│   │   ├── pushCampaignQueueService.js # Cola de campañas
│   │   ├── cloudinaryUploadService.js  # Upload a Cloudinary
│   │   └── websocket-events.js         # Eventos WebSocket
│   │
│   ├── db/                             # Migraciones DB
│   │   ├── migrations/                 # Knex migrations
│   │   └── seeds/                      # Data seeds
│   │
│   ├── config-*.js                     # Configuración dinámica
│   ├── calculo-precios-server.js       # Cálculo de precios
│   ├── audit-*.js                      # Auditoría de BD
│   └── SCHEMA.md                       # Documentación de esquema
│
├── __tests__/                          # Tests
│   ├── *.unit.test.js                  # Unit tests
│   └── *.integration.test.js           # Integration tests
│
├── e2e/                                # E2E tests (Playwright)
│
├── public/                             # Static assets
│   ├── images/                         # Imágenes
│   └── manifest.json                   # PWA manifest
│
├── scripts/                            # Utility scripts
│   ├── load-test-*.js                  # Load testing
│   ├── health-check.js                 # Health check
│   └── staging-safety-check.js         # Safety checks
│
├── _docs/                              # Documentación
│   ├── deploy-config-local.md
│   └── railway-cloudflare-variables.md
│
├── package.json                        # Root dependencies
├── jest.config.js                      # Jest configuration
├── jest.setup.js                       # Jest setup
├── vercel.json                         # Vercel config
└── COMANDOS-UTILES.md                  # Common commands
```

---

## 🔐 AUTENTICACIÓN & SEGURIDAD

### JWT (JSON Web Tokens)
- **Secret:** Configurado en `JWT_SECRET` (.env)
- **Expira:** 24 horas
- **Headers:** `Authorization: Bearer {token}`
- **Almacenamiento:** localStorage (frontend)

### Rutas Protegidas
- POST `/api/login` - Login admin
- POST `/api/logout` - Logout
- GET `/api/admin/*` - Endpoints admin
- DELETE, PATCH endpoints

### Rate Limiting
```javascript
// Diferentes límites para diferentes rutas
- Public reads: Más permisivo
- Push notifications: 40 req / 10 min
- Login: Rate limited
```

### Validaciones Críticas
- ✅ HTML sanitization (sanitize-html)
- ✅ Input validation (Joi, custom)
- ✅ SQL injection prevention (Knex parameterized)
- ✅ CORS habilitado
- ✅ Helmet security headers

---

## 📊 BASE DE DATOS - TABLAS PRINCIPALES

### ✅ `ordenes`
Pedidos de boletos realizados por clientes.

| Columna | Tipo | Descripción |
|---------|------|-------------|
| `id` | SERIAL | PK |
| `numero_orden` | VARCHAR | Único, ID público |
| `nombre_cliente` | VARCHAR | - |
| `apellido_cliente` | VARCHAR | - |
| `email` | VARCHAR | - |
| `telefono_cliente` | VARCHAR | **⭐ Usar esto, NO whatsapp** |
| `cantidad_boletos` | INTEGER | Tickets comprados |
| `precio_unitario` | DECIMAL | Precio por ticket |
| `subtotal` | DECIMAL | - |
| `descuento` | DECIMAL | - |
| `total` | DECIMAL | Monto final |
| `boletos` | JSON | Array [101, 102, ...] |
| `tipo_pago` | VARCHAR | transferencia, efectivo |
| `estado` | VARCHAR | pendiente, confirmada, cancelada |
| `comprobante_path` | VARCHAR | URL Cloudinary |
| `created_at` | TIMESTAMP | - |
| `updated_at` | TIMESTAMP | - |

### ⚠️ COLUMNAS ELIMINADAS (NO USAR)
- ❌ `whatsapp` → Use `telefono_cliente`
- ❌ `oportunidades` → Tabla separada

### ✅ `boletos_estado` (o `boletos_disponibles`)
Catálogo de todos los boletos de cada rifa.

| Columna | Tipo | Descripción |
|---------|------|-------------|
| `id` | SERIAL | PK |
| `numero` | INTEGER | 1-1000000 (ej) |
| `numero_orden` | VARCHAR | FK a orden (NULL si disponible) |
| `estado` | VARCHAR | disponible, vendido, premiado |
| `rifa_id` | INTEGER | FK a rifa |
| `created_at` | TIMESTAMP | - |

**⚠️ Índice crítico:**
```sql
CREATE INDEX idx_boletos_disponibles_para_seleccion
ON boletos_estado(numero)
WHERE estado = 'disponible' AND numero_orden IS NULL;
```

### ✅ `oportunidades`
Boletos especiales dentro de rangos específicos.

| Columna | Tipo | Descripción |
|---------|------|-------------|
| `id` | SERIAL | PK |
| `numero_inicio` | INTEGER | Ej: 100000 |
| `numero_fin` | INTEGER | Ej: 200000 |
| `descripcion` | VARCHAR | "Boletos dorados" |
| `precio_adicional` | DECIMAL | Premium price |
| `rifa_id` | INTEGER | FK |

### ✅ `admin_users`
Credenciales de administradores.

| Columna | Tipo | Descripción |
|---------|------|-------------|
| `id` | SERIAL | PK |
| `username` | VARCHAR | Único |
| `password_hash` | VARCHAR | bcrypt hash |
| `email` | VARCHAR | - |
| `role` | VARCHAR | admin, moderator |
| `created_at` | TIMESTAMP | - |

### ✅ `rifas`
Campañas de rifa (meta principal de cada sorteo).

| Columna | Tipo | Descripción |
|---------|------|-------------|
| `id` | SERIAL | PK |
| `nombre` | VARCHAR | Ej: "iPhone 15" |
| `descripcion` | TEXT | - |
| `imagen_url` | VARCHAR | URL Cloudinary |
| `estado` | VARCHAR | activa, finalizada, archivada |
| `cantidad_boletos` | INTEGER | Total tickets |
| `precio_boleto` | DECIMAL | Default price |
| `created_at` | TIMESTAMP | - |

### ✅ `push_subscriptions`
Suscripciones para notificaciones push.

| Columna | Tipo | Descripción |
|---------|------|-------------|
| `id` | SERIAL | PK |
| `order_id` | UUID | FK a orden |
| `subscription` | JSONB | {endpoint, keys} |
| `created_at` | TIMESTAMP | - |

---

## 🔌 ENDPOINTS API PRINCIPALES

### 🔓 Públicos (Sin autenticación)

#### GET `/api/health`
Health check del servidor.
```
Response: { success: true, timestamp: "2026-04-27T..." }
```

#### GET `/api/public/config`
Obtiene configuración pública (precios, rifas activas).
```
Response: {
  rifa: {
    precioBoleto: 10,
    cantidad_boletos: 100000,
    promocionPorTiempo: {...}
  }
}
```

#### GET `/api/public/boletos`
Obtiene estado de boletos disponibles.
```
Query: ?rifa_id=1&limit=100
Response: { boletos: [101, 102, ...], disponibles: 95000 }
```

#### GET `/api/ganadores`
Lista de ganadores finales.
```
Response: { ganadores: [{boleto: 12345, premio: "iPhone", ...}] }
```

#### POST `/api/ordenes`
**Crear una nueva orden (compra de boletos)**
```javascript
Body: {
  nombre_cliente: "Juan",
  apellido_cliente: "Pérez",
  email: "juan@example.com",
  telefono_cliente: "+1234567890",
  cantidad_boletos: 5,
  boletos: [101, 102, 103, 104, 105],
  precio_unitario: 10,
  total: 50,
  tipo_pago: "transferencia",
  rifa_id: 1
}

Response: {
  id: 1,
  numero_orden: "ORD-2026042712345",
  estado: "pendiente",
  created_at: "2026-04-27T12:34:56Z"
}
```

#### GET `/api/ordenes/:numero_orden`
Obtiene detalles de una orden (sin autenticación, por número público).
```
Response: {
  numero_orden: "ORD-2026042712345",
  estado: "confirmada",
  boletos: [101, 102, ...],
  total: 50
}
```

#### POST `/api/ordenes/:numero_orden/comprobante`
Sube comprobante de pago (multipart/form-data).
```
Form data:
  - archivo: <File>
  - tipo: "transferencia"

Response: {
  comprobante_path: "https://res.cloudinary.com/...",
  estado: "confirmada"
}
```

#### POST `/api/push/subscribe`
Suscribirse a notificaciones push.
```javascript
Body: {
  orderNumber: "ORD-2026042712345",
  subscription: {
    endpoint: "https://...",
    keys: { p256dh: "...", auth: "..." }
  }
}
```

#### POST `/api/push/campaign`
Enviar campaña de notificaciones (ADMIN).
```javascript
Body: {
  title: "¡Sorteo en 1 hora!",
  message: "Prepárate...",
  eventType: "SORTEO_PROXIMO",
  rifaId: 1
}
```

### 🔐 Admin (Requiere JWT)

#### POST `/api/login`
```javascript
Body: {
  username: "admin",
  password: "contraseña"
}

Response: {
  token: "eyJhbGc...",
  expiresIn: "24h"
}
```

#### GET `/api/admin/ordenes`
Listar todas las órdenes con filtros.
```
Query: ?estado=pendiente&page=1&limit=50&search=juan
Response: {
  ordenes: [...],
  total: 150,
  pages: 3
}
```

#### PATCH `/api/admin/ordenes/:id/estado`
Cambiar estado de orden.
```javascript
Body: { estado: "confirmada" }
```

#### GET `/api/admin/estadisticas`
Dashboard statistics.
```
Response: {
  totalOrdenes: 5000,
  ingresos: 50000,
  boletos_vendidos: 5000,
  ...
}
```

#### POST `/api/admin/rifa`
Crear nueva rifa.
```javascript
Body: {
  nombre: "iPhone 15",
  cantidad_boletos: 100000,
  precio_boleto: 10,
  imagen: <File>
}
```

#### GET `/api/admin/config`
Obtener configuración editable.

#### PATCH `/api/admin/config`
Actualizar configuración.

---

## 🔄 FLUJOS PRINCIPALES

### 1️⃣ FLUJO DE COMPRA

```
Cliente accede a index.html
        ↓
Carga config (precios, rifas activas)
        ↓
Selecciona boletos (carrito-global.js)
        ↓
Entra en checkout
        ↓
Completa formulario + tipo pago
        ↓
POST /api/ordenes
        ↓
Backend:
  - Valida boletos disponibles
  - Calcula descuentos (descuento compartido)
  - Calcula total
  - Crea orden (pendiente)
  - Marca boletos como reservados
        ↓
Respuesta: número_orden + QR
        ↓
Cliente ve modal "Orden Confirmada"
        ↓
Cliente sube comprobante (si aplica)
        ↓
Admin confirma en dashboard
        ↓
Orden final (confirmada)
```

### 2️⃣ FLUJO DE EXPIRACIÓN DE ÓRDENES

```
Cada X minutos (intervalo configurable):

1. Busca órdenes en estado "pendiente"
   más viejas que Y horas

2. Por cada orden expirada:
   - Libera boletos reservados
   - Cambia estado a "cancelada"
   - Notifica cliente (push)

3. Sincroniza BD
```

**Configuración dinámicamente en `/api/admin/config`:**
```javascript
{
  tiempoApartadoHoras: 48,
  intervaloLimpiezaMinutos: 30
}
```

### 3️⃣ FLUJO DE SORTEO FINAL

```
Admin inicia sorteo desde dashboard
        ↓
Sistema genera ganadores (máquina suerte):
  - Selecciona boletos de órdenes confirmadas
  - Asigna premios
  - Guarda snapshot
        ↓
WebSocket notifica a clientes en vivo
        ↓
Muestra modal "GANADOR" si cliente compró boleto ganador
        ↓
Admin publica resultados
        ↓
GET /api/ganadores muestra lista
```

### 4️⃣ FLUJO DE NOTIFICACIONES PUSH

```
1. Cliente se suscribe en compra:
   POST /api/push/subscribe
   
2. Backend almacena subscription en BD

3. Admin envía campaña:
   POST /api/push/campaign
   
4. Sistema itera suscripciones:
   - Construye payload
   - Envía por Web Push API
   - Reintenta si falla
   
5. Cliente recibe notificación
```

---

## 🎯 SERVICIOS BACKEND CLAVE

### `rifaService.js`
Gestión de campañas de rifa (crear, actualizar, listar, archivar).

**Funciones principales:**
- `crearRifa(datos)` - Nueva rifa
- `obtenerRifaActiva()` - Rifa en venta
- `finalizarRifa(rifaId)` - Terminar venta
- `archivarRifa(rifaId)` - Guardar histórico

### `boletoService.js`
Lógica de boletos (disponibilidad, selección, generación).

**Funciones principales:**
- `seleccionarBoletosAleatorios(cantidad, rifaId)` - Pick random tickets
- `marcarComoReservados(numeros, ordenId)` - Mark as reserved
- `liberarBoletos(ordenId)` - Release on expiration
- `generarBoletos(cantidad)` - Create new tickets

### `ordenExpirationService.js`
Expiración automática de órdenes pendientes.

**Funciones principales:**
- `iniciar()` - Start interval
- `limpiarOrdenesPendientes()` - Process expired
- `notificarExpiracion(orden)` - Notify client

### `oportunidadesOrdenService.js`
Gestión de boletos especiales ("oportunidades" = boletos premium en rango específico).

**Funciones principales:**
- `validarOportunidades(numeros)` - Check if premium
- `aplicarPrecioEspecial(numeros)` - Add premium price
- `crearOportunidad(config)` - Create range

### `pushNotificationsService.js`
Sistema de notificaciones push (Web Push API).

**Funciones principales:**
- `obtenerConfigPush()` - Get settings
- `enviarPushOrdenConfirmada(orden)` - Order confirmed notification
- `enviarPushOrdenPorVencer(orden)` - Warning before expiry
- `upsertSuscripcionPush(subscription)` - Save subscription

### `cloudinaryUploadService.js`
Upload de comprobantes y archivos a Cloudinary.

**Funciones principales:**
- `subirBufferACloudinary(buffer, tipo)` - Upload file
- `normalizarAssetType(tipo)` - Normalize asset type
- `construirURL(publicId)` - Build Cloudinary URL

### `websocket-events.js`
Eventos WebSocket (Socket.io) para updates en tiempo real.

**Eventos principales:**
- `nueva-rifa` - New raffle started
- `boleto-vendido` - Ticket sold
- `sorteo-iniciado` - Raffle started
- `ganador-seleccionado` - Winner selected
- `orden-confirmada` - Order confirmed

---

## 💰 CÁLCULO DE PRECIOS

### Ubicación: `backend/calculo-precios-server.js`

**Funciones clave:**
- `calcularDescuentoCompartido(numeros, rifa)` - Discount for groups
- `calcularTotalesServidor(orden)` - Final totals
- `auditarConsistenciaPrecios(ordenes)` - Audit consistency

**Regla importante:**
```javascript
// Descuento compartido: Si 2+ clientes compran boletos en secuencia,
// ambos reciben descuento
Total con descuento: (cantidad * precio) - descuento_aplicado
```

**⚠️ CRÍTICO:** El cálculo debe sincronizarse entre frontend (`js/calculo-precios.js`) y backend.

---

## 🔧 CONFIGURACIÓN DINÁMICA

### Ubicación: `backend/config-manager-v2.js`

**Configuración editable en tiempo real:**
```javascript
{
  // Rifa
  rifa: {
    precioBoleto: 10,
    nombre: "iPhone 15",
    cantidad_boletos: 100000,
    promocionPorTiempo: {
      enabled: true,
      fechaInicio: "2026-04-27",
      fechaFin: "2026-05-01",
      precioProvisional: 8
    }
  },
  
  // Expiración
  tiempoApartadoHoras: 48,
  intervaloLimpiezaMinutos: 30,
  
  // Oportunidades (boletos premium)
  oportunidades: [
    {
      numero_inicio: 100000,
      numero_fin: 200000,
      descripcion: "Boletos dorados",
      precio_adicional: 5
    }
  ]
}
```

**Acceso:**
```javascript
const config = obtenerConfigActual(); // En memoria
// O desde BD:
const configDB = await db('config').first();
```

---

## 🧪 TESTING

### Unit Tests
```bash
npm run test:unit
```
Archivos: `__tests__/component.unit.test.js`

### Integration Tests
```bash
npm run test:integration
```

### E2E Tests (Playwright)
```bash
npm run test:e2e
```
Archivos: `e2e/**.spec.js`

### Coverage
```bash
npm run test:coverage
```
Genera reporte HTML en `coverage/index.html`

**Tests críticos existentes:**
- ✅ `carrito-global-robustez.unit.test.js` - Cart logic
- ✅ `compra-grid-confiabilidad.unit.test.js` - Purchase flow
- ✅ `push-notifications-service.unit.test.js` - Push notifications
- ✅ `websocket-events.unit.test.js` - WebSocket events
- ✅ `admin-dashboard-realtime.unit.test.js` - Real-time updates

---

## 🚀 DEPLOYMENT

### Vercel (Producción)
```bash
git push origin main
# Vercel se dispara automáticamente
```

**Archivo config:** `vercel.json`

**Variables de entorno en Vercel:**
- `DATABASE_URL` - PostgreSQL connection
- `JWT_SECRET` - Secret key (32+ chars)
- `CLOUDINARY_URL` - Cloudinary API
- `NODE_ENV` - production
- Otros: `NEXT_PUBLIC_*` (frontend)

### Migraciones en Producción
```bash
npm run migration:latest
```

### Rollback en Producción
```bash
npm run migration:rollback
```

---

## 📝 CONVENCIONES & PATRONES

### Variables de Entorno
- `.env` - Desarrollo local (NO commitear)
- `.env.example` - Template público
- Vercel variables - Dashboard de Vercel

### Nombrado de Funciones
```javascript
// Servicios (Services)
obtenerXXX()     // Get from DB
crearXXX()       // Create
actualizarXXX()  // Update
eliminarXXX()    // Delete
validarXXX()     // Validate
calcularXXX()    // Calculate

// Event handlers (Frontend)
manejarClick()
inicializarXXX()
sincronizarXXX()
```

### Estructura de Errores
```javascript
{
  success: false,
  message: "Descripción del error",
  code: "ERROR_CODE",
  details: {...}
}
```

### Timestamps
- Usar `new Date()` (ISO 8601)
- Siempre en UTC
- DB: `created_at`, `updated_at` automáticos

### JSON en BD
```javascript
// Boletos guardados como array JSON
boletos: [101, 102, 103, ...]

// Subscription guardada como JSONB
subscription: {
  endpoint: "https://...",
  keys: { p256dh: "...", auth: "..." }
}
```

---

## ⚠️ CONSIDERACIONES IMPORTANTES PARA IA

### 1. Columnas Eliminadas (NUNCA usar)
```javascript
❌ orden.whatsapp           → Usar orden.telefono_cliente
❌ config.oportunidades     → Tabla separada `oportunidades`
❌ orden.ciudad             → Usar orden.ciudad_cliente
```

**Validación:** Ejecutar `npm run validate` antes de deploy.

### 2. Performance Crítica
**Máquina de la suerte debe responder en < 200ms**
```sql
-- Usa índice parcial (NO full table scan)
SELECT numero FROM boletos_estado
WHERE estado = 'disponible' AND numero_orden IS NULL
ORDER BY RANDOM()
LIMIT 100;
```

### 3. Concurrencia & Race Conditions
- Múltiples clientes comprando boletos simultáneamente
- Usar transacciones DB
- Archivo locking en operaciones críticas
- WebSocket para actualizar estado en vivo

### 4. Cálculo de Precios
**DEBE estar sincronizado frontend ↔ backend**
```javascript
// Frontend: js/calculo-precios.js
// Backend: backend/calculo-precios-server.js
// Ambos deben dar el MISMO resultado
```

### 5. Oportunidades (Boletos Premium)
- Rango de números especiales (ej: 100000-200000)
- Precio adicional automático
- Validar en compra y en confir

mación

### 6. Expiración de Órdenes
- Configurable en tiempo real
- Intervalo de limpieza automática
- Notificar cliente 24h antes
- Liberar boletos al expirar

### 7. WebSocket en Producción
- Socket.io con fallback HTTP polling
- Eventos: nueva-rifa, boleto-vendido, ganador, etc.
- Sincronizar en tiempo real entre admin ↔ clientes

### 8. Notificaciones Push
- Web Push API (estándar)
- Almacenar subscriptions en BD
- Reintento si falla
- Payload: titulo, mensaje, data (orden, etc)

### 9. Rate Limiting
```javascript
// Diferentes límites según ruta
public reads: permisivo
push: 40 req / 10 min
login: strict
admin: moderate
```

### 10. Seguridad en Compra
```javascript
// Validar en backend:
- Boletos existen en BD
- Boletos están disponibles (no reservados)
- Cliente no compra 2x mismo boleto
- Precio coincide con configuración actual
- Total es correcto
```

---

## 🎓 CÓMO EMPEZAR (Para IA)

### 1. Entender el Dominio
- "Rifa" = Sorteo/Lotería
- "Boleto" = Ticket de entrada
- "Orden" = Compra de N boletos
- "Oportunidades" = Boletos premium en rango especial

### 2. Explorar la Codebase
```bash
# Leer estos archivos primero:
- backend/server.js          # Entry point backend
- js/compra.js               # Entry point frontend
- backend/SCHEMA.md          # Esquema BD
- COMANDOS-UTILES.md         # Common commands
```

### 3. Ejecutar Localmente
```bash
cd /Users/ayair/Desktop/rifas-web

# Frontend (HTML estático, abrir en navegador)
open index.html

# Backend
cd backend
npm install
npm run dev              # Starts on port 5001
# En otra terminal:
npm run test             # Run tests
npm run audit:bd         # Audit database
```

### 4. Variables de Entorno
```bash
# backend/.env
DATABASE_URL=postgresql://user:pass@host/rifaplus
JWT_SECRET=tu-secret-muy-seguro-aqui-min-32-chars
NODE_ENV=development
CLOUDINARY_URL=cloudinary://key:secret@cloud
```

### 5. Debugging
```bash
# Ver logs del servidor
node backend/server.js

# Ver état de BD
npm run validate

# Auditoría de índices
npm run audit:bd

# Aplicar índices de performance
npm run apply:index
```

---

## 📞 CONTACTOS & RECURSOS

### Documentación Interna
- `SCHEMA.md` - Esquema BD
- `MIGRATION_GUIDE.md` - Guía de índices
- `COMANDOS-UTILES.md` - Common commands
- `_docs/deploy-*.md` - Deploy guides

### Servicios Externos
- **Supabase:** PostgreSQL hosted
- **Cloudinary:** Storage de comprobantes
- **Vercel:** Hosting + CI/CD
- **Socket.io:** WebSockets

### NPM Scripts Útiles
```bash
npm run dev                    # Dev mode (frontend + backend)
npm run dev:backend           # Backend only
npm run dev:frontend          # Frontend only
npm test                      # All tests
npm run test:unit             # Unit tests only
npm run lint                  # Fix lint issues
npm run audit:bd              # Check database
npm run apply:index           # Apply performance indexes
npm run validate:launch       # Pre-deploy validation
```

---

## 🔄 ÚLTIMA ACTUALIZACIÓN

- **Fecha:** 27 de abril de 2026
- **Versión:** 2.3.0
- **Cambios recientes:**
  - ✅ Índice parcial para máquina suerte (200ms)
  - ✅ WebSocket en tiempo real
  - ✅ Notificaciones push
  - ✅ Configuración dinámica
  - ✅ Expiración automática de órdenes
  - ✅ Oportunidades (boletos premium)

---

**Este documento debe ser la "fuente de verdad" para cualquier agente de IA trabajando en RifaPlus.**  
_Si encontras discrepancias, actualiza este documento inmediatamente._
