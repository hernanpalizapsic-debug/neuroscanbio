import { bio, questions } from './state.js';

export const log = (m) =>
  (document.getElementById('log').innerText = m.toUpperCase().replace(/ /g, '_'));

export const speak = (t) => {
  if (!window.speechSynthesis) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(t);
  u.lang = 'es-ES';
  u.rate = 1.05;
  speechSynthesis.speak(u);
};

const VIEWS = ['view-start', 'view-quiz', 'view-hrv', 'view-face', 'view-loading', 'view-report', 'view-error'];
export const show = (id) =>
  VIEWS.forEach((v) => document.getElementById(v).classList.toggle('hidden', v !== id));

/**
 * @param {{ title: string, message: string, detail?: string, actions?: Array<{label:string, onClick:()=>void, variant?:'primary'|'secondary'}> }} opts
 */
export function renderError({ title, message, detail, actions }) {
  show('view-error');
  log('error');
  document.getElementById('error-title').innerText = title || 'Ups, algo falló';
  document.getElementById('error-msg').innerText = message || '';
  document.getElementById('error-detail').innerText = detail || '';
  const container = document.getElementById('error-actions');
  container.innerHTML = '';
  (actions || []).forEach(({ label, onClick, variant }) => {
    const btn = document.createElement('button');
    btn.className =
      variant === 'primary'
        ? 'w-full py-4 bg-cyan-500 text-black font-black rounded-full uppercase text-xs tracking-widest active:scale-95 transition-all'
        : 'w-full py-4 border-2 border-cyan-500 text-cyan-400 font-bold rounded-full uppercase text-xs tracking-widest active:scale-95 transition-all';
    btn.innerText = label;
    btn.onclick = onClick;
    container.appendChild(btn);
  });
}

export const setInstr = (a, b) => {
  document.getElementById('face-instr').innerText = a;
  document.getElementById('face-sub').innerText = b || '';
};

export const faceTimerEl = () => document.getElementById('face-timer');

let qi = 0;
export function renderQuiz(onDone) {
  const s = questions[qi];
  document.getElementById('quiz-title').innerText = `Baseline ${qi + 1}/3`;
  document.getElementById('quiz-q').innerText = s.q;
  document.getElementById('quiz-prog').style.width = `${((qi + 1) / 3) * 100}%`;
  const c = document.getElementById('quiz-opts');
  c.innerHTML = '';
  s.opts.forEach((o) => {
    const b = document.createElement('button');
    b.className =
      'py-4 bg-white/5 border border-white/10 rounded-2xl text-xs uppercase font-bold active:scale-95 transition-all hover:bg-cyan-500 hover:text-black';
    b.innerText = o;
    b.onclick = () => {
      bio.quiz[s.id] = o;
      if (qi < 2) {
        qi++;
        renderQuiz(onDone);
      } else {
        qi = 0;
        onDone();
      }
    };
    c.appendChild(b);
  });
}

// ----- Lenguaje claro por tarjeta (sin términos clínicos al usuario) -----

function phraseHRV(M) {
  if (!M.hrv.ok) {
    const d = M.hrv.diag || {};
    return {
      icon: '❤️',
      title: 'Pulso',
      text: `No pudimos medir tu pulso con suficiente claridad esta vez (se detectaron ${M.hrv.beatsDetected || 0} latidos posibles). Probá apoyar el dedo con más firmeza, cubriendo bien la cámara y el flash, sin moverlo.`,
      tip: `Diagnóstico: flash ${d.torch || 'desconocido'}, brillo promedio ${d.avgR ?? '--'}, amplitud de señal ${d.ampPct ?? '--'}%.`,
    };
  }
  let text = `Tu corazón late en promedio ${M.hrv.bpm} veces por minuto. `;
  if (M.hrv.confidence === 'Alta') {
    if (M.hrv.rmssd > 50)
      text += 'La variación entre tus latidos es alta — un patrón típicamente asociado a un estado más relajado y con buena capacidad de recuperación.';
    else if (M.hrv.rmssd < 20)
      text += 'La variación entre tus latidos es baja — un patrón típicamente asociado a un estado de mayor activación o alerta.';
    else
      text += 'La variación entre tus latidos está en un rango intermedio, compatible con un estado equilibrado.';
  } else {
    text += 'La medición tiene confianza media: sirve como referencia, pero conviene repetirla para confirmar la tendencia.';
  }
  return { icon: '❤️', title: 'Pulso y ritmo cardíaco', text, tip: `Confianza de la medición: ${M.hrv.confidence}.` };
}

