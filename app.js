/* ===================================================================
   GRITA PARA GANAR - PWA
   Tablet + microfono (el que el sistema tenga por defecto, sirve
   cualquiera inalambrico generico que se conecte como entrada de audio).

   Sin hardware extra: mide el grito con Web Audio y reparte premios.

   OJO / leccion aprendida del proyecto con hardware:
   hay que APAGAR autoGainControl y noiseSuppression. El AGC comprime
   el audio y hace que hablar normal mida casi lo mismo que gritar,
   con lo cual el juego no diferencia nada.
   =================================================================== */

'use strict';

/* ---------------- Configuracion por defecto ---------------- */
const CFG_DEF = {
  // Mapeo de 2 puntos (en dBFS): piso = habla normal -> 0 ; max = grito -> 100
  pisoDb: -38,
  maxDb:  -10,

  // Rangos de premio sobre el nivel 0..100
  minBajo:  25,   // debajo de esto: sin premio
  minMedio: 60,
  minAlto:  92,

  msGrito: 4000,  // duracion de la ventana de grito

  // Premios (editables desde el panel)
  nomBajo: 'Lata de Cola',  emoBajo: '\u{1F964}',
  nomMedio:'Tomatodo',      emoMedio:'\u{1F376}',
  nomAlto: 'Alexa',         emoAlto: '\u{1F50A}',

  // Sorteo oculto del premio mayor
  stockAlto: 2,
  altoMin:  10,   // se "arma" como pronto tras estos intentos
  altoMax:  40,   // ...y como tarde a los MAX (elegido al azar)
  variaTope: 8,   // cuanto varia el tope del medidor cuando no esta armado

  micId: ''       // dispositivo de entrada elegido
};

const LS_CFG    = 'gritoCfg';
const LS_SORTEO = 'gritoSorteo';
const LS_STATS  = 'gritoStats';

let cfg    = cargar(LS_CFG,    { ...CFG_DEF });
let sorteo = cargar(LS_SORTEO, null);
let stats  = cargar(LS_STATS,  { jugadas:0, sinPremio:0, bajo:0, medio:0, alto:0 });

function cargar(clave, porDefecto){
  try{
    const v = JSON.parse(localStorage.getItem(clave));
    if(v && typeof v === 'object') return clave === LS_CFG ? { ...CFG_DEF, ...v } : v;
  }catch(e){}
  return porDefecto;
}
const guardarCfg    = () => localStorage.setItem(LS_CFG,    JSON.stringify(cfg));
const guardarSorteo = () => localStorage.setItem(LS_SORTEO, JSON.stringify(sorteo));
const guardarStats  = () => localStorage.setItem(LS_STATS,  JSON.stringify(stats));

/* ---------------- Atajos DOM ---------------- */
const $ = (id) => document.getElementById(id);
const PANTALLAS = ['p-permiso','p-reposo','p-cuenta','p-grito','p-premio','p-admin'];
function mostrar(id){
  PANTALLAS.forEach(p => $(p).classList.toggle('activa', p === id));
}
function toast(txt){
  const t = $('toast');
  t.textContent = txt; t.classList.add('ver');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('ver'), 1600);
}

/* ---------------- Audio ---------------- */
let audioCtx = null, analizador = null, bufer = null, streamActual = null;
let audioListo = false;

