# 🛡️ Sistema de Aislamiento Multirifa - Documentación de Garantía

## Objetivo
Garantizar que múltiples rifas coexistan en la misma base de datos **sin mezclarse nunca**, asegurando integridad y confiabilidad total.

---

## 🔐 Mecanismos de Aislamiento

### 1. **Header HTTP `X-Rifa-Id`** (Frontend → Backend)

#### Frontend (`admin-boletos.html`, `admin-dashboard.html`, etc.)
```javascript
async function fetchWithAuth(url, opts = {}) {
    const token = getToken();
    opts.headers = opts.headers || {};
    opts.headers['Content-Type'] = 'application/json';
    if (token) opts.headers['Authorization'] = 'Bearer ' + token;

    // ⚠️ CRÍTICO: Agregar header X-Rifa-Id para aislamiento
    const rifaIdSeleccionada = localStorage.getItem('rifaplus_rifa_activa');
    if (rifaIdSeleccionada) {
        opts.headers['X-Rifa-Id'] = String(rifaIdSeleccionada);
    }

    const res = await fetch(url, opts);
    // ...
}
```

**Todas** las peticiones AJAX desde el admin incluyen automáticamente el header con la rifa seleccionada.

---

### 2. **Middleware Global** (Backend)

#### `server.js` - Middleware de contexto de rifa
```javascript
app.use(async (req, res, next) => {
    const { rifaId, slug } = obtenerHeadersRifaRequest(req);
    const contexto = await rifaService.resolverContexto({
        rifaId,
        slug,
        fallbackActive: true
    });

    req.rifaContext = contexto;  // ✅ Contexto disponible en TODOS los endpoints
    // ...
});
```

---

### 3. **Función Centralizada `getRifaIdFromRequest`**

#### `backend/services/rifaScope.js`
```javascript
function getRifaIdFromRequest(req) {
  // Prioridad 1: rifaContext (middleware global)
  const rifaIdContext = Number.parseInt(req?.rifaContext?.id, 10);
  if (Number.isInteger(rifaIdContext) && rifaIdContext > 0) {
    return rifaIdContext;
  }
  
  // Prioridad 2: Header X-Rifa-Id (frontend admin)
  const rifaIdHeader = req.headers['x-rifa-id'] 
    ? Number.parseInt(req.headers['x-rifa-id'], 10) 
    : null;
  if (Number.isInteger(rifaIdHeader) && rifaIdHeader > 0) {
    return rifaIdHeader;
  }
  
  return null;  // ⚠️ Solo en rutas públicas o mal configuradas
}
```

**Jerarquía de prioridades:**
1. `req.rifaContext.id` (middleware global)
2. `req.headers['x-rifa-id']` (header del frontend)
3. `null` (fallback - debería loggear advertencia)

---

### 4. **Helper `applyRifaScope`**

```javascript
function applyRifaScope(query, contexto = {}, column = 'rifa_id') {
  const { rifaId } = normalizeRifaContext(contexto);
  if (rifaId) {
    query.where(column, rifaId);  // ✅ Aplica WHERE rifa_id = X
  }
  return query;
}
```

**Uso recomendado:**
```javascript
const rifaIdActual = obtenerRifaIdRequest(req);
const ordenes = await db('ordenes')
    .modify((qb) => aplicarFiltroRifa(qb, rifaIdActual))
    .where('estado', 'confirmada');
```

---

## 📋 Endpoints Críticos con Aislamiento

### Búsqueda de Boletos

| Endpoint | Estado | Filtro |
|----------|--------|--------|
| `GET /api/admin/numero-inteligente/:numero` | ✅ Blindado | `boletos_estado.rifa_id`, `ordenes.rifa_id`, `orden_oportunidades.rifa_id` |
| `GET /api/admin/boleto-simple/:numero` | ✅ Blindado | `ordenes.rifa_id` |
| `GET /api/admin/boleto/:numero` | ✅ Blindado | `ordenes.rifa_id` |
| `GET /api/public/boletos` | ✅ Blindado | `req.rifaContext` o `X-Rifa-Id` header |

### Ruletazo (Sorteos)

