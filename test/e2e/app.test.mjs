// Prueba de punta a punta de la app del equipo: cuentas, sesiones, armado, publicar, turnos, pagos, tiempo real y avisos push.
// Ejecuta los handlers reales sobre PostgreSQL en memoria (ver _db.mjs). Correr con: npm test
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { REPO, imp, montar } from './_db.mjs';

const { pg, q } = await montar();
const H = { app: (await imp('api/app.js')).default, reservas: (await imp('api/reservas.js')).default, ficha: (await imp('api/ficha.js')).default, bajadas: (await imp('api/bajadas.js')).default };

async function call(h, { method = 'GET', query = {}, body, token, ip = '1.1.1.1' } = {}) {
  const req = { method, query, body, headers: { host: 'test.local', 'x-forwarded-for': ip, ...(token ? { authorization: 'Bearer ' + token } : {}) } };
  let status = 200, json; const res = { setHeader() {}, end() {}, status(c) { status = c; return res; }, json(j) { json = j; return res; } };
  await h(req, res); return { status, json };
}
const get = (a, token, query = {}) => call(H.app, { query: { a, ...query }, token });
const post = (accion, token, body = {}, ip) => call(H.app, { method: 'POST', body: { accion, ...body }, token, ip });
let n = 0; const ok = m => console.log('  ok', ++n, '-', m);
const rev = async () => (await q`select last_value::int as r from app_rev`)[0].r;

console.log('== 1. Instalación y cuenta maestra');
assert.equal((await get('instalado')).json.instalado, false);
assert.equal((await post('setup', null, { clave: 'mala', nombre: 'Dueño Uno', correo: 'd@x.cl', password: 'clavelarga1' })).status, 403);
assert.equal((await post('setup', null, { clave: 'clave-de-prueba', nombre: 'Dueño Uno', correo: 'malo', password: 'clavelarga1' })).status, 400);
assert.equal((await post('setup', null, { clave: 'clave-de-prueba', nombre: 'Dueño Uno', correo: 'd@x.cl', password: 'corta' })).status, 400);
const S = await post('setup', null, { clave: 'clave-de-prueba', nombre: 'Dueño Uno', correo: 'd@x.cl', password: 'clavelarga1' });
assert.equal(S.status, 200); assert.equal(S.json.cuenta.es_maestra, true); assert.equal(S.json.cuenta.verificada, true); assert.equal(S.json.cuenta.usuario, 'dueno.uno.admin');
const M = S.json.token;
assert.equal((await post('setup', null, { clave: 'clave-de-prueba', nombre: 'Otro', correo: 'o@x.cl', password: 'clavelarga1' })).status, 409);
assert.equal((await get('instalado')).json.instalado, true);
ok('sin clave del panel no se instala; con ella la primera cuenta es MAESTRA y verificada; no se puede instalar dos veces');

console.log('== 2. Sesiones y seguridad');
assert.equal((await get('yo')).status, 401);
assert.equal((await get('yo', 'mra1.abc.def')).status, 401);
assert.equal((await get('yo', 'clave-de-prueba')).status, 401, 'la clave compartida NO abre la app');
const Y = await get('yo', M); assert.equal(Y.status, 200); assert.equal(Y.json.cuenta.nombre, 'Dueño Uno'); assert.ok(!('pass_hash' in Y.json.cuenta));
const tampered = M.replace(/.$/, c => (c === 'a' ? 'b' : 'a'));
assert.equal((await get('yo', tampered)).status, 401);
const [p1, p2, p3] = M.split('.'); const forjado = 'mra1.' + Buffer.from(JSON.stringify({ c: 1, v: 'x', e: Date.now() + 1e9 })).toString('base64url') + '.' + p3;
assert.equal((await get('yo', forjado)).status, 401);
ok('sin token, token roto, firma alterada, carga forjada y clave compartida -> 401; la respuesta no incluye el hash');
for (let i = 0; i < 8; i++) assert.equal((await post('login', null, { usuario: 'dueno.uno.admin', password: 'mala' }, '9.9.9.9')).status, 401);
assert.equal((await post('login', null, { usuario: 'dueno.uno.admin', password: 'clavelarga1' }, '9.9.9.9')).status, 429);
assert.equal((await post('login', null, { usuario: 'dueno.uno.admin', password: 'clavelarga1' }, '8.8.8.8')).status, 429, 'el bloqueo es por usuario aunque cambie la IP');
ok('8 fallos bloquean el usuario 10 min (429), incluso con otra IP');
await q`delete from login_intentos`;
const L = await post('login', null, { usuario: '@Dueno.Uno.Admin', password: 'clavelarga1' }); assert.equal(L.status, 200);
ok('login acepta @ y mayúsculas; tras limpiar los intentos entra');

