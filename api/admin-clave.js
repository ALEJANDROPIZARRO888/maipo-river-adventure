import { ensureSchema, cors, isAdmin, body, setAdminPassword } from './_lib.js';

// Cambia la clave del panel /admin. Requiere la clave actual (Authorization: Bearer ...).
export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'método no permitido' });
  try {
    await ensureSchema();
    if (!(await isAdmin(req))) return res.status(401).json({ error: 'no autorizado' });
    const b = await body(req);
    const nueva = String(b.nueva || '');
    if (nueva.length < 10) return res.status(400).json({ error: 'La clave nueva debe tener al menos 10 caracteres' });
    await setAdminPassword(nueva);
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('admin-clave error', e);
    return res.status(500).json({ error: 'error interno' });
  }
}
