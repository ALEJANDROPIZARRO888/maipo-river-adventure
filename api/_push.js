import webpush from 'web-push';

// Avisos push al celular (Web Push). Cada teléfono que activa los avisos deja una suscripción; aquí se guardan y se les envía.
// Las llaves VAPID (la identidad del servidor ante Google, Apple y Mozilla) se generan solas la primera vez y viven en la base.
let _vapid;
export async function vapid(q) {
  if (_vapid) return _vapid;
  await q`insert into config (k, v) values ('vapid', ${JSON.stringify(webpush.generateVAPIDKeys())}) on conflict (k) do nothing`;
  const [r] = await q`select v from config where k = 'vapid'`;
  return (_vapid = JSON.parse(r.v));
}

// Solo se aceptan direcciones de los servicios de push de los navegadores. Sin esto, cualquier cuenta podría registrar una
// dirección cualquiera y hacer que el servidor le envíe peticiones (por ejemplo a servicios internos).
const SERVICIOS = [/(^|\.)fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];
const B64URL = /^[A-Za-z0-9_-]+$/;
export function suscripcionValida(sub) {
  try {
    const u = new URL(sub.endpoint);
    if (u.protocol !== 'https:' || u.username || u.password || u.port || sub.endpoint.length > 700) return false;
    if (!SERVICIOS.some(re => re.test(u.hostname))) return false;
    const { p256dh, auth } = sub.keys || {};
    return typeof p256dh === 'string' && typeof auth === 'string' && B64URL.test(p256dh) && B64URL.test(auth) && p256dh.length === 87 && auth.length >= 16 && auth.length <= 24;
  } catch { return false; }
}

const MAX_POR_CUENTA = 5; // teléfonos por persona; al pasar el límite se descartan los más antiguos
export async function guardarSuscripcion(q, cuentaId, sub, ua) {
  await q`insert into push_subs (cuenta_id, endpoint, p256dh, auth, ua) values (${cuentaId}, ${sub.endpoint}, ${sub.keys.p256dh}, ${sub.keys.auth}, ${String(ua || '').slice(0, 200)})
    on conflict (endpoint) do update set cuenta_id = excluded.cuenta_id, p256dh = excluded.p256dh, auth = excluded.auth, ua = excluded.ua`;
  await q`delete from push_subs where cuenta_id = ${cuentaId} and id not in (select id from push_subs where cuenta_id = ${cuentaId} order by id desc limit ${MAX_POR_CUENTA})`;
}
export async function borrarSuscripcion(q, cuentaId, endpoint) {
  await q`delete from push_subs where cuenta_id = ${cuentaId} and endpoint = ${String(endpoint)}`;
}

let _enviar = (sub, cuerpo, opts) => webpush.sendNotification(sub, cuerpo, opts);
// Solo para pruebas: reemplaza el envío real.
export function useSender(fn) { _enviar = fn; }

// Envía `payload` a todos los teléfonos de esas cuentas (solo cuentas activas). Nunca lanza: un aviso que falla no debe
// romper la operación que lo originó. Las suscripciones vencidas (404/410) se borran solas.
export async function enviarPush(q, cuentas, payload) {
  if (!cuentas.length) return { enviados: 0, fallidos: 0 };
  const subs = await q`select s.id, s.endpoint, s.p256dh, s.auth from push_subs s join cuentas c on c.id = s.cuenta_id
    where s.cuenta_id = any(${cuentas}::int[]) and c.activa`;
  if (!subs.length) return { enviados: 0, fallidos: 0 };
  const v = await vapid(q);
  const opts = { vapidDetails: { subject: 'mailto:' + (process.env.ADMIN_EMAIL || 'maiporiveradventure@gmail.com'), publicKey: v.publicKey, privateKey: v.privateKey }, TTL: 6 * 3600, urgency: 'high', timeout: 4000 };
  const cuerpo = JSON.stringify(payload);
  const res = await Promise.allSettled(subs.map(s => _enviar({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, cuerpo, opts)));
  const vencidas = subs.filter((s, i) => res[i].status === 'rejected' && [404, 410].includes(res[i].reason && res[i].reason.statusCode)).map(s => s.id);
  if (vencidas.length) await q`delete from push_subs where id = any(${vencidas}::int[])`;
  const ok = res.filter(r => r.status === 'fulfilled').length;
  return { enviados: ok, fallidos: res.length - ok };
}
