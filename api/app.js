import { db, cors, body, clientIp, sendMail, esc, isAdmin, emailShell, clp, fmtFecha } from './_lib.js';
import { ensureApp, cuentaDe, firmar, hashClave, claveOk, claveTemporal, bloqueado, registrarFallo, limpiarFallos, usuarioLibre, hoyCL } from './_auth.js';
import { materializar, salidasDe, TRAMOS } from './_bajadas.js';
import { tarifa, puestosDe, distribuirFichas, elegirPersonal, choque, resumenPago, balsasNecesarias, FUNCIONES, NOMBRE_FUNCION } from './_auto.js';
import { notificar } from './_notif.js';
import { vapid, suscripcionValida, guardarSuscripcion, borrarSuscripcion, enviarPush } from './_push.js';

// API de la app del personal. Un solo endpoint: GET ?a=<consulta> y POST {accion, ...}. Todo (salvo instalar e iniciar sesión)
// exige la sesión de una cuenta; los admin ven todo lo operacional y cada trabajador solo lo suyo.
class Fallo extends Error { constructor(estado, msg, extra = {}) { super(msg); this.estado = estado; this.extra = extra; } }
const FECHA = /^\d{4}-\d{2}-\d{2}$/, MAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const clip = (v, n) => String(v ?? '').trim().slice(0, n);
const etiquetaPuesto = (puesto, bote) => bote || (puesto.startsWith('kayak:') ? 'Kayak ' + puesto.slice(6) : 'Traslado y fotos');
const fechaCorta = f => fmtFecha(f, 'es').replace(/ de \d{4}$/, '');
const publica = c => ({ id: c.id, tipo: c.tipo, usuario: c.usuario, nombre: c.nombre, correo: c.correo, telefono: c.telefono, es_maestra: c.es_maestra, verificada: c.verificada, funciones: c.funciones });
const rango = (q) => {
  const desde = String(q.desde || hoyCL()), hasta = String(q.hasta || desde);
  if (!FECHA.test(desde) || !FECHA.test(hasta) || hasta < desde || (Date.parse(hasta) - Date.parse(desde)) / 864e5 > 400) throw new Fallo(400, 'fechas inválidas');
  return { desde, hasta };
};
const soloAdmin = yo => { if (yo.tipo !== 'admin') throw new Fallo(403, 'Solo para cuentas de administración.'); };
const soloTrabajador = yo => { if (yo.tipo !== 'trabajador') throw new Fallo(403, 'Solo para cuentas de trabajador.'); };
const funcionesOk = f => Array.isArray(f) && f.length > 0 && f.every(x => FUNCIONES.includes(x));

// Cuántas bajadas lleva cada trabajador (para repartir con equidad).
async function cargas(q) {
  const rows = await q`select trabajador_id, count(*)::int as n from turnos where estado in ('asignado', 'aceptado', 'cerrado', 'pagado') group by trabajador_id`;
  return new Map(rows.map(r => [r.trabajador_id, r.n]));
}
// Turnos de un día. Al armar cuentan también los borradores; al aceptar solo los compromisos reales.
async function turnosDelDia(q, fecha, estados = ['borrador', 'asignado', 'aceptado', 'cerrado', 'pagado']) {
  return q`select t.trabajador_id, t.bajada_id, b.tramo from turnos t join bajadas b on b.id = t.bajada_id where b.fecha = ${fecha} and t.estado = any(${estados}::text[])`;
}
async function bajadaCompleta(q, id) {
  const [b] = await q`select id, fecha::text as fecha, horario, tramo, estado, cupo from bajadas where id = ${id}`;
  if (!b) throw new Fallo(404, 'La salida no existe.');
  b.botes = await q`select id, nombre, clase, capacidad from botes where bajada_id = ${id} order by id`;
  return b;
}

// ---------------------------------------------------------------- acciones públicas
async function instalado({ q }) { const [n] = await q`select count(*)::int as n from cuentas`; return { instalado: n.n > 0 }; }

async function setup({ q, b, req }) {
  const ip = clientIp(req);
  if (await bloqueado('setup', ip)) throw new Fallo(429, 'Demasiados intentos, espera unos minutos.');
  const [n] = await q`select count(*)::int as n from cuentas`;
  if (n.n) throw new Fallo(409, 'El sistema ya está instalado.');
  // Quien instala demuestra ser el dueño con la clave del panel: así nadie puede quedarse con la cuenta maestra.
  if (!(await isAdmin({ headers: { authorization: 'Bearer ' + String(b.clave || '') } }))) {
    await registrarFallo('setup', ip);
    throw new Fallo(403, 'La clave del panel no es correcta.');
  }
  const nombre = clip(b.nombre, 80), correo = clip(b.correo, 160), pw = String(b.password || '');
  if (nombre.length < 2) throw new Fallo(400, 'Falta el nombre.');
  if (!MAIL.test(correo)) throw new Fallo(400, 'El correo no es válido.');
  if (pw.length < 8) throw new Fallo(400, 'La contraseña debe tener al menos 8 caracteres.');
  const usuario = await usuarioLibre(nombre, 'admin');
  const [c] = await q`insert into cuentas (tipo, usuario, nombre, correo, pass_hash, es_maestra, verificada)
    values ('admin', ${usuario}, ${nombre}, ${correo}, ${hashClave(pw)}, true, true) returning *`;
  return { token: await firmar(c), cuenta: publica(c) };
}