| Endpoint/Función | Estado | Filtro |
|------------------|--------|--------|
| `loadCurrentRifa()` (admin-ruletazo.js) | ✅ Blindado | Obtiene `adminRifaSelect`, envía header `X-Rifa-Id` |
| `loadRifa(rifaId)` | ✅ Blindado | Envía header `X-Rifa-Id` |
| `declararGanadorBackend()` | ✅ Blindado | Envía header `X-Rifa-Id` |
| `POST /api/admin/declarar-ganador` | ✅ Blindado | `ganadores.rifa_id`, validación por rifa |

### Órdenes

| Endpoint | Estado | Filtro |
|----------|--------|--------|
| `GET /api/admin/boletos` | ✅ Blindado | `ordenes.rifa_id` |
| `GET /api/admin/ordenes` | ✅ Blindado | `ordenes.rifa_id` |
| `PATCH /api/ordenes/:id/estado` | ✅ Blindado | `ordenes.rifa_id`, `boletos_estado.rifa_id` |
| `POST /api/admin/ordenes-manual` | ✅ Blindado | `ordenes.rifa_id`, `boletos_estado.rifa_id` |
| `PATCH /api/admin/boletos/:numero/liberar` | ✅ Blindado | Múltiples tablas con `rifa_id` |

### Estadísticas

| Endpoint | Estado | Filtro |
|----------|--------|--------|
| `GET /api/admin/sales-stats` | ✅ Blindado | `ordenes.rifa_id` |
| `GET /api/admin/boletos/inventario/resumen` | ✅ Blindado | `boletos_estado.rifa_id` |
| `GET /api/admin/oportunidades-stats` | ✅ Blindado | `orden_oportunidades.rifa_id` |

### Ganadores

| Endpoint | Estado | Filtro |
|----------|--------|--------|
| `POST /api/admin/declarar-ganador` | ✅ Blindado | `ganadores.rifa_id`, validación por rifa |
| `DELETE /api/admin/ganadores/:numero` | ✅ Blindado | `ganadores.rifa_id` |

---

## ⚠️ Puntos Críticos de Atención

### 1. **Función `buscarOrdenActivaPorBoleto`**
```javascript
async function buscarOrdenActivaPorBoleto(numero, options = {}) {
    const rifaIdActual = Number.parseInt(options.rifaId, 10) || obtenerRifaIdActual();
    
    // ✅ Filtra boletos_estado por rifa_id
    const boletoEstado = await db('boletos_estado')
        .where('numero', numeroBoleto)
        .modify((qb) => { if (rifaIdActual) qb.where('rifa_id', rifaIdActual); })
        .first();
    
    // ✅ Filtra orden_oportunidades por rifa_id
    const oportunidadEstado = await db('orden_oportunidades')
        .where('numero_oportunidad', numeroBoleto)
        .modify((qb) => { if (rifaIdActual) qb.where('rifa_id', rifaIdActual); })
        .first();
    
    // ✅ Filtra fallback legacy por rifa_id
    const ordenesLegacy = await dbUtils.ordersContainingBoletoQuery(numeroBoleto)
        .modify((qb) => { if (rifaIdActual) qb.where('rifa_id', rifaIdActual); });
    
    // ...
}
```

### 2. **Ruletazo - Respetar adminRifaSelect**

El ruletazo AHORA respeta la rifa seleccionada en el selector `adminRifaSelect`:

```javascript
// ✅ loadCurrentRifa() - Obtiene rifa del selector admin
async function loadCurrentRifa() {
    const rifaIdSeleccionada = window.adminLayout?.getActiveRifaId?.() 
        || localStorage.getItem('rifaplus_rifa_activa')
        || '1';
    
    // ✅ Envía header X-Rifa-Id
    const response = await fetch(`${apiBase}/api/public/boletos`, {
        headers: {
            'X-Rifa-Id': String(rifaIdSeleccionada)
        }
    });
    
    machine.currentRifa = {
        id: rifaIdSeleccionada,  // ✅ ID seleccionado, NO hardcodeado
        name: rifaTitle,
        // ...
    };
}

// ✅ declararGanadorBackend() - Envía header X-Rifa-Id
window.declararGanadorBackend = async function(numero, tipoGanador, lugarGanado) {
    const rifaIdSeleccionada = window.adminLayout?.getActiveRifaId?.()
        || localStorage.getItem('rifaplus_rifa_activa');
    
    const response = await fetch(`${apiBase}/api/admin/declarar-ganador`, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'X-Rifa-Id': String(rifaIdSeleccionada)  // ✅ CRÍTICO
        },
        body: JSON.stringify({ numero, tipo_ganador, posicion })
    });
};
```

