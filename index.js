// 续写鸡 NEXT 一体化 v1.0.0
// 全新独立扩展：不依赖旧续写鸡，不依赖 ST-Prompt-Template / Extension-ScriptEvents
import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const EXT = "XuXieJi_NEXT";
const VERSION = "1.0.0";
const BASE_KEY = "xuxieji_next";
const $id = (id) => document.getElementById(id);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const DEFAULT_SETTINGS = {
  branchCount: 1,
  maxEditorTail: 12000,
  autoSummaryEnabled: true,
  autoSummaryThreshold: 12000,
  autoSummaryTarget: 900,
  worldbookEnabled: true,
  dynamicPromptEnabled: true,
  rpEnabled: true,
  hudEnabled: true,
  secretLock: true,
  systemPrompt: `你是长篇小说续写引擎。必须严格承接已有正文、记忆、世界状态与人物知识边界。
禁止擅自跳过关键过程，禁止无原因恢复损伤、关系或资源。
当存在冲突设定时保留冲突，不擅自统一。`,
  dynamicTemplate: `【动态世界状态】
当前时间：{{currentTime}}
当前位置：{{location}}
在场角色：{{presentCharacters}}
所属势力：{{faction}}
知识阶段：{{knowledgeStage}}
机体状态：{{bodyStatus}}
能源：{{energy}}
损伤：{{damage}}
处理器：{{processor}}
通讯：{{communication}}
电子眼：{{visionMode}}
当前事件：{{currentEvent}}
隐藏情报锁：{{secretLock}}

{{#if secretLock}}
严格遵守当前知识阶段，不得提前泄露角色尚未知晓的信息。
{{/if}}

机体连续性规则：
- 结构损伤、模块损伤、能源不足、核心数据损伤必须分开处理。
- DAMAGE/REPAIR 必须承接上一次状态，不得无原因瞬间恢复。
- 普通对白/普通叙事不强制显示电子眼HUD。
- 只有扫描、识别、锁定、分析或电子脑UI实际运行时，才表现机器视觉界面。`
};

const DEFAULT_RP = {
  currentTime: "未知",
  location: "未知",
  presentCharacters: "苏若",
  faction: "未知",
  knowledgeStage: "SURO-K0",
  bodyStatus: "严重受损恢复期",
  energy: "未知",
  damage: ">35%（初始）",
  processor: "CPU受损 / 辅助CPU严重故障",
  communication: "中枢连接不稳定",
  visionMode: "NORMAL",
  currentEvent: "苏若苏醒",
  secretLock: "ON"
};

const DEFAULT_DAMAGE = {
  severity: "D4",
  structural: "未知",
  modules: "CPU受损；辅助CPU严重故障",
  power: "未知",
  coreData: "待检测",
  memory: "待检测",
  processorStability: "不稳定",
  repairState: "主动金属自修复中",
  externalRepair: "辅助CPU需要外部维修设施",
  notes: ""
};

let editorText = "";
let busy = false;
let stBridgeReady = false;

// ---------------- Storage / scope ----------------
function safeContext() {
  try { return getContext?.() || {}; } catch { return {}; }
}
function scopeId() {
  const c = safeContext();
  return String(c.chatId ?? c.chat_id ?? c.characterId ?? c.character_id ?? c.name2 ?? "default");
}
function key(name) { return `${BASE_KEY}__${scopeId()}__${name}`; }
function loadJSON(name, fallback) {
  try {
    const raw = localStorage.getItem(key(name));
    return raw ? { ...fallback, ...JSON.parse(raw) } : structuredClone(fallback);
  } catch { return structuredClone(fallback); }
}
function loadArray(name) {
  try { const x = JSON.parse(localStorage.getItem(key(name)) || "[]"); return Array.isArray(x) ? x : []; }
  catch { return []; }
}
function saveJSON(name, value) { localStorage.setItem(key(name), JSON.stringify(value)); }
function saveArray(name, value) { localStorage.setItem(key(name), JSON.stringify(value)); }