async function login({ q, b, req }) {
  const usuario = clip(b.usuario, 60).toLowerCase().replace(/^@/, ''), ip = clientIp(req);
  if (await bloqueado(usuario, ip)) throw new Fallo(429, 'Demasiados intentos, espera unos minutos.');
  const [c] = await q`select * from cuentas where usuario = ${usuario}`;
  if (!c || !c.activa || !claveOk(b.password, c.pass_hash)) {
    await registrarFallo(usuario, ip);
    throw new Fallo(401, 'Usuario o contraseña incorrectos.');
  }
  await limpiarFallos(usuario);
  return { token: await firmar(c), cuenta: publica(c) };
}

// ---------------------------------------------------------------- consultas (GET)
async function rev({ q }) { const [r] = await q`select last_value::int as rev from app_rev`; return r; }

async function yoInfo({ q, yo }) {
  const [a] = await q`select (select count(*)::int from avisos where cuenta_id = ${yo.id} and not leido) as sin_leer,
    (select count(*)::int from push_subs where cuenta_id = ${yo.id}) as telefonos`;
  return { cuenta: publica(yo), avisos: a.sin_leer, telefonos: a.telefonos, hoy: hoyCL(), ...(await rev({ q })) };
}

async function dia({ q, yo, query }) {
  soloAdmin(yo);
  const fecha = String(query.fecha || hoyCL());
  if (!FECHA.test(fecha)) throw new Fallo(400, 'fecha inválida');
  await materializar(fecha, fecha);
  const { salidas, sinSalida } = await salidasDe(fecha, fecha);
  const ids = salidas.map(s => s.id);
  const [turnos, pub, nuevas] = await Promise.all([
    q`select t.id, t.bajada_id, t.puesto, t.funcion, t.estado, t.trabajador_id, t.tarifa, t.motivo_rechazo, c.nombre
      from turnos t join cuentas c on c.id = t.trabajador_id where t.bajada_id = any(${ids}::int[]) order by t.id`,
    q`select b.id, b.publicada_en, c.nombre as publicada_por from bajadas b left join cuentas c on c.id = b.publicada_por where b.id = any(${ids}::int[])`,
    q`select count(*)::int as n from reservas where estado = 'nueva'`
  ]);
  for (const s of salidas) {
    const mios = turnos.filter(t => t.bajada_id === s.id);
    s.puestos = puestosDe(s.botes).map(p => ({ ...p, turno: mios.find(t => t.puesto === p.puesto && t.estado !== 'rechazado') || null }));
    s.rechazos = mios.filter(t => t.estado === 'rechazado');
    s.balsasNecesarias = [...balsasNecesarias(s.botes, new Map(s.botes.map(b => [b.id, b.fichas.length])), s.reservadas)];
    Object.assign(s, pub.find(p => p.id === s.id) || {});
  }
  return {
    fecha, salidas, sinSalida, reservasNuevas: nuevas[0].n,
    resumen: { salidas: salidas.length, pasajeros: salidas.reduce((a, s) => a + s.reservadas, 0), fichas: salidas.reduce((a, s) => a + s.fichas, 0) }
  };
}

async function misTurnos({ q, yo, query }) {
  soloTrabajador(yo);
  const desde = String(query.desde || hoyCL());
  const hasta = String(query.hasta || new Date(Date.parse(desde) + 30 * 864e5).toISOString().slice(0, 10));
  if (!FECHA.test(desde) || !FECHA.test(hasta) || hasta < desde) throw new Fallo(400, 'fechas inválidas');
  const turnos = await q`select t.id, t.puesto, t.funcion, t.estado, t.tarifa, t.pax_finales, t.bajada_id, b.fecha::text as fecha, b.horario, b.tramo,
      b.estado as bajada_estado, bo.nombre as bote
    from turnos t join bajadas b on b.id = t.bajada_id left join botes bo on bo.id = t.bote_id
    where t.trabajador_id = ${yo.id} and t.estado <> 'borrador' and b.fecha between ${desde} and ${hasta}
    order by b.fecha, b.horario`;
  for (const t of turnos) { t.etiqueta = etiquetaPuesto(t.puesto, t.bote); t.tramoEtiqueta = TRAMOS[t.tramo] || null; }
  return { turnos, resumen: resumenPago(turnos), pendientes: turnos.filter(t => t.estado === 'asignado').length };
}

