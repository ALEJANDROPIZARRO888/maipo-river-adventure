import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Guardas sobre los archivos de la app instalable. Nacen de un defecto real: los avisos no se podían activar al abrir la app
// como /app (sin barra final), porque navigator.serviceWorker.ready no se resuelve si la página está fuera del alcance (/app/).
const leer = f => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const appJs = leer('app/app.js'), indexHtml = leer('app/index.html'), manifest = JSON.parse(leer('app/manifest.webmanifest')), apiApp = leer('api/app.js');

test('la app no depende de navigator.serviceWorker.ready (no se resuelve fuera del alcance del service worker)', () => {
  assert.ok(!/serviceWorker\.ready/.test(appJs.replace(/\/\/.*$/gm, '')), 'usa el registro por alcance con swRegistro()');
  assert.match(appJs, /getRegistration\('\/app\/'\)/);
});

test('abrir /app sin la barra final lleva a /app/ antes de cargar nada', () => {
  assert.match(indexHtml, /location\.pathname === '\/app'/);
  assert.match(indexHtml, /location\.replace\('\/app\/'/);
  assert.ok(indexHtml.indexOf('location.replace') < indexHtml.indexOf('app.js'), 'la redirección corre antes que el resto');
});

test('el alcance del service worker, el manifiesto y la dirección de inicio coinciden en /app/', () => {
  assert.equal(manifest.scope, '/app/'); assert.equal(manifest.start_url, '/app/');
  assert.match(appJs, /register\('\/app\/sw\.js', \{ scope: '\/app\/' \}\)/);
});

test('los enlaces que se comparten (WhatsApp, correo de acceso) apuntan a /app/ y no a /app', () => {
  assert.ok(!/origin\}\/app\\n/.test(appJs), 'enlace de WhatsApp o copiar sin la barra final');
  assert.match(apiApp, /href="\$\{base\}\/app\/"/);
  assert.ok(!/href="\$\{base\}\/app"/.test(apiApp), 'correo con /app sin la barra final');
});
