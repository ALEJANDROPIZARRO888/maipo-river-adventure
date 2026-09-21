// Prueba de punta a punta de salidas (bajadas), balsas y fichas, y de que la reserva y la ficha públicas no dependen de la app.
// Ejecuta los handlers reales sobre PostgreSQL en memoria (ver _db.mjs). Correr con: npm test
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { pathToFileURL } from 'node:url';
import { REPO, imp, montar } from './_db.mjs';

const { pg, q } = await montar();
const lib = await imp('api/_lib.js');
const { default: reservas } = await imp('api/reservas.js');
const { default: bajadas } = await imp('api/bajadas.js');
const { default: ficha } = await imp('api/ficha.js');
const B = await imp('api/_bajadas.js');

async function call(handler, { method = 'GET', query = {}, body, auth = true } = {}) {
  const req = { method, query, body, headers: { host: 'test.local', ...(auth ? { authorization: 'Bearer clave-de-prueba' } : {}) } };
  let status = 200, json;
  const res = { setHeader() {}, end() {}, status(c) { status = c; return res; }, json(j) { json = j; return res; } };
  await handler(req, res);
  return { status, json };
}
const reservar = (o) => call(reservas, { method: 'POST', auth: false, body: { telefono: '+56911111111', correo: 'x@y.cl', ...o } });
let n = 0; const ok = (m) => console.log('  ok', ++n, '-', m);

console.log('== 1. Reservas por el handler público (sin cambios en ese flujo)');
const A = await reservar({ nombre: 'Ana Perez', fecha: '2026-10-18', horario: '11:00', personas: 4, plan: 'Rafting Extrema $45.000' });
const A2 = await reservar({ nombre: 'Beto Soto', fecha: '2026-10-18', horario: '11:00', personas: 3, plan: 'Rafting Extrema $45.000' });
const C = await reservar({ nombre: 'Carla Diaz', fecha: '2026-10-18', horario: '14:00', personas: 2, plan: 'Rafting Power $35.000' });
const K = await reservar({ nombre: 'Kayak Kim', fecha: '2026-10-18', horario: '17:00', personas: 2, plan: 'Clases de kayak $60.000' });
const X = await reservar({ nombre: 'Cancelada Cea', fecha: '2026-10-18', horario: '17:00', personas: 2, plan: 'Rafting Power $35.000' });
for (const r of [A, A2, C, K, X]) assert.equal(r.status, 201);
await call(reservas, { method: 'PATCH', body: { id: X.json.id, estado: 'cancelada' } });
ok('5 reservas creadas, 1 cancelada');

console.log('== 2. Autenticación');
assert.equal((await call(bajadas, { query: { fecha: '2026-10-18' }, auth: false })).status, 401);
ok('GET /api/bajadas sin clave -> 401');
assert.equal((await call(bajadas, { query: { fecha: 'mañana' } })).status, 400);
assert.equal((await call(bajadas, { query: { desde: '2026-01-01', hasta: '2026-12-31' } })).status, 400);
ok('fecha inválida y rango > 62 días -> 400');

console.log('== 3. Materializar salidas del día');
let d = (await call(bajadas, { query: { fecha: '2026-10-18' } })).json;
assert.equal(d.salidas.length, 2, 'solo 11:00 y 14:00: el kayak y la cancelada no crean salida');
const s11 = d.salidas.find(s => s.horario === '11:00'), s14 = d.salidas.find(s => s.horario === '14:00');
assert.equal(s11.reservadas, 7); assert.equal(s11.cupo, 14);
assert.equal(s11.tramo, 'san_alfonso_melocoton'); assert.equal(s14.tramo, 'melocoton_san_jose');
assert.deepEqual(s11.botes.map(b => b.capacidad), [8, 6]);
assert.equal(s11.reservas.length, 2); assert.deepEqual(s11.alertas, []);
ok('2 salidas; kayak y reserva cancelada no generan salida');
ok('11:00 -> 7 reservadas de 14, tramo auto San Alfonso—Melocotón, balsas 8+6');
const d2 = (await call(bajadas, { query: { fecha: '2026-10-18' } })).json;
assert.deepEqual(d2.salidas.map(s => s.id), d.salidas.map(s => s.id));
assert.equal(d2.salidas[0].botes.length, 2);
assert.equal((await q`select count(*)::int as n from botes`)[0].n, 4);
ok('idempotente: mismo id de salida y sin balsas duplicadas al reabrir el día');

