import { randomBytes } from 'node:crypto';
import { db, ensureSchema, cors, isAdmin, body, sendMail, planInfo, horaSalida, esc, fmtFecha, clp, emailShell, syncCupos } from './_lib.js';

export default async function handler(req, res) {
  if (cors(req, res)) return;
  try {
    await ensureSchema();
    const q = db();

    // ---- Admin: listar reservas con progreso de fichas
    if (req.method === 'GET') {
      if (!(await isAdmin(req))) return res.status(401).json({ error: 'no autorizado' });
      const rows = await q`
        select r.id, r.creada, r.token, r.nombre, r.telefono, r.correo, r.fecha::text as fecha,
               r.horario, r.personas, r.plan, r.tramo, r.monto, r.comentarios, r.estado, r.origen,
               (select count(*)::int from fichas f where f.reserva_id = r.id) as fichas
        from reservas r order by r.fecha asc, r.horario asc, r.id asc`;
      return res.status(200).json({ reservas: rows });
    }

    // ---- Admin: cambiar estado (cancelar libera cupos en la planilla; reactivar los vuelve a ocupar)
    if (req.method === 'PATCH') {
      if (!(await isAdmin(req))) return res.status(401).json({ error: 'no autorizado' });
      const b = await body(req);
      const ok = ['nueva', 'confirmada', 'cancelada', 'completada'];
      if (!b.id || !ok.includes(b.estado)) return res.status(400).json({ error: 'datos inválidos' });
      const [antes] = await q`select estado, fecha::text as fecha, horario, personas, cupo_sync, nombre, correo, token, origen from reservas where id = ${b.id}`;
      if (!antes) return res.status(404).json({ error: 'no existe' });
      await q`update reservas set estado = ${b.estado} where id = ${b.id}`;
      let planilla = null; // null = no aplica
      if (antes.cupo_sync && (antes.estado === 'cancelada') !== (b.estado === 'cancelada')) {
        planilla = await syncCupos(antes.fecha, antes.horario, b.estado === 'cancelada' ? -antes.personas : antes.personas);
      }
      // Correo automático al cliente cuando una reserva de la web pasa a confirmada
      let correoEnviado = null;
      if (antes.estado === 'nueva' && b.estado === 'confirmada' && antes.origen === 'web' && /^\S+@\S+\.\S+$/.test(antes.correo)) {
        const base = process.env.PUBLIC_BASE_URL || `https://${req.headers.host}`;
        const fichaUrl = `${base}/fichapasajero?r=${antes.token}`;
        const n = esc(antes.nombre);
        const btn = (href, txt) => `<p style="margin:16px 0"><a href="${href}" style="background:#5980a6;color:#fff;text-decoration:none;padding:12px 18px;display:inline-block;font-weight:700">${txt}</a></p>`;
        const admin = process.env.ADMIN_EMAIL || 'maiporiveradventure@gmail.com';
        const r = await Promise.allSettled([sendMail({
          to: antes.correo,
          replyTo: admin,
          subject: 'Reserva confirmada / Booking confirmed — Maipo River Adventure',
          html: emailShell(`<h2 style="margin:8px 0">Hola ${n}, tu reserva está confirmada</h2>
            <p style="margin:14px 0 4px"><b>${fmtFecha(antes.fecha, 'es')}</b> · ${esc(antes.horario)} hrs<br>${antes.personas} ${antes.personas === 1 ? 'persona' : 'personas'}</p>
            <p>Llega 20 minutos antes a nuestra base en San Alfonso. Para agilizar el día, <b>cada pasajero</b> debe completar su ficha de seguridad:</p>
            ${btn(fichaUrl, 'Completar ficha de seguridad')}
            <hr style="border:0;border-top:1px solid #c9ccd0;margin:20px 0">
            <h2 style="margin:8px 0">Hi ${n}, your booking is confirmed</h2>
            <p style="margin:14px 0 4px"><b>${fmtFecha(antes.fecha, 'en')}</b> · ${esc(antes.horario)}<br>${antes.personas} ${antes.personas === 1 ? 'person' : 'people'}</p>
            <p>Arrive 20 minutes early at our base in San Alfonso. To speed things up, <b>every passenger</b> must fill in the safety form:</p>
            ${btn(fichaUrl, 'Fill in the safety form')}
            <p style="font-size:13px;color:#5b6167">WhatsApp: <a href="https://wa.me/56976437931">+56 9 7643 7931</a></p>`)
        })]);
        correoEnviado = r[0].status === 'fulfilled';
      }
      return res.status(200).json({ ok: true, planilla, correo: correoEnviado });
    }

    // ---- Admin: reserva manual (teléfono, WhatsApp, presencial) — ocupa cupos en la planilla
    if (req.method === 'POST' && (await isAdmin(req))) {
      const b = await body(req);
      const nombre = String(b.nombre || '').trim();
      const telefono = String(b.telefono || '').trim();
      const correo = String(b.correo || '').trim();
      const fecha = String(b.fecha || '').trim();
      const hora = horaSalida(String(b.horario || '').trim());
      const personas = parseInt(b.personas, 10);
      const plan = String(b.plan || '').trim() || 'Reserva manual';
      if (nombre.length < 2 || !/^\d{4}-\d{2}-\d{2}$/.test(fecha) || !hora || !(personas >= 1 && personas <= 60)) {
        return res.status(400).json({ error: 'datos inválidos' });
      }
      const monto = parseInt(b.monto, 10) || 0;
      const token = randomBytes(9).toString('base64url');
      const [r] = await q`
        insert into reservas (token, nombre, telefono, correo, fecha, horario, personas, plan, tramo, monto, comentarios, estado, origen, cupo_sync)
        values (${token}, ${nombre}, ${telefono || '-'}, ${correo || '-'}, ${fecha}, ${hora}, ${personas}, ${plan}, ${String(b.tramo || '').trim() || '-'}, ${monto}, ${String(b.comentarios || '').slice(0, 1000) || null}, 'confirmada', 'manual', true)
        returning id`;
      const planilla = await syncCupos(fecha, hora, personas);
      const base = process.env.PUBLIC_BASE_URL || `https://${req.headers.host}`;
      const fichaUrl = `${base}/fichapasajero?r=${token}`;

      // Correos: al cliente (si dejaron correo) y copia al administrador
      const btn = (href, txt) => `<p style="margin:16px 0"><a href="${href}" style="background:#5980a6;color:#fff;text-decoration:none;padding:12px 18px;display:inline-block;font-weight:700">${txt}</a></p>`;
      const planH = esc(plan), nombreH = esc(nombre);
      const resEs = `<p style="margin:14px 0 4px"><b>${fmtFecha(fecha, 'es')}</b> · ${esc(hora)} hrs<br>${personas} ${personas === 1 ? 'persona' : 'personas'} · ${planH}</p>`;
      const resEn = `<p style="margin:14px 0 4px"><b>${fmtFecha(fecha, 'en')}</b> · ${esc(hora)}<br>${personas} ${personas === 1 ? 'person' : 'people'} · ${planH}</p>`;
      const admin = process.env.ADMIN_EMAIL || 'maiporiveradventure@gmail.com';
      const envios = [
        sendMail({
          to: admin,
          subject: `Reserva manual #${r.id} — ${nombre} (${fecha} ${hora})`,
          html: emailShell(`<h2 style="margin:8px 0">Reserva manual creada desde el panel</h2>
            <p style="margin:0"><b>${nombreH}</b><br>${esc(telefono) || '-'} · ${esc(correo) || '-'}</p>
            ${resEs}
            <p style="margin:4px 0">Monto: <b>${clp(monto)}</b></p>
            ${btn(`${base}/admin`, 'Abrir panel de reservas')}
            <p style="font-size:13px;color:#5b6167">Link de ficha para los pasajeros:<br><a href="${fichaUrl}">${fichaUrl}</a></p>`)
        })
      ];
      const correoOk = /^\S+@\S+\.\S+$/.test(correo);
      if (correoOk) envios.push(sendMail({
        to: correo,
        replyTo: admin,
        subject: 'Reserva confirmada / Booking confirmed — Maipo River Adventure',
        html: emailShell(`<h2 style="margin:8px 0">Hola ${nombreH}, tu reserva está confirmada</h2>
          ${resEs}
          <p>Para agilizar el día, <b>cada pasajero</b> debe completar su ficha de seguridad:</p>
          ${btn(fichaUrl, 'Completar ficha de seguridad')}
          <hr style="border:0;border-top:1px solid #c9ccd0;margin:20px 0">
          <h2 style="margin:8px 0">Hi ${nombreH}, your booking is confirmed</h2>
          ${resEn}
          <p>To speed things up on the day, <b>every passenger</b> must fill in the safety form:</p>
          ${btn(fichaUrl, 'Fill in the safety form')}
          <p style="font-size:13px;color:#5b6167">WhatsApp: <a href="https://wa.me/56976437931">+56 9 7643 7931</a></p>`)
      }));
      await Promise.allSettled(envios);
      return res.status(201).json({ ok: true, id: r.id, planilla, correo: correoOk, fichaUrl });
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
      insert into reservas (token, nombre, telefono, correo, fecha, horario, personas, plan, tramo, monto, comentarios, cupo_sync)
      values (${token}, ${nombre}, ${telefono}, ${correo}, ${fecha}, ${hora}, ${personas}, ${plan}, ${tramo}, ${monto}, ${comentarios || null}, true)
      returning id`;

    const base = process.env.PUBLIC_BASE_URL || `https://${req.headers.host}`;
    const fichaUrl = `${base}/fichapasajero?r=${token}`;

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