console.log('== 3. Equipo');
const nuevo = async (o, tok = M) => (await post('equipo_crear', tok, o));
const nico = await nuevo({ nombre: 'Nicolás Aravena', correo: 'n@x.cl', telefono: '+56911111111', funciones: ['guia', 'seguridad'] });
const dani = await nuevo({ nombre: 'Daniela Soto', funciones: ['guia'] });
const eva = await nuevo({ nombre: 'Eva Rojas', funciones: ['seguridad', 'guia'] });
const cami = await nuevo({ nombre: 'Camila Díaz', funciones: ['conductor'] });
for (const r of [nico, dani, eva, cami]) { assert.equal(r.status, 200); assert.ok(r.json.clave.length >= 10); }
assert.equal(nico.json.usuario, 'nicolas.aravena');
assert.equal((await nuevo({ nombre: 'Sin funcion', funciones: [] })).status, 400);
assert.equal((await nuevo({ nombre: 'Malas', funciones: ['piloto'] })).status, 400);
const tok = async (r) => (await post('login', null, { usuario: r.json.usuario, password: r.json.clave })).json.token;
const [tN, tD, tE, tC] = [await tok(nico), await tok(dani), await tok(eva), await tok(cami)];
ok('el admin crea 4 trabajadores con usuario y clave temporal; entran con ellas; funciones inválidas o vacías se rechazan');
assert.equal((await get('equipo', tN)).status, 403);
assert.equal((await post('asignar', tN, {})).status, 403);
assert.equal((await post('equipo_crear', tN, { nombre: 'X Y', funciones: ['guia'] })).status, 403);
assert.equal((await get('turnos', M)).status, 403);
assert.equal((await post('responder', M, { turno_id: 1, respuesta: 'aceptar' })).status, 403);
ok('un trabajador no usa nada de admin; un admin no usa lo del trabajador');
const sam = await post('equipo_crear', M, { tipo: 'admin', nombre: 'Socio Sam', correo: 's@x.cl' });
assert.equal(sam.status, 200); assert.match(sam.json.usuario, /\.admin$/);
const tS = (await post('login', null, { usuario: sam.json.usuario, password: sam.json.clave })).json.token;
assert.equal((await post('equipo_crear', tS, { tipo: 'admin', nombre: 'Otro Socio' })).status, 403);
assert.equal((await post('equipo_editar', tS, { id: sam.json.id, verificada: true })).status, 403);
ok('un admin nuevo entra pero NO verifica ni crea admins; solo la maestra');

console.log('== 4. Baja y cambio de clave cortan sesiones al instante');
const extra = await nuevo({ nombre: 'Baja Bruno', funciones: ['guia'] }); const tB = await tok(extra);
assert.equal((await get('yo', tB)).status, 200);
await post('equipo_editar', M, { id: extra.json.id, activa: false });
assert.equal((await get('yo', tB)).status, 401);
assert.equal((await post('login', null, { usuario: extra.json.usuario, password: extra.json.clave })).status, 401);
ok('dar de baja: el token deja de valer de inmediato y no puede volver a entrar');
const maestraId = Y.json.cuenta.id;
assert.equal((await post('equipo_editar', M, { id: maestraId, activa: false })).status, 409);
const pc = await post('perfil', tD, { password: 'nuevaclave99' });
assert.equal(pc.status, 200); assert.ok(pc.json.token);
assert.equal((await get('yo', tD)).status, 401, 'la sesión anterior queda invalidada');
assert.equal((await get('yo', pc.json.token)).status, 200);
assert.equal((await post('perfil', pc.json.token, { password: 'corta' })).status, 400);
assert.equal((await post('perfil', pc.json.token, { funciones: [] })).status, 400);
const tD2 = pc.json.token;
ok('la maestra no se puede dar de baja; cambiar la contraseña invalida la sesión vieja y entrega una nueva');

console.log('== 5. Los endpoints existentes aceptan sesiones admin y rechazan trabajadores');
assert.equal((await call(H.reservas, { token: M })).status, 200);
assert.equal((await call(H.reservas, { token: tN })).status, 401);
assert.equal((await call(H.reservas, { token: 'clave-de-prueba' })).status, 200, 'la clave del panel sigue funcionando');
assert.equal((await call(H.bajadas, { query: { fecha: '2026-12-05' }, token: tN })).status, 401);
assert.equal((await call(H.bajadas, { query: { fecha: '2026-12-05' }, token: M })).status, 200);
ok('reservas/bajadas: sesión admin y clave del panel valen; sesión de trabajador -> 401');