async function turno({ q, yo, query }) {
  const id = parseInt(query.id, 10);
  const [t] = id > 0 ? await q`select t.*, b.fecha::text as fecha, b.horario, b.tramo, b.estado as bajada_estado, bo.nombre as bote, bo.capacidad as bote_cap
      from turnos t join bajadas b on b.id = t.bajada_id left join botes bo on bo.id = t.bote_id where t.id = ${id}` : [];
  if (!t || (yo.tipo !== 'admin' && t.trabajador_id !== yo.id)) throw new Fallo(404, 'El turno no existe.');
  const abierto = yo.tipo === 'admin' || ['aceptado', 'cerrado', 'pagado'].includes(t.estado); // los datos de pasajeros solo tras aceptar
  const equipo = await q`select tt.puesto, tt.funcion, tt.estado, c.nombre, bo.nombre as bote from turnos tt join cuentas c on c.id = tt.trabajador_id
    left join botes bo on bo.id = tt.bote_id where tt.bajada_id = ${t.bajada_id} and tt.estado not in ('borrador', 'rechazado') order by tt.id`;
  const salida = { turno: { ...t, etiqueta: etiquetaPuesto(t.puesto, t.bote), tramoEtiqueta: TRAMOS[t.tramo] || null, funcionNombre: NOMBRE_FUNCION[t.funcion] },
    equipo: equipo.map(e => ({ nombre: e.nombre, funcion: e.funcion, etiqueta: etiquetaPuesto(e.puesto, e.bote), estado: e.estado })) };
  if (!abierto) return salida;
  const fichas = await q`select f.id, f.nombre, f.edad, f.idioma, f.menor, f.sabe_nadar, f.medico, f.emergencia_nombre, f.telefono, f.presente, f.bote_id,
      f.apoderado, f.uso_imagen, bo.nombre as bote,
      -- Visitas = salidas distintas en que aparece el mismo documento (sin importar puntos ni guion); una ficha repetida no suma.
      (select count(distinct coalesce(x.bajada_id, xr.bajada_id, -x.id))::int from fichas x left join reservas xr on xr.id = x.reserva_id
        where regexp_replace(lower(x.documento), '[^0-9a-z]', '', 'g') = regexp_replace(lower(f.documento), '[^0-9a-z]', '', 'g')
          and coalesce(f.documento, '') <> '' and x.id <= f.id) as visitas
    from fichas f left join reservas r on r.id = f.reserva_id left join botes bo on bo.id = f.bote_id
    where coalesce(f.bajada_id, r.bajada_id) = ${t.bajada_id} order by f.id`;
  const cond = f => f.medico && !/^(ninguna?|none|no|n\/a|-)$/i.test(f.medico.trim());
  salida.totalPax = fichas.length;
  if (t.funcion === 'guia') salida.pasajeros = fichas.filter(f => f.bote_id === t.bote_id);
  else if (t.funcion === 'seguridad') {
    const botes = await q`select bo.id, bo.nombre, bo.capacidad, (select c.nombre from turnos tt join cuentas c on c.id = tt.trabajador_id
        where tt.bote_id = bo.id and tt.estado not in ('borrador', 'rechazado') limit 1) as guia from botes bo where bo.bajada_id = ${t.bajada_id} and bo.clase = 'balsa' order by bo.id`;
    salida.botes = botes.map(b => { const ps = fichas.filter(f => f.bote_id === b.id);
      return { ...b, pax: ps.length, medicos: ps.filter(cond).length, menores: ps.filter(f => f.menor).length }; });
  } else salida.manifiesto = fichas.map(f => ({ id: f.id, nombre: f.nombre, bote: f.bote, idioma: f.idioma, medico: cond(f) ? f.medico : null, menor: f.menor, sabe_nadar: f.sabe_nadar }));
  return salida;
}

async function avisosDe({ q, yo }) {
  return { avisos: await q`select id, tipo, titulo, cuerpo, ruta, ref_id, leido, creada from avisos where cuenta_id = ${yo.id} order by id desc limit 50` };
}

async function equipo({ q, yo }) {
  soloAdmin(yo);
  const gente = await q`select c.id, c.tipo, c.usuario, c.nombre, c.correo, c.telefono, c.funciones, c.activa, c.es_maestra, c.verificada,
      (select count(*)::int from turnos t where t.trabajador_id = c.id and t.estado in ('cerrado', 'pagado') and date_trunc('month', t.cerrado_en) = date_trunc('month', now())) as mes,
      (select count(*)::int from turnos t where t.trabajador_id = c.id and t.estado in ('asignado', 'aceptado', 'cerrado', 'pagado')) as carga
    from cuentas c order by c.tipo, c.nombre`;
  return { equipo: gente };
}

async function pagos({ q, yo, query }) {
  soloAdmin(yo);
  const { desde, hasta } = rango(query);
  const rows = await q`select c.id, c.nombre, c.usuario, t.funcion, t.estado, t.tarifa from turnos t join cuentas c on c.id = t.trabajador_id
    join bajadas b on b.id = t.bajada_id where b.fecha between ${desde} and ${hasta} and t.estado in ('asignado', 'aceptado', 'cerrado', 'pagado') order by c.nombre`;
  const por = new Map();
  for (const r of rows) {
    if (!por.has(r.id)) por.set(r.id, { id: r.id, nombre: r.nombre, usuario: r.usuario, guia: 0, seguridad: 0, conductor: 0, porPagar: 0, pagado: 0, estimado: 0 });
    const f = por.get(r.id);
    if (r.estado === 'cerrado') { f[r.funcion]++; f.porPagar += r.tarifa || 0; }
    else if (r.estado === 'pagado') { f[r.funcion]++; f.pagado += r.tarifa || 0; }
    else f.estimado += r.tarifa || 0;
  }
  const filas = [...por.values()];
  return { desde, hasta, filas, total: { porPagar: filas.reduce((a, f) => a + f.porPagar, 0), pagado: filas.reduce((a, f) => a + f.pagado, 0), estimado: filas.reduce((a, f) => a + f.estimado, 0) } };
}

