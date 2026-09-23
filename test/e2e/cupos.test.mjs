// Regresión del bug reportado: una reserva no restaba el cupo en la planilla de Google, así que la web seguía
// mostrando el horario disponible y se podía sobrevender. Cubre los dos caminos que escriben en la planilla
// (reserva pública y reserva manual del admin) con el Apps Script simulado: éxito, rechazo, sin configurar y caído.
// Ejecuta los handlers reales sobre PostgreSQL en memoria (ver _db.mjs). Correr con: npm test
import assert from 'node:assert/strict';
import { imp, montar } from './_db.mjs';

const { q } = await montar();
const reservas = (await imp('api/reservas.js')).default;
const app = (await imp('api/app.js')).default;

// Intercepta SOLO las llamadas al Apps Script (syncCupos). Nada más en este entorno de pruebas llama a fetch
// (no hay GMAIL_APP_PASSWORD ni RESEND_API_KEY configuradas, así que sendMail nunca sale a la red).
const fetchReal = globalThis.fetch;
let llamadas = [], responder = () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) });
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('script.google.com')) { llamadas.push({ url: String(url), body: opts && JSON.parse(opts.body) }); return responder(); }
  return fetchReal(url, opts);
};
const limpiar = () => { llamadas = []; };

async function llamar(h, { method = 'GET', query = {}, body, token } = {}) {
  let status = 200, json;
  const res = { setHeader() {}, end() {}, status(c) { status = c; return res; }, json(j) { json = j; return res; } };
  await h({ method, query, body, headers: { host: 'test.local', ...(token ? { authorization: 'Bearer ' + token } : {}) } }, res);
  return { status, json };
}
const reservar = body => llamar(reservas, { method: 'POST', body: { nombre: 'Cliente Prueba', telefono: '+56911111111', correo: 'x@y.cl', fecha: '2027-02-10', horario: '11:00', personas: 3, plan: 'Rafting Extrema $45.000', ...body } });
const manual = (token, body) => llamar(reservas, { method: 'POST', token, body: { nombre: 'Manual Prueba', fecha: '2027-02-11', horario: '14:00', personas: 2, ...body } });
const cupoDe = async id => (await q`select cupo_sync from reservas where id = ${id}`)[0].cupo_sync;
const esperar = (ms = 120) => new Promise(r => setTimeout(r, ms));
let n = 0, r; const ok = m => console.log('  ok', ++n, '-', m);

console.log('== Sin la app del equipo instalada: la falla de sincronización no rompe la reserva del cliente');
delete process.env.SHEET_SYNC_KEY; limpiar();
r = await reservar({ cupoWeb: false, nombre: 'Sin App Instalada' });
await esperar();
assert.equal(r.status, 201, 'la reserva se guarda igual aunque no exista la tabla avisos (código 42P01 capturado)');
assert.equal(await cupoDe(r.json.id), false);
ok('sin la app del equipo instalada, el aviso falla en silencio (42P01) y la reserva del cliente no se entera');

console.log('== Reserva pública: el navegador ya restó el cupo (cupoWeb: true)');
delete process.env.SHEET_SYNC_KEY; limpiar();
r = await reservar({ cupoWeb: true });
assert.equal(r.status, 201); assert.equal(r.json.cupo, true);
assert.equal(llamadas.length, 0, 'el servidor no debe volver a restar: ya lo hizo el navegador');
assert.equal(await cupoDe(r.json.id), true);
ok('cupoWeb=true -> el servidor no llama al Apps Script y cupo_sync queda true');

console.log('== Reserva pública: el navegador NO pudo confirmarlo (bug reportado) -> el servidor resta de respaldo');
process.env.SHEET_SYNC_KEY = 'clave-de-prueba'; limpiar();
r = await reservar({ cupoWeb: false });
assert.equal(r.status, 201); assert.equal(r.json.cupo, true);
assert.equal(llamadas.length, 1, 'el servidor debe intentar restar el cupo como respaldo');
assert.deepEqual(llamadas[0].body, { action: 'ajustar', key: 'clave-de-prueba', fecha: '2027-02-10', horario: '11:00', delta: 3 });
assert.equal(await cupoDe(r.json.id), true);
ok('el servidor resta el cupo cuando el navegador no pudo (era exactamente el bug reportado)');

