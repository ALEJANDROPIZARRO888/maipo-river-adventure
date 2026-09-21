import { db, ensureSchema } from './_lib.js';

// Una "bajada" es una salida concreta (fecha + horario). Agrupa las reservas y fichas que van en ella.
export const CAPACIDAD_SALIDA = 14; // igual que la planilla de cupos
export const BALSAS_BASE = [8, 6];  // reparto inicial de las 14 plazas; el admin lo puede cambiar
export const HORARIOS = ['11:00', '14:00', '17:00'];
export const TRAMOS = {
  san_alfonso_melocoton: 'San Alfonso — Melocotón',
  melocoton_san_jose: 'Melocotón — San José',
  seccion_completa: 'Sección completa'
};
// 'publicada' y 'cerrada' llegan con los turnos del personal; por ahora el panel solo maneja estos.
export const ESTADOS_EDITABLES = ['borrador', 'lista', 'suspendida'];

let _listo;
// Crea las tablas de bajadas. Aparte de ensureSchema() para que la reserva pública no pague estas consultas.
export function ensureBajadas() {
  return (_listo ||= (async () => {
    await ensureSchema();
    const q = db();
    await q.transaction([
      q`create table if not exists bajadas (
        id serial primary key,
        creada timestamptz not null default now(),
        fecha date not null,
        horario text not null,
        tramo text,
        estado text not null default 'borrador',
        cupo int not null default 14,
        caudal_m3s numeric,
        unique (fecha, horario)
      )`,
      q`create table if not exists botes (
        id serial primary key,
        bajada_id int not null references bajadas(id) on delete cascade,
        nombre text not null,
        clase text not null default 'balsa',
        capacidad int not null
      )`,
      q`alter table reservas add column if not exists bajada_id int references bajadas(id)`,
      q`alter table fichas add column if not exists bajada_id int references bajadas(id)`,
      q`alter table fichas add column if not exists bote_id int references botes(id) on delete set null`,
      // La sección completa sale solo a las 11:00 y ocupa la jornada: se exige en la base, no solo en el panel.
      // Solo vale para salidas con tramo asignado. Una salida sin tramo puede existir aunque choque: es una reserva
      // que un cliente ya hizo en la web, y el panel la muestra como alerta para que el admin la resuelva.
      q`create or replace function bajada_regla_dia() returns trigger as $$
        begin
          if new.tramo is null then
            return new;
          end if;
          if new.tramo = 'seccion_completa' then
            if new.horario <> '11:00' then
              raise exception 'La sección completa sale solo a las 11:00' using errcode = 'MR001';
            end if;
            if exists (select 1 from bajadas where fecha = new.fecha and id <> new.id and tramo is not null) then
              raise exception 'Ese día ya hay otra salida con tramo asignado: la sección completa ocupa la jornada. Quítale el tramo a la otra salida o mueve sus reservas.' using errcode = 'MR001';
            end if;
          elsif exists (select 1 from bajadas where fecha = new.fecha and id <> new.id and tramo = 'seccion_completa') then
            raise exception 'Ese día es de sección completa: ocupa la jornada, no puede haber otra salida con tramo.' using errcode = 'MR001';
          end if;
          return new;
        end $$ language plpgsql`,
      q`drop trigger if exists bajada_regla_dia on bajadas`,
      q`create trigger bajada_regla_dia before insert or update of fecha, horario, tramo on bajadas
        for each row execute function bajada_regla_dia()`
    ]);
  })().catch(e => { _listo = undefined; throw e; }));
}

// 'San Alfonso — Melocotón' | 'Rafting Full' -> 'san_alfonso_melocoton' | 'seccion_completa' ... ; kayak y textos libres -> null.
export function tramoClave(t = '') {
  const s = String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (/completa|full/.test(s)) return 'seccion_completa';
  if (/san alfonso|extrema/.test(s)) return 'san_alfonso_melocoton';
  if (/san jose|power/.test(s)) return 'melocoton_san_jose';
  return null;
}

const claveDe = r => tramoClave(r.tramo) || tramoClave(r.plan);

// Las clases de kayak entran como reservas, pero no son bajadas de rafting.
export const esKayak = r => !claveDe(r) && /kayak/i.test(`${r.tramo} ${r.plan}`);

// Formato de salida que llevan los QR de la base: '2026-10-18-1100' (o con espacio/':'). Otro texto -> null.
export function salidaDeTexto(t = '') {
  const m = String(t).trim().match(/^(\d{4}-\d{2}-\d{2})[\sT_-]*(\d{2}):?(\d{2})$/);
  return m && HORARIOS.includes(`${m[2]}:${m[3]}`) ? { fecha: m[1], horario: `${m[2]}:${m[3]}` } : null;
}

// Si todas las reservas activas de la salida son del mismo tramo, lo deja fijado. Si choca con la regla del día, lo ignora.
async function tramoAuto(id) {
  const q = db();
  const [b] = await q`select tramo from bajadas where id = ${id}`;
  if (!b || b.tramo) return;
  const rs = await q`select tramo, plan from reservas where bajada_id = ${id} and estado <> 'cancelada'`;
  const claves = new Set(rs.map(claveDe).filter(Boolean));
  if (claves.size !== 1) return;
  try { await q`update bajadas set tramo = ${[...claves][0]} where id = ${id} and tramo is null`; }
  catch (e) { if (e.code !== 'MR001') throw e; }
}

