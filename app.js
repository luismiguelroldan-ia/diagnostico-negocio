// FORMULARIO DE DIAGNÓSTICO — una pregunta por pantalla, voz o texto, guardado automático.
const $ = s => document.querySelector(s);
const GAS = !!(window.google && google.script && google.script.run); // true cuando el formulario vive dentro de Google
const gas = (fn, arg) => new Promise((ok, mal) => google.script.run.withSuccessHandler(ok).withFailureHandler(mal)[fn](arg));
const EN_LINEA = GAS || !!ENDPOINT;
// Cada persona tiene su propio código. Si el enlace no trae uno (?c=), se crea aquí, se recuerda en este
// dispositivo y se deja en la dirección para que pueda volver al mismo formulario. El servidor lo registra solo.
const CODIGO = (() => {
  const limpio = t => String(t || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 40);
  const url = new URL(location.href);
  let c = limpio(window.CODIGO_SERVIDOR || url.searchParams.get('c'));
  if (c.length < 8) {
    try { c = limpio(localStorage.getItem('diag_codigo')); } catch (e) { c = ''; }
    if (c.length < 8) {
      const letras = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', azar = crypto.getRandomValues(new Uint8Array(10));
      c = Array.from(azar, n => letras[n % letras.length]).join('');
    }
    try { url.searchParams.set('c', c); history.replaceState(null, '', url); } catch (e) {}
  }
  try { localStorage.setItem('diag_codigo', c); } catch (e) {}
  return c;
})();
const CLAVE = 'diag_' + CODIGO;
const MIC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';

let S = { r: {}, pos: 0, fin: false, extras: [], cola: [] };
try { S = Object.assign(S, JSON.parse(localStorage.getItem(CLAVE) || '{}')); } catch (e) {}
const persistir = () => { try { localStorage.setItem(CLAVE, JSON.stringify(S)); } catch (e) {} };

const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const marca = t => esc(t).replace(/\{(.+?)\}/g, '<span class="res">$1</span>');
const plano = t => t.replace(/[{}]/g, '');
const aplica = q => !q.si || q.si(S.r);
const visibles = () => PREGUNTAS.filter(aplica);
const vacia = v => v == null || v === '' || (Array.isArray(v) && !v.length);

// ───── Envío a Google (cola con reintento) ─────
function encolar(obj) { S.cola.push(Object.assign({ codigo: CODIGO, t: Date.now() }, obj)); persistir(); vaciarCola(); }
let enviando = false;
async function vaciarCola() {
  if (!EN_LINEA) { $('#estado').textContent = 'MODO DEMOSTRACIÓN'; return; }
  if (enviando || !S.cola.length) return;
  enviando = true; $('#estado').textContent = 'GUARDANDO…';
  try {
    while (S.cola.length) {
      const j = GAS ? await gas('recibir', S.cola[0]) : await (await fetch(ENDPOINT, { method: 'POST', body: JSON.stringify(S.cola[0]) })).json();
      if (!j.ok) throw new Error(j.error || 'error');
      S.cola.shift(); persistir();
    }
    $('#estado').textContent = 'GUARDADO';
  } catch (e) {
    $('#estado').textContent = e.message === 'codigo' ? 'NO SE ESTÁ GUARDANDO · AVISA A QUIEN TE ENVIÓ EL ENLACE' : 'SIN CONEXIÓN · SE GUARDA AQUÍ';
    setTimeout(vaciarCola, 15000);
  }
  enviando = false;
}
window.addEventListener('online', vaciarCola);

function guardar(q, valor) {
  const antes = JSON.stringify(S.r[q.id]);
  S.r[q.id] = valor; persistir();
  if (JSON.stringify(valor) !== antes && !vacia(valor))
    encolar({ accion: 'guardar', id: q.id, area: q.area, pregunta: plano(q.p), respuesta: Array.isArray(valor) ? valor.join(' | ') : valor });
}

