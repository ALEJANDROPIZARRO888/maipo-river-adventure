// Base de datos PostgreSQL real en memoria (PGlite) detrás de un cliente con la misma forma que neon():
// plantilla etiquetada perezosa y q.transaction([...]). Así las pruebas ejecutan los handlers reales sin tocar Neon.
import { PGlite } from '@electric-sql/pglite';
import { pathToFileURL, fileURLToPath } from 'node:url';

export const REPO = fileURLToPath(new URL('../../', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '');
export const imp = f => import(pathToFileURL(`${REPO}/${f}`).href);

export function crearBase() {
  const pg = new PGlite();
  const mk = (strings, values) => {
    const text = strings.reduce((a, s, i) => a + '$' + i + s);
    return { text, values, then: (ok, ko) => pg.query(text, values).then(r => r.rows).then(ok, ko) };
  };
  const q = (strings, ...values) => mk(strings, values);
  q.transaction = list => pg.transaction(async tx => { const out = []; for (const x of list) out.push((await tx.query(x.text, x.values)).rows); return out; });
  return { pg, q };
}

// Deja el entorno sin credenciales reales (los correos y la planilla quedan como no-op) y conecta la base en memoria.
export async function montar() {
  for (const k of ['GMAIL_APP_PASSWORD', 'RESEND_API_KEY', 'SHEET_SYNC_KEY', 'DATABASE_URL']) delete process.env[k];
  process.env.ADMIN_TOKEN = 'clave-de-prueba';
  const base = crearBase();
  (await imp('api/_lib.js')).useDb(base.q);
  return base;
}
