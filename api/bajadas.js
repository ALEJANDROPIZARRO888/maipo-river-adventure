import { db, cors, body } from './_lib.js';
import { esAdmin } from './_auth.js';
import { ensureBajadas, materializar, salidasDe, TRAMOS, ESTADOS_EDITABLES } from './_bajadas.js';

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const clip = (v, n) => String(v ?? '').trim().slice(0, n);

export default async function handler(req, res) {
  if (cors(req, res)) return;
  try {
    await ensureBajadas();
    if (!(await esAdmin(req))) return res.status(401).json({ error: 'no autorizado' });
    const q = db();

    // ---- Salidas de un día (?fecha=) o de un rango (?desde=&hasta=), con reservas, balsas y fichas
    if (req.method === 'GET') {
      const desde = String(req.query.desde || req.query.fecha || '');
      const hasta = String(req.query.hasta || req.query.fecha || desde);
      if (!FECHA.test(desde) || !FECHA.test(hasta) || hasta < desde || (Date.parse(hasta) - Date.parse(desde)) / 864e5 > 62) {
        return res.status(400).json({ error: 'fecha inválida (usa ?fecha=AAAA-MM-DD, o ?desde= y ?hasta= de hasta 62 días)' });
      }
      await materializar(desde, hasta);
      return res.status(200).json(await salidasDe(desde, hasta));
    }

    // ---- Cambiar tramo, cupo, caudal, estado o el reparto de balsas de una salida
    if (req.method === 'PATCH') {
      const b = await body(req);
      const id = parseInt(b.id, 10);
      const [s] = id > 0 ? await q`select id from bajadas where id = ${id}` : [];
      if (!s) return res.status(404).json({ error: 'la salida no existe' });

      // Se valida todo primero para no dejar cambios a medias.
      const cambios = {};
      if ('tramo' in b) {
        if (b.tramo && !TRAMOS[b.tramo]) return res.status(400).json({ error: 'tramo inválido' });
        cambios.tramo = b.tramo || null;
      }
      if ('cupo' in b) {
        const n = parseInt(b.cupo, 10);
        if (!(n >= 1 && n <= 60)) return res.status(400).json({ error: 'cupo inválido (1 a 60)' });
        cambios.cupo = n;
      }
      if ('caudal_m3s' in b) {
        const n = b.caudal_m3s === null || b.caudal_m3s === '' ? null : Number(b.caudal_m3s);
        if (n !== null && !(n >= 0 && n < 10000)) return res.status(400).json({ error: 'caudal inválido' });
        cambios.caudal_m3s = n;
      }
      if ('estado' in b) {
        if (!ESTADOS_EDITABLES.includes(b.estado)) return res.status(400).json({ error: 'estado no disponible todavía' });
        cambios.estado = b.estado;
      }
      let botes = null;
      if ('botes' in b) {
        botes = Array.isArray(b.botes) ? b.botes.map((x, i) => ({ nombre: clip(x && x.nombre, 40) || 'Balsa ' + (i + 1), capacidad: parseInt(x && x.capacidad, 10) })) : [];
        if (botes.length < 1 || botes.length > 8 || botes.some(x => !(x.capacidad >= 1 && x.capacidad <= 12))) {
          return res.status(400).json({ error: 'balsas inválidas (de 1 a 8, con 1 a 12 plazas cada una)' });
        }
        const [u] = await q`select count(*)::int as n from fichas where bote_id in (select id from botes where bajada_id = ${id})`;
        if (u.n) return res.status(409).json({ error: 'Hay pasajeros asignados a las balsas: sácalos antes de cambiar el reparto.' });
      }

      // El trigger de la base rechaza (MR001) un tramo que rompa la regla de la sección completa.
      if ('tramo' in cambios) await q`update bajadas set tramo = ${cambios.tramo} where id = ${id}`;
      if ('cupo' in cambios) await q`update bajadas set cupo = ${cambios.cupo} where id = ${id}`;
      if ('caudal_m3s' in cambios) await q`update bajadas set caudal_m3s = ${cambios.caudal_m3s} where id = ${id}`;
      if ('estado' in cambios) await q`update bajadas set estado = ${cambios.estado} where id = ${id}`;
      if (botes) {
        await q.transaction([
          q`delete from botes where bajada_id = ${id}`,
          ...botes.map(x => q`insert into botes (bajada_id, nombre, clase, capacidad) values (${id}, ${x.nombre}, 'balsa', ${x.capacidad})`)
        ]);
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'método no permitido' });
  } catch (e) {
    if (e && e.code === 'MR001') return res.status(409).json({ error: e.message });
    console.error('bajadas error', e);
    return res.status(500).json({ error: 'error interno' });
  }
}