// Crea la salida de cada fecha+horario con reservas de rafting activas (o fichas de QR con salida legible) y las enlaza.
// Es idempotente: se puede llamar cada vez que el panel abre un día.
export async function materializar(desde, hasta) {
  const q = db();
  const rs = await q`select id, fecha::text as fecha, horario, tramo, plan from reservas
    where estado <> 'cancelada' and bajada_id is null and fecha between ${desde} and ${hasta}`;
  const fl = await q`select id, salida from fichas where reserva_id is null and bajada_id is null and salida is not null`;
  const slots = new Map();
  const slot = (fecha, horario) => {
    const k = fecha + ' ' + horario;
    if (!slots.has(k)) slots.set(k, { fecha, horario, reservas: [], fichas: [] });
    return slots.get(k);
  };
  for (const r of rs) if (!esKayak(r)) slot(r.fecha, r.horario).reservas.push(r.id);
  for (const f of fl) {
    const s = salidaDeTexto(f.salida);
    if (s && s.fecha >= desde && s.fecha <= hasta) slot(s.fecha, s.horario).fichas.push(f.id);
  }
  for (const s of slots.values()) {
    // Salida y balsas iniciales en una sola sentencia: no queda una salida sin balsas si algo falla a medias.
    await q`with b as (
        insert into bajadas (fecha, horario, cupo) values (${s.fecha}, ${s.horario}, ${CAPACIDAD_SALIDA})
        on conflict (fecha, horario) do nothing returning id)
      insert into botes (bajada_id, nombre, clase, capacidad)
      select b.id, x.nombre, 'balsa', x.cap from b,
        unnest(${BALSAS_BASE.map((_, i) => 'Balsa ' + (i + 1))}::text[], ${BALSAS_BASE}::int[]) as x(nombre, cap)`;
    const [b] = await q`select id from bajadas where fecha = ${s.fecha} and horario = ${s.horario}`;
    if (s.reservas.length) await q`update reservas set bajada_id = ${b.id} where id = any(${s.reservas}::int[])`;
    if (s.fichas.length) await q`update fichas set bajada_id = ${b.id} where id = any(${s.fichas}::int[])`;
    await tramoAuto(b.id);
  }
}

// Las salidas del rango con sus reservas, balsas y fichas, más las fichas libres que aún no tienen salida.
export async function salidasDe(desde, hasta) {
  const q = db();
  const bs = await q`select id, fecha::text as fecha, horario, tramo, estado, cupo, caudal_m3s from bajadas
    where fecha between ${desde} and ${hasta} order by fecha, horario`;
  const ids = bs.map(b => b.id);
  const [rs, bots, fs, libres] = await Promise.all([
    q`select r.id, r.bajada_id, r.nombre, r.telefono, r.personas, r.plan, r.tramo, r.estado,
             (select count(*)::int from fichas f where f.reserva_id = r.id) as fichas
      from reservas r where r.bajada_id = any(${ids}::int[]) order by r.id`,
    q`select id, bajada_id, nombre, clase, capacidad from botes where bajada_id = any(${ids}::int[]) order by id`,
    q`select f.id, f.nombre, f.edad, f.idioma, f.menor, f.sabe_nadar, f.medico, f.reserva_id, f.bote_id,
             coalesce(f.bajada_id, r.bajada_id) as bajada_id
      from fichas f left join reservas r on r.id = f.reserva_id
      where coalesce(f.bajada_id, r.bajada_id) = any(${ids}::int[]) order by f.id`,
    q`select id, nombre, edad, salida, creada from fichas
      where reserva_id is null and bajada_id is null order by id desc limit 100`
  ]);

  const salidas = bs.map(b => {
    const reservas = rs.filter(r => r.bajada_id === b.id);
    const activas = reservas.filter(r => r.estado !== 'cancelada');
    const fichas = fs.filter(f => f.bajada_id === b.id);
    const botes = bots.filter(x => x.bajada_id === b.id).map(x => ({ ...x, fichas: fichas.filter(f => f.bote_id === x.id) }));
    // Personas por tramo: una misma salida puede vender tramos distintos (la logística la resuelve el admin).
    const porTramo = {};
    for (const r of activas) { const k = claveDe(r); if (k) porTramo[k] = (porTramo[k] || 0) + r.personas; }
    return {
      id: b.id, fecha: b.fecha, horario: b.horario, tramo: b.tramo, tramoEtiqueta: TRAMOS[b.tramo] || null,
      estado: b.estado, cupo: b.cupo, caudal_m3s: b.caudal_m3s,
      reservadas: activas.reduce((a, r) => a + r.personas, 0), fichas: fichas.length, porTramo,
      reservas, botes, sinBote: fichas.filter(f => !f.bote_id), alertas: []
    };
  });

  // Alertas: cosas que el admin debe resolver antes de armar la salida.
  for (const s of salidas) {
    if (s.reservadas > s.cupo) s.alertas.push('sobrecupo');
    const delDia = salidas.filter(x => x.fecha === s.fecha);
    const full = delDia.some(x => x.reservas.some(r => r.estado !== 'cancelada' && claveDe(r) === 'seccion_completa'));
    if (full && (delDia.length > 1 || s.horario !== '11:00')) s.alertas.push('choque_seccion_completa');
  }
  return { salidas, sinSalida: libres };
}
