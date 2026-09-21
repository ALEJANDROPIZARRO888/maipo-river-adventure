import { db, ensureSchema, cors, body, clientIp, sendMail, esc, fmtFecha, emailShell } from './_lib.js';
import { ensureBajadas } from './_bajadas.js';
import { esAdmin } from './_auth.js';

const MAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const clip = (v, n) => String(v ?? '').trim().slice(0, n);
const palabras = t => t.trim().split(/\s+/).filter(Boolean).length;
const ahora = () => new Date().toLocaleString('es-CL', { timeZone: 'America/Santiago', dateStyle: 'long', timeStyle: 'short' });

function edadDe(nac) {
  const n = new Date(nac + 'T00:00:00Z');
  if (isNaN(n)) return null;
  const h = new Date();
  let a = h.getUTCFullYear() - n.getUTCFullYear();
  const m = h.getUTCMonth() - n.getUTCMonth();
  if (m < 0 || (m === 0 && h.getUTCDate() < n.getUTCDate())) a--;
  return a >= 0 && a < 120 ? a : null;
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  try {
    await ensureSchema();
    const q = db();

    if (req.method === 'GET') {
      // Admin: todas las fichas (las más nuevas primero)
      if (req.query.lista) {
        if (!(await esAdmin(req))) return res.status(401).json({ error: 'no autorizado' });
        const fichas = await q`
          select f.id, f.creada, f.nombre, f.documento, f.nacimiento::text as nacimiento, f.edad, f.telefono, f.correo,
                 f.nacionalidad, f.idioma, f.emergencia_nombre, f.medico, f.menor, f.apoderado, f.sabe_nadar, f.uso_imagen,
                 f.salida, f.tramo, f.firma, f.ip, f.reserva_id, r.nombre as titular, r.fecha::text as fecha, r.horario
          from fichas f left join reservas r on r.id = f.reserva_id
          order by f.id desc limit 500`;
        return res.status(200).json({ fichas });
      }
      // Público: datos de la reserva para mostrar en la ficha
      const t = String(req.query.r || '');
      const [r] = await q`select id, nombre, fecha::text as fecha, horario, personas, tramo from reservas where token = ${t}`;
      if (!r) return res.status(404).json({ error: 'reserva no encontrada' });
      const [c] = await q`select count(*)::int as n from fichas where reserva_id = ${r.id}`;
      return res.status(200).json({ titular: r.nombre, fecha: r.fecha, horario: r.horario, personas: r.personas, tramo: r.tramo, fichas: c.n });
    }

    // Admin: asignar una ficha a una salida (las fichas con reserva ya heredan la de su reserva) y a una balsa
    if (req.method === 'PATCH') {
      await ensureBajadas();
      if (!(await esAdmin(req))) return res.status(401).json({ error: 'no autorizado' });
      const b = await body(req);
      const id = parseInt(b.id, 10);
      const [f] = id > 0 ? await q`select f.bajada_id, f.bote_id, r.bajada_id as rbajada from fichas f left join reservas r on r.id = f.reserva_id where f.id = ${id}` : [];
      if (!f) return res.status(404).json({ error: 'la ficha no existe' });

      const bajada = 'bajada_id' in b ? (b.bajada_id == null ? null : parseInt(b.bajada_id, 10)) : f.bajada_id;
      if (bajada !== null) {
        if (!(bajada > 0)) return res.status(400).json({ error: 'salida inválida' });
        const [s] = await q`select id from bajadas where id = ${bajada}`;
        if (!s) return res.status(404).json({ error: 'la salida no existe' });
      }
      const efectiva = bajada ?? f.rbajada;

      const pedida = 'bote_id' in b;
      let bote = pedida ? (b.bote_id == null ? null : parseInt(b.bote_id, 10)) : f.bote_id;
      if (bote !== null) {
        if (!(bote > 0)) return res.status(400).json({ error: 'balsa inválida' });
        const [x] = await q`select bajada_id, nombre, capacidad, (select count(*)::int from fichas where bote_id = botes.id and id <> ${id}) as ocupados
          from botes where id = ${bote}`;
        if (!x) return res.status(404).json({ error: 'la balsa no existe' });
        if (x.bajada_id !== efectiva) {
          if (pedida) return res.status(409).json({ error: 'Esa balsa es de otra salida.' });
          bote = null; // cambió de salida: pierde la balsa que tenía
        } else if (x.ocupados >= x.capacidad) {
          return res.status(409).json({ error: `${x.nombre} ya está llena (${x.capacidad} de ${x.capacidad}).` });
        }
      }
      await q`update fichas set bajada_id = ${bajada}, bote_id = ${bote} where id = ${id}`;
      return res.status(200).json({ ok: true });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'método no permitido' });
    const b = await body(req);
    if (b.website) return res.status(200).json({ ok: true }); // honeypot anti-bot

    // Reserva opcional: la ficha puede llegar con ?r=TOKEN (link del correo) o libre (QR de la base)
    let r = null;
    if (b.r) {
      [r] = await q`select id, nombre, fecha::text as fecha, horario, personas, tramo from reservas where token = ${String(b.r)}`;
      if (!r) return res.status(404).json({ error: 'reserva no encontrada' });
    }

    const lang = b.idiomaFicha === 'EN' ? 'EN' : 'ES';
    const es = lang === 'ES';
    const nombre = clip(b.nombre, 120);
    const documento = clip(b.rut ?? b.documento, 40);
    const telefono = clip(b.telefono, 40);
    const correo = clip(b.email ?? b.correo, 160);
    const nacionalidad = clip(b.nacionalidad, 60);
    const idioma = clip(b.idioma, 40) || lang;
    const emergencia = clip(b.emergencia, 200);
    const medico = clip(b.medico, 1000) || (es ? 'ninguna' : 'none');
    const firma = clip(b.firma, 120);
    const salida = clip(b.salida, 80);
    const tramo = clip(b.tramo, 80) || (r ? r.tramo : '');
    const consentTexto = clip(b.consentTexto, 6000);
    const nacimiento = /^\d{4}-\d{2}-\d{2}$/.test(String(b.nacimiento || '')) ? String(b.nacimiento) : null;
    const edad = nacimiento ? edadDe(nacimiento) : null;
    const menor = edad !== null && edad < 18;
    const apoNombre = clip(b.apoderado, 120);
    const apoRut = clip(b.apoderadoRut, 60);
    const sabeNadar = b.sabeNadar === true;
    const usoImagen = b.usoImagen === true;

    const errores = [];
    if (palabras(nombre) < 2) errores.push('nombre');
    if (!documento) errores.push('rut');
    if (edad === null) errores.push('nacimiento');
    if (telefono.replace(/\D/g, '').length < 6) errores.push('telefono');
    if (!MAIL_RE.test(correo)) errores.push('email');
    if (!emergencia) errores.push('emergencia');
    if (menor && (!apoNombre || !apoRut)) errores.push('apoderado');
    if (b.consentimiento !== true) errores.push('consentimiento');
    if (palabras(firma) < 2 || firma.length <= 5) errores.push('firma');
    if (errores.length) return res.status(400).json({ error: 'datos inválidos', campos: errores });

    const ip = clientIp(req);
    if (ip) {
      const [k] = await q`select count(*)::int as n from fichas where ip = ${ip} and creada > now() - interval '10 minutes'`;
      if (k.n >= 20) return res.status(429).json({ error: 'demasiados envíos, intenta en unos minutos' });
    }
    let total = null;
    if (r) {
      const [c] = await q`select count(*)::int as n from fichas where reserva_id = ${r.id}`;
      if (c.n >= r.personas + 10) return res.status(429).json({ error: 'demasiadas fichas para esta reserva' });
      total = c.n + 1;
    }

    const apo = menor ? JSON.stringify({ nombre: apoNombre, rut: apoRut }) : null;
    await q`insert into fichas
      (reserva_id, nombre, documento, nacimiento, telefono, correo, nacionalidad, idioma, emergencia_nombre, medico,
       menor, apoderado, consentimiento, firma, ip, salida, tramo, edad, sabe_nadar, uso_imagen, consent_texto, idioma_ficha)
      values (${r ? r.id : null}, ${nombre}, ${documento}, ${nacimiento}, ${telefono}, ${correo}, ${nacionalidad || null}, ${idioma},
              ${emergencia}, ${medico}, ${menor}, ${apo}::jsonb, true, ${firma}, ${ip}, ${salida || null}, ${tramo || null},
              ${edad}, ${sabeNadar}, ${usoImagen}, ${consentTexto || null}, ${lang})`;

    // ---- Correos automáticos (no bloquean la respuesta si fallan)
    const base = process.env.PUBLIC_BASE_URL || `https://${req.headers.host}`;
    const admin = process.env.ADMIN_EMAIL || 'maiporiveradventure@gmail.com';
    const primer = esc(nombre.split(/\s+/)[0]);
    const cuando = r
      ? `${fmtFecha(r.fecha, es ? 'es' : 'en')} · ${esc(r.horario)}${es ? ' hrs' : ''}`
      : (salida ? esc(salida) : (es ? 'salida por confirmar' : 'departure to be confirmed'));
    const tramoH = tramo ? ` · ${esc(tramo)}` : '';
    const li = arr => '<ul style="margin:6px 0 12px;padding-left:20px">' + arr.map(x => '<li>' + x + '</li>').join('') + '</ul>';

    const paraPasajero = es
      ? `<h2 style="margin:8px 0">Hola ${primer}, tu ficha está lista</h2>
         <p>Tu registro quedó guardado para: <b>${cuando}</b>${tramoH}.</p>
         <p style="margin:12px 0 0"><b>Qué recordar</b></p>
         ${li(['Llega 20 minutos antes a nuestra base en San Alfonso.', 'Trae traje de baño, toalla y una muda seca.', 'El casco, el chaleco y el traje los ponemos nosotros.', 'Tu guía dará la charla de seguridad antes de subir a la balsa.'])}
         <p style="font-size:13px;color:#5b6167">Después de la bajada te enviamos las fotos del día por correo, de regalo.</p>
         <hr style="border:0;border-top:1px solid #c9ccd0;margin:18px 0">
         <p style="margin:0 0 6px"><b>Consentimiento de seguridad</b>: aceptado y firmado electrónicamente por <b>${esc(firma)}</b> el ${esc(ahora())}.</p>
         ${consentTexto ? `<div style="font-size:12px;line-height:1.5;color:#5b6167;border:1px solid #c9ccd0;padding:10px">${esc(consentTexto)}</div>` : ''}
         <p style="font-size:13px;color:#5b6167">Guardamos una copia. Si necesitas cambiar algo, escríbenos por WhatsApp: <a href="https://wa.me/56976437931">+56 9 7643 7931</a></p>`
      : `<h2 style="margin:8px 0">Hi ${primer}, your form is ready</h2>
         <p>Your registration is saved for: <b>${cuando}</b>${tramoH}.</p>
         <p style="margin:12px 0 0"><b>What to remember</b></p>
         ${li(['Arrive 20 minutes early at our base in San Alfonso.', 'Bring swimwear, a towel and dry clothes.', 'Helmet, vest and wetsuit are on us.', 'Your guide gives the safety briefing before you board.'])}
         <p style="font-size:13px;color:#5b6167">After the descent we email you the day's photos as a gift.</p>
         <hr style="border:0;border-top:1px solid #c9ccd0;margin:18px 0">
         <p style="margin:0 0 6px"><b>Safety consent</b>: accepted and signed electronically by <b>${esc(firma)}</b> on ${esc(ahora())} (Chile time).</p>
         ${consentTexto ? `<div style="font-size:12px;line-height:1.5;color:#5b6167;border:1px solid #c9ccd0;padding:10px">${esc(consentTexto)}</div>` : ''}
         <p style="font-size:13px;color:#5b6167">We keep a copy. If you need to change anything, message us on WhatsApp: <a href="https://wa.me/56976437931">+56 9 7643 7931</a></p>`;

    const fila = (k, val) => `<tr><td style="padding:3px 12px 3px 0;color:#5b6167;vertical-align:top">${k}</td><td style="padding:3px 0"><b>${val || '-'}</b></td></tr>`;
    const paraAdmin = `<h2 style="margin:8px 0">Nueva ficha de pasajero${menor ? ' — MENOR DE EDAD' : ''}</h2>
      <p style="margin:0 0 8px">${cuando}${tramoH}${r ? ` · reserva de <b>${esc(r.nombre)}</b>` : ' · ficha libre (QR / link)'}</p>
      <table style="font-size:14px;border-collapse:collapse">
        ${fila('Nombre', esc(nombre))}${fila('Documento', esc(documento))}${fila('Edad', edad + ' años')}
        ${fila('Teléfono', esc(telefono))}${fila('Correo', esc(correo))}${fila('Nacionalidad', esc(nacionalidad))}${fila('Idioma', esc(idioma))}
        ${fila('Emergencia', esc(emergencia))}${fila('Condiciones médicas', esc(medico))}
        ${fila('Sabe nadar', sabeNadar ? 'sí' : 'NO')}${fila('Uso de imagen', usoImagen ? 'sí' : 'no')}
        ${menor ? fila('Apoderado', esc(apoNombre) + ' — ' + esc(apoRut)) : ''}
        ${fila('Firma', esc(firma))}
      </table>
      <p style="margin:16px 0"><a href="${base}/admin" style="background:#5980a6;color:#fff;text-decoration:none;padding:12px 18px;display:inline-block;font-weight:700">Abrir panel</a></p>`;

    await Promise.allSettled([
      sendMail({
        to: correo,
        replyTo: admin,
        subject: es ? 'Tu ficha está lista — Maipo River Adventure' : 'Your registration is confirmed — Maipo River Adventure',
        html: emailShell(paraPasajero)
      }),
      sendMail({
        to: admin,
        replyTo: correo,
        subject: `Nueva ficha — ${nombre}${menor ? ' (MENOR)' : ''}${sabeNadar ? '' : ' · NO SABE NADAR'}`,
        html: emailShell(paraAdmin)
      })
    ]);

    return res.status(201).json({ ok: true, fichas: total, personas: r ? r.personas : null });
  } catch (e) {
    console.error('ficha error', e);
    return res.status(500).json({ error: 'error interno' });
  }
}
