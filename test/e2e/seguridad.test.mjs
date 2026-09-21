// Regresiones de seguridad y robustez halladas en la revisión de código de la app del equipo.
// Ejecuta los handlers reales sobre PostgreSQL en memoria (ver _db.mjs). Correr con: npm test
import assert from 'node:assert/strict';
import { imp, montar } from './_db.mjs';

const { q } = await montar();
const app = (await imp('api/app.js')).default, reservas = (await imp('api/reservas.js')).default, ficha = (await imp('api/ficha.js')).default;
const { hoyCL } = await imp('api/_auth.js');

async function llamar(h, { method = 'GET', query = {}, body, token } = {}) {
  let status = 200, json;
  const res = { setHeader() {}, end() {}, status(c) { status = c; return res; }, json(j) { json = j; return res; } };
  await h({ method, query, body, headers: { host: 'test.local', 'x-forwarded-for': '2.2.2.2', ...(token ? { authorization: 'Bearer ' + token } : {}) } }, res);
  return { status, json };
}
const post = (accion, token, body = {}) => llamar(app, { method: 'POST', body: { accion, ...body }, token });
const get = (a, token, query = {}) => llamar(app, { query: { a, ...query }, token });
let n = 0; const ok = m => console.log('  ok', ++n, '-', m);

const M = (await post('setup', null, { clave: 'clave-de-prueba', nombre: 'Dueña Uno', correo: 'd@x.cl', password: 'clavelarga1' })).json;
const entrar = async r => (await post('login', null, { usuario: r.usuario, password: r.clave })).json.token;

console.log('== Un admin sin verificar no puede tomar la cuenta maestra ni tocar a otros admin');
const sam = (await post('equipo_crear', M.token, { tipo: 'admin', nombre: 'Socio Sam' })).json, tS = await entrar(sam);
const otro = (await post('equipo_crear', M.token, { tipo: 'admin', nombre: 'Otro Socio' })).json;
let r = await post('equipo_editar', tS, { id: M.cuenta.id, reset_clave: true });
assert.equal(r.status, 403); assert.equal(r.json.clave, undefined);
assert.equal((await post('login', null, { usuario: M.cuenta.usuario, password: 'clavelarga1' })).status, 200, 'la maestra sigue entrando con su clave');
assert.equal((await post('equipo_editar', tS, { id: otro.id, reset_clave: true })).status, 403);
assert.equal((await post('equipo_editar', tS, { id: otro.id, activa: false })).status, 403);
ok('Sam (sin verificar) no puede resetear la clave de la maestra ni de otro admin, ni darlo de baja');
assert.equal((await post('equipo_editar', M.token, { id: M.cuenta.id, reset_clave: true })).status, 409);
ok('ni siquiera la maestra puede resetear su propia clave por Equipo: se cambia desde su perfil');
r = await post('equipo_editar', M.token, { id: otro.id, reset_clave: true }); assert.equal(r.status, 200); assert.ok(r.json.clave);
assert.equal((await post('equipo_editar', M.token, { id: otro.id, activa: false })).status, 200);
ok('la maestra sí administra a los otros admin (nueva clave y baja)');
const w = (await post('equipo_crear', tS, { nombre: 'Worker Wal', funciones: ['guia'] })).json;
assert.ok(w.clave); assert.equal((await post('equipo_editar', tS, { id: w.id, reset_clave: true })).status, 200);
assert.equal((await post('equipo_editar', tS, { id: w.id, activa: false })).status, 200);
ok('un admin sin verificar sí puede gestionar trabajadores');

console.log('== Acciones heredadas del prototipo de Object');
for (const a of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) {
  assert.equal((await get(a, M.token)).status, 400, 'GET ' + a);
  assert.equal((await post(a, M.token)).status, 400, 'POST ' + a);
}
ok('constructor, toString, __proto__… responden 400 "acción desconocida" en vez de ejecutarse');

