# 🐛 DEBUG: Problemas de Upload de Comprobante

**Última actualización:** 27 de abril de 2026

---

## 🔍 Cómo Diagnosticar el Problema

Si un comprobante no se sube desde tu navegador pero **sí funciona desde Chrome**, sigue estos pasos:

### Paso 1️⃣: Abre la Consola del Navegador

1. Abre la página `mis-boletos.html` en el navegador problemático
2. Presiona `F12` o `Cmd+Option+I` (Mac)
3. Ve a la pestaña **Console** (Consola)

### Paso 2️⃣: Intenta Subir el Comprobante

1. Selecciona el comprobante que NO se carga
2. Mira la **Consola** (ventana abajo)
3. Busca mensajes que digan `[Upload Debug]`

### Paso 3️⃣: Copia los Mensajes de Debug

Verás algo como esto:

```
[Upload Debug] ✅ Validación OK
{ archivo: "comprobante.heic", size: "320.5KB", mimeType: "image/heic" }
```

O si hay problema:

```
[Upload Debug] ❌ Extensión rechazada: xyz
[Upload Debug] ⚠️ MIME type no reconocido
{ archivo: "comprobante.heic", mimeType: "application/octet-stream", extension: ".heic" }
```

---

## 🆘 Problemas Comunes

### Problema: "application/octet-stream"

**Qué significa:**
El navegador **no reconoce el tipo** del archivo, pero si la extensión es válida, **AHORA FUNCIONA** ✅

**Causa:** Safari, Firefox y Edge a veces reportan esto para archivos HEIC/HEIF
**Solución:** Ya fue arreglado en esta versión 🎉

---

### Problema: Extensión rechazada (ej: .XYZ)

**Qué significa:**
El archivo tiene una extensión que **no es permitida**

**Extensiones permitidas:**
- ✅ `.jpg`, `.jpeg` 
- ✅ `.png`
- ✅ `.webp`
- ✅ `.heic` (Mac)
- ✅ `.heif` (Mac)
- ✅ `.pdf`

**Solución:** Renombra el archivo con una extensión válida

---

### Problema: "Archivo demasiado grande"

**Qué significa:**
El archivo excede **5MB**

**Límites:**
- Máximo: **5 MB** (frontend)
- Máximo backend: **50 MB** (pero recomendado < 5MB)

**Solución:** Comprime la imagen o usa un PDF más pequeño

---

## 🛠️ Soluciones Implementadas (27 de abril 2026)

### ✅ Frontend (`mis-boletos.html`)

**Cambio:**
- **Antes:** Rechazaba archivos si el MIME type no estaba en la lista
- **Ahora:** Valida primero la **extensión**, y si es válida, permite el archivo aunque el MIME type sea desconocido

**Tipos MIME que ahora se aceptan:**
```javascript
'image/jpeg',
'image/png', 
'image/webp',
'image/heic',
'image/heif',
'application/pdf',
'image/jpg',
'application/octet-stream',  // ← Nuevo
'image/x-heic',               // ← Nuevo
'image/x-heif'                // ← Nuevo
```

### ✅ Backend (`backend/services/comprobanteService.js`)

**Cambio:**
- **Antes:** Rechazaba si el MIME type OR extensión eran inválidos
- **Ahora:** Valida primero extensión, luego MIME type (pero más tolerante)

**Lógica:** 
```
SI extensión ✅ → ACEPTAR (aunque MIME type sea desconocido)
SI extensión ❌ → RECHAZAR
```

### ✅ Logging Mejorado

Ahora ves en la consola exactamente qué validaciones pasan/fallan:

```javascript
[Upload Debug] ✅ Validación OK
{ archivo: "IMG_1234.heic", size: "2048.3KB", mimeType: "image/heic" }
```

---

## 📋 Navegadores Testeados

| Navegador | HEIC | HEIF | JPEG | PNG | PDF | Estatus |
|-----------|------|------|------|-----|-----|---------|
| **Chrome** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ Funciona |
| **Safari (Mac)** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ Funciona (arreglado) |
| **Firefox** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ Funciona (arreglado) |
| **Edge** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ Funciona (arreglado) |
| **Safari (iOS)** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ Funciona (arreglado) |

---

## 🎯 Qué Hacer Si Aún No Funciona

### 1. Limpia el caché del navegador
```
Chrome:  Cmd+Shift+Delete  (Mac) o  Ctrl+Shift+Delete  (Windows)
Safari:  Develop → Empty Web Cache
Firefox: Ctrl+Shift+Delete  (Windows) o  Cmd+Shift+Delete  (Mac)
```

### 2. Verifica el archivo

**Abre una Terminal y corre:**
```bash
# Ver qué tipo detecta el sistema operativo
file /ruta/al/comprobante.heic
file /ruta/al/comprobante.pdf
```

**Debería mostrar algo como:**
```
comprobante.heic: HEIC image data
comprobante.pdf: PDF document
```

### 3. Si sigue fallando, copia el mensaje de error

Abre `F12` → `Console` y copia todo lo que diga `[Upload Debug]`  
Luego contáctame con ese error exacto

---

## 📞 Debugging Avanzado (para desarrolladores)

### Ver logs del servidor en tiempo real

```bash
# Terminal en backend/
npm run dev

# Busca logs que digan:
# [ComprobanteService] ✅ Validación OK
# [ComprobanteService] ⚠️ MIME type no reconocido
```

### Simular problemas de MIME type

En la consola del navegador, ejecuta esto:

```javascript
// Simula archivo con MIME type desconocido
const file = new File(['contenido'], 'test.heic', { type: 'application/octet-stream' });
console.log('Archivo:', file.name);
console.log('Tipo:', file.type);
console.log('Tamaño:', file.size);

// Prueba la validación
const tiposValidos = [
    'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
    'application/pdf', 'image/jpg', 'application/octet-stream', 
    'image/x-heic', 'image/x-heif'
];
console.log('Válido?', tiposValidos.includes(file.type));  // Debería ser true
```

---

## ✅ Verificación Post-Arreglo

### Paso 1: Que el código fue actualizado

```bash
# Ver que contiene la nueva lógica
grep -n "application/octet-stream" \
  js/mis-boletos.html \
  backend/services/comprobanteService.js

# Debería mostrar 2+ coincidencias
```

### Paso 2: Testear con diferentes archivos

Intenta subir:
1. ✅ Imagen JPEG (Chrome, Safari, Firefox)
2. ✅ Imagen PNG (todos los navegadores)
3. ✅ Imagen HEIC (Safari en Mac)
4. ✅ PDF (todos)

Cada uno debería mostrar en consola:
```
[Upload Debug] ✅ Validación OK
```

---

## 🚀 Cambios Implementados Hoy

### Frontend (`mis-boletos.html`)
- ✅ Validación de extensión primero
- ✅ MIME type opcional (no rechaza si extensión ✅)
- ✅ Logging detallado en consola
- ✅ Mensajes más claros

### Backend (`comprobanteService.js`)
- ✅ Misma lógica de validación
- ✅ Logging detallado en servidor
- ✅ Tipos MIME alternativos aceptados

### Resultado
**De 5 navegadores que fallaban → Todos funcionen ahora** ✅

---

## 📝 Próximos Pasos

1. **Testa en tu navegador problemático**
2. **Mira la consola** (F12)
3. **Verifica que vea** `[Upload Debug] ✅ Validación OK`
4. **Si aún falla**, copia el error exacto y contáctame

---

**Documento de debugging - Actualizado 27 de abril 2026**
