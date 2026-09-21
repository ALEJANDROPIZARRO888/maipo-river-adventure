import { neon } from '@neondatabase/serverless';
import nodemailer from 'nodemailer';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

let _db;
export function db() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL no configurada');
  return (_db ||= neon(process.env.DATABASE_URL));
}

let _ready;
export function ensureSchema() {
  return (_ready ||= (async () => {
    const q = db();
    await q`create table if not exists reservas (
      id serial primary key,
      creada timestamptz not null default now(),
      token text not null unique,
      nombre text not null,
      telefono text not null,
      correo text not null,
      fecha date not null,
      horario text not null,
      personas int not null,
      plan text not null,
      tramo text not null,
      monto int not null,
      comentarios text,
      estado text not null default 'nueva',
      origen text not null default 'web'
    )`;
    await q`create table if not exists fichas (
      id serial primary key,
      creada timestamptz not null default now(),
      reserva_id int not null references reservas(id) on delete cascade,
      nombre text not null,
      documento text,
      nacimiento date,
      telefono text,
      correo text,
      nacionalidad text,
      idioma text,
      emergencia_nombre text,
      emergencia_tel text,
      medico text,
      menor boolean not null default false,
      apoderado jsonb,
      consentimiento boolean not null,
      firma text not null,
      ip text
    )`;
    await q`create table if not exists config (k text primary key, v text not null)`;
    await q`alter table reservas add column if not exists cupo_sync boolean not null default false`;
    await q`alter table fichas alter column reserva_id drop not null`;
    await q`alter table fichas add column if not exists salida text`;
    await q`alter table fichas add column if not exists tramo text`;
    await q`alter table fichas add column if not exists edad int`;
    await q`alter table fichas add column if not exists sabe_nadar boolean`;
    await q`alter table fichas add column if not exists uso_imagen boolean`;
    await q`alter table fichas add column if not exists consent_texto text`;
    await q`alter table fichas add column if not exists idioma_ficha text`;
  })());
}

export function cors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGINS || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') { res.status(204).end(); return true; }
  return false;
}

// Clave de administración: si se cambió desde el panel, vale la guardada (hash scrypt en la tabla config);
// si nunca se cambió, vale ADMIN_TOKEN (variable de Vercel).
export async function isAdmin(req) {
  const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!t) return false;
  const [row] = await db()`select v from config where k = 'admin_hash'`;
  if (row) {
    const [salt, hash] = row.v.split(':');
    const cand = scryptSync(t, Buffer.from(salt, 'hex'), 32);
    const real = Buffer.from(hash, 'hex');
    return cand.length === real.length && timingSafeEqual(cand, real);
  }
  return !!process.env.ADMIN_TOKEN && t === process.env.ADMIN_TOKEN;
}

export async function setAdminPassword(pw) {
  const salt = randomBytes(16);
  const v = salt.toString('hex') + ':' + scryptSync(pw, salt, 32).toString('hex');
  await db()`insert into config (k, v) values ('admin_hash', ${v}) on conflict (k) do update set v = excluded.v`;
}

export function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null;
}

export async function body(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}

// ---- Correo -------------------------------------------------------------
// Prioridad 1: Gmail (contraseña de aplicación). Prioridad 2: Resend.
// Si no hay ninguna configurada no hace nada: nunca rompe la reserva.
const GMAIL_USER = () => process.env.GMAIL_USER || 'maiporiveradventure@gmail.com';
let _tx;
function transport() {
  const pass = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
  if (!pass) return null;
  return (_tx ||= nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 465, secure: true,
    auth: { user: GMAIL_USER(), pass }
  }));
}

export async function sendMail({ to, subject, html, replyTo }) {
  if (!to) return false;
  const tx = transport();
  if (tx) {
    try {
      await tx.sendMail({ from: `"Maipo River Adventure" <${GMAIL_USER()}>`, to, subject, html, replyTo });
      return true;
    } catch (e) { console.error('smtp error', e && e.message); return false; }
  }
  const key = process.env.RESEND_API_KEY;
  if (!key) return false;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.MAIL_FROM || 'Maipo River Adventure <onboarding@resend.dev>',
        to: Array.isArray(to) ? to : [to], subject, html, reply_to: replyTo
      })
    });
    return r.ok;
  } catch { return false; }
}

// Fecha legible ("jueves, 31 de diciembre de 2026") a partir de 'YYYY-MM-DD' o ISO.
export function fmtFecha(f, lang = 'es') {
  const s = String(f || '').slice(0, 10);
  const d = new Date(s + 'T12:00:00Z');
  if (isNaN(d)) return s;
  return new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'es-CL', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC'
  }).format(d);
}

export const clp = n => '$' + Number(n || 0).toLocaleString('es-CL');

// Marco simple y compatible con clientes de correo.
export function emailShell(inner) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;background:#f2f2f3;padding:20px">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #c9ccd0;padding:22px;color:#1d1f20;line-height:1.5">
    <div style="font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#2f5478;font-size:13px">Maipo River Adventure</div>
    ${inner}
  </div>
</div>`;
}

// Plan -> tramo y monto (CLP). Rafting cobra por persona; los packs de kayak son precio total.
export function planInfo(plan = '', personas = 1) {
  const p = plan.toLowerCase();
  const precio = (plan.match(/\$\s?([\d.]+)/) || [])[1];
  const valor = precio ? parseInt(precio.replace(/\./g, ''), 10) : 0;
  if (p.includes('full')) return { tramo: 'Sección completa', monto: valor * personas };
  if (p.includes('extrema')) return { tramo: 'San Alfonso — Melocotón', monto: valor * personas };
  if (p.includes('power')) return { tramo: 'Melocotón — San José', monto: valor * personas };
  if (p.includes('kayak')) return { tramo: 'Clases de kayak', monto: valor };
  return { tramo: 'Por definir', monto: 0 };
}

// La web ofrece franjas (Mañana / Medio día / Tarde); la operación usa 11:00, 14:00 y 17:00.
export function horaSalida(h = '') {
  const t = h.toLowerCase();
  if (/11:00|ma[ñn]ana|morning/.test(t)) return '11:00';
  if (/14:00|medio|midday|noon/.test(t)) return '14:00';
  if (/17:00|tarde|afternoon/.test(t)) return '17:00';
  return null;
}

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---- Sincronización de cupos con la planilla Google (Apps Script).
// Suma/resta `delta` personas a RESERVADOS de (fecha, horario). Devuelve true si la planilla confirmó.
const APPS_SCRIPT_URL = () => process.env.APPS_SCRIPT_URL ||
  'https://script.google.com/macros/s/AKfycbwoIxVXpwzK5aIzoVXqcHUGtwCL1BgFHKHTCzyCsxRQuxY1ZKcKKgOMUPY7NFBx7rCa/exec';

export async function syncCupos(fecha, horario, delta) {
  const key = (process.env.SHEET_SYNC_KEY || '').trim();
  if (!key || !delta) return false;
  try {
    const r = await fetch(APPS_SCRIPT_URL(), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'ajustar', key, fecha: String(fecha).slice(0, 10), horario, delta }),
      redirect: 'follow'
    });
    const t = await r.text();
    let j = {}; try { j = JSON.parse(t); } catch {}
    if (j.ok !== true) console.error('syncCupos rechazado', r.status, t.slice(0, 200));
    return j.ok === true;
  } catch (e) {
    console.error('syncCupos error', e);
    return false;
  }
}