console.log('== 4. DDL idempotente sobre una base ya migrada (nueva instancia del módulo)');
const B2 = await import(pathToFileURL(`${REPO}/api/_bajadas.js`).href + '?otra=1');
await B2.ensureBajadas();
ok('ensureBajadas() corre de nuevo sin error (create if not exists / drop+create trigger)');

console.log('== 5. Fichas: con reserva, libres con salida legible y libres sin salida');
const fpost = (o) => call(ficha, { method: 'POST', auth: false, body: {
  telefono: '+56922222222', email: 'p@q.cl', emergencia: 'Mamá — 99999999', consentimiento: true, sabeNadar: true, usoImagen: true,
  nacimiento: '1990-05-05', rut: '1-9', ...o } });
const f1 = await fpost({ r: A.json.fichaUrl.split('r=')[1], nombre: 'Ana Perez', firma: 'Ana Perez' });
const f2 = await fpost({ r: A.json.fichaUrl.split('r=')[1], nombre: 'Luis Perez', firma: 'Luis Perez', medico: 'asma' });
const f3 = await fpost({ nombre: 'Libre Legible', firma: 'Libre Legible', salida: '2026-10-18-1400' });
const f4 = await fpost({ nombre: 'Libre Rara', firma: 'Libre Rara', salida: '18oct-1100' });
const f5 = await fpost({ nombre: 'Menor Mena', firma: 'Menor Mena', nacimiento: '2015-01-01', apoderado: 'Papa Mena', apoderadoRut: '2-7' });
for (const f of [f1, f2, f3, f4, f5]) assert.equal(f.status, 201, JSON.stringify(f.json));
d = (await call(bajadas, { query: { fecha: '2026-10-18' } })).json;
const t11 = d.salidas.find(s => s.horario === '11:00'), t14 = d.salidas.find(s => s.horario === '14:00');
assert.equal(t11.fichas, 2); assert.equal(t11.sinBote.length, 2);
assert.equal(t14.fichas, 1, 'la ficha libre con salida 2026-10-18-1400 se enlaza sola');
assert.deepEqual(d.sinSalida.map(f => f.nombre).sort(), ['Libre Rara', 'Menor Mena']);
ok('fichas con reserva heredan la salida; QR "2026-10-18-1400" se enlaza solo; "18oct-1100" queda sin salida');

console.log('== 6. Asignar fichas a balsas y capacidad');
const ids = Object.fromEntries((await q`select id, nombre from fichas`).map(f => [f.nombre, f.id]));
const bote = (s, i) => s.botes[i].id;
assert.equal((await call(ficha, { method: 'PATCH', body: { id: ids['Ana Perez'], bote_id: bote(t11, 0) } })).status, 200);
assert.equal((await call(ficha, { method: 'PATCH', body: { id: ids['Luis Perez'], bote_id: bote(t11, 0) } })).status, 200);
ok('dos fichas a Balsa 1');
let r = await call(ficha, { method: 'PATCH', body: { id: ids['Ana Perez'], bote_id: bote(t14, 0) } });
assert.equal(r.status, 409); assert.match(r.json.error, /otra salida/);
ok('balsa de otra salida -> 409');
r = await call(bajadas, { method: 'PATCH', body: { id: t11.id, botes: [{ nombre: 'Balsa 1', capacidad: 8 }] } });
assert.equal(r.status, 409); assert.match(r.json.error, /pasajeros asignados/);
ok('cambiar balsas con gente asignada -> 409');
// capacidad: dejo una balsa de 1 plaza en la salida de las 14:00 (nadie asignado allí) y meto dos fichas
r = await call(bajadas, { method: 'PATCH', body: { id: t14.id, botes: [{ nombre: 'Balsa 1', capacidad: 1 }, { nombre: 'Balsa 2', capacidad: 5 }] } });
assert.equal(r.status, 200);
d = (await call(bajadas, { query: { fecha: '2026-10-18' } })).json;
const u14 = d.salidas.find(s => s.horario === '14:00');
assert.deepEqual(u14.botes.map(b => b.capacidad), [1, 5]);
await call(ficha, { method: 'PATCH', body: { id: ids['Libre Rara'], bajada_id: u14.id } });
assert.equal((await call(ficha, { method: 'PATCH', body: { id: ids['Libre Legible'], bote_id: u14.botes[0].id } })).status, 200);
r = await call(ficha, { method: 'PATCH', body: { id: ids['Libre Rara'], bote_id: u14.botes[0].id } });
assert.equal(r.status, 409); assert.match(r.json.error, /llena \(1 de 1\)/);
ok('reemplazo de balsas 1+5; balsa llena rechaza a la segunda ficha (409 "ya está llena (1 de 1)")');
// mover la ficha de salida le quita la balsa
await call(ficha, { method: 'PATCH', body: { id: ids['Libre Legible'], bajada_id: t11.id } });
assert.equal((await q`select bote_id from fichas where id = ${ids['Libre Legible']}`)[0].bote_id, null);
ok('al cambiar una ficha de salida pierde su balsa anterior');
assert.equal((await call(ficha, { method: 'PATCH', body: { id: 99999, bote_id: null } })).status, 404);
assert.equal((await call(ficha, { method: 'PATCH', body: { id: ids['Ana Perez'], bote_id: 99999 } })).status, 404);
assert.equal((await call(ficha, { method: 'PATCH', body: { id: ids['Ana Perez'] }, auth: false })).status, 401);
ok('ficha/balsa inexistente -> 404; sin clave -> 401');