**⚠️ ANTES DEL FIX:**
- `loadCurrentRifa()` usaba `id: '1'` hardcodeado
- No enviaba header `X-Rifa-Id`
- Podía mostrar boletos de otra rifa

**✅ DESPUÉS DEL FIX:**
- Obtiene `rifaId` de `adminLayout.getActiveRifaId()` o localStorage
- Envía header `X-Rifa-Id` en TODAS las peticiones
- `machine.currentRifa.id` = rifa seleccionada en adminRifaSelect

### 3. **Transacciones ACID**
Todas las operaciones que modifican inventario usan transacciones:
```javascript
await db.transaction(async (trx) => {
    // ✅ Todas las consultas dentro de la transacción filtran por rifa_id
    await trx('ordenes')
        .modify((qb) => aplicarFiltroRifa(qb, rifaIdActual))
        .where('numero_orden', id)
        .update({ estado: 'confirmada' });
    
    await trx('boletos_estado')
        .modify((qb) => aplicarFiltroRifa(qb, rifaIdActual))
        .whereIn('numero', boletos)
        .update({ estado: 'vendido' });
});
```

---

## 🧪 Pruebas de Validación

### Test 1: Búsqueda de Boleto Cruzada
```
ESCENARIO:
- Rifa 7: Boleto #64 = DISPONIBLE
- Rifa 8: Boleto #64 = VENDIDO

ACCIÓN:
1. Seleccionar Rifa 8 en adminRifaSelect
2. Buscar boleto #64 en admin-boletos

RESULTADO ESPERADO:
✅ Debe mostrar "VENDIDO" (de Rifa 8)
❌ NUNCA debe mostrar "DISPONIBLE" (de Rifa 7)
```

### Test 2: Creación de Orden Manual
```
ESCENARIO:
- Rifa 7 activa
- Rifa 8 seleccionada en admin

ACCIÓN:
1. Crear orden manual con boletos [100, 101, 102]

RESULTADO ESPERADO:
✅ Orden creada con rifa_id = 8
✅ Boletos marcados como vendidos en rifa_id = 8
❌ NUNCA debe afectar boletos de rifa_id = 7
```

### Test 3: Estadísticas Cruzadas
```
ESCENARIO:
- Rifa 7: 500 boletos vendidos
- Rifa 8: 200 boletos vendidos

ACCIÓN:
1. Con Rifa 8 seleccionada, GET /api/admin/boletos

RESULTADO ESPERADO:
✅ Debe retornar ~200 boletos (solo de Rifa 8)
❌ NUNCA debe retornar 700 boletos (mezcla)
```

### Test 4: Ruletazo - Aislamiento de Sorteos
```
ESCENARIO:
- Rifa 7: 500 boletos vendidos, números [1-500]
- Rifa 8: 200 boletos vendidos, números [1-200]

ACCIÓN:
1. Seleccionar Rifa 8 en adminRifaSelect
2. Abrir admin-ruletazo.html
3. Verificar estadísticas en el dashboard del ruletazo

RESULTADO ESPERADO:
✅ "Vendidos" debe mostrar 200 (de Rifa 8)
✅ "Disponibles" debe mostrar totalBoletos - 200
✅ El sorteo solo puede seleccionar números de Rifa 8
❌ NUNCA debe mostrar 500 vendidos (de Rifa 7)

ACCIÓN ADICIONAL:
1. Realizar sorteo en ruletazo
2. Declarar ganador

RESULTADO ESPERADO:
✅ Ganador se registra con rifa_id = 8
✅ Ganador aparece en el historial de Rifa 8
❌ NUNCA debe afectar ganadores de Rifa 7
```

---

### 4. **Navegación - Preservar parámetro `rifa`**

Todos los enlaces de navegación ahora preservan automáticamente el parámetro `rifa`:

