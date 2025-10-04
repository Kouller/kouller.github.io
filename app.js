'use strict';

/** ========= CONFIG ========= */
const DEFAULT_DURATION_MS = 2 * 60 * 60 * 1000; // 2h

/** ========= HELPERS ========= */
const $ = (id)=>document.getElementById(id);
const escapeHtml = (s)=> String(s).replace(/[&<>\"']/g, c=>({
  "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"
}[c]));
const pad = (n)=> String(n).padStart(2,'0');
const shuffle = (arr)=>{ const a=[...arr]; for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]];} return a; };
const pickN = (arr,n)=> shuffle(arr).slice(0,n);
const flattenBank = (x)=>{ const out=[]; (function w(y){ Array.isArray(y) ? y.forEach(w) : out.push(y)})(x); return out; };

// CSV helpers
function csvEscape(v){ const s = String(v ?? ''); return `"${s.replace(/"/g,'""')}"`; }
function buildCsvReport(items, answers){
  const header = [
    'Nro','Pregunta','Tipo','Opciones (label:text)',
    'Correctas (letras)','Marcadas (letras)','Estado',
    'Respuesta correcta (expandida)','Justificacion'
  ];
  const rows = [header];
  for(let i=0;i<items.length;i++){
    const it = items[i]||{};
    const qn = it.numero || (i+1);
    const tipo = (Array.isArray(it.answer_letters) && it.answer_letters.length>1) ? 'Multiple' : 'Unica';
    const opciones = (it.options||[]).map(o=>`${(o.label||'').toUpperCase()}: ${o.text||''}`).join(' | ');
    const correctas = (it.answer_letters||[]).slice().sort();
    const marcadas = (answers[i]||[]).slice().sort();
    const estado = JSON.stringify(correctas)===JSON.stringify(marcadas) ? 'Correcta' : 'Incorrecta';
    const correctasTexto = (it.options||[]).filter(o=>correctas.includes(o.label)).map(o=>`${o.label.toUpperCase()}. ${o.text||''}`).join(' | ');
    const just = it.justificacion ? String(it.justificacion) : '';
    rows.push([ qn, it.question||'', tipo, opciones, correctas.join(','), marcadas.join(','), estado, correctasTexto, just ].map(csvEscape));
  }
  return rows.map(r=>r.join(',')).join('\r\n');
}

/** ========= STATE ========= */
let EXAM = {
  items: [], i: 0, answers: [], deadline: 0, timerId: null, reportBlob: null,
  recording: { rec:null, chunks:[], stream:null }
};

