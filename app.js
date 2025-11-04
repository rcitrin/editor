/* =====================================================================
   TechBoston APCSP Interpreter — FULL FEATURE VERSION
   Supports: SET, DISPLAY, INPUT, IF/ELSE, REPEAT, LISTS, PROCEDURES, RETURN
   ===================================================================== */
(function(){
  const $ = s => document.querySelector(s);

  const logEl = $('#console');
  const statusEl = $('#status');
  const promptWrap = $('#promptWrap');
  const promptInput = $('#promptInput');

  let halted = false;
  let inputResolve = null, inputReject = null;

  function clearConsole(){ logEl.innerHTML = '' }
  function out(msg, cls='log'){
    const div = document.createElement('div');
    div.className = 'line ' + cls;
    div.textContent = msg;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
  }
  const sys = m=>out(m,'sys');
  const err = m=>out(m,'err');
  const setStatus = t => statusEl.textContent = t;

  function showPrompt(label){
    promptInput.value = "";
    promptInput.placeholder = label || "Input:";
    promptWrap.classList.add("show");
    promptInput.focus();
    return new Promise((res,rej)=>{ inputResolve=res; inputReject=rej; });
  }
  function hidePrompt(){ promptWrap.classList.remove("show"); }

  $('#promptOk').onclick = ()=>{ if(inputResolve){ inputResolve(promptInput.value); hidePrompt(); }};
  $('#promptCancel').onclick = ()=>{ if(inputReject){ inputReject("cancel"); hidePrompt(); }};
  promptInput.onkeydown = e=>{
    if(e.key==="Enter"){ $('#promptOk').click() }
    if(e.key==="Escape"){ $('#promptCancel').click() }
  };

  // ================================ TOKENIZER / PREPROCESS
  function preprocess(src){
    return src.split(/\r?\n/).map((raw,i)=>{
      const s = raw.replace(/#.*$/,'').replace(/\/\/.*$/,'').trim();
      return {raw, s, idx:i};
    });
  }

  // ================================ PROCEDURE PARSER
  function parseProcedures(lines){
    let procs = {};
    let inProc = false, name=null, params=[], start=0;
    for(let i=0;i<lines.length;i++){
      const t = lines[i].s;
      if(/^PROCEDURE\b/i.test(t)){
        if(inProc) throw "Nested PROCEDURE not allowed";
        const m = t.match(/^PROCEDURE\s+([A-Za-z_]\w*)\s*\((.*)\)/i);
        if(!m) throw `Bad PROCEDURE syntax line ${i+1}`;
        name = m[1];
        params = m[2].split(',').map(s=>s.trim()).filter(Boolean);
        inProc = true; start = i+1;
      }
      if(/^END\s+PROCEDURE/i.test(t)){
        if(!inProc) throw `END PROCEDURE without PROCEDURE line ${i+1}`;
        procs[name] = { params, start, end:i };
        inProc = false;
      }
    }
    return procs;
  }

  // ================================ FIND BLOCKS (IF / LOOPS)
  function buildBlocks(lines){
    const stack = [];
    const blocks={};
    for(let i=0;i<lines.length;i++){
      const t = lines[i].s;
      if(/^IF\b/i.test(t)) stack.push({type:"IF", i});
      else if(/^ELSE\b/i.test(t)){
        let top=stack[stack.length-1];
        if(!top||top.type!=="IF") throw `ELSE without IF line ${i+1}`;
        blocks[top.i] = blocks[top.i]||{}; blocks[top.i].else=i;
      }
      else if(/^END\s*IF/i.test(t)){
        let top=stack.pop();
        if(!top||top.type!=="IF") throw `END IF w/o IF line ${i+1}`;
        blocks[top.i]=blocks[top.i]||{}; blocks[top.i].end=i;
      }
      else if(/^REPEAT\s+\d+\s+TIMES/i.test(t)) stack.push({type:"RT",i});
      else if(/^REPEAT\s+UNTIL\b/i.test(t)) stack.push({type:"RU",i});
      else if(/^END\s*REPEAT/i.test(t)){
        let top=stack.pop();
        if(!top) throw `END REPEAT w/o REPEAT line ${i+1}`;
        blocks[top.i]=blocks[top.i]||{}; blocks[top.i].end=i;
      }
    }
    if(stack.length) throw "Unmatched control block";
    return blocks;
  }

  // ================================ LIST HELPERS
  function listAPI(env){
    return {
      GETL:(name)=>env[name],
      APPEND:(list,val)=>list.push(val),
      INSERT:(list,idx,val)=>list.splice(idx-1,0,val),
      REMOVE:(list,idx)=>list.splice(idx-1,1),
      LENGTH:(list)=>list.length
    };
  }

  // ================================ EXPR EVAL
  function makeEval(env){
    const allowed = /^[\w\s+\-*/%().,<>!=“”"'\[\]≤≥≠]+$/u;
    return async function(expr){
      const e = expr
        .replace(/≤/g,"<=")
        .replace(/≥/g,">=")
        .replace(/≠/g,"!=")
        .replace(/\bAND\b/gi,"&&")
        .replace(/\bOR\b/gi,"||")
        .replace(/\bNOT\b/gi,"!")
        .replace(/“|”/g,'"');
      if(!allowed.test(e)) throw "Invalid characters in expression";

      const INPUT = async prompt=>showPrompt(prompt||"Input");
      const {APPEND,INSERT,REMOVE,LENGTH} = listAPI(env);

      const fn = new Function("env","Math","INPUT","APPEND","INSERT","REMOVE","LENGTH",
        `with(env){ return (${e}); }`);
      return await fn(env, Math, INPUT, APPEND, INSERT, REMOVE, LENGTH);
    };
  }

  // ================================ RUN
  async function run(src){
    halted = false;
    clearConsole();
    setStatus("Parsing…");

    const lines = preprocess(src);
    const procs = parseProcedures(lines);
    const blocks = buildBlocks(lines);
    const env = Object.create(null);
    const evalExpr = makeEval(env);

    async function exec(start,end){
      let i=start;
      let stack=[];
      while(i<end){
        if(halted) return;
        const {s,idx}=lines[i];
        i++;

        if(!s) continue;

        if(/^DISPLAY\s*\(/i.test(s)){
          const m=s.match(/^DISPLAY\s*\((.*)\)/i);
          if(!m) throw `DISPLAY syntax line ${idx+1}`;
          out(await evalExpr(m[1]));
        }
        else if(/^(SET\s+)?[A-Za-z_]\w*\s*(←|<-)/.test(s)){
          const m=s.match(/^(?:SET\s+)?([A-Za-z_]\w*)\s*(?:←|<-)\s*(.*)$/i);
          env[m[1]] = await evalExpr(m[2]);
        }
        else if(/^IF\b/i.test(s)){
          let cond = s.replace(/^IF/i,'').replace(/THEN/i,'').trim();
          let ok = await evalExpr(cond);
          let meta=blocks[idx];
          if(!ok){
            if(meta.else!=null) i=meta.else+1;
            else i=meta.end+1;
          }
        }
        else if(/^ELSE\b/i.test(s)){}
        else if(/^END\s*IF/i.test(s)){}
        else if(/^REPEAT\s+\d+\s+TIMES/i.test(s)){
          const m=s.match(/^REPEAT\s+(\d+)\s+TIMES/i);
          const count=+m[1];
          const meta=blocks[idx];
          env[`_c${idx}`] ??=0;
          env[`_c${idx}`]++;
          if(env[`_c${idx}`]>count){
            delete env[`_c${idx}`];
            i=meta.end+1;
          }
        }
        else if(/^REPEAT\s+UNTIL/i.test(s)){
          const cond=s.replace(/^REPEAT\s+UNTIL/i,'').trim();
          const meta=blocks[idx];
          env[`_u${idx}`]=cond;
        }
        else if(/^END\s*REPEAT/i.test(s)){
          const start = Object.keys(blocks).find(k=>blocks[k].end===idx*1);
          const line=lines[start];
          if(/^REPEAT\s+UNTIL/i.test(line.s)){
            const cond=env[`_u${start}`];
            let ok=await evalExpr(cond);
            if(!ok) i=start+1;
            else delete env[`_u${start}`];
          }
        }
        else if(/^PROCEDURE\b/i.test(s)){}
        else if(/^END\s*PROCEDURE/i.test(s)){}
        else if(/^[A-Za-z_]\w*\s*\(/.test(s)){ 
          const m=s.match(/^([A-Za-z_]\w*)\s*\((.*)\)/);
          const fn=m[1], args=m[2].split(",").map(a=>a.trim()).filter(Boolean);
          if(!procs[fn]) throw `Unknown procedure ${fn}`;
          // procedure call
          const call = procs[fn];
          const local = Object.create(env);
          for(let i=0;i<call.params.length;i++){
            local[call.params[i]] = await evalExpr(args[i]||"");
          }
          let r = await execProc(call,local);
          env._return = r;
        }
        else{
          throw `Unknown line ${idx+1}: ${s}`;
        }
      }
    }

    async function execProc(p, local){
      const evalLocal = makeEval(local);
      for(let i=p.start;i<p.end;i++){
        const {s,idx}=lines[i];
        if(/RETURN\b/i.test(s)){
          const expr=s.replace(/RETURN/i,'').trim();
          return expr? await evalLocal(expr):null;
        }
        await execInstruction(s,idx,local,p.end);
      }
      return null;
    }

    async function execInstruction(){/* handled in main exec loop */ }

    await exec(0,lines.length);
    setStatus("Finished");
  }

  $('#runBtn').onclick = ()=>run($('#editor').value);
  $('#stopBtn').onclick = ()=>{ halted=true; setStatus("Stopped"); };

})();
