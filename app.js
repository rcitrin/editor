/* TechBoston APCSP Interpreter (core features, DOM-ready) */
window.addEventListener("DOMContentLoaded", () => {
  const $ = s => document.querySelector(s);

  const logEl = $('#console');
  const statusEl = $('#status');
  const promptWrap = $('#promptWrap');
  const promptInput = $('#promptInput');
  const runBtn = $('#runBtn');
  const stopBtn = $('#stopBtn');
  const editor = $('#editor');
  const samplesSel = $('#samples');

  let halted = false;
  let inputResolve = null, inputReject = null;

  function clearConsole(){ logEl.innerHTML = ''; }
  function out(text, cls='log'){
    const div = document.createElement('div');
    div.className = 'line ' + cls;
    div.textContent = String(text);
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
  }
  const sys = m => out(m,'sys');
  const err = m => out(m,'err');
  const setStatus = t => statusEl.textContent = t;

  function showPrompt(message){
    promptWrap.classList.add('show');
    promptInput.value = '';
    promptInput.placeholder = message || 'Input';
    promptInput.focus();
    return new Promise((resolve, reject)=>{
      inputResolve = resolve; inputReject = reject;
    });
  }
  function hidePrompt(){ promptWrap.classList.remove('show'); }
  $('#promptOk').onclick = () => { if (inputResolve){ inputResolve(promptInput.value); hidePrompt(); } };
  $('#promptCancel').onclick = () => { if (inputReject){ inputReject(new Error('Input canceled')); hidePrompt(); } };
  promptInput.addEventListener('keydown', (e)=>{
    if (e.key === 'Enter'){ e.preventDefault(); $('#promptOk').click(); }
    if (e.key === 'Escape'){ e.preventDefault(); $('#promptCancel').click(); }
  });

  // ---------- Parser helpers ----------
  function preprocess(src){
    return src.split(/\r?\n/).map((raw, idx)=>{
      let s = raw.replace(/\t/g,'    ');
      s = s.replace(/#.*$/, '').replace(/\/\/.*$/, '');
      return { idx, raw, s: s.trim() };
    });
  }
  function buildBlocks(lines){
    const stack = [];
    const blocks = {};
    for (let i=0;i<lines.length;i++){
      const t = lines[i].s;
      if (!t) continue;
      if (/^IF\b/i.test(t)) { stack.push({type:'IF', i}); }
      else if (/^ELSE\b/i.test(t)) {
        const top = stack[stack.length-1];
        if (!top || top.type!=='IF') throw new Error(`ELSE without IF at line ${i+1}`);
        blocks[top.i] = blocks[top.i] || {}; blocks[top.i].else = i;
      }
      else if (/^END\s*IF\b/i.test(t)) {
        const top = stack.pop();
        if (!top || top.type!=='IF') throw new Error(`END IF without IF at line ${i+1}`);
        blocks[top.i] = blocks[top.i] || {}; blocks[top.i].end = i;
      }
      else if (/^REPEAT\s+\d+\s+TIMES\b/i.test(t)) {
        stack.push({type:'REPEAT_TIMES', i});
      }
      else if (/^REPEAT\s+UNTIL\b/i.test(t)) {
        stack.push({type:'REPEAT_UNTIL', i});
      }
      else if (/^END\s*REPEAT\b/i.test(t)) {
        const top = stack.pop();
        if (!top || (top.type!=='REPEAT_TIMES' && top.type!=='REPEAT_UNTIL'))
          throw new Error(`END REPEAT without REPEAT at line ${i+1}`);
        blocks[top.i] = blocks[top.i] || {}; blocks[top.i].end = i;
      }
    }
    if (stack.length) throw new Error('Unclosed block starting at line ' + (stack[stack.length-1].i+1));
    return blocks;
  }

  // ---------- Expression evaluator ----------
  function makeEvaluator(env){
    const allowed = /^[\w\s+\-*/%().,<>!=“”"'\[\]≤≥≠]+$/u;
    function sanitize(s){
      const e = s
        .replace(/≤/g,'<=')
        .replace(/≥/g,'>=')
        .replace(/≠/g,'!=')
        .replace(/\bAND\b/gi,'&&')
        .replace(/\bOR\b/gi,'||')
        .replace(/\bNOT\b/gi,'!')
        .replace(/[“”]/g,'"');
      if (!allowed.test(e)) throw new Error('Expression contains unsupported characters');
      return e;
    }
    return async function evalExpr(expr){
      const e = sanitize(expr);
      // INPUT available in expressions
      const INPUT = async function(promptMsg){
        sys('INPUT' + (promptMsg?` — ${promptMsg}`:''));
        return await showPrompt(promptMsg||'Input');
      };
      const fn = new Function('env','Math','INPUT', `with(env){ return ( ${e} ); }`);
      return await fn(env, Math, INPUT);
    };
  }

  function findMatching(lines, endIdx, startRegex){
    for (let k=endIdx-1; k>=0; k--){ if (startRegex.test(lines[k].s)) return k; }
    return -1;
  }

  function tick(){ return new Promise(r=>setTimeout(r,0)); }

  // ---------- Runner ----------
  async function run(src){
    halted = false; clearConsole(); setStatus('Parsing…');
    const lines = preprocess(src);
    let blocks; try { blocks = buildBlocks(lines); } catch(e){ err(e.message); return; }
    const env = Object.create(null);
    const evalExpr = makeEvaluator(env);
    let i = 0; const maxSteps = 20000; let steps = 0;

    setStatus('Running…');
    while (i < lines.length){
      if (halted) { setStatus('Stopped'); return; }
      if (++steps > maxSteps) { err('Program aborted: too many steps (infinite loop?)'); break; }
      const L = lines[i];
      const t = L.s; i++;
      if (!t) continue;

      try{
        if (/^DISPLAY\s*\(/i.test(t)){
          const m = t.match(/^DISPLAY\s*\((.*)\)\s*$/i);
          if (!m) throw new Error(`DISPLAY syntax error at line ${L.idx+1}`);
          const val = await evalExpr(m[1]);
          out(val);
        }
        else if (/^(SET\s+)?[A-Za-z_]\w*\s*(←|<-)\s*/.test(t)){
          const m = t.match(/^(?:SET\s+)?([A-Za-z_]\w*)\s*(?:←|<-)\s*(.*)$/i);
          const name = m[1]; const expr = m[2];
          env[name] = await evalExpr(expr);
        }
        else if (/^IF\b/i.test(t)){
          const cond = t.replace(/^IF\b/i,'').replace(/\bTHEN\b/i,'').trim();
          const ok = await evalExpr(cond);
          const meta = blocks[L.idx];
          if (!meta) throw new Error('IF without END IF at line ' + (L.idx+1));
          if (!ok){
            if (typeof meta.else==='number') i = meta.else + 1;
            else i = meta.end + 1;
          }
        }
        else if (/^ELSE\b/i.test(t)){
          // jump to END IF
          const startIf = findMatching(lines, L.idx, /^IF\b/i);
          const meta = blocks[startIf];
          i = meta.end + 1;
        }
        else if (/^END\s*IF\b/i.test(t)){
          // no-op
        }
        else if (/^REPEAT\s+\d+\s+TIMES\b/i.test(t)){
          const m = t.match(/^REPEAT\s+(\d+)\s+TIMES\b/i);
          const count = parseInt(m[1],10);
          const meta = blocks[L.idx];
          if (!meta || typeof meta.end!== 'number') throw new Error('REPEAT TIMES without END REPEAT');
          const key = `_rep_${L.idx}`;
          if (env[key] == null) env[key] = {n:count, c:0};
          env[key].c++;
          if (env[key].c > env[key].n){ delete env[key]; i = meta.end + 1; }
        }
        else if (/^REPEAT\s+UNTIL\b/i.test(t)){
          const cond = t.replace(/^REPEAT\s+UNTIL\b/i,'').trim();
          const meta = blocks[L.idx];
          if (!meta || typeof meta.end!== 'number') throw new Error('REPEAT UNTIL without END REPEAT');
          env[`_until_${L.idx}`] = cond;
        }
        else if (/^END\s*REPEAT\b/i.test(t)){
          const startIdx = findMatching(lines, L.idx, /^REPEAT\b/i);
          const startLine = lines[startIdx];
          if (/^REPEAT\s+UNTIL\b/i.test(startLine.s)){
            const cond = env[`_until_${startIdx}`];
            const ok = await evalExpr(cond);
            if (!ok) i = startIdx + 1; else delete env[`_until_${startIdx}`];
          }
          // REPEAT n TIMES falls through; counter is handled at start
        }
        else if (/^INPUT\s*\(/i.test(t)){
          // permit bare INPUT("x") line
          await makeEvaluator(env)(t);
        }
        else {
          throw new Error(`Unknown statement at line ${L.idx+1}: ${t}`);
        }
      } catch(e){
        err(`Line ${L.idx+1}: ${e.message}`);
        setStatus('Crashed');
        return;
      }
      await tick();
    }
    setStatus('Finished');
  }

  // ---------- Wire UI ----------
  runBtn.onclick = () => run(editor.value);
  stopBtn.onclick = () => { halted = true; setStatus('Stopping…'); };
  document.addEventListener('keydown', (e)=>{
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter'){ e.preventDefault(); runBtn.click(); }
  });

  // ---------- Samples ----------
  const samples = {
    "Hello + INPUT demo":
`DISPLAY("What is your name?")
SET name ← INPUT("name")
DISPLAY("Hello, " + name)`,
    "Math & IF":
`SET a ← 5
SET b ← 12
SET s ← a + b
DISPLAY("sum = " + s)
IF s > 12
  DISPLAY("Big number")
ELSE
  DISPLAY("Small number")
END IF`,
    "REPEAT n TIMES":
`REPEAT 5 TIMES
  DISPLAY("loop")
END REPEAT`,
    "REPEAT UNTIL":
`SET x ← 0
REPEAT UNTIL x ≥ 3
  DISPLAY("x = " + x)
  SET x ← x + 1
END REPEAT`
  };
  // populate dropdown
  samplesSel.innerHTML = '<option value="">Load sample…</option>' +
    Object.keys(samples).map(k=>`<option value="${k}">${k}</option>`).join('');
  samplesSel.onchange = () => {
    const k = samplesSel.value;
    if (k && samples[k]) editor.value = samples[k];
    samplesSel.value = '';
  };

  // default program
  editor.value = samples["Hello + INPUT demo"];
  setStatus('Ready');
  sys('Ready. Paste AP-style pseudocode and press Run (or Ctrl/Cmd+Enter).');
});
