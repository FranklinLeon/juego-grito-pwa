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

  // Premios de la campaña (escalafon del PDF). Los dibujos son fijos,
  // salidos del arte; desde el panel solo se edita el texto.
  cfgVer:  2,
  nomBajo: 'Souvenir',
  nomMedio:'Merchandising',
  nomAlto: 'Mega Regalo',

  // Sorteo oculto del premio mayor
  stockAlto: 2,
  altoMin:  10,   // se "arma" como pronto tras estos intentos
  altoMax:  40,   // ...y como tarde a los MAX (elegido al azar)
  variaTope: 8,   // cuanto varia el tope del medidor cuando no esta armado

  marca: 'mirasol',   // 'mirasol' | 'proauto' (solo cambia el logo)
  micId: ''       // dispositivo de entrada elegido
};

// Subir junto con VERSION en sw.js: asi el panel de ajustes deja ver a
// simple vista si la tablet ya tiene la ultima version instalada.
const APP_VERSION = 'v7';

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

/* Migracion de config: las tablets que ya usaron la version anterior tienen
   guardados los premios viejos (Lata de Cola / Tomatodo / Alexa) y el merge
   con CFG_DEF los conservaria para siempre. Al subir cfgVer se reescriben.

   OJO: hay que mirar el objeto CRUDO de localStorage, no `cfg`. Como cargar()
   hace {...CFG_DEF, ...guardado}, una config vieja (sin cfgVer) hereda el
   cfgVer de los defaults y la comprobacion nunca detectaria nada. */
(function migrarCfg(){
  let bruto = null;
  try{ bruto = JSON.parse(localStorage.getItem(LS_CFG)); }catch(e){}
  if(!bruto || typeof bruto !== 'object') return;      // instalacion nueva: ya trae los defaults
  if(bruto.cfgVer === CFG_DEF.cfgVer) return;
  cfg.nomBajo  = CFG_DEF.nomBajo;
  cfg.nomMedio = CFG_DEF.nomMedio;
  cfg.nomAlto  = CFG_DEF.nomAlto;
  delete cfg.emoBajo; delete cfg.emoMedio; delete cfg.emoAlto;
  cfg.cfgVer = CFG_DEF.cfgVer;
  guardarCfg();
})();

/* Dibujos de cada premio (fijos, recortados del PDF de la campaña) */
const IMG_PREMIO = {
  bajo:  'marca/premio-verde.png',
  medio: 'marca/premio-naranja.png',
  alto:  'marca/premio-rojo.png'
};
const escapar = (t) => String(t).replace(/[&<>"]/g, c =>
  ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]));

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
let senalMala = 0;   // lecturas no-finitas seguidas (mic conectado pero con datos invalidos)

/* Datos crudos del mic para el panel de diagnostico: con esto se ve de una
   si el problema es la frecuencia, el track silenciado o muestras invalidas,
   en vez de tener que adivinar desde otro sitio. */
let diag = {
  intento:'—', trackLabel:'—', trackSR:0, ctxSR:0, canales:0,
  rms:0, noFinitos:0, mudo:null, estadoPista:'—'
};

/* No todos los microfonos/drivers Android aceptan igual las restricciones
   estrictas (mono forzado, deviceId exacto). Un mic USB/Bluetooth que en
   una tablet funciona bien puede en otra devolver un stream "valido" para
   getUserMedia pero con datos corruptos (se ve como NIVEL=NaN en el panel),
   porque el driver de esa tablet no soporta bien esa combinacion. Por eso
   se prueba en 3 niveles, cada uno menos exigente que el anterior. */
async function pedirStream(deviceId){
  const base = { echoCancellation:false, noiseSuppression:false, autoGainControl:false };
  const intentos = [
    deviceId ? { ...base, channelCount:1, deviceId:{ exact:deviceId } } : { ...base, channelCount:1 },
    deviceId ? { ...base, deviceId:{ exact:deviceId } } : { ...base },   // sin forzar mono
    deviceId ? { deviceId:{ exact:deviceId } } : true                    // solo el dispositivo, con AGC del sistema
  ];
  let ultimoError = null;
  for(let i = 0; i < intentos.length; i++){
    try{
      const s = await navigator.mediaDevices.getUserMedia({ audio: intentos[i] });
      diag.intento = `${i + 1} de ${intentos.length}`;
      return s;
    }catch(e){ ultimoError = e; }
  }
  throw ultimoError;
}

