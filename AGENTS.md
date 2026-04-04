# AGENTS.md

Guía operativa para cualquier IA que continúe este proyecto.

## 1) Objetivo del repo

Cockpit desktop modular para robótica, con:

- Frontend: React + TSX
- Runtime desktop: Tauri 2
- Arquitectura por capas: `Frontend -> Services -> Dispatchers -> Transports`
- Extensión por **paquetes** (`src/packages/<id>`)

## 2) Estado arquitectónico actual (importante)

- La app ya no usa “módulos sueltos” globales como unidad de extensión.
- La unidad de extensión es **paquete**.
- El core descubre paquetes con `import.meta.glob`:
  - `src/packages/*/index.ts|tsx`
  - `src/packages/*/config.json`
- Si `config.json` falta o es inválido, el paquete no carga.

## 3) Reglas duras (no romper)

- No crear nuevas features en rutas legacy globales (`src/modules/*`, `src/services/impl/*` global, etc.).
- Frontend nunca habla directo con transport/dispatcher.
- Services contienen lógica de negocio.
- Dispatchers enrutan/serializan mensajes backend.
- Transports solo canal técnico (`connect/disconnect/send/recv`), sin lógica de negocio.
- En sidebar, secciones colapsables deben usar `PanelCollapsibleSection` del paquete `core`.
- No existe propiedad `order`: el orden visual/runtime es por orden de registro.
- Estilos:
  - Base global en `src/app/base.css`
  - Estilos de features en `src/packages/<id>/frontend/**/styles.css`

## 4) Estructura esperada de un paquete

```text
src/packages/mi-paquete/
  index.ts
  config.json
  frontend/
    feature-a/
      index.tsx
      styles.css
  services/
    impl/
  dispatcher/
    impl/
  transport/
    impl/   # solo si aplica
```

## 5) Configuración de paquetes

Cada `config.json` debe usar schema:

```json
{
  "values": {},
  "settings": {
    "title": "Opcional",
    "fields": [
      { "key": "x", "label": "X", "type": "string|number|boolean|json" }
    ]
  }
}
```

Reglas:

- cada `fields[i].key` debe existir en `values`
- no se renderizan keys fuera de `fields`
- el orden de UI es el orden del array `fields`

Persistencia efectiva:

- Base: `src/packages/<id>/config.json`
- Override local: `packages/<id>.json` (config dir de Tauri)
- Merge runtime: `{ ...values, ...override }`

API runtime:

- `getPackageConfig(packageId)`
- `setPackageConfig(packageId, config)`
- `resetPackageConfig(packageId)`

## 6) IDs y namespacing

- Definir IDs locales en paquete (`service.navigation`, `dispatcher.map`, etc.).
- `PackageManager` aplica scope automático: `<packageId>.<id>`.
- Dentro del paquete, usar IDs locales.
- Desde core/global, evitar hardcodear IDs scoped si se puede resolver por runtime/registry.

## 7) Settings globales (core)

La tab **Global** del modal Settings está implementada para notificaciones del sistema.

Archivo de configuración:

- `core/notifications.json` (vía `src/core/config/globalNotificationConfig.ts`)

Servicio global:

- `service.system-notifications` (`SystemNotificationService`)

Dispara notificaciones (solo sin foco) para:

- recorrido completado
- obstáculo detectado (keywords)
- conexión perdida
- recordatorio de conexión con bytes totales

## 8) Flujo recomendado para una IA al implementar cambios

1. Leer contexto mínimo: `README.md`, `docs/conceptos-generales.md`, `docs/crear-modulo.md`.
2. Identificar ownership del cambio (core vs paquete).
3. Implementar manteniendo capas desacopladas.
4. Si cambian contratos/schemas, actualizar docs.
5. Validar:
   - `npm run test`
   - `npm run build`
   - si aplica desktop: `npm run tauri:dev`

## 9) Comandos útiles

- `npm run dev`
- `npm run tauri:dev`
- `npm run test`
- `npm run build`
- `npm run tauri:build`

## 10) Criterio de done para cambios de arquitectura

- No rompe carga de paquetes ni registries.
- No reintroduce acoplamiento frontend -> transport/dispatcher.
- Respeta config-driven settings por `config.json`.
- Mantiene tests/build en verde.