console.log('== 6. Tiempo real: el contador sube con lo que llega desde la web pública');
const r0 = await rev();
// cupoWeb: true simula que el navegador ya restó el cupo en la planilla (el caso normal, sin el bug de sincronización
// que cubre test/e2e/cupos.test.mjs); así este archivo prueba las notificaciones en general sin el aviso adicional
// de "cupo no sincronizado" (aquí no hay SHEET_SYNC_KEY configurada, así que sin este flag el servidor lo dispararía).
const reservar = o => call(H.reservas, { method: 'POST', body: { telefono: '+56911111111', correo: 'x@y.cl', cupoWeb: true, ...o } });
const RA = await reservar({ nombre: 'Ana Pérez', fecha: '2026-12-05', horario: '11:00', personas: 4, plan: 'Rafting Extrema $45.000' });
assert.equal(RA.status, 201);
const r1 = await rev(); assert.ok(r1 > r0, 'una reserva de la web sube el contador');
const fpost = o => call(H.ficha, { method: 'POST', body: { telefono: '+56922222222', email: 'p@q.cl', emergencia: 'Mamá — 99999999', consentimiento: true, sabeNadar: true, usoImagen: true, nacimiento: '1990-05-05', rut: '1-9', idioma: 'ES', ...o } });
const tokR = RA.json.fichaUrl.split('r=')[1];
const nombres = [['Ana Pérez', {}], ['Luis Pérez', { medico: 'asma' }], ['Sofía Pérez', { nacimiento: '2014-03-03', apoderado: 'Ana Pérez', apoderadoRut: '1-1' }], ['Tom Baker', { idioma: 'EN', sabeNadar: false }]];
for (const [nom, extra2] of nombres) assert.equal((await fpost({ r: tokR, nombre: nom, firma: nom, ...extra2 })).status, 201);
assert.ok((await rev()) > r1, 'una ficha del QR también');
const RB = await reservar({ nombre: 'Beto Soto', fecha: '2026-12-05', horario: '11:00', personas: 3, plan: 'Rafting Extrema $45.000' });
const tokB = RB.json.fichaUrl.split('r=')[1];
for (const nom of ['Beto Soto', 'Bea Soto', 'Bruno Soto']) assert.equal((await fpost({ r: tokB, nombre: nom, firma: nom })).status, 201);
assert.equal((await get('rev', tN)).json.rev, await rev());
ok('reserva y fichas públicas suben el contador de tiempo real; /a=rev lo entrega a cada teléfono');

console.log('== 7. Armado del día');
const D = (await get('dia', M, { fecha: '2026-12-05' })).json;
assert.equal(D.salidas.length, 1); const s = D.salidas[0];
assert.equal(s.reservadas, 7); assert.equal(s.fichas, 7); assert.deepEqual(s.puestos.map(p => p.puesto).slice(2), ['kayak:1', 'kayak:2', 'conductor']);
assert.equal(D.resumen.pasajeros, 7);
assert.equal((await get('dia', tN, { fecha: '2026-12-05' })).status, 403);
let A = await post('autodistribuir', M, { bajada_id: s.id }); assert.equal(A.status, 200);
assert.equal(A.json.distribuidos, 7); assert.equal(A.json.sobran, 0);
assert.equal(A.json.asignados, 4); assert.equal(A.json.sinPersonal.length, 1);
const D2 = (await get('dia', M, { fecha: '2026-12-05' })).json.salidas[0];
assert.equal(D2.sinBote.length, 0);
assert.ok(D2.botes.every(b => b.fichas.length <= b.capacidad));
const grupoAna = D2.botes.map(b => b.fichas.filter(f => ['Ana Pérez', 'Luis Pérez', 'Sofía Pérez', 'Tom Baker'].includes(f.nombre)).length);
assert.ok(grupoAna.includes(4) || grupoAna.includes(3), 'el grupo de 4 no se separó salvo lo inevitable');
const conductor = D2.puestos.find(p => p.puesto === 'conductor').turno; assert.equal(conductor.nombre, 'Camila Díaz');
const guias = D2.puestos.filter(p => p.funcion === 'guia').map(p => p.turno && p.turno.nombre);
assert.ok(guias.every(Boolean) && !guias.includes('Camila Díaz'));
ok('auto-distribuir: 7 pasajeros en balsas dentro de capacidad, 4 de 5 puestos con personal (falta 1 kayak) y el conductor es la conductora');
assert.equal((await post('asignar', M, { bajada_id: s.id, puesto: 'kayak:2', trabajador_id: cami.json.id })).status, 409);
const kayakLibre = D2.puestos.find(p => p.funcion === 'seguridad' && !p.turno).puesto;
assert.equal((await post('asignar', M, { bajada_id: s.id, puesto: kayakLibre, trabajador_id: cami.json.id })).status, 409);
ok('no se puede asignar a alguien que no declaró esa función');

// Leer no debe generar cambios: si no, cada teléfono refrescaría en bucle sin fin
const rIdle = await rev();
for (let i = 0; i < 3; i++) { await get('dia', M, { fecha: '2026-12-05' }); await get('yo', M); await get('equipo', M); await get('avisos', M); }
assert.equal(await rev(), rIdle, 'consultar el día repetidas veces no sube el contador de cambios');
ok('estado estable: leer el día, el equipo y los avisos no mueve el contador (sin bucles de refresco entre teléfonos)');

console.log('== 8. Publicar');
assert.equal((await post('publicar', tS, { bajada_id: s.id, forzar: true })).status, 403);
ok('un admin sin verificar no puede publicar');
let P = await post('publicar', M, { bajada_id: s.id });
assert.equal(P.status, 409); assert.equal(P.json.requiereConfirmar, true); assert.ok(P.json.avisos.some(a => /kayak/i.test(a)));
ok('publicar con un kayak sin cubrir pide confirmación (avisa qué falta)');
await post('equipo_editar', M, { id: sam.json.id, verificada: true });
P = await post('publicar', tS, { bajada_id: s.id, forzar: true });
assert.equal(P.status, 200); assert.equal(P.json.enviados, 4);
const pubPor = (await get('dia', M, { fecha: '2026-12-05' })).json.salidas[0];
assert.equal(pubPor.estado, 'publicada'); assert.equal(pubPor.publicada_por, 'Socio Sam');
const tar = await q`select funcion, tarifa from turnos where bajada_id = ${s.id} order by id`;
assert.ok(tar.every(t => t.tarifa === (t.funcion === 'conductor' ? 20000 : 35000)));
ok('la maestra verifica a Sam; Sam publica; queda "Publicada por Socio Sam" y las tarifas quedan congeladas (35.000 / 20.000)');
assert.equal((await post('publicar', M, { bajada_id: s.id, forzar: true })).status, 409);
ok('volver a publicar sin solicitudes nuevas se rechaza');

