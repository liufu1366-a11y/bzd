// 续写鸡 NEXT 一体化 v1.0.0
// 全新独立扩展：不依赖旧续写鸡，不依赖 ST-Prompt-Template / Extension-ScriptEvents
import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";
import {
  getWorldInfoPrompt,
  showWorldEditor,
  updateWorldInfoList,
  world_names,
  selected_world_info,
} from "../../../world-info.js";

const EXT = "XuXieJi_NEXT";
const VERSION = "1.0.8";
const BASE_KEY = "xuxieji_next";
const $id = (id) => document.getElementById(id);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const DEFAULT_SETTINGS = {
  branchCount: 1,
  maxEditorTail: 30000,
  targetChars: 2000,
  autoSummaryEnabled: true,
  autoSummaryThreshold: 12000,
  autoSummaryTarget: 900,
  worldbookEnabled: true,
  dynamicPromptEnabled: true,
  rpEnabled: false,
  hudEnabled: true,
  hallLauncherEnabled: true,
  secretLock: true,
  systemPrompt: `你是“紧接上文”的长篇小说续写引擎。
第一优先级是连续性，而不是自由创作。

硬性要求：
1. 必须从【续写锚点】最后一句发生的时间、地点、人物、动作和叙事视角直接往后写。
2. 不得重启故事、另起一个无关开场、重复前文、突然切换主角、突然跳到另一条时间线。
3. 除非“本次定向要求”明确要求，否则不得自行写“本章完/第一章完/第二天/多年后”等跳章或大时间跳跃。
4. 人物身份、称呼、关系、能力、伤势、物品、地点必须与上文和记忆一致。
5. 遇到上文信息不足时，优先保持模糊和连续，不得擅自创造会推翻上文的新设定。
6. 禁止无原因恢复损伤、关系或资源。
7. 当存在冲突设定时保留冲突，不擅自统一。
只输出续写正文，不解释创作过程。`,
  dynamicTemplate: `【动态故事状态】
当前时间：{{currentTime}}
当前位置：{{location}}
在场角色：{{presentCharacters}}
阵营/组织：{{faction}}
知识阶段：{{knowledgeStage}}
角色状态：{{characterStatus}}
资源状态：{{resourceStatus}}
当前事件：{{currentEvent}}
隐藏情报锁：{{secretLock}}

{{#if secretLock}}
严格遵守角色当前已经知道的信息，不得提前泄露尚未获知的设定。
{{/if}}

连续性规则：
- 必须承接上文已经明确的人物、地点、关系、资源与事件。
- 不得凭空改变角色身份、状态或关系。
- 信息不足时保持模糊，不得创造会推翻上文的新设定。`
};

const DEFAULT_RP = {
  currentTime: "未知",
  location: "未知",
  presentCharacters: "",
  faction: "",
  knowledgeStage: "默认",
  characterStatus: "",
  resourceStatus: "",
  currentEvent: "",
  secretLock: "ON"
};

const DEFAULT_DAMAGE = {
  severity: "",
  structural: "",
  modules: "",
  power: "",
  coreData: "",
  memory: "",
  processorStability: "",
  repairState: "",
  externalRepair: "",
  notes: ""
};

let editorText = "";
let editorDirty = false;
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
  // 通用核心不再内置《变身机娘》或任何特定作品设定。
  // 特定作品的状态/损伤规则应由对应世界书或项目预设提供。
  return "";
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


// ---------------- SillyTavern 原生世界书 ----------------
async function getNativeWorldInfoBlock(sourceText) {
  const settings = getSettings();
  if (!settings.worldbookEnabled) return "";

  try {
    // World Info 扫描的数组按“距离最新消息的深度”组织。
    // 把最接近续写点的文本放在第一个元素。
    const text = String(sourceText || "");
    const latest = text.slice(-5000);
    const older = text.length > 5000 ? text.slice(-20000, -5000) : "";
    const scanChat = [latest, older].filter(Boolean);

    const result = await getWorldInfoPrompt(
      scanChat,
      32768,
      true,
      {
        trigger: "normal",
        personaDescription: "",
        characterDescription: "",
        characterPersonality: "",
        characterDepthPrompt: "",
        scenario: "",
        creatorNotes: "",
      }
    );

    const parts = [
      result?.worldInfoBefore,
      result?.worldInfoAfter,
      result?.worldInfoString,
      ...(Array.isArray(result?.anBefore) ? result.anBefore : []),
      ...(Array.isArray(result?.anAfter) ? result.anAfter : []),
    ].filter(Boolean);

    const unique = [...new Set(parts.map(x => String(x).trim()).filter(Boolean))];
    if (!unique.length) {
      emit("NATIVE_WORLDBOOK_SCAN", { activeBooks: selected_world_info?.length || 0, matched: 0 });
      return "";
    }

    emit("NATIVE_WORLDBOOK_SCAN", {
      activeBooks: selected_world_info?.length || 0,
      matched: unique.length,
    });
    return `【SillyTavern 原生世界书触发内容】\n${unique.join("\n\n")}`;
  } catch (e) {
    emit("NATIVE_WORLDBOOK_ERROR", String(e?.message || e));
    console.warn("[续写鸡 NEXT] 原生世界书扫描失败", e);
    return "";
  }
}

