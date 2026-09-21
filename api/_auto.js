// Reglas de operación puras (sin base de datos): tarifas, reparto de pasajeros en balsas, elección de personal y choques de horario.
// Portadas de la clase Component del prototipo de diseño (auto, rate, choca); aquí están aisladas para poder probarlas.

export const FUNCIONES = ['guia', 'seguridad', 'conductor'];
export const NOMBRE_FUNCION = { guia: 'Guía de balsa', seguridad: 'Kayak de seguridad', conductor: 'Conductor / fotógrafo' };
export const TARIFA_BASE = { guia: 35000, seguridad: 35000, conductor: 20000 }; // CLP por bajada
export const FACTOR_TRAMO = { seccion_completa: 2 };
export const KAYAKS_SEGURIDAD = 2;

// La tarifa se congela al publicar la bajada: un cambio de tarifa no altera lo ya trabajado.
export const tarifa = (funcion, tramo) => (TARIFA_BASE[funcion] || 0) * (FACTOR_TRAMO[tramo] || 1);

export const tieneCondicion = m => { const t = String(m ?? '').trim().toLowerCase(); return !!t && !/^(ninguna?|none|no|n\/a|-)$/.test(t); };
const idiomaDe = f => (String(f.idioma || f.idioma_ficha || 'ES').trim().slice(0, 2).toUpperCase() || 'ES');

// Puestos de una salida: un guía por balsa, los kayaks de seguridad y un conductor/fotógrafo.
export function puestosDe(botes) {
  const balsas = botes.filter(b => b.clase === 'balsa').map(b => ({ puesto: 'balsa:' + b.id, funcion: 'guia', bote_id: b.id, etiqueta: b.nombre }));
  const kayaks = Array.from({ length: KAYAKS_SEGURIDAD }, (_, i) => ({ puesto: 'kayak:' + (i + 1), funcion: 'seguridad', bote_id: null, etiqueta: 'Kayak ' + (i + 1) }));
  return [...balsas, ...kayaks, { puesto: 'conductor', funcion: 'conductor', bote_id: null, etiqueta: 'Traslado y fotos' }];
}

// Balsas que necesitan guía para salir: las que ya tienen pasajeros y las primeras que hagan falta para sentar a todos
// los reservados. Una salida de 2 personas no necesita la segunda balsa. `ocupadas`: Map boteId -> pasajeros asignados.
export function balsasNecesarias(balsas, ocupadas, personas) {
  const nec = new Set(balsas.filter(b => (ocupadas.get(b.id) || 0) > 0).map(b => b.id));
  const asignados = [...ocupadas.values()].reduce((a, n) => a + n, 0);
  const total = Math.max(personas || 0, asignados, 1);
  let cupo = balsas.filter(b => nec.has(b.id)).reduce((a, b) => a + b.capacidad, 0);
  for (const b of balsas) { if (cupo >= total) break; if (!nec.has(b.id)) { nec.add(b.id); cupo += b.capacidad; } }
  return nec;
}

// Reparte fichas en balsas. Prioridad: no separar grupos (misma reserva) -> equilibrar la carga -> juntar idioma
// -> máximo una condición médica por balsa -> respetar capacidad. Si un grupo no cabe entero, se divide antes que pasarse.
// Devuelve { asignacion: { fichaId: boteId }, sobran: [fichaId] }.
export function distribuirFichas(balsas, fichas) {
  const bins = balsas.map(b => ({ id: b.id, cap: b.capacidad, pax: [], med: 0, langs: new Set() }));
  const grupos = new Map();
  for (const f of fichas) {
    const k = f.reserva_id ?? 'f' + f.id;
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push(f);
  }
  const lista = [...grupos.values()].sort((a, b) => b.length - a.length || idiomaDe(a[0]).localeCompare(idiomaDe(b[0])));
  const asignacion = {}, sobran = [];
  for (const g of lista) {
    let resto = g.slice();
    while (resto.length) {
      const conLugar = bins.filter(b => b.pax.length < b.cap);
      if (!conLugar.length) { sobran.push(...resto.map(f => f.id)); break; }
      const med = resto.filter(f => tieneCondicion(f.medico)).length;
      const puntaje = b => {
        let s = (b.pax.length / b.cap) * 16;
        if (b.cap - b.pax.length < resto.length) s += 400;
        if (b.med + med > 1) s += 60;
        if (b.langs.size && !b.langs.has(idiomaDe(resto[0]))) s += 6;
        return s;
      };
      const b = conLugar.slice().sort((x, y) => puntaje(x) - puntaje(y))[0];
      const tomados = resto.splice(0, b.cap - b.pax.length);
      for (const f of tomados) { b.pax.push(f); b.langs.add(idiomaDe(f)); asignacion[f.id] = b.id; if (tieneCondicion(f.medico)) b.med++; }
    }
  }
  return { asignacion, sobran };
}