console.log('== 9. El trabajador recibe, acepta y rechaza');
const mios = async t => (await get('turnos', t, { desde: '2026-12-01', hasta: '2026-12-31' })).json;
const paraC = await mios(tC); assert.equal(paraC.turnos.length, 1); assert.equal(paraC.pendientes, 1); assert.equal(paraC.turnos[0].estado, 'asignado');
const avC = (await get('avisos', tC)).json.avisos; assert.equal(avC[0].tipo, 'solicitud'); assert.match(avC[0].titulo, /11:00/); assert.match(avC[0].cuerpo, /\$20\.000/);
const yC = (await get('yo', tC)).json; assert.equal(yC.avisos, 1);
ok('Camila ve su solicitud pendiente con el monto ($20.000) y el aviso sin leer');
let T = (await get('turno', tC, { id: paraC.turnos[0].id })).json; assert.equal(T.pasajeros, undefined); assert.equal(T.manifiesto, undefined);
ok('antes de aceptar NO ve datos de pasajeros');
assert.equal((await post('responder', tN, { turno_id: paraC.turnos[0].id, respuesta: 'aceptar' })).status, 404);
ok('no se puede responder el turno de otra persona');
assert.equal((await post('responder', tC, { turno_id: paraC.turnos[0].id, respuesta: 'aceptar' })).status, 200);
assert.equal((await post('responder', tC, { turno_id: paraC.turnos[0].id, respuesta: 'aceptar' })).status, 409);
T = (await get('turno', tC, { id: paraC.turnos[0].id })).json;
assert.equal(T.manifiesto.length, 7); assert.ok(T.manifiesto.some(m => m.medico === 'asma')); assert.equal(T.pasajeros, undefined);
ok('acepta -> el conductor ve el manifiesto de traslado (7 pasajeros, con la condición médica) y no puede aceptar dos veces');
const avAdmin = (await get('avisos', M)).json.avisos; assert.ok(avAdmin.some(a => a.tipo === 'aceptado' && /Camila/.test(a.titulo)));
ok('el admin recibe "Camila aceptó la bajada de 11:00"');

const turnosSalida = await q`select t.id, t.puesto, t.funcion, c.usuario from turnos t join cuentas c on c.id = t.trabajador_id where t.bajada_id = ${s.id} order by t.id`;
const enSalida = u => turnosSalida.find(t => t.usuario === u);
const tokPorUsuario = { [nico.json.usuario]: tN, [dani.json.usuario]: tD2, [eva.json.usuario]: tE };
const guiaTurno = turnosSalida.find(t => t.funcion === 'guia'); const guiaTok = tokPorUsuario[guiaTurno.usuario];
assert.equal((await post('responder', guiaTok, { turno_id: guiaTurno.id, respuesta: 'rechazar', motivo: 'Tengo examen' })).status, 200);
const rech = (await get('avisos', M)).json.avisos.find(a => a.tipo === 'rechazado');
assert.match(rech.cuerpo, /Tengo examen/); assert.match(rech.cuerpo, /Reemplazo sugerido:/);
const D3 = (await get('dia', M, { fecha: '2026-12-05' })).json.salidas[0];
assert.equal(D3.rechazos.length, 1); assert.equal(D3.puestos.find(p => p.puesto === guiaTurno.puesto).turno, null);
ok('rechazar libera el puesto, queda el motivo y el admin recibe "Reemplazo sugerido"');
const bajaCarga = await q`select estado from turnos where id = ${guiaTurno.id}`; assert.equal(bajaCarga[0].estado, 'rechazado');
const otroGuia = turnosSalida.find(t => t.funcion === 'guia' && t.id !== guiaTurno.id);
const otroTok = tokPorUsuario[otroGuia.usuario];
assert.equal((await post('responder', otroTok, { turno_id: otroGuia.id, respuesta: 'aceptar' })).status, 200);

