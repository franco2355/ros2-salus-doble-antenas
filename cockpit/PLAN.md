# PLAN - Migración Cockpit a extensión VSCode

## 1. Objetivo operacional

Migrar Cockpit desde runtime Tauri a runtime de extensión VSCode Desktop.

Resultado esperado:
- Cockpit abre desde comando de extensión.
- Cockpit expone contenedores homologados a VSCode: sidebar, workspace, console, toolbar, footer, modal.
- Cockpit mantiene arquitectura por paquetes/módulos y contribuciones por slot.
- Cockpit elimina terminal propia y usa terminal integrada VSCode.
- Cockpit compila y pasa pruebas con toolchain sin Tauri.

## 2. Estrategia ejecutada

### Etapa 1 (implementación inmediata)

Port funcional rápido:
- Crear extensión VSCode con comando principal `cockpit.open`.
- Reusar UI React actual en webview sin dependencias Tauri.
- Introducir bridge Host <-> Webview para config, notificaciones, foco y terminal VSCode.
- Eliminar módulo terminal del core.
- Mantener runtime modular dentro webview para minimizar riesgo inicial.

### Etapa 2 (implementación incremental)

Homologación completa por contenedores VSCode:
- Sidebar y console se exponen como `WebviewView`.
- Workspace se expone como `WebviewPanel`.
- Toolbar y footer se proyectan a comandos/menús/status bar.
- Modal simple migra a API de diálogos VSCode.
- Modal compleja se mantiene en webview con ruta dedicada.

## 3. Mapa Cockpit -> VSCode

### Sidebar
- Cockpit slot: `sidebar`.
- VSCode homólogo: Activity Bar + `WebviewView`.
- Implementación: provider `cockpit.sidebar` con modo webview `slot=sidebar`.

### Workspace
- Cockpit slot: `workspace`.
- VSCode homólogo: Editor Area (`WebviewPanel`).
- Implementación: comando `cockpit.open` abre panel principal; comando `cockpit.workspace.open` abre panel y activa vista objetivo.

### Console
- Cockpit slot: `console`.
- VSCode homólogo: Panel inferior (`WebviewView`).
- Implementación: provider `cockpit.console` con modo `slot=console`.
- Cambio obligatorio: eliminar `console.terminal` de contribuciones.

### Toolbar
- Cockpit slot: `toolbar`.
- VSCode homólogo: Command Palette, menús `view/title` y `command`.
- Implementación: comando `cockpit.refreshToolbarProjection` + envío de contribuciones toolbar desde webview al host.

### Footer
- Cockpit slot: `footer`.
- VSCode homólogo: Status Bar.
- Implementación: comando `cockpit.refreshFooterProjection` + envío de contribuciones footer desde webview al host.

### Modal
- Cockpit slot: `modal` y diálogos globales.
- VSCode homólogo: `window.showInformationMessage/showWarningMessage/showInputBox` para simples.
- Implementación inicial: mantener modales UI dentro webview y bridge preparado para migración progresiva.

## 4. Contratos técnicos

## 4.1 Protocolo Host/Webview

Mensajes request/response/event:
- Request webview -> host:
  - `host.config.read`
  - `host.config.write`
  - `host.config.remove`
  - `host.notify`
  - `host.focus.isFocused`
  - `host.terminal.open`
  - `host.terminal.sendText`
  - `host.terminal.reveal`
- Response host -> webview:
  - `{ type: "host.response", id, ok, result|error }`
- Event webview -> host:
  - `cockpit.projection.toolbar`
  - `cockpit.projection.footer`

## 4.2 API de plataforma (nuevo)

`platform/host/*`:
- `bridge.ts`: transporte de mensajes y RPC.
- `configFs.ts`: persistencia por settings/storage.
- `notifications.ts`: notificaciones VSCode.
- `windowFocus.ts`: foco de ventana.
- `terminal.ts`: terminal integrada.
- `webviewZoom.ts`: fallback CSS zoom.

## 4.3 Persistencia

- Settings estables: `settings.json` (namespace `cockpit`).
- Estado dinámico: `workspaceState`/`globalState` (claves `cockpit.config.*`).
- Compatibilidad legacy no requerida.

## 5. Secuencia de implementación detallada

1. Crear `PLAN.md` operativo.
2. Introducir `src/extension/extension.ts` con:
   - activación,
   - comando `cockpit.open`,
   - providers `cockpit.sidebar` y `cockpit.console`,
   - handlers RPC Host/Webview,
   - proyección mínima toolbar/footer.
3. Incorporar utilitarios de webview:
   - resolver `index.html` build,
   - reescribir `src/href` a `asWebviewUri`,
   - inyectar nonce y variable de slot.
4. Sustituir capa Tauri por capa host:
   - migrar imports de `platform/tauri/*` a `platform/host/*`.
5. Eliminar terminal core:
   - quitar módulo de `src/packages/core/index.ts`,
   - remover carpeta `src/packages/core/modules/terminal/*`,
   - limpiar config `src/packages/core/config.json`.
6. Cambiar IDs shell commands a namespace `cockpit.*`.
7. Añadir soporte de modo webview por slot en frontend bootstrap.
8. Ajustar package.json:
   - quitar dependencias/scripts Tauri,
   - añadir metadata de extensión VSCode,
   - añadir build extension (`esbuild`).
9. Remover `src-tauri`.
10. Limpiar y actualizar pruebas:
   - eliminar tests de puente/módulo terminal,
   - actualizar expectativas de IDs de comandos shell.
11. Ejecutar `npm run build`.
12. Ejecutar `npm run test`.
13. Corregir regresiones hasta verde.

## 6. Riesgos y controles

1. Webviews múltiples sin estado compartido completo.
- Control: panel principal sigue disponible; providers slot son incrementales.

2. CSP y recursos externos en mapas/cámara.
- Control: CSP con allowlist explícita; fallback visible.

3. Conflictos de atajos con VSCode.
- Control: nombres `cockpit.*`, context keys reservadas para siguiente iteración.

4. Proyección toolbar/footer incompleta por render React no serializable.
- Control: proyección inicial mínima por etiquetas; iterar con metadatos serializables.

## 7. Criterios de aceptación implementables

1. `npm run build` exitoso sin Tauri.
2. `npm run test` exitoso sin tests terminal legacy.
3. `src-tauri` eliminado.
4. `@tauri-apps/api` eliminado.
5. Comando `cockpit.open` registrado en extensión.
6. Vistas `cockpit.sidebar` y `cockpit.console` registradas.
7. Cockpit abre en VSCode como webview funcional.
8. Slot `console` no contiene terminal propia.

