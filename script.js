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

  // ---------- Formulario de reserva ----------
  var EMAIL = 'maiporiveradventure@gmail.com';
  var WA = '56976437931';
  var sentMsg = document.getElementById('sentMsg');
  var failedMsg = document.getElementById('failedMsg');
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

  function postEmail() {
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

  if (reservaForm) {
    reservaForm.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!valid()) return;
      window.open('https://wa.me/' + WA + '?text=' + encodeURIComponent(buildText()), '_blank');
      showSent();
      postEmail().catch(function () {});
    });
  }

  if (emailBtn) {
    var sending = false;
    emailBtn.addEventListener('click', function () {
      if (!valid() || sending) return;
      sending = true;
      failedMsg && (failedMsg.style.display = 'none');
      var esOn = !page || page.dataset.lang !== 'en';
      if (emailLabel) emailLabel.textContent = esOn ? 'Enviando…' : 'Sending…';
      postEmail().then(function () {
        sending = false;
        if (emailLabel) emailLabel.textContent = esOn ? 'Enviado ✓' : 'Sent ✓';
        showSent();
      }).catch(function () {
        sending = false;
        if (emailLabel) {
          var esOn2 = !page || page.dataset.lang !== 'en';
          emailLabel.textContent = esOn2 ? 'Enviar por correo' : 'Send by email';
        }
        showFailed();
      });
    });
  }
})();