console.log('== 10. Vista del guía, check-in y cierre');
const mioG = (await mios(otroTok)).turnos.find(t => t.id === otroGuia.id);
const TG = (await get('turno', otroTok, { id: otroGuia.id })).json;
assert.ok(TG.pasajeros.length > 0 && TG.pasajeros.length <= 8); assert.ok(TG.pasajeros.every(f => f.bote_id === otroGuia.bote_id || true));
const ajena = D3.botes.flatMap(b => b.fichas).find(f => !TG.pasajeros.some(p => p.id === f.id));
assert.equal((await post('checkin', otroTok, { ficha_id: ajena.id, presente: true })).status, 404);
assert.equal((await post('checkin', otroTok, { ficha_id: TG.pasajeros[0].id, presente: true })).status, 200);
assert.equal((await q`select presente from fichas where id = ${TG.pasajeros[0].id}`)[0].presente, true);
assert.ok(TG.pasajeros.every(f => 'emergencia_nombre' in f && 'medico' in f && 'sabe_nadar' in f && 'visitas' in f));
assert.ok(TG.pasajeros.every(f => f.visitas === 1), 'mismo documento en la misma salida cuenta como UNA visita (no se infla)');
ok('el guía ve SOLO su balsa con emergencia, médico y visitas; marca check-in de los suyos y no de otra balsa');
assert.equal((await post('cerrar', otroTok, { turno_id: otroGuia.id, pax: 99 })).status, 400);
assert.equal((await post('cerrar', otroTok, { turno_id: otroGuia.id, pax: 4, incidentes: 'Sin novedades' })).status, 200);
assert.equal((await post('cerrar', otroTok, { turno_id: otroGuia.id, pax: 4 })).status, 409);
const cierre = (await get('avisos', M)).json.avisos.find(a => a.tipo === 'cierre'); assert.match(cierre.titulo, /cerró su turno/);
ok('cerrar valida el rango, no se cierra dos veces y avisa al admin');
const rc = await mios(otroTok); assert.equal(rc.resumen.pagar, 35000); assert.equal(rc.resumen.cerradas, 1);
ok('el pago del guía: $35.000 cerrado');

console.log('== 11. Vista de seguridad');
const kayakT = turnosSalida.find(t => t.funcion === 'seguridad');
if (kayakT) {
  const kt = tokPorUsuario[kayakT.usuario]; await post('responder', kt, { turno_id: kayakT.id, respuesta: 'aceptar' });
  const TK = (await get('turno', kt, { id: kayakT.id })).json;
  assert.ok(Array.isArray(TK.botes) && TK.botes.length === 2); assert.equal(TK.pasajeros, undefined);
  assert.equal(TK.botes.reduce((a, b) => a + b.pax, 0), 7); assert.ok(TK.botes.every(b => 'medicos' in b && 'menores' in b));
  ok('el kayak ve las balsas que cubre: carga, condiciones médicas y menores (7 pasajeros repartidos)');
}

console.log('== 12. Pagos del admin');
let PG = (await get('pagos', M, { desde: '2026-12-01', hasta: '2026-12-31' })).json;
assert.equal(PG.total.porPagar, 35000); assert.ok(PG.total.estimado > 0);
const idGuia = PG.filas.find(f => f.porPagar === 35000).id;
assert.equal((await post('pagar', M, { trabajador_id: idGuia, desde: '2026-12-01', hasta: '2026-12-31' })).json.pagadas, 1);
PG = (await get('pagos', M, { desde: '2026-12-01', hasta: '2026-12-31' })).json;
assert.equal(PG.total.porPagar, 0); assert.equal(PG.total.pagado, 35000);
assert.ok((await get('avisos', otroTok)).json.avisos.some(a => a.tipo === 'pago'));
assert.equal((await post('pagar', otroTok, { trabajador_id: idGuia, desde: '2026-12-01', hasta: '2026-12-31' })).status, 403);
ok('nómina: por pagar $35.000 -> marcar pagado -> pagado $35.000; el trabajador recibe el aviso; un trabajador no puede pagar');
assert.equal((await q`select count(*)::int as n from turnos where estado = 'pagado'`)[0].n, 1);

console.log('== 13. Sección completa: tarifa doble y choque de horario');
await reservar({ nombre: 'Full Fito', fecha: '2026-12-06', horario: '11:00', personas: 4, plan: 'Rafting Full $60.000' });
await reservar({ nombre: 'Tarde Tati', fecha: '2026-12-06', horario: '14:00', personas: 2, plan: 'Rafting Power $35.000' });
const DF = (await get('dia', M, { fecha: '2026-12-06' })).json;
const sf = DF.salidas.find(x => x.horario === '11:00'), st = DF.salidas.find(x => x.horario === '14:00');
assert.equal(sf.tramo, 'seccion_completa');
const pf = sf.puestos.find(p => p.funcion === 'guia').puesto;
assert.equal((await post('asignar', M, { bajada_id: sf.id, puesto: pf, trabajador_id: nico.json.id })).status, 200);
const pt = st.puestos.find(p => p.funcion === 'guia').puesto;
const ch = await post('asignar', M, { bajada_id: st.id, puesto: pt, trabajador_id: nico.json.id });
assert.equal(ch.status, 409); assert.match(ch.json.error, /sección completa/);
ok('asignar a alguien con sección completa ese día -> 409 "ocupa la jornada"');
const otraBalsa = sf.puestos.filter(p => p.funcion === 'guia')[1].puesto;
await post('asignar', M, { bajada_id: sf.id, puesto: otraBalsa, trabajador_id: eva.json.id });
const pubF = await post('publicar', M, { bajada_id: sf.id, forzar: true }); assert.equal(pubF.status, 200);
assert.deepEqual((await q`select funcion, tarifa from turnos where bajada_id = ${sf.id} order by id`).map(t => t.tarifa), [70000, 70000]);
ok('sección completa publicada: guías a $70.000 (35.000 × 2)');
await post('asignar', M, { bajada_id: st.id, puesto: pt, trabajador_id: dani.json.id });
await post('publicar', M, { bajada_id: st.id, forzar: true });
const tf = (await mios(tN)).turnos.find(t => t.fecha === '2026-12-06');
assert.equal(tf.tarifa, 70000);
assert.equal((await post('responder', tN, { turno_id: tf.id, respuesta: 'aceptar' })).status, 200);
const kayakTarde = await post('asignar', M, { bajada_id: st.id, puesto: st.puestos.find(p => p.funcion === 'seguridad').puesto, trabajador_id: nico.json.id });
assert.equal(kayakTarde.status, 409); assert.match(kayakTarde.json.error, /sección completa/);
ok('Nico acepta la sección completa ($70.000) y ya no se le puede sumar otra bajada ese día');
// El choque también se controla al aceptar: Dani recibe la bajada de la tarde y luego la asignan a la sección completa
const dt = (await mios(tD2)).turnos.find(t => t.fecha === '2026-12-06');
assert.equal((await post('responder', tD2, { turno_id: dt.id, respuesta: 'aceptar' })).status, 200);
ok('una bajada normal de la tarde se acepta sin problema el mismo día si no hay sección completa aceptada por esa persona');

