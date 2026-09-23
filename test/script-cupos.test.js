import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Guardas sobre script.js (sitio público, sin bundler): nacen de dos hallazgos reales.
//  1. La ventanilla de horarios podía mostrar disponibilidad vieja porque el fetch no pedía evitar el caché del
//     navegador; el reportado "5 cupos" para un día que en el servidor real ya estaban en 14/14/14 encajaba con eso.
//  2. Se pidió que, desde las 17:00 (hora de Chile, no la del navegador de quien mira el sitio), el aviso de cupos
//     muestre el día siguiente en vez de hoy.
const leer = f => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const scriptJs = leer('script.js'), indexHtml = leer('index.html');
const sinComentarios = scriptJs.replace(/\/\/.*$/gm, '');

test('las dos consultas de disponibilidad a la planilla evitan el caché del navegador', () => {
  // Los paréntesis anidados de la llamada hacen frágil una sola regex; se toma un tramo de código tras cada
  // ocurrencia de "fetch(sinCache(CUPOS_API" y se confirma que 'no-store' aparece antes del siguiente .then(.
  const inicios = [...sinComentarios.matchAll(/fetch\(sinCache\(CUPOS_API/g)].map(m => m.index);
  assert.equal(inicios.length, 2, 'una en el formulario (actualizarDisponibilidad) y otra en el aviso hoy/mañana');
  for (const i of inicios) {
    const tramo = sinComentarios.slice(i, sinComentarios.indexOf('.then(', i));
    assert.match(tramo, /cache:\s*'no-store'/, 'pide no-store, no solo el parámetro que cambia en cada consulta');
  }
});

test('sinCache() agrega un parámetro que cambia en cada llamada', () => {
  assert.match(sinComentarios, /function sinCache\(url\)\s*\{\s*return url \+.*Date\.now\(\)/);
});

test('el aviso de cupos decide hoy/mañana con la hora de Chile, no la del navegador de quien mira el sitio', () => {
  assert.match(sinComentarios, /timeZone:\s*'America\/Santiago'/);
  assert.match(sinComentarios, /horaCL\s*>=\s*17/, 'el umbral es las 17:00, la última salida del día');
  // No debe decidir con new Date().getHours() (hora local del visitante) para esto.
  const bloqueHoyManana = sinComentarios.slice(sinComentarios.indexOf('Cupos disponibles hoy / mañana'));
  assert.ok(!/new Date\(\)\.getHours\(\)/.test(bloqueHoyManana.slice(0, 800)));
});

test('el título del aviso cambia a "mañana" y el id existe en el HTML para poder cambiarlo', () => {
  assert.match(sinComentarios, /Cupos disponibles mañana/);
  assert.match(sinComentarios, /Spots available tomorrow/);
  assert.match(indexHtml, /id="cuposHoyTitulo"/);
});
