import test from 'node:test';
import assert from 'node:assert/strict';
import { tarifa, distribuirFichas, elegirPersonal, choque, puestosDe, resumenPago, tieneCondicion, balsasNecesarias } from '../api/_auto.js';

const balsas = [{ id: 1, capacidad: 8 }, { id: 2, capacidad: 6 }];
const ficha = (id, reserva_id, extra = {}) => ({ id, reserva_id, idioma: 'ES', medico: 'ninguna', ...extra });
const cuenta = (asig, ids) => ids.filter(id => asig[id] === undefined).length;

test('tarifa: guía y kayak 35.000, conductor 20.000; sección completa paga el doble', () => {
  assert.equal(tarifa('guia', 'san_alfonso_melocoton'), 35000);
  assert.equal(tarifa('seguridad', null), 35000);
  assert.equal(tarifa('conductor', 'melocoton_san_jose'), 20000);
  assert.equal(tarifa('guia', 'seccion_completa'), 70000);
  assert.equal(tarifa('conductor', 'seccion_completa'), 40000);
  assert.equal(tarifa('inexistente', null), 0);
});

test('tieneCondicion ignora "ninguna" y variantes', () => {
  for (const m of ['ninguna', 'None', ' no ', '', null, '-']) assert.equal(tieneCondicion(m), false);
  for (const m of ['asma', 'alergia a la penicilina']) assert.equal(tieneCondicion(m), true);
});

test('distribuirFichas respeta capacidad y no separa grupos que caben', () => {
  const fichas = [ficha(1, 'A'), ficha(2, 'A'), ficha(3, 'A'), ficha(4, 'B'), ficha(5, 'B'), ficha(6, 'C')];
  const { asignacion, sobran } = distribuirFichas(balsas, fichas);
  assert.deepEqual(sobran, []);
  assert.equal(asignacion[1], asignacion[2]); assert.equal(asignacion[2], asignacion[3]);
  assert.equal(asignacion[4], asignacion[5]);
  const porBalsa = id => Object.values(asignacion).filter(b => b === id).length;
  assert.ok(porBalsa(1) <= 8 && porBalsa(2) <= 6);
});

test('distribuirFichas divide un grupo que no cabe entero en vez de pasarse de capacidad', () => {
  const fichas = Array.from({ length: 12 }, (_, i) => ficha(i + 1, 'GRANDE'));
  const { asignacion, sobran } = distribuirFichas(balsas, fichas);
  assert.deepEqual(sobran, []);
  assert.equal(Object.values(asignacion).filter(b => b === 1).length, 8);
  assert.equal(Object.values(asignacion).filter(b => b === 2).length, 4);
});

test('distribuirFichas deja fuera a los que no caben (15 para 14 plazas)', () => {
  const fichas = Array.from({ length: 15 }, (_, i) => ficha(i + 1, 'g' + i));
  const { asignacion, sobran } = distribuirFichas(balsas, fichas);
  assert.equal(Object.keys(asignacion).length, 14); assert.equal(sobran.length, 1);
});

test('distribuirFichas: máximo una condición médica por balsa cuando se puede', () => {
  const fichas = [ficha(1, 'a', { medico: 'asma' }), ficha(2, 'b', { medico: 'epilepsia' }), ficha(3, 'c'), ficha(4, 'd')];
  const { asignacion } = distribuirFichas(balsas, fichas);
  assert.notEqual(asignacion[1], asignacion[2]);
});

test('distribuirFichas: una balsa que ya tiene un idioma atrae a quienes hablan el mismo', () => {
  // Orden de reparto: grupo EN (3), grupo ES (3), grupo ES (2). Los dos ES quedan juntos, lejos de los EN.
  const fichas = [
    ficha(1, 'EN3', { idioma: 'EN' }), ficha(2, 'EN3', { idioma: 'EN' }), ficha(3, 'EN3', { idioma: 'EN' }),
    ficha(4, 'ES3'), ficha(5, 'ES3'), ficha(6, 'ES3'),
    ficha(7, 'ES2'), ficha(8, 'ES2')
  ];
  const { asignacion } = distribuirFichas(balsas, fichas);
  assert.equal(asignacion[4], asignacion[7]);
  assert.notEqual(asignacion[1], asignacion[7]);
});

test('distribuirFichas sin balsas o sin fichas no falla', () => {
  assert.deepEqual(distribuirFichas([], [ficha(1, 'a')]), { asignacion: {}, sobran: [1] });
  assert.deepEqual(distribuirFichas(balsas, []), { asignacion: {}, sobran: [] });
});

test('balsasNecesarias: solo las balsas con pasajeros y las mínimas para sentar a los reservados', () => {
  const bs = [{ id: 1, capacidad: 8 }, { id: 2, capacidad: 6 }];
  assert.deepEqual([...balsasNecesarias(bs, new Map(), 2)], [1], '2 personas caben en la primera');
  assert.deepEqual([...balsasNecesarias(bs, new Map(), 9)], [1, 2], '9 personas necesitan las dos');
  assert.deepEqual([...balsasNecesarias(bs, new Map([[2, 3]]), 3)], [2], 'si los pasajeros están en la balsa 2, no se exige la 1');
  assert.deepEqual([...balsasNecesarias(bs, new Map([[1, 4], [2, 3]]), 7)].sort(), [1, 2]);
  assert.deepEqual([...balsasNecesarias(bs, new Map(), 0)], [1], 'siempre al menos una');
  assert.deepEqual([...balsasNecesarias([], new Map(), 5)], []);
});

