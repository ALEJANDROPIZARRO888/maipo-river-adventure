# Maipo River Adventure

Sitio web (rafting en el Cajón del Maipo) más el backend de operación: reservas, fichas de pasajeros por QR y panel de administración. Se publica solo en Vercel con cada cambio en la rama `main`.

## Estructura

| Ruta | Qué es |
| --- | --- |
| `index.html`, `script.js`, `styles.css` | Sitio público. El formulario de reserva también envía los datos a `/api/reservas`. |
| `api/reservas.js` | `POST` público: crea la reserva y envía los correos. `GET`/`PATCH` (con `ADMIN_TOKEN`): lista y cambia el estado. |
| `api/ficha.js` | Ficha del pasajero: `GET` datos de la reserva, `POST` guarda la ficha con consentimiento, fecha, hora e IP. |
| `api/_lib.js` | Base de datos (Neon Postgres), correo (Gmail o Resend), formatos y utilidades. Crea las tablas solo. |
| `ficha/index.html` | Ficha pública ES/EN a la que se llega con el QR: `/ficha?r=TOKEN`. |
| `admin/index.html` | Panel `/admin`: reservas, progreso de fichas ("X de N"), estados, link de ficha y envío por WhatsApp. |

## Variables de entorno

Los nombres están en `.env.example`. Los valores se guardan solo en Vercel (Settings, Environment Variables), nunca en este repositorio.

## Flujo

1. El cliente reserva en la web. El cupo sigue descontándose en la planilla de Google, como antes.
2. La reserva queda guardada en Postgres y llegan dos correos: aviso al admin y confirmación bilingüe al cliente con el link de ficha.
3. Cada pasajero completa su ficha desde el QR o el link.
4. El admin ve todo en `/admin`.

## Cómo cambiar algo

Edita el archivo en GitHub y guarda (commit a `main`); Vercel publica en menos de un minuto. Para probar sin afectar el sitio, crea una rama y usa la vista previa que genera Vercel.