// ---------------- Event bus ----------------
const bus = new Map();
function on(name, fn, once=false) {
  const arr = bus.get(name) || [];
  arr.push({fn, once});
  bus.set(name, arr);
  return () => off(name, fn);
}
function once(name, fn) { return on(name, fn, true); }
function off(name, fn) {
  const arr = bus.get(name) || [];
  bus.set(name, arr.filter(x => x.fn !== fn));
}
function emit(name, detail={}) {
  addLog(name, detail);
  const arr = [...(bus.get(name) || [])];
  for (const x of arr) {
    try { x.fn(detail); } catch (e) { console.error("[续写鸡 NEXT event]", name, e); }
    if (x.once) off(name, x.fn);
  }
  try { window.dispatchEvent(new CustomEvent(`xuxieji-next:${name}`, { detail })); } catch {}
}
function addLog(name, detail={}) {
  const logs = loadArray("logs");
  logs.push({
    t: new Date().toLocaleTimeString(),
    name,
    detail: typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 260)
  });
  while (logs.length > 120) logs.shift();
  saveArray("logs", logs);
  renderDiagnostics();
}

// ---------------- Prompt template ----------------
function truthy(v) {
  if (typeof v === "string") return !["", "0", "false", "off", "no", "null", "undefined"].includes(v.toLowerCase());
  return Boolean(v);
}
function renderTemplate(tpl, vars) {
  let s = String(tpl || "");
  // {{#if key}}...{{/if}}
  s = s.replace(/\{\{#if\s+([A-Za-z0-9_.-]+)\s*\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_, k, body) => truthy(vars[k]) ? body : "");
  // {{#unless key}}...{{/unless}}
  s = s.replace(/\{\{#unless\s+([A-Za-z0-9_.-]+)\s*\}\}([\s\S]*?)\{\{\/unless\}\}/g,
    (_, k, body) => !truthy(vars[k]) ? body : "");
  // {{var}} and <%= var %>
  s = s.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_, k) => vars[k] ?? "");
  s = s.replace(/<%=\s*([A-Za-z0-9_.-]+)\s*%>/g, (_, k) => vars[k] ?? "");
  return s.trim();
}

// ---------------- RP / damage ----------------
function getRP() { return loadJSON("rp", DEFAULT_RP); }
function setRP(patch) {
  const state = {...getRP(), ...(patch || {})};
  saveJSON("rp", state);
  emit("WORLD_STATE_UPDATED", state);
  renderHUD();
  return state;
}
function getDamage() { return loadJSON("damage", DEFAULT_DAMAGE); }
function setDamage(patch) {
  const d = {...getDamage(), ...(patch || {})};
  saveJSON("damage", d);
  emit("DAMAGE_UPDATED", d);
  renderHUD();
  return d;
}
function damagePromptBlock() {
  const d = getDamage();
  return `【DAMAGE / REPAIR 连续状态】
严重度：${d.severity}
结构：${d.structural}
模块：${d.modules}
能源：${d.power}
核心数据：${d.coreData}
记忆完整性：${d.memory}
处理器稳定性：${d.processorStability}
维修状态：${d.repairState}
外部维修：${d.externalRepair}
备注：${d.notes || "无"}

损伤叙事必须遵循：受损前状态 → 原因 → 外观/结构/模块/能源/数据变化 → 系统保护 → 自修复或外部维修 → 恢复后状态。`;
}

// ---------------- Internal worldbook ----------------
function worldbook() { return loadArray("worldbook"); }
function saveWorldbook(list) { saveArray("worldbook", list); emit("WORLDBOOK_UPDATED", {count:list.length}); }
function normalizeKeywords(s) {
  return String(s||"").split(/[,，;\n]/).map(x=>x.trim()).filter(Boolean);
}
function triggeredWorldbook(sourceText) {
  const settings = getSettings();
  if (!settings.worldbookEnabled) return [];
  const text = String(sourceText || "").toLowerCase();
  return worldbook().filter(e => {
    if (!e.enabled) return false;
    if (e.constant) return true;
    const kws = Array.isArray(e.keywords) ? e.keywords : normalizeKeywords(e.keywords);
    return kws.some(k => text.includes(String(k).toLowerCase()));
  });
}
function worldbookBlock(sourceText) {
  const list = triggeredWorldbook(sourceText);
  if (!list.length) return "";
  return "【触发世界书】\n" + list.map((e,i)=>`[${i+1}] ${e.title}\n${e.content}`).join("\n\n");
}

// ---------------- Memory / summaries ----------------
function memories() { return loadArray("memories"); }
function saveMemories(list) { saveArray("memories", list); emit("MEMORY_UPDATED", {count:list.length}); }
function memoryBlock() {
  const arr = memories().filter(x=>x.enabled !== false);
  return arr.length ? "【长期记忆/历史总结】\n" + arr.map((x,i)=>`[${i+1}] ${x.title}\n${x.content}`).join("\n\n") : "";
}
async function summarizeText(text, title="自动总结") {
  const c = safeContext();
  if (typeof c.generateRaw !== "function") throw new Error("SillyTavern generateRaw 不可用");
  const settings = getSettings();
  emit("SUMMARY_STARTED", {length:text.length});
  const out = await c.generateRaw({
    systemPrompt: "你是长篇小说记忆压缩器。只保留剧情事实、人物状态、关系变化、地点、时间、资源、损伤与未解决伏笔。不要添加原文没有的信息。",
    prompt: `请把下面正文压缩成约 ${settings.autoSummaryTarget} 字的长期记忆。\n\n${text}`,
    stream: false
  });
  const result = extractText(out);
  if (!result) throw new Error("总结返回为空");
  const arr = memories();
  arr.push({id:crypto.randomUUID?.() || String(Date.now()), title, content:result, enabled:true, time:Date.now()});
  saveMemories(arr);
  emit("SUMMARY_FINISHED", {length:result.length});
  return result;
}

// ---------------- Generation ----------------
function extractText(raw) {
  if (typeof raw === "string") return raw.trim();
  const candidates = [
    raw?.content, raw?.text, raw?.message?.content,
    raw?.choices?.[0]?.message?.content, raw?.choices?.[0]?.text,
    raw?.data?.choices?.[0]?.message?.content
  ];
  return candidates.find(x=>typeof x==="string" && x.trim())?.trim() || "";
}
function getSettings() {
  extension_settings[EXT] = {...DEFAULT_SETTINGS, ...(extension_settings[EXT] || {})};
  return extension_settings[EXT];
}
function promptBundle(direction="") {
  const s = getSettings();
  const rp = getRP();
  const tail = editorText.slice(-Math.max(2000, Number(s.maxEditorTail)||12000));
  const dynamic = s.dynamicPromptEnabled ? renderTemplate(s.dynamicTemplate, rp) : "";
  const blocks = [
    s.systemPrompt,
    memoryBlock(),
    worldbookBlock(`${tail}\n${direction}\n${JSON.stringify(rp)}`),
    s.rpEnabled ? dynamic : "",
    s.rpEnabled ? damagePromptBlock() : ""
  ].filter(Boolean);
  return {
    systemPrompt: blocks.join("\n\n"),
    prompt: `【当前正文尾部】\n${tail || "（暂无正文）"}\n\n【本次续写要求】\n${direction || "自然承接并继续故事。"}\n\n只输出续写正文，不解释。`
  };
}
async function generateContinuation(direction="") {
  if (busy) return;
  const c = safeContext();
  if (typeof c.generateRaw !== "function") {
    toastr.error("当前 SillyTavern 没有提供 generateRaw。", "续写鸡 NEXT");
    return;
  }
  busy = true;
  updateBusy();
  try {
    const p = promptBundle(direction);
    emit("GENERATION_STARTED", {promptLength:p.prompt.length, systemLength:p.systemPrompt.length});
    emit("PROMPT_INJECTED", {worldbook:triggeredWorldbook(editorText+"\n"+direction).length});
    const raw = await c.generateRaw({systemPrompt:p.systemPrompt, prompt:p.prompt, stream:false});
    const text = extractText(raw);
    if (!text) throw new Error("AI返回为空");
    editorText = [editorText.trimEnd(), text].filter(Boolean).join("\n\n");
    saveEditor();
    emit("GENERATION_FINISHED", {length:text.length});
    renderEditor();
    await maybeAutoSummarize();
  } catch(e) {
    console.error(e);
    emit("GENERATION_ERROR", String(e?.message || e));
    toastr.error(String(e?.message || e), "续写失败");
  } finally {
    busy = false; updateBusy();
  }
}
async function maybeAutoSummarize() {
  const s = getSettings();
  if (!s.autoSummaryEnabled) return;
  const checkpoint = Number(localStorage.getItem(key("summary_checkpoint")) || 0);
  if (editorText.length - checkpoint < Number(s.autoSummaryThreshold || 12000)) return;
  const segment = editorText.slice(checkpoint, editorText.length);
  try {
    await summarizeText(segment, `自动记忆 ${new Date().toLocaleString()}`);
    localStorage.setItem(key("summary_checkpoint"), String(editorText.length));
  } catch(e) {
    emit("SUMMARY_ERROR", String(e?.message || e));
  }
}

// ---------------- Editor ----------------
function loadEditor() { editorText = localStorage.getItem(key("editor")) || ""; }
function saveEditor() {
  localStorage.setItem(key("editor"), editorText);
  emit("EDITOR_SAVED", {length:editorText.length});
}
function renderEditor() {
  const ta = $id("xjn-editor-text");
  if (ta && ta.value !== editorText) ta.value = editorText;
  const wc = $id("xjn-word-count");
  if (wc) wc.textContent = `${editorText.length.toLocaleString()} 字`;
}
function updateBusy() {
  const b = $id("xjn-generate");
  if (b) { b.disabled = busy; b.textContent = busy ? "生成中…" : "开始续写"; }
}

// ---------------- UI helpers ----------------
function esc(s) { return String(s??"").replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function modal(title, body, cls="") {
  const wrap = document.createElement("div");
  wrap.className = "xjn-modal";
  wrap.innerHTML = `<div class="xjn-mask"></div><div class="xjn-dialog ${cls}"><div class="xjn-head"><b>${esc(title)}</b><button class="menu_button xjn-close">×</button></div><div class="xjn-body">${body}</div></div>`;
  document.body.appendChild(wrap);
  const close = ()=>wrap.remove();
  wrap.querySelector(".xjn-close").onclick=close;
  wrap.querySelector(".xjn-mask").onclick=close;
  return wrap;
}
function openEditor() {
  loadEditor();
  const w = modal("续写鸡 NEXT · 长篇编辑器", `
    <div class="xjn-toolbar">
      <button id="xjn-generate" class="menu_button primary">开始续写</button>
      <button id="xjn-save" class="menu_button">保存</button>
      <button id="xjn-summary" class="menu_button">总结当前正文</button>
      <button id="xjn-export" class="menu_button">导出TXT</button>
      <span id="xjn-word-count"></span>
    </div>
    <textarea id="xjn-editor-text" class="text_pole xjn-editor"></textarea>
    <label class="xjn-label">本次定向要求</label>
    <textarea id="xjn-direction" class="text_pole xjn-direction" placeholder="例如：继续当前场景，不跳时间；优先表现机体故障和电子眼反馈。"></textarea>
  `, "xjn-editor-dialog");
  const ta=$id("xjn-editor-text"); ta.value=editorText;
  ta.addEventListener("input",()=>{editorText=ta.value; renderEditor();});
  $id("xjn-save").onclick=()=>{saveEditor(); toastr.success("正文已保存","续写鸡 NEXT");};
  $id("xjn-generate").onclick=()=>generateContinuation($id("xjn-direction").value);
  $id("xjn-summary").onclick=async()=> {
    try { await summarizeText(editorText, `手动总结 ${new Date().toLocaleString()}`); toastr.success("总结已加入长期记忆","续写鸡 NEXT"); }
    catch(e){toastr.error(String(e.message||e),"总结失败");}
  };
  $id("xjn-export").onclick=()=>{
    const blob=new Blob([editorText],{type:"text/plain;charset=utf-8"});
    const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download="续写鸡_NEXT_正文.txt"; a.click(); URL.revokeObjectURL(a.href);
  };
  renderEditor(); updateBusy();
}

function openWorldbook() {
  let list=worldbook();
  const w=modal("内置世界书", `
    <div class="xjn-toolbar"><button id="xjn-wb-add" class="menu_button primary">新增条目</button><button id="xjn-wb-export" class="menu_button">导出JSON</button><label class="menu_button">导入JSON<input id="xjn-wb-import" type="file" accept=".json" hidden></label></div>
    <div id="xjn-wb-list"></div>`, "xjn-wide");
  const box=$id("xjn-wb-list");
  function render(){
    box.innerHTML=list.map((e,i)=>`<div class="xjn-card">
      <div class="xjn-card-row"><input class="text_pole wb-title" data-i="${i}" value="${esc(e.title)}"><label><input type="checkbox" class="wb-enabled" data-i="${i}" ${e.enabled?"checked":""}>启用</label><label><input type="checkbox" class="wb-constant" data-i="${i}" ${e.constant?"checked":""}>常驻</label><button class="menu_button wb-del" data-i="${i}">删除</button></div>
      <input class="text_pole wb-keywords" data-i="${i}" value="${esc((e.keywords||[]).join(", "))}" placeholder="关键词，逗号分隔">
      <textarea class="text_pole wb-content" data-i="${i}" rows="5">${esc(e.content||"")}</textarea>
    </div>`).join("") || `<div class="xjn-empty">暂无世界书条目。</div>`;
    box.querySelectorAll("input,textarea").forEach(el=>el.addEventListener("change",()=>{
      const i=Number(el.dataset.i); if(Number.isNaN(i))return;
      if(el.classList.contains("wb-title")) list[i].title=el.value;
      if(el.classList.contains("wb-enabled")) list[i].enabled=el.checked;
      if(el.classList.contains("wb-constant")) list[i].constant=el.checked;
      if(el.classList.contains("wb-keywords")) list[i].keywords=normalizeKeywords(el.value);
      if(el.classList.contains("wb-content")) list[i].content=el.value;
      saveWorldbook(list);
    }));
    box.querySelectorAll(".wb-del").forEach(b=>b.onclick=()=>{list.splice(Number(b.dataset.i),1);saveWorldbook(list);render();});
  }
  $id("xjn-wb-add").onclick=()=>{list.push({id:String(Date.now()),title:"新条目",keywords:[],content:"",enabled:true,constant:false});saveWorldbook(list);render();};
  $id("xjn-wb-export").onclick=()=>downloadJSON("续写鸡_NEXT_世界书.json", list);
  $id("xjn-wb-import").onchange=async ev=>{try{list=JSON.parse(await ev.target.files[0].text());saveWorldbook(list);render();}catch{toastr.error("JSON格式错误");}};
  render();
}

function openMemory() {
  let list=memories();
  const w=modal("长期记忆 / 总结库", `
    <div class="xjn-toolbar"><button id="xjn-mem-add" class="menu_button primary">新增记忆</button><button id="xjn-mem-export" class="menu_button">导出JSON</button></div>
    <div id="xjn-mem-list"></div>`, "xjn-wide");
  const box=$id("xjn-mem-list");
  function render(){
    box.innerHTML=list.map((e,i)=>`<div class="xjn-card"><div class="xjn-card-row"><input class="text_pole mem-title" data-i="${i}" value="${esc(e.title)}"><label><input class="mem-enabled" data-i="${i}" type="checkbox" ${e.enabled!==false?"checked":""}>启用</label><button class="menu_button mem-del" data-i="${i}">删除</button></div><textarea class="text_pole mem-content" data-i="${i}" rows="5">${esc(e.content||"")}</textarea></div>`).join("")||`<div class="xjn-empty">暂无长期记忆。</div>`;
    box.querySelectorAll("input,textarea").forEach(el=>el.addEventListener("change",()=>{const i=Number(el.dataset.i);if(el.classList.contains("mem-title"))list[i].title=el.value;if(el.classList.contains("mem-enabled"))list[i].enabled=el.checked;if(el.classList.contains("mem-content"))list[i].content=el.value;saveMemories(list);}));
    box.querySelectorAll(".mem-del").forEach(b=>b.onclick=()=>{list.splice(Number(b.dataset.i),1);saveMemories(list);render();});
  }
  $id("xjn-mem-add").onclick=()=>{list.push({id:String(Date.now()),title:"新记忆",content:"",enabled:true});saveMemories(list);render();};
  $id("xjn-mem-export").onclick=()=>downloadJSON("续写鸡_NEXT_长期记忆.json",list);
  render();
}

function openRP() {
  const rp=getRP(), d=getDamage();
  const fields = [
    ["currentTime","当前时间"],["location","当前位置"],["presentCharacters","在场角色"],["faction","所属势力"],
    ["knowledgeStage","知识阶段"],["bodyStatus","机体状态"],["energy","能源"],["damage","总体损伤"],
    ["processor","处理器"],["communication","通讯"],["visionMode","电子眼模式"],["currentEvent","当前事件"],["secretLock","隐藏情报锁"]
  ];
  const dfields=[["severity","严重度"],["structural","结构"],["modules","模块"],["power","能源"],["coreData","核心数据"],["memory","记忆完整性"],["processorStability","处理器稳定性"],["repairState","维修状态"],["externalRepair","外部维修"],["notes","备注"]];
  const w=modal("RP世界状态 / DAMAGE-REPAIR", `
    <h4>动态世界状态</h4><div class="xjn-grid">${fields.map(([k,n])=>`<label>${n}<input class="text_pole rp-f" data-k="${k}" value="${esc(rp[k])}"></label>`).join("")}</div>
    <h4>DAMAGE / REPAIR</h4><div class="xjn-grid">${dfields.map(([k,n])=>`<label>${n}<input class="text_pole dmg-f" data-k="${k}" value="${esc(d[k])}"></label>`).join("")}</div>
    <div class="xjn-toolbar"><button id="xjn-rp-save" class="menu_button primary">保存状态</button><button id="xjn-rp-reset" class="menu_button">恢复初始机娘状态</button></div>
  `,"xjn-wide");
  $id("xjn-rp-save").onclick=()=>{
    const a={};w.querySelectorAll(".rp-f").forEach(x=>a[x.dataset.k]=x.value);
    const b={};w.querySelectorAll(".dmg-f").forEach(x=>b[x.dataset.k]=x.value);
    setRP(a);setDamage(b);toastr.success("状态已保存","续写鸡 NEXT");
  };
  $id("xjn-rp-reset").onclick=()=>{saveJSON("rp",DEFAULT_RP);saveJSON("damage",DEFAULT_DAMAGE);w.remove();openRP();};
}

function openTemplate() {
  const s=getSettings();
  const w=modal("动态 Prompt 模板", `
    <div class="xjn-tip">支持：{{currentTime}}、{{location}} 等变量；{{#if secretLock}}...{{/if}}；{{#unless key}}...{{/unless}}；以及 &lt;%= currentTime %&gt;。</div>
    <textarea id="xjn-template" class="text_pole xjn-template">${esc(s.dynamicTemplate)}</textarea>
    <div class="xjn-toolbar"><button id="xjn-template-save" class="menu_button primary">保存模板</button><button id="xjn-template-reset" class="menu_button">恢复默认</button></div>
  `,"xjn-wide");
  $id("xjn-template-save").onclick=()=>{getSettings().dynamicTemplate=$id("xjn-template").value;saveSettingsDebounced();emit("TEMPLATE_UPDATED");toastr.success("动态模板已保存");};
  $id("xjn-template-reset").onclick=()=>{$id("xjn-template").value=DEFAULT_SETTINGS.dynamicTemplate;};
}

function downloadJSON(name,data){
  const blob=new Blob([JSON.stringify(data,null,2)],{type:"application/json"});
  const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=name;a.click();URL.revokeObjectURL(a.href);
}
function exportAll(){
  downloadJSON("续写鸡_NEXT_完整备份.json",{
    version:VERSION,scope:scopeId(),editor:editorText,rp:getRP(),damage:getDamage(),worldbook:worldbook(),memories:memories(),settings:getSettings()
  });
}
async function importAll(file){
  const x=JSON.parse(await file.text());
  if(x.editor!=null){editorText=String(x.editor);saveEditor();}
  if(x.rp)saveJSON("rp",x.rp); if(x.damage)saveJSON("damage",x.damage);
  if(Array.isArray(x.worldbook))saveWorldbook(x.worldbook);
  if(Array.isArray(x.memories))saveMemories(x.memories);
  if(x.settings){extension_settings[EXT]={...DEFAULT_SETTINGS,...x.settings};saveSettingsDebounced();}
  emit("BACKUP_IMPORTED"); renderHUD();
}

// ---------------- HUD / diagnostics ----------------
function selfCheck(){
  const c=safeContext(), s=getSettings();
  return {
    "扩展核心": true,
    "AI generateRaw": typeof c.generateRaw==="function",
    "编辑器持久化": true,
    "动态Prompt": Boolean(s.dynamicPromptEnabled),
    "事件总线": true,
    "ST事件桥": stBridgeReady,
    "内置世界书": Array.isArray(worldbook()),
    "长期记忆": Array.isArray(memories()),
    "RP状态": Boolean(getRP().knowledgeStage),
    "DAMAGE/REPAIR": Boolean(getDamage().severity),
    "HUD": Boolean($id("xjn-hud"))
  };
}
function ensureHUD(){
  if($id("xjn-hud")) return;
  const h=document.createElement("div");h.id="xjn-hud";h.innerHTML=`
    <div class="xjn-hud-head"><b>续写鸡 NEXT</b><span><button id="xjn-hud-diag">自检</button><button id="xjn-hud-hide">×</button></span></div>
    <div id="xjn-hud-state"></div>`;
  document.body.appendChild(h);
  $id("xjn-hud-hide").onclick=()=>h.classList.add("xjn-hidden");
  $id("xjn-hud-diag").onclick=openDiagnostics;
  renderHUD();
}
function renderHUD(){
  const h=$id("xjn-hud-state"); if(!h)return;
  const r=getRP(),d=getDamage();
  h.innerHTML=`<div><span>时间</span><b>${esc(r.currentTime)}</b></div><div><span>地点</span><b>${esc(r.location)}</b></div><div><span>知识</span><b>${esc(r.knowledgeStage)}</b></div><div><span>机体</span><b>${esc(r.bodyStatus)}</b></div><div><span>损伤</span><b>${esc(r.damage)}</b></div><div><span>能源</span><b>${esc(r.energy)}</b></div><div><span>电子眼</span><b>${esc(r.visionMode)}</b></div><div><span>DAMAGE</span><b>${esc(d.severity)}</b></div>`;
}
function renderDiagnostics(){
  const box=$id("xjn-diag-body"); if(!box)return;
  const checks=selfCheck(), logs=loadArray("logs").slice(-16).reverse();
  box.innerHTML=`<div class="xjn-diag-grid">${Object.entries(checks).map(([n,ok])=>`<div><span>${esc(n)}</span><b class="${ok?"ok":"bad"}">● ${ok?"正常":"异常/未连接"}</b></div>`).join("")}</div><h4>最近事件</h4><div class="xjn-log">${logs.map(x=>`<div>[${esc(x.t)}] ${esc(x.name)} <small>${esc(x.detail||"")}</small></div>`).join("")||"暂无事件"}</div>`;
}
function openDiagnostics(){
  const w=modal("系统自检 / 事件日志",`<div id="xjn-diag-body"></div><div class="xjn-toolbar"><button id="xjn-log-clear" class="menu_button">清空日志</button></div>`,"xjn-wide");
  $id("xjn-log-clear").onclick=()=>{saveArray("logs",[]);renderDiagnostics();};renderDiagnostics();
}

// ---------------- ST event bridge ----------------
function installSTBridge(){
  try{
    const c=safeContext(), source=c.eventSource, types=c.event_types||c.eventTypes||{};
    if(!source||typeof source.on!=="function"){emit("ST_EVENT_BRIDGE_UNAVAILABLE");return;}
    ["CHAT_CHANGED","MESSAGE_RECEIVED","MESSAGE_SENT","GENERATION_STARTED","GENERATION_ENDED","GENERATION_STOPPED"].forEach(n=>{
      try{source.on(types[n]||n,(...args)=>emit(`ST_${n}`,{argc:args.length}));}catch{}
    });
    stBridgeReady=true;emit("ST_EVENT_BRIDGE_READY");
  }catch(e){emit("ST_EVENT_BRIDGE_ERROR",String(e?.message||e));}
}

// ---------------- Settings UI ----------------
function settingsHtml(){
  return `<div class="xjn-settings"><div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header"><b>续写鸡 NEXT 一体化 v${VERSION}</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
    <div class="inline-drawer-content">
      <div class="xjn-settings-buttons">
        <button id="xjn-open-editor" class="menu_button primary">打开长篇编辑器</button>
        <button id="xjn-open-worldbook" class="menu_button">世界书</button>
        <button id="xjn-open-memory" class="menu_button">长期记忆</button>
        <button id="xjn-open-rp" class="menu_button">RP / DAMAGE</button>
        <button id="xjn-open-template" class="menu_button">动态Prompt</button>
        <button id="xjn-open-diag" class="menu_button">自检 / 日志</button>
      </div>
      <hr class="sysHR">
      <label class="xjn-setting"><span>自动总结</span><input id="xjn-set-autosum" type="checkbox"></label>
      <label class="xjn-setting"><span>世界书启用</span><input id="xjn-set-wb" type="checkbox"></label>
      <label class="xjn-setting"><span>动态Prompt启用</span><input id="xjn-set-dyn" type="checkbox"></label>
      <label class="xjn-setting"><span>RP状态启用</span><input id="xjn-set-rp" type="checkbox"></label>
      <label class="xjn-setting"><span>HUD显示</span><input id="xjn-set-hud" type="checkbox"></label>
      <label class="xjn-setting"><span>自动总结阈值</span><input id="xjn-set-threshold" class="text_pole" type="number" min="3000" max="100000"></label>
      <label class="xjn-setting"><span>编辑器尾部送入AI字数</span><input id="xjn-set-tail" class="text_pole" type="number" min="2000" max="100000"></label>
      <hr class="sysHR">
      <div class="xjn-settings-buttons"><button id="xjn-export-all" class="menu_button">导出完整备份</button><label class="menu_button">导入完整备份<input id="xjn-import-all" type="file" accept=".json" hidden></label></div>
    </div></div></div>`;
}
function bindSettings(){
  const s=getSettings();
  const pairs=[["xjn-set-autosum","autoSummaryEnabled"],["xjn-set-wb","worldbookEnabled"],["xjn-set-dyn","dynamicPromptEnabled"],["xjn-set-rp","rpEnabled"],["xjn-set-hud","hudEnabled"]];
  pairs.forEach(([id,k])=>{const el=$id(id);el.checked=Boolean(s[k]);el.onchange=()=>{s[k]=el.checked;saveSettingsDebounced(); if(k==="hudEnabled"){$id("xjn-hud")?.classList.toggle("xjn-hidden",!el.checked);}};});
  $id("xjn-set-threshold").value=s.autoSummaryThreshold;$id("xjn-set-threshold").onchange=e=>{s.autoSummaryThreshold=Math.max(3000,Number(e.target.value)||12000);saveSettingsDebounced();};
  $id("xjn-set-tail").value=s.maxEditorTail;$id("xjn-set-tail").onchange=e=>{s.maxEditorTail=Math.max(2000,Number(e.target.value)||12000);saveSettingsDebounced();};
  $id("xjn-open-editor").onclick=openEditor;$id("xjn-open-worldbook").onclick=openWorldbook;$id("xjn-open-memory").onclick=openMemory;$id("xjn-open-rp").onclick=openRP;$id("xjn-open-template").onclick=openTemplate;$id("xjn-open-diag").onclick=openDiagnostics;
  $id("xjn-export-all").onclick=()=>{loadEditor();exportAll();};
  $id("xjn-import-all").onchange=async e=>{try{await importAll(e.target.files[0]);toastr.success("完整备份已导入","续写鸡 NEXT");}catch(err){toastr.error(String(err.message||err),"导入失败");}};
}

// Public API for other ST scripts
window.XuXieJiNEXT = {version:VERSION,on,once,off,emit,getRP,setRP,getDamage,setDamage,worldbook,memories,renderTemplate,selfCheck,openEditor,openDiagnostics,generateContinuation};

jQuery(async()=>{
  extension_settings[EXT]={...DEFAULT_SETTINGS,...(extension_settings[EXT]||{})};
  $("#extensions_settings").append(settingsHtml());
  bindSettings(); loadEditor(); ensureHUD(); installSTBridge();
  if(!getSettings().hudEnabled)$id("xjn-hud")?.classList.add("xjn-hidden");
  emit("EXTENSION_READY",{version:VERSION,scope:scopeId()});
  console.log(`[续写鸡 NEXT] v${VERSION} loaded`);
});