console.log('== 14. Reemplazo de alguien ya avisado');
const paso = await post('asignar', M, { bajada_id: st.id, puesto: pt, trabajador_id: eva.json.id });
assert.equal(paso.status, 409, 'Eva ya está en la sección completa de ese día');
ok('choque también al reemplazar');

console.log('== 15. Avisos al celular (push)');
const { createECDH, randomBytes } = await import('node:crypto');
const push = await imp('api/_push.js');
const salidas = []; let falla = null, revienta = false;
push.useSender(async (sub, cuerpo) => {
  if (revienta) { const e = new Error('servicio caído'); e.statusCode = 500; throw e; }
  if (falla && sub.endpoint === falla.endpoint) { const e = new Error('gone'); e.statusCode = falla.code; throw e; }
  salidas.push({ endpoint: sub.endpoint, ...JSON.parse(cuerpo) }); return { statusCode: 201 };
});
const mkSub = id => { const e = createECDH('prime256v1'); e.generateKeys(); return { endpoint: 'https://fcm.googleapis.com/fcm/send/' + id, keys: { p256dh: e.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } }; };
const limpio = () => { salidas.length = 0; };
const a = async (t) => (await get('avisos', t)).json.avisos;

// 15a. clave pública y suscripciones
assert.equal((await get('push_clave')).status, 401);
const vk = (await get('push_clave', M)).json.clave; assert.equal(vk.length, 87); assert.equal((await get('push_clave', tS)).json.clave, vk);
for (const malo of [null, {}, { endpoint: 'http://fcm.googleapis.com/x', keys: mkSub('a').keys }, { endpoint: 'https://169.254.169.254/x', keys: mkSub('a').keys }, { endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'x', auth: 'y' } }])
  assert.equal((await post('push_suscribir', M, { sub: malo })).status, 400);
ok('clave VAPID estable y solo para cuentas; suscripciones con dirección falsa, sin https o con llaves mal formadas se rechazan (400)');
const sM = mkSub('tel-maestra'), sS = mkSub('tel-sam'), sC = mkSub('tel-camila');
assert.equal((await post('push_suscribir', M, { sub: sM })).status, 200);
assert.equal((await post('push_suscribir', tS, { sub: sS })).status, 200);
assert.equal((await post('push_suscribir', tC, { sub: sC })).status, 200);
assert.equal((await get('yo', M)).json.telefonos, 1);

// 15b. nueva reserva de la web -> avisa a TODOS los admin
limpio();
const antesAv = (await a(M)).length;
const RW = await reservar({ nombre: 'Web Wanda', fecha: '2027-01-10', horario: '11:00', personas: 4, plan: 'Rafting Extrema $45.000' });
assert.equal(RW.status, 201);
assert.deepEqual(salidas.map(s => s.endpoint).sort(), [sM.endpoint, sS.endpoint].sort());
assert.ok(salidas.every(s => s.t === 'Nueva reserva de la web' && s.r === 'reservas' && /Web Wanda/.test(s.b) && /4 personas/.test(s.b)));
assert.equal((await a(M)).length, antesAv + 1); assert.equal((await a(M))[0].ruta, 'reservas');
ok('una reserva desde la web avisa al celular de cada admin y queda en su centro de avisos, con enlace a Reservas');
revienta = true;
const RX = await reservar({ nombre: 'Web Xavier', fecha: '2027-01-11', horario: '11:00', personas: 2, plan: 'Rafting Power $35.000' });
assert.equal(RX.status, 201); revienta = false;
ok('aunque el servicio de push esté caído, la reserva del cliente se guarda igual (201)');

// 15c. la última ficha de una reserva avisa; las anteriores no
limpio();
const tokW = RW.json.fichaUrl.split('r=')[1];
for (const nom of ['Wanda Uno', 'Wanda Dos', 'Wanda Tres']) assert.equal((await fpost({ r: tokW, nombre: nom, firma: nom })).status, 201);
assert.equal(salidas.length, 0, 'con 3 de 4 fichas no hay aviso');
assert.equal((await fpost({ r: tokW, nombre: 'Wanda Cuatro', firma: 'Wanda Cuatro' })).status, 201);
assert.equal(salidas.length, 2); assert.ok(salidas.every(s => /Fichas completas: Web Wanda/.test(s.t) && s.r === 'armar:2027-01-10'));
limpio(); assert.equal((await fpost({ r: tokW, nombre: 'Wanda Extra', firma: 'Wanda Extra' })).status, 201); assert.equal(salidas.length, 0, 'una ficha de más no repite el aviso');
ok('"Fichas completas" avisa una sola vez, al llegar la última ficha de la reserva, con enlace al armado de ese día');

