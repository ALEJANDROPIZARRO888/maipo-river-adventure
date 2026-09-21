import { randomBytes } from 'node:crypto';
import { db, ensureSchema, cors, isAdmin, body, sendMail, planInfo, horaSalida, esc, fmtFecha, clp, emailShell } from './_lib.js';

export default async function handler(req, res) {
  if (cors(req, res)) return;
  try {
    await ensureSchema();
    const q = db();

    // ---- Admin: listar reservas con progreso de fichas
    if (req.method === 'GET') {
      if (!isAdmin(req)) return res.status(401).json({ error: 'no autorizado' });
      const rows = await q`
        select r.id, r.creada, r.token, r.nombre, r.telefono, r.correo, r.fecha::text as fecha,
               r.horario, r.personas, r.plan, r.tramo, r.monto, r.comentarios, r.estado, r.origen,
               (select count(*)::int from fichas f where f.reserva_id = r.id) as fichas
        from reservas r order by r.fecha asc, r.horario asc, r.id asc`;
      return res.status(200).json({ reservas: rows });
    }

    // ---- Admin: cambiar estado
    if (req.method === 'PATCH') {
      if (!isAdmin(req)) return res.status(401).json({ error: 'no autorizado' });
      const b = await body(req);
      const ok = ['nueva', 'confirmada', 'cancelada', 'completada'];
      if (!b.id || !ok.includes(b.estado)) return res.status(400).json({ error: 'datos inválidos' });
      await q`update reservas set estado = ${b.estado} where id = ${b.id}`;
      return res.status(200).json({ ok: true });
    }

    // ---- Público: crear reserva desde la web
    if (req.method !== 'POST') return res.status(405).json({ error: 'método no permitido' });
    const b = await body(req);
    if (b.website) return res.status(200).json({ ok: true }); // honeypot anti-bot

    const nombre = String(b.nombre || '').trim();
    const telefono = String(b.telefono || '').trim();
    const correo = String(b.correo || '').trim();
    const fecha = String(b.fecha || '').trim();
    const horario = String(b.horario || '').trim();
    const personas = parseInt(b.personas, 10);
    const plan = String(b.plan || '').trim();
    const comentarios = String(b.comentarios || '').trim().slice(0, 1000);

    const errores = [];
    if (nombre.length < 2) errores.push('nombre');
    if (telefono.replace(/\D/g, '').length < 8) errores.push('telefono');
    if (!/^\S+@\S+\.\S+$/.test(correo)) errores.push('correo');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) errores.push('fecha');
    if (!horaSalida(horario)) errores.push('horario');
    if (!(personas >= 1 && personas <= 60)) errores.push('personas');
    if (!plan) errores.push('plan');
    if (errores.length) return res.status(400).json({ error: 'datos inválidos', campos: errores });

    const hora = horaSalida(horario);
    const { tramo, monto } = planInfo(plan, personas);
    const token = randomBytes(9).toString('base64url');

    const [r] = await q`
      insert into reservas (token, nombre, telefono, correo, fecha, horario, personas, plan, tramo, monto, comentarios)
      values (${token}, ${nombre}, ${telefono}, ${correo}, ${fecha}, ${hora}, ${personas}, ${plan}, ${tramo}, ${monto}, ${comentarios || null})
      returning id`;

    const base = process.env.PUBLIC_BASE_URL || `https://${req.headers.host}`;
    const fichaUrl = `${base}/ficha?r=${token}`;

    // Avisos: no bloquean la respuesta si fallan
    const nombreH = esc(nombre), planH = esc(plan);
    const resumenEs = `<p style="margin:14px 0 4px"><b>${fmtFecha(fecha, 'es')}</b> · ${esc(hora)} hrs<br>${personas} ${personas === 1 ? 'persona' : 'personas'} · ${planH}</p>`;
    const resumenEn = `<p style="margin:14px 0 4px"><b>${fmtFecha(fecha, 'en')}</b> · ${esc(hora)}<br>${personas} ${personas === 1 ? 'person' : 'people'} · ${planH}</p>`;
    const btn = (href, txt) => `<p style="margin:16px 0"><a href="${href}" style="background:#5980a6;color:#fff;text-decoration:none;padding:12px 18px;display:inline-block;font-weight:700">${txt}</a></p>`;

    await Promise.allSettled([
      sendMail({
        to: process.env.ADMIN_EMAIL || 'maiporiveradventure@gmail.com',
        replyTo: correo,
        subject: `Nueva reserva #${r.id} — ${nombre} (${fecha} ${hora})`,
        html: emailShell(`<h2 style="margin:8px 0">Nueva reserva desde la web</h2>
          <p style="margin:0"><b>${nombreH}</b><br>${esc(telefono)} · ${esc(correo)}</p>
          ${resumenEs}
          <p style="margin:4px 0">Monto estimado: <b>${clp(monto)}</b></p>
          <p style="margin:4px 0;color:#5b6167">Comentarios: ${esc(comentarios) || '-'}</p>
          ${btn(`${base}/admin`, 'Abrir panel de reservas')}
          <p style="font-size:13px;color:#5b6167">Link de ficha para los pasajeros:<br><a href="${fichaUrl}">${fichaUrl}</a></p>`)
      }),
      sendMail({
        to: correo,
        replyTo: process.env.ADMIN_EMAIL || 'maiporiveradventure@gmail.com',
        subject: 'Recibimos tu reserva / We received your booking — Maipo River Adventure',
        html: emailShell(`<h2 style="margin:8px 0">Hola ${nombreH}, recibimos tu solicitud</h2>
          ${resumenEs}
          <p>Te confirmaremos por WhatsApp. Para agilizar el día, <b>cada pasajero</b> debe completar su ficha de seguridad:</p>
          ${btn(fichaUrl, 'Completar ficha de seguridad')}
          <hr style="border:0;border-top:1px solid #c9ccd0;margin:20px 0">
          <h2 style="margin:8px 0">Hi ${nombreH}, we received your request</h2>
          ${resumenEn}
          <p>We will confirm via WhatsApp. To speed things up on the day, <b>every passenger</b> must fill in the safety form:</p>
          ${btn(fichaUrl, 'Fill in the safety form')}
          <p style="font-size:13px;color:#5b6167">WhatsApp: <a href="https://wa.me/56976437931">+56 9 7643 7931</a></p>`)
      })
    ]);

    return res.status(201).json({ ok: true, id: r.id, fichaUrl });
  } catch (e) {
    console.error('reservas error', e);
    return res.status(500).json({ error: 'error interno' });
  }
}