// ---------------------------------------------------------------- acciones (POST)
async function asignar({ q, yo, b }) {
  soloAdmin(yo);
  const bj = await bajadaCompleta(q, parseInt(b.bajada_id, 10));
  if (!['borrador', 'lista', 'publicada'].includes(bj.estado)) throw new Fallo(409, 'Esta salida ya no se puede modificar.');
  const p = puestosDe(bj.botes).find(x => x.puesto === b.puesto);
  if (!p) throw new Fallo(400, 'Ese puesto no existe en la salida.');
  const [actual] = await q`select id, estado, trabajador_id from turnos where bajada_id = ${bj.id} and puesto = ${p.puesto} and estado <> 'rechazado'`;
  if (actual && ['cerrado', 'pagado'].includes(actual.estado)) throw new Fallo(409, 'Ese turno ya fue cerrado.');
  const ops = [];
  if (actual) ops.push(q`delete from turnos where id = ${actual.id}`);
  if (b.trabajador_id != null && b.trabajador_id !== '') {
    const tid = parseInt(b.trabajador_id, 10);
    const [w] = await q`select id, nombre, funciones, activa, tipo from cuentas where id = ${tid}`;
    if (!w || w.tipo !== 'trabajador' || !w.activa) throw new Fallo(404, 'La persona no existe o está dada de baja.');
    if (!w.funciones.includes(p.funcion)) throw new Fallo(409, `${w.nombre} no declaró la función "${NOMBRE_FUNCION[p.funcion]}".`);
    const otro = await q`select puesto from turnos where bajada_id = ${bj.id} and trabajador_id = ${tid} and estado <> 'rechazado' and puesto <> ${p.puesto}`;
    if (otro.length) throw new Fallo(409, `${w.nombre} ya está en otro puesto de esta salida.`);
    const motivo = choque(tid, bj, await turnosDelDia(q, bj.fecha));
    if (motivo) throw new Fallo(409, `${w.nombre}: ${motivo}`);
    ops.push(q`insert into turnos (bajada_id, puesto, bote_id, trabajador_id, funcion) values (${bj.id}, ${p.puesto}, ${p.bote_id}, ${tid}, ${p.funcion})`);
  }
  if (ops.length) await q.transaction(ops);
  // Si la persona reemplazada ya tenía la solicitud, se le avisa que ya no va.
  if (actual && ['asignado', 'aceptado'].includes(actual.estado) && String(actual.trabajador_id) !== String(b.trabajador_id))
    await notificar(q, actual.trabajador_id, { tipo: 'cancelado', titulo: `Ya no estás en la bajada de las ${bj.horario}`, cuerpo: `${fechaCorta(bj.fecha)} · el administrador cambió el equipo.`, ruta: 'agenda', ref: bj.id });
  return { ok: true };
}

async function autodistribuir({ q, yo, b }) {
  soloAdmin(yo);
  const bj = await bajadaCompleta(q, parseInt(b.bajada_id, 10));
  if (!['borrador', 'lista', 'publicada'].includes(bj.estado)) throw new Fallo(409, 'Esta salida ya no se puede modificar.');
  const fichas = await q`select f.id, f.reserva_id, f.idioma, f.idioma_ficha, f.medico from fichas f left join reservas r on r.id = f.reserva_id
    where coalesce(f.bajada_id, r.bajada_id) = ${bj.id} order by f.id`;
  const { asignacion, sobran } = distribuirFichas(bj.botes.filter(x => x.clase === 'balsa'), fichas);
  const porBote = new Map();
  for (const [fid, bid] of Object.entries(asignacion)) { if (!porBote.has(bid)) porBote.set(bid, []); porBote.get(bid).push(+fid); }
  const ops = [q`update fichas set bote_id = null where id = any(${fichas.map(f => f.id)}::int[])`];
  for (const [bid, ids] of porBote) ops.push(q`update fichas set bote_id = ${bid} where id = any(${ids}::int[])`);
  await q.transaction(ops);

  // Personal: solo se llenan los puestos vacíos; lo ya enviado o aceptado no se toca.
  const puestos = puestosDe(bj.botes);
  const vigentes = await q`select puesto, trabajador_id from turnos where bajada_id = ${bj.id} and estado <> 'rechazado'`;
  const llenos = new Set(vigentes.map(t => t.puesto));
  // Solo las balsas con pasajeros (o necesarias para sentar a los reservados) piden guía.
  const [res] = await q`select coalesce(sum(personas), 0)::int as n from reservas where bajada_id = ${bj.id} and estado <> 'cancelada'`;
  const nec = balsasNecesarias(bj.botes.filter(x => x.clase === 'balsa'), new Map([...porBote].map(([id, ids]) => [id, ids.length])), res.n);
  const vacios = puestos.filter(p => !llenos.has(p.puesto) && (p.funcion !== 'guia' || nec.has(p.bote_id)));
  const carga = await cargas(q), delDia = await turnosDelDia(q, bj.fecha);
  const gente = (await q`select id, nombre, funciones from cuentas where tipo = 'trabajador' and activa`)
    .map(g => ({ ...g, carga: carga.get(g.id) || 0 }));
  const ocupados = new Set([...vigentes.map(t => t.trabajador_id), ...gente.filter(g => choque(g.id, bj, delDia)).map(g => g.id)]);
  const elegido = elegirPersonal(vacios, gente, ocupados);
  const ins = vacios.filter(p => elegido[p.puesto]).map(p =>
    q`insert into turnos (bajada_id, puesto, bote_id, trabajador_id, funcion) values (${bj.id}, ${p.puesto}, ${p.bote_id}, ${elegido[p.puesto]}, ${p.funcion})`);
  if (ins.length) await q.transaction(ins);
  return { ok: true, distribuidos: Object.keys(asignacion).length, sobran: sobran.length, asignados: ins.length, sinPersonal: vacios.filter(p => !elegido[p.puesto]).map(p => etiquetaPuesto(p.puesto, bj.botes.find(x => x.id === p.bote_id)?.nombre)) };
}

