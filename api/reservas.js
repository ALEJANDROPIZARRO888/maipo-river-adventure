import { randomBytes } from 'node:crypto';
import { db, ensureSchema, cors, isAdmin, body, sendMail, planInfo, horaSalida, esc } from './_lib.js';

export default async function handler(req, res) {
  if (cors(req, res)) return;
  try {
    await ensureSchema();
    const q = db();

    // ---- Admin: listar reservas con progreso de fichas
    if (req.method === 'GET') {
      if (!isAdmin(req)) return res.status(401).json({ error: 'no autorizado' });
      const rows = await q`
        select r.*, (select count(*)::int from fichas f where f.reserva_id = r.id) as fichas
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
    await Promise.allSettled([
      sendMail({
        to: process.env.ADMIN_EMAIL || 'maiporiveradventure@gmail.com',
        subject: `Nueva reserva #${r.id} — ${nombre} (${fecha} ${hora})`,
        html: `<h2>Nueva reserva desde la web</h2>
          <p><b>${esc(nombre)}</b> · ${esc(telefono)} · ${esc(correo)}</p>
          <p>${esc(fecha)} a las ${esc(hora)} · ${personas} persona(s)<br>${esc(plan)}<br>Monto estimado: $${monto.toLocaleString('es-CL')}</p>
          <p>Comentarios: ${esc(comentarios) || '-'}</p>
          <p>Link de ficha para los pasajeros: <a href="${fichaUrl}">${fichaUrl}</a></p>`
      }),
      sendMail({
        to: correo,
        subject: 'Recibimos tu reserva — Maipo River Adventure',
        html: `<p>Hola ${esc(nombre)}, recibimos tu solicitud para el ${esc(fecha)} a las ${esc(hora)} (${personas} persona(s)).</p>
          <p>Para agilizar el día, cada pasajero debe completar su ficha de seguridad aquí:<br><a href="${fichaUrl}">${fichaUrl}</a></p>
          <p>Te confirmaremos por WhatsApp. / We'll confirm via WhatsApp.</p>`
      })
    ]);

    return res.status(201).json({ ok: true, id: r.id, fichaUrl });
  } catch (e) {
    console.error('reservas error', e);
    return res.status(500).json({ error: 'error interno' });
  }
}
