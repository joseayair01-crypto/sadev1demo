# 📚 Comandos Útiles - RifaPlus

Documento con los comandos más utilizados para desarrollar, testear y desplegar la aplicación.

---

## 🚀 Inicio Rápido

### Backend
```bash
cd backend
npm install              # Instalar dependencias
npm start               # Iniciar servidor en puerto 5001
npm run dev             # Modo desarrollo con nodemon
```

### Frontend
```bash
# Abrir en navegador (sin servidor especial, es HTML estático)
open index.html         # macOS
start index.html        # Windows
xdg-open index.html     # Linux
```

---

## 📦 Gestión de Dependencias

```bash
# Instalar nuevas dependencias
npm install [nombre-paquete]

# Instalar versión específica
npm install [nombre-paquete]@[versión]

# Actualizar dependencias
npm update

# Verificar dependencias desactualizadas
npm outdated

# Limpiar
npm cache clean --force
rm -rf node_modules
npm install
```

---

## 🧪 Testing

### Tests Unitarios
```bash
npm test                      # Ejecutar todos los tests
npm test -- --watch          # Modo observación
npm test -- --coverage       # Con cobertura de código
npm test [nombre-archivo]    # Test específico
```

### Tests E2E
```bash
npm run e2e                   # Ejecutar tests E2E
npm run e2e:headed          # Con interfaz visual
```

### Pruebas de Carga
```bash
npm run health-check         # Verificar salud del API

npm run load:public -- \
  --baseUrl=http://localhost:5001 \
  --path=/api/public/boletos/stats \
  --duration=60 \
  --concurrency=50

npm run load:orders -- \
  --baseUrl=http://localhost:5001 \
  --duration=30 \
  --concurrency=2 \
  --ticketStart=200000 \
  --ticketsPerOrder=3 \
  --pricePerTicket=6

# Escenario estable para validar producción sin castigar el rate limit
npm run load:orders:c5:b2:m2 -- \
  --baseUrl=https://tu-backend.up.railway.app \
  --allowRemote=true \
  --allowProduction=true

# Pico controlado para medir capacidad real con pacing
npm run load:orders:peak-controlled -- \
  --baseUrl=https://tu-backend.up.railway.app \
  --allowRemote=true \
  --allowProduction=true
```

Notas:
`load:orders:c5:b2:m2` ya respeta `Retry-After` y mete pausa entre intentos.
`load:orders:peak-controlled` sirve para estrés controlado sin convertir la prueba en bombardeo artificial desde un solo IP.

---

## 🔧 Base de Datos

### Migraciones
```bash
cd backend

# Ver estado de migraciones
npm run migrate:status

# Ejecutar migraciones pendientes
npm run migrate:up

# Deshacer última migración
npm run migrate:down

# Forzar migración específica
npm run migrate:force -- --step=5
```

### Validación y Auditoría
```bash
# Validar estructura de BD
npm run validate-db

# Auditar índices
npm run audit:indexes

# Limpiar caché
npm run clean-cache
```

### Backup y Restore
```bash
# Hacer backup
npm run backup:db
# Archivo guardado en: backend/backups/

# Restaurar desde backup
npm run restore:db -- --from=./backups/[nombre-archivo].sql
```

---

## 👤 Administración

### Usuarios Admin
```bash
cd backend

# Crear nuevo admin
npm run create-admin

# Resetear contraseña admin
npm run reset-admin-password

# Promover usuario a admin
npm run promote-admin -- --email=usuario@ejemplo.com

# Resetear todos los admins (peligroso)
npm run reset-admin
```

---

## 🌐 Git & GitHub

### Commits y Pushes
```bash
# Ver estado actual
git status

# Ver cambios
git diff

# Agregar cambios
git add .
git add [archivo-específico]

# Crear commit
git commit -m "Mensaje descriptivo"

# Pushear a GitHub
git push origin main

# Pullear cambios (actualizar local)
git pull origin main
```

### Verificar Cambios
```bash
# Ver commits recientes
git log --oneline -10

# Ver cambios específicos de un archivo
git log -p [archivo]

# Ver quién cambió cada línea
git blame [archivo]
```

### Ramas
```bash
# Listar ramas locales
git branch

# Crear nueva rama
git branch [nombre-rama]

# Cambiar de rama
git checkout [nombre-rama]

# Crear y cambiar en un comando
git checkout -b [nombre-rama]

# Eliminar rama local
git branch -d [nombre-rama]

# Eliminar rama remota
git push origin --delete [nombre-rama]
```

---

## 🚢 Despliegue

### Vercel (Frontend)
```bash
# Deploy automático (push a main)
git push origin main

# O manual
vercel deploy --prod
```

### Railway (Backend)
```bash
# verificar entorno en dashboard
# El deploy es automático cuando haces push a main

# Ver logs en producción
railway logs

# Variables de entorno
railway set VARIABLE_NAME=value
```

