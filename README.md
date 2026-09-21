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

## Salidas (bajadas)

Una salida es un horario concreto (fecha + 11:00 / 14:00 / 17:00) con capacidad de **14** personas, igual que la planilla de cupos. Se crean solas al abrir un día en la pestaña **Salidas**: cada fecha y horario con reservas de rafting activas genera su salida y enlaza esas reservas. Las clases de kayak y las reservas canceladas no cuentan.

- **Balsas:** cada salida nace con dos balsas de 8 y 6 plazas. Se pueden cambiar con "Cambiar balsas" mientras no haya pasajeros asignados. Una balsa llena rechaza más fichas.
- **Tramo:** se fija solo si todas las reservas de la salida son del mismo tramo; si no, el panel avisa y el admin lo elige.
- **Sección completa:** sale solo a las 11:00 y ocupa la jornada. La base lo exige para salidas con tramo asignado; si un cliente ya reservó algo que choca, aparece como alerta y no como error.
- **QR por salida:** una ficha libre se enlaza sola a su salida si el QR lleva `?salida=AAAA-MM-DD-HHMM` (por ejemplo `?salida=2026-10-18-1400`). Con otro texto queda en "Fichas sin salida" para asignarla a mano.

## Pruebas

`npm test` corre las pruebas de las funciones puras (`test/`).

## Variables de entorno

Los nombres están en `.env.example`. Los valores se guardan solo en Vercel (Settings, Environment Variables), nunca en este repositorio.

## Flujo

1. El cliente reserva en la web. El cupo sigue descontándose en la planilla de Google, como antes.
2. La reserva queda guardada en Postgres y llegan dos correos: aviso al admin y confirmación bilingüe al cliente con el link de ficha.
3. Cada pasajero completa su ficha desde el QR o el link.
4. El admin ve todo en `/admin`.

## Cómo cambiar algo

Edita el archivo en GitHub y guarda (commit a `main`); Vercel publica en menos de un minuto. Para probar sin afectar el sitio, crea una rama y usa la vista previa que genera Vercel.