test('puestosDe: un guía por balsa, 2 kayaks y 1 conductor', () => {
  const p = puestosDe([{ id: 7, clase: 'balsa', nombre: 'Balsa 1' }, { id: 8, clase: 'balsa', nombre: 'Balsa 2' }]);
  assert.deepEqual(p.map(x => x.puesto), ['balsa:7', 'balsa:8', 'kayak:1', 'kayak:2', 'conductor']);
  assert.deepEqual(p.map(x => x.funcion), ['guia', 'guia', 'seguridad', 'seguridad', 'conductor']);
});

test('elegirPersonal: solo asigna a quien declaró la función y prioriza a quien tiene menos bajadas', () => {
  const puestos = puestosDe([{ id: 1, clase: 'balsa', nombre: 'B1' }]);
  const gente = [
    { id: 1, nombre: 'Ana', funciones: ['guia', 'seguridad'], carga: 5 },
    { id: 2, nombre: 'Beto', funciones: ['guia'], carga: 1 },
    { id: 3, nombre: 'Cami', funciones: ['conductor'], carga: 0 },
    { id: 4, nombre: 'Dani', funciones: ['seguridad'], carga: 2 }
  ];
  const e = elegirPersonal(puestos, gente);
  assert.equal(e['balsa:1'], 2);          // el guía con menos carga
  assert.equal(e['conductor'], 3);
  assert.equal(e['kayak:1'], 4);          // Dani (2) antes que Ana (5)
  assert.equal(e['kayak:2'], 1);
});

test('elegirPersonal no gasta al único conductor como guía y respeta ocupados', () => {
  const puestos = puestosDe([{ id: 1, clase: 'balsa', nombre: 'B1' }]);
  const gente = [{ id: 1, nombre: 'Solo', funciones: ['guia', 'conductor'], carga: 0 }, { id: 2, nombre: 'Otro', funciones: ['guia'], carga: 9 }];
  const e = elegirPersonal(puestos, gente);
  assert.equal(e['conductor'], 1); assert.equal(e['balsa:1'], 2);
  const e2 = elegirPersonal(puestos, gente, new Set([2]));
  assert.equal(e2['balsa:1'], 1); assert.equal(e2['conductor'], undefined);
});

test('elegirPersonal: cubre los dos guías aunque los kayaks compitan por las mismas personas', () => {
  const puestos = puestosDe([{ id: 1, clase: 'balsa', nombre: 'B1' }, { id: 2, clase: 'balsa', nombre: 'B2' }]);
  const gente = [
    { id: 1, nombre: 'Nico', funciones: ['guia', 'seguridad'], carga: 0 }, { id: 2, nombre: 'Dani', funciones: ['guia'], carga: 1 },
    { id: 3, nombre: 'Eva', funciones: ['seguridad', 'guia'], carga: 2 }, { id: 4, nombre: 'Cami', funciones: ['conductor'], carga: 0 }
  ];
  const e = elegirPersonal(puestos, gente);
  assert.ok(e['balsa:1'] && e['balsa:2'], 'las dos balsas tienen guía');
  assert.equal(e['conductor'], 4);
  assert.equal(['kayak:1', 'kayak:2'].filter(k => e[k]).length, 1, 'con 4 personas solo alcanza para un kayak');
  assert.equal(new Set(Object.values(e)).size, Object.values(e).length, 'nadie ocupa dos puestos');
});

test('elegirPersonal: entre combinaciones equivalentes reparte con más equidad', () => {
  const puestos = puestosDe([{ id: 1, clase: 'balsa', nombre: 'B1' }]).filter(p => p.funcion === 'guia');
  const gente = [{ id: 1, nombre: 'Veterano', funciones: ['guia'], carga: 20 }, { id: 2, nombre: 'Nuevo', funciones: ['guia'], carga: 2 }];
  assert.equal(elegirPersonal(puestos, gente)['balsa:1'], 2);
});

test('choque: la sección completa ocupa la jornada', () => {
  const dia = [{ trabajador_id: 1, bajada_id: 10, tramo: 'seccion_completa' }, { trabajador_id: 2, bajada_id: 11, tramo: 'san_alfonso_melocoton' }];
  assert.match(choque(1, { id: 12, tramo: 'melocoton_san_jose' }, dia), /sección completa/);
  assert.equal(choque(1, { id: 10, tramo: 'seccion_completa' }, dia), null, 'no choca consigo misma');
  assert.match(choque(2, { id: 13, tramo: 'seccion_completa' }, dia), /ocupa la jornada/);
  assert.equal(choque(2, { id: 14, tramo: 'melocoton_san_jose' }, dia), null, 'dos bajadas normales el mismo día están bien');
  assert.equal(choque(3, { id: 15, tramo: 'seccion_completa' }, dia), null);
});

test('resumenPago: solo cuentan cerradas y pagadas; el estimado va aparte', () => {
  const r = resumenPago([
    { estado: 'cerrado', funcion: 'guia', tarifa: 35000 }, { estado: 'pagado', funcion: 'conductor', tarifa: 20000 },
    { estado: 'aceptado', funcion: 'guia', tarifa: 35000 }, { estado: 'asignado', funcion: 'seguridad', tarifa: 35000 },
    { estado: 'rechazado', funcion: 'guia', tarifa: 35000 }, { estado: 'borrador', funcion: 'guia', tarifa: null }
  ]);
  assert.equal(r.pagar, 55000); assert.equal(r.estimado, 70000); assert.equal(r.cerradas, 2);
  assert.deepEqual(r.porFuncion, { guia: 1, seguridad: 0, conductor: 1 });
});