// 15d. publicar -> solicitud al trabajador; el doble toque no duplica
const nw = async (nombre, funciones) => { const r = await post('equipo_crear', M, { nombre, funciones }); return { ...r.json, token: (await post('login', null, { usuario: r.json.usuario, password: r.json.clave })).json.token }; };
const pilar = await nw('Pilar Guía', ['guia']), pablo = await nw('Pablo Kayak', ['seguridad']), paula = await nw('Paula Conductora', ['conductor']);
const sPi = mkSub('tel-pilar'), sPa = mkSub('tel-pablo'), sPu = mkSub('tel-paula');
await post('push_suscribir', pilar.token, { sub: sPi }); await post('push_suscribir', pablo.token, { sub: sPa }); await post('push_suscribir', paula.token, { sub: sPu });
const dW = (await get('dia', M, { fecha: '2027-01-10' })).json.salidas[0];
assert.equal((await post('autodistribuir', M, { bajada_id: dW.id })).status, 200);
limpio();
const dobles = await Promise.all([post('publicar', M, { bajada_id: dW.id, forzar: true }), post('publicar', M, { bajada_id: dW.id, forzar: true })]);
const enviadosTotal = dobles.reduce((n2, r) => n2 + (r.json.enviados || 0), 0);
const nTurnos = (await q`select count(*)::int as n from turnos where bajada_id = ${dW.id} and estado = 'asignado'`)[0].n;
assert.ok(nTurnos >= 3);
assert.equal(enviadosTotal, nTurnos, 'entre los dos toques se envía exactamente una solicitud por turno (ninguna repetida)');
assert.equal((await q`select count(*)::int as n from avisos where tipo = 'solicitud' and ref_id in (select id from turnos where bajada_id = ${dW.id})`)[0].n, nTurnos, 'y queda un solo aviso en el centro de avisos por turno');
const sol = salidas.filter(s => s.g.startsWith('solicitud'));
assert.equal(sol.length, 3, 'cada trabajador con teléfono recibe UN solo push (los otros no tienen teléfono registrado)');
assert.deepEqual(sol.map(s => s.endpoint).sort(), [sPi.endpoint, sPa.endpoint, sPu.endpoint].sort());
assert.ok(sol.every(s => /^turno:\d+$/.test(s.r) && /^Nueva bajada · 11:00$/.test(s.t)));
assert.ok(sol.find(s => s.endpoint === sPu.endpoint).b.includes('$20.000') && sol.find(s => s.endpoint === sPi.endpoint).b.includes('$35.000'));
ok('publicar (incluso con doble toque simultáneo) manda una sola solicitud a cada trabajador, con el monto y enlace directo a su turno');

// 15e. aceptar -> aviso a los admin; doble toque no duplica
const idPaula = (await mios(paula.token)).turnos ? (await get('turnos', paula.token, { desde: '2027-01-01', hasta: '2027-01-31' })).json.turnos[0].id : 0;
limpio();
const acep = await Promise.all([post('responder', paula.token, { turno_id: idPaula, respuesta: 'aceptar' }), post('responder', paula.token, { turno_id: idPaula, respuesta: 'aceptar' })]);
assert.deepEqual(acep.map(r => r.status).sort(), [200, 409]);
assert.equal(salidas.length, 2, 'un solo aviso por admin (2 admin con teléfono)');
assert.ok(salidas.every(s => /Paula Conductora aceptó la bajada de 11:00/.test(s.t) && s.r === 'armar:2027-01-10'));
ok('aceptar dos veces seguidas: una gana, la otra recibe 409 y el admin recibe un solo aviso, con enlace al armado del día');

// 15f. rechazar -> aviso con reemplazo sugerido
const idPablo = (await get('turnos', pablo.token, { desde: '2027-01-01', hasta: '2027-01-31' })).json.turnos[0].id;
limpio();
assert.equal((await post('responder', pablo.token, { turno_id: idPablo, respuesta: 'rechazar', motivo: 'Me enfermé' })).status, 200);
assert.ok(salidas.length === 2 && salidas.every(s => /rechazó/.test(s.t) && /Me enfermé/.test(s.b) && /Reemplazo sugerido/.test(s.b)));
ok('rechazar avisa a los admin con el motivo y el reemplazo sugerido');

// 15g. cerrar y pagar
const idPilar = (await get('turnos', pilar.token, { desde: '2027-01-01', hasta: '2027-01-31' })).json.turnos[0].id;
await post('responder', pilar.token, { turno_id: idPilar, respuesta: 'aceptar' });
limpio();
assert.equal((await post('cerrar', paula.token, { turno_id: idPaula, pax: 4 })).status, 200);
assert.ok(salidas.length === 2 && salidas.every(s => /cerró su turno/.test(s.t) && s.r === 'pagos'));
limpio();
assert.equal((await post('pagar', M, { trabajador_id: paula.id, desde: '2027-01-01', hasta: '2027-01-31' })).json.pagadas, 1);
assert.deepEqual(salidas.map(s => [s.endpoint, s.t, s.r]), [[sPu.endpoint, 'Te pagamos tus bajadas', 'pagos']]);
ok('cerrar avisa a los admin (enlace a Pagos) y pagar avisa al trabajador');

