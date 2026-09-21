import { db, fmtFecha } from './_lib.js';
import { enviarPush } from './_push.js';

// 'lunes, 21 de septiembre' en vez de '2026-09-21'
const dia = f => fmtFecha(f, 'es').replace(/ de \d{4}$/, '');

// Un aviso = una fila en el centro de avisos de la app + un push al celular. `ruta` dice a qué pantalla lleva al tocarlo:
//   turno:<id> · armar:<AAAA-MM-DD> · reservas · pagos · agenda · avisos
const corta = (s, n) => { const t = String(s ?? ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const conLimite = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r('limite'), ms))]);

// destino: 'admins' o un id / lista de ids de cuenta. Nunca lanza.
export async function notificar(q, destino, { tipo, titulo, cuerpo = null, ruta = null, ref = null }) {
  try {
    const ids = destino === 'admins' ? (await q`select id from cuentas where tipo = 'admin' and activa`).map(r => r.id) : [].concat(destino);
    if (!ids.length) return;
    await q`insert into avisos (cuenta_id, tipo, titulo, cuerpo, ruta, ref_id) select id, ${tipo}::text, ${titulo}::text, ${cuerpo}::text, ${ruta}::text, ${ref}::int from unnest(${ids}::int[]) as id`;
    // El push tiene un límite de tiempo: si el servicio del navegador tarda, la operación no espera más.
    const r = await conLimite(enviarPush(q, ids, { t: corta(titulo, 80), b: corta(cuerpo, 180), r: ruta, g: tipo + ':' + (ref ?? '') }), 3500);
    if (r === 'limite') console.error('push: tardó demasiado');
  } catch (e) {
    if (e && e.code === '42P01') return; // la app del equipo aún no está instalada: no hay a quién avisar
    console.error('notificar', e && e.message);
  }
}

// ---- Avisos que nacen en la web pública (reserva y ficha). Se llaman con import() dinámico y sin await propio: si algo
// falla (por ejemplo la app aún no está instalada) la reserva o la ficha del cliente no se enteran.
const MAX_AVISOS_RESERVA = 10; // por admin cada 10 minutos
export async function reservaNueva({ nombre, personas, fecha, horario, plan }) {
  // El formulario público es anónimo: si alguien lo inunda, se deja de avisar (las reservas igual quedan en la lista)
  // para no dejar inservibles los avisos reales ni llenar la base.
  const [r] = await db()`select count(*)::int as n from avisos where tipo = 'reserva' and creada > now() - interval '10 minutes'
    and cuenta_id = (select min(id) from cuentas where tipo = 'admin' and activa)`;
  if (r && r.n >= MAX_AVISOS_RESERVA) return;
  await notificar(db(), 'admins', {
    tipo: 'reserva', titulo: 'Nueva reserva de la web', ruta: 'reservas',
    cuerpo: `${nombre} · ${personas} ${personas === 1 ? 'persona' : 'personas'} · ${dia(fecha)} ${horario} · ${plan}`
  });
}
export async function fichasCompletas({ titular, total, personas, fecha, horario }) {
  await notificar(db(), 'admins', {
    tipo: 'fichas', titulo: `Fichas completas: ${titular}`, ruta: 'armar:' + String(fecha).slice(0, 10),
    cuerpo: `Ya llenaron su ficha ${total} de ${personas} · ${dia(fecha)} ${horario}`
  });
}