/** ========= APP ========= */
document.addEventListener('DOMContentLoaded', () => {
  const welcome = $('welcome'), exam = $('exam'), results = $('results');
  const qTitle=$('qTitle'), qText=$('qText'), options=$('options'), qIndex=$('qIndex'), qTotal=$('qTotal'), modePill=$('modePill');
  const btnStart=$('btnStart'), btnNext=$('btnNext'), btnFinish=$('btnFinish'), btnRestart=$('btnRestart');
  const timerEl=$('timer'), bar=$('bar'), scoreEl=$('score'), passStatus=$('passStatus');
  const btnCam=$('btnCam'), cam=$('cam'), btnRecord=$('btnRecord'), btnExport=$('btnExport');

  const BANK = (typeof TODAS !== 'undefined') ? TODAS : (typeof window!=='undefined' ? window.TODAS : undefined);

  // Cámara
  const isSecure = location.protocol==='https:' || location.hostname==='localhost' || location.hostname==='127.0.0.1';
  btnCam && (btnCam.disabled = !isSecure);
  btnRecord && (btnRecord.disabled = !isSecure);

  btnCam?.addEventListener('click', async ()=>{
    try{
      const stream = await navigator.mediaDevices.getUserMedia({video:true,audio:false});
      cam.srcObject=stream; cam.style.display='block'; btnCam.disabled=true; btnCam.textContent='Cámara activa';
    }catch(e){ alert('No se pudo activar la cámara: '+e.message); }
  });

  btnRecord?.addEventListener('click', async ()=>{
    if(EXAM.recording.rec){
      try{ EXAM.recording.rec.stop(); btnRecord.textContent='Procesando…'; btnRecord.disabled=true; }catch(e){}
      return;
    }
    try{
      const display = await navigator.mediaDevices.getDisplayMedia({video:true,audio:true});
      EXAM.recording.stream = display;
      EXAM.recording.chunks = [];
      const rec = new MediaRecorder(display,{mimeType:'video/webm; codecs=vp9,opus'});
      rec.ondataavailable = e=>{ if(e.data && e.data.size>0) EXAM.recording.chunks.push(e.data); };
      rec.onstop = ()=>{ btnRecord.textContent='Grabación lista'; btnRecord.disabled=true; };
      rec.start();
      EXAM.recording.rec = rec;
      btnRecord.textContent='Detener grabación';
    }catch(e){ alert('No se pudo iniciar la grabación: '+e.message); }
  });

  // Empezar
  btnStart.addEventListener('click', ()=>{
    const flat = flattenBank(BANK || []);
    if(!flat.length){ alert('No hay banco de preguntas cargado.'); return; }

    EXAM.items = pickN(flat, 42);
    EXAM.i = 0;
    EXAM.answers = Array(EXAM.items.length).fill(null);
    qTotal.textContent = String(EXAM.items.length);

    const qs = new URLSearchParams(location.search);
    const overrideMin = parseInt(qs.get('mins'));
    const duration = Number.isFinite(overrideMin) ? overrideMin*60*1000 : DEFAULT_DURATION_MS;
    EXAM.deadline = Date.now()+duration;

    startTimer();
    welcome.style.display='none';
    results.style.display='none';
    exam.style.display='block';
    renderQuestion();
  });

  btnNext.addEventListener('click', (e)=>{
    e.preventDefault();
    const selected = [...options.querySelectorAll('input:checked')].map(x=>x.value);
    if(selected.length===0){ alert('Selecciona al menos una opción.'); return; }
    EXAM.answers[EXAM.i] = selected.sort();
    if(EXAM.i === EXAM.items.length-1){ finalize('manual'); }
    else { EXAM.i++; renderQuestion(); }
  });

  btnFinish.addEventListener('click', (e)=>{
    e.preventDefault();
    if(confirm('¿Deseas finalizar el examen? No podrás volver atrás.')) finalize('manual');
  });

  btnRestart?.addEventListener('click', ()=> location.reload());

  btnExport?.addEventListener('click', ()=>{
    if(!EXAM.reportBlob){ alert('Aún no hay reporte. Finaliza un examen para generar el CSV.'); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(EXAM.reportBlob);
    a.download = `reporte-examen-${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.csv`;
    a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href), 10000);
  });

  // Export PDF (print-to-PDF)
  document.getElementById('btnExportPDF')?.addEventListener('click', ()=>{
    if(!EXAM.items?.length){ alert('Aún no hay reporte. Finaliza un examen para generar el PDF.'); return; }
    const scoreText = document.getElementById('score')?.textContent || '';
    const passText = document.getElementById('passStatus')?.textContent || '';
    exportPDF(EXAM.items, EXAM.answers, scoreText, passText);
  });

  function renderQuestion(){
    const item = EXAM.items[EXAM.i];
    qIndex.textContent = String(EXAM.i+1);
    qTitle.textContent = `Pregunta ${EXAM.i+1}`;
    qText.textContent = item.question;
    const multi = (item.answer_letters||[]).length>1;
    modePill.textContent = multi ? 'Selección múltiple' : 'Única respuesta';
    const opts = shuffle((item.options||[]).map(o=>({label:o.label, text:o.text})));
    options.innerHTML = '';
    opts.forEach(o=>{
      const type = multi ? 'checkbox' : 'radio';
      options.insertAdjacentHTML('beforeend',
        `<label class="opt"><input type="${type}" name="q" value="${o.label}"><div><strong>${o.label.toUpperCase()}.</strong> ${escapeHtml(o.text||'')}</div></label>`);
    });
    btnNext.textContent = (EXAM.i===EXAM.items.length-1) ? 'Finalizar →' : 'Continuar →';
  }

  function startTimer(){
    const totalMs = Math.max(EXAM.deadline - Date.now(), 0);
    tick();
    EXAM.timerId = setInterval(tick, 1000);
    function tick(){
      const left = Math.max(EXAM.deadline - Date.now(), 0);
      const s = Math.floor(left/1000)%60, m=Math.floor(left/(60*1000))%60, h=Math.floor(left/(60*60*1000));
      timerEl.textContent = `${pad(h)}:${pad(m)}:${pad(s)}`;
      bar.style.width = `${Math.max(0, Math.min(1, 1 - (left/(totalMs||1))))*100}%`;
      timerEl.style.background = left < 5*60*1000 ? 'rgba(239,68,68,.2)' : '';
      if(left<=0){ finalize('time'); }
    }
  }

  function finalize(reason){
    clearInterval(EXAM.timerId);

    // detener grabación si activa
    if(EXAM.recording && EXAM.recording.rec && EXAM.recording.rec.state!=='inactive'){
      try{ EXAM.recording.rec.stop(); }catch(e){}
    }

    // apagar y ocultar cámara
    try{
      if(cam && cam.srcObject){ cam.srcObject.getTracks().forEach(t=>t.stop()); cam.srcObject=null; }
      cam.style.display='none';
      if(EXAM.recording && EXAM.recording.stream){
        try{ EXAM.recording.stream.getTracks().forEach(t=>t.stop()); }catch(_){}
      }
    }catch(_){}

    const total = EXAM.items.length;
    let correct = 0;
    for(let i=0;i<total;i++){
      const need = (EXAM.items[i].answer_letters||[]).slice().sort();
      const got  = (EXAM.answers[i]||[]).slice().sort();
      if(JSON.stringify(need)===JSON.stringify(got)) correct++;
    }
    const nota = (correct/total)*20;
    scoreEl.textContent = `${nota.toFixed(2)} / 20 (aciertos: ${correct}/${total})`;

    const required = Math.ceil(0.7 * total);
    const pass = correct >= required;
    if(passStatus){
      passStatus.textContent = pass
        ? `Aprobado ✅ ¡Felicitaciones! (${correct}/${total}, requiere ${required})`
        : `No aprobado ❌ (${correct}/${total}, requiere ${required})`;
      passStatus.style.background = pass ? 'rgba(34,197,94,.18)' : 'rgba(239,68,68,.18)';
      passStatus.style.borderColor = pass ? 'rgba(34,197,94,.45)' : 'rgba(239,68,68,.45)';
    }

    // Construir CSV
    try{
      const csv = buildSimpleCsv(EXAM.items, EXAM.answers);
      EXAM.reportBlob = new Blob([csv], { type:'text/csv;charset=utf-8' });
    }catch(e){
      console.error('CSV build error', e);
      EXAM.reportBlob = null;
    }

    exam.style.display='none';
    results.style.display='block';
  }
});