console.log('== 7. Sección completa: regla del día en la base');
const F = await reservar({ nombre: 'Full Fito', fecha: '2026-10-25', horario: '11:00', personas: 6, plan: 'Rafting Full $60.000' });
d = (await call(bajadas, { query: { fecha: '2026-10-25' } })).json;
assert.equal(d.salidas.length, 1); assert.equal(d.salidas[0].tramo, 'seccion_completa'); assert.deepEqual(d.salidas[0].alertas, []);
ok('reserva Full a las 11:00 -> salida con tramo sección completa, sin alertas');
await reservar({ nombre: 'Tarde Tati', fecha: '2026-10-25', horario: '14:00', personas: 2, plan: 'Rafting Extrema $45.000' });
d = (await call(bajadas, { query: { fecha: '2026-10-25' } })).json;
assert.equal(d.salidas.length, 2);
const tarde = d.salidas.find(s => s.horario === '14:00');
assert.equal(tarde.tramo, null, 'el trigger impide fijar tramo en un día de sección completa; se ignora sin romper');
assert.ok(d.salidas.every(s => s.alertas.includes('choque_seccion_completa')));
ok('otra reserva ese día -> salida sin tramo fijado y alerta choque_seccion_completa en ambas');
r = await call(bajadas, { method: 'PATCH', body: { id: tarde.id, tramo: 'san_alfonso_melocoton' } });
assert.equal(r.status, 409); assert.match(r.json.error, /sección completa/);
ok('PATCH de tramo que rompe la regla -> 409 con mensaje en español (código MR001 llega al handler)');
await reservar({ nombre: 'Full Tarde', fecha: '2026-11-01', horario: '14:00', personas: 2, plan: 'Rafting Full $60.000' });
d = (await call(bajadas, { query: { fecha: '2026-11-01' } })).json;
assert.equal(d.salidas[0].tramo, null); assert.ok(d.salidas[0].alertas.includes('choque_seccion_completa'));
ok('Full reservada a las 14:00 -> no se fija tramo (solo sale a las 11:00) y queda alerta');

// Caso inverso: una salida ya armada y después llega una reserva Full el mismo día
await reservar({ nombre: 'Tarde Primero', fecha: '2026-11-15', horario: '14:00', personas: 2, plan: 'Rafting Extrema $45.000' });
await call(bajadas, { query: { fecha: '2026-11-15' } });
await reservar({ nombre: 'Full Despues', fecha: '2026-11-15', horario: '11:00', personas: 4, plan: 'Rafting Full $60.000' });
d = (await call(bajadas, { query: { fecha: '2026-11-15' } })).json;
const m11 = d.salidas.find(s => s.horario === '11:00'), m14 = d.salidas.find(s => s.horario === '14:00');
assert.equal(m14.tramo, 'san_alfonso_melocoton'); assert.equal(m11.tramo, null);
assert.ok(d.salidas.every(s => s.alertas.includes('choque_seccion_completa')));
ok('salida ya armada + reserva Full posterior -> la Full queda sin tramo y ambas muestran alerta (el panel no falla)');
r = await call(bajadas, { method: 'PATCH', body: { id: m11.id, tramo: 'seccion_completa' } });
assert.equal(r.status, 409); assert.match(r.json.error, /Quítale el tramo a la otra salida/);
assert.equal((await call(bajadas, { method: 'PATCH', body: { id: m14.id, tramo: null } })).status, 200);
assert.equal((await call(bajadas, { method: 'PATCH', body: { id: m11.id, tramo: 'seccion_completa' } })).status, 200);
ok('camino de resolución: quitar el tramo de la otra salida y luego fijar sección completa -> 200');

