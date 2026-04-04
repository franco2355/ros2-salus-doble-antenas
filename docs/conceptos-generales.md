# Terminología del repo (modelo por paquetes)

Documento corto para entender cómo se compone la app hoy.

## AppShell

`AppShell` es el marco principal de la UI:

- toolbar
- selector/panel lateral
- workspace central
- consola inferior
- host de modales y diálogos
- footer

No contiene lógica de negocio de robótica.

## Paquete

Un **paquete** es la unidad de extensión del sistema.  
Vive en `src/packages/<packageId>` y agrupa:

- frontend
- services
- dispatchers
- transports
- `config.json`

El core descubre paquetes con `import.meta.glob` (index + config), sin catálogo manual.

## Módulo (dentro de un paquete)

Cada paquete contiene una lista de `CockpitModule` en su `createPackage()`.  
Un módulo registra contribuciones en runtime (`register(ctx)`), por ejemplo:

- sidebar panel
- workspace view
- console tab
- toolbar menu
- modal dialog
- footer item
- services/dispatchers/transports

## `config.json` del paquete

Cada paquete debe tener:

- `values`: valores default
- `settings.fields`: metadata para renderizar la UI de settings global

Si el schema no es válido, el paquete no carga.

## Configuración efectiva

Para cada paquete:

- base: `src/packages/<id>/config.json`
- override local: `packages/<id>.json` (Tauri config dir)
- merge runtime: `{ ...values, ...override }`

API de runtime:

- `getPackageConfig(packageId)`
- `setPackageConfig(packageId, config)`
- `resetPackageConfig(packageId)`

## Activación y toggles

Se controla con `config/modules.yaml`:

- `packages.<id>.enabled`
- `packages.<id>.modules.<moduleId>`

## Registries

Los registries son listas dinámicas donde módulos publican contribuciones y el shell las consume.

Principales:

- `sidebarPanelRegistry`
- `workspaceViewRegistry`
- `consoleTabRegistry`
- `toolbarMenuRegistry`
- `modalRegistry`
- `footerItemRegistry`
- `serviceRegistry`
- `dispatcherRegistry`
- `transportRegistry`

Ejemplo:

```ts
ctx.registries.sidebarPanelRegistry.registerSidebarPanel({
  id: "sidebar.mi-feature",
  label: "Mi Feature",
  render: (runtime) => <MiPanel runtime={runtime} />
});
```

El orden visual de elementos registrados se resuelve por orden de registro (inserción).

## Capas

- Frontend: componentes React/TSX, consumen services.
- Service: lógica de negocio y estado de feature.
- Dispatcher: request/subscribe por `op`, desacopla protocolo de negocio.
- Transport: canal técnico (`connect/disconnect/send/recv`), sin lógica de dominio.

Regla clave: frontend no habla directo con dispatcher/transport.

## IDs y namespacing

Los módulos usan IDs lógicos (`service.x`, `dispatcher.y`, etc.).  
`PackageManager` aplica scope por paquete para evitar colisiones entre paquetes.

## Sidebar colapsable

No existe colapsado implícito por `.panel-card + h3/h4`.  
Para secciones colapsables en sidebar usar `PanelCollapsibleSection` del paquete `core`.

## CSS

- `src/app/base.css`: estilos globales/base.
- `src/packages/<id>/frontend/*/styles.css`: estilos específicos de cada módulo frontend del paquete.
