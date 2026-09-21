'use strict';
// App del equipo de Maipo River Adventure. Sin dependencias ni paso de compilación: se edita y se publica tal cual.
// Secciones: utilidades · estado y API · avisos al celular · carga de datos · vistas · navegación · eventos · arranque.

// ------------------------------------------------------------------ utilidades
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clp = n => '$' + Number(n || 0).toLocaleString('es-CL');
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'], MES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const fdate = f => { const [y, m, d] = String(f).slice(0, 10).split('-').map(Number); return DIAS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] + ' ' + d + ' ' + MES[m - 1]; };
const sumaDias = (f, n) => { const [y, m, d] = f.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const plural = (n, a, b) => n + ' ' + (n === 1 ? a : b);
const FN = { guia: 'Guía de balsa', seguridad: 'Kayak de seguridad', conductor: 'Conductor / fotógrafo' };
const FN_C = { guia: 'Guía', seguridad: 'Kayak', conductor: 'Conductor' };
const FN_L = { guia: 'guía', seguridad: 'kayak de seguridad', conductor: 'conductor / fotógrafo' };
const VER = { guia: 'Ver mi bote', seguridad: 'Ver mi kayak', conductor: 'Ver mi turno' };
const TRAMOS = { san_alfonso_melocoton: 'San Alfonso — Melocotón', melocoton_san_jose: 'Melocotón — San José', seccion_completa: 'Sección completa' };
const ESTADO = { borrador: 'sin enviar', asignado: 'esperando respuesta', aceptado: 'aceptó', rechazado: 'rechazó', cerrado: 'cerrado', pagado: 'pagado' };
const SIN_CONDICION = /^(ninguna?|none|no|n\/a|-)$/i;
const conCondicion = m => !!m && !SIN_CONDICION.test(String(m).trim());
const store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  del: k => { try { localStorage.removeItem(k); } catch {} },
  limpiar: () => { try { Object.keys(localStorage).filter(k => k.startsWith('mra_c_') || k === 'mra_tok').forEach(k => localStorage.removeItem(k)); } catch {} }
};
const hora12 = t => new Date(t).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Santiago' });
const diaDe = t => new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/Santiago' });
const cuando = t => diaDe(t) === S.hoy ? hora12(t) : `${fdate(diaDe(t))} ${hora12(t)}`;

// ------------------------------------------------------------------ estado y API
const S = {
  token: store.get('mra_tok') || '', cuenta: null, vista: 'inicio', rev: -1, hoy: '', fecha: '', periodo: 'Semana', d: {}, equipo: [],
  avisos: -1, online: true, offline: false, error: '', clave: null, instalado: true, cargando: true, ocupado: false, push: 'desconocido', rutaPendiente: ''
};
const admin = () => !!S.cuenta && S.cuenta.tipo === 'admin';

async function pedir(method, url, body, opts = {}) {
  let r;
  try { r = await fetch(url, { method, headers: { 'Content-Type': 'application/json', ...(S.token && !opts.publico ? { Authorization: 'Bearer ' + S.token } : {}) }, body: body ? JSON.stringify(body) : undefined }); }
  catch { S.online = false; const e = new Error('Sin conexión'); e.sinRed = true; throw e; }
  S.online = true;
  if (r.status === 401 && !opts.publico) { cerrarSesion(); throw new Error('Tu sesión terminó. Vuelve a entrar.'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || 'Error ' + r.status); e.datos = j; e.estado = r.status; throw e; }
  return j;
}
// Lecturas: si no hay señal se muestra lo último que se vio (útil en el río). Solo para leer; guardar exige conexión.
async function leer(url) {
  const k = 'mra_c_' + (S.cuenta ? S.cuenta.id : 0) + url;
  try { const j = await pedir('GET', url); store.set(k, JSON.stringify(j)); S.offline = false; return j; }
  catch (e) { if (e.sinRed) { const c = store.get(k); if (c) { S.offline = true; return JSON.parse(c); } } throw e; }
}
const get = (a, p = {}) => leer('/api/app?' + new URLSearchParams({ a, ...p }));
const post = (accion, body = {}) => pedir('POST', '/api/app', { accion, ...body });
const errorTxt = e => e.sinRed ? 'Sin conexión: no se pudo guardar. Intenta de nuevo cuando vuelva la señal.' : e.message;

function cerrarSesion() { S.token = ''; S.cuenta = null; S.d = {}; S.equipo = []; S.rev = -1; S.avisos = -1; store.limpiar(); limpiarBadge(); render(); }

// Toque protegido: mientras algo se guarda no se acepta otro toque (evita publicar o cerrar dos veces).
async function correr(fn) {
  if (S.ocupado) return;
  S.ocupado = true; document.body.classList.add('ocupado');
  try { return await fn(); } finally { S.ocupado = false; document.body.classList.remove('ocupado'); }
}
async function ejecutar(fn, okMsg) {
  S.error = '';
  try { const r = await fn(); if (okMsg) aviso(okMsg); await refrescar(true); return r; }
  catch (e) { S.error = errorTxt(e); render(); return null; }
}