async function iniciarAudio(deviceId){
  // Cerrar el stream anterior si se cambia de microfono
  if(streamActual) streamActual.getTracks().forEach(t => t.stop());

  streamActual = await pedirStream(deviceId);

  /* CLAVE: el AudioContext queda clavado a la frecuencia de muestreo con la
     que se creo (la del primer mic usado, normalmente el interno a 48 kHz).
     Si luego se conecta un mic externo que trabaja a otra frecuencia (16 kHz
     es comun en USB/Bluetooth), Chrome en Android no siempre resamplea bien
     ese MediaStreamSource: entrega silencio o muestras basura. Por eso el mic
     graba perfecto en la app de audio del sistema (que abre su propia cadena
     a la frecuencia nativa) y en cambio aqui no daba nivel.
     Solucion: si la frecuencia del mic no coincide, se recrea el contexto. */
  const pista = streamActual.getAudioTracks()[0];
  const cfgPista = pista && pista.getSettings ? pista.getSettings() : {};
  const srMic = cfgPista.sampleRate || 0;

  if(audioCtx && srMic && audioCtx.sampleRate !== srMic){
    try{ await audioCtx.close(); }catch(e){}
    audioCtx = null;
  }
  if(!audioCtx){
    const Ctor = window.AudioContext || window.webkitAudioContext;
    // si el navegador rechaza esa frecuencia, se cae al contexto por defecto
    try{ audioCtx = srMic ? new Ctor({ sampleRate: srMic }) : new Ctor(); }
    catch(e){ audioCtx = new Ctor(); }
  }
  if(audioCtx.state === 'suspended') await audioCtx.resume();

  diag.trackLabel = (pista && pista.label) || '—';
  diag.trackSR    = srMic || 0;
  diag.ctxSR      = audioCtx.sampleRate || 0;
  diag.canales    = cfgPista.channelCount || 0;

  const fuente = audioCtx.createMediaStreamSource(streamActual);
  analizador = audioCtx.createAnalyser();
  analizador.fftSize = 1024;
  analizador.smoothingTimeConstant = 0;   // sin suavizado interno: lo hacemos nosotros
  fuente.connect(analizador);
  bufer = new Float32Array(analizador.fftSize);

  audioListo = true;
  senalMala = 0;
  listarMicrofonos();

  // Si el stream "conecto" pero el mic entrega datos invalidos (pasa con
  // ciertos drivers Bluetooth/USB en Android), detectarlo pronto y avisar
  // en vez de dejar que el panel muestre NaN sin explicacion.
  setTimeout(() => {
    if(audioListo && senalMala > 20){
      toast('Este micrófono no está dando datos válidos en esta tablet');
    }
  }, 700);
}

// Nivel de sonido instantaneo en dBFS (RMS de la ventana de FFT)
function leerDb(){
  if(!audioListo) return -99;
  analizador.getFloatTimeDomainData(bufer);

  /* Se promedia SOLO sobre las muestras validas. Antes bastaba una muestra
     NaN para envenenar toda la suma y tirar la lectura entera; asi un mic
     que entrega algun frame sucio sigue midiendo con el resto. */
  let suma = 0, validas = 0, noFin = 0;
  for(let i = 0; i < bufer.length; i++){
    const v = bufer[i];
    if(Number.isFinite(v)){ suma += v * v; validas++; }
    else noFin++;
  }
  diag.noFinitos = noFin;

  if(!validas){ senalMala++; diag.rms = 0; return -99; }

  const rms = Math.sqrt(suma / validas);
  diag.rms = rms;
  const db = 20 * Math.log10(rms + 1e-9);   // el epsilon evita log10(0)

  if(!Number.isFinite(db)){ senalMala++; return -99; }
  senalMala = 0;
  return db;
}

