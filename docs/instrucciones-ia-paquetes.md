# Instrucciones para IA: crear paquetes nuevos en este repo

Este archivo es un prompt-operativo para otra IA que deba extender Cockpit.

## Objetivo

Implementar un paquete nuevo bajo `src/packages/<packageId>` siguiendo contratos existentes, sin romper desacople por capas.

## Reglas obligatorias

- No usar rutas legacy (`src/modules/*`, `src/services/impl/*` global) para nuevas features.
- Crear siempre `config.json` válido (`values + settings.fields`).
- Frontend solo consume services.
- Services no dependen de componentes React.
- Dispatchers no contienen lógica de UI.
- Transports no contienen lógica de negocio.
- En sidebar usar `PanelCollapsibleSection` del paquete `core` para secciones colapsables.
- El orden visual/runtime se define por orden de registro (no existe propiedad `order`).

## Pasos mínimos que debe ejecutar la IA

1. Crear estructura del paquete:
- `index.ts`
- `config.json`
- `frontend/<feature>/index.tsx` + `styles.css`
- `services/impl/*`
- `dispatcher/impl/*`
- `transport/impl/*` (si aplica)

2. Implementar `createPackage(): CockpitPackage` en `src/packages/<id>/index.ts`.

3. En cada módulo frontend (`CockpitModule`), registrar en `register(ctx)`:
- dispatcher(s)
- service(s)
- UI contributions (sidebar/workspace/console/toolbar/modal/footer)

4. Configurar toggles en `config/modules.yaml`:
- `packages.<id>.enabled`
- `packages.<id>.modules.<moduleId>`

5. Validar:
- `npm run test`
- `npm run build`

## Contratos a respetar

- Transport: `connect`, `disconnect`, `send`, `recv`
- Dispatcher: `handleIncoming`, `request`, `subscribe`
- Service: `getState` + `subscribe` + métodos de negocio

## Criterios de aceptación

- El paquete carga automáticamente al iniciar la app.
- Puede deshabilitarse sin romper el shell.
- Su configuración aparece en modal global de settings.
- No hay acoplamiento directo frontend -> dispatcher/transport.
