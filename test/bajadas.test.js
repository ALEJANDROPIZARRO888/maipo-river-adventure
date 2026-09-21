import test from 'node:test';
import assert from 'node:assert/strict';
import { tramoClave, esKayak, salidaDeTexto } from '../api/_bajadas.js';

test('tramoClave reconoce tramos por etiqueta o por nombre de plan', () => {
  assert.equal(tramoClave('San Alfonso — Melocotón'), 'san_alfonso_melocoton');
  assert.equal(tramoClave('Melocotón — San José'), 'melocoton_san_jose');
  assert.equal(tramoClave('Sección completa'), 'seccion_completa');
  assert.equal(tramoClave('Rafting Extrema $45.000'), 'san_alfonso_melocoton');
  assert.equal(tramoClave('Rafting Power $35.000'), 'melocoton_san_jose');
  assert.equal(tramoClave('Rafting Full $60.000'), 'seccion_completa');
});

test('tramoClave devuelve null para kayak, por definir y vacíos', () => {
  for (const t of ['Clases de kayak', 'Por definir', '-', '', undefined]) assert.equal(tramoClave(t), null);
});

test('esKayak solo marca las clases de kayak, no el rafting', () => {
  assert.equal(esKayak({ tramo: 'Clases de kayak', plan: 'Pack kayak $60.000' }), true);
  assert.equal(esKayak({ tramo: 'Sección completa', plan: 'Rafting Full' }), false);
  assert.equal(esKayak({ tramo: '-', plan: 'Reserva manual' }), false);
});

test('salidaDeTexto lee el formato de los QR y rechaza el resto', () => {
  const ok = { fecha: '2026-10-18', horario: '14:00' };
  for (const t of ['2026-10-18-1400', '2026-10-18 14:00', '2026-10-18T1400', ' 2026-10-18_14:00 ']) assert.deepEqual(salidaDeTexto(t), ok);
  for (const t of ['18oct-1100', '2026-10-18-1530', '2026-10-18', 'sábado grupo colegio', '', undefined]) assert.equal(salidaDeTexto(t), null);
});