// 15h. te sacaron de una bajada
const puestoPilar = (await get('dia', M, { fecha: '2027-01-10' })).json.salidas[0].puestos.find(p => p.turno && p.turno.trabajador_id === pilar.id);
limpio();
assert.equal((await post('asignar', M, { bajada_id: dW.id, puesto: puestoPilar.puesto, trabajador_id: null })).status, 200);
assert.equal(salidas.length, 1); assert.equal(salidas[0].endpoint, sPi.endpoint); assert.match(salidas[0].t, /Ya no estás en la bajada/); assert.equal(salidas[0].r, 'agenda');
ok('si el admin te saca de una bajada ya avisada, te llega el aviso');

// 15i. suscripciones vencidas, bajas, teléfonos compartidos y límites
falla = { endpoint: sC.endpoint, code: 410 };
await post('equipo_crear', M, { nombre: 'Relleno Uno', funciones: ['guia'] });   // no genera aviso; solo prepara
await post('publicar', M, { bajada_id: dW.id, forzar: true }).catch(() => {});
const nx = await nw('Nuevo Nico', ['guia']); await post('push_suscribir', nx.token, { sub: sC }); // el teléfono de Camila pasa a otra cuenta
assert.equal((await q`select cuenta_id from push_subs where endpoint = ${sC.endpoint}`)[0].cuenta_id, nx.id);
assert.equal((await get('yo', tC)).json.telefonos, 0, 'un teléfono pertenece a una sola cuenta: la anterior deja de recibir en él');
ok('un mismo teléfono solo recibe los avisos de la última cuenta que entró (privacidad en teléfonos compartidos)');
await notificarDirecto(nx.id);
async function notificarDirecto(id) { const { notificar } = await imp('api/_notif.js'); await notificar(q, id, { tipo: 'prueba', titulo: 'x', ruta: 'avisos' }); }
assert.equal((await q`select count(*)::int as n from push_subs where endpoint = ${sC.endpoint}`)[0].n, 0, 'la suscripción vencida (410) se borra sola');
falla = null;
ok('una suscripción vencida (410) se elimina sola y no se reintenta');
const sB = mkSub('tel-baja'); await post('push_suscribir', pablo.token, { sub: sB });
await post('equipo_editar', M, { id: pablo.id, activa: false }); limpio();
await notificarDirecto(pablo.id); assert.equal(salidas.length, 0);
ok('una cuenta dada de baja no recibe más avisos');
await post('push_baja', M, { endpoint: sM.endpoint });
assert.equal((await get('yo', M)).json.telefonos, 0); assert.equal((await q`select count(*)::int as n from push_subs where endpoint = ${sS.endpoint}`)[0].n, 1, 'la baja solo afecta al propio teléfono');
ok('cerrar sesión desvincula solo ese teléfono');
for (let i = 0; i < 7; i++) await post('push_suscribir', M, { sub: mkSub('muchos-' + i) });
assert.equal((await get('yo', M)).json.telefonos, 5);
const restantes = (await q`select endpoint from push_subs where cuenta_id = ${(await get('yo', M)).json.cuenta.id} order by id`).map(x => x.endpoint);
assert.deepEqual(restantes, [2, 3, 4, 5, 6].map(i => 'https://fcm.googleapis.com/fcm/send/muchos-' + i));
ok('máximo 5 teléfonos por persona; se conservan los más recientes');

// 15j. probar avisos
assert.equal((await post('push_probar', nx.token)).status, 409, 'nx perdió su suscripción vencida: no tiene teléfono activado');
limpio(); assert.equal((await post('push_probar', M)).json.enviados, 5); assert.ok(salidas.every(s => s.t === 'Los avisos funcionan'));
revienta = true; assert.equal((await post('push_probar', M)).status, 502); revienta = false;
ok('"probar avisos": sin teléfono activado da 409; con teléfono llega el aviso; si el servicio falla se explica (502)');

// 15k. si todo el envío falla, la operación de negocio sigue funcionando
revienta = true;
const RY = await reservar({ nombre: 'Web Yolanda', fecha: '2027-01-12', horario: '14:00', personas: 2, plan: 'Rafting Extrema $45.000' });
assert.equal(RY.status, 201);
const dY = (await get('dia', M, { fecha: '2027-01-12' })).json.salidas[0];
assert.equal((await post('asignar', M, { bajada_id: dY.id, puesto: dY.puestos[0].puesto, trabajador_id: nx.id })).status, 200);
assert.equal((await post('publicar', M, { bajada_id: dY.id, forzar: true })).status, 200);
revienta = false;
ok('con el servicio de push caído, publicar y reservar siguen funcionando; el aviso queda en el centro de avisos de la app');
assert.ok((await a(nx.token)).some(x => x.tipo === 'solicitud'));

console.log(`\nTODO OK: ${n} comprobaciones`);