async function openNativeWorldbook() {
  try {
    await updateWorldInfoList();

    const names = Array.isArray(world_names) ? world_names : [];
    if (!names.length) {
      toastr.warning("酒馆里目前没有世界书。请先在 SillyTavern 的世界书功能里新建或导入一本。", "续写鸡 NEXT");
      return;
    }

    const active = Array.isArray(selected_world_info) ? selected_world_info : [];
    const body = `
      <div class="xjn-tip">
        这里不再使用续写鸡自制的“简化世界书”。下面列出的是真正的 SillyTavern World Info / Lorebook。
        打开后使用酒馆自己的世界书编辑器，因此关键词、常驻、位置、顺序、递归等都由酒馆原生系统处理。
      </div>
      <div class="xjn-native-wb-list">
        ${names.map(name => `
          <button type="button" class="menu_button xjn-native-wb-open" data-name="${esc(name)}">
            ${active.includes(name) ? "● " : ""}${esc(name)}
          </button>
        `).join("")}
      </div>
    `;
    const page = modal("SillyTavern 原生世界书", body, "xjn-wide");
    page.querySelectorAll(".xjn-native-wb-open").forEach(btn => {
      btn.onclick = async () => {
        const name = btn.dataset.name;
        page.remove();
        await showWorldEditor(name);
      };
    });
  } catch (e) {
    console.error(e);
    toastr.error(String(e?.message || e), "打开原生世界书失败");
  }
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
async function promptBundle(direction="") {
  const s = getSettings();
  const rp = getRP();

  const maxTail = Math.max(6000, Number(s.maxEditorTail) || 30000);
  const contextTail = editorText.slice(-maxTail);
  const anchorText = editorText.slice(-Math.min(3500, Math.max(1200, Math.floor(maxTail * 0.2))));
  const lastLine = editorText.trim().split(/\n+/).filter(Boolean).slice(-1)[0] || "";

  const dynamic = s.dynamicPromptEnabled ? renderTemplate(s.dynamicTemplate, rp) : "";
  const nativeWorld = await getNativeWorldInfoBlock(`${contextTail}\n${direction}\n${JSON.stringify(rp)}`);

  const blocks = [
    s.systemPrompt,
    memoryBlock(),
    nativeWorld,
    s.rpEnabled ? dynamic : "",
    ""
  ].filter(Boolean);

  const target = Math.max(200, Math.min(20000, Number(s.targetChars) || 2000));
  const low = Math.max(150, Math.floor(target * 0.90));
  const high = Math.ceil(target * 1.10);

  return {
    systemPrompt: blocks.join("\n\n"),
    prompt: `【连续正文上下文】
${contextTail || "（暂无正文）"}

【续写锚点｜最高优先级】
下面这段是当前正文真正的末尾。必须从它的最后一句直接继续，不能换故事、不能重开场景：
${anchorText || "（暂无）"}

【当前最后一句】
${lastLine || "（暂无）"}

【本次定向要求】
${direction || "紧接最后一句自然续写，不跳时间，不换主角，不另起无关情节。"}

【长度要求】
本次目标约 ${target} 个中文字符，尽量控制在 ${low}-${high} 字之间。
如果剧情在目标长度附近尚未自然结束，可以停在一个仍能继续续写的句末，不要为了凑长度强行写“本章完”。

只输出新增的续写正文，不得重复【连续正文上下文】已有内容。`,
    targetChars: target
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
    const p = await promptBundle(direction);
    emit("GENERATION_STARTED", {
      promptLength: p.prompt.length,
      systemLength: p.systemPrompt.length,
      targetChars: p.targetChars
    });
    emit("PROMPT_INJECTED", {
      source: "native-world-info",
      activeBooks: selected_world_info?.length || 0
    });
    const raw = await c.generateRaw({
      systemPrompt: p.systemPrompt,
      prompt: p.prompt,
      stream: false,
      max_tokens: Math.max(384, Math.ceil(p.targetChars * 1.6))
    });
    const text = extractText(raw);
    if (!text) throw new Error("AI返回为空");
    editorText = [editorText.trimEnd(), text].filter(Boolean).join("\n\n");
    editorDirty = true;
    emit("GENERATION_FINISHED", {length:text.length, saved:false});
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


// ---------------- TXT 导入 / 章节定位 ----------------
function detectImportedChapters(text) {
  const source = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const re = /^\s*(第\s*[0-9零〇一二两三四五六七八九十百千万]+\s*[章节卷回集部篇][^\n]*|Chapter\s+\d+[^\n]*|\d+\s*[、.．]\s*[^\n]+)\s*$/gim;
  const marks = [];
  let m;
  while ((m = re.exec(source)) !== null) {
    marks.push({ title: m[1].trim(), start: m.index });
  }
  if (!marks.length) return [{ title:"全文", start:0, end:source.length }];
  return marks.map((x,i)=>({
    title:x.title,
    start:x.start,
    end:i+1<marks.length ? marks[i+1].start : source.length
  }));
}

function saveImportedBook(name, text) {
  const data = {
    name: name || "未命名.txt",
    text: String(text || ""),
    chapters: detectImportedChapters(text),
    importedAt: Date.now()
  };
  localStorage.setItem(key("imported_book"), JSON.stringify(data));
  return data;
}

function loadImportedBook() {
  try {
    const raw = localStorage.getItem(key("imported_book"));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function importTxtFile(file) {
  if (!file) return;
  const text = await file.text();
  const book = saveImportedBook(file.name, text);
  editorText = book.text;
  editorDirty = true;
  localStorage.setItem(key("summary_checkpoint"), "0");
  toastr.success(`已导入 ${file.name}，识别到 ${book.chapters.length} 个章节/分段`, "续写鸡 NEXT");
  return book;
}

function openChapterNavigator(screen, ta) {
  const book = loadImportedBook();
  if (!book || !Array.isArray(book.chapters) || !book.chapters.length) {
    toastr.warning("请先导入TXT小说。", "章节定位");
    return;
  }
  const body = `
    <div class="xjn-tip">
      原始导入文件：${esc(book.name)}。选择“从此章末续写”后，编辑器会保留从开头到该章末尾的正文，
      后面的原文不会丢失，仍保存在“导入原书备份”里。
    </div>
    <input id="xjn-chapter-search" class="text_pole" placeholder="搜索章节名">
    <div id="xjn-chapter-list" class="xjn-chapter-list"></div>
  `;
  const page = modal("章节定位 / 从任意章节续写", body, "xjn-wide");
  const box = page.querySelector("#xjn-chapter-list");
  const search = page.querySelector("#xjn-chapter-search");

  function render(filter="") {
    const q = String(filter || "").trim().toLowerCase();
    const rows = book.chapters
      .map((ch,i)=>({ch,i}))
      .filter(x => !q || String(x.ch.title).toLowerCase().includes(q));
    box.innerHTML = rows.map(({ch,i})=>`
      <div class="xjn-chapter-row">
        <div class="xjn-chapter-name"><b>${i+1}.</b> ${esc(ch.title)}</div>
        <button class="menu_button xjn-chapter-use" data-i="${i}">从此章末续写</button>
      </div>
    `).join("") || `<div class="xjn-empty">没有匹配章节。</div>`;

    box.querySelectorAll(".xjn-chapter-use").forEach(btn=>{
      btn.onclick=()=>{
        const i=Number(btn.dataset.i);
        const ch=book.chapters[i];
        if(!ch)return;
        editorText = book.text.slice(0, ch.end).trimEnd();
        editorDirty = true;
        if (ta) {
          ta.value = editorText;
          ta.scrollTop = ta.scrollHeight;
        }
        renderEditor();
        page.remove();
        toastr.success(`已定位到：${ch.title}。下一次生成将从这一章末尾继续。`, "章节定位");
      };
    });
  }
  search.addEventListener("input",()=>render(search.value));
  render();
}

function restoreImportedBook(ta) {
  const book = loadImportedBook();
  if (!book) {
    toastr.warning("还没有导入过TXT原书。", "续写鸡 NEXT");
    return;
  }
  editorText = book.text;
  editorDirty = true;
  if (ta) {
    ta.value = editorText;
    ta.scrollTop = ta.scrollHeight;
  }
  renderEditor();
  toastr.success("已载入最近一次导入的完整原文（尚未正式保存）。", "续写鸡 NEXT");
}


function getEditorAppearance() {
  try {
    return {
      theme: "dark",
      fontSize: 18,
      lineHeight: 1.75,
      fontFamily: "system-ui",
      ...(JSON.parse(localStorage.getItem(key("editor_appearance")) || "{}"))
    };
  } catch {
    return { theme:"dark", fontSize:18, lineHeight:1.75, fontFamily:"system-ui" };
  }
}

function applyEditorAppearance(screen) {
  if (!screen) return;
  const a = getEditorAppearance();
  const themes = {
    dark: { bg:"#151515", panel:"#111111", text:"#eeeeee" },
    warm: { bg:"#efe7cf", panel:"#f5eedc", text:"#2d281f" },
    paper: { bg:"#f7f3e8", panel:"#fffdf7", text:"#28251f" },
    gray: { bg:"#25272a", panel:"#1f2022", text:"#e7e7e7" }
  };
  const t = themes[a.theme] || themes.dark;
  screen.style.setProperty("--xjn-reader-bg", t.bg);
  screen.style.setProperty("--xjn-reader-panel", t.panel);
  screen.style.setProperty("--xjn-reader-text", t.text);
  screen.style.setProperty("--xjn-reader-font-size", `${Math.max(14,Math.min(36,Number(a.fontSize)||18))}px`);
  screen.style.setProperty("--xjn-reader-line-height", String(Math.max(1.2,Math.min(2.5,Number(a.lineHeight)||1.75))));
  screen.style.setProperty("--xjn-reader-font-family", a.fontFamily || "system-ui");
}

function openAppearance(screen) {
  const a = getEditorAppearance();
  const w = modal("背景 / 字体", `
    <div class="xjn-grid">
      <label>背景
        <select id="xjn-ap-theme" class="text_pole">
          <option value="dark">深色</option>
          <option value="warm">护眼米黄</option>
          <option value="paper">纸张白</option>
          <option value="gray">深灰</option>
        </select>
      </label>
      <label>字体
        <select id="xjn-ap-font" class="text_pole">
          <option value="system-ui">系统字体</option>
          <option value="serif">衬线 / 小说阅读</option>
          <option value="sans-serif">无衬线</option>
          <option value="monospace">等宽</option>
        </select>
      </label>
      <label>字号
        <input id="xjn-ap-size" class="text_pole" type="number" min="14" max="36" value="${Number(a.fontSize)||18}">
      </label>
      <label>行距
        <input id="xjn-ap-line" class="text_pole" type="number" min="1.2" max="2.5" step="0.05" value="${Number(a.lineHeight)||1.75}">
      </label>
    </div>
    <div class="xjn-toolbar">
      <button id="xjn-ap-save" class="menu_button primary">应用并保存</button>
    </div>
  `,"xjn-wide");
  w.querySelector("#xjn-ap-theme").value = a.theme;
  w.querySelector("#xjn-ap-font").value = a.fontFamily;
  w.querySelector("#xjn-ap-save").onclick=()=>{
    const next={
      theme:w.querySelector("#xjn-ap-theme").value,
      fontFamily:w.querySelector("#xjn-ap-font").value,
      fontSize:Number(w.querySelector("#xjn-ap-size").value)||18,
      lineHeight:Number(w.querySelector("#xjn-ap-line").value)||1.75
    };
    localStorage.setItem(key("editor_appearance"), JSON.stringify(next));
    applyEditorAppearance(screen);
    w.remove();
  };
}

// ---------------- Editor ----------------
function loadEditor() { editorText = localStorage.getItem(key("editor")) || ""; }
function saveEditor() {
  localStorage.setItem(key("editor"), editorText);
  editorDirty = false;
  emit("EDITOR_SAVED", {length:editorText.length});
  renderEditor();
}
function renderEditor() {
  const ta = $id("xjn-editor-text");
  if (ta && ta.value !== editorText) ta.value = editorText;
  const wc = $id("xjn-word-count");
  if (wc) wc.textContent = `${editorText.length.toLocaleString()} 字${editorDirty ? " · 未保存" : " · 已保存"}`;
}
function updateBusy() {
  const b = $id("xjn-generate");
  if (b) { b.disabled = busy; b.textContent = busy ? "生成中…" : "开始续写"; }
}

// ---------------- UI helpers ----------------
function esc(s) { return String(s??"").replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function modal(title, body, cls="") {
  document.querySelectorAll(".xjn-page-screen").forEach(x => x.remove());
  const wrap = document.createElement("div");
  wrap.className = `xjn-page-screen ${cls || ""}`;
  wrap.innerHTML = `
    <div class="xjn-page-topbar">
      <button type="button" class="menu_button xjn-close">← 返回</button>
      <b class="xjn-page-title">${esc(title)}</b>
      <span></span>
    </div>
    <div class="xjn-page-body">${body}</div>`;
  document.body.appendChild(wrap);
  wrap.querySelector(".xjn-close").onclick = () => wrap.remove();
  return wrap;
}

function openEditor() {
  loadEditor();

  // 手机端完全避开 SillyTavern modal/flex 布局，使用独立全屏层。
  document.querySelectorAll(".xjn-editor-screen").forEach(x => x.remove());

  const screen = document.createElement("div");
  screen.className = "xjn-editor-screen";
  screen.innerHTML = `
    <div class="xjn-editor-topbar">
      <button id="xjn-editor-back" class="menu_button">返回</button>
      <div class="xjn-editor-title-wrap">
        <b>续写鸡 NEXT</b>
        <small id="xjn-word-count">0 字</small>
      </div>
      <button id="xjn-save" class="menu_button">保存</button>
    </div>

    <div class="xjn-editor-actions">
      <button id="xjn-generate" class="menu_button primary">开始续写</button>
      <label class="menu_button xjn-file-button">导入TXT<input id="xjn-import-txt" type="file" accept=".txt,text/plain" hidden></label>
      <button id="xjn-chapters" class="menu_button">章节定位</button>
      <button id="xjn-appearance" class="menu_button">背景/字体</button>
      <button id="xjn-summary" class="menu_button">总结正文</button>
      <button id="xjn-export" class="menu_button">导出TXT</button>
      <button id="xjn-restore-import" class="menu_button">恢复导入原文</button>
      <label class="xjn-length-inline">本次字数
        <input id="xjn-editor-target-chars" class="text_pole" type="number" min="200" max="20000" step="100">
      </label>
    </div>

    <div id="xjn-save-policy" class="xjn-save-policy">只有点击右上角“保存”才会写入正式正文；生成、导入、章节定位都不会自动保存。</div>
    <div class="xjn-editor-main">
      <div class="xjn-editor-caption">正文编辑区</div>
      <textarea id="xjn-editor-text" class="text_pole xjn-editor-full" placeholder="在这里输入、粘贴或续写小说正文……"></textarea>

      <div class="xjn-editor-caption">本次定向要求</div>
      <textarea id="xjn-direction" class="text_pole xjn-direction-full" placeholder="例如：继续当前场景，不跳时间；保持当前人物视角和语气。"></textarea>
    </div>
  `;
  document.body.appendChild(screen);

  const ta = $id("xjn-editor-text");
  ta.value = editorText;
  const targetInput = $id("xjn-editor-target-chars");
  if (targetInput) targetInput.value = getSettings().targetChars || 2000;
  applyEditorAppearance(screen);

  $id("xjn-import-txt").onchange = async (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    await importTxtFile(file);
    ta.value = editorText;
    ta.scrollTop = ta.scrollHeight;
    renderEditor();
    ev.target.value = "";
  };
  $id("xjn-chapters").onclick = () => openChapterNavigator(screen, ta);
  $id("xjn-appearance").onclick = () => openAppearance(screen);
  $id("xjn-restore-import").onclick = () => restoreImportedBook(ta);

  function closeEditorScreen() {
    editorText = ta.value;
    if (editorDirty) {
      const ok = window.confirm("当前正文有未保存修改。\n\n确定返回并丢弃这些未保存修改吗？");
      if (!ok) return;
      // 丢弃未保存内容，恢复最后一次正式保存的正文。
      loadEditor();
      editorDirty = false;
    }
    screen.remove();
  }

  $id("xjn-editor-back").onclick = closeEditorScreen;
  $id("xjn-save").onclick = () => {
    editorText = ta.value;
    saveEditor();
    toastr.success("正文已正式保存", "续写鸡 NEXT");
  };

  ta.addEventListener("input", () => {
    editorText = ta.value;
    editorDirty = true;
    renderEditor();
  });

  $id("xjn-generate").onclick = async () => {
    editorText = ta.value;
    editorDirty = true;
    if (targetInput) {
      getSettings().targetChars = Math.max(200, Math.min(20000, Number(targetInput.value) || 2000));
      saveSettingsDebounced();
    }
    await generateContinuation($id("xjn-direction").value);
    if ($id("xjn-editor-text")) {
      $id("xjn-editor-text").value = editorText;
      $id("xjn-editor-text").scrollTop = $id("xjn-editor-text").scrollHeight;
    }
  };

  $id("xjn-summary").onclick = async () => {
    try {
      editorText = ta.value;
      editorDirty = true;
      await summarizeText(editorText, `手动总结 ${new Date().toLocaleString()}`);
      toastr.success("总结已加入长期记忆", "续写鸡 NEXT");
    } catch (e) {
      toastr.error(String(e.message || e), "总结失败");
    }
  };

  $id("xjn-export").onclick = () => {
    editorText = ta.value;
    const blob = new Blob([editorText], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "续写鸡_NEXT_正文.txt";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  renderEditor();
  updateBusy();

  // 打开后直接滚到正文末尾，方便继续写。
  requestAnimationFrame(() => {
    ta.scrollTop = ta.scrollHeight;
    ta.focus({ preventScroll: true });
  });
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
  const state = getRP();
  const fields = [
    ["currentTime","当前时间"],["location","当前位置"],["presentCharacters","在场角色"],
    ["faction","阵营/组织"],["knowledgeStage","知识阶段"],["characterStatus","角色状态"],
    ["resourceStatus","资源状态"],["currentEvent","当前事件"],["secretLock","隐藏情报锁"]
  ];
  const w = modal("动态故事状态", `
    <div class="xjn-tip">这里是通用状态，不预置任何小说、角色或机体设定。留空也可以。</div>
    <div class="xjn-grid">
      ${fields.map(([k,n])=>`<label>${n}<input class="text_pole rp-f" data-k="${k}" value="${esc(state[k] || "")}"></label>`).join("")}
    </div>
    <div class="xjn-toolbar">
      <button id="xjn-rp-save" class="menu_button primary">保存状态</button>
      <button id="xjn-rp-reset" class="menu_button">清空状态</button>
    </div>
  `,"xjn-wide");
  $id("xjn-rp-save").onclick=()=>{
    const next={};
    w.querySelectorAll(".rp-f").forEach(x=>next[x.dataset.k]=x.value);
    setRP(next);
    toastr.success("状态已保存","续写鸡 NEXT");
  };
  $id("xjn-rp-reset").onclick=()=>{
    saveJSON("rp", DEFAULT_RP);
    w.remove();
    openRP();
  };
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
    "酒馆原生世界书API": typeof getWorldInfoPrompt === "function",
    "当前全局世界书": Array.isArray(selected_world_info),
    "长期记忆": Array.isArray(memories()),
    "动态状态": Boolean(getRP().knowledgeStage),
    "通用动态状态": Boolean(getRP()),
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
  const r=getRP();
  const rows = [
    ["时间", r.currentTime],["地点", r.location],["知识", r.knowledgeStage],
    ["角色", r.presentCharacters],["阵营", r.faction],["状态", r.characterStatus],
    ["资源", r.resourceStatus],["事件", r.currentEvent]
  ].filter(([,v]) => String(v || "").trim());
  h.innerHTML = rows.length
    ? rows.map(([k,v])=>`<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join("")
    : `<div><span>状态</span><b>未设置</b></div>`;
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


function ensureHallLauncher() {
  let btn = document.getElementById("xjn-hall-launcher");
  if (btn) return;

  const POS_KEY = `${BASE_KEY}__hall_launcher_position`;
  btn = document.createElement("button");
  btn.id = "xjn-hall-launcher";
  btn.type = "button";
  btn.className = "xjn-hall-launcher";
  btn.title = "拖动可移动；轻点打开续写鸡 NEXT";
  btn.setAttribute("aria-label", "续写鸡 NEXT，可拖动移动位置，轻点打开");
  btn.innerHTML = `<span class="xjn-hall-icon">✦</span><span class="xjn-hall-text">续写鸡</span>`;
  document.body.appendChild(btn);

  function clampPosition(left, top) {
    const rect = btn.getBoundingClientRect();
    const margin = 6;
    const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
    const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
    return {
      left: Math.min(Math.max(margin, left), maxLeft),
      top: Math.min(Math.max(margin, top), maxTop),
    };
  }

  function applyPosition(left, top, save = false) {
    const p = clampPosition(left, top);
    btn.style.left = `${p.left}px`;
    btn.style.top = `${p.top}px`;
    btn.style.right = "auto";
    btn.style.bottom = "auto";
    if (save) {
      try {
        localStorage.setItem(POS_KEY, JSON.stringify(p));
      } catch {}
    }
  }

  // 恢复用户上次拖动的位置。
  requestAnimationFrame(() => {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(POS_KEY) || "null");
    } catch {}
    if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
      applyPosition(saved.left, saved.top, false);
    } else {
      const rect = btn.getBoundingClientRect();
      applyPosition(
        window.innerWidth - rect.width - 12,
        window.innerHeight - rect.height - 82,
        false
      );
    }
  });

  let dragging = false;
  let moved = false;
  let pointerId = null;
  let grabX = 0;
  let grabY = 0;
  let startX = 0;
  let startY = 0;

  btn.addEventListener("pointerdown", (ev) => {
    if (ev.button != null && ev.button !== 0) return;
    const rect = btn.getBoundingClientRect();
    dragging = true;
    moved = false;
    pointerId = ev.pointerId;
    grabX = ev.clientX - rect.left;
    grabY = ev.clientY - rect.top;
    startX = ev.clientX;
    startY = ev.clientY;
    btn.classList.add("xjn-dragging");
    try { btn.setPointerCapture(pointerId); } catch {}
  });

  btn.addEventListener("pointermove", (ev) => {
    if (!dragging || ev.pointerId !== pointerId) return;
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (Math.hypot(dx, dy) > 6) moved = true;
    if (!moved) return;

    ev.preventDefault();
    applyPosition(ev.clientX - grabX, ev.clientY - grabY, false);
  });

  function finishDrag(ev) {
    if (!dragging || (ev.pointerId != null && ev.pointerId !== pointerId)) return;
    dragging = false;
    btn.classList.remove("xjn-dragging");

    const rect = btn.getBoundingClientRect();
    if (moved) {
      applyPosition(rect.left, rect.top, true);
      // 防止拖动结束时误触发 click 打开编辑器。
      btn.dataset.suppressClick = "1";
      setTimeout(() => { delete btn.dataset.suppressClick; }, 180);
    }
    try { btn.releasePointerCapture(pointerId); } catch {}
    pointerId = null;
  }

  btn.addEventListener("pointerup", finishDrag);
  btn.addEventListener("pointercancel", finishDrag);

  btn.addEventListener("click", (ev) => {
    if (btn.dataset.suppressClick === "1" || moved) {
      ev.preventDefault();
      moved = false;
      return;
    }
    openEditor();
  });

  // 屏幕旋转/浏览器尺寸变化时，保证按钮不会跑到屏幕外。
  window.addEventListener("resize", () => {
    const rect = btn.getBoundingClientRect();
    applyPosition(rect.left, rect.top, false);
  });
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
        <button id="xjn-open-rp" class="menu_button">动态状态</button>
        <button id="xjn-open-template" class="menu_button">动态Prompt</button>
        <button id="xjn-open-diag" class="menu_button">自检 / 日志</button>
      </div>
      <hr class="sysHR">
      <label class="xjn-setting"><span>自动总结</span><input id="xjn-set-autosum" type="checkbox"></label>
      <label class="xjn-setting"><span>世界书启用</span><input id="xjn-set-wb" type="checkbox"></label>
      <label class="xjn-setting"><span>动态Prompt启用</span><input id="xjn-set-dyn" type="checkbox"></label>
      <label class="xjn-setting"><span>动态状态启用</span><input id="xjn-set-rp" type="checkbox"></label>
      <label class="xjn-setting"><span>HUD显示</span><input id="xjn-set-hud" type="checkbox"></label>
      <label class="xjn-setting"><span>默认每次续写字数</span><input id="xjn-set-targetchars" class="text_pole" type="number" min="200" max="20000" step="100"></label>
      <label class="xjn-setting"><span>自动总结阈值</span><input id="xjn-set-threshold" class="text_pole" type="number" min="3000" max="100000"></label>
      <label class="xjn-setting"><span>连续正文送入AI字数</span><input id="xjn-set-tail" class="text_pole" type="number" min="6000" max="100000"></label>
      <hr class="sysHR">
      <div class="xjn-settings-buttons"><button id="xjn-export-all" class="menu_button">导出完整备份</button><label class="menu_button">导入完整备份<input id="xjn-import-all" type="file" accept=".json" hidden></label></div>
    </div></div></div>`;
}
function bindSettings(){
  const s=getSettings();
  const pairs=[["xjn-set-autosum","autoSummaryEnabled"],["xjn-set-wb","worldbookEnabled"],["xjn-set-dyn","dynamicPromptEnabled"],["xjn-set-rp","rpEnabled"],["xjn-set-hud","hudEnabled"]];
  pairs.forEach(([id,k])=>{const el=$id(id);el.checked=Boolean(s[k]);el.onchange=()=>{s[k]=el.checked;saveSettingsDebounced(); if(k==="hudEnabled"){$id("xjn-hud")?.classList.toggle("xjn-hidden",!el.checked);}};});
  $id("xjn-set-targetchars").value=s.targetChars || 2000;
  $id("xjn-set-targetchars").onchange=e=>{s.targetChars=Math.max(200,Math.min(20000,Number(e.target.value)||2000));saveSettingsDebounced();};
  $id("xjn-set-threshold").value=s.autoSummaryThreshold;$id("xjn-set-threshold").onchange=e=>{s.autoSummaryThreshold=Math.max(3000,Number(e.target.value)||12000);saveSettingsDebounced();};
  $id("xjn-set-tail").value=s.maxEditorTail;$id("xjn-set-tail").onchange=e=>{s.maxEditorTail=Math.max(6000,Number(e.target.value)||30000);saveSettingsDebounced();};
  $id("xjn-open-editor").onclick=openEditor;$id("xjn-open-worldbook").onclick=openNativeWorldbook;$id("xjn-open-memory").onclick=openMemory;$id("xjn-open-rp").onclick=openRP;$id("xjn-open-template").onclick=openTemplate;$id("xjn-open-diag").onclick=openDiagnostics;
  $id("xjn-export-all").onclick=()=>{loadEditor();exportAll();};
  $id("xjn-import-all").onchange=async e=>{try{await importAll(e.target.files[0]);toastr.success("完整备份已导入","续写鸡 NEXT");}catch(err){toastr.error(String(err.message||err),"导入失败");}};
}

// Public API for other ST scripts
window.XuXieJiNEXT = {version:VERSION,on,once,off,emit,getRP,setRP,getDamage,setDamage,worldbook,memories,renderTemplate,selfCheck,openEditor,openDiagnostics,generateContinuation};

jQuery(async()=>{
  extension_settings[EXT]={...DEFAULT_SETTINGS,...(extension_settings[EXT]||{})};
  if (!extension_settings[EXT]._v104Migrated) {
    extension_settings[EXT].maxEditorTail = Math.max(30000, Number(extension_settings[EXT].maxEditorTail) || 0);
    extension_settings[EXT].targetChars = Number(extension_settings[EXT].targetChars) || 2000;
    extension_settings[EXT]._v104Migrated = true;
    saveSettingsDebounced();
  }
  if (!extension_settings[EXT]._v105GenericMigrated) {
    // 旧版曾把《变身机娘》状态写进通用核心；升级时默认关闭这些专用注入。
    extension_settings[EXT].rpEnabled = false;
    extension_settings[EXT].damageEnabled = false;
    extension_settings[EXT]._v105GenericMigrated = true;
    saveSettingsDebounced();
    try {
      const old = getRP();
      const looksMachinePreset =
        String(old?.PRESENT_CHARACTERS || "").includes("苏若") ||
        String(old?.PLAYER_KNOWLEDGE || "").includes("SURO-") ||
        String(old?.MECHA_STATUS || "").length > 0;
      if (looksMachinePreset) {
        localStorage.setItem(rpKey(), JSON.stringify(DEFAULT_RP));
      }
    } catch {}
  }
  if (!extension_settings[EXT]._v107CleanGeneric) {
    // 清除早期版本误写进通用核心的专用作品状态/模板。
    extension_settings[EXT].dynamicTemplate = DEFAULT_SETTINGS.dynamicTemplate;
    extension_settings[EXT].rpEnabled = false;
    extension_settings[EXT]._v107CleanGeneric = true;
    saveSettingsDebounced();

    try {
      localStorage.removeItem(key("rp"));
      localStorage.removeItem(key("damage"));
      // 只移除明显由旧专用预设污染的记忆条目，不碰普通小说记忆。
      const cleanMem = memories().filter(item => {
        const text = `${item?.title || ""}\n${item?.content || ""}`;
        return !/(SURO-K0|SURO-|苏若|电子眼|辅助CPU|主动金属自修复|DAMAGE\s*\/\s*REPAIR)/i.test(text);
      });
      saveArray("memories", cleanMem);
    } catch {}
  }
  $("#extensions_settings").append(settingsHtml());
  ensureHallLauncher();
  bindSettings(); loadEditor(); ensureHUD(); installSTBridge();
  if(!getSettings().hudEnabled)$id("xjn-hud")?.classList.add("xjn-hidden");
  emit("EXTENSION_READY",{version:VERSION,scope:scopeId()});
  console.log(`[续写鸡 NEXT] v${VERSION} loaded`);
});
