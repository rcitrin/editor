// TechBoston CSP Interpreter — With Procedures (AP CSP style)
// Supports: SET, DISPLAY, INPUT, IF/ELSE/END IF, REPEAT/UNTIL/END REPEAT,
// PROCEDURE, params, CALL, RETURN

window.addEventListener("DOMContentLoaded", () => {

  const $ = sel => document.querySelector(sel);

  const consoleEl = $("#console");
  const statusEl = $("#status");
  const runBtn = $("#runBtn");
  const stopBtn = $("#stopBtn");
  const editor = $("#editor");
  const promptWrap = $("#promptWrap");
  const promptInput = $("#promptInput");
  const promptOk = $("#promptOk");
  const promptCancel = $("#promptCancel");
  const samplesSel = $("#samples");

  let halted = false;
  let inputResolve, inputReject;

  function log(msg, cls="log") {
    const div = document.createElement("div");
    div.className = "line " + cls;
    div.textContent = msg;
    consoleEl.appendChild(div);
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }
  const out = msg => log(msg, "log");
  const err = msg => log(msg, "err");
  const sys = msg => log(msg, "sys");
  const setStatus = msg => statusEl.textContent = msg;
  const clearConsole = () => consoleEl.innerHTML = "";

  // --------------------- INPUT UI --------------------
  function showPrompt(p) {
    promptInput.value = "";
    promptInput.placeholder = p || "Input";
    promptWrap.classList.add("show");
    promptInput.focus();
    return new Promise((resolve, reject) => {
      inputResolve = resolve;
      inputReject = reject;
    });
  }
  function hidePrompt() {
    promptWrap.classList.remove("show");
  }

  promptOk.onclick = () => { if (inputResolve){ inputResolve(promptInput.value); hidePrompt(); }};
  promptCancel.onclick = () => { if (inputReject){ inputReject("cancel"); hidePrompt(); }};
  promptInput.addEventListener("keydown", e => {
    if (e.key === "Enter") promptOk.click();
    if (e.key === "Escape") promptCancel.click();
  });

  // ------------------- PREPROCESS --------------------
  function preprocess(src) {
    return src.split(/\r?\n/).map((raw, idx) => {
      const clean = raw
        .replace(/[\u200B-\u200D\uFEFF]/g, "")
        .replace(/#.*$/, "")
        .replace(/\/\/.*$/, "")
        .trim();
      return { raw, s: clean, idx };
    });
  }

  // ------------------- BLOCKS ------------------------
  function buildBlocks(lines) {
    const stack = [];
    const blocks = {};
    for (let i=0;i<lines.length;i++) {
      const t = lines[i].s;
      if (!t) continue;
      if (/^IF\b/i.test(t)) stack.push({type:"IF", i});
      else if (/^ELSE\b/i.test(t)) {
        const top = stack.at(-1);
        blocks[top.i] = blocks[top.i]||{}; blocks[top.i].else = i;
      }
      else if (/^END\s*IF\b/i.test(t)) {
        const top = stack.pop();
        blocks[top.i] = blocks[top.i] || {}; blocks[top.i].end = i;
      }
      else if (/^REPEAT\s+\d+\s+TIMES\b/i.test(t)) stack.push({type:"RT", i});
      else if (/^REPEAT\s+UNTIL/i.test(t)) stack.push({type:"RU", i});
      else if (/^END\s*REPEAT\b/i.test(t)) {
        const top = stack.pop();
        blocks[top.i] = blocks[top.i]||{}; blocks[top.i].end = i;
      }
    }
    return blocks;
  }

  function findMatching(lines, idx, regex) {
    for (let i=idx-1;i>=0;i--) if (regex.test(lines[i].s)) return i;
    return -1;
  }

  // ------------------ PROCEDURE PARSE -----------------
  function parseProcedures(lines){
    const procs = {};
    let curr = null;

    for (let i=0; i<lines.length; i++){
      const t = lines[i].s;
      if (/^PROCEDURE\b/i.test(t)){
        const m = t.match(/^PROCEDURE\s+([A-Za-z_]\w*)\s*\((.*)\)/i);
        const name = m[1];
        const params = m[2].split(",").map(s=>s.trim()).filter(Boolean);
        curr = { name, params, start: i+1, end: null };
      } else if (/^END\s+PROCEDURE\b/i.test(t)){
        curr.end = i;
        procs[curr.name] = curr;
        curr = null;
      }
    }
    return procs;
  }

  // ------------------- EVAL ---------------------------
  function makeEval(env){
    const whitelist = /^[\w\s+\-*/%().,<>!=\"']+$/u;
    return async expr => {
      let e = expr
        .replace(/≤/g,"<=")
        .replace(/≥/g,">=")
        .replace(/≠/g,"!=")
        .replace(/\bAND\b/gi,"&&")
        .replace(/\bOR\b/gi,"||")
        .replace(/\bNOT\b/gi,"!");

      if (!whitelist.test(e)) throw "Expression contains unsupported characters";

      const INPUT = async prompt => showPrompt(prompt);
      const fn = new Function("env","Math","INPUT",`with(env){return (${e});}`);
      return await fn(env, Math, INPUT);
    };
  }

  async function execBlock(lines, blocks, procs, env, start, end){
    const evalExpr = makeEval(env);
    let i = start;

    while (i < end) {
      const {s, idx} = lines[i];
      i++;

      if (!s) continue;

      // ----- DISPLAY -----
      if (/^DISPLAY\s*\(/i.test(s)){
        const m = s.match(/^DISPLAY\s*\((.*)\)$/i);
        out(await evalExpr(m[1]));
      }
      // ----- SET -----
      else if (/^(SET\s+)?[A-Za-z_]\w*\s*(←|<-)/.test(s)){
        const m = s.match(/^(?:SET\s+)?([A-Za-z_]\w*)\s*(?:←|<-)\s*(.*)$/i);
        env[m[1]] = await evalExpr(m[2]);
      }
      // ----- IF -----
      else if (/^IF\b/i.test(s)){
        const cond = s.replace(/^IF\b/i,"").replace(/\bTHEN\b/i,"").trim();
        const ok = await evalExpr(cond);
        const meta = blocks[idx];
        if (!ok){
          if (meta.else != null) i = meta.else + 1;
          else i = meta.end + 1;
        }
      }
      else if (/^ELSE\b/i.test(s)){
        const startIf = findMatching(lines, idx, /^IF\b/i);
        i = blocks[startIf].end + 1;
      }
      else if (/^END\s*IF/i.test(s)){}
      // ----- REPEAT -----
      else if (/^REPEAT\s+\d+\s+TIMES\b/i.test(s)){
        const m = s.match(/^REPEAT\s+(\d+)\s+TIMES/i);
        const count = +m[1];
        const meta = blocks[idx];
        env[`_c${idx}`] ??= 0;
        env[`_c${idx}`]++;
        if (env[`_c${idx}`] > count){
          delete env[`_c${idx}`];
          i = meta.end + 1;
        }
      }
      else if (/^REPEAT\s+UNTIL\b/i.test(s)){
        env[`_u${idx}`] = s.replace(/^REPEAT\s+UNTIL\b/i,"").trim();
      }
      else if (/^END\s*REPEAT/i.test(s)){
        const startR = findMatching(lines, idx, /^REPEAT\b/i);
        if (/^REPEAT\s+UNTIL/i.test(lines[startR].s)){
          const cond = env[`_u${startR}`];
          const ok = await evalExpr(cond);
          if (!ok) i = startR + 1;
        }
      }
      // ----- PROCEDURE call -----
      else if (/^[A-Za-z_]\w*\s*\(/.test(s)){
        let call = s.replace(/^CALL\s+/i,"");
        const m = call.match(/^([A-Za-z_]\w*)\s*\((.*)\)/);
        if (!m) throw `Bad procedure call at line ${idx+1}`;

        const name = m[1];
        if (!procs[name]) throw `Unknown procedure ${name}`;

        const args = m[2].split(",").map(a=>a.trim()).filter(Boolean);
        const def = procs[name];
        const local = Object.create(env);

        for (let x=0; x<def.params.length; x++){
          local[def.params[x]] = await evalExpr(args[x] || "");
        }

        const ret = await execBlock(lines, blocks, procs, local, def.start, def.end);
        env._return = ret;
      }
      // ----- RETURN -----
      else if (/^RETURN\b/i.test(s)){
        const expr = s.replace(/^RETURN/i,"").trim();
        return expr ? await evalExpr(expr) : null;
      }
      else if (/^PROCEDURE\b/i.test(s)) {
        // skip body here
        const def = parseProcedures(lines)[s.split(/\s+/)[1].split("(")[0]];
        i = def.end + 1;
      }
      else if (/^END\s+PROCEDURE/i.test(s)){
        return;
      }
      else throw `Unknown statement at line ${idx+1}: ${s}`;
    }
  }

  async function run(src) {
    halted = false;
    clearConsole();
    setStatus("Parsing…");

    const lines = preprocess(src);
    const blocks = buildBlocks(lines);
    const procs = parseProcedures(lines);
    const env = {};
    setStatus("Running…");

    try {
      await execBlock(lines, blocks, procs, env, 0, lines.length);
      setStatus("Finished");
    } catch(e){
      err(e);
      setStatus("Crashed");
    }
  }

  // ---------- UI hook ----------
  runBtn.onclick = () => run(editor.value);
  stopBtn.onclick = () => halted = true;

  document.addEventListener("keydown", e=>{
    if ((e.metaKey||e.ctrlKey) && e.key==="Enter") runBtn.click();
  });

  // ----- Samples -----
  const samples = {
"Hello Procedure":
`PROCEDURE greet(name)
  DISPLAY("Hello " + name)
END PROCEDURE

greet("TBA")`
  };

  samplesSel.innerHTML = "<option>Load sample…</option>" +
    Object.keys(samples).map(k=>`<option value="${k}">${k}</option>`).join("");

  samplesSel.onchange = () => {
    if(samples[samplesSel.value]) editor.value = samples[samplesSel.value];
    samplesSel.value = "";
  };

  editor.value = samples["Hello Procedure"];
  sys("Ready.");
});
