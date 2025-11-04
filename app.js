// TechBoston CSP Mini Interpreter (stable core build)
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

  // --- INPUT prompt handling ---
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

  promptOk.onclick = () => { if (inputResolve) { inputResolve(promptInput.value); hidePrompt(); }};
  promptCancel.onclick = () => { if (inputReject) { inputReject("cancel"); hidePrompt(); }};
  promptInput.addEventListener("keydown", e => {
    if (e.key === "Enter") promptOk.click();
    if (e.key === "Escape") promptCancel.click();
  });

  // --- Parser / sanitizer ---
  function preprocess(src) {
    return src.split(/\r?\n/).map((raw, idx) => {
      const clean = raw
        .replace(/[\u200B-\u200D\uFEFF]/g, "") // kill zero-width weirdos
        .replace(/#.*$/, "")
        .replace(/\/\/.*$/, "")
        .trim();
      return { raw, s: clean, idx };
    });
  }

  function buildBlocks(lines) {
    const stack = [];
    const blocks = {};
    for (let i=0;i<lines.length;i++) {
      const t = lines[i].s;
      if (!t) continue;

      if (/^IF\b/i.test(t)) stack.push({type:"IF", i});
      else if (/^ELSE\b/i.test(t)) {
        const top = stack.at(-1);
        if (!top || top.type!=="IF") throw `ELSE without IF at line ${i+1}`;
        blocks[top.i] = blocks[top.i] || {}; blocks[top.i].else = i;
      }
      else if (/^END\s*IF\b/i.test(t)) {
        const top = stack.pop();
        if (!top || top.type!=="IF") throw `END IF without IF at line ${i+1}`;
        blocks[top.i] = blocks[top.i] || {}; blocks[top.i].end = i;
      }
      else if (/^REPEAT\s+\d+\s+TIMES\b/i.test(t)) stack.push({type:"RT", i});
      else if (/^REPEAT\s+UNTIL/i.test(t)) stack.push({type:"RU", i});
      else if (/^END\s*REPEAT\b/i.test(t)) {
        const top = stack.pop();
        if (!top) throw `END REPEAT without REPEAT at line ${i+1}`;
        blocks[top.i] = blocks[top.i] || {}; blocks[top.i].end = i;
      }
    }
    if (stack.length) throw `Unclosed block at line ${stack[0].i+1}`;
    return blocks;
  }

  function findMatching(lines, endIdx, regex) {
    for (let i=endIdx-1;i>=0;i--) if (regex.test(lines[i].s)) return i;
    return -1;
  }

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

  async function run(src) {
    halted = false;
    clearConsole();
    setStatus("Parsing…");

    const lines = preprocess(src);
    const blocks = buildBlocks(lines);
    const env = {};
    const evalExpr = makeEval(env);
    let i = 0;
    let steps = 0;

    setStatus("Running…");
    while (i < lines.length) {
      if (halted) { setStatus("Stopped"); return; }
      if (++steps > 20000) { err("Infinite loop?"); return; }

      const {s, idx} = lines[i];
      i++;

      if (!s) continue;

      try {
        if (/^DISPLAY\s*\(/i.test(s)){
          const m = s.match(/^DISPLAY\s*\((.*)\)$/i);
          out(await evalExpr(m[1]));
        }
        else if (/^(SET\s+)?[A-Za-z_]\w*\s*(←|<-)\s*/.test(s)){
          const m = s.match(/^(?:SET\s+)?([A-Za-z_]\w*)\s*(?:←|<-)\s*(.*)$/i);
          env[m[1]] = await evalExpr(m[2]);
        }
        else if (/^IF\b/i.test(s)){
          const cond = s.replace(/^IF\b/i,"").replace(/\bTHEN\b/i,"").trim();
          const ok = await evalExpr(cond);
          const meta = blocks[idx];
          if (!ok) {
            if (meta.else != null) i = meta.else + 1;
            else i = meta.end + 1;
          }
        }
        else if (/^ELSE\b/i.test(s)) {
          const start = findMatching(lines, idx, /^IF\b/i);
          i = blocks[start].end + 1;
        }
        else if (/^END\s*IF/i.test(s)){}
        else if (/^REPEAT\s+\d+\s+TIMES\b/i.test(s)){
          const m = s.match(/^REPEAT\s+(\d+)\s+TIMES\b/i);
          const count = +m[1];
          const meta = blocks[idx];
          env[`_c${idx}`] ??=0;
          env[`_c${idx}`]++;
          if (env[`_c${idx}`] > count) { delete env[`_c${idx}`]; i = meta.end + 1; }
        }
        else if (/^REPEAT\s+UNTIL\b/i.test(s)){
          env[`_u${idx}`] = s.replace(/^REPEAT\s+UNTIL\b/i,"").trim();
        }
        else if (/^END\s*REPEAT/i.test(s)){
          const start = findMatching(lines, idx, /^REPEAT\b/i);
          if (/^REPEAT\s+UNTIL/i.test(lines[start].s)){
            const cond = env[`_u${start}`];
            const ok = await evalExpr(cond);
            if (!ok) i = start + 1;
          }
        }
        else if (/^INPUT\s*\(/i.test(s)){
          await evalExpr(s);
        }
        else throw `Unknown statement: ${s}`;
      } catch(e){
        err(`Line ${idx+1}: ${e}`);
        setStatus("Crashed");
        return;
      }
    }
    setStatus("Finished");
  }

  // ---------- UI ----------
  runBtn.onclick = () => run(editor.value);
  stopBtn.onclick = () => { halted = true; };

  document.addEventListener("keydown", e=>{
    if ((e.metaKey||e.ctrlKey) && e.key==="Enter") runBtn.click();
  });

  // ---------- Samples ----------
  const samples = {
"Hello":
`DISPLAY("What is your name?")
SET name ← INPUT("name")
DISPLAY("Hello, " + name)`,

"Repeat":
`SET x ← 0
REPEAT UNTIL x ≥ 3
  DISPLAY(x)
  SET x ← x + 1
END REPEAT`
  };

  samplesSel.innerHTML = "<option>Load sample…</option>" +
    Object.keys(samples).map(k=>`<option value="${k}">${k}</option>`).join("");
  samplesSel.onchange = () => {
    if (samples[samplesSel.value]) editor.value = samples[samplesSel.value];
    samplesSel.value = "";
  };

  editor.value = samples["Hello"];
  setStatus("Ready");
  sys("Ready.");
});