async function publicar({ q, yo, b }) {
  soloAdmin(yo);
  if (!yo.verificada) throw new Fallo(403, 'Tu cuenta admin no está verificada: no puedes publicar bajadas.');
  const bj = await bajadaCompleta(q, parseInt(b.bajada_id, 10));
  if (!['borrador', 'lista', 'publicada'].includes(bj.estado)) throw new Fallo(409, 'Esta salida no se puede publicar.');
  const turnos = await q`select id, puesto, funcion, estado from turnos where bajada_id = ${bj.id} and estado <> 'rechazado'`;
  const puestos = puestosDe(bj.botes);
  const falta = p => !turnos.some(t => t.puesto === p.puesto);
  // Guía obligatorio solo en las balsas que salen (con pasajeros, o las mínimas para sentar a los reservados).
  const [res] = await q`select coalesce(sum(personas), 0)::int as n from reservas where bajada_id = ${bj.id} and estado <> 'cancelada'`;
  const ocup = await q`select bote_id, count(*)::int as n from fichas where bote_id = any(${bj.botes.map(x => x.id)}::int[]) group by bote_id`;
  const nec = balsasNecesarias(bj.botes.filter(x => x.clase === 'balsa'), new Map(ocup.map(o => [o.bote_id, o.n])), res.n);
  const sinGuia = puestos.filter(p => p.funcion === 'guia' && nec.has(p.bote_id) && falta(p)).map(p => p.etiqueta);
  if (sinGuia.length) throw new Fallo(409, `Falta guía en: ${sinGuia.join(', ')}.`, { bloqueo: true });
  const pendientes = turnos.filter(t => t.estado === 'borrador');
  if (!pendientes.length) throw new Fallo(409, 'No hay solicitudes nuevas por enviar.', { bloqueo: true });
  // Lo que no impide publicar pero conviene revisar: se pide confirmación (forzar).
  const avisos = [];
  const [sb] = await q`select count(*)::int as n from fichas f left join reservas r on r.id = f.reserva_id where coalesce(f.bajada_id, r.bajada_id) = ${bj.id} and f.bote_id is null`;
  if (sb.n) avisos.push(`${sb.n} ${sb.n === 1 ? 'pasajero sin balsa' : 'pasajeros sin balsa'}.`);
  const sinKayak = puestos.filter(p => p.funcion === 'seguridad' && falta(p)).length;
  if (sinKayak) avisos.push(`${sinKayak === 1 ? 'Falta 1 kayak de seguridad' : `Faltan ${sinKayak} kayaks de seguridad`}.`);
  if (puestos.some(p => p.funcion === 'conductor' && falta(p))) avisos.push('Falta conductor / fotógrafo.');
  if (avisos.length && !b.forzar) throw new Fallo(409, 'Hay cosas por revisar antes de avisar al equipo.', { avisos, requiereConfirmar: true });

  // Se "reclaman" los borradores en una sola sentencia: si el admin toca el botón dos veces, solo una de las dos
  // publicaciones recibe filas de vuelta y el equipo no recibe la solicitud repetida.
  const g = tarifa('guia', bj.tramo), s = tarifa('seguridad', bj.tramo), c = tarifa('conductor', bj.tramo);
  const [reclamados] = await q.transaction([
    q`update turnos set estado = 'asignado', tarifa = case funcion when 'guia' then ${g}::int when 'seguridad' then ${s}::int else ${c}::int end
      where bajada_id = ${bj.id} and estado = 'borrador' returning id, trabajador_id, funcion, puesto, tarifa`,
    q`update bajadas set estado = 'publicada', publicada_por = ${yo.id}, publicada_en = coalesce(publicada_en, now()) where id = ${bj.id}`
  ]);
  await Promise.all(reclamados.map(t => {
    const p = puestos.find(x => x.puesto === t.puesto);
    return notificar(q, t.trabajador_id, {
      tipo: 'solicitud', titulo: `Nueva bajada · ${bj.horario}`, ruta: 'turno:' + t.id, ref: t.id,
      cuerpo: `${fechaCorta(bj.fecha)} · ${NOMBRE_FUNCION[t.funcion]} (${p ? p.etiqueta : ''}) · ${TRAMOS[bj.tramo] || 'tramo por confirmar'} · ${clp(t.tarifa)}`
    });
  }));
  return { ok: true, enviados: reclamados.length };
}