function phraseBlink(M) {
  let text;
  if (M.blinkRate < 8)
    text = `Parpadeaste poco durante la prueba (${M.blinkRate}/min). Esto puede indicar concentración intensa o fatiga ocular acumulada.`;
  else if (M.blinkRate > 25)
    text = `Parpadeaste con frecuencia alta (${M.blinkRate}/min), lo cual a veces se asocia a cansancio visual o irritación.`;
  else
    text = `Tu frecuencia de parpadeo (${M.blinkRate}/min) está en un rango típico de alerta relajada.`;
  return { icon: '👁️', title: 'Parpadeo', text, tip: `Duración media del parpadeo: ${M.avgBlinkMs} ms · EAR basal: ${M.baselineEAR}.` };
}

function phraseSaccade(M) {
  let text;
  if (M.saccadeTrackError < 5)
    text = 'Seguiste el punto en pantalla con buena precisión — tu coordinación visual estuvo fina durante la prueba.';
  else if (M.saccadeTrackError < 12)
    text = 'Tu seguimiento visual fue aceptable, con cierta dispersión — normal si hubo distracción momentánea.';
  else
    text = 'Hubo bastante dispersión al seguir el punto, lo que puede reflejar fatiga visual o dificultad para mantener el foco en este momento.';
  return { icon: '🎯', title: 'Seguimiento visual', text, tip: `Error de seguimiento: ${M.saccadeTrackError} (escala relativa, menor = mejor).` };
}

function phrasePLR(M) {
  if (!M.plr.ok)
    return {
      icon: '💡',
      title: 'Reacción pupilar a la luz',
      text: 'No pudimos medir la reacción de tu pupila al destello con suficiente confianza esta vez (depende mucho del color de ojos y la luz ambiente). No es un problema, simplemente no se reporta un dato sin respaldo.',
      tip: 'Sin datos suficientes (bajo contraste o resolución).',
    };
  const text = `Tu pupila se contrajo un ${M.plr.constriction}% al recibir el destello de luz, en ${M.plr.latency} milisegundos. Esta reacción refleja, hasta cierto punto, la capacidad de respuesta automática de tu sistema nervioso ante un estímulo.`;
  return { icon: '💡', title: 'Reacción pupilar a la luz', text, tip: `Constricción ${M.plr.constriction}% · latencia ${M.plr.latency} ms.` };
}

function phraseHead(M) {
  let text;
  if (M.headStability < 1.5)
    text = 'Mantuviste la cabeza muy estable durante la prueba, señal de buen control postural en este momento.';
  else if (M.headStability < 4)
    text = 'Tu estabilidad postural fue normal, con pequeños movimientos esperables.';
  else
    text = 'Hubo bastante movimiento de cabeza durante la prueba, lo que a veces acompaña a estados de mayor inquietud o activación.';
  return { icon: '🧍', title: 'Estabilidad postural', text, tip: `Índice de jitter cefálico: ${M.headStability}.` };
}

export function renderReport(M) {
  show('view-report');
  log('done');
  speak('Tu informe está listo.');
  const blocks = [phraseHRV(M), phraseBlink(M), phraseSaccade(M), phrasePLR(M), phraseHead(M)];
  const xvalLine = M.crossValidation
    ? `<p class="text-[10px] text-slate-500 mono mt-2">Validación cruzada pulso dedo↔rostro: concordancia ${M.crossValidation.agreement} (Δ${M.crossValidation.bpmDiff} BPM).</p>`
    : '';

  const cards = blocks
    .map(
      (b) => `
    <div class="glass p-5 rounded-2xl">
      <h3 class="text-sm font-bold text-white mb-2 flex items-center gap-2"><span>${b.icon}</span> ${b.title}</h3>
      <p class="text-[13px] text-slate-300 leading-relaxed">${b.text}</p>
    </div>
  `
    )
    .join('');

  document.getElementById('report-content').innerHTML = `
    <div class="p-5 rounded-2xl bg-cyan-500/10 border border-cyan-500/20">
      <p class="text-[11px] text-cyan-100 leading-relaxed">Este informe describe señales objetivas medidas durante la sesión. No reemplaza una evaluación médica y está pensado para ver tu evolución a lo largo del programa, no como un valor absoluto aislado.</p>
    </div>
    ${cards}
    ${xvalLine}
    <details class="glass p-5 rounded-2xl">
      <summary class="text-[10px] font-bold text-cyan-400 uppercase tracking-widest">Ver detalle técnico</summary>
      <pre class="text-[8px] text-slate-400 mono overflow-x-auto whitespace-pre-wrap">${JSON.stringify(M, null, 2)}</pre>
    </details>
  `;
}
