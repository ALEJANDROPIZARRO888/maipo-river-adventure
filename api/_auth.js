import { randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';
import { db, isAdmin } from './_lib.js';
import { ensureBajadas } from './_bajadas.js';

// Cuentas, turnos y avisos de la app del personal. Aparte de ensureSchema() para que la reserva pública no pague estas consultas.
let _listo;
export function ensureApp() {
  return (_listo ||= (async () => {
    await ensureBajadas();
    const q = db();
    await q.transaction([
      // Una persona puede tener DOS cuentas (admin y trabajador): son filas distintas. Solo puede existir una cuenta maestra.
      q`create table if not exists cuentas (
        id serial primary key,
        creada timestamptz not null default now(),
        tipo text not null check (tipo in ('admin', 'trabajador')),
        usuario text not null unique,
        nombre text not null,
        correo text,
        telefono text,
        pass_hash text not null,
        es_maestra boolean not null default false,
        verificada boolean not null default false,
        verificada_por int references cuentas(id),
        funciones text[] not null default '{}',
        activa boolean not null default true
      )`,
      q`create unique index if not exists una_cuenta_maestra on cuentas (es_maestra) where es_maestra`,
      // La función NO es del trabajador: es de este turno. La tarifa se congela al publicar.
      q`create table if not exists turnos (
        id serial primary key,
        bajada_id int not null references bajadas(id) on delete cascade,
        puesto text not null,
        bote_id int references botes(id) on delete set null,
        trabajador_id int not null references cuentas(id),
        funcion text not null,
        estado text not null default 'borrador',
        tarifa int,
        respondido_en timestamptz,
        motivo_rechazo text,
        cerrado_en timestamptz,
        pax_finales int,
        incidentes text,
        pagado_en timestamptz
      )`,
      q`create unique index if not exists turno_puesto on turnos (bajada_id, puesto) where estado <> 'rechazado'`,
      q`create unique index if not exists turno_persona on turnos (bajada_id, trabajador_id) where estado <> 'rechazado'`,
      q`create table if not exists avisos (
        id serial primary key,
        creada timestamptz not null default now(),
        cuenta_id int not null references cuentas(id) on delete cascade,
        tipo text not null,
        titulo text not null,
        cuerpo text,
        ruta text,
        ref_id int,
        leido boolean not null default false
      )`,
      q`alter table avisos add column if not exists ruta text`,
      q`create index if not exists avisos_cuenta on avisos (cuenta_id, id desc)`,
      // Un teléfono que activó los avisos = una suscripción (dirección del servicio de push del navegador + llaves).
      q`create table if not exists push_subs (
        id serial primary key,
        creada timestamptz not null default now(),
        cuenta_id int not null references cuentas(id) on delete cascade,
        endpoint text not null unique,
        p256dh text not null,
        auth text not null,
        ua text
      )`,
      q`create table if not exists login_intentos (id serial primary key, clave text not null, creada timestamptz not null default now())`,
      q`create index if not exists login_intentos_clave on login_intentos (clave, creada)`,
      q`alter table bajadas add column if not exists publicada_por int references cuentas(id)`,
      q`alter table bajadas add column if not exists publicada_en timestamptz`,
      q`alter table fichas add column if not exists presente boolean`,
      // Tiempo real: cada cambio (también los que llegan desde la web pública) sube este contador; los teléfonos lo consultan.
      // El bloque interno nunca deja que un fallo del contador impida guardar una reserva o una ficha.
      q`create sequence if not exists app_rev`,
      q`create or replace function bump_rev() returns trigger as $$
        begin
          begin perform nextval('app_rev'); exception when others then null; end;
          return null;
        end $$ language plpgsql`,
      q`do $$ declare t text; begin
          foreach t in array array['reservas', 'fichas', 'bajadas', 'botes', 'turnos', 'cuentas', 'avisos'] loop
            if not exists (select 1 from pg_trigger where tgname = 'bump_rev' and tgrelid = t::regclass) then
              execute format('create trigger bump_rev after insert or update or delete on %I for each statement execute function bump_rev()', t);
            end if;
          end loop;
        end $$`
    ]);
  })().catch(e => { _listo = undefined; throw e; }));
}

// ---- Contraseñas (scrypt) y sesiones (firma HMAC; el secreto se guarda en la base, no hace falta configurar nada)
export function hashClave(pw) {
  const salt = randomBytes(16);
  return salt.toString('hex') + ':' + scryptSync(pw, salt, 32).toString('hex');
}
export function claveOk(pw, guardado) {
  const [salt, hash] = String(guardado || '').split(':');
  if (!salt || !hash) return false;
  const cand = scryptSync(String(pw), Buffer.from(salt, 'hex'), 32), real = Buffer.from(hash, 'hex');
  return cand.length === real.length && timingSafeEqual(cand, real);
}
// Clave temporal legible (sin 0/O/1/l/I) para entregar al crear una cuenta; la persona la cambia en su perfil.
export function claveTemporal() {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(randomBytes(10), b => abc[b % abc.length]).join('');
}

let _secreto;
async function secreto() {
  if (_secreto) return _secreto;
  const q = db();
  await q`insert into config (k, v) values ('app_secret', ${randomBytes(32).toString('hex')}) on conflict (k) do nothing`;
  const [r] = await q`select v from config where k = 'app_secret'`;
  return (_secreto = r.v);
}
const DIAS_SESION = 30;
export async function firmar(cuenta) {
  const p = Buffer.from(JSON.stringify({ c: cuenta.id, v: cuenta.pass_hash.slice(-10), e: Date.now() + DIAS_SESION * 864e5 })).toString('base64url');
  return 'mra1.' + p + '.' + createHmac('sha256', await secreto()).update(p).digest('base64url');
}

const esToken = req => /^Bearer\s+mra1\./i.test(req.headers.authorization || '');

// La cuenta dueña del token, o null. Se lee de la base en cada llamada: dar de baja corta el acceso de inmediato,
// y cambiar la contraseña invalida las sesiones anteriores. No devuelve el hash de la contraseña.
export async function cuentaDe(req) {
  if (!esToken(req)) return null;
  const [, p, sig] = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').split('.');
  if (!p || !sig) return null;
  const esperado = createHmac('sha256', await secreto()).update(p).digest();
  const dado = Buffer.from(sig, 'base64url');
  if (dado.length !== esperado.length || !timingSafeEqual(dado, esperado)) return null;
  let d; try { d = JSON.parse(Buffer.from(p, 'base64url').toString()); } catch { return null; }
  if (!(d.e > Date.now())) return null;
  const [c] = await db()`select id, tipo, usuario, nombre, correo, telefono, es_maestra, verificada, funciones, activa, right(pass_hash, 10) as v
    from cuentas where id = ${d.c}`;
  if (!c || !c.activa || c.v !== d.v) return null;
  delete c.v;
  return c;
}

// Acceso de administración: la clave compartida del panel actual, o la sesión de una cuenta admin activa.
// (Publicar bajadas es aparte: exige una cuenta admin verificada.)
export async function esAdmin(req) {
  if (esToken(req)) { const c = await cuentaDe(req); return !!c && c.tipo === 'admin'; }
  return isAdmin(req);
}

// ---- Límite de intentos de acceso: 8 fallos por usuario o 40 por IP en 10 minutos.
export async function bloqueado(usuario, ip) {
  const [r] = await db()`select
      (select count(*)::int from login_intentos where clave = ${'u:' + usuario} and creada > now() - interval '10 minutes') as u,
      (select count(*)::int from login_intentos where clave = ${'i:' + (ip || '?')} and creada > now() - interval '10 minutes') as i`;
  return r.u >= 8 || r.i >= 40;
}
export async function registrarFallo(usuario, ip) {
  await db()`insert into login_intentos (clave) values (${'u:' + usuario}), (${'i:' + (ip || '?')})`;
}
export async function limpiarFallos(usuario) {
  await db()`delete from login_intentos where clave = ${'u:' + usuario} or creada < now() - interval '1 day'`;
}

// ---- Utilidades de cuentas
export const quitaAcentos = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '');
// 'Nicolás Aravena' -> 'nico.aravena' no se puede adivinar; se usa 'nicolas.aravena' (+ '.admin' para cuentas admin) y un número si ya existe.
export async function usuarioLibre(nombre, tipo) {
  const partes = quitaAcentos(nombre).toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(Boolean);
  const base = (partes.length > 1 ? partes[0] + '.' + partes[partes.length - 1] : partes[0] || 'usuario') + (tipo === 'admin' ? '.admin' : '');
  for (let n = 0; ; n++) {
    const u = n ? base + n : base;
    const [x] = await db()`select 1 as x from cuentas where usuario = ${u}`;
    if (!x) return u;
  }
}

// Fecha de hoy en Chile (AAAA-MM-DD): el servidor corre en UTC y de noche ya sería "mañana".
export const hoyCL = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Santiago' });