async function responder({ q, yo, b }) {
  soloTrabajador(yo);
  const id = parseInt(b.turno_id, 10);
  const [t] = id > 0 ? await q`select t.*, bj.fecha::text as fecha, bj.horario, bj.tramo from turnos t join bajadas bj on bj.id = t.bajada_id where t.id = ${id} and t.trabajador_id = ${yo.id}` : [];
  if (!t) throw new Fallo(404, 'El turno no existe.');
  if (t.estado !== 'asignado') throw new Fallo(409, 'Este turno ya fue respondido.');
  const quien = yo.nombre, cuando = `${fechaCorta(t.fecha)} ${t.horario}`;
  if (b.respuesta === 'aceptar') {
    const motivo = choque(yo.id, { id: t.bajada_id, tramo: t.tramo }, await turnosDelDia(q, t.fecha, ['aceptado', 'cerrado', 'pagado']));
    if (motivo) throw new Fallo(409, motivo);
    // Condicional: si la persona toca "Aceptar" dos veces, solo la primera cambia el estado y avisa al admin.
    const ganado = await q`update turnos set estado = 'aceptado', respondido_en = now() where id = ${id} and estado = 'asignado' returning id`;
    if (!ganado.length) throw new Fallo(409, 'Este turno ya fue respondido.');
    await notificar(q, 'admins', { tipo: 'aceptado', titulo: `${quien} aceptó la bajada de ${t.horario}`, cuerpo: `${NOMBRE_FUNCION[t.funcion]} · ${cuando}`, ruta: 'armar:' + t.fecha, ref: t.bajada_id });
    return { ok: true, estado: 'aceptado' };
  }
  if (b.respuesta !== 'rechazar') throw new Fallo(400, 'Respuesta inválida.');
  const mot = clip(b.motivo, 300) || null;
  const ganado = await q`update turnos set estado = 'rechazado', respondido_en = now(), motivo_rechazo = ${mot} where id = ${id} and estado = 'asignado' returning id`;
  if (!ganado.length) throw new Fallo(409, 'Este turno ya fue respondido.');
  // Reemplazo sugerido: quienes declaran la función, sin choque y con menos bajadas.
  const carga = await cargas(q), delDia = await turnosDelDia(q, t.fecha);
  const dentro = new Set((await q`select trabajador_id from turnos where bajada_id = ${t.bajada_id} and estado <> 'rechazado'`).map(x => x.trabajador_id));
  const libres = (await q`select id, nombre, funciones from cuentas where tipo = 'trabajador' and activa`)
    .filter(g => g.funciones.includes(t.funcion) && g.id !== yo.id && !dentro.has(g.id) && !choque(g.id, { id: t.bajada_id, tramo: t.tramo }, delDia))
    .sort((x, y) => (carga.get(x.id) || 0) - (carga.get(y.id) || 0)).slice(0, 3);
  await notificar(q, 'admins', {
    tipo: 'rechazado', titulo: `${quien} rechazó la bajada de ${t.horario}`, ruta: 'armar:' + t.fecha, ref: t.bajada_id,
    cuerpo: `${NOMBRE_FUNCION[t.funcion]} · ${cuando}${mot ? ` · “${mot}”` : ''}. Reemplazo sugerido: ${libres.map(g => `${g.nombre.split(' ')[0]} (${carga.get(g.id) || 0})`).join(', ') || 'nadie disponible'}.`
  });
  return { ok: true, estado: 'rechazado' };
}

async function checkin({ q, yo, b }) {
  soloTrabajador(yo);
  const fid = parseInt(b.ficha_id, 10);
  const [f] = fid > 0 ? await q`select f.id from fichas f join turnos t on t.bote_id = f.bote_id
    where f.id = ${fid} and t.trabajador_id = ${yo.id} and t.funcion = 'guia' and t.estado = 'aceptado'` : [];
  if (!f) throw new Fallo(404, 'Ese pasajero no está en tu balsa.');
  await q`update fichas set presente = ${b.presente === true} where id = ${fid}`;
  return { ok: true };
}

