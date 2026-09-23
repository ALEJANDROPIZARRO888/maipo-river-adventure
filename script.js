(function () {
  'use strict';

  var page = document.getElementById('page');
  var header = document.querySelector('header[data-active]');

  // ---------- Idioma (ES/EN) ----------
  function setLang(l) {
    if (page) page.dataset.lang = l;
    document.documentElement.lang = l;
    try { window.localStorage.setItem('mra_lang', l); } catch (e) {}
  }
  document.querySelectorAll('.langbtn.es').forEach(function (b) {
    b.addEventListener('click', function () { setLang('es'); });
  });
  document.querySelectorAll('.langbtn.en').forEach(function (b) {
    b.addEventListener('click', function () { setLang('en'); });
  });
  (function initLang() {
    var saved = null;
    try { saved = window.localStorage.getItem('mra_lang'); } catch (e) {}
    if (saved === 'en' || saved === 'es') { setLang(saved); return; }
    if ((navigator.language || '').toLowerCase().indexOf('es') !== 0) { setLang('en'); }
  })();

  // ---------- Menú móvil ----------
  var navHam = document.getElementById('navHam');
  var mobileMenu = document.getElementById('mobileMenu');
  if (navHam && mobileMenu) {
    navHam.addEventListener('click', function () {
      var open = mobileMenu.style.display === 'flex';
      mobileMenu.style.display = open ? 'none' : 'flex';
      navHam.setAttribute('aria-expanded', open ? 'false' : 'true');
    });
    mobileMenu.addEventListener('click', function (e) {
      if (e.target.closest('a')) {
        mobileMenu.style.display = 'none';
        navHam.setAttribute('aria-expanded', 'false');
      }
    });
  }

  // ---------- Abrir secciones colapsadas desde el menú ----------
  function revealSection(target) {
    if (!target) return;
    target.style.display = 'block';
    target.open = true;
  }
  function scrollToSectionWhenReady(target) {
    function jump() { target.scrollIntoView({ behavior: 'auto', block: 'start' }); }
    var imgs = target.querySelectorAll('img');
    var pending = 0;
    Array.prototype.forEach.call(imgs, function (img) {
      if (!img.complete) {
        pending++;
        var done = function () { pending--; if (pending <= 0) jump(); };
        img.addEventListener('load', done, { once: true });
        img.addEventListener('error', done, { once: true });
      }
    });
    jump();
    [100, 250, 450, 700, 1000].forEach(function (delay) { setTimeout(jump, delay); });
  }
  document.addEventListener('click', function (e) {
    var link = e.target.closest('a[href^="#"]');
    if (!link) return;
    var target = document.getElementById(link.getAttribute('href').slice(1));
    if (!target || !target.classList.contains('acc-section')) return;
    e.preventDefault();
    if (mobileMenu) {
      mobileMenu.style.display = 'none';
      if (navHam) navHam.setAttribute('aria-expanded', 'false');
    }
    revealSection(target);
    scrollToSectionWhenReady(target);
  });
  if (location.hash) {
    var initialTarget = document.getElementById(location.hash.slice(1));
    if (initialTarget && initialTarget.classList.contains('acc-section')) {
      initialTarget.style.display = 'block';
      initialTarget.open = true;
      scrollToSectionWhenReady(initialTarget);
    }
  }

  // ---------- Scroll spy (sección activa en el nav) ----------
  var sectionIds = ['planes', 'kayak', 'como', 'seguridad', 'nosotros', 'galeria', 'faq', 'ubicacion'];
  var sections = sectionIds.map(function (id) { return document.getElementById(id); }).filter(Boolean);
  if (window.IntersectionObserver && sections.length && header) {
    var obs = new IntersectionObserver(function (entries) {
      var vis = entries.filter(function (e) { return e.isIntersecting; })
        .sort(function (a, b) { return b.intersectionRatio - a.intersectionRatio; });
      if (vis[0]) header.dataset.active = vis[0].target.id;
    }, { rootMargin: '-45% 0px -45% 0px', threshold: [0, 0.25, 0.5] });
    sections.forEach(function (el) { obs.observe(el); });
  }

  // ---------- Botón volver arriba ----------
  var backToTop = document.getElementById('backToTop');
  if (backToTop) {
    window.addEventListener('scroll', function () {
      var show = window.pageYOffset > 900;
      backToTop.style.display = show ? 'flex' : 'none';
    }, { passive: true });
  }

  // ---------- Botones "Reservar este plan" ----------
  var reservaForm = document.getElementById('reservaForm');
  document.querySelectorAll('.planBtn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var plan = btn.getAttribute('data-plan');
      if (reservaForm && reservaForm.elements['plan']) {
        reservaForm.elements['plan'].value = plan;
      }
      var el = document.getElementById('reserva');
      if (el) {
        var y = el.getBoundingClientRect().top + window.pageYOffset - 70;
        window.scrollTo({ top: y, behavior: 'smooth' });
      }
    });
  });

  // ---------- Fecha mínima = hoy ----------
  var fechaInput = reservaForm ? reservaForm.elements['fecha'] : null;
  if (fechaInput) {
    var t = new Date();
    var today = t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
    fechaInput.min = today;
  }

  // ---------- Cupos en tiempo real ----------
  var CUPOS_API = 'https://script.google.com/macros/s/AKfycbwoIxVXpwzK5aIzoVXqcHUGtwCL1BgFHKHTCzyCsxRQuxY1ZKcKKgOMUPY7NFBx7rCa/exec';
  var horarioSelect = reservaForm ? reservaForm.elements['horario'] : null;
  var horarioLabelsBase = {};
  if (horarioSelect) {
    Array.prototype.forEach.call(horarioSelect.options, function (opt) {
      if (opt.value) horarioLabelsBase[opt.value] = opt.textContent;
    });
  }
  function actualizarDisponibilidad(fecha) {
    if (!horarioSelect || !fecha) return;
    fetch(CUPOS_API + '?fecha=' + encodeURIComponent(fecha))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !data.disponibilidad) return;
        Array.prototype.forEach.call(horarioSelect.options, function (opt) {
          if (!opt.value) return;
          var cupos = data.disponibilidad[opt.value];
          if (typeof cupos !== 'number') return;
          var base = horarioLabelsBase[opt.value] || opt.value;
          opt.disabled = cupos <= 0;
          opt.textContent = cupos <= 0 ? (base + ' — Sin cupo') : (base + ' — ' + cupos + ' cupos');
          if (cupos <= 0 && horarioSelect.value === opt.value) horarioSelect.value = '';
        });
      })
      .catch(function () {});
  }
  if (fechaInput) {
    fechaInput.addEventListener('change', function () { actualizarDisponibilidad(fechaInput.value); });
  }

  // ---------- Cupos disponibles hoy ----------
  var cuposHoyWidget = document.getElementById('cuposHoyWidget');
  var cuposHoyList = document.getElementById('cuposHoyList');
  if (cuposHoyWidget && cuposHoyList) {
    var th = new Date();
    var hoyStr = th.getFullYear() + '-' + String(th.getMonth() + 1).padStart(2, '0') + '-' + String(th.getDate()).padStart(2, '0');
    fetch(CUPOS_API + '?fecha=' + encodeURIComponent(hoyStr))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !data.disponibilidad) return;
        var horarios = ['11:00', '14:00', '17:00'];
        var html = '';
        horarios.forEach(function (h) {
          var cupos = data.disponibilidad[h];
          if (typeof cupos !== 'number') return;
          var color = cupos > 0 ? '#25D366' : '#e05555';
          html += '<div style="display:flex;justify-content:space-between;gap:14px;"><span>' + h + ' hrs</span><span style="color:' + color + ';font-weight:800;">' +
            '<span class="lang-es">' + (cupos > 0 ? cupos + ' cupos' : 'Sin cupo') + '</span>' +
            '<span class="lang-en">' + (cupos > 0 ? cupos + ' spots' : 'Full') + '</span></span></div>';
        });
        if (html) {
          cuposHoyList.innerHTML = html;
          cuposHoyWidget.style.display = 'block';
        }
      })
      .catch(function () {});
  }

  // ---------- Formulario de reserva ----------
  var EMAIL = 'maiporiveradventure@gmail.com';
  var WA = '56976437931';
  var sentMsg = document.getElementById('sentMsg');
  var failedMsg = document.getElementById('failedMsg');
  var noCupoMsg = document.getElementById('noCupoMsg');
  var emailBtn = document.getElementById('emailFallbackBtn');
  var emailLabel = document.getElementById('emailFallbackLabel');

  function fields() {
    var f = reservaForm;
    function g(n) { var el = f.elements[n]; return el ? String(el.value || '').trim() : ''; }
    return {
      nombre: g('nombre'), telefono: g('telefono'), correo: g('correo'), fecha: g('fecha'),
      horario: g('horario'), personas: g('personas'), plan: g('plan'), comentarios: g('comentarios') || '-'
    };
  }

  function buildText() {
    var d = fields();
    return [
      'Hola Maipo River Adventure! Quiero reservar mi aventura de rafting.', '',
      'Nombre: ' + d.nombre, 'Telefono: ' + d.telefono, 'Correo: ' + d.correo,
      'Fecha deseada: ' + d.fecha, 'Horario: ' + d.horario, 'Personas: ' + d.personas,
      'Plan: ' + d.plan, 'Comentarios: ' + d.comentarios
    ].join('\n');
  }

  function valid() {
    if (!reservaForm) return false;
    if (!reservaForm.checkValidity()) { reservaForm.reportValidity(); return false; }
    return true;
  }

  // Guarda la reserva en el backend propio (panel admin + ficha QR). Nunca bloquea la reserva.
  // cupoWeb: si este navegador ya restó el cupo en la planilla (ver reservarCupo). El servidor solo intenta restarlo
  // de nuevo si aquí llega false/indefinido, así nunca se descuenta dos veces por la misma reserva.
  function postApi(cupoWeb) {
    try {
      var d = fields();
      d.cupoWeb = cupoWeb === true;
      fetch('/api/reservas', {
        method: 'POST', keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(d)
      }).catch(function () {});
    } catch (e) {}
  }

  function postEmail(cupoWeb) {
    postApi(cupoWeb);
    var d = fields();
    return fetch('https://formsubmit.co/ajax/' + encodeURIComponent(EMAIL), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        _subject: 'Nueva reserva web — ' + d.nombre + ' (' + d.fecha + ')',
        _template: 'table',
        Nombre: d.nombre, Telefono: d.telefono, Correo: d.correo,
        'Fecha deseada': d.fecha, Horario: d.horario, Personas: d.personas,
        Plan: d.plan, Comentarios: d.comentarios
      })
    }).then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); });
  }

  function showSent() {
    if (sentMsg) sentMsg.style.display = 'flex';
    if (failedMsg) failedMsg.style.display = 'none';
  }
  function showFailed() {
    if (failedMsg) failedMsg.style.display = 'block';
  }

  function showSinCupo() {
    if (sentMsg) sentMsg.style.display = 'none';
    if (failedMsg) failedMsg.style.display = 'none';
    if (noCupoMsg) noCupoMsg.style.display = 'block';
  }
  // Resta el cupo directo en la planilla desde el navegador (rápido, y es lo único que valida "sin cupo" antes de
  // enviar). Devuelve { permite, restado }: permite=false SOLO cuando el script confirmó que ya no hay cupo (bloquea
  // la reserva); si la petición falla por cualquier otro motivo (bloqueador de anuncios, red, script caído, CORS) se
  // deja permite=true y restado=false, para no impedir una reserva legítima — el servidor resta como respaldo
  // (ver postApi/cupoWeb) para que la web nunca siga mostrando cupo donde ya no queda.
  function reservarCupo(fecha, horario, personas) {
    return fetch(CUPOS_API, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ fecha: fecha, horario: horario, personas: Number(personas) || 1 })
    })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (res && res.error === 'sin_cupo') {
          showSinCupo();
          actualizarDisponibilidad(fecha);
          return { permite: false, restado: false };
        }
        return { permite: true, restado: true };
      })
      .catch(function () { return { permite: true, restado: false }; });
  }

  // Único camino para confirmar cupo y enviar la reserva; lo usan tanto el botón principal (WhatsApp) como el
  // alterno (por correo). Antes, el botón alterno llamaba a postEmail() directo, sin pasar por reservarCupo(): toda
  // reserva hecha por ahí nunca restaba el cupo en la planilla, y la web seguía mostrando el horario disponible.
  function confirmarCupo() {
    if (!valid()) return Promise.resolve(null);
    var d = fields();
    if (noCupoMsg) noCupoMsg.style.display = 'none';
    return reservarCupo(d.fecha, d.horario, d.personas).then(function (r) { return r.permite ? r : null; });
  }

  if (reservaForm) {
    reservaForm.addEventListener('submit', function (e) {
      e.preventDefault();
      confirmarCupo().then(function (r) {
        if (!r) return;
        window.open('https://wa.me/' + WA + '?text=' + encodeURIComponent(buildText()), '_blank');
        showSent();
        postEmail(r.restado).catch(function () {});
      });
    });
  }

  if (emailBtn) {
    var sending = false;
    emailBtn.addEventListener('click', function () {
      if (sending || !valid()) return;
      sending = true;
      failedMsg && (failedMsg.style.display = 'none');
      var esOn = !page || page.dataset.lang !== 'en';
      if (emailLabel) emailLabel.textContent = esOn ? 'Enviando…' : 'Sending…';
      var volver = function () {
        sending = false;
        if (emailLabel) { var e2 = !page || page.dataset.lang !== 'en'; emailLabel.textContent = e2 ? 'Enviar por correo' : 'Send by email'; }
      };
      confirmarCupo().then(function (r) {
        if (!r) { volver(); return; }
        return postEmail(r.restado).then(function () {
          sending = false;
          if (emailLabel) emailLabel.textContent = esOn ? 'Enviado ✓' : 'Sent ✓';
          showSent();
        });
      }).catch(function () {
        volver();
        showFailed();
      });
    });
  }
})();

