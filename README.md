# Maipo River Adventure

Sitio web (rafting en el Cajón del Maipo) más el backend de operación: reservas, fichas de pasajeros por QR y panel de administración. Se publica solo en Vercel con cada cambio en la rama `main`.

## Estructura

| Ruta | Qué es |
| --- | --- |
| `index.html`, `script.js`, `styles.css` | Sitio público. El formulario de reserva también envía los datos a `/api/reservas`. |
| `api/reservas.js` | `POST` público: crea la reserva y envía los correos. `GET`/`PATCH` (con `ADMIN_TOKEN`): lista y cambia el estado. |
| `api/ficha.js` | Ficha del pasajero: `GET` datos de la reserva, `POST` guarda la ficha con consentimiento, fecha, hora e IP. `PATCH` (admin) asigna una ficha a una salida y a una balsa. |
| `api/bajadas.js` | Admin: `GET ?fecha=` devuelve las salidas del día con reservas, balsas y fichas; `PATCH` cambia tramo, cupo, caudal, estado o el reparto de balsas. |
| `api/_bajadas.js` | Tablas `bajadas` y `botes`, la regla de la sección completa (trigger en la base) y el enlace de reservas y fichas a cada salida. |
| `api/_lib.js` | Base de datos (Neon Postgres), correo (Gmail o Resend), formatos y utilidades. Crea las tablas solo. |
| `fichapasajero/index.html` | Ficha pública ES/EN a la que se llega con el QR: `/fichapasajero?r=TOKEN` (`/ficha` redirige aquí). |
| `admin/index.html` | Panel `/admin`: reservas, cupos, **salidas** (reparto en balsas), fichas, link de ficha y envío por WhatsApp. |
| `app/` | **App del equipo** (`/app`), instalable en el celular: `index.html`, `app.js`, `app.css`, `manifest.webmanifest`, `sw.js` (funciona sin señal y recibe los avisos) e íconos. |
| `api/app.js` | API de la app: login, armado y publicación de bajadas, turnos, avisos, equipo y pagos. |
| `api/_auth.js` | Cuentas, sesiones firmadas, límite de intentos y el contador de cambios para el tiempo real. |
| `api/_notif.js` | Un aviso = una fila en el centro de avisos + un push al celular, con enlace a la pantalla que corresponde. |
| `api/_push.js` | Web Push: llaves VAPID (se generan solas), suscripciones de cada teléfono y envío. |
| `api/_auto.js` | Reglas puras de operación: tarifas, auto-distribución de pasajeros, elección de personal y choques de horario. |

## Cupos: cómo se descuentan (y qué falló antes)

La web muestra la disponibilidad leyendo la planilla de Google (Apps Script), no Postgres. El navegador del cliente
resta el cupo ahí directamente al reservar (`reservarCupo()` en `script.js`) porque es lo único que puede confirmar
"sin cupo" antes de enviar. Eso es fràgil por diseño: cualquier fallo en el navegador (bloqueador de anuncios, mala
señal, el script de Google lento o caído) impedía la resta sin que nadie se enterara, y la web seguía mostrando cupo
donde ya no quedaba — bug reportado en producción; el botón alterno "Enviar por correo" ni siquiera lo intentaba.

Ahora hay dos capas:
1. **Navegador** (rápido, con UX inmediata): intenta restar y avisa "sin cupo" si el script lo confirma. Cualquier
   otro fallo ya no se trata como éxito silencioso: se marca `cupoWeb: false` y se sigue adelante (no bloquea una
   reserva legítima por un problema de red del cliente).
2. **Servidor** (respaldo confiable, mismo mecanismo que ya usaban las reservas manuales del admin — `syncCupos()` en
   `_lib.js`, requiere `SHEET_SYNC_KEY`): si `cupoWeb` no llegó en `true`, el servidor intenta restar él mismo antes
   de guardar la reserva. `cupo_sync` en la fila refleja el resultado **real** (antes, la reserva manual del admin
   guardaba `cupo_sync = true` sin importar si la sincronización funcionaba). Si ninguna de las dos capas lo logra
   (por ejemplo, `SHEET_SYNC_KEY` sin configurar en Vercel), la reserva se guarda igual y el admin recibe un aviso
   ("⚠️ Cupo no descontado en la planilla") para corregir la planilla a mano.

**Revisa en Vercel que `SHEET_SYNC_KEY` esté configurada** y coincida con la `SYNC_KEY` del Apps Script: sin ella, el
respaldo del servidor no puede actuar y solo queda la resta del navegador (la capa frágil).

## Salidas (bajadas)

Una salida es un horario concreto (fecha + 11:00 / 14:00 / 17:00) con capacidad de **14** personas, igual que la planilla de cupos. Se crean solas al abrir un día en la pestaña **Salidas**: cada fecha y horario con reservas de rafting activas genera su salida y enlaza esas reservas. Las clases de kayak y las reservas canceladas no cuentan.

