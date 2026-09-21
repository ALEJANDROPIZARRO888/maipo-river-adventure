import test from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import webpush from 'web-push';
import { suscripcionValida } from '../api/_push.js';

// Una suscripción con la forma real que entrega un navegador: llave pública P-256 sin comprimir (65 bytes) y secreto de 16 bytes.
function suscripcion(endpoint = 'https://fcm.googleapis.com/fcm/send/abc123') {
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
  return { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
}

test('suscripcionValida acepta los servicios de push de Chrome, Firefox, Safari y Edge', () => {
  for (const e of [
    'https://fcm.googleapis.com/fcm/send/abc123',
    'https://fcm.googleapis.com/wp/xyz',
    'https://updates.push.services.mozilla.com/wpush/v2/gAAAAAB',
    'https://web.push.apple.com/QAbc',
    'https://wns2-par02p.notify.windows.com/w/?token=abc'
  ]) assert.equal(suscripcionValida(suscripcion(e)), true, e);
});

test('suscripcionValida rechaza direcciones que no son de un servicio de push (protección contra SSRF)', () => {
  for (const e of [
    'http://fcm.googleapis.com/fcm/send/abc',              // sin https
    'https://localhost/x', 'https://127.0.0.1/x', 'https://169.254.169.254/latest/meta-data', 'https://10.0.0.5/x',
    'https://fcm.googleapis.com.evil.com/x',               // dominio que solo empieza igual
    'https://evil.com/fcm.googleapis.com',                 // el nombre está en la ruta, no en el host
    'https://evilfcm.googleapis.com.attacker.io/x',
    'https://fcm.googleapis.com:8443/x',                   // puerto
    'https://user:clave@fcm.googleapis.com/x',             // credenciales en la URL
    'ftp://fcm.googleapis.com/x', 'javascript:alert(1)', 'no es una url', '',
    'https://fcm.googleapis.com/' + 'a'.repeat(800)        // demasiado larga
  ]) assert.equal(suscripcionValida(suscripcion(e)), false, e);
});

test('suscripcionValida exige llaves con el formato correcto', () => {
  const ok = suscripcion();
  assert.equal(suscripcionValida(ok), true);
  for (const s of [
    null, undefined, {}, { endpoint: ok.endpoint }, { endpoint: ok.endpoint, keys: {} },
    { ...ok, keys: { ...ok.keys, p256dh: 'corta' } },
    { ...ok, keys: { ...ok.keys, auth: 'x' } },
    { ...ok, keys: { ...ok.keys, auth: 'a'.repeat(40) } },
    { ...ok, keys: { ...ok.keys, auth: 'con espacios y símbolos!!!!' } },
    { ...ok, keys: { p256dh: 123, auth: 456 } },
    { endpoint: 42, keys: ok.keys }
  ]) assert.equal(suscripcionValida(s), false, JSON.stringify(s));
});

test('web-push arma una petición válida con nuestras llaves y carga (cifrado + VAPID), sin salir a la red', () => {
  const v = webpush.generateVAPIDKeys();
  const sub = suscripcion();
  const d = webpush.generateRequestDetails(sub, JSON.stringify({ t: 'Nueva bajada · 11:00', b: 'lunes 21 sep', r: 'turno:12', g: 'solicitud:12' }),
    { vapidDetails: { subject: 'mailto:maiporiveradventure@gmail.com', publicKey: v.publicKey, privateKey: v.privateKey }, TTL: 21600, urgency: 'high' });
  assert.equal(d.method, 'POST'); assert.equal(d.endpoint, sub.endpoint);
  assert.equal(d.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(d.headers.TTL, 21600); assert.equal(d.headers.Urgency, 'high');
  assert.match(d.headers.Authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
  assert.ok(Buffer.isBuffer(d.body) && d.body.length > 100, 'la carga viaja cifrada');
  assert.ok(!d.body.toString('utf8').includes('Nueva bajada'), 'el texto no viaja en claro');
});