// ------------------------------------------------------------------ mensajes en pantalla
let toastT;
function aviso(titulo, texto = '', ruta = '') {
  const t = $('#toast'); t.innerHTML = `<b>${esc(titulo)}</b>${esc(texto)}`; t.hidden = false;
  if (ruta) t.dataset.ruta = ruta; else delete t.dataset.ruta;
  try { navigator.vibrate && navigator.vibrate([80, 40, 80]); } catch {}
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 6500);
}
// Cuadro propio en vez de prompt()/confirm() del navegador (se ve mal y a veces se bloquea en apps instaladas).
function dialogo({ titulo, texto = '', campo = null, si = 'Aceptar', no = 'Cancelar', lista = null }) {
  return new Promise(res => {
    const d = $('#dlg');
    d.innerHTML = `<form method="dialog"><h3>${esc(titulo)}</h3>${texto ? `<p>${esc(texto)}</p>` : ''}
      ${lista ? `<ul>${lista.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      ${campo ? `<label for="dlgv">${esc(campo)}</label><textarea id="dlgv" maxlength="300"></textarea>` : ''}
      <div class="row"><button value="si" type="submit">${esc(si)}</button>${no ? `<button class="ghost" value="no" type="submit">${esc(no)}</button>` : ''}</div></form>`;
    d.onclose = () => res(d.returnValue === 'si' ? (campo ? ($('#dlgv') ? $('#dlgv').value : '') : true) : null);
    d.showModal();
  });
}

// ------------------------------------------------------------------ avisos al celular (Web Push)
const esIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const instalada = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const puedePush = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const urlB64 = s => { const p = '='.repeat((4 - s.length % 4) % 4), b = (s + p).replace(/-/g, '+').replace(/_/g, '/'); return Uint8Array.from(atob(b), c => c.charCodeAt(0)); };
const igual = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// activo · pendiente (falta activarlos) · bloqueado · instalar (iPhone sin instalar) · no-soportado
async function estadoPush() {
  if (!puedePush()) return esIOS && !instalada() ? 'instalar' : 'no-soportado';
  if (Notification.permission === 'denied') return 'bloqueado';
  if (Notification.permission !== 'granted') return 'pendiente';
  try { const reg = await navigator.serviceWorker.ready; return (await reg.pushManager.getSubscription()) ? 'activo' : 'pendiente'; } catch { return 'pendiente'; }
}
async function suscribirse() {
  const reg = await navigator.serviceWorker.ready;
  const { clave } = await pedir('GET', '/api/app?a=push_clave'), key = urlB64(clave);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !(sub.options && sub.options.applicationServerKey && igual(new Uint8Array(sub.options.applicationServerKey), key))) { await sub.unsubscribe(); sub = null; }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await post('push_suscribir', { sub: sub.toJSON() });
}
// Al abrir la app, si los avisos ya estaban permitidos se vuelve a registrar este teléfono (por si cambió de cuenta o se reinició la base).
async function sincronizarPush() {
  try { if (puedePush() && Notification.permission === 'granted') await suscribirse(); } catch {}
  S.push = await estadoPush(); render();
}
async function activarAvisos() {
  try {
    const perm = await Notification.requestPermission();
    if (perm === 'granted') { await suscribirse(); aviso('Avisos activados', 'Te llegarán al celular aunque la app esté cerrada.'); }
  } catch (e) { S.error = 'No se pudieron activar los avisos: ' + errorTxt(e); }
  S.push = await estadoPush(); render();
}
async function desactivarAvisos() {
  try { const reg = await navigator.serviceWorker.ready, sub = await reg.pushManager.getSubscription(); if (sub) { await post('push_baja', { endpoint: sub.endpoint }); await sub.unsubscribe(); } } catch {}
  S.push = await estadoPush(); render();
}
// Al cerrar sesión el teléfono se desvincula, para que quien use después este celular no reciba los avisos de otra persona.
async function desvincularPush() {
  try { if (puedePush()) { const reg = await navigator.serviceWorker.ready, sub = await reg.pushManager.getSubscription(); if (sub) await post('push_baja', { endpoint: sub.endpoint }); } } catch {}
}
const ocultoAvisos = () => Date.now() - Number(store.get('mra_push_no') || 0) < 3 * 864e5;
function limpiarBadge() { try { navigator.clearAppBadge && navigator.clearAppBadge(); } catch {} }
function ponerBadge(n) { try { if (n > 0) navigator.setAppBadge && navigator.setAppBadge(n); else limpiarBadge(); } catch {} }
// Con la app a la vista, los avisos que dejó el sistema en la bandeja ya no hacen falta.
async function limpiarBandeja() {
  try { if (document.hidden || !('serviceWorker' in navigator)) return; const reg = await navigator.serviceWorker.getRegistration('/app/'); if (reg) (await reg.getNotifications()).forEach(n => n.close()); } catch {}
}

function bannerAvisos() {
  const p = S.push, quien = admin() ? 'cada reserva nueva de la web, cuando alguien acepta o rechaza una bajada y cuando llegan las fichas' : 'cada solicitud de bajada y cuando te pagan';
  if (p === 'pendiente' && !ocultoAvisos()) return `<div class="hero"><div class="tag">Recomendado</div><div class="grande-txt">Activa los avisos</div>
    <p>Así te enteras al instante de ${quien}, <b>aunque no tengas la app abierta</b>.</p>
    <div class="row"><button class="grande" data-a="activarAvisos">Activar avisos en este teléfono</button><button class="ghost" data-a="ahoraNo">Ahora no</button></div></div>`;
  if (p === 'instalar') return `<div class="hero"><div class="tag">Para recibir avisos en iPhone</div><div class="grande-txt">Instala la app primero</div>
    <ol class="small"><li>Toca el botón <b>Compartir</b> del navegador (el cuadrado con la flecha).</li><li>Elige <b>Agregar a pantalla de inicio</b>.</li><li>Abre <b>Maipo River</b> desde el ícono nuevo y activa los avisos.</li></ol></div>`;
  if (p === 'bloqueado') return `<div class="warn"><b>Los avisos están bloqueados</b> en este navegador. Para recibirlos, permite las notificaciones de esta página en los ajustes del navegador y vuelve a abrir la app.</div>`;
  return '';
}

// ------------------------------------------------------------------ carga por vista
const rango = p => {
  const h = S.hoy;
  if (p === 'Día') return [h, h];
  const [y, m, d] = h.split('-').map(Number);
  if (p === 'Semana') { const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; const ini = sumaDias(h, -dow); return [ini, sumaDias(ini, 6)]; }
  return [new Date(Date.UTC(y, m - 1, 1)).toISOString().slice(0, 10), new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)];
};
async function cargarVista() {
  const v = S.vista, d = S.d;
  if (v.startsWith('turno:')) { d.turno = await get('turno', { id: v.slice(6) }); return; }
  if (v === 'perfil') return;
  if (admin()) {
    if (v === 'inicio') { [d.dia, d.avisos] = await Promise.all([get('dia', { fecha: S.hoy }), get('avisos')]); }
    else if (v === 'armar') { [d.dia, S.equipo] = await Promise.all([get('dia', { fecha: S.fecha }), get('equipo').then(x => x.equipo)]); }
    else if (v === 'reservas') d.reservas = (await leer('/api/reservas')).reservas;
    else if (v === 'equipo') S.equipo = (await get('equipo')).equipo;
    else if (v === 'pagos') { const [a, b] = rango(S.periodo); d.pagos = await get('pagos', { desde: a, hasta: b }); }
    else if (v === 'avisos') d.avisos = await get('avisos');
  } else {
    if (v === 'inicio') {
      const [a, b] = rango(S.periodo);
      [d.turnos, d.periodo] = await Promise.all([get('turnos', { desde: S.hoy, hasta: sumaDias(S.hoy, 30) }), get('turnos', { desde: a, hasta: b })]);
    } else if (v === 'agenda') d.turnos = await get('turnos', { desde: S.hoy, hasta: sumaDias(S.hoy, 30) });
    else if (v === 'pagos') { const [a, b] = rango(S.periodo); d.periodo = await get('turnos', { desde: a, hasta: b }); }
    else if (v === 'avisos') d.avisos = await get('avisos');
  }
}
const editando = () => { const a = document.activeElement; return a && ['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName) && a.closest('#vista'); };
let pendiente = false;
async function refrescar(forzar) {
  if (!S.token) return;
  try {
    const y = await get('yo');
    S.cuenta = y.cuenta; S.hoy = y.hoy; if (!S.fecha) S.fecha = y.hoy;
    if (y.avisos > S.avisos && S.avisos >= 0 && S.vista !== 'avisos') {
      const u = (await get('avisos')).avisos.find(a => !a.leido); if (u) aviso(u.titulo, u.cuerpo || '', u.ruta || '');
    }
    S.avisos = y.avisos; S.rev = y.rev;
    await cargarVista();
  } catch (e) {
    if (e.estado === 404 && S.vista.startsWith('turno:')) {
      // El turno ya no existe o no es tuyo (por ejemplo un aviso viejo): se vuelve al inicio en vez de dejar una pantalla vacía.
      S.vista = 'inicio'; S.error = 'Ese turno ya no está disponible.';
      try { await cargarVista(); } catch {}
    } else if (!e.sinRed) S.error = errorTxt(e);
  }
  S.cargando = false;
  if (!forzar && editando()) { pendiente = true; return; }
  render(); limpiarBandeja();
}
async function pulso() {
  if (!S.token || document.hidden || S.ocupado) return;
  try {
    const { rev } = await pedir('GET', '/api/app?a=rev');
    if (rev !== S.rev) await refrescar(false); else if (S.offline) await refrescar(false);
    S.online = true;
  } catch { S.online = false; }
  ponerVivo();
}
function ponerVivo() { const v = $('.vivo'); if (v) { v.classList.toggle('off', !S.online); v.lastChild.textContent = S.online ? 'En vivo' : 'Sin conexión'; } }

// ------------------------------------------------------------------ vistas: piezas comunes
function cabecera() {
  const c = S.cuenta, ini = c.nombre.split(/\s+/).map(x => x[0]).slice(0, 2).join('').toUpperCase();
  return `<header><div class="marca">Maipo River<small>${admin() ? 'Administración' : (c.funciones || []).map(f => FN_C[f]).join(' · ')} · ${esc(c.nombre.split(' ')[0])}</small></div>
    <span class="vivo${S.online ? '' : ' off'}"><i></i>${S.online ? 'En vivo' : 'Sin conexión'}</span>
    ${admin() ? `<button class="ib txt" data-a="ir" data-v="avisos" aria-label="Avisos${S.avisos > 0 ? ': ' + S.avisos + ' sin leer' : ''}">Avisos${S.avisos > 0 ? `<span class="n">${S.avisos}</span>` : ''}</button>` : ''}
    <button class="ib av" data-a="ir" data-v="perfil" aria-label="Mi perfil">${esc(ini)}</button></header>${S.offline ? '<div class="off-banner" role="status">Sin señal: mostrando lo último que viste</div>' : ''}`;
}
function menu() {
  const items = admin() ? [['inicio', 'Inicio'], ['armar', 'Armar'], ['reservas', 'Reservas'], ['equipo', 'Equipo'], ['pagos', 'Pagos']]
    : [['inicio', 'Inicio'], ['agenda', 'Agenda'], ['pagos', 'Pagos'], ['avisos', 'Avisos']];
  const base = S.vista.startsWith('turno:') ? 'inicio' : S.vista;
  return `<nav aria-label="Secciones">${items.map(([v, t]) => `<button data-a="ir" data-v="${v}" aria-current="${base === v}">${t}${!admin() && v === 'avisos' && S.avisos > 0 ? `<span class="n">${S.avisos}</span>` : ''}</button>`).join('')}</nav>`;
}
const errBox = () => S.error ? `<div class="err" role="alert">${esc(S.error)}</div>` : '';
const cargandoTxt = '<p class="muted" role="status">Cargando…</p>';

// Consejos de primer uso: 3 pasos, se cierran una vez y no vuelven.
function consejo() {
  const k = 'mra_tip_' + (admin() ? 'a' : 't'); if (store.get(k)) return '';
  const pasos = admin()
    ? ['En <b>Equipo</b> agrega a tu gente: cada persona recibe su usuario y clave.', 'Cuando llega una reserva te avisamos. En <b>Armar</b> toca <b>Armar automáticamente</b>.', 'Revisa y toca <b>Avisar al equipo</b>: cada persona recibe su solicitud en el celular.']
    : ['Cuando el administrador te asigne una bajada, <b>te llega un aviso</b> al celular.', 'Toca <b>Aceptar</b> o <b>No puedo</b>. Si aceptas, se abre tu turno con la lista de tu bote.', 'Al terminar, <b>cierra la bajada</b> en tu turno: así queda sumada a tu pago.'];
  return `<div class="tip"><b>Cómo funciona</b><ol>${pasos.map(p => `<li>${p}</li>`).join('')}</ol><div class="row"><button class="ghost" data-a="cerrarTip">Entendido</button></div></div>`;
}

// ---- Avisos (centro de avisos: cada uno lleva a su pantalla)
function avisoHtml(a) {
  return `<div class="card tocable ${a.leido ? '' : 'acento'}" data-a="abrirAviso" data-id="${a.id}" data-ruta="${esc(a.ruta || '')}" role="button" tabindex="0">
    <div class="head"><b>${esc(a.titulo)}</b><span class="tag">${esc(cuando(a.creada))}</span></div>
    ${a.cuerpo ? `<div class="muted">${esc(a.cuerpo)}</div>` : ''}${a.ruta ? '<div class="tag" style="margin-top:6px">Tocar para abrir ›</div>' : ''}</div>`;
}
function vAvisos() {
  const l = S.d.avisos ? S.d.avisos.avisos : [];
  return `<h1>Avisos</h1>${l.some(a => !a.leido) ? '<div class="row"><button class="ghost" data-a="leidoTodos">Marcar todo como leído</button></div>' : ''}
    ${l.length ? l.map(avisoHtml).join('') : '<p class="muted">Sin avisos por ahora. Aquí aparece cada solicitud, cada reserva nueva y cada cambio.</p>'}`;
}

// ---- Inicio del admin
function vInicioAdmin() {
  const d = S.d.dia; if (!d) return cargandoTxt;
  const r = d.resumen, av = (S.d.avisos ? S.d.avisos.avisos : []).filter(a => !a.leido).slice(0, 4);
  return `<h1>Hoy · ${esc(fdate(S.hoy))}</h1>${errBox()}${bannerAvisos()}${consejo()}
    <div class="stats"><div class="stat"><b>${r.salidas}</b><span class="muted">${r.salidas === 1 ? 'bajada' : 'bajadas'}</span></div><div class="stat"><b>${r.pasajeros}</b><span class="muted">reservados</span></div><div class="stat"><b>${r.fichas}</b><span class="muted">fichas</span></div></div>
    ${d.reservasNuevas ? `<div class="info"><b>${plural(d.reservasNuevas, 'reserva nueva', 'reservas nuevas')}</b> por confirmar. <a href="#" data-a="ir" data-v="reservas">Ver reservas</a></div>` : ''}
    ${av.length ? `<h2>Sin leer</h2>${av.map(avisoHtml).join('')}<div class="row"><button class="ghost" data-a="ir" data-v="avisos">Ver todos los avisos</button></div>` : ''}
    <h2>Bajadas de hoy</h2>
    ${d.salidas.length ? d.salidas.map(s => { const acp = s.puestos.filter(p => p.turno && ['aceptado', 'cerrado', 'pagado'].includes(p.turno.estado)).length, tot = s.puestos.filter(p => p.turno).length;
      return `<div class="card"><div class="head"><b>${esc(s.horario)} · ${esc(s.tramoEtiqueta || (Object.keys(s.porTramo).length > 1 ? 'Bajada mixta' : 'Tramo por confirmar'))}</b><span class="tag st-${esc(s.estado)}">${esc(s.estado)}</span></div>
        <div>${plural(s.reservadas, 'persona', 'personas')} de ${s.cupo} · ${plural(s.fichas, 'ficha llena', 'fichas llenas')}</div>
        <div class="bar"><i style="width:${Math.min(100, s.reservadas / s.cupo * 100)}%"></i></div>
        <div class="muted small">Equipo: ${tot ? `${acp} de ${tot} confirmaron` : 'sin asignar todavía'}</div>
        <div class="row"><button data-a="armarDia" data-f="${esc(S.hoy)}">Armar esta bajada</button></div></div>`; }).join('') : '<p class="muted">No hay bajadas hoy. Aparecen solas cuando llega una reserva de rafting.</p>'}`;
}

// ---- Armar (admin): pasos claros y un solo botón principal
function selPersonal(s, p) {
  const t = p.turno, otros = new Set(s.puestos.filter(x => x.turno && x.puesto !== p.puesto).map(x => x.turno.trabajador_id));
  const ops = S.equipo.filter(c => c.tipo === 'trabajador' && c.activa && c.funciones.includes(p.funcion));
  const bloqueado = t && ['cerrado', 'pagado'].includes(t.estado);
  return `<select data-c="puesto" data-sid="${s.id}" data-p="${esc(p.puesto)}" aria-label="${esc(FN_C[p.funcion] + ' ' + p.etiqueta)}"${bloqueado ? ' disabled' : ''}><option value="">Sin asignar</option>${ops.map(c =>
    `<option value="${c.id}"${t && t.trabajador_id === c.id ? ' selected' : ''}${otros.has(c.id) ? ' disabled' : ''}>${esc(c.nombre)} (${c.carga})${otros.has(c.id) ? ' · ocupado' : ''}</option>`).join('')}</select>`;
}
function filaFicha(f, s) {
  const tags = [f.menor ? 'MENOR' : '', f.sabe_nadar === false ? 'NO SABE NADAR' : '', conCondicion(f.medico) ? 'MÉDICO' : ''].filter(Boolean).join(' · ');
  return `<div class="pax row between" style="margin:0"><span><b>${esc(f.nombre)}</b> <span class="muted small">${f.edad ?? '?'} años · ${esc(f.idioma || '')}</span>${tags ? ` <span class="tag">${tags}</span>` : ''}${conCondicion(f.medico) ? `<br><span class="muted small">${esc(f.medico)}</span>` : ''}</span>
    <select data-c="bote" data-fid="${f.id}" aria-label="Balsa de ${esc(f.nombre)}"><option value="">Sin balsa</option>${s.botes.map(b => `<option value="${b.id}"${f.bote_id === b.id ? ' selected' : ''}>${esc(b.nombre)} (${b.fichas.length}/${b.capacidad})</option>`).join('')}</select></div>`;
}
// Qué falta para poder avisar al equipo, en tres pasos que se entienden de un vistazo.
function pasos(s) {
  const nec = new Set(s.balsasNecesarias), req = s.puestos.filter(p => p.funcion !== 'guia' || nec.has(p.bote_id));
  const cubiertos = req.filter(p => p.turno).length, sinGuia = req.filter(p => p.funcion === 'guia' && !p.turno);
  const pend = s.puestos.filter(p => p.turno && p.turno.estado === 'borrador').length, enviados = s.puestos.filter(p => p.turno && p.turno.estado !== 'borrador' && p.turno.estado !== 'rechazado').length;
  const acp = s.puestos.filter(p => p.turno && ['aceptado', 'cerrado', 'pagado'].includes(p.turno.estado)).length;
  const p1 = s.fichas === 0 ? { est: 'espera', t: 'Pasajeros en balsas', d: 'Aún no llegan fichas: cada pasajero la llena desde su correo o el QR de la base.' }
    : s.sinBote.length ? { est: 'falta', t: 'Pasajeros en balsas', d: `${plural(s.sinBote.length, 'pasajero sin balsa', 'pasajeros sin balsa')}.` }
    : { est: 'ok', t: 'Pasajeros en balsas', d: `${plural(s.fichas, 'pasajero repartido', 'pasajeros repartidos')}.` };
  const p2 = sinGuia.length ? { est: 'falta', t: 'Equipo', d: `Falta guía en ${sinGuia.map(x => x.etiqueta).join(', ')}.` }
    : cubiertos < req.length ? { est: 'espera', t: 'Equipo', d: `${cubiertos} de ${req.length} puestos cubiertos (faltan ${req.filter(p => !p.turno).map(x => x.etiqueta).join(', ')}).` }
    : { est: 'ok', t: 'Equipo', d: `${cubiertos} de ${req.length} puestos cubiertos.` };
  const p3 = pend ? { est: 'falta', t: 'Avisar al equipo', d: `${plural(pend, 'persona espera', 'personas esperan')} su solicitud.` }
    : enviados ? { est: acp === enviados ? 'ok' : 'espera', t: 'Avisar al equipo', d: `${acp} de ${enviados} ya confirmaron.` }
    : { est: 'espera', t: 'Avisar al equipo', d: 'Aún no se envían solicitudes.' };
  return { lista: [p1, p2, p3], pend, sinGuia: sinGuia.length, faltaEquipo: cubiertos < req.length, sinBote: s.fichas > 0 && s.sinBote.length > 0, nadie: !s.puestos.some(p => p.turno) };
}
const ICONO = { ok: '✓', falta: '!', espera: '…' };
function salidaArmar(s) {
  const nec = new Set(s.balsasNecesarias), pa = pasos(s);
  const puesto = p => { const t = p.turno, opc = p.funcion === 'guia' && !nec.has(p.bote_id);
    return `<div class="row between" style="margin:6px 0"><span>${esc(FN_C[p.funcion])} · ${esc(p.etiqueta)}${opc ? ' <span class="muted small">(sin pasajeros: opcional)</span>' : ''}${t ? ` <span class="tag st-${esc(t.estado)}">${esc(ESTADO[t.estado])}</span>` : ''}</span>${selPersonal(s, p)}</div>`; };
  const tr = Object.entries(s.porTramo);
  // Un solo botón principal que cambia según lo que falte.
  let principal = '';
  if (pa.pend) principal = `<button class="ok grande" data-a="publicar" data-sid="${s.id}">Avisar al equipo (${pa.pend})</button>`;
  else if (pa.nadie || pa.faltaEquipo || pa.sinBote) principal = `<button class="grande" data-a="auto" data-sid="${s.id}">${pa.nadie ? 'Armar automáticamente' : 'Completar automáticamente'}</button>`;
  const secundario = pa.pend || (!pa.nadie && !pa.faltaEquipo && !pa.sinBote) ? `<button class="ghost" data-a="auto" data-sid="${s.id}">Repartir de nuevo automáticamente</button>` : '';
  return `<div class="card${s.estado === 'suspendida' ? ' cancelada' : ''}">
    <div class="head"><b>${esc(s.horario)} · ${esc(s.tramoEtiqueta || (tr.length > 1 ? 'Bajada mixta' : 'Tramo por confirmar'))}</b><span class="tag st-${esc(s.estado)}">${esc(s.estado)}</span></div>
    <div><b>${s.reservadas}</b> de ${s.cupo} cupos</div><div class="bar"><i style="width:${Math.min(100, s.reservadas / s.cupo * 100)}%"></i></div>
    ${tr.length ? `<div class="muted small">${tr.map(([k, n]) => n + ' en ' + esc(TRAMOS[k])).join(' · ')}</div>` : ''}
    ${s.publicada_por ? `<div class="muted small">Publicada por ${esc(s.publicada_por)}</div>` : ''}
    ${s.alertas.includes('sobrecupo') ? '<div class="warn">Hay más personas reservadas que cupos en esta bajada.</div>' : ''}
    ${s.alertas.includes('choque_seccion_completa') ? '<div class="warn">La sección completa sale a las 11:00 y ocupa el día, pero hay otra bajada o reserva ese mismo día.</div>' : ''}
    ${s.rechazos.map(r => `<div class="warn"><b>${esc(r.nombre)}</b> rechazó ${esc(FN_L[r.funcion])}${r.motivo_rechazo ? ': “' + esc(r.motivo_rechazo) + '”' : ''}. Elige un reemplazo abajo.</div>`).join('')}
    <ul class="pasos" aria-label="Pasos para armar la bajada">${pa.lista.map(x => `<li class="paso ${x.est}"><span class="ico" aria-hidden="true">${ICONO[x.est]}</span><span><b>${esc(x.t)}</b><span class="muted small">${esc(x.d)}</span></span></li>`).join('')}</ul>
    <div class="row">${principal}${secundario}</div>
    <details${pa.faltaEquipo || pa.sinGuia || (s.rechazos.length && pa.faltaEquipo) ? ' open' : ''}><summary><b>Equipo de esta bajada</b></summary>${s.puestos.map(puesto).join('')}</details>
    <details${pa.sinBote ? ' open' : ''}><summary><b>Pasajeros y balsas</b></summary>
      ${s.botes.map(b => `<div style="margin:8px 0 2px"><b>${esc(b.nombre)}</b> · ${b.fichas.length} de ${b.capacidad}</div>${b.fichas.length ? b.fichas.map(f => filaFicha(f, s)).join('') : '<div class="muted small">Nadie asignado todavía.</div>'}`).join('')}
      ${s.sinBote.length ? `<div style="margin:10px 0 2px"><b>Sin balsa (${s.sinBote.length})</b></div>${s.sinBote.map(f => filaFicha(f, s)).join('')}` : ''}</details>
  </div>`;
}
function vArmar() {
  const d = S.d.dia; if (!d) return cargandoTxt;
  return `<h1>Armar bajadas</h1>
    <div class="row"><button class="ghost" data-a="dia" data-n="-1" aria-label="Día anterior">‹</button><input type="date" id="fdia" value="${esc(S.fecha)}" style="flex:1;min-width:140px" data-c="fecha" aria-label="Fecha"><button class="ghost" data-a="dia" data-n="1" aria-label="Día siguiente">›</button><button class="ghost" data-a="dia" data-n="0">Hoy</button></div>
    ${errBox()}
    ${d.salidas.length ? d.salidas.map(salidaArmar).join('') : `<p class="muted">No hay bajadas el ${esc(fdate(S.fecha))}. Aparecen solas cuando llega una reserva de rafting.</p>`}
    ${d.sinSalida.length ? `<div class="card"><div class="head"><b>Fichas sin bajada (${d.sinSalida.length})</b></div><p class="muted small">Llegaron por QR sin reserva. Asígnalas a una bajada de este día.</p>${d.sinSalida.map(f => `<div class="row between" style="margin:4px 0"><span><b>${esc(f.nombre)}</b> <span class="muted small">${f.edad ?? '?'} años${f.salida ? ' · ' + esc(f.salida) : ''}</span></span>
      ${d.salidas.length ? `<select data-c="asig" data-fid="${f.id}" aria-label="Bajada de ${esc(f.nombre)}"><option value="">Asignar a…</option>${d.salidas.map(s => `<option value="${s.id}">${esc(s.horario)}</option>`).join('')}</select>` : ''}</div>`).join('')}</div>` : ''}`;
}

// ---- Reservas (admin)
function vReservas() {
  const l = S.d.reservas; if (!l) return cargandoTxt;
  const filas = l.filter(r => r.estado !== 'cancelada' && r.estado !== 'completada' && r.fecha.slice(0, 10) >= S.hoy);
  return `<h1>Reservas</h1><p class="muted small">Próximas y activas. Llegan solas desde la web y te avisamos.</p>${errBox()}
    ${filas.length ? filas.map(r => { const nueva = Date.now() - new Date(r.creada) < 15 * 60e3;
      return `<div class="card${nueva ? ' acento' : ''}"><div class="head"><b>${esc(r.nombre)}</b><span class="tag st-${esc(r.estado)}">${nueva ? 'NUEVA · ' : ''}${esc(r.estado)}${r.origen === 'manual' ? ' · manual' : ''}</span></div>
      <div><b>${esc(fdate(r.fecha))}</b> · ${esc(r.horario)} · ${esc(r.tramo)}</div>
      <div class="muted small">${plural(r.personas, 'persona', 'personas')} · ${clp(r.monto)} estimado · <a href="tel:${esc(r.telefono)}">${esc(r.telefono)}</a></div>
      <div><b>${r.fichas} de ${r.personas}</b> fichas llenas</div>${r.comentarios ? `<div class="muted small">“${esc(r.comentarios)}”</div>` : ''}
      <div class="row">${r.estado !== 'confirmada' ? `<button data-a="rsv" data-id="${r.id}" data-e="confirmada">Confirmar</button>` : ''}
        <button class="ghost" data-a="rsv" data-id="${r.id}" data-e="cancelada" data-n="${esc(r.nombre)}">Cancelar</button>
        <button class="ghost" data-a="copiar" data-t="${esc(location.origin + '/fichapasajero?r=' + r.token)}">Copiar link de ficha</button></div></div>`; }).join('') : '<p class="muted">No hay reservas próximas.</p>'}`;
}

// ---- Equipo (admin)
function vEquipo() {
  const l = S.equipo, nuevo = S.clave;
  const card = c => `<div class="card" style="${c.activa ? '' : 'opacity:.6'}"><div class="head"><b>${esc(c.nombre)}</b><span>${c.es_maestra ? '<span class="pill">Maestra</span> ' : ''}${c.tipo === 'admin' ? `<span class="pill">${c.verificada ? 'Verificada' : 'Sin verificar'}</span>` : ''}${c.activa ? '' : ' <span class="tag st-cancelada">de baja</span>'}</span></div>
    <div class="muted small">@${esc(c.usuario)}${c.correo ? ' · ' + esc(c.correo) : ''}${c.telefono ? ' · ' + esc(c.telefono) : ''}</div>
    ${c.tipo === 'trabajador' ? `<div class="chips" style="margin-top:8px">${Object.keys(FN).map(f => `<button class="chip" aria-pressed="${c.funciones.includes(f)}" data-a="fn" data-id="${c.id}" data-f="${f}">${esc(FN_C[f])}</button>`).join('')}</div>
      <div class="muted small">${plural(c.mes, 'bajada', 'bajadas')} este mes · ${plural(c.carga, 'acumulada', 'acumuladas')}</div>` : ''}
    <div class="row">${c.es_maestra ? '' : `<button class="ghost" data-a="baja" data-id="${c.id}" data-on="${c.activa ? 0 : 1}" data-n="${esc(c.nombre)}">${c.activa ? 'Dar de baja' : 'Reactivar'}</button>`}
      <button class="ghost" data-a="reset" data-id="${c.id}" data-n="${esc(c.nombre)}">Nueva clave</button>
      ${c.tipo === 'admin' && S.cuenta.es_maestra && !c.es_maestra ? `<button class="ghost" data-a="verificar" data-id="${c.id}" data-on="${c.verificada ? 0 : 1}">${c.verificada ? 'Quitar verificación' : 'Verificar'}</button>` : ''}</div></div>`;
  const chipsFn = Object.keys(FN).map(f => `<label class="chip"><input type="checkbox" name="fn" value="${f}"> ${esc(FN_C[f])}</label>`).join('');
  return `<h1>Equipo</h1>${errBox()}
    ${nuevo ? `<div class="card acento"><div class="head"><b>Acceso listo</b></div><p>Entrégale estos datos a <b>${esc(nuevo.nombre)}</b>. La clave se muestra una sola vez.</p>
      <p style="font-size:18px">Usuario: <b>${esc(nuevo.usuario)}</b><br>Clave: <b>${esc(nuevo.clave)}</b></p>${nuevo.correoEnviado ? '<p class="muted small">También se la enviamos por correo.</p>' : ''}
      <div class="row"><button data-a="copiar" data-t="${esc(`Maipo River — entra a ${location.origin}/app\nUsuario: ${nuevo.usuario}\nClave: ${nuevo.clave}`)}">Copiar</button>
      <a class="tag" style="align-self:center" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(`Hola ${nuevo.nombre.split(' ')[0]}! Entra a ${location.origin}/app\nUsuario: ${nuevo.usuario}\nClave: ${nuevo.clave}`)}">Enviar por WhatsApp</a>
      <button class="ghost" data-a="cerrarClave">Listo</button></div></div>` : ''}
    <details class="card"><summary><b>Agregar colaborador</b></summary>
      <form data-f="nuevoMiembro"><label for="nm-nombre">Nombre completo</label><input id="nm-nombre" name="nombre" required autocomplete="off">
        <div class="grid2"><div><label for="nm-tel">Teléfono</label><input id="nm-tel" name="telefono" inputmode="tel"></div><div><label for="nm-mail">Correo</label><input id="nm-mail" name="correo" type="email"></div></div>
        ${S.cuenta.es_maestra ? `<label for="nm-tipo">Tipo de cuenta</label><select id="nm-tipo" name="tipo"><option value="trabajador">Trabajador</option><option value="admin">Administración (socio)</option></select>` : ''}
        <label>Funciones que puede cumplir</label><div class="chips">${chipsFn}</div>
        <div class="row"><button type="submit">Crear acceso</button></div></form></details>
    <h2>Trabajadores</h2>${l.filter(c => c.tipo === 'trabajador').map(card).join('') || '<p class="muted">Aún no hay trabajadores. Agrega el primero arriba.</p>'}
    <h2>Administración</h2>${l.filter(c => c.tipo === 'admin').map(card).join('')}`;
}

// ---- Pagos
function selPeriodo() { return `<div class="chips">${['Día', 'Semana', 'Mes'].map(p => `<button class="chip" aria-pressed="${S.periodo === p}" data-a="periodo" data-p="${p}">${p}</button>`).join('')}</div>`; }
function vPagosAdmin() {
  const p = S.d.pagos; if (!p) return cargandoTxt;
  return `<h1>Pagos</h1>${selPeriodo()}<p class="muted small">${esc(fdate(p.desde))} al ${esc(fdate(p.hasta))}. Solo cuentan las bajadas cerradas; lo demás es estimado.</p>${errBox()}
    <div class="stats"><div class="stat"><b>${clp(p.total.porPagar)}</b><span class="muted">por pagar</span></div><div class="stat"><b>${clp(p.total.pagado)}</b><span class="muted">pagado</span></div><div class="stat"><b>${clp(p.total.estimado)}</b><span class="muted">estimado</span></div></div>
    ${p.filas.length ? `<div class="card"><table><tr><th>Persona</th><th>G</th><th>K</th><th>C</th><th>Por pagar</th></tr>${p.filas.map(f => `<tr><td>${esc(f.nombre)}</td><td>${f.guia}</td><td>${f.seguridad}</td><td>${f.conductor}</td><td>${clp(f.porPagar)}</td></tr>`).join('')}</table>
      <p class="muted small">G guía · K kayak de seguridad · C conductor/fotógrafo</p></div>
      ${p.filas.filter(f => f.porPagar > 0).map(f => `<div class="row between"><span><b>${esc(f.nombre)}</b> ${clp(f.porPagar)}</span><button class="ok" data-a="pagar" data-id="${f.id}" data-n="${esc(f.nombre)}" data-m="${f.porPagar}">Marcar pagado</button></div>`).join('')}` : '<p class="muted">Sin bajadas en este período.</p>'}`;
}
function vPagosTrab() {
  const p = S.d.periodo; if (!p) return cargandoTxt;
  const r = p.resumen;
  return `<h1>Mis pagos</h1>${selPeriodo()}
    <div class="stats"><div class="stat"><b>${clp(r.pagar)}</b><span class="muted">a pagar</span></div><div class="stat"><b>${r.cerradas}</b><span class="muted">${r.cerradas === 1 ? 'bajada' : 'bajadas'}</span></div><div class="stat"><b>${clp(r.estimado)}</b><span class="muted">estimado</span></div></div>
    <p class="muted small">${r.porFuncion.guia} guía · ${r.porFuncion.seguridad} kayak · ${r.porFuncion.conductor} apoyo. El estimado no cuenta hasta que cierres la bajada.</p>
    ${p.turnos.length ? p.turnos.filter(t => t.estado !== 'rechazado').map(t => { const cuenta = ['cerrado', 'pagado'].includes(t.estado);
      return `<div class="card" style="${cuenta ? '' : 'opacity:.6'}"><div class="head"><b>${esc(fdate(t.fecha))} · ${esc(t.horario)}</b><b>${cuenta ? '' : '≈ '}${clp(t.tarifa)}</b></div>
        <div class="muted small">${esc(FN_C[t.funcion])} · ${esc(t.tramoEtiqueta || 'tramo por confirmar')} · <span class="st-${esc(t.estado)}">${esc(t.estado)}</span>${cuenta ? '' : ' · no cuenta aún'}</div></div>`; }).join('') : '<p class="muted">Sin bajadas en este período.</p>'}`;
}

// ---- Trabajador: inicio y agenda
const detalleSolicitud = t => `Te piden como <b>${esc(FN_L[t.funcion])}</b> (${esc(t.etiqueta)}) · ${esc(t.tramoEtiqueta || 'tramo por confirmar')}. Te pagan <b>${clp(t.tarifa)}</b>.`;
function solicitudHero(t) {
  return `<div class="hero" role="group" aria-label="Solicitud de bajada"><div class="tag">Solicitud de bajada</div><div class="grande-txt">${esc(fdate(t.fecha))} · ${esc(t.horario)}</div><p>${detalleSolicitud(t)}</p>
    <div class="row"><button class="ok grande" data-a="resp" data-id="${t.id}" data-r="aceptar">Aceptar</button><button class="bad" data-a="resp" data-id="${t.id}" data-r="rechazar">No puedo</button></div></div>`;
}
function tarjetaTurno(t) {
  return `<div class="card"><div class="head"><b>${esc(fdate(t.fecha))} · ${esc(t.horario)}</b><span class="tag st-${esc(t.estado)}">${esc(t.estado === 'asignado' ? 'esperando tu respuesta' : t.estado === 'aceptado' ? 'confirmada' : t.estado)}</span></div>
    <div>${esc(FN[t.funcion])} · ${esc(t.etiqueta)}</div><div class="muted small">${esc(t.tramoEtiqueta || 'Tramo por confirmar')} · ${clp(t.tarifa)}</div>
    <div class="row">${t.estado === 'asignado' ? `<button class="ok" data-a="resp" data-id="${t.id}" data-r="aceptar">Aceptar</button><button class="bad" data-a="resp" data-id="${t.id}" data-r="rechazar">No puedo</button>`
      : `<button data-a="ir" data-v="turno:${t.id}">${esc(VER[t.funcion])}</button>`}</div></div>`;
}
function vInicioTrab() {
  const t = S.d.turnos; if (!t) return cargandoTxt;
  const pend = t.turnos.filter(x => x.estado === 'asignado'), hoy = t.turnos.filter(x => x.fecha === S.hoy && x.estado !== 'asignado' && x.estado !== 'rechazado');
  const prox = t.turnos.find(x => ['aceptado'].includes(x.estado) && x.fecha > S.hoy);
  const p = S.d.periodo ? S.d.periodo.resumen : { pagar: 0, cerradas: 0, porFuncion: { guia: 0, seguridad: 0, conductor: 0 } };
  // Lo urgente primero: las solicitudes por responder, y recién después los avisos de configuración y los consejos.
  return `<h1>Hola, ${esc(S.cuenta.nombre.split(' ')[0])}</h1>${errBox()}
    ${pend.map(solicitudHero).join('')}${bannerAvisos()}${consejo()}
    <h2>Hoy · ${esc(fdate(S.hoy))}</h2>
    ${hoy.length ? hoy.map(tarjetaTurno).join('') : '<p class="muted">No tienes bajadas hoy.</p>'}
    ${prox ? `<h2>Tu próxima bajada</h2>${tarjetaTurno(prox)}` : ''}
    <h2>Mi período</h2>${selPeriodo()}
    <div class="stats" style="grid-template-columns:1fr 1fr"><div class="stat"><b>${p.cerradas}</b><span class="muted">${p.cerradas === 1 ? 'bajada cerrada' : 'bajadas cerradas'} · ${p.porFuncion.guia} guía · ${p.porFuncion.seguridad} kayak · ${p.porFuncion.conductor} apoyo</span></div><div class="stat"><b>${clp(p.pagar)}</b><span class="muted">a pagar</span></div></div>`;
}
function vAgenda() {
  const t = S.d.turnos; if (!t) return cargandoTxt;
  const vig = t.turnos.filter(x => x.estado !== 'rechazado');
  const por = {}; vig.forEach(x => (por[x.fecha] ||= []).push(x));
  return `<h1>Agenda</h1><p class="muted small">Tus próximos 30 días.</p>${Object.keys(por).length ? Object.keys(por).sort().map(f => `<h2>${esc(fdate(f))}</h2>${por[f].map(tarjetaTurno).join('')}`).join('') : '<p class="muted">No tienes bajadas asignadas. Cuando el administrador te asigne una, te llega la solicitud.</p>'}`;
}

// ---- Turno (cambia según la función)
const CHECK = {
  guia: ['Chalecos y cascos según talla', 'Charla de seguridad (ES + EN)', 'Check-in de mis pasajeros con consentimiento firmado', 'Kayak de seguridad en posición'],
  seguridad: ['Kayak, pala y casco revisados', 'Cuerda de rescate y silbato', 'Briefing con los guías de balsa', 'Posición acordada en cada rápido'],
  conductor: ['Combustible y revisión de la van', 'Balsas y remos cargados en el trailer', 'Retiro de pasajeros en la base', 'Cámara con batería y tarjeta libres', 'Traslado de vuelta desde el take-out']
};
const marcas = id => { try { return JSON.parse(store.get('mra_ck_' + id) || '[]'); } catch { return []; } };
const chipsPax = f => [f.menor ? 'MENOR' : '', conCondicion(f.medico) ? 'MÉDICO' : '', f.sabe_nadar === false ? 'NO SABE NADAR' : '', f.visitas > 1 ? f.visitas + 'ª VEZ' : '', f.presente === false ? 'NO LLEGÓ' : ''].filter(Boolean).join(' · ');
function vTurno() {
  const d = S.d.turno; if (!d) return cargandoTxt;
  const t = d.turno, ck = marcas(t.id), listo = t.estado === 'aceptado', cerrado = ['cerrado', 'pagado'].includes(t.estado);
  const cab = `<div class="row"><button class="ghost" data-a="ir" data-v="inicio">‹ Volver</button></div>
    <h1>${esc(t.horario)} · ${esc(t.etiqueta)}</h1><div class="muted">${esc(fdate(t.fecha))} · ${esc(t.tramoEtiqueta || 'Tramo por confirmar')} · ${esc(t.funcionNombre)} · <b>${clp(t.tarifa)}</b></div>${errBox()}`;
  if (t.estado === 'asignado') return cab + solicitudHero({ ...t, etiqueta: t.etiqueta });
  if (t.estado === 'rechazado') return cab + '<div class="info">Rechazaste esta bajada. El administrador ya fue avisado.</div>';
  const equipo = `<h2>Equipo de la bajada</h2><div class="muted">${d.equipo.map(e => `${esc(e.nombre)} — ${esc(FN_C[e.funcion])} ${esc(e.etiqueta)}`).join('<br>') || 'Aún sin equipo confirmado.'}</div>`;
  const checklist = `<h2>Checklist</h2><div class="card">${CHECK[t.funcion].map((x, i) => `<label style="display:flex;gap:10px;align-items:center;margin:6px 0;text-transform:none;letter-spacing:0;font:500 15px Barlow"><input type="checkbox" data-c="ck" data-id="${t.id}" data-i="${i}" style="min-height:auto;width:22px;height:22px"${ck.includes(i) ? ' checked' : ''}${cerrado ? ' disabled' : ''}> ${esc(x)}</label>`).join('')}</div>`;
  let cuerpo = '';
  if (t.funcion === 'guia') {
    const ps = d.pasajeros || [], pres = ps.filter(f => f.presente).length;
    cuerpo = `<h2>Mis pasajeros · llegaron ${pres} de ${ps.length}</h2>${ps.length ? ps.map(f => `<details class="pax"><summary><input type="checkbox" data-c="checkin" data-fid="${f.id}" style="min-height:auto;width:24px;height:24px;margin-right:8px"${f.presente ? ' checked' : ''}${cerrado ? ' disabled' : ''} aria-label="Llegó ${esc(f.nombre)}"><span><b>${esc(f.nombre)}</b> <span class="muted small">${f.edad ?? '?'} años · ${esc(f.idioma || '')}</span><br><span class="tag">${chipsPax(f) || 'sin condiciones médicas'}</span></span></summary>
      <div class="small" style="padding:4px 0 8px 32px"><div><b>Emergencia:</b> ${esc(f.emergencia_nombre || '-')}</div><div><b>Médico:</b> ${esc(f.medico || '-')}</div>${f.menor && f.apoderado ? `<div><b>Apoderado:</b> ${esc(f.apoderado.nombre)} — ${esc(f.apoderado.rut)}</div>` : ''}<div><b>Contacto:</b> <a href="tel:${esc(f.telefono)}">${esc(f.telefono)}</a></div><div class="muted">${f.visitas > 1 ? f.visitas + 'ª bajada con nosotros · ya conoce la charla' : 'Primera vez · reforzar la charla'} · consentimiento firmado</div></div></details>`).join('')
      : '<p class="muted">El administrador aún no distribuye los pasajeros de esta bajada.</p>'}`;
  } else if (t.funcion === 'seguridad') {
    cuerpo = `<h2>Balsas que cubro</h2>${(d.botes || []).length ? d.botes.map(b => `<div class="card"><div class="head"><b>${esc(b.nombre)}</b><span class="tag">${b.guia ? 'Guía ' + esc(b.guia) : 'sin guía'}</span></div>
      <div>${b.pax ? plural(b.pax, 'pasajero', 'pasajeros') : 'Sin distribuir todavía'} · ${b.medicos ? plural(b.medicos, 'condición médica', 'condiciones médicas') : 'sin condiciones médicas'} · ${b.menores ? plural(b.menores, 'menor a bordo', 'menores a bordo') : 'sin menores'}</div></div>`).join('') : '<p class="muted">Sin distribuir todavía · el administrador aún no reparte esta bajada.</p>'}`;
  } else {
    const m = d.manifiesto || [];
    cuerpo = `<h2>Manifiesto de traslado · ${m.length}</h2>${m.length ? m.map(f => `<div class="pax"><b>${esc(f.nombre)}</b> <span class="tag">${esc(f.bote || 'sin balsa')} · ${esc(f.idioma || '')}${f.menor ? ' · MENOR' : ''}${f.sabe_nadar === false ? ' · NO SABE NADAR' : ''}</span>${f.medico ? `<div class="muted small">${esc(f.medico)}</div>` : ''}</div>`).join('') : '<p class="muted">Aún no hay fichas para esta bajada.</p>'}
      <div class="info small">Las fotos de regalo llegan en la próxima versión.</div>`;
  }
  let cierre = '';
  if (cerrado) cierre = `<div class="card acento"><b>Bajada cerrada</b><div>${plural(t.pax_finales ?? 0, 'pasajero', 'pasajeros')} · ${clp(t.tarifa)} ${t.estado === 'pagado' ? '· pagado' : 'a pagar'}</div></div>`;
  else if (listo) {
    const pres = (d.pasajeros || []).filter(f => f.presente).length, def = t.funcion === 'guia' ? (pres || (d.pasajeros || []).length) : (t.funcion === 'seguridad' ? d.totalPax : (d.manifiesto || []).length);
    cierre = `<h2>Cerrar ${t.funcion === 'conductor' ? 'traslado' : 'bajada'}</h2><form class="card" data-f="cerrar" data-id="${t.id}"><label for="c-pax">${t.funcion === 'guia' ? '¿Cuántos bajaron en tu balsa?' : t.funcion === 'seguridad' ? '¿Cuántos bajaron en la bajada completa?' : '¿Cuántos pasajeros trasladaste?'}</label>
      <input id="c-pax" name="pax" type="number" min="0" max="60" value="${def ?? 0}" inputmode="numeric" required><label for="c-inc">Incidentes (opcional)</label><textarea id="c-inc" name="incidentes" maxlength="1000" placeholder="Sin novedades"></textarea>
      <div class="row"><button class="ok grande" type="submit">Cerrar y sumar al pago</button></div></form>`;
  }
  return cab + checklist + cuerpo + equipo + cierre;
}

// ---- Perfil
function tarjetaAvisosPerfil() {
  const p = S.push;
  if (p === 'desconocido') return '';
  if (p === 'activo') return `<div class="card"><h3>Avisos en este teléfono</h3><p><b class="st-aceptado">Activados ✓</b> Te llegan aunque la app esté cerrada.</p><div class="row"><button data-a="probarAvisos">Probar avisos</button><button class="ghost" data-a="desactivarAvisos">Desactivar</button></div></div>`;
  if (p === 'pendiente') return `<div class="card"><h3>Avisos en este teléfono</h3><p>Aún no están activados: no te enteras de nada si no tienes la app abierta.</p><div class="row"><button class="grande" data-a="activarAvisos">Activar avisos</button></div></div>`;
  return `<div class="card">${bannerAvisos() || '<h3>Avisos en este teléfono</h3><p class="muted">Este navegador no permite avisos. Usa la app desde Chrome (Android) o instálala en el iPhone.</p>'}</div>`;
}
function vPerfil() {
  const c = S.cuenta;
  return `<h1>${esc(c.nombre)}</h1><div class="muted">@${esc(c.usuario)} · ${admin() ? 'Administración' + (c.es_maestra ? ' · cuenta maestra' : c.verificada ? ' · verificada' : ' · sin verificar') : 'Trabajador'}</div>${errBox()}
    ${admin() && !c.verificada ? '<div class="warn">Tu cuenta admin no está verificada: no puedes publicar bajadas. La cuenta maestra debe verificarte en Equipo.</div>' : ''}
    ${tarjetaAvisosPerfil()}
    <form class="card" data-f="perfil"><h3>Mis datos</h3>
      ${!admin() ? `<label>Funciones que puedo cumplir</label><div class="chips">${Object.keys(FN).map(f => `<label class="chip"><input type="checkbox" name="fn" value="${f}"${(c.funciones || []).includes(f) ? ' checked' : ''}> ${esc(FN_C[f])}</label>`).join('')}</div>` : ''}
      <div class="grid2"><div><label for="p-tel">Teléfono</label><input id="p-tel" name="telefono" value="${esc(c.telefono || '')}" inputmode="tel"></div><div><label for="p-mail">Correo</label><input id="p-mail" name="correo" type="email" value="${esc(c.correo || '')}"></div></div>
      <label for="p-pw">Contraseña nueva (opcional, mínimo 8)</label><input id="p-pw" name="password" type="password" autocomplete="new-password" minlength="8">
      <div class="row"><button type="submit">Guardar</button></div></form>
    <div class="row"><button class="ghost" data-a="salir">Cerrar sesión</button>${admin() ? '<a class="tag" href="/admin">Panel clásico</a>' : ''}</div>
    ${instalada() ? '' : '<p class="muted small">Para instalar: en el celular abre el menú del navegador y elige “Agregar a pantalla de inicio”.</p>'}`;
}

// ------------------------------------------------------------------ pantallas de acceso
function vLogin() {
  return `<div class="center"><img class="logo" src="/app/icon-192.png" alt="Maipo River Adventure"><h1 style="text-align:center">Equipo</h1><p class="muted" style="text-align:center">Ingresa con el usuario y la contraseña que te entregó el administrador.</p>
    ${errBox()}<form data-f="login"><label for="l-u">Usuario</label><input id="l-u" name="usuario" autocomplete="username" autocapitalize="none" required><label for="l-p">Contraseña</label><input id="l-p" name="password" type="password" autocomplete="current-password" required>
    <div class="row"><button type="submit" style="width:100%">Entrar</button></div></form></div>`;
}
function vInstalar() {
  return `<div class="center"><img class="logo" src="/app/icon-192.png" alt="Maipo River Adventure"><h1 style="text-align:center">Primera instalación</h1>
    <p>Esta es la primera vez que se abre el sistema. <b>La primera cuenta queda como cuenta maestra</b>: es la única que verifica a los otros socios y no se puede transferir sin confirmación.</p>${errBox()}
    <form data-f="instalar"><label for="i-c">Clave del panel de reservas</label><input id="i-c" name="clave" type="password" required autocomplete="off"><div class="muted small">La misma que usas en maiporiveradventure.cl/admin. Así solo el dueño puede instalar.</div>
    <label for="i-n">Nombre completo</label><input id="i-n" name="nombre" required autocomplete="name"><label for="i-m">Correo</label><input id="i-m" name="correo" type="email" required autocomplete="email">
    <label for="i-p">Contraseña (mínimo 8)</label><input id="i-p" name="password" type="password" minlength="8" required autocomplete="new-password">
    <div class="row"><button type="submit" style="width:100%">Crear cuenta maestra</button></div></form></div>`;
}

// ------------------------------------------------------------------ render y navegación
function render() {
  const raiz = $('#raiz');
  if (S.cargando && S.token && !S.cuenta) { raiz.innerHTML = '<div class="center"><p class="muted" style="text-align:center" role="status">Cargando…</p></div>'; return; }
  if (!S.token || !S.cuenta) { raiz.innerHTML = S.instalado ? vLogin() : vInstalar(); return; }
  const v = S.vista;
  let cuerpo;
  if (v === 'perfil') cuerpo = vPerfil();
  else if (v === 'avisos') cuerpo = vAvisos();
  else if (v.startsWith('turno:')) cuerpo = vTurno();
  else if (admin()) cuerpo = ({ inicio: vInicioAdmin, armar: vArmar, reservas: vReservas, equipo: vEquipo, pagos: vPagosAdmin })[v]();
  else cuerpo = ({ inicio: vInicioTrab, agenda: vAgenda, pagos: vPagosTrab })[v]();
  const y = window.scrollY;
  raiz.innerHTML = cabecera() + `<main id="vista">${cuerpo}</main>` + menu();
  window.scrollTo(0, y);
  document.title = (S.avisos > 0 ? `(${S.avisos}) ` : '') + 'Maipo River — Equipo';
  ponerBadge(S.avisos);
}
function ir(v) {
  S.vista = v; S.error = ''; if (v === 'armar' && !S.fecha) S.fecha = S.hoy;
  S.d = { ...S.d, dia: v === 'armar' ? null : S.d.dia };
  window.scrollTo(0, 0); render(); refrescar(true);
}
// Cada aviso lleva a su pantalla: turno:<id> · armar:<fecha> · reservas · pagos · agenda · avisos · inicio
const SOLO_ADMIN = new Set(['armar', 'reservas', 'equipo']), SOLO_TRAB = new Set(['agenda']);
function irRuta(r) {
  if (!r || !S.cuenta) return;
  const [k, arg] = r.split(':');
  if (k === 'armar') { if (!admin()) return ir('inicio'); S.fecha = /^\d{4}-\d{2}-\d{2}$/.test(arg) ? arg : S.hoy; return ir('armar'); }
  if (k === 'turno') return /^\d+$/.test(arg || '') ? ir('turno:' + arg) : ir('inicio');
  if (SOLO_ADMIN.has(k) && !admin()) return ir('inicio');
  if (SOLO_TRAB.has(k) && admin()) return ir('inicio');
  if (['inicio', 'reservas', 'equipo', 'pagos', 'agenda', 'avisos'].includes(k)) return ir(k);
  ir('inicio');
}

// ------------------------------------------------------------------ eventos
const A = {
  ir: el => ir(el.dataset.v),
  armarDia: el => { S.fecha = el.dataset.f; ir('armar'); },
  dia: el => { const n = +el.dataset.n; S.fecha = n === 0 ? S.hoy : sumaDias(S.fecha, n); S.d.dia = null; render(); refrescar(true); },
  periodo: el => { S.periodo = el.dataset.p; refrescar(true); },
  salir: async () => { await desvincularPush(); cerrarSesion(); },
  copiar: async el => { try { await navigator.clipboard.writeText(el.dataset.t); aviso('Copiado'); } catch { aviso('No se pudo copiar', 'Selecciona el texto a mano.'); } },
  abrirAviso: async el => {
    const ruta = el.dataset.ruta;
    try { await post('leido', { id: +el.dataset.id }); } catch {}
    if (ruta) irRuta(ruta); else refrescar(true);
  },
  leidoTodos: () => ejecutar(() => post('leido', { todos: true })),
  cerrarClave: () => { S.clave = null; render(); },
  cerrarTip: () => { store.set('mra_tip_' + (admin() ? 'a' : 't'), '1'); render(); },
  ahoraNo: () => { store.set('mra_push_no', String(Date.now())); render(); },
  activarAvisos: () => activarAvisos(),
  desactivarAvisos: () => desactivarAvisos(),
  probarAvisos: async () => {
    try { await post('push_probar'); aviso('Aviso de prueba enviado', 'Debería llegarte en unos segundos.'); }
    catch (e) { S.error = errorTxt(e); render(); }
  },
  auto: async el => {
    const r = await ejecutar(() => post('autodistribuir', { bajada_id: +el.dataset.sid }));
    if (r) aviso('Listo', `${plural(r.distribuidos, 'pasajero repartido', 'pasajeros repartidos')} · ${plural(r.asignados, 'puesto cubierto', 'puestos cubiertos')}${r.sinPersonal.length ? ' · falta: ' + r.sinPersonal.join(', ') : ''}${r.sobran ? ' · ' + plural(r.sobran, 'pasajero no cabe', 'pasajeros no caben') : ''}`);
  },
  publicar: async el => {
    const id = +el.dataset.sid;
    try {
      await post('publicar', { bajada_id: id }); aviso('Solicitudes enviadas', 'Cada persona ya recibió su aviso.'); await refrescar(true);
    } catch (e) {
      if (e.datos && e.datos.requiereConfirmar) {
        const si = await dialogo({ titulo: 'Antes de avisar al equipo', texto: 'Hay cosas por revisar. ¿Avisar igual?', lista: e.datos.avisos, si: 'Avisar igual', no: 'Volver' });
        if (si) await ejecutar(() => post('publicar', { bajada_id: id, forzar: true }), 'Solicitudes enviadas');
      } else { S.error = errorTxt(e); render(); }
    }
  },
  resp: async el => {
    const rechazar = el.dataset.r === 'rechazar';
    let motivo = '';
    if (rechazar) { motivo = await dialogo({ titulo: '¿No puedes esta bajada?', texto: 'Le avisamos al administrador para que busque un reemplazo.', campo: 'Motivo (opcional)', si: 'Enviar', no: 'Volver' }); if (motivo === null) return; }
    await ejecutar(() => post('responder', { turno_id: +el.dataset.id, respuesta: el.dataset.r, motivo }), rechazar ? 'Le avisamos al administrador' : 'Bajada aceptada');
  },
  rsv: async el => {
    if (el.dataset.e === 'cancelada' && !(await dialogo({ titulo: `¿Cancelar la reserva de ${el.dataset.n}?`, texto: 'Se liberan sus cupos en la planilla.', si: 'Cancelar reserva', no: 'Volver' }))) return;
    await ejecutar(() => pedir('PATCH', '/api/reservas', { id: +el.dataset.id, estado: el.dataset.e }));
  },
  fn: async el => {
    const c = S.equipo.find(x => x.id === +el.dataset.id), f = el.dataset.f;
    const nuevas = c.funciones.includes(f) ? c.funciones.filter(x => x !== f) : [...c.funciones, f];
    if (!nuevas.length) { S.error = 'Debe tener al menos una función.'; render(); return; }
    await ejecutar(() => post('equipo_editar', { id: c.id, funciones: nuevas }));
  },
  baja: async el => {
    const on = el.dataset.on === '1';
    if (!on && !(await dialogo({ titulo: `¿Dar de baja a ${el.dataset.n}?`, texto: 'Pierde el acceso de inmediato, aunque tenga la app instalada.', si: 'Dar de baja', no: 'Volver' }))) return;
    await ejecutar(() => post('equipo_editar', { id: +el.dataset.id, activa: on }));
  },
  reset: async el => {
    if (!(await dialogo({ titulo: `¿Nueva clave para ${el.dataset.n}?`, texto: 'La clave anterior deja de servir.', si: 'Generar', no: 'Volver' }))) return;
    const r = await ejecutar(() => post('equipo_editar', { id: +el.dataset.id, reset_clave: true }));
    if (r && r.clave) { const c = S.equipo.find(x => x.id === +el.dataset.id); S.clave = { nombre: c.nombre, usuario: c.usuario, clave: r.clave, correoEnviado: false }; render(); window.scrollTo(0, 0); }
  },
  verificar: el => ejecutar(() => post('equipo_editar', { id: +el.dataset.id, verificada: el.dataset.on === '1' })),
  pagar: async el => {
    if (!(await dialogo({ titulo: `¿Marcar pagado a ${el.dataset.n}?`, texto: `${clp(el.dataset.m)} en bajadas cerradas de este período.`, si: 'Marcar pagado', no: 'Volver' }))) return;
    const [a, b] = rango(S.periodo);
    await ejecutar(() => post('pagar', { trabajador_id: +el.dataset.id, desde: a, hasta: b }), 'Pago registrado');
  }
};
// Acciones que abren cuadros o piden permisos del navegador no deben quedar bloqueadas por el "ocupado".
const LIBRES = new Set(['ir', 'armarDia', 'dia', 'periodo', 'copiar', 'cerrarClave', 'cerrarTip', 'ahoraNo', 'activarAvisos', 'abrirAviso']);
document.addEventListener('click', e => {
  const toast = e.target.closest('#toast[data-ruta]'); if (toast) { $('#toast').hidden = true; irRuta(toast.dataset.ruta); return; }
  const el = e.target.closest('[data-a]'); if (!el || !A[el.dataset.a]) return;
  if (el.tagName === 'A') e.preventDefault();
  if (el.disabled) return;
  if (LIBRES.has(el.dataset.a)) A[el.dataset.a](el); else correr(() => A[el.dataset.a](el));
});
document.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.card.tocable')) { e.preventDefault(); e.target.click(); } });
document.addEventListener('change', e => {
  const t = e.target, c = t.dataset.c; if (!c) return;
  if (c === 'fecha') { if (t.value) { S.fecha = t.value; S.d.dia = null; render(); refrescar(true); } return; }
  if (c === 'ck') { const id = t.dataset.id, l = new Set(marcas(id)); t.checked ? l.add(+t.dataset.i) : l.delete(+t.dataset.i); store.set('mra_ck_' + id, JSON.stringify([...l])); return; }
  const hacer = { puesto: () => ejecutar(() => post('asignar', { bajada_id: +t.dataset.sid, puesto: t.dataset.p, trabajador_id: t.value ? +t.value : null })),
    bote: () => ejecutar(() => pedir('PATCH', '/api/ficha', { id: +t.dataset.fid, bote_id: t.value ? +t.value : null })),
    asig: () => t.value ? ejecutar(() => pedir('PATCH', '/api/ficha', { id: +t.dataset.fid, bajada_id: +t.value })) : null,
    checkin: () => ejecutar(() => post('checkin', { ficha_id: +t.dataset.fid, presente: t.checked })) }[c];
  if (hacer) correr(hacer);
});
document.addEventListener('submit', e => {
  const f = e.target, k = f.dataset.f; if (!k) return; e.preventDefault();
  const d = Object.fromEntries(new FormData(f)), fn = new FormData(f).getAll('fn');
  correr(async () => {
    S.error = '';
    try {
      if (k === 'login' || k === 'instalar') {
        const r = await pedir('POST', '/api/app', { accion: k === 'login' ? 'login' : 'setup', ...d }, { publico: true });
        S.token = r.token; S.cuenta = r.cuenta; store.set('mra_tok', r.token); S.vista = 'inicio'; S.fecha = ''; S.avisos = -1; S.cargando = true; S.instalado = true;
        await refrescar(true); sincronizarPush(); return;
      }
      if (k === 'nuevoMiembro') {
        const r = await post('equipo_crear', { nombre: d.nombre, telefono: d.telefono, correo: d.correo, tipo: d.tipo || 'trabajador', funciones: fn });
        S.clave = { nombre: d.nombre, usuario: r.usuario, clave: r.clave, correoEnviado: r.correoEnviado }; await refrescar(true); window.scrollTo(0, 0); return;
      }
      if (k === 'perfil') {
        const b = { telefono: d.telefono, correo: d.correo }; if (d.password) b.password = d.password; if (!admin()) b.funciones = fn;
        const r = await post('perfil', b); if (r.token) { S.token = r.token; store.set('mra_tok', r.token); }
        S.cuenta = r.cuenta; aviso('Datos guardados'); await refrescar(true); return;
      }
      if (k === 'cerrar') {
        if (!(await dialogo({ titulo: '¿Cerrar la bajada?', texto: `${plural(+d.pax, 'pasajero', 'pasajeros')}. Después de cerrar cuenta para tu pago y no se puede editar.`, si: 'Cerrar', no: 'Volver' }))) return;
        await post('cerrar', { turno_id: +f.dataset.id, pax: +d.pax, incidentes: d.incidentes }); aviso('Bajada cerrada', 'Sumada a tu pago.'); await refrescar(true);
      }
    } catch (err) { S.error = errorTxt(err); render(); }
  });
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) { pulso(); limpiarBandeja(); } });
document.addEventListener('focusout', () => { if (pendiente) { pendiente = false; setTimeout(() => { if (!editando()) refrescar(true); }, 50); } });
window.addEventListener('online', pulso);
window.addEventListener('hashchange', () => { const r = location.hash.slice(1); if (r && S.cuenta) { history.replaceState(null, '', location.pathname); irRuta(r); } });

// ------------------------------------------------------------------ arranque
(async function () {
  S.rutaPendiente = location.hash.slice(1);
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' }).catch(() => {});
    // Al tocar un aviso del sistema con la app ya abierta, el service worker nos pide ir a esa pantalla.
    navigator.serviceWorker.addEventListener('message', e => { if (e.data && e.data.ruta) irRuta(e.data.ruta); });
  }
  try { S.instalado = (await pedir('GET', '/api/app?a=instalado', null, { publico: true })).instalado; } catch {}
  setInterval(pulso, 3000);
  if (S.token) {
    S.cargando = true; render(); await refrescar(true);
    if (!S.cuenta) render();
    else { await sincronizarPush(); if (S.rutaPendiente) { history.replaceState(null, '', location.pathname); irRuta(S.rutaPendiente); S.rutaPendiente = ''; } }
  } else { S.cargando = false; render(); }
})();