async function cerrar({ q, yo, b }) {
  soloTrabajador(yo);
  const id = parseInt(b.turno_id, 10);
  const [t] = id > 0 ? await q`select t.*, bj.horario, bj.fecha::text as fecha from turnos t join bajadas bj on bj.id = t.bajada_id where t.id = ${id} and t.trabajador_id = ${yo.id}` : [];
  if (!t) throw new Fallo(404, 'El turno no existe.');
  if (t.estado !== 'aceptado') throw new Fallo(409, t.estado === 'cerrado' || t.estado === 'pagado' ? 'Este turno ya está cerrado.' : 'Primero acepta el turno.');
  const pax = parseInt(b.pax, 10);
  if (!(pax >= 0 && pax <= 60)) throw new Fallo(400, 'Indica cuántos bajaron (0 a 60).');
  const inc = clip(b.incidentes, 1000) || null;
  const ganado = await q`update turnos set estado = 'cerrado', cerrado_en = now(), pax_finales = ${pax}, incidentes = ${inc} where id = ${id} and estado = 'aceptado' returning id`;
  if (!ganado.length) throw new Fallo(409, 'Este turno ya está cerrado.');
  const [aun] = await q`select count(*)::int as n from turnos where bajada_id = ${t.bajada_id} and estado in ('asignado', 'aceptado')`;
  if (!aun.n) await q`update bajadas set estado = 'cerrada' where id = ${t.bajada_id} and estado = 'publicada'`;
  await notificar(q, 'admins', {
    tipo: 'cierre', titulo: `${yo.nombre} cerró su turno de las ${t.horario}`, ruta: 'pagos', ref: t.bajada_id,
    cuerpo: `${NOMBRE_FUNCION[t.funcion]} · ${pax} ${pax === 1 ? 'pasajero' : 'pasajeros'}${inc ? ' · con incidentes' : ''}`
  });
  return { ok: true };
}

async function leido({ q, yo, b }) {
  if (b.todos) await q`update avisos set leido = true where cuenta_id = ${yo.id} and not leido`;
  else await q`update avisos set leido = true where id = ${parseInt(b.id, 10) || 0} and cuenta_id = ${yo.id}`;
  return { ok: true };
}

async function equipoCrear({ q, yo, b, req }) {
  soloAdmin(yo);
  const tipo = b.tipo === 'admin' ? 'admin' : 'trabajador';
  if (tipo === 'admin' && !yo.es_maestra) throw new Fallo(403, 'Solo la cuenta maestra puede crear cuentas de administración.');
  const nombre = clip(b.nombre, 80), correo = clip(b.correo, 160), tel = clip(b.telefono, 40);
  if (nombre.length < 2) throw new Fallo(400, 'Falta el nombre.');
  if (correo && !MAIL.test(correo)) throw new Fallo(400, 'El correo no es válido.');
  if (tipo === 'trabajador' && !funcionesOk(b.funciones)) throw new Fallo(400, 'Elige al menos una función.');
  const usuario = await usuarioLibre(nombre, tipo), clave = claveTemporal();
  const [c] = await q`insert into cuentas (tipo, usuario, nombre, correo, telefono, pass_hash, funciones, verificada)
    values (${tipo}, ${usuario}, ${nombre}, ${correo || null}, ${tel || null}, ${hashClave(clave)}, ${tipo === 'trabajador' ? b.funciones : []}::text[], false) returning id`;
  const base = process.env.PUBLIC_BASE_URL || `https://${req.headers.host}`;
  const correoEnviado = correo ? await sendMail({ to: correo, replyTo: process.env.ADMIN_EMAIL || 'maiporiveradventure@gmail.com',
    subject: 'Tu acceso a la app de Maipo River Adventure',
    html: emailShell(`<h2 style="margin:8px 0">Hola ${esc(nombre.split(' ')[0])}, ya tienes acceso</h2>
      <p>Entra desde tu celular y agrégala a la pantalla de inicio:</p>
      <p style="margin:16px 0"><a href="${base}/app" style="background:#5980a6;color:#fff;text-decoration:none;padding:12px 18px;display:inline-block;font-weight:700">Abrir la app</a></p>
      <p>Usuario: <b>${esc(usuario)}</b><br>Contraseña temporal: <b>${esc(clave)}</b></p>
      <p style="font-size:13px;color:#5b6167">Cámbiala en tu perfil la primera vez que entres.</p>`) }) : false;
  return { ok: true, id: c.id, usuario, clave, correoEnviado };
}

async function equipoEditar({ q, yo, b }) {
  soloAdmin(yo);
  const id = parseInt(b.id, 10);
  const [c] = id > 0 ? await q`select * from cuentas where id = ${id}` : [];
  if (!c) throw new Fallo(404, 'La cuenta no existe.');
  let clave = null;
  if ('funciones' in b) {
    if (c.tipo !== 'trabajador' || !funcionesOk(b.funciones)) throw new Fallo(400, 'Funciones inválidas.');
    await q`update cuentas set funciones = ${b.funciones}::text[] where id = ${id}`;
  }
  if ('activa' in b) {
    if (c.es_maestra) throw new Fallo(409, 'La cuenta maestra no se puede dar de baja.');
    await q`update cuentas set activa = ${b.activa === true} where id = ${id}`;
  }
  if ('verificada' in b) {
    if (!yo.es_maestra) throw new Fallo(403, 'Solo la cuenta maestra verifica accesos de administración.');
    if (c.tipo !== 'admin') throw new Fallo(400, 'Solo las cuentas admin se verifican.');
    await q`update cuentas set verificada = ${b.verificada === true}, verificada_por = ${b.verificada === true ? yo.id : null} where id = ${id}`;
  }
  if (b.reset_clave) { clave = claveTemporal(); await q`update cuentas set pass_hash = ${hashClave(clave)} where id = ${id}`; }
  return { ok: true, clave };
}

