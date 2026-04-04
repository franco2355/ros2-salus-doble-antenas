# Cómo crear un módulo nuevo

Guía práctica para agregar un módulo en esta arquitectura modular.

## Qué es un módulo en este proyecto

Un módulo es una unidad funcional que puede registrar:

- UI (sidebar, workspace, consola, toolbar, modal, footer)
- services (lógica de negocio)
- dispatchers (contrato de mensajes por `op`)
- transports (protocolo de comunicación)

Se activa/desactiva por `config/modules.yaml`, sin tocar el core.

## Responsabilidad de cada capa

- `Transport`: conexión técnica (`connect`, `disconnect`, `send`, `recv`). No contiene reglas de negocio.
- `Dispatcher`: conoce operaciones del backend (`op`) y enruta mensajes. No renderiza UI.
- `Service`: lógica de negocio, validaciones, coordinación de dispatchers, estado para frontend.
- `Frontend`: componentes React/TSX. Consume solo services.

Regla clave: la UI nunca llama transport ni dispatcher directo.

## ¿Qué tengo que crear?

Usá esta matriz:

| Necesidad | ¿Crear Service? | ¿Crear Dispatcher? | ¿Crear Transport? |
|---|---:|---:|---:|
| Solo UI local (sin backend) | Sí | No | No |
| Nueva feature que usa backend existente | Sí | Sí | No |
| Nuevo conjunto de `ops` sobre protocolo existente | Sí | Sí | No |
| Nuevo protocolo (ROS bridge/custom WS/HTTP) | Sí | Sí | Sí |

Nota: en este repo, casi siempre vas a crear al menos un `Service`.

## Estructura sugerida

```text
src/
  modules/mi-modulo/index.tsx
  modules/mi-modulo/styles.css
  services/impl/MiModuloService.ts
  dispatcher/impl/MiModuloDispatcher.ts
  transport/impl/MiModuloTransport.ts   # solo si aplica
```

## Paso a paso

## 1) Crear la fábrica del módulo

Archivo: `src/modules/mi-modulo/index.tsx`

```tsx
import "./styles.css";
import type { CockpitModule, ModuleContext } from "../../core/types/module";

export function createMiModulo(): CockpitModule {
  return {
    id: "mi-modulo",
    version: "1.0.0",
    enabledByDefault: true,
    register(ctx: ModuleContext): void {
      // registrar transport/dispatcher/service/ui
    }
  };
}
```

## 1.1) Crear estilos del módulo

Archivo: `src/modules/mi-modulo/styles.css`

Regla de este repo:

- Todo estilo específico del módulo va aquí.
- `src/app/base.css` solo contiene estilos compartidos/globales (shell, tokens, utilidades comunes).

## 1.2) Secciones colapsables del sidebar (contrato actual)

Para sidebar, el colapsado ya no es implícito por `.panel-card + h3/h4`.

Debés usar el componente global:

```tsx
import { CollapsibleSection } from ".../app/layout/CollapsibleSection";

<CollapsibleSection title="Mi sección">
  {/* contenido del paquete */}
</CollapsibleSection>
```

El título/chevron y comportamiento de colapsado son globales (`app/base.css`), y el contenido sigue siendo propiedad del paquete.

## 2) Definir IDs consistentes

Usá constantes para evitar colisiones:

```ts
const TRANSPORT_ID = "transport.mi-modulo";
const DISPATCHER_ID = "dispatcher.mi-modulo";
const SERVICE_ID = "service.mi-modulo";
```

Convención recomendada:

- `transport.*`
- `dispatcher.*`
- `service.*`
- `sidebar.*`, `workspace.*`, `console.*`, `toolbar.*`, `modal.*`, `footer.*`

## 3) Crear Dispatcher (si hay backend)

El dispatcher encapsula `ops`, requests y subscriptions del backend para tu dominio.

Puntos mínimos:

- extender `DispatcherBase`
- declarar `ops` soportadas
- mapear helpers (`requestX`, `subscribeY`)
- publicar en `handleIncoming`

```ts
// esquema simplificado
class MiModuloDispatcher extends DispatcherBase {
  constructor(id: string, transportId: string) {
    super(id, transportId, ["mi_op", "mi_event"]);
  }
  handleIncoming(message: IncomingPacket): void {
    this.publish(message.op, message);
  }
  requestMiOp(payload: MessagePayload) {
    return this.request("mi_op", payload);
  }
}
```

## 4) Crear Service

El service es la API consumida por la UI.

Debe:

- validar entradas
- transformar datos
- coordinar uno o más dispatchers
- exponer `getState()` + `subscribe(...)` si maneja estado

No debe:

- renderizar UI
- depender de detalles de componentes React

## 5) Crear Transport (solo si hay protocolo nuevo)

Implementá interfaz `Transport`:

- `connect(ctx)`
- `disconnect()`
- `send(packet)`
- `recv(handler)`

El transport maneja lo técnico del canal (sesión, socket, token técnico, reconexión), no reglas del dominio.

## 6) Registrar todo en `register(ctx)`

Orden recomendado:

1. registrar transport (si aplica)
2. registrar dispatcher
3. registrar service
4. registrar contribuciones UI

Ejemplo:

```ts
ctx.registries.dispatcherRegistry.registerDispatcher({
  id: DISPATCHER_ID,
  order: 50,
  dispatcher
});

ctx.registries.serviceRegistry.registerService({
  id: SERVICE_ID,
  order: 50,
  service
});

ctx.registries.workspaceViewRegistry.registerWorkspaceView({
  id: "workspace.mi-modulo",
  label: "Mi Módulo",
  order: 50,
  render: (runtime) => <MiVista runtime={runtime} />
});
```

Registries disponibles:

- `toolbarMenuRegistry`
- `sidebarPanelRegistry`
- `workspaceViewRegistry`
- `consoleTabRegistry`
- `modalRegistry`
- `footerItemRegistry`
- `serviceRegistry`
- `dispatcherRegistry`
- `transportRegistry`

## 7) Agregar módulo al catálogo

Editar `src/core/bootstrap/moduleCatalog.ts`:

- importar `createMiModulo`
- incluirlo en `getModuleCatalog()`

## 8) Activar por config

Editar `config/modules.yaml`:

```yaml
modules:
  mi-modulo: true
```

## 9) Validar

```bash
npm run test
npm run build
npm run tauri:dev
```

Checklist de aceptación:

- aparece UI del módulo cuando está habilitado
- desaparece sin romper la app cuando está deshabilitado
- la UI solo consume service
- no hay acceso directo a transport/dispatcher desde componentes
- requests/responses del módulo funcionan

## Errores comunes

- usar `transport` desde React: rompe desacople
- meter lógica de negocio en componentes
- no usar IDs estables y producir colisiones
- olvidar registrar el módulo en `moduleCatalog.ts`
- asumir que el módulo siempre está habilitado