// ───── Voz: dictado en vivo si el navegador lo permite; si no, graba la nota de voz ─────
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let voz = null;
function pararVoz() { if (voz) { const v = voz; voz = null; v.parar(); } }
function alternarVoz(btn, area, etiqueta, idRef) {
  if (voz) { pararVoz(); return; }
  const fin = msg => { btn.classList.remove('on'); etiqueta.textContent = msg; };
  if (SR) {
    const rec = new SR(); rec.lang = 'es-CO'; rec.continuous = true; rec.interimResults = true;
    let base = area.value ? area.value.trimEnd() + ' ' : '';
    rec.onresult = e => {
      let prov = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) base += e.results[i][0].transcript.trim() + ' '; else prov += e.results[i][0].transcript;
      }
      area.value = base + prov; area.dispatchEvent(new Event('input'));
    };
    rec.onerror = e => { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { voz = null; fin('No pude usar el micrófono. Revisa el permiso o escribe la respuesta.'); } };
    rec.onend = () => { if (voz && voz.rec === rec) { try { rec.start(); } catch (e) {} } else fin('Listo. Revisa el texto y corrígelo si hace falta.'); };
    voz = { rec, parar: () => rec.stop() };
    try { rec.start(); } catch (e) { voz = null; return fin('No pude iniciar el dictado. Escribe la respuesta.'); }
    btn.classList.add('on'); etiqueta.textContent = 'Te escucho… toca otra vez para terminar.';
  } else if (navigator.mediaDevices && window.MediaRecorder) {
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      const mr = new MediaRecorder(stream), trozos = [];
      mr.ondataavailable = e => trozos.push(e.data);
      mr.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(trozos, { type: mr.mimeType });
        const fr = new FileReader();
        fr.onload = () => {
          if (EN_LINEA) encolar({ accion: 'audio', id: idRef(), mime: blob.type, datos: fr.result.split(',')[1] });
          area.value = (area.value ? area.value.trimEnd() + ' ' : '') + '[Nota de voz enviada]'; area.dispatchEvent(new Event('input'));
          fin(EN_LINEA ? 'Nota de voz guardada. Puedes grabar otra o seguir.' : 'Modo demostración: la nota de voz no se guarda.');
        };
        fr.readAsDataURL(blob);
      };
      const tope = setTimeout(pararVoz, 180000); // máximo 3 minutos por nota
      voz = { parar: () => { clearTimeout(tope); mr.stop(); } };
      mr.start(); btn.classList.add('on'); etiqueta.textContent = 'Grabando… toca otra vez para terminar.';
    }).catch(() => fin('No pude usar el micrófono. Revisa el permiso o escribe la respuesta.'));
  } else fin('Este navegador no permite grabar. Escribe la respuesta.');
}
function campoVoz(valor, idRef) {
  const d = document.createElement('div');
  d.innerHTML = `<textarea placeholder="Habla o escribe aquí…"></textarea><div class="voz"><button type="button" class="mic" aria-label="Responder hablando">${MIC}</button><span>Toca el micrófono y cuéntalo hablando.</span></div>`;
  const area = d.querySelector('textarea'); area.value = valor || '';
  d.querySelector('.mic').onclick = e => alternarVoz(e.currentTarget, area, d.querySelector('.voz span'), idRef);
  return { nodo: d, area };
}

// ───── Pantallas ─────
function pie(...btns) { const p = $('#pie'); p.innerHTML = ''; btns.forEach(b => b && p.append(b)); }
function boton(txt, cls, fn) { const b = document.createElement('button'); b.className = 'btn ' + cls; b.textContent = txt; b.onclick = fn; return b; }
function espacio() { const s = document.createElement('span'); s.className = 'sp'; return s; }

function ir(delta) {
  pararVoz();
  const v = visibles(); let i = v.findIndex(q => q.id === S.actual);
  i = Math.max(0, i + delta);
  if (i >= v.length) return terminar();
  S.actual = v[i].id; persistir(); pintar();
}