// Promedio de los ultimos VENTANA_MS: un mic barato se satura/clipea por
// 1-2 frames con una plosiva o un golpe de aire, y ese instante SOLO
// (leerDb crudo) puede marcar un pico que el jugador nunca vio en el
// medidor. Promediando en una ventana corta, todo el juego (medidor,
// pico que decide el premio, y las calibraciones HABLA/GRITO/PICO) lee
// el mismo numero suavizado y deja de "regalar" premios por un click.
const VENTANA_MS = 200;
let ventanaDb = [];
function leerDbSuavizado(){
  const dbInstant = leerDb();
  const ahora = performance.now();
  ventanaDb.push({ t: ahora, db: dbInstant });
  while(ventanaDb.length > 1 && ahora - ventanaDb[0].t > VENTANA_MS) ventanaDb.shift();
  let suma = 0;
  for(const e of ventanaDb) suma += e.db;
  return suma / ventanaDb.length;
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

/* ---------------- Marca (Mirasol / Proauto) ---------------- */
/* Lo unico que cambia entre las dos es el wordmark de arriba. Se puede
   fijar por URL (?marca=proauto) para dejar cada tablet clavada en su
   marca sin tener que entrar al panel. */
const MARCAS = { mirasol:'marca/mirasol.png', proauto:'marca/proauto.png' };

function aplicarMarca(){
  const src = MARCAS[cfg.marca] || MARCAS.mirasol;
  document.querySelectorAll('.marca-wordmark').forEach(img => { img.src = src; });
  const bM = $('btnMarcaMirasol'), bP = $('btnMarcaProauto');
  if(bM) bM.classList.toggle('sel', cfg.marca === 'mirasol');
  if(bP) bP.classList.toggle('sel', cfg.marca === 'proauto');
}
(function marcaPorURL(){
  const m = (new URLSearchParams(location.search).get('marca') || '').toLowerCase();
  if(MARCAS[m] && m !== cfg.marca){ cfg.marca = m; guardarCfg(); }
})();

function irA(nuevo){
  estado = nuevo;
  document.body.classList.remove('panel-abierto');
  mostrar('p-' + nuevo);
}

/* ---------------- Reposo ---------------- */
function pintarTiraPremios(){
  $('tiraPremios').innerHTML =
    [['bajo', cfg.nomBajo], ['medio', cfg.nomMedio], ['alto', cfg.nomAlto]]
      .map(([k, nom]) => `
        <div class="premio-item ${k}">
          <img src="${IMG_PREMIO[k]}" alt="">
          <div class="premio-nom">${escapar(nom)}</div>
          <div class="premio-linea"></div>
        </div>`).join('');
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
  $('barraFill').style.clipPath = 'inset(0 100% 0 0)';
  $('nivelNum').textContent  = '0';
  $('picoVal').textContent   = '0';
  dibujarEscena(0);
  finGrito = performance.now() + cfg.msGrito;
  if(!rafId) rafId = requestAnimationFrame(bucle);
}

// marcas de los umbrales sobre la barra
function pintarMarcasUmbral(){
  $('marcasUmbral').innerHTML =
    [[cfg.minBajo,''],[cfg.minMedio,''],[cfg.minAlto,'alto']]
      .map(([n, cls]) => `<i class="${cls}" style="left:${n}%"></i>`).join('');
}

/* El arte ES el medidor: la boca se abre y las lineas de grito salen
   disparadas hacia afuera segun el volumen. */
function dibujarEscena(nivel){
  const k = Math.max(0, Math.min(100, nivel)) / 100;
  $('bocaGrito').style.transform = `scale(${(1 + k * .34).toFixed(3)})`;
  const desp = (k * 15).toFixed(1), esc = (1 + k * .55).toFixed(3), op = (.3 + k * .7).toFixed(2);
  const li = $('lineasIzqG'), ld = $('lineasDerG');
  li.style.transform = `translateX(-${desp}%) scale(${esc})`;
  ld.style.transform = `translateX(${desp}%) scale(${esc})`;
  li.style.opacity = ld.style.opacity = op;
}

/* ---------------- Bucle de render ---------------- */
function bucle(){
  rafId = requestAnimationFrame(bucle);
  const db = leerDbSuavizado();
  const nivel = dbANivel(db);

  if(estado === 'grito'){
    // ataque rapido / caida suave: se ve mucho mejor en el medidor
    nivelSuavizado = Math.max(nivel, nivelSuavizado * .88);

    if(nivel > picoReal) picoReal = nivel;                       // pico REAL: define el premio
    const visto = Math.min(nivelSuavizado, topeVisto);           // lo que ve el jugador
    if(visto > picoVisto) picoVisto = Math.round(visto);

    $('barraFill').style.clipPath = `inset(0 ${100 - visto}% 0 0)`;
    $('nivelNum').textContent = Math.round(visto);
    $('picoVal').textContent  = picoVisto;
    dibujarEscena(visto);
    document.body.classList.toggle('sacudir', visto > 75);

    if(performance.now() >= finGrito) terminarGrito();
  }
  else if(estado === 'admin'){
    $('liveFill').style.clipPath = `inset(0 ${100 - nivel}% 0 0)`;
    $('liveNivel').textContent = nivel;
    $('liveDb').textContent    = Number.isFinite(db) ? db.toFixed(1) : '—';
    // senalMala alto = el mic esta "conectado" pero sin datos usables (pasa
    // con algunos drivers Bluetooth/USB en Android): mejor decirlo claro
    // que dejar el panel mostrando ceros o guiones sin explicacion.
    $('livePremio').textContent = senalMala > 20
      ? '⚠ mic sin señal válida — prueba otro micrófono'
      : etiquetaPremio(nivel);
    pintarDiag();
    if(capturando) procesarCaptura(db);
  }
  else if(estado !== 'grito' && estado !== 'admin'){
    // nada que dibujar: ahorramos trabajo
  }
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

  const img = $('premioImg');
  if(cual === 'nada'){
    tit.textContent = '¡CASI!';
    tit.classList.add('flojo');
    img.style.display = 'none';
    $('premioNombre').textContent = '¡Grita más fuerte!';
    $('premioCta').textContent    = 'Vuelve a intentarlo';
    trombon();
  }else{
    const nom = cual === 'alto' ? cfg.nomAlto : cual === 'medio' ? cfg.nomMedio : cfg.nomBajo;
    tit.textContent = '¡GANASTE!';
    tit.classList.remove('flojo');
    img.style.display = '';
    img.src = IMG_PREMIO[cual];
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
  const cols = ['#ffffff','#0a0a0a','#edebd6','#ffffff','#5cc0f0','#edebd6'];
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
  $('panelVer').textContent = APP_VERSION;
  ['pisoDb','maxDb','minBajo','minMedio','minAlto','stockAlto','altoMin','altoMax']
    .forEach(k => { const e = $('v-' + k); if(e) e.textContent = cfg[k]; });
  $('v-msGrito').textContent = (cfg.msGrito / 1000).toFixed(1);

  $('txtBajo').value  = cfg.nomBajo;
  $('txtMedio').value = cfg.nomMedio;
  $('txtAlto').value  = cfg.nomAlto;
  $('lbl1').textContent = cfg.nomBajo;
  $('lbl2').textContent = cfg.nomMedio;
  $('lbl3').textContent = cfg.nomAlto;

  /* Se muestra CUANTO FALTA, no el numero absoluto de intento: sorteo.target
     es acumulado desde la instalacion, asi que tras 80 partidas decia cosas
     como "se arma en el intento #103" y no habia forma de interpretarlo. */
  const faltan = Math.max(sorteo.target - sorteo.intentos, 0);
  $('estadoSorteo').innerHTML =
    sorteo.stock <= 0
      ? `Sin stock de <b>${escapar(cfg.nomAlto)}</b>: ya no puede salir. ` +
        `Usa «Reiniciar sorteo» para reponerlo.`
      : `Stock: <b>${sorteo.stock}</b> &middot; llevas <b>${sorteo.intentos}</b> gritos jugados<br>` +
        (sorteo.armado
          ? `<b>ARMADO</b> &rarr; lo gana el próximo grito que llegue a ${cfg.minAlto}.`
          : `Se arma dentro de <b>${faltan}</b> ${faltan === 1 ? 'grito' : 'gritos'} más.`);

  $('stats').innerHTML = `
    <div class="stat"><div class="n">${stats.jugadas}</div><div class="t">jugadas</div></div>
    <div class="stat"><div class="n">${stats.sinPremio}</div><div class="t">sin premio</div></div>
    <div class="stat"><div class="n">${stats.bajo}</div><div class="t">${cfg.nomBajo}</div></div>
    <div class="stat"><div class="n">${stats.medio}</div><div class="t">${cfg.nomMedio}</div></div>
    <div class="stat"><div class="n">${stats.alto}</div><div class="t">${cfg.nomAlto}</div></div>`;
}

/* Diagnostico en vivo del microfono. Deliberadamente muestra los datos
   CRUDOS: si un mic no da nivel, esto dice por que sin tener que suponer. */
function pintarDiag(){
  const pista = streamActual ? streamActual.getAudioTracks()[0] : null;
  if(pista){
    diag.mudo = pista.muted;
    diag.estadoPista = pista.readyState;
  }
  const desajuste = diag.trackSR && diag.ctxSR && diag.trackSR !== diag.ctxSR;
  const fila = (k, v, cls) => `<div class="k">${k}</div><div class="v ${cls || ''}">${v}</div>`;
  $('diag').innerHTML =
    fila('micrófono', escapar(diag.trackLabel || '—')) +
    fila('frecuencia mic', diag.trackSR ? diag.trackSR + ' Hz' : '—', desajuste ? 'mal' : 'bien') +
    fila('frecuencia audio', diag.ctxSR ? diag.ctxSR + ' Hz' : '—', desajuste ? 'mal' : 'bien') +
    fila('canales', diag.canales || '—') +
    fila('silenciado', diag.mudo === null ? '—' : (diag.mudo ? 'SÍ' : 'no'), diag.mudo ? 'mal' : 'bien') +
    fila('estado pista', diag.estadoPista, diag.estadoPista === 'live' ? 'bien' : 'mal') +
    fila('muestras inválidas', diag.noFinitos, diag.noFinitos ? 'mal' : 'bien') +
    fila('RMS crudo', diag.rms.toFixed(6), diag.rms > 0 ? 'bien' : 'mal') +
    fila('conectó al intento', diag.intento);
}

function abrirPanel(){
  estado = 'admin';
  document.body.classList.add('panel-abierto');
  mostrar('p-admin');
  aplicarMarca();
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

    /* Estos tocan el sorteo YA EN CURSO. Si no se aplican aqui, cambiarlos
       en el panel no hace nada hasta el proximo "Reiniciar sorteo", y el
       recuadro de estado sigue mostrando los valores viejos. */
    if(k === 'stockAlto'){ sorteo.stock = cfg.stockAlto; guardarSorteo(); }
    if(k === 'altoMin' || k === 'altoMax'){
      if(cfg.altoMax < cfg.altoMin) cfg.altoMax = cfg.altoMin;   // rango invertido
      nuevoTarget();                                             // vuelve a sortear
    }

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
enlazarTexto('txtBajo','nomBajo');
enlazarTexto('txtMedio','nomMedio');
enlazarTexto('txtAlto','nomAlto');

$('btnFijarHabla').addEventListener('click', () => iniciarCaptura('piso'));
$('btnFijarGrito').addEventListener('click', () => iniciarCaptura('grito'));
$('btnMedirPico').addEventListener('click', () => iniciarCaptura('pico'));
$('btnLimpiarLog').addEventListener('click', () => { logPicos = []; pintarLog(); });

/* Reconectar: rehace toda la cadena de audio desde cero. Sirve cuando se
   enchufa el mic con la app ya abierta (Android le asigna otro id y el
   guardado queda apuntando a un dispositivo que ya no existe). */
$('btnReconectar').addEventListener('click', async () => {
  try{
    if(streamActual) streamActual.getTracks().forEach(t => t.stop());
    if(audioCtx){ try{ await audioCtx.close(); }catch(e){} audioCtx = null; }
    audioListo = false;
    cfg.micId = '';            // olvidar el mic guardado: se toma el del sistema
    guardarCfg();
    await iniciarAudio(undefined);
    pintarPanel(); pintarDiag();
    toast('Micrófono reconectado');
  }catch(err){
    toast('No se pudo reconectar: ' + (err && err.name ? err.name : err));
  }
});

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
  const mic = cfg.micId, marca = cfg.marca;   // no se pierde el mic ni la marca elegida
  cfg = { ...CFG_DEF, micId: mic, marca };
  guardarCfg(); pintarPanel(); pintarTiraPremios(); toast('Valores restaurados');
});

const elegirMarca = (m) => {
  cfg.marca = m; guardarCfg(); aplicarMarca();
  toast(m === 'proauto' ? 'Marca: Proauto' : 'Marca: Mirasol');
};
$('btnMarcaMirasol').addEventListener('click', () => elegirMarca('mirasol'));
$('btnMarcaProauto').addEventListener('click', () => elegirMarca('proauto'));
$('btnCerrarPanel').addEventListener('click', () => {
  pintarTiraPremios();
  irA(audioListo ? 'reposo' : 'permiso');
});

// boton de ajustes: un solo toque en la esquina superior derecha
$('btnTuerca').addEventListener('click', (e) => { e.stopPropagation(); abrirPanel(); });

// evita el zoom por doble toque
document.addEventListener('dblclick', e => e.preventDefault(), { passive:false });

aplicarMarca();

/* ---------------- Service worker (offline) ---------------- */
if('serviceWorker' in navigator){
  addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