console.log('== 8. Otras validaciones y alertas');
r = await call(bajadas, { method: 'PATCH', body: { id: s11.id, estado: 'publicada' } });
assert.equal(r.status, 400);
assert.equal((await call(bajadas, { method: 'PATCH', body: { id: s11.id, estado: 'suspendida', cupo: 20, caudal_m3s: 12.5, tramo: 'melocoton_san_jose' } })).status, 200);
const g = (await q`select estado, cupo, caudal_m3s::float as c, tramo from bajadas where id = ${s11.id}`)[0];
assert.deepEqual(g, { estado: 'suspendida', cupo: 20, c: 12.5, tramo: 'melocoton_san_jose' });
r = await call(bajadas, { method: 'PATCH', body: { id: s11.id, cupo: 0, estado: 'lista' } });
assert.equal(r.status, 400);
assert.equal((await q`select estado from bajadas where id = ${s11.id}`)[0].estado, 'suspendida', 'una validación fallida no deja cambios a medias');
ok("estado 'publicada' aún no disponible (400); PATCH múltiple aplica; validación fallida no deja cambios parciales");
await reservar({ nombre: 'Sobre Sosa', fecha: '2026-11-08', horario: '11:00', personas: 12, plan: 'Rafting Extrema $45.000' });
await reservar({ nombre: 'Sobre Segundo', fecha: '2026-11-08', horario: '11:00', personas: 5, plan: 'Rafting Power $35.000' });
d = (await call(bajadas, { query: { fecha: '2026-11-08' } })).json;
assert.equal(d.salidas[0].reservadas, 17); assert.equal(d.salidas[0].tramo, null);
assert.deepEqual(d.salidas[0].alertas, ['sobrecupo']);
assert.deepEqual(d.salidas[0].porTramo, { san_alfonso_melocoton: 12, melocoton_san_jose: 5 });
ok('17 personas de dos tramos en la misma salida -> solo alerta de sobrecupo; los tramos mezclados se venden y se informan (12 + 5)');
await reservar({ nombre: 'Mixta Uno', fecha: '2026-11-22', horario: '14:00', personas: 4, plan: 'Rafting Extrema $45.000' });
await reservar({ nombre: 'Mixta Dos', fecha: '2026-11-22', horario: '14:00', personas: 3, plan: 'Rafting Power $35.000' });
d = (await call(bajadas, { query: { fecha: '2026-11-22' } })).json;
assert.deepEqual(d.salidas[0].alertas, []); assert.equal(d.salidas[0].tramo, null);
ok('salida mixta dentro del cupo -> sin alertas y sin tramo forzado');

console.log('== 9. La reserva y ficha públicas siguen sin depender de las tablas nuevas');
const fresh = new PGlite();
const mk2 = (s, v) => ({ then: (a, b) => fresh.query(s.reduce((x, y, i) => x + '$' + i + y), v).then(r => r.rows).then(a, b) });
const q2 = (s, ...v) => mk2(s, v); q2.transaction = q.transaction;
// Base virgen SIN ensureBajadas: solo el flujo público
const src = await import(pathToFileURL(`${REPO}/api/_lib.js`).href + '?virgen=1');
src.useDb(q2);
await src.ensureSchema();
const t = await q2`select table_name from information_schema.tables where table_schema='public' order by 1`;
assert.ok(!t.some(x => x.table_name === 'bajadas' || x.table_name === 'botes'));
ok('ensureSchema() (camino público) no crea ni consulta las tablas de bajadas');

console.log(`\nTODO OK: ${n} comprobaciones`);