function mapLettersToTexts(item, letters){
  const dict = new Map((item.options||[]).map(o=>[String(o.label).toLowerCase(), o.text||'']));
  return (letters||[]).map(l => dict.get(String(l).toLowerCase()) || '').filter(Boolean);
}

function buildFriendlyRows(items, answers){
  const rows = [];
  for(let i=0;i<items.length;i++){
    const it = items[i] || {};
    const correctLetters = (it.answer_letters || []).slice().sort();
    const userLetters = (answers[i] || []).slice().sort();
    const correctTexts = mapLettersToTexts(it, correctLetters);
    const userTexts = mapLettersToTexts(it, userLetters);
    const status = JSON.stringify(correctLetters) === JSON.stringify(userLetters) ? 'Correcta' : 'Incorrecta';
    rows.push({
      num: it.numero || (i+1),
      pregunta: it.question || '',
      usuario: userTexts.join(' | '),
      correcta: correctTexts.join(' | '),
      estado: status
    });
  }
  return rows;
}

// Simplified CSV (persona normal): N°, Pregunta, Respuesta del usuario, Respuesta correcta, Estado
function buildSimpleCsv(items, answers){
  const rows = buildFriendlyRows(items, answers);
  const header = ['N°','Pregunta','Respuesta del usuario','Respuesta correcta','Estado'];
  const lines = [header.map(csvEscape).join(',')];
  for(const r of rows){
    lines.push([r.num, r.pregunta, r.usuario, r.correcta, r.estado].map(csvEscape).join(','));
  }
  return lines.join('\r\n');
}


    function exportPDF(items, answers, scoreText, passText){
      const rows = buildFriendlyRows(items, answers);
      const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>Reporte de examen</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Arial; margin:24px; color:#111}
  h1{margin:0 0 4px 0; font-size:20px}
  .muted{color:#555; margin:0 0 12px 0}
  .badge{display:inline-block; padding:4px 8px; border-radius:8px; font-size:12px; border:1px solid #ddd}
  table{width:100%; border-collapse:collapse; margin-top:12px; font-size:12px}
  th,td{border:1px solid #ddd; padding:8px; vertical-align:top}
  th{background:#f5f5f5; text-align:left}
  .right{float:right}
</style>
</head>
<body>
  <h1>Reporte de examen</h1>
  <div class="muted">${new Date().toLocaleString()}</div>
  <div class="badge">${scoreText}</div>
  <div class="badge" style="margin-left:8px">${passText}</div>
  <table>
    <thead>
      <tr><th style="width:40px">N°</th><th>Pregunta</th><th style="width:28%">Respuesta del usuario</th><th style="width:28%">Respuesta correcta</th><th style="width:100px">Estado</th></tr>
    </thead>
    <tbody>
      ${rows.map(r=>`<tr>
        <td>${r.num}</td>
        <td>${r.pregunta.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</td>
        <td>${(r.usuario||'').replace(/&/g,'&amp;').replace(/</g,'&lt;')}</td>
        <td>${(r.correcta||'').replace(/&/g,'&amp;').replace(/</g,'&lt;')}</td>
        <td>${r.estado}</td>
      </tr>`).join('')}
    </tbody>
  </table>
  <script>window.onload=()=>{setTimeout(()=>window.print(),300)}</script>
</body>
</html>`;

      const w = window.open('', '_blank');
      if(!w){ alert('Permite ventanas emergentes para descargar el PDF.'); return; }
      w.document.open();
      w.document.write(html);
      w.document.close();
    }