async function perfil({ q, yo, b }) {
  const sets = {};
  if ('telefono' in b) sets.telefono = clip(b.telefono, 40) || null;
  if ('correo' in b) { const c = clip(b.correo, 160); if (c && !MAIL.test(c)) throw new Fallo(400, 'El correo no es válido.'); sets.correo = c || null; }
  if ('funciones' in b) { if (yo.tipo !== 'trabajador' || !funcionesOk(b.funciones)) throw new Fallo(400, 'Elige al menos una función.'); sets.funciones = b.funciones; }
  if ('telefono' in sets) await q`update cuentas set telefono = ${sets.telefono} where id = ${yo.id}`;
  if ('correo' in sets) await q`update cuentas set correo = ${sets.correo} where id = ${yo.id}`;
  if ('funciones' in sets) await q`update cuentas set funciones = ${sets.funciones}::text[] where id = ${yo.id}`;
  let token = null;
  if (b.password) {
    if (String(b.password).length < 8) throw new Fallo(400, 'La contraseña debe tener al menos 8 caracteres.');
    const [c] = await q`update cuentas set pass_hash = ${hashClave(String(b.password))} where id = ${yo.id} returning *`;
    token = await firmar(c); // la sesión anterior deja de valer; esta continúa
  }
  const [c] = await q`select * from cuentas where id = ${yo.id}`;
  return { ok: true, cuenta: publica(c), token };
}

async function pagar({ q, yo, b }) {
  soloAdmin(yo);
  const { desde, hasta } = rango(b);
  const tid = parseInt(b.trabajador_id, 10);
  const rows = await q`update turnos set estado = 'pagado', pagado_en = now() where trabajador_id = ${tid} and estado = 'cerrado'
    and bajada_id in (select id from bajadas where fecha between ${desde} and ${hasta}) returning tarifa`;
  if (rows.length) await notificar(q, tid, { tipo: 'pago', titulo: 'Te pagamos tus bajadas', ruta: 'pagos', cuerpo: `${rows.length} ${rows.length === 1 ? 'bajada' : 'bajadas'} · ${clp(rows.reduce((a, r) => a + (r.tarifa || 0), 0))}` });
  return { ok: true, pagadas: rows.length };
}

// ---- Avisos al celular (Web Push)
async function pushClave({ q }) { return { clave: (await vapid(q)).publicKey }; }

async function pushSuscribir({ q, yo, b, req }) {
  if (!suscripcionValida(b.sub)) throw new Fallo(400, 'Este navegador no entregó una suscripción de avisos válida.');
  await guardarSuscripcion(q, yo.id, b.sub, req.headers['user-agent']);
  return { ok: true };
}
// Al cerrar sesión el teléfono se desvincula: así el siguiente que use ese celular no recibe los avisos de otra persona.
async function pushBaja({ q, yo, b }) { await borrarSuscripcion(q, yo.id, b.endpoint); return { ok: true }; }

async function pushProbar({ q, yo }) {
  const [n] = await q`select count(*)::int as n from push_subs where cuenta_id = ${yo.id}`;
  if (!n.n) throw new Fallo(409, 'Este teléfono aún no tiene los avisos activados.');
  const r = await enviarPush(q, [yo.id], { t: 'Los avisos funcionan', b: 'Así te va a llegar cada aviso de Maipo River.', r: 'avisos', g: 'prueba' });
  if (!r.enviados) throw new Fallo(502, 'No se pudo enviar el aviso de prueba. Desactiva y vuelve a activar los avisos.');
  return { ok: true, enviados: r.enviados };
}

const GET = { instalado, rev, yo: yoInfo, dia, turnos: misTurnos, turno, avisos: avisosDe, equipo, pagos, push_clave: pushClave };
const POST = { setup, login, asignar, autodistribuir, publicar, responder, checkin, cerrar, leido, equipo_crear: equipoCrear, equipo_editar: equipoEditar, perfil, pagar, push_suscribir: pushSuscribir, push_baja: pushBaja, push_probar: pushProbar };
const PUBLICAS = new Set(['instalado', 'setup', 'login']);

export default async function handler(req, res) {
  if (cors(req, res)) return;
  try {
    await ensureApp();
    const q = db();
    const esGet = req.method === 'GET';
    if (!esGet && req.method !== 'POST') return res.status(405).json({ error: 'método no permitido' });
    const b = esGet ? {} : await body(req);
    const accion = String(esGet ? req.query.a : b.accion || '');
    const fn = (esGet ? GET : POST)[accion];
    if (!fn) return res.status(400).json({ error: 'acción desconocida' });
    const yo = PUBLICAS.has(accion) ? null : await cuentaDe(req);
    if (!PUBLICAS.has(accion) && !yo) return res.status(401).json({ error: 'sesión no válida' });
    return res.status(200).json(await fn({ q, yo, b, query: req.query || {}, req }));
  } catch (e) {
    if (e instanceof Fallo) return res.status(e.estado).json({ error: e.message, ...e.extra });
    if (e && e.code === '23505') return res.status(409).json({ error: 'Ya existe un registro igual.' });
    console.error('app error', e);
    return res.status(500).json({ error: 'error interno' });
  }
}