console.log('== Reserva pública: tampoco se manda el campo cupoWeb (botón que antes no restaba nada)');
limpiar();
r = await reservar({});
assert.equal(r.status, 201); assert.equal(llamadas.length, 1, 'sin cupoWeb se trata igual que cupoWeb=false: el servidor resta');
assert.equal(await cupoDe(r.json.id), true);
ok('omitir cupoWeb (el bug del botón alterno) igual queda cubierto por el respaldo del servidor');

console.log('== Reserva pública: SHEET_SYNC_KEY sin configurar -> no se sobreescribe con éxito falso');
delete process.env.SHEET_SYNC_KEY; limpiar();
r = await reservar({ cupoWeb: false, nombre: 'Sin Config' });
assert.equal(r.status, 201); assert.equal(r.json.cupo, false);
assert.equal(llamadas.length, 0, 'sin clave, syncCupos ni siquiera llama al script');
assert.equal(await cupoDe(r.json.id), false, 'cupo_sync queda false: una futura cancelación no restará de más');
ok('sin SHEET_SYNC_KEY, la reserva se guarda igual pero cupo_sync queda en false (antes quedaba true a ciegas)');

console.log('== Reserva pública: el Apps Script rechaza el ajuste');
process.env.SHEET_SYNC_KEY = 'clave-de-prueba';
responder = () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: false, error: 'no encontrado' }) });
limpiar();
r = await reservar({ cupoWeb: false, nombre: 'Rechazada' });
assert.equal(r.json.cupo, false); assert.equal(await cupoDe(r.json.id), false);
ok('si el script responde ok:false, cupo_sync también queda false');

console.log('== Reserva manual del admin: mismas garantías que la reserva pública');
responder = () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) });
const M = (await llamar(app, { method: 'POST', body: { accion: 'setup', clave: 'clave-de-prueba', nombre: 'Dueña Uno', correo: 'd@x.cl', password: 'clavelarga1' } })).json;
delete process.env.SHEET_SYNC_KEY; limpiar();
r = await manual('clave-de-prueba', {});
assert.equal(r.status, 201); assert.equal(r.json.planilla, false);
assert.equal(await cupoDe(r.json.id), false, 'antes: cupo_sync quedaba TRUE a ciegas aunque syncCupos no pudiera correr');
ok('reserva manual sin SHEET_SYNC_KEY: cupo_sync ya no miente (antes era true fijo, ahora refleja el fallo real)');
process.env.SHEET_SYNC_KEY = 'clave-de-prueba'; limpiar();
r = await manual('clave-de-prueba', { nombre: 'Manual Ok' });
assert.equal(r.json.planilla, true); assert.equal(await cupoDe(r.json.id), true);
assert.equal(llamadas.length, 1);
ok('reserva manual con la planilla al día: sigue funcionando igual que antes (planilla:true, cupo_sync:true)');

console.log('== Aviso al admin cuando la sincronización falla, con y sin la app instalada');
delete process.env.SHEET_SYNC_KEY; limpiar();
r = await reservar({ cupoWeb: false, nombre: 'Avisa Admin' });
await esperar();
const av = await q`select tipo, titulo, cuerpo, ruta from avisos where tipo = 'cupo_error' order by id desc limit 1`;
assert.equal(av.length, 1); assert.match(av[0].titulo, /Cupo no descontado/); assert.match(av[0].cuerpo, /Avisa Admin/); assert.equal(av[0].ruta, 'reservas');
ok('con la app instalada, la falla de sincronización deja un aviso claro para el admin');
const antes = (await q`select count(*)::int as n from avisos where tipo = 'cupo_error'`)[0].n;
r = await manual('clave-de-prueba', { nombre: 'Tambien Avisa' });
await esperar();
assert.equal((await q`select count(*)::int as n from avisos where tipo = 'cupo_error'`)[0].n, antes + 1, 'la reserva manual también avisa si falla');
ok('la reserva manual del admin también genera el aviso cuando la sincronización falla');

console.log(`\nTODO OK: ${n} comprobaciones`);
globalThis.fetch = fetchReal;