async function iniciarAudio(deviceId){
  // Cerrar el stream anterior si se cambia de microfono
  if(streamActual) streamActual.getTracks().forEach(t => t.stop());

  const restricciones = {
    audio: {
      echoCancellation: false,   // <- los tres van APAGADOS a proposito:
      noiseSuppression: false,   //    si no, el navegador comprime/filtra
      autoGainControl:  false,   //    y gritar mide igual que hablar
      channelCount: 1
    }
  };
  if(deviceId) restricciones.audio.deviceId = { exact: deviceId };

  streamActual = await navigator.mediaDevices.getUserMedia(restricciones);

  if(!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if(audioCtx.state === 'suspended') await audioCtx.resume();

  const fuente = audioCtx.createMediaStreamSource(streamActual);
  analizador = audioCtx.createAnalyser();
  analizador.fftSize = 1024;
  analizador.smoothingTimeConstant = 0;   // sin suavizado interno: lo hacemos nosotros
  fuente.connect(analizador);
  bufer = new Float32Array(analizador.fftSize);

  audioListo = true;
  listarMicrofonos();
}

// Nivel de sonido instantaneo en dBFS (RMS de la ventana)
function leerDb(){
  if(!audioListo) return -99;
  analizador.getFloatTimeDomainData(bufer);
  let suma = 0;
  for(let i = 0; i < bufer.length; i++) suma += bufer[i] * bufer[i];
  const rms = Math.sqrt(suma / bufer.length);
  return 20 * Math.log10(rms + 1e-9);   // el epsilon evita log10(0)
}

// dB -> nivel 0..100 con el mapeo de 2 puntos calibrado
function dbANivel(db){
  if(db <= cfg.pisoDb) return 0;
  const span = Math.max(cfg.maxDb - cfg.pisoDb, 1);
  return Math.max(0, Math.min(100, Math.round((db - cfg.pisoDb) * 100 / span)));
}

async function listarMicrofonos(){
  try{
    const disp = await navigator.mediaDevices.enumerateDevices();
    const mics = disp.filter(d => d.kind === 'audioinput');
    const sel = $('selMic');
    sel.innerHTML = '';
    mics.forEach((m, i) => {
      const o = document.createElement('option');
      o.value = m.deviceId;
      o.textContent = m.label || `Micrófono ${i + 1}`;
      sel.appendChild(o);
    });
    if(cfg.micId) sel.value = cfg.micId;
  }catch(e){ /* sin permisos aun */ }
}

/* ---------------- Sonidos (sin archivos) ---------------- */
function bip(freq, dur = .12, tipo = 'sine', vol = .18){
  if(!audioCtx) return;
  try{
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = tipo; o.frequency.value = freq; g.gain.value = vol;
    o.connect(g); g.connect(audioCtx.destination);
    o.start();
    g.gain.exponentialRampToValueAtTime(.0001, audioCtx.currentTime + dur);
    o.stop(audioCtx.currentTime + dur);
  }catch(e){}
}
const fanfarria = () => [523,659,784,1046,1318].forEach((f,i) => setTimeout(() => bip(f,.22,'triangle',.2), i*120));
const trombon   = () => { bip(300,.3,'sine',.16); setTimeout(() => bip(200,.4,'sine',.16), 200); };

/* ---------------- Sorteo oculto del premio mayor ---------------- */
/* Misma estrategia que el juego con hardware: se elige AL AZAR un intento
   futuro donde el premio mayor se "arma". Desde ahi lo gana el primer grito
   suficientemente fuerte. Mientras NO esta armado, el medidor se topa justo
   debajo del umbral (con variacion) para no delatar nada.               */
function nuevoTarget(){
  const rango = Math.max(cfg.altoMax - cfg.altoMin + 1, 1);
  sorteo.target  = sorteo.intentos + cfg.altoMin + Math.floor(Math.random() * rango);
  sorteo.armado  = false;
  guardarSorteo();
}
function iniciarSorteo(reset){
  if(reset || !sorteo){
    sorteo = { stock: cfg.stockAlto, intentos: 0, target: 0, armado: false };
    nuevoTarget();
  }
}
iniciarSorteo(false);

/* ---------------- Estado del juego ---------------- */
let estado = 'permiso';
let picoReal = 0;        // pico REAL (decide el premio)
let picoVisto = 0;       // pico MOSTRADO (lo que ve el jugador, puede ir topado)
let topeVisto = 100;
let nivelSuavizado = 0;
let finGrito = 0;
let rafId = null;

const CIRC = 2 * Math.PI * 100;   // circunferencia del arco (r=100)

function irA(nuevo){
  estado = nuevo;
  document.body.classList.remove('panel-abierto');
  mostrar('p-' + nuevo);
}

/* ---------------- Reposo ---------------- */
function pintarTiraPremios(){
  $('tiraPremios').innerHTML = `
    <div class="premio-chip"><span class="emo">${cfg.emoBajo}</span>${cfg.nomBajo}</div>
    <div class="premio-chip"><span class="emo">${cfg.emoMedio}</span>${cfg.nomMedio}</div>
    <div class="premio-chip alto"><span class="emo">${cfg.emoAlto}</span>${cfg.nomAlto}</div>`;
}

function pantallaCompleta(){
  const el = document.documentElement;
  const fn = el.requestFullscreen || el.webkitRequestFullscreen;
  if(fn) { try{ fn.call(el); }catch(e){} }
}

/* ---------------- Arranque de una partida ---------------- */
function empezarJuego(){
  if(estado !== 'reposo') return;
  pantallaCompleta();
  if(audioCtx && audioCtx.state === 'suspended') audioCtx.resume();

  // Se cuenta el intento y se decide si el premio mayor queda ARMADO
  sorteo.intentos++;
  if(!sorteo.armado && sorteo.stock > 0 && sorteo.intentos >= sorteo.target){
    sorteo.armado = true;
  }
  // Tope del medidor para ESTA partida
  if(sorteo.armado && sorteo.stock > 0){
    topeVisto = 100;                                   // libre: puede llegar al rojo
  }else{
    const v = Math.max(cfg.variaTope, 1);
    topeVisto = (cfg.minAlto - 1) - Math.floor(Math.random() * v);
  }
  guardarSorteo();

  picoReal = 0; picoVisto = 0; nivelSuavizado = 0;
  cuentaRegresiva(3);
}

function cuentaRegresiva(n){
  irA('cuenta');
  const el = $('cuentaNum');
  el.textContent = n;
  el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
  bip(700 + (3 - n) * 120, .14, 'square', .16);

  setTimeout(() => {
    if(n > 1) cuentaRegresiva(n - 1);
    else empezarGrito();
  }, 1000);
}

function empezarGrito(){
  irA('grito');
  bip(1100, .3, 'square', .2);
  pintarMarcasUmbral();
  $('arcoRelleno').style.strokeDashoffset = CIRC;
  $('nivelNum').textContent = '0';
  $('picoVal').textContent  = '0';
  finGrito = performance.now() + cfg.msGrito;
  if(!rafId) rafId = requestAnimationFrame(bucle);
}

// marcas de los umbrales sobre el arco
function pintarMarcasUmbral(){
  const g = $('marcasUmbral');
  g.innerHTML = '';
  [[cfg.minBajo,''],[cfg.minMedio,''],[cfg.minAlto,'alto']].forEach(([n, cls]) => {
    const a = (n / 100) * 2 * Math.PI;
    const l = document.createElementNS('http://www.w3.org/2000/svg','line');
    l.setAttribute('x1', 120 + 90  * Math.cos(a)); l.setAttribute('y1', 120 + 90  * Math.sin(a));
    l.setAttribute('x2', 120 + 110 * Math.cos(a)); l.setAttribute('y2', 120 + 110 * Math.sin(a));
    l.setAttribute('class', 'marca ' + cls);
    g.appendChild(l);
  });
}

/* ---------------- Bucle de render ---------------- */
function bucle(){
  rafId = requestAnimationFrame(bucle);
  const db = leerDb();
  const nivel = dbANivel(db);

  if(estado === 'grito'){
    // ataque rapido / caida suave: se ve mucho mejor en el medidor
    nivelSuavizado = Math.max(nivel, nivelSuavizado * .88);

    if(nivel > picoReal) picoReal = nivel;                       // pico REAL: define el premio
    const visto = Math.min(nivelSuavizado, topeVisto);           // lo que ve el jugador
    if(visto > picoVisto) picoVisto = Math.round(visto);

    $('arcoRelleno').style.strokeDashoffset = CIRC * (1 - visto / 100);
    $('nivelNum').textContent = Math.round(visto);
    $('picoVal').textContent  = picoVisto;
    document.body.classList.toggle('sacudir', visto > 75);

    if(visto > 55) lanzarOnda(visto);

    if(performance.now() >= finGrito) terminarGrito();
  }
  else if(estado === 'admin'){
    $('liveFill').style.width  = nivel + '%';
    $('liveNivel').textContent = nivel;
    $('liveDb').textContent    = db.toFixed(1);
    $('livePremio').textContent = etiquetaPremio(nivel);
    if(capturando) procesarCaptura(db);
  }
  else if(estado !== 'grito' && estado !== 'admin'){
    // nada que dibujar: ahorramos trabajo
  }
}

let ondaTic = 0;
function lanzarOnda(intensidad){
  const ahora = performance.now();
  if(ahora - ondaTic < 260) return;
  ondaTic = ahora;
  const o = ondaTic % 2 === 0 ? $('onda1') : $('onda2');
  o.animate(
    [ { transform:'scale(.85)', opacity: .55 }, { transform:'scale(1.5)', opacity: 0 } ],
    { duration: 900, easing: 'ease-out' }
  );
}

/* ---------------- Fin del grito: decidir premio ---------------- */
function decidirPremio(pico){
  if(pico < cfg.minBajo) return 'nada';
  if(sorteo.armado && sorteo.stock > 0 && pico >= cfg.minAlto){
    sorteo.stock--;
    nuevoTarget();               // recien ahora entra a jugar el siguiente
    return 'alto';
  }
  if(pico >= cfg.minMedio) return 'medio';
  return 'bajo';
}

function terminarGrito(){
  document.body.classList.remove('sacudir');
  const cual = decidirPremio(picoReal);

  stats.jugadas++;
  stats[cual === 'nada' ? 'sinPremio' : cual]++;
  guardarStats();

  irA('premio');
  const tit = $('premioTitulo');

  if(cual === 'nada'){
    tit.textContent = '¡CASI!';
    tit.classList.add('flojo');
    $('premioIcono').textContent  = '\u{1F4AA}';
    $('premioNombre').textContent = '¡Grita más fuerte!';
    $('premioCta').textContent    = 'Vuelve a intentarlo';
    trombon();
  }else{
    const nom = cual === 'alto' ? cfg.nomAlto : cual === 'medio' ? cfg.nomMedio : cfg.nomBajo;
    const emo = cual === 'alto' ? cfg.emoAlto : cual === 'medio' ? cfg.emoMedio : cfg.emoBajo;
    tit.textContent = '¡GANASTE!';
    tit.classList.remove('flojo');
    $('premioIcono').textContent  = emo;
    $('premioNombre').textContent = nom;
    $('premioCta').textContent    = 'Reclama tu premio';
    fanfarria();
    confeti(cual === 'alto' ? 260 : 150);
  }
  $('premioNivel').textContent = picoVisto;

  clearTimeout(terminarGrito._t);
  terminarGrito._t = setTimeout(volverAReposo, 9000);   // vuelve solo
}

function volverAReposo(){
  clearTimeout(terminarGrito._t);
  pararConfeti();
  pintarTiraPremios();
  irA('reposo');
}

/* ---------------- Confeti ---------------- */
const cv = $('confeti'); const cx = cv.getContext('2d');
let piezas = [], animando = false, rafConf = null;
function ajustarLienzo(){ cv.width = innerWidth; cv.height = innerHeight; }
addEventListener('resize', ajustarLienzo); ajustarLienzo();

function confeti(n){
  const cols = ['#00e5ff','#ff2d95','#ffd23f','#00ff9d','#ffffff','#ff7a2d'];
  piezas = [];
  for(let i = 0; i < n; i++){
    piezas.push({
      x: Math.random() * cv.width, y: -20 - Math.random() * cv.height,
      w: 6 + Math.random() * 9, h: 9 + Math.random() * 12,
      vy: 2.2 + Math.random() * 4.5, vx: -1.6 + Math.random() * 3.2,
      rot: Math.random() * 6.28, vr: -.22 + Math.random() * .44,
      col: cols[(Math.random() * cols.length) | 0]
    });
  }
  if(!animando){ animando = true; pintarConfeti(); }
}
function pintarConfeti(){
  cx.clearRect(0, 0, cv.width, cv.height);
  piezas.forEach(p => {
    p.x += p.vx; p.y += p.vy; p.rot += p.vr;
    cx.save(); cx.translate(p.x, p.y); cx.rotate(p.rot);
    cx.fillStyle = p.col; cx.fillRect(-p.w/2, -p.h/2, p.w, p.h); cx.restore();
  });
  piezas = piezas.filter(p => p.y < cv.height + 40);
  if(piezas.length){ rafConf = requestAnimationFrame(pintarConfeti); }
  else { animando = false; cx.clearRect(0, 0, cv.width, cv.height); }
}
function pararConfeti(){
  if(rafConf) cancelAnimationFrame(rafConf);
  animando = false; piezas = []; cx.clearRect(0, 0, cv.width, cv.height);
}

/* ---------------- Panel de ajustes ---------------- */
function etiquetaPremio(n){
  if(n < cfg.minBajo)  return 'sin premio';
  if(n < cfg.minMedio) return cfg.nomBajo;
  if(n < cfg.minAlto)  return cfg.nomMedio;
  return cfg.nomAlto + ' (califica)';
}

const LIMITES = {
  pisoDb:[-90,0], maxDb:[-90,0],
  minBajo:[0,100], minMedio:[0,100], minAlto:[0,100],
  msGrito:[1000,15000],
  stockAlto:[0,99], altoMin:[1,500], altoMax:[1,500]
};

function pintarPanel(){
  ['pisoDb','maxDb','minBajo','minMedio','minAlto','stockAlto','altoMin','altoMax']
    .forEach(k => { const e = $('v-' + k); if(e) e.textContent = cfg[k]; });
  $('v-msGrito').textContent = (cfg.msGrito / 1000).toFixed(1);

  $('txtBajo').value  = cfg.nomBajo;  $('emoBajo').value  = cfg.emoBajo;
  $('txtMedio').value = cfg.nomMedio; $('emoMedio').value = cfg.emoMedio;
  $('txtAlto').value  = cfg.nomAlto;  $('emoAlto').value  = cfg.emoAlto;
  $('lbl1').textContent = cfg.nomBajo;
  $('lbl2').textContent = cfg.nomMedio;
  $('lbl3').textContent = cfg.nomAlto;

  $('estadoSorteo').textContent =
    `Stock: ${sorteo.stock} · intentos jugados: ${sorteo.intentos} · ` +
    (sorteo.armado ? 'ARMADO (lo gana el próximo grito fuerte)'
                   : `se arma en el intento #${sorteo.target}`);

  $('stats').innerHTML = `
    <div class="stat"><div class="n">${stats.jugadas}</div><div class="t">jugadas</div></div>
    <div class="stat"><div class="n">${stats.sinPremio}</div><div class="t">sin premio</div></div>
    <div class="stat"><div class="n">${stats.bajo}</div><div class="t">${cfg.nomBajo}</div></div>
    <div class="stat"><div class="n">${stats.medio}</div><div class="t">${cfg.nomMedio}</div></div>
    <div class="stat"><div class="n">${stats.alto}</div><div class="t">${cfg.nomAlto}</div></div>`;
}

function abrirPanel(){
  estado = 'admin';
  document.body.classList.add('panel-abierto');
  mostrar('p-admin');
  pintarPanel();
  pintarLog();
  listarMicrofonos();
  if(!rafId) rafId = requestAnimationFrame(bucle);
}

/* ----- Prueba de gritos: premio SOLO por nivel (sin sorteo oculto) ----- */
/* Esto es para AFINAR: muestra que premio daria cada grito con los rangos
   actuales, igual que el calibrador de la cabina. No consume el sorteo. */
function premioDeNivel(n){
  if(n < cfg.minBajo)  return { txt:'SIN PREMIO',  cls:'p-nada'  };
  if(n < cfg.minMedio) return { txt:cfg.nomBajo,   cls:'p-bajo'  };
  if(n < cfg.minAlto)  return { txt:cfg.nomMedio,  cls:'p-medio' };
  return                      { txt:cfg.nomAlto,   cls:'p-alto'  };
}

let logPicos = [];   // gritos de prueba de esta sesion (no se guarda)
function pintarLog(){
  const c = $('logGritos'), res = $('logResumen'), btn = $('btnLimpiarLog');
  if(!logPicos.length){
    c.innerHTML = '';
    res.textContent = 'Aún no hay gritos medidos.';
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  const cuenta = { 'p-nada':0, 'p-bajo':0, 'p-medio':0, 'p-alto':0 };
  logPicos.forEach(r => cuenta[r.cls]++);
  res.innerHTML =
    `${logPicos.length} gritos · ` +
    `sin premio <b>${cuenta['p-nada']}</b> · ` +
    `${cfg.nomBajo} <b>${cuenta['p-bajo']}</b> · ` +
    `${cfg.nomMedio} <b>${cuenta['p-medio']}</b> · ` +
    `${cfg.nomAlto} <b>${cuenta['p-alto']}</b>`;
  const n = logPicos.length;
  c.innerHTML = logPicos.map((r, i) => `
    <div class="log-fila">
      <span class="log-n">#${n - i}</span>
      <span class="log-niv">${r.nivel}</span>
      <span class="log-prem ${r.cls}">${r.txt}</span>
    </div>`).join('');
}

/* ----- Captura (HABLA / GRITO para calibrar · PICO para probar) ----- */
let capturando = null, capFin = 0, capSuma = 0, capN = 0, capPico = -99;
function iniciarCaptura(tipo){
  capturando = tipo;
  capFin  = performance.now() + (tipo === 'piso' ? 2000 : 3000);
  capSuma = 0; capN = 0; capPico = -99;
  toast(tipo === 'piso' ? 'Midiendo el ambiente...' : '¡GRITA AHORA!');
}
function procesarCaptura(db){
  if(capturando === 'piso'){ capSuma += db; capN++; }
  else if(db > capPico) capPico = db;          // grito y pico: se quedan con el máximo

  if(performance.now() < capFin) return;

  // PICO: solo prueba, agrega a la lista sin tocar la calibracion
  if(capturando === 'pico'){
    const nivel = dbANivel(capPico);
    const p = premioDeNivel(nivel);
    logPicos.unshift({ nivel, txt: p.txt, cls: p.cls });
    if(logPicos.length > 30) logPicos.pop();
    capturando = null;
    pintarLog();
    toast(`Pico: nivel ${nivel} → ${p.txt}`);
    return;
  }

  // HABLA / GRITO: fijan la calibracion
  if(capturando === 'piso' && capN){
    cfg.pisoDb = Math.round(capSuma / capN + 3);   // +3 dB de margen sobre el ruido
  }else if(capturando === 'grito'){
    cfg.maxDb = Math.round(capPico);
  }
  if(cfg.maxDb <= cfg.pisoDb) cfg.maxDb = cfg.pisoDb + 6;   // evita rango invertido
  capturando = null;
  guardarCfg(); pintarPanel(); toast('Calibrado ✔');
}

/* ---------------- Eventos ---------------- */
$('btnActivar').addEventListener('click', async () => {
  try{
    await iniciarAudio(cfg.micId || undefined);
    pintarTiraPremios();
    irA('reposo');
    if(!rafId) rafId = requestAnimationFrame(bucle);
  }catch(e){
    $('notaPermiso').textContent =
      'No se pudo abrir el micrófono: ' + (e && e.message ? e.message : e) +
      '. Revisa el permiso del navegador y que la página sea https:// o localhost.';
  }
});

$('p-reposo').addEventListener('pointerdown', empezarJuego);
$('btnOtraVez').addEventListener('click', (e) => { e.stopPropagation(); volverAReposo(); });
$('p-premio').addEventListener('pointerdown', () => { if(estado === 'premio') volverAReposo(); });

// steppers del panel
document.querySelectorAll('.stepper button').forEach(b => {
  b.addEventListener('click', () => {
    const k = b.dataset.k, d = parseInt(b.dataset.d, 10);
    const lim = LIMITES[k] || [-9999, 9999];
    cfg[k] = Math.max(lim[0], Math.min(lim[1], (cfg[k] || 0) + d));
    guardarCfg(); pintarPanel();
  });
});

// nombres / emojis
const enlazarTexto = (idInput, clave) => {
  $(idInput).addEventListener('input', e => {
    cfg[clave] = e.target.value; guardarCfg();
    $('lbl1').textContent = cfg.nomBajo;
    $('lbl2').textContent = cfg.nomMedio;
    $('lbl3').textContent = cfg.nomAlto;
  });
};
enlazarTexto('txtBajo','nomBajo');   enlazarTexto('emoBajo','emoBajo');
enlazarTexto('txtMedio','nomMedio'); enlazarTexto('emoMedio','emoMedio');
enlazarTexto('txtAlto','nomAlto');   enlazarTexto('emoAlto','emoAlto');

$('btnFijarHabla').addEventListener('click', () => iniciarCaptura('piso'));
$('btnFijarGrito').addEventListener('click', () => iniciarCaptura('grito'));
$('btnMedirPico').addEventListener('click', () => iniciarCaptura('pico'));
$('btnLimpiarLog').addEventListener('click', () => { logPicos = []; pintarLog(); });

$('selMic').addEventListener('change', async e => {
  cfg.micId = e.target.value; guardarCfg();
  try{ await iniciarAudio(cfg.micId); toast('Micrófono cambiado'); }
  catch(err){ toast('No se pudo usar ese micrófono'); }
});

$('btnResetSorteo').addEventListener('click', () => {
  iniciarSorteo(true); pintarPanel(); toast('Sorteo reiniciado');
});
$('btnResetStats').addEventListener('click', () => {
  stats = { jugadas:0, sinPremio:0, bajo:0, medio:0, alto:0 };
  guardarStats(); pintarPanel(); toast('Estadísticas borradas');
});
$('btnRestaurar').addEventListener('click', () => {
  const mic = cfg.micId;
  cfg = { ...CFG_DEF, micId: mic };
  guardarCfg(); pintarPanel(); pintarTiraPremios(); toast('Valores restaurados');
});
$('btnCerrarPanel').addEventListener('click', () => {
  pintarTiraPremios();
  irA(audioListo ? 'reposo' : 'permiso');
});

// boton de ajustes: un solo toque en la esquina superior derecha
$('btnTuerca').addEventListener('click', (e) => { e.stopPropagation(); abrirPanel(); });

// evita el zoom por doble toque
document.addEventListener('dblclick', e => e.preventDefault(), { passive:false });

/* ---------------- Service worker (offline) ---------------- */
if('serviceWorker' in navigator){
  addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