// Elige personal para los puestos. `gente`: [{ id, nombre, funciones, carga }] (carga = bajadas acumuladas);
// `ocupados`: ids no disponibles (ya en otro puesto o con choque). Solo se asigna a quien declaró la función.
// Busca la mejor combinación completa: primero cubrir más puestos (el guía pesa más porque sin guía no se puede salir),
// y entre las que cubren lo mismo, la que reparte con más equidad (menor carga acumulada total). Con ~5 puestos es instantáneo.
const PESO = { guia: 1000, seguridad: 10, conductor: 10 };
export function elegirPersonal(puestos, gente, ocupados = new Set()) {
  const libres = gente.filter(g => !ocupados.has(g.id)).sort((a, b) => a.carga - b.carga || a.nombre.localeCompare(b.nombre));
  const restante = new Array(puestos.length + 1).fill(0);
  for (let i = puestos.length - 1; i >= 0; i--) restante[i] = restante[i + 1] + (PESO[puestos[i].funcion] || 1);
  let mejor = { valor: -1, carga: 0, elegido: {} };
  const usados = new Set(), actual = {};
  const ir = (i, valor, carga) => {
    if (valor + restante[i] < mejor.valor) return; // ya no puede superar lo encontrado
    if (i === puestos.length) {
      if (valor > mejor.valor || (valor === mejor.valor && carga < mejor.carga)) mejor = { valor, carga, elegido: { ...actual } };
      return;
    }
    const p = puestos[i];
    for (const g of libres) {
      if (usados.has(g.id) || !g.funciones.includes(p.funcion)) continue;
      usados.add(g.id); actual[p.puesto] = g.id;
      ir(i + 1, valor + (PESO[p.funcion] || 1), carga + g.carga);
      usados.delete(g.id); delete actual[p.puesto];
    }
    ir(i + 1, valor, carga); // el puesto queda sin cubrir
  };
  ir(0, 0, 0);
  return mejor.elegido;
}

// Choque de horario: la sección completa ocupa la jornada, así que no se combina con otra bajada el mismo día.
// `delDia`: turnos vigentes de ese día [{ trabajador_id, bajada_id, tramo }].
export function choque(trabajadorId, bajada, delDia) {
  const otros = delDia.filter(t => t.trabajador_id === trabajadorId && t.bajada_id !== bajada.id);
  if (!otros.length) return null;
  if (bajada.tramo === 'seccion_completa') return 'La sección completa ocupa la jornada y ya tiene otra bajada ese día.';
  if (otros.some(t => t.tramo === 'seccion_completa')) return 'Ese día tiene una sección completa, que ocupa la jornada.';
  return null;
}

// Los admin ven cuánto pagar; solo cuentan las bajadas cerradas o pagadas. Lo demás es estimado y va aparte.
export function resumenPago(turnos) {
  const r = { pagar: 0, estimado: 0, cerradas: 0, porFuncion: { guia: 0, seguridad: 0, conductor: 0 } };
  for (const t of turnos) {
    if (t.estado === 'cerrado' || t.estado === 'pagado') {
      r.pagar += t.tarifa || 0; r.cerradas++;
      r.porFuncion[t.funcion] = (r.porFuncion[t.funcion] || 0) + 1;
    } else if (t.estado === 'asignado' || t.estado === 'aceptado') r.estimado += t.tarifa || 0;
  }
  return r;
}