- **Balsas:** cada salida nace con dos balsas de 8 y 6 plazas. Se pueden cambiar con "Cambiar balsas" mientras no haya pasajeros asignados. Una balsa llena rechaza más fichas.
- **Tramo:** se fija solo si todas las reservas de la salida son del mismo tramo; si no, el panel avisa y el admin lo elige.
- **Sección completa:** sale solo a las 11:00 y ocupa la jornada. La base lo exige para salidas con tramo asignado; si un cliente ya reservó algo que choca, aparece como alerta y no como error.
- **QR por salida:** una ficha libre se enlaza sola a su salida si el QR lleva `?salida=AAAA-MM-DD-HHMM` (por ejemplo `?salida=2026-10-18-1400`). Con otro texto queda en "Fichas sin salida" para asignarla a mano.

## App del equipo (`/app`)

Una sola app con dos áreas según el tipo de cuenta. Se instala desde el navegador del celular ("Agregar a pantalla de inicio"), sin tiendas.

- **Primera vez:** quien abre `/app` en un sistema sin cuentas ve la instalación. Debe ingresar la clave del panel `/admin` (así solo el dueño puede instalar) y crea la **cuenta maestra**, la única que verifica a los otros socios.
- **Cuentas:** admin y trabajador son cuentas separadas aunque sean la misma persona. Los admin crean a los trabajadores en **Equipo** (usuario + clave temporal que se muestra una sola vez y se envía por correo si hay). Dar de baja corta el acceso al instante.
- **Admin:** inicio con avisos, **Armar** (auto-distribuir pasajeros en balsas y personal, asignar a mano, publicar), reservas, equipo y pagos. Publicar exige una cuenta admin verificada y una guía en cada balsa que sale; lo demás pide confirmación.
- **Trabajador:** solicitudes de bajada (aceptar / no puedo), agenda, vista del turno según su función (guía ve a los pasajeros de su balsa con emergencia y datos médicos; kayak ve las balsas que cubre; conductor ve el manifiesto de traslado), cierre de bajada y pagos. Solo cuentan las bajadas cerradas; lo demás es estimado. La tarifa se congela al publicar (guía y kayak $35.000, conductor $20.000; sección completa ×2).
- **Tiempo real:** cada cambio en la base (incluidas las reservas y fichas que llegan desde la web pública) sube un contador (`app_rev`, mantenido por triggers). Cada teléfono lo consulta cada 3 segundos y se actualiza solo cuando cambia. Sin señal, la app muestra lo último que vio; guardar cambios exige conexión.
- **Avisos al celular (push):** cada persona los activa una vez desde la app ("Activar avisos"). Llegan aunque la app esté cerrada y al tocarlos abren la pantalla que corresponde. Cada teléfono queda ligado a una sola cuenta y se desvincula al cerrar sesión. En Perfil hay un botón "Probar avisos".
  - **Admin recibe:** reserva nueva de la web, fichas completas de una reserva, y cuando un trabajador acepta, rechaza (con reemplazo sugerido) o cierra su turno.
  - **Trabajador recibe:** solicitud de bajada (con función, tramo y monto), aviso si lo sacan de una bajada, y cuando le pagan.
  - **iPhone:** los avisos solo funcionan con la app instalada en la pantalla de inicio (iOS 16.4 o superior).
  - **Técnica:** librería `web-push`; las llaves VAPID se guardan en la tabla `config` (no hay que configurar nada). Solo se aceptan direcciones de los servicios de push de Chrome, Firefox, Safari y Edge. Si el envío falla, la operación (publicar, aceptar, reservar…) sigue igual y el aviso queda en el centro de avisos de la app.
- **Aún no incluye:** fotos y videos (Mercado Pago), caudal DGA, WhatsApp Business, recordatorios programados, PDF del consentimiento, registro propio de trabajadores y cola de cambios sin señal.

## Pruebas

`npm install` y luego `npm test`. Corre en unos 25 segundos y no toca ninguna base real:

- `test/*.test.js`: funciones puras (tarifas, reparto en balsas, elección de personal, choques de horario, validación de suscripciones push).
- `test/e2e/*.test.mjs`: los handlers reales de la API sobre PostgreSQL en memoria ([PGlite](https://pglite.dev), dependencia de desarrollo). Cubren salidas y fichas, la app completa (cuentas, sesiones, armado, publicar, turnos, pagos, tiempo real, avisos push con un emisor simulado), las regresiones de seguridad, y la sincronización de cupos (`cupos.test.mjs`, con el Apps Script simulado — nunca sale a la red real). Correrlas antes de publicar a `main`.

## Variables de entorno

Los nombres están en `.env.example`. Los valores se guardan solo en Vercel (Settings, Environment Variables), nunca en este repositorio.

## Flujo

1. El cliente reserva en la web. El cupo sigue descontándose en la planilla de Google, como antes.
2. La reserva queda guardada en Postgres y llegan dos correos: aviso al admin y confirmación bilingüe al cliente con el link de ficha.
3. Cada pasajero completa su ficha desde el QR o el link.
4. El admin ve todo en `/admin`.

## Cómo cambiar algo

Edita el archivo en GitHub y guarda (commit a `main`); Vercel publica en menos de un minuto. Para probar sin afectar el sitio, crea una rama y usa la vista previa que genera Vercel.