function pintar() {
  if (S.fin && !S.editando) return pantallaFinal();
  const v = visibles();
  let i = v.findIndex(q => q.id === S.actual); if (i < 0) { i = 0; S.actual = v[0].id; }
  const q = v[i], m = $('#main');
  $('#barra').style.width = Math.round(i / v.length * 100) + '%';
  $('#etq').textContent = q.area;
  m.className = q.tipo === 'intro' ? 'intro' : ''; m.innerHTML = '';
  const atras = i > 0 ? boton('Atrás', 'txt', () => ir(-1)) : null;
  const volver = S.editando ? boton('Volver al resumen', 'sec', () => { pararVoz(); S.editando = false; persistir(); pintar(); }) : null;

  if (q.tipo === 'intro') {
    m.innerHTML = `<span class="etq">${q.n} · ${esc(q.area)}</span><h1>${marca(q.titulo)}</h1><p>${esc(q.texto)}</p>`;
    return pie(atras, espacio(), boton(i === 0 ? 'Empezar' : 'Continuar', 'acc', () => ir(1)));
  }
  if (q.tipo === 'permiso') {
    m.innerHTML = `<h1>${marca(q.p)}</h1>${q.texto.map(t => `<p class="ayuda">${esc(t)}</p>`).join('')}<div class="ops multi"><button type="button" class="op${S.r[q.id] ? ' sel' : ''}">${esc(q.acepto)}</button></div>`;
    const ok = boton('Continuar', '', () => { if (!S.r[q.id]) guardar(q, 'Autorizó · ' + new Date().toLocaleString('es-CO')); ir(1); });
    ok.disabled = !S.r[q.id];
    m.querySelector('.op').onclick = e => { if (S.r[q.id]) return; ok.disabled = !e.currentTarget.classList.toggle('sel'); };
    return pie(atras, espacio(), volver, ok);
  }
  m.innerHTML = `<h1>${marca(q.p)}</h1>${q.ayuda ? `<p class="ayuda">${esc(q.ayuda)}</p>` : ''}`;
  const sig = boton('Continuar', '', () => ir(1));
  const saltar = q.obligatoria ? null : boton('Saltar', 'txt', () => ir(1));

  if (q.tipo === 'texto' || q.tipo === 'corto') {
    let campo;
    if (q.tipo === 'texto') { const c = campoVoz(S.r[q.id], () => q.id); m.append(c.nodo); campo = c.area; }
    else { campo = document.createElement('input'); campo.type = q.entrada || 'text'; campo.value = S.r[q.id] || ''; m.append(campo); campo.onkeydown = e => { if (e.key === 'Enter' && !sig.disabled) sig.click(); }; }
    const act = () => { const t = campo.value.trim(); sig.disabled = !t || !!(q.valida && !q.valida.test(t)); };
    campo.addEventListener('input', act); act();
    let avisado = false;
    sig.onclick = () => {
      pararVoz(); const t = campo.value.trim();
      if (q.tipo === 'texto' && !avisado && t.split(/\s+/).length < 5 && !/^(no|ninguna|ninguno|nada|no aplica)\.?$/i.test(t)) {
        avisado = true;
        const aviso = document.createElement('p'); aviso.className = 'ayuda'; aviso.style.cssText = 'margin-top:12px;font-weight:600;color:#1E5F74';
        aviso.textContent = '¿Me cuentas un poco más? Con un ejemplo o el paso a paso el diagnóstico sale mucho mejor. Si no hay más que decir, toca Continuar otra vez.';
        m.append(aviso); campo.focus(); return;
      }
      guardar(q, t); ir(1);
    };
    if (q.tipo === 'corto') campo.focus();
  } else {
    const multi = q.tipo === 'multi';
    const caja = document.createElement('div'); caja.className = 'ops' + (multi ? ' multi' : '');
    let sel = multi ? (S.r[q.id] || []).filter(x => q.op.includes(x)) : S.r[q.id];
    const otroPrevio = multi ? (S.r[q.id] || []).find(x => !q.op.includes(x)) || '' : '';
    q.op.forEach(o => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'op'; b.textContent = o;
      if (multi ? sel.includes(o) : sel === o) b.classList.add('sel');
      b.onclick = () => {
        if (multi) { sel = sel.includes(o) ? sel.filter(x => x !== o) : sel.concat(o); b.classList.toggle('sel'); act(); }
        else { guardar(q, o); ir(1); }
      };
      caja.append(b);
    });
    m.append(caja);
    let otro, act = () => {};
    if (multi) {
      otro = document.createElement('input'); otro.type = 'text'; otro.className = 'otro campo-otro'; otro.placeholder = 'Otro: escríbelo aquí'; otro.value = otroPrevio; m.append(otro);
      act = () => { sig.disabled = !sel.length && !otro.value.trim(); };
      otro.oninput = act; act();
      sig.onclick = () => { guardar(q, sel.concat(otro.value.trim() ? [otro.value.trim()] : [])); ir(1); };
    } else sig.disabled = vacia(S.r[q.id]);
  }
  pie(atras, saltar, espacio(), volver, sig);
  scrollTo(0, 0);
}

function terminar() {
  if (!S.fin) { S.fin = true; encolar({ accion: 'finalizar' }); }
  S.editando = false; persistir(); pantallaFinal();
}

