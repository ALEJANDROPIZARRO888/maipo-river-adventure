import { db, ensureSchema, cors, body, clientIp } from './_lib.js';

export default async function handler(req, res) {
  if (cors(req, res)) return;
  try {
    await ensureSchema();
    const q = db();

    if (req.method === 'GET') {
      const t = String(req.query.r || '');
      const [r] = await q`select id, nombre, fecha::text as fecha, horario, personas, tramo from reservas where token = ${t}`;
      if (!r) return res.status(404).json({ error: 'reserva no encontrada' });
      const [c] = await q`select count(*)::int as n from fichas where reserva_id = ${r.id}`;
      return res.status(200).json({ titular: r.nombre, fecha: r.fecha, horario: r.horario, personas: r.personas, tramo: r.tramo, fichas: c.n });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'método no permitido' });
    const b = await body(req);
    const [r] = await q`select id, personas from reservas where token = ${String(b.r || '')}`;
    if (!r) return res.status(404).json({ error: 'reserva no encontrada' });

    const nombre = String(b.nombre || '').trim();
    const firma = String(b.firma || '').trim();
    const menor = !!b.menor;
    const ap = b.apoderado || null;

    const errores = [];
    if (nombre.length < 2) errores.push('nombre');
    if (b.consentimiento !== true) errores.push('consentimiento');
    if (firma.length < 5) errores.push('firma');
    if (menor && !(ap && String(ap.nombre || '').trim() && String(ap.firma || '').trim().length >= 5)) errores.push('apoderado');
    if (errores.length) return res.status(400).json({ error: 'datos inválidos', campos: errores });

    const [c] = await q`select count(*)::int as n from fichas where reserva_id = ${r.id}`;
    if (c.n >= r.personas + 10) return res.status(429).json({ error: 'demasiadas fichas para esta reserva' });

    await q`insert into fichas
      (reserva_id, nombre, documento, nacimiento, telefono, correo, nacionalidad, idioma,
       emergencia_nombre, emergencia_tel, medico, menor, apoderado, consentimiento, firma, ip)
      values (${r.id}, ${nombre}, ${b.documento || null}, ${b.nacimiento || null}, ${b.telefono || null}, ${b.correo || null},
              ${b.nacionalidad || null}, ${b.idioma || null}, ${b.emergenciaNombre || null}, ${b.emergenciaTel || null},
              ${b.medico || null}, ${menor}, ${ap ? JSON.stringify(ap) : null}, true, ${firma}, ${clientIp(req)})`;
    return res.status(201).json({ ok: true, fichas: c.n + 1, personas: r.personas });
  } catch (e) {
    console.error('ficha error', e);
    return res.status(500).json({ error: 'error interno' });
  }
}