---

## 🔍 Debugging

### Verificar Logs
```bash
# Backend
cd backend
tail -f server-logs.txt

# Ver últimas líneas
tail -50 server-logs.txt

# Buscar errores
grep ERROR server-logs.txt
grep "404\|500" server-logs.txt
```

### Verificar Puertos
```bash
# Verificar si puerto 5001 está en uso
lsof -i :5001

# Matar proceso en puerto
kill -9 [PID]

# macOS alternativa
ps aux | grep node
```

### Limpiar Archivos Locales
```bash
# Eliminar archivos no trackeados
git clean -fd

# Reset a último commit
git reset --hard HEAD

# Descartar cambios de un archivo
git restore [archivo]

# Descartar todos los cambios
git restore .
```

---

## 📋 Configuración

### Archivos de Configuración
```bash
# Backend config
backend/config.json              # Configuración principal
backend/config.example.json      # Plantilla de ejemplo

# Frontend config
js/config.js                     # Configuración global
js/deploy-config.js              # URLs de despliegue
```

### Variables de Entorno
```bash
# Backend (.env)
cp backend/.env.example backend/.env

# Editar variables
nano backend/.env          # o tu editor favorito
```

### Sincronizar Config
```bash
cd backend
npm run sync-config-json-to-db   # BD -> JSON
npm run sync-db-to-config-json   # JSON -> BD
```

---

## 📡 API Pública

### Endpoints Útiles
```bash
# Verificar salud
curl http://localhost:5001/api/health

# Stats de boletos
curl http://localhost:5001/api/public/boletos/stats

# Órdenes stats
curl http://localhost:5001/api/public/ordenes-stats

# Boletos por rango
curl "http://localhost:5001/api/public/boletos?inicio=0&fin=99"

# Obtener config pública
curl http://localhost:5001/api/public/config
```

### Pruebas con cURL
```bash
# GET
curl -X GET "http://localhost:5001/api/endpoint"

# POST
curl -X POST http://localhost:5001/api/endpoint \
  -H "Content-Type: application/json" \
  -d '{"clave":"valor"}'

# Con autenticación
curl -H "Authorization: Bearer [token]" \
  http://localhost:5001/api/endpoint
```

---

## 🛠️ Troubleshooting

### Problema: Puerto 5001 ya está en uso
```bash
lsof -i :5001
kill -9 [PID]
npm start
```

### Problema: Module not found
```bash
rm -rf node_modules package-lock.json
npm install
```

### Problema: BD no responde
```bash
cd backend
npm run validate-db
npm run repair:db    # Si existe
```

### Problema: Cambios no se ven
```bash
# Limpiar caché
npm run clean-cache

# Hard refresh en navegador
Ctrl + Shift + R    (Chrome, Firefox, Edge)
Cmd + Shift + R     (macOS Safari: Cmd + Option + R)
```

### Problema: Git merge conflicts
```bash
# Ver conflictos
git status

# Editar archivos manualmente y resolver

# Marcar como resuelto
git add [archivo]

# Completar merge
git commit -m "Resolver conflictos"
```

---

## 📊 Monitoreo en Producción

```bash
# Railway (Backend)
railway logs --follow

# Vercel (Frontend)
vercel logs [proyecto-name]

# Verificar API en producción
curl https://sadev-production.up.railway.app/api/health
```

---

## 💾 Backups y Recuperación

```bash
# Crear backup manual de config
cp backend/config.json backend/backups/config.$(date +%s).json

# Crear backup de BD
npm run backup:db

# Ver backups existentes
ls -lah backend/backups/
```

---

## 🔐 Seguridad

```bash
# Verificar vulnerabilidades de dependencias
npm audit

# Reparar vulnerabilidades automáticamente
npm audit fix

# Regenerar certificados SSL (si aplica)
npm run generate:ssl
```

---

## ⚡ Optimización y Performance

```bash
# Analizar tamaño de bundles
npm run build:analyze

# Ver performance de BD
npm run analyze:db-performance

# Limpiar caché y rebuild
npm run clean-cache
npm run build
```

---

## 📝 Notas Importantes

- **Siempre** hacer backup antes de cambios importantes en BD
- **Verificar** `npm test` antes de hacer push
- **Revisar** los logs en producción regularmente
- **Actualizar** dependencias de forma segura
- **Documentar** cambios en README.md o en este archivo

---

## 🤝 Contribución

Al agregar cambios:
1. Crear rama: `git checkout -b feature/nombre-feature`
2. Hacer cambios
3. Test: `npm test`
4. Commit: `git commit -m "descripción clara"`
5. Push: `git push origin feature/nombre-feature`
6. Crear Pull Request en GitHub

---

**Última actualización:** 11 de Abril de 2026