function pantallaFinal() {
  const m = $('#main'); m.className = ''; $('#barra').style.width = '100%'; $('#etq').textContent = 'Resumen';
  const v = visibles().filter(q => q.tipo !== 'intro' && q.tipo !== 'permiso'), faltan = v.filter(q => vacia(S.r[q.id])).length;
  m.innerHTML = `<h1>Listo. Ya tengo el {mapa} de tu negocio`.replace(/\{(.+?)\}/, '<span class="res">$1</span>') + `</h1>
    <p class="ayuda">${faltan ? `Quedaron ${faltan} preguntas sin responder (están marcadas abajo). ` : ''}Puedes corregir cualquier respuesta o agregar un proceso que no haya salido. Este enlace te sirve para volver cuando quieras.</p>
    <div class="acciones"><button class="btn acc" id="mas">Agregar un proceso que faltó</button></div>
    <div id="extras"></div><div id="resumen"></div>`;
  $('#mas').onclick = pantallaExtra;
  if (S.extras.length) {
    $('#extras').innerHTML = '<h2>Procesos que agregaste</h2><div class="lista">' + S.extras.map((x, k) => `<button class="item" data-x="${k}"><b>${esc(x.nombre)} · ${esc(x.area)}</b><small>${esc(x.relato)}</small></button>`).join('') + '</div>';
    $('#extras').querySelectorAll('[data-x]').forEach(b => b.onclick = () => pantallaExtra(+b.dataset.x));
  }
  let html = '', area = '';
  v.forEach(q => {
    if (q.area !== area) { html += (area ? '</div>' : '') + `<h2>${esc(q.area)}</h2><div class="lista">`; area = q.area; }
    const r = S.r[q.id], t = vacia(r) ? 'Sin responder · toca para contestar' : Array.isArray(r) ? r.join(', ') : r;
    html += `<button class="item${vacia(r) ? ' vacio' : ''}" data-q="${q.id}"><b>${esc(plano(q.p))}</b><small>${esc(t)}</small></button>`;
  });
  $('#resumen').innerHTML = html + '</div>';
  $('#resumen').querySelectorAll('[data-q]').forEach(b => b.onclick = () => { S.editando = true; S.actual = b.dataset.q; persistir(); pintar(); });
  pie(); scrollTo(0, 0);
}

function pantallaExtra(k) {
  const nuevo = typeof k !== 'number', x = nuevo ? { nombre: '', area: AREAS_EXTRA[1], relato: '' } : S.extras[k];
  const idx = nuevo ? S.extras.length : k;
  const m = $('#main'); $('#etq').textContent = 'Proceso adicional';
  m.innerHTML = `<h1>Cuéntame ese <span class="res">proceso</span></h1><p class="ayuda">Ponle un nombre corto y cuéntalo paso a paso: quién lo hace, con qué y dónde se enreda.</p>
    <input type="text" id="xn" placeholder="Nombre. Ejemplo: Devoluciones"><select id="xa">${AREAS_EXTRA.map(a => `<option${a === x.area ? ' selected' : ''}>${a}</option>`).join('')}</select>`;
  $('#xn').value = x.nombre;
  const c = campoVoz(x.relato, () => 'extra_' + (idx + 1)); m.append(c.nodo);
  const ok = boton('Guardar proceso', 'acc', () => {
    pararVoz();
    const dato = { nombre: $('#xn').value.trim(), area: $('#xa').value, relato: c.area.value.trim() };
    S.extras[idx] = dato; persistir();
    encolar({ accion: 'guardar', id: 'extra_' + (idx + 1), area: dato.area, pregunta: 'PROCESO ADICIONAL: ' + dato.nombre, respuesta: dato.relato });
    pantallaFinal();
  });
  const act = () => { ok.disabled = !$('#xn').value.trim() || !c.area.value.trim(); };
  $('#xn').oninput = act; c.area.addEventListener('input', act); act();
  pie(boton('Cancelar', 'txt', () => { pararVoz(); pantallaFinal(); }), espacio(), ok); scrollTo(0, 0);
}

// Al abrir dentro de Google: recupera lo ya respondido (sirve para volver desde otro dispositivo)
async function recuperar() {
  if (!GAS) return;
  try {
    const j = await gas('cargar', CODIGO);
    if (!j.ok) { $('#main').innerHTML = '<h1>Este enlace no es <span class="res">válido</span></h1><p class="ayuda">Revisa que lo hayas copiado completo o pide uno nuevo.</p>'; $('#pie').innerHTML = ''; throw 0; }
    j.respuestas.forEach(x => {
      const q = PREGUNTAS.find(p => p.id === x.id);
      if (q && vacia(S.r[q.id])) S.r[q.id] = q.tipo === 'multi' ? x.respuesta.split(' | ') : x.respuesta;
      const m = /^extra_(d+)$/.exec(x.id);
      if (m && !S.extras[m[1] - 1]) S.extras[m[1] - 1] = { nombre: x.pregunta.replace('PROCESO ADICIONAL: ', ''), area: x.area, relato: x.respuesta };
    });
    S.extras = Array.from(S.extras, x => x || { nombre: '(sin nombre)', area: 'Otro', relato: '' });
    if (j.fin) S.fin = true;
    if (!S.actual) { const pend = visibles().find(q => q.tipo !== 'intro' && vacia(S.r[q.id])); if (pend && Object.keys(S.r).length) S.actual = pend.id; }
    persistir();
  } catch (e) { if (e === 0) throw e; }
}
recuperar().then(() => { pintar(); vaciarCola(); }, () => {});