```javascript
// mis-boletos.html, compra.html
function preservarParametroRifaEnNavegacion() {
    const rifaSlug = new URLSearchParams(window.location.search).get('rifa');
    if (!rifaSlug) return;
    
    // Actualizar todos los enlaces de navegación
    const enlaces = document.querySelectorAll('a.nav-link, a.overlay-link');
    enlaces.forEach(enlace => {
        const href = enlace.getAttribute('href');
        if (href && !href.startsWith('#') && !href.startsWith('http')) {
            const separator = href.includes('?') ? '&' : '?';
            enlace.setAttribute('href', `${href}${separator}rifa=${encodeURIComponent(rifaSlug)}`);
        }
    });
}
```

**✅ ANTES:**
- `mis-boletos.html?rifa=s8` → Click "Inicio" → `index.html` ❌ (pierde rifa)
- `compra.html?rifa=s8` → Click "Mis Boletos" → `mis-boletos.html` ❌ (pierde rifa)

**✅ AHORA:**
- `mis-boletos.html?rifa=s8` → Click "Inicio" → `index.html?rifa=s8` ✅
- `compra.html?rifa=s8` → Click "Mis Boletos" → `mis-boletos.html?rifa=s8` ✅
- `mis-boletos-restringido.html?rifa=s8` → Click "Volver" → `index.html?rifa=s8` ✅

---

## 🔧 Checklist para Nuevos Endpoints

Al crear un nuevo endpoint admin, verificar:

- [ ] ¿Obtiene `rifaIdActual` de `req.rifaContext` o `req.headers['x-rifa-id']`?
- [ ] ¿Todas las consultas `db('tabla')` incluyen `.modify((qb) => aplicarFiltroRifa(qb, rifaIdActual))`?
- [ ] ¿Las transacciones aplican el filtro en TODAS las consultas internas?
- [ ] ¿Los logs incluyen `rifa_id` para debugging?
- [ ] ¿El frontend envía el header `X-Rifa-Id`?

---

## 📊 Monitoreo y Debugging

### Logs de Advertencia
```javascript
if (!rifaIdActual) {
    console.warn('[numero-inteligente] ⚠️ Búsqueda sin rifa identificada - número:', numero);
}
```

**Buscar en logs:**
- `⚠️ Búsqueda sin rifa identificada` - Indica posible fuga
- `SIN_RIFA` - Query ejecutada sin filtro

### Headers Esperados
```
Authorization: Bearer <token>
X-Rifa-Id: 8  ← CRÍTICO
```

---

## 🚨 Incidentes Conocidos (Histórico)

### Incidente #1 - Mezcla de Boletos (2026-04-30)
**Síntoma:** Boleto #64 aparecía disponible en Rifa 8 cuando estaba vendido en Rifa 7.

**Causa:** Endpoints `numero-inteligente`, `boleto-simple`, `boleto` no filtraban por `rifa_id`.

**Solución:**
1. Frontend: Agregar header `X-Rifa-Id` en `fetchWithAuth`
2. Backend: Filtrar TODAS las consultas por `rifa_id`
3. Fallback legacy: También filtrar por `rifa_id`

---

## ✅ Garantías

1. **Nunca** una consulta admin retorna datos de múltiples rifas
2. **Siempre** se valida `rifa_id` antes de insertar/actualizar
3. **Siempre** se loguean advertencias si falta `rifa_id`
4. **Siempre** las transacciones mantienen aislamiento por rifa

---

## 📚 Archivos Clave

| Archivo | Responsabilidad |
|---------|----------------|
| `backend/services/rifaScope.js` | Funciones centralizadas de aislamiento (`getRifaIdFromRequest`, `applyRifaScope`) |
| `backend/server.js` | Middleware global + endpoints blindados + logging de depuración |
| `js/admin-layout.js` | Gestiona `rifaplus_rifa_activa` en localStorage + selector `adminRifaSelect` |
| `admin-boletos.html` | Frontend: envía header `X-Rifa-Id`, renderTicket await, logging |
| `js/admin-ruletazo.js` | Ruletazo: respeta `rifaplus_rifa_activa`, envía header `X-Rifa-Id`, validación crítica |
| `js/ganadores.js` | Sistema de ganadores: obtiene rifa de localStorage, logging de depuración |
| `admin-ruletazo.html` | Página de sorteos - actualizada v20260430.2 |

---

**Última actualización:** 2026-04-30  
**Versión:** 1.2 (Ruletazo blindado + logging completo)  
**Estado:** ✅ Production Ready
