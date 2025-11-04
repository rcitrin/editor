<script>
// --- Mini Interpreter -----------------------------------------------
// Grammar (line-oriented):
//  - SET name ← expr         (← or <-)
//  - DISPLAY(expr)
//  - name ← expr             (assignment without SET also allowed)
//  - IF condition            -> END IF (optional ELSE)
//  - REPEAT n TIMES          -> END REPEAT
//  - REPEAT UNTIL condition  -> END REPEAT (post-check)
//  - INPUT() usable inside expressions, or INPUT("prompt")
//  - Comments start with # or //
//  - Strings in "double quotes"

(function(){
  const $ = sel => document.querySelector(sel);
  const logEl = $('#console');
  const statusEl = $('#status');
  const promptWrap = $('#promptWrap');
  const promptInput = $('#promptInput');
  const promptOk = $('#promptOk');
  const promptCancel = $('#promptCancel');

  let halted = false;
  let inputResolve = null, inputReject = null;

  function setStatus(txt){ statusEl.textContent = txt; }
  function clearConsole(){ logEl.innerHTML = ''; }
  function out(text, cls='log'){
    const div = document.createElement('div');
    div.className = 'line ' + cls; div.textContent = String(text);
    logEl.appendChild(div); logEl.scrollTop = logEl.scrollHeight;
  }
  function sys(text){ out(text, 'sys'); }
  function err(text){ out(text, 'err'); }

  function showPrompt(message){
    promptWrap.classList.add('show');
    promptInput.value = '';
    if (message) promptInput.placeholder = message;
    promptInput.focus();
    return new Promise((resolve, reject)=>{
      inputResolve = resolve; inputReject = reject;
    });
  }
  function hidePrompt(){
    promptWrap.classList.remove('show');
  }

  promptOk.addEventListener('click', ()=>{ if (inputResolve){ inputResolve(promptInput.value); hidePrompt(); }});
  promptCancel.addEventListener('click', ()=>{ if (inputReject){ inputReject(new Error('Input canceled')); hidePrompt(); }});
  promptInput.addEventListener('keydown', (e)=>{
    if (e.key === 'Enter'){ e.preventDefault(); promptOk.click(); }
    if (e.key === 'Escape'){ e.preventDefault(); promptCancel.click(); }
  });

  // Simple tokenizer: split into trimmed lines, remove comments
  function preprocess(src){
    const lines = src.split(/\r?\n/).map((raw, idx)=>{
      let s = raw.replace(/\t/g,'    ');
      s = s.replace(/#.*$/, '').replace(/\/\/.*$/, '');
      return { idx, raw, s: s.trim() };
    });
    return lines;
  }

  // Build a control-flow map for IF/ELSE/END IF and REPEAT blocks
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
      else if (/^REPEAT\b/i.test(t)) {
        if (/^REPEAT\s+\d+\s+TIMES\b/i.test(t)) {
          stack.push({type:'REPEAT_TIMES', i});
        } else if (/^REPEAT\s+UNTIL\b/i.test(t)) {
          stack.push({type:'REPEAT_UNTIL', i});
        }
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

  // Safe-ish evaluator: allow variables and basic Math; block keywords and dangerous tokens
  function makeEvaluator(env){
    const allowed = /^[\w\s+\-*/%().,<>!=\"'\[\]≤≥≠]+$/u; // crude gate
    function sanitize(s){
      if (!allowed.test(s)) throw new Error('Expression contains unsupported characters');
      // normalize APCSP operators to JS
      return s
        .replace(/≤/g,'<=')
        .replace(/≥/g,'>=')
        .replace(/≠/g,'!=')
        .replace(/\bAND\b/gi,'&&')
        .replace(/\bOR\b/gi,'||')
        .replace(/\bNOT\b/gi,'!');
    }
    return async function evalExpr(expr){
      const e = sanitize(expr);
      // Provide INPUT within expressions
      const INPUT = async function(promptMsg){
        sys('INPUT' + (promptMsg?` — ${promptMsg}`:''));
        return await showPrompt(promptMsg||'Input');
      };
      // with(env) gives variable lookup from env
      const fn = new Function('env','Math','INPUT', `with(env){ return ( ${e} ); }`);
      return await fn(env, Math, INPUT);
    };
  }

  async function run(src){
    halted = false; clearConsole(); setStatus('Parsing…');
    const lines = preprocess(src);
    let blocks; try { blocks = buildBlocks(lines); } catch(e){ err(e.message); return; }
    const env = Object.create(null);
    const evalExpr = makeEvaluator(env);
    let i = 0; const maxSteps = 20000; let steps = 0;

    function goto(n){ i = n; }

    setStatus('Running…');
    while (i < lines.length){
      if (halted) { setStatus('Stopped'); return; }
      if (++steps > maxSteps) { err('Program aborted: too many steps (infinite loop?)'); break; }
      const L = lines[i];
      const t = L.s; i++;
      if (!t) continue;

      try{
        // DISPLAY(x)
        if (/^DISPLAY\s*\(/i.test(t)){
          const m = t.match(/^DISPLAY\s*\((.*)\)\s*$/i);
          if (!m) throw new Error(`DISPLAY syntax error at line ${L.idx+1}`);
          const val = await evalExpr(m[1]);
          out(val);
        }
        // SET x ← expr  OR  x ← expr
        else if (/^(SET\s+)?[A-Za-z_]\w*\s*(←|<-)\s*/.test(t)){
          const m = t.match(/^(?:SET\s+)?([A-Za-z_]\w*)\s*(?:←|<-)\s*(.*)$/i);
          const name = m[1]; const expr = m[2];
          env[name] = await evalExpr(expr);
        }
        // IF cond
        else if (/^IF\b/i.test(t)){
          const cond = t.replace(/^IF\b/i,'').replace(/^\s*\(?/,'').replace(/\)?\s*$/,'').replace(/\s*THEN\s*$/i,'').trim();
          const ok = await evalExpr(cond);
          const meta = blocks[L.idx];
          if (ok){ /* run through */ }
          else {
            if (meta && typeof meta.else==='number') { goto(meta.else+1); }
            else if (meta && typeof meta.end==='number') { goto(meta.end+1); }
            else throw new Error('IF without END IF at line ' + (L.idx+1));
          }
        }
        else if (/^ELSE\b/i.test(t)){
          const meta = blocks[findMatchingIf(lines, L.idx)];
          if (!meta || typeof meta.end!=='number') throw new Error('ELSE without END IF at line ' + (L.idx+1));
          goto(meta.end+1);
        }
        else if (/^END\s*IF\b/i.test(t)){
          // no-op
        }
        // REPEAT n TIMES
        else if (/^REPEAT\s+\d+\s+TIMES\b/i.test(t)){
          const m = t.match(/^REPEAT\s+(\d+)\s+TIMES\b/i);
          const count = parseInt(m[1],10);
          const meta = blocks[L.idx];
          if (!meta || typeof meta.end!== 'number') throw new Error('REPEAT TIMES without END REPEAT');
          // create hidden counters
          const key = `_rep_${L.idx}`; const end = meta.end;
          if (env[key] == null) env[key] = {n:count, c:0};
          if (env[key].c >= env[key].n){ delete env[key]; goto(end+1); }
          else { env[key].c++; }
        }
        // REPEAT UNTIL condition  (post-check loop)
        else if (/^REPEAT\s+UNTIL\b/i.test(t)){
          const cond = t.replace(/^REPEAT\s+UNTIL\b/i,'').trim();
          const meta = blocks[L.idx];
          if (!meta || typeof meta.end!== 'number') throw new Error('REPEAT UNTIL without END REPEAT');
          // store the condition to check at END REPEAT
          env[`_until_${L.idx}`] = cond;
        }
        else if (/^END\s*REPEAT\b/i.test(t)){
          // find matching REPEAT ... by walking back
          const start = findMatchingRepeat(lines, L.idx);
          const startLine = lines[start];
          if (/^REPEAT\s+UNTIL\b/i.test(startLine.s)){
            const cond = env[`_until_${start}`];
            const ok = await evalExpr(cond);
            if (ok) { delete env[`_until_${start}`]; /* fall through */ }
            else { goto(start+1); }
          } else {
            // for TIMES, just fall through; counter already advanced
          }
        }
        else {
          // Bare expression? Allow function-style calls like INPUT("name")
          if (/^INPUT\s*\(/i.test(t)){
            // Discarded value unless assigned; still executes for side-effect prompt
            await makeEvaluator(env)(t);
          } else if (t) {
            throw new Error(`Unknown statement at line ${L.idx+1}: ${t}`);
          }
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

  function findMatchingIf(lines, elseIndex){
    for (let k=elseIndex-1; k>=0; k--){ if (/^IF\b/i.test(lines[k].s)) return k; }
    return -1;
  }
  function findMatchingRepeat(lines, endIdx){
    for (let k=endIdx-1; k>=0; k--){ if (/^REPEAT\b/i.test(lines[k].s)) return k; }
    return -1;
  }
  function tick(){ return new Promise(r=>setTimeout(r, 0)); }

  // Hook up UI
  $('#runBtn').addEventListener('click', ()=> run($('#editor').value));
  $('#stopBtn').addEventListener('click', ()=> { halted = true; setStatus('Stopping…'); });
  document.addEventListener('keydown', (e)=>{
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter'){ e.preventDefault(); $('#runBtn').click(); }
  });

  // Sample programs
  const samples = {
`Hello + INPUT demo`:
`DISPLAY("What is your name?")
SET name ← INPUT("name")
DISPLAY("Hello, " + name)
`,
`Math & IF`:
`SET a ← 5
SET b ← 12
SET s ← a + b
DISPLAY("sum = " + s)
IF s > 12
  DISPLAY("Big number")
ELSE
  DISPLAY("Small number")
END IF
`,
`REPEAT n TIMES`:
`REPEAT 5 TIMES
  DISPLAY("loop")
END REPEAT
`,
`RE