console.log('== Datos de pasajeros: solo unos días después de cerrar la bajada');
const gina = (await post('equipo_crear', M.token, { nombre: 'Gina Guía', funciones: ['guia'] })).json, tG = await entrar(gina);
const dias = n2 => new Date(Date.parse(hoyCL()) + n2 * 864e5).toISOString().slice(0, 10);
async function bajadaCerrada(fecha, nombre) {
  const R = await llamar(reservas, { method: 'POST', body: { nombre, telefono: '+56911111111', correo: 'x@y.cl', fecha, horario: '11:00', personas: 2, plan: 'Rafting Extrema $45.000' } });
  assert.equal(R.status, 201);
  for (const p of ['Uno', 'Dos']) assert.equal((await llamar(ficha, { method: 'POST', body: { r: R.json.fichaUrl.split('r=')[1], nombre: `${nombre} ${p}`, firma: `${nombre} ${p}`, telefono: '+56922222222', email: 'p@q.cl',
    emergencia: 'Mamá — 999', consentimiento: true, sabeNadar: true, usoImagen: true, nacimiento: '1990-05-05', rut: p === 'Uno' ? '1-9' : '2-7', medico: 'asma' } })).status, 201);
  const sal = (await get('dia', M.token, { fecha })).json.salidas[0];
  assert.equal((await post('autodistribuir', M.token, { bajada_id: sal.id })).status, 200);
  assert.equal((await post('publicar', M.token, { bajada_id: sal.id, forzar: true })).status, 200);
  const t = (await get('turnos', tG, { desde: fecha, hasta: fecha })).json.turnos[0];
  assert.equal((await post('responder', tG, { turno_id: t.id, respuesta: 'aceptar' })).status, 200);
  const abierta = (await get('turno', tG, { id: t.id })).json;
  assert.equal(abierta.pasajeros.length, 2, 'aceptado: ve a sus pasajeros');
  assert.equal((await post('cerrar', tG, { turno_id: t.id, pax: 2 })).status, 200);
  return t.id;
}
const reciente = await bajadaCerrada(dias(-1), 'Reciente Rita'), antigua = await bajadaCerrada(dias(-11), 'Antigua Ana');
let d = (await get('turno', tG, { id: reciente })).json;
assert.equal(d.pasajeros.length, 2); assert.equal(d.datosOcultos, undefined);
d = (await get('turno', tG, { id: antigua })).json;
assert.equal(d.datosOcultos, true); assert.equal(d.pasajeros, undefined); assert.equal(d.manifiesto, undefined); assert.equal(d.botes, undefined);
assert.equal(d.turno.estado, 'cerrado', 'igual ve su turno, el monto y el pago');
assert.equal((await get('turno', M.token, { id: antigua })).json.pasajeros.length, 2, 'el admin sí conserva el acceso');
ok('cerrada hace 1 día: el guía aún ve a sus pasajeros; cerrada hace 11 días: solo ve su turno y su pago; el admin no pierde acceso');

console.log('== Inundar el formulario público de reservas no inunda los celulares');
const antes = (await q`select count(*)::int as n from avisos where tipo = 'reserva' and cuenta_id = ${M.cuenta.id}`)[0].n;
for (let i = 0; i < 14; i++) assert.equal((await llamar(reservas, { method: 'POST', body: { nombre: 'Spam ' + i, telefono: '+56911111111', correo: 's@y.cl', fecha: dias(30), horario: '14:00', personas: 1, plan: 'Rafting Power $35.000' } })).status, 201);
const despues = (await q`select count(*)::int as n from avisos where tipo = 'reserva' and cuenta_id = ${M.cuenta.id}`)[0].n;
assert.equal(despues, 10, 'tope de 10 avisos de reserva cada 10 minutos por admin');
assert.ok(antes <= 10);
assert.equal((await q`select count(*)::int as n from reservas where nombre like 'Spam %'`)[0].n, 14, 'pero las 14 reservas quedan guardadas');
ok('14 reservas seguidas: se guardan las 14, pero solo se generan 10 avisos');

console.log('== El límite de intentos de acceso se reinicia con un acceso correcto');
for (let i = 0; i < 3; i++) await post('login', null, { usuario: gina.usuario, password: 'mala' });
assert.equal((await q`select count(*)::int as n from login_intentos where clave = ${'u:' + gina.usuario}`)[0].n, 3);
assert.equal((await post('login', null, { usuario: gina.usuario, password: gina.clave })).status, 200);
assert.equal((await q`select count(*)::int as n from login_intentos where clave = ${'u:' + gina.usuario}`)[0].n, 0);
ok('tras un acceso correcto se borran los fallos de ese usuario');

console.log(`\nTODO OK: ${n} comprobaciones`);
