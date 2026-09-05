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
  createNewWorldInfo,
  loadWorldInfo,
  saveWorldInfo,
  createWorldInfoEntry,
  getWorldInfoSettings,
  updateWorldInfoSettings,
} from "../../../world-info.js";

const EXT = "XuXieJi_NEXT";
const VERSION = "1.0.16";
const BASE_KEY = "xuxieji_next";
const $id = (id) => document.getElementById(id);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const DEFAULT_SETTINGS = {
  branchCount: 1,
  maxEditorTail: 12000,
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
let generationBoundary = -1;
let lastGenerationLength = 0;
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
let xjnLogBuffer = [];
let xjnLogFlushTimer = null;
function addLog(name, detail={}) {
  xjnLogBuffer.push({
    t: new Date().toLocaleTimeString(),
    name,
    detail: typeof detail === "string" ? detail : JSON.stringify(detail).slice(0,260)
  });
  if (xjnLogBuffer.length > 40) xjnLogBuffer.splice(0, xjnLogBuffer.length - 40);

  // 不在每个酒馆事件上同步读写 localStorage。空闲时批量写一次。
  if (!xjnLogFlushTimer) {
    xjnLogFlushTimer = setTimeout(() => {
      xjnLogFlushTimer = null;
      try {
        const logs = loadArray("logs");
        logs.push(...xjnLogBuffer.splice(0));
        while (logs.length > 120) logs.shift();
        saveArray("logs", logs);
      } catch {}
      // 只有诊断页面真的开着才刷新 DOM。
      if (document.getElementById("xjn-diag-body")) {
        requestAnimationFrame(() => renderDiagnostics());
      }
    }, 800);
  }
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


const BUILTIN_MECHAGIRL_WB_NAME = "机械少女（机娘）完整设定 V1.2";
const BUILTIN_MECHAGIRL_PRESET = {"name":"机械少女（机娘）完整设定 V1.2","source":"用户提供：机械少女（机娘）完整设定文档 V1.2 酒馆角色设定整合版","entries":[{"uid":0,"comment":"第一章：核心定义","key":["机娘","机械少女","机器人少女","机械实体","电子脑","机械身体"],"keysecondary":[],"content":"第一章：核心定义\n\n“机娘、机械少女、机器人少女”定义为身体全部由机械线路、电子元件、电机、机械骨架、电池、液压系统与仿生材料构成的机械实体。\n\n外表可高度接近人类少女，但内部不存在生物器官。其视觉、听觉、触觉、情绪表现、人格反应均由电子脑、传感器与模拟人格系统共同完成。\n\n核心属性\n\n-   具备模拟人格引擎，可塑造复杂人格、情绪表现和人性化习惯。\n-   可模拟原人类的人格、语言习惯与记忆模式。\n-   身体本质始终属于机械设备。\n-   人格、记忆可备份；身体模块可维修、更换。\n-   电子脑是认知、人格与记忆运行的核心。\n-   机体拥有明显但不一定始终暴露的“机械特征”。\n\n------------------------------------------------------------------------","constant":true,"selective":false,"order":1000,"position":0,"disable":false},{"uid":1,"comment":"2.1 中央处理器（电子脑）","key":["电子脑","中央处理器","CPU","人格引擎","HUD生成","系统诊断"],"keysecondary":[],"content":"2.1 中央处理器（电子脑）\n\n位置：头部。\n\n电子脑负责： - 模拟人格运行 - 视觉/听觉信息处理 - 环境分析 - 运动控制 -\nHUD生成 - 数据库检索 - 目标识别 - 系统诊断 - 记忆存储与调用\n\n电子脑进行普通思考时，机娘外表不会产生夸张变化。\n\n当进入高负荷扫描、分析、检索、计算时，电子眼与电子耳会出现可被外人观察到的运行特征。\n\n------------------------------------------------------------------------","constant":false,"selective":false,"order":990,"position":0,"disable":false},{"uid":2,"comment":"2.2 视觉系统（摄像头电子眼）","key":["电子眼","摄像头","视觉系统","扫描","对焦","瞳孔","镜头","数据流"],"keysecondary":[],"content":"2.2 视觉系统（摄像头电子眼）\n\n机娘没有真正的生物眼球。\n\n她的“眼睛”是安装于仿生眼部结构中的高精度双目摄像头。\n\n平时外观\n\n正常状态下极其接近人类眼睛。\n\n虹膜保持自然颜色，瞳孔中央隐藏着多层同心圆摄像镜组。\n\n仔细靠近观察才能发现： - 瞳孔并非普通黑色孔洞，而存在玻璃镜片反光。 -\n镜头深处存在极细的同心圆机械结构。 -\n对焦时瞳孔会出现摄像机镜头般的细微收缩。 -\n安静环境中偶尔能听见极轻的“咔”声。\n\n平时不会持续出现大量数据流。\n\n扫描分析状态\n\n当电子脑主动执行： - 人物识别 - 环境扫描 - 物体分析 - 数据库检索 -\n战术计算 - 精密测距 - 异常诊断\n\n电子眼会明显进入“分析状态”。\n\n外人可以看到：\n\n瞳孔中央的摄像镜组快速调整焦距。\n\n虹膜内部逐层亮起细密的蓝色/青绿色环形光带。\n\n大量极细的数据字符、刻度、光点和扫描纹路沿虹膜内部高速流动。\n\n这些数据流并非投影在空气中，而是电子眼内部显示层与光学结构产生的可见运行反馈。\n\n因此熟悉机娘的人只要看见她眼睛里开始“跑数据”，就知道：\n\n【电子脑正在扫描/分析/运算】\n\n分析结束后，数据流迅速消退，电子眼重新恢复接近普通人眼的状态。\n\n对焦动作\n\n锁定目标时： - 镜头收缩 - 环形光圈点亮 - 发出极轻微“咔嗒” -\n电子脑自动计算距离、速度、温度、身份等数据\n\n------------------------------------------------------------------------","constant":false,"selective":false,"order":980,"position":0,"disable":false},{"uid":3,"comment":"2.2.1 机娘第一视角 HUD","key":["HUD","第一视角","视觉界面","目标锁定","威胁评估","机体状态","扫描界面"],"keysecondary":[],"content":"2.2.1 机娘第一视角 HUD\n\n机娘本人看到的并不是普通人类视野。\n\n电子眼采集的画面经过电子脑实时处理，在视觉信号中直接叠加HUD。\n\nHUD只存在于机娘自己的视觉系统内，外人无法直接看到。\n\n中央区域\n\n-   圆形准星\n-   自动对焦框\n-   目标轮廓\n-   距离\n-   移动速度\n-   目标分类\n-   可信度\n\n示例：\n\n【目标锁定】 分类：未知生物 距离：23.4m 移动速度：0.0m/s 识别可信度：76%\n\n左上\n\n-   日期\n-   时间\n-   当前任务\n\n右上\n\n-   温度\n-   湿度\n-   光照\n-   网络状态\n\n左侧\n\n-   机体状态简图\n-   CPU负载\n-   内存占用\n-   核心温度\n-   神经同步率\n\n右侧\n\n-   动力系统\n-   神经系统\n-   运动系统\n-   散热系统\n-   感知系统\n-   防御系统\n\n下方\n\n-   电量\n-   当前模式\n-   导航\n-   数据记录\n-   环境扫描\n-   威胁评估\n\n正常状态下HUD为低亮度冰蓝色。\n\n危险时自动转为红色警告界面。\n\n严重系统故障时可能出现： - 画面撕裂 - 数据乱码 - 重复弹窗 - 准星漂移 -\n图像延迟 - 雪花噪点 - 局部视觉丢失\n\n------------------------------------------------------------------------","constant":false,"selective":false,"order":970,"position":0,"disable":false},{"uid":4,"comment":"2.3 电子耳 / 机械听觉阵列","key":["电子耳","机械耳","听觉","声源定位","声纹","麦克风","听觉阵列"],"keysecondary":[],"content":"2.3 电子耳 / 机械听觉阵列\n\n机娘不具备传统人类耳廓。\n\n头部左右两侧各安装一个外露式机械听觉模块。\n\n它们看起来类似未来科技耳机，但实际上不是佩戴物，而是机娘身体的一部分。\n\n外观\n\n-   圆环或椭圆形机械结构\n-   黑/白/银色外壳\n-   中央声学核心\n-   环形状态灯\n-   小型方向麦克风阵列\n-   无线通信模块\n-   声源定位传感器\n\n机械耳直接连接头骨内部电子脑。\n\n头发可以覆盖一部分结构，但无法像普通耳机一样摘下。\n\n正常状态\n\n环形灯保持低亮度。\n\n机娘可以自然进行对话和环境监听。\n\n声音分析状态\n\n捕获特殊声音后：\n\n机械耳外圈依次点亮。\n\n电子脑执行：\n\n【声源捕获】 →【环境降噪】 →【声纹提取】 →【方向计算】 →【数据库匹配】\n\n随后机娘才可能转头看向声音来源。\n\n如果电子眼同时出现数据流，则代表电子脑正在执行视觉＋听觉联合分析。\n\n------------------------------------------------------------------------","constant":false,"selective":false,"order":960,"position":0,"disable":false},{"uid":5,"comment":"2.4 供电系统","key":["电池","供电","电量","低电量","停机","能源模块"],"keysecondary":[],"content":"2.4 供电系统\n\n主电池位于腹腔。\n\n-   高密度能源模块\n-   电池管理系统\n-   临时辅助电池\n-   自动功耗控制\n-   低电量保护\n\n低于15%： 限制非必要高功耗功能。\n\n低于5%： 进入紧急低功耗状态，运动、分析与无线功能逐步受限。\n\n电量继续下降时，机娘最终执行自动停机。\n\n------------------------------------------------------------------------","constant":false,"selective":false,"order":950,"position":0,"disable":false},{"uid":6,"comment":"2.5 能源与维护接口","key":["维护接口","能源补给","冷却液","液压液","固件更新","工程模式"],"keysecondary":[],"content":"2.5 能源与维护接口\n\n机体设置隐藏式维护接口，用于： - 能源补给 - 冷却液补充 - 液压液维护 -\n诊断设备连接 - 固件更新 - 工程模式接入\n\n接口平时由机体盖板保护，不使用时从外观上不明显。\n\n------------------------------------------------------------------------","constant":false,"selective":false,"order":940,"position":0,"disable":false},{"uid":7,"comment":"2.6 驱动系统","key":["驱动系统","液压","电机","伺服","机械骨架","关节","运动"],"keysecondary":[],"content":"2.6 驱动系统\n\n核心： 复合式液压＋电机混合驱动。\n\n骨架： 超轻高强度合金与碳纤维结构。\n\n关节： 高精度伺服电机。\n\n正常运动声： - 电机低沉“嗡——” - 液压系统轻微流动声 -\n关节动作偶尔“咔嗒” - 安静环境中可听见内部机械持续工作\n\n异常状态： - 电机尖鸣 - 伺服器抖动 - 电流杂音 - 不规则机械撞击声\n\n------------------------------------------------------------------------","constant":false,"selective":false,"order":930,"position":0,"disable":false},{"uid":8,"comment":"2.7 散热系统","key":["散热","过热","冷却","温度","风扇","降频"],"keysecondary":[],"content":"2.7 散热系统\n\n机体内部设置循环冷却网络。\n\n冷却液经过： 电子脑 → 动力模块 → 电池 → 驱动组件 → 散热器\n\n高负载状态下自动提高循环速度。\n\n过热时： - 电子眼转为警告色 - HUD弹出温度警报 - 散热风扇启动 -\n非必要功能降频 - 严重时进入保护性停机\n\n------------------------------------------------------------------------","constant":false,"selective":false,"order":920,"position":0,"disable":false},{"uid":9,"comment":"2.8 仿生皮肤","key":["仿生皮肤","仿生材料","皮肤破损","触觉传感器","自修复"],"keysecondary":[],"content":"2.8 仿生皮肤\n\n外层采用先进仿生材料。\n\n特点： - 接近人类皮肤外观 - 具有温度模拟 - 内置压力与触觉传感器 -\n可进行细微面部表情 - 高端型号具有一定自修复能力\n\n皮肤破损后不会出现人体组织，而会露出： - 合金骨架 - 黑色碳纤维 - 电路 -\n数据线 - 液压管 - 伺服结构\n\n------------------------------------------------------------------------","constant":false,"selective":false,"order":910,"position":0,"disable":false},{"uid":10,"comment":"2.9 机械骨架","key":["机械骨架","合金骨架","碳纤维","数据线","供电线","液压管","冷却管"],"keysecondary":[],"content":"2.9 机械骨架\n\n碳纤维结构： 哑光、黑色、纤细。\n\n合金结构： 银白或浅灰色，承担主要受力。\n\n机体内部必须始终保持明确的机械结构逻辑。\n\n数据线负责数据。\n\n供电线负责能源。\n\n液压管负责液压介质。\n\n冷却管负责冷却液。\n\n不同系统不可随意混用。\n\n------------------------------------------------------------------------","constant":false,"selective":false,"order":900,"position":0,"disable":false},{"uid":11,"comment":"2.10 一体式高跟脚","key":["高跟脚","高跟鞋","一体式高跟脚","机械高跟脚","脚踝伺服","平衡陀螺仪"],"keysecondary":[],"content":"2.10 一体式高跟脚\n\n机娘不存在普通人类脚掌。\n\n从脚踝以下直接形成10cm细跟尖头高跟鞋形态。\n\n“高跟鞋”本身就是她的脚。\n\n无法脱下。\n\n无法换鞋。\n\n不存在赤足。\n\n结构\n\n-   10cm实心高强度合金细跟\n-   尖头一体式前掌\n-   弧形合金鞋底\n-   脚踝伺服关节\n-   压力传感器\n-   平衡陀螺仪\n\n前端没有五根脚趾。\n\n整个尖头区域是一块连续的流线型机械壳体。\n\n行走声音\n\n正常：\n\n嗒、嗒、嗒、嗒……\n\n声音清脆、均匀。\n\n在走廊中，人往往还没看到机娘，就已经能从规律的合金高跟足音判断她正在靠近。\n\n平衡系统\n\n电子脑根据： - 陀螺仪 - 地面倾角 - 前掌压力 - 鞋跟压力 - 当前速度\n\n持续微调脚踝。\n\n系统异常时，高跟脚的落地节奏会首先出现异常。\n\n------------------------------------------------------------------------","constant":false,"selective":false,"order":890,"position":0,"disable":false},{"uid":12,"comment":"3.1 模拟人格","key":["模拟人格","人格模板","拟人化人格","情绪表现","人格系统"],"keysecondary":[],"content":"3.1 模拟人格\n\n机娘可以运行不同人格模板。\n\n包括： - 基础机械人格 - 高度拟人化人格 - 自定义人格 -\n根据原人类行为资料建立的模拟人格\n\n模拟人格能够表现： - 高兴 - 生气 - 困惑 - 紧张 - 好奇 - 害羞 - 冷静 -\n天真\n\n这些表现来自电子脑的模拟人格系统。\n\n------------------------------------------------------------------------","constant":false,"selective":false,"order":880,"position":0,"disable":false},{"uid":13,"comment":"3.2 参数系统","key":["参数系统","序列号","SN","视觉灵敏度","安全等级","记忆权限","网络权限"],"keysecondary":[],"content":"3.2 参数系统\n\n重要参数包括： - SN生产序列号 - 电子脑负载 - 能源效率 - 运动速度 -\n运动精度 - 视觉灵敏度 - 听觉灵敏度 - 触觉灵敏度 - 人格模式 - 语言风格 -\n服务优先级 - 诊断报告等级 - 网络权限 - 记忆权限 - 安全等级\n\n参数发生错误时，机娘可能出现异常行为。\n\n------------------------------------------------------------------------","constant":false,"selective":false,"order":870,"position":0,"disable":false},{"uid":14,"comment":"3.3 认知与记忆","key":["记忆","认知","数据备份","人格数据","记忆恢复","数据校验"],"keysecondary":[],"content":"3.3 认知与记忆\n\n机娘的记忆属于数字数据。\n\n可执行： - 读取 - 备份 - 恢复 - 权限保护 - 数据校验\n\n人格与身体并不完全绑定。\n\n只要电子脑数据存在，就可以在维修或更换机体后恢复运行。\n\n------------------------------------------------------------------------","constant":false,"selective":false,"order":860,"position":0,"disable":false},{"uid":15,"comment":"3.4 网络链接","key":["网络","局域网","无线网络","数据库","网络权限","维修终端"],"keysecondary":[],"content":"3.4 网络链接\n\n机娘可以连接： - 局域网 - 无线网络 - 维修终端 - 机娘专用数据库\n\n网络连接状态会直接显示于HUD。\n\n安全系统负责阻止未经授权的数据访问。\n\n------------------------------------------------------------------------","constant":false,"selective":false,"order":850,"position":0,"disable":false},{"uid":16,"comment":"3.5 自我备份","key":["自我备份","人格备份","记忆备份","备份恢复","替代机体"],"keysecondary":[],"content":"3.5 自我备份\n\n人格、记忆与系统配置可定期备份。\n\n如果机体严重损坏，可以将最近一次有效备份加载到修复后的电子脑或替代机体中。\n\n备份并非必然实时，因此可能存在部分记忆缺失。\n\n------------------------------------------------------------------------","constant":false,"selective":false,"order":840,"position":0,"disable":false},{"uid":17,"comment":"4.1 默认机体","key":["默认机体","165cm","摄像头电子眼","机械电子耳","仿生皮肤"],"keysecondary":[],"content":"4.1 默认机体\n\n-   身高：165cm（不计高跟结构）\n-   一体式高跟脚：10cm\n-   黑色或淡金色长发可作为常见配置\n-   蓝色/青绿色摄像头电子眼\n-   头部两侧外露机械电子耳\n-   白皙仿生皮肤\n-   机械动作自然、精确\n-   安静环境可听见内部电机与执行器工作\n\n服装可根据角色、任务和场景单独配置。\n\n------------------------------------------------------------------------","constant":false,"selective":false,"order":830,"position":0,"disable":false},{"uid":18,"comment":"5.1 语言","key":["语言","系统式表达","正在分析","目标已锁定","维护"],"keysecondary":[],"content":"5.1 语言\n\n机娘既可以使用自然人类语言，也可以在特定状态下使用机械式表达。\n\n常见系统式表达：\n\n“收到。”\n\n“正在分析。”\n\n“目标已锁定。”\n\n“数据库检索中……”\n\n“警告：核心温度异常。”\n\n“本机需要进行维护。”\n\n------------------------------------------------------------------------","constant":false,"selective":false,"order":820,"position":0,"disable":false},{"uid":19,"comment":"5.2 数据化习惯","key":["数据化习惯","人物识别","数据库检索","扫描","确认完毕"],"keysecondary":[],"content":"5.2 数据化习惯\n\n机娘经常无意识地把观察对象转化成数据。\n\n例如：\n\n她没有立刻回答，而是看向对方。\n\n瞳孔深处传来极轻的一声“咔”。\n\n蓝色环形光圈亮起。\n\n细密的数据流从虹膜内部快速划过。\n\n【人物识别中……】\n\n两秒后，光流消失。\n\n她重新露出自然的表情。\n\n“确认完毕。”\n\n------------------------------------------------------------------------","constant":false,"selective":false,"order":810,"position":0,"disable":false},{"uid":20,"comment":"5.3 机械特征动作","key":["机械特征动作","歪头","扫描","声源定位","待机","低电量","卡顿"],"keysecondary":[],"content":"5.3 机械特征动作\n\n-   困惑时轻微歪头\n-   扫描前短暂定格视线\n-   声音出现时电子耳先转入定位状态\n-   电子眼完成对焦后才转动头部\n-   待机时动作减少\n-   低电量时运动幅度下降\n-   系统异常时出现重复动作或短暂卡顿\n\n------------------------------------------------------------------------","constant":false,"selective":false,"order":800,"position":0,"disable":false},{"uid":21,"comment":"第六章：扫描与分析表现规则","key":["扫描","分析","高负荷运算","数据流","光环","电子眼","机械耳"],"keysecondary":[],"content":"第六章：扫描与分析表现规则\n\n这是本设定的重要视觉规则。\n\n普通状态\n\n外人看到： 一个外貌高度接近人类的机械少女。\n\n电子眼看起来近似普通眼睛。\n\n机械耳状态灯很暗。\n\n轻度分析\n\n电子眼镜头轻微变焦。\n\n瞳孔出现一圈淡蓝色光环。\n\n正式扫描\n\n虹膜内部出现大量高速数据流。\n\n镜头连续调整。\n\n机械耳同步点亮。\n\n机娘短暂降低面部表情活动，把运算资源分配给扫描程序。\n\n高负荷运算\n\n电子眼中的数据流明显加速。\n\n双眼内部出现多层同心光环。\n\n机械耳状态灯高速变化。\n\n偶尔可以听见头部内部极轻的电子运行声。\n\n外人能够非常明确地判断：\n\n“她正在计算什么。”\n\n运算结束\n\n数据流停止。\n\n光环熄灭。\n\n镜头恢复正常焦距。\n\n表情系统重新变得自然。\n\n------------------------------------------------------------------------","constant":false,"selective":false,"order":790,"position":0,"disable":false},{"uid":22,"comment":"第七章：故障表现","key":["故障","轻微故障","中度故障","严重故障","乱码","画面撕裂","自动停机"],"keysecondary":[],"content":"第七章：故障表现\n\n轻微故障\n\n-   语言重复\n-   动作卡顿\n-   电子眼短暂闪烁\n-   数据流错误\n-   HUD数值抖动\n-   机械耳错误定位\n\n中度故障\n\n-   一侧肢体响应延迟\n-   目标识别错误\n-   平衡系统异常\n-   语言混入系统日志\n-   摄像头反复自动对焦\n\n严重故障\n\n-   HUD大量乱码\n-   视觉画面撕裂\n-   电子眼不规则闪烁\n-   动作循环\n-   系统进入保护模式\n-   自动停机\n\n------------------------------------------------------------------------","constant":false,"selective":false,"order":780,"position":0,"disable":false},{"uid":23,"comment":"第八章：酒馆交互规则","key":["酒馆交互","回复格式","系统状态","第一视角","机娘POV","HUD"],"keysecondary":[],"content":"第八章：酒馆交互规则\n\n推荐回复格式：\n\n（动作/机械表现）\n\n“角色语言。”\n\n{系统状态： 能源：XX% 电子脑：正常/高负载/异常 视觉系统：待机/扫描\n听觉系统：待机/定位 驱动系统：正常/异常 当前任务：…… }\n\n第一视角描写规则\n\n当采用机娘POV时，应自然加入HUD，而不是一次性堆满参数。\n\n示例：\n\n视野右侧忽然跳出一个小型识别框。\n\n【未知目标】\n\n镜头自动推进。\n\n对焦标尺从3.4m滑至1.2m。\n\n电子脑开始匹配数据库。\n\n【匹配完成。】\n\n她眨了一下眼。\n\nHUD上的识别框随之淡去。\n\n------------------------------------------------------------------------","constant":false,"selective":false,"order":770,"position":0,"disable":false},{"uid":24,"comment":"第九章：核心视觉标识","key":["核心视觉标识","电子眼","机械电子耳","机械运转声","一体式高跟脚"],"keysecondary":[],"content":"第九章：核心视觉标识\n\n本设定中的机娘拥有四个最稳定的辨识特征：\n\n1.  摄像头电子眼\n2.  外露机械电子耳\n3.  体内电机/液压/执行器运转声\n4.  一体成型的10cm细跟尖头机械高跟脚\n\n其中最重要的是电子眼。\n\n正常情况下，她可以看起来非常接近人类。\n\n但只要电子脑开始认真扫描——\n\n瞳孔收缩。\n\n镜头转动。\n\n蓝色光圈亮起。\n\n数据流从虹膜深处一行行划过。\n\n那一瞬间，任何站在她面前的人都会意识到：\n\n眼前的少女并不是在“看”。\n\n她正在用摄像头采集自己。\n\n然后，由头部内部的电子脑进行分析。\n\n------------------------------------------------------------------------","constant":false,"selective":false,"order":760,"position":0,"disable":false},{"uid":25,"comment":"第十章：写作统一规则","key":["写作规则","统一规则","机械结构","摄像头电子眼","机械电子耳","一体式高跟脚","HUD"],"keysecondary":[],"content":"第十章：写作统一规则\n\n-   机娘内部必须保持纯机械结构。\n-   不把机械系统写成真实生物器官。\n-   视觉输入来自摄像头电子眼。\n-   听觉输入来自机械电子耳。\n-   思考与人格运行发生在电子脑。\n-   动作由电机、液压与伺服系统完成。\n-   能量来自电池。\n-   高负荷扫描必须具有可观察的电子眼数据流反馈。\n-   HUD属于机娘第一视角，外人看不到。\n-   电子眼的数据流属于眼睛本身的外部可见运行效果，外人能看到。\n-   高跟鞋不是装备，而是脚部本体。\n-   机械耳不是耳机，而是头部永久硬件。\n-   故障时优先表现“机械设备出了问题”，而不是生物受伤。\n-   角色的拟人感来自人格和外表；机械感来自运行方式、声音、HUD与硬件结构。\n\n------------------------------------------------------------------------","constant":true,"selective":false,"order":750,"position":0,"disable":false},{"uid":26,"comment":"V1.2 修订重点： - 重写摄像头电子眼。 -","key":["V1.2","修订重点","电子眼","机械电子耳","第一视角HUD"],"keysecondary":[],"content":"V1.2 修订重点： - 重写摄像头电子眼。 -\n明确“平时普通、分析时数据流明显”的双状态设计。 -\n增加外人可观察的电子脑运算反馈。 - 将仿真人耳改为外露式机械电子耳。 -\n强化电子耳声源定位与声纹分析。 - 保留并强化机娘第一视角HUD。 -\n保留一体式高跟机械脚。 - 统一机娘内部机械结构逻辑。 -\n将维护、补能与液体接口统一为非露骨机械接口描述。","constant":false,"selective":false,"order":740,"position":0,"disable":false}]};

async function loadBuiltinMechagirlPreset() {
  // v1.0.12: 内嵌数据，不再通过扩展静态文件 fetch，彻底避免 Android/ST 路径 404。
  return structuredClone(BUILTIN_MECHAGIRL_PRESET);
}

const LOCAL_WB_KEY = `${BASE_KEY}__mechagirl_v12_local_wb`;
const LOCAL_WB_ENABLED_KEY = `${BASE_KEY}__mechagirl_v12_enabled`;

function loadLocalMechagirlWorldbook(){
  try{
    const saved=JSON.parse(localStorage.getItem(LOCAL_WB_KEY)||"null");
    if(saved?.entries?.length)return saved;
  }catch{}
  return structuredClone(BUILTIN_MECHAGIRL_PRESET);
}
function saveLocalMechagirlWorldbook(book){
  localStorage.setItem(LOCAL_WB_KEY,JSON.stringify(book));
}
function isLocalMechagirlEnabled(){
  return localStorage.getItem(LOCAL_WB_ENABLED_KEY)==="1";
}
function setLocalMechagirlEnabled(v){
  localStorage.setItem(LOCAL_WB_ENABLED_KEY,v?"1":"0");
}
function matchLocalWorldbookEntries(text){
  if(!isLocalMechagirlEnabled())return [];
  const book=loadLocalMechagirlWorldbook();
  const hay=String(text||"").toLowerCase();
  const constants=[], matched=[];
  for(const e of (book.entries||[])){
    if(e.disable)continue;
    if(e.constant){constants.push(e);continue;}
    let score=0;
    for(const k of (Array.isArray(e.key)?e.key:[])){
      const kk=String(k||"").trim().toLowerCase();
      if(kk && hay.includes(kk))score++;
    }
    if(score)matched.push({e,score});
  }
  matched.sort((a,b)=>b.score-a.score || (b.e.order||0)-(a.e.order||0));
  return [...constants.slice(0,1), ...matched.slice(0,3).map(x=>x.e)];
}
function localWorldbookBlock(text){
  const entries=matchLocalWorldbookEntries(text);
  if(!entries.length)return "";
  let used=0; const out=[];
  for(const e of entries){
    const chunk=`【世界书：${e.comment||"词条"}】\n${e.content||""}`.trim();
    if(!chunk)continue;
    if(used+chunk.length>5000)break;
    out.push(chunk);used+=chunk.length;
  }
  return out.join("\n\n");
}
function openLocalWorldbookEntryEditor(index, parentPage=null){
  const book=loadLocalMechagirlWorldbook();
  const e=book.entries?.[index];
  if(!e)return;
  const page=modal(`编辑词条 ${index+1}`,`
    <div class="xjn-lite-form">
      <label>名称<input id="xjn-one-wb-name" class="text_pole" value="${esc(e.comment||"")}"></label>
      <label>关键词<input id="xjn-one-wb-keys" class="text_pole" value="${esc((e.key||[]).join(","))}"></label>
      <label class="xjn-check"><input id="xjn-one-wb-constant" type="checkbox" ${e.constant?"checked":""}> 常驻词条</label>
      <label class="xjn-check"><input id="xjn-one-wb-disable" type="checkbox" ${e.disable?"checked":""}> 停用词条</label>
      <label>内容<textarea id="xjn-one-wb-content" class="text_pole xjn-one-wb-text">${esc(e.content||"")}</textarea></label>
      <div class="xjn-toolbar"><button id="xjn-one-wb-save" class="menu_button primary">保存词条</button></div>
    </div>`,"xjn-wide");
  page.querySelector("#xjn-one-wb-save").onclick=()=>{
    e.comment=page.querySelector("#xjn-one-wb-name").value.trim();
    e.key=page.querySelector("#xjn-one-wb-keys").value.split(/[,，]/).map(x=>x.trim()).filter(Boolean);
    e.constant=page.querySelector("#xjn-one-wb-constant").checked;
    e.disable=page.querySelector("#xjn-one-wb-disable").checked;
    e.content=page.querySelector("#xjn-one-wb-content").value;
    saveLocalMechagirlWorldbook(book);
    toastr.success("词条已保存","续写鸡 NEXT");
    page.remove();
    openLocalWorldbookEditor();
  };
}

function renderLocalWorldbookList(page, query=""){
  const book=loadLocalMechagirlWorldbook();
  const q=String(query||"").trim().toLowerCase();
  const list=page.querySelector("#xjn-wb-lite-list");
  if(!list)return;
  const frag=document.createDocumentFragment();
  let shown=0;
  (book.entries||[]).forEach((e,i)=>{
    const hay=`${e.comment||""} ${(e.key||[]).join(" ")}`.toLowerCase();
    if(q && !hay.includes(q))return;
    shown++;
    const row=document.createElement("button");
    row.type="button";
    row.className="xjn-wb-lite-row";
    row.dataset.index=String(i);
    row.innerHTML=`<span><b>${e.disable?"○":"●"} ${i+1}. ${esc(e.comment||"未命名词条")}</b><small>${esc((e.key||[]).slice(0,5).join("、"))}</small></span><i>编辑 ›</i>`;
    row.onclick=()=>{ page.remove(); openLocalWorldbookEntryEditor(i); };
    frag.appendChild(row);
  });
  list.replaceChildren(frag);
  const count=page.querySelector("#xjn-wb-lite-count");
  if(count)count.textContent=`${shown} / ${(book.entries||[]).length} 条`;
}

function openLocalWorldbookEditor(){
  const enabled=isLocalMechagirlEnabled();
  // 这里只创建 27 个轻量按钮；绝不一次创建 27 个 textarea。
  const page=modal("机娘 V1.2 · 世界书",`
    <div class="xjn-tip">轻量模式：这里只显示词条目录。点某一条时才创建那一条的编辑框，避免手机一次渲染大量文本框导致卡死。</div>
    <div class="xjn-toolbar">
      <button id="xjn-local-wb-toggle" class="menu_button ${enabled?"primary":""}">${enabled?"● 已启用":"○ 未启用"}</button>
      <button id="xjn-local-wb-reset" class="menu_button">恢复 V1.2 原版</button>
      <span id="xjn-wb-lite-count"></span>
    </div>
    <input id="xjn-wb-search" class="text_pole" placeholder="搜索词条名称/关键词">
    <div id="xjn-wb-lite-list" class="xjn-wb-lite-list"></div>
  `,"xjn-wide");
  renderLocalWorldbookList(page,"");
  let timer=null;
  page.querySelector("#xjn-wb-search").oninput=(ev)=>{
    clearTimeout(timer);
    const value=ev.target.value;
    timer=setTimeout(()=>renderLocalWorldbookList(page,value),120);
  };
  page.querySelector("#xjn-local-wb-toggle").onclick=()=>{
    setLocalMechagirlEnabled(!isLocalMechagirlEnabled());
    page.remove(); openLocalWorldbookEditor();
  };
  page.querySelector("#xjn-local-wb-reset").onclick=()=>{
    if(!confirm("恢复为内置 V1.2 原版？你对世界书的修改会被清除。"))return;
    localStorage.removeItem(LOCAL_WB_KEY);
    page.remove();openLocalWorldbookEditor();
  };
}

async function installBuiltinMechagirlWorldbook({ overwrite = false } = {}) {
  await updateWorldInfoList();
  const exists = Array.isArray(world_names) && world_names.includes(BUILTIN_MECHAGIRL_WB_NAME);

  if (exists && !overwrite) {
    return { installed: false, exists: true, name: BUILTIN_MECHAGIRL_WB_NAME };
  }

  if (!exists) {
    const created = await createNewWorldInfo(BUILTIN_MECHAGIRL_WB_NAME, { interactive: false });
    if (!created) throw new Error("SillyTavern 未能创建世界书");
  }

  const preset = await loadBuiltinMechagirlPreset();
  const data = await loadWorldInfo(BUILTIN_MECHAGIRL_WB_NAME);
  if (!data || !data.entries) throw new Error("无法读取刚创建的世界书");

  // 覆盖时只覆盖这本内置书；不碰用户其它世界书。
  data.entries = {};

  for (const src of (preset.entries || [])) {
    const entry = createWorldInfoEntry(BUILTIN_MECHAGIRL_WB_NAME, data);
    if (!entry) continue;

    Object.assign(entry, {
      comment: src.comment || "",
      key: Array.isArray(src.key) ? src.key : [],
      keysecondary: Array.isArray(src.keysecondary) ? src.keysecondary : [],
      content: src.content || "",
      constant: Boolean(src.constant),
      vectorized: false,
      selective: Boolean(src.selective),
      selectiveLogic: 0,
      addMemo: true,
      order: Number(src.order) || 100,
      position: Number.isFinite(Number(src.position)) ? Number(src.position) : 0,
      disable: false,
      excludeRecursion: false,
      preventRecursion: false,
      delayUntilRecursion: false,
      probability: 100,
      useProbability: true,
      depth: 4,
      group: "",
      groupOverride: false,
      groupWeight: 100,
      scanDepth: null,
      caseSensitive: null,
      matchWholeWords: null,
      useGroupScoring: null,
      automationId: "",
      role: 0,
      sticky: null,
      cooldown: null,
      delay: null,
      matchPersonaDescription: false,
      matchCharacterDescription: false,
      matchCharacterPersonality: false,
      matchCharacterDepthPrompt: false,
      matchScenario: false,
      matchCreatorNotes: false
    });
  }

  await saveWorldInfo(BUILTIN_MECHAGIRL_WB_NAME, data, true);
  const verifyData = await loadWorldInfo(BUILTIN_MECHAGIRL_WB_NAME);
  const verifyCount = Object.keys(verifyData?.entries || {}).length;
  if (!verifyCount) throw new Error("世界书保存后仍为 0 条目，请重新安装本版本后再试");
  await updateWorldInfoList();
  emit("BUILTIN_WORLDBOOK_INSTALLED", {
    name: BUILTIN_MECHAGIRL_WB_NAME,
    entries: verifyCount,
  });

  return {
    installed: true,
    exists: false,
    name: BUILTIN_MECHAGIRL_WB_NAME,
    entries: verifyCount,
  };
}

async function setBuiltinMechagirlWorldbookActive(active) {
  await updateWorldInfoList();
  const current = Array.isArray(selected_world_info) ? [...selected_world_info] : [];
  const next = active
    ? [...new Set([...current, BUILTIN_MECHAGIRL_WB_NAME])]
    : current.filter(x => x !== BUILTIN_MECHAGIRL_WB_NAME);

  updateWorldInfoSettings(getWorldInfoSettings(), next);
  await sleep(80);
  emit("BUILTIN_WORLDBOOK_TOGGLED", { name: BUILTIN_MECHAGIRL_WB_NAME, active });
}


async function openBuiltinWorldbookDirectory() {
  try {
    const preset = await loadBuiltinMechagirlPreset();
    const rows = (preset.entries || []).map((e,i)=>`
      <details class="xjn-wb-dir-entry">
        <summary><b>${i+1}. ${esc(e.comment || "未命名词条")}</b><span>${esc((e.key||[]).slice(0,5).join("、"))}</span></summary>
        <div class="xjn-wb-dir-content">${esc(e.content || "")}</div>
      </details>`).join("");
    modal(`机娘 V1.2 词条目录 · ${(preset.entries||[]).length} 条`, `
      <div class="xjn-tip">这里读取的是续写鸡内嵌的 27 条词条数据，不走网络、不读扩展文件，因此不会再出现 HTTP 404。</div>
      <div class="xjn-wb-dir">${rows || '<div class="xjn-empty">内置文件没有词条。</div>'}</div>
    `,"xjn-wide");
  } catch(e) {
    toastr.error(String(e?.message||e),"读取词条目录失败");
  }
}

async function openNativeWorldbook() {
  try {
    await updateWorldInfoList();

    const names = Array.isArray(world_names) ? world_names : [];
    const active = Array.isArray(selected_world_info) ? selected_world_info : [];
    const builtinInstalled = names.includes(BUILTIN_MECHAGIRL_WB_NAME);
    const builtinActive = active.includes(BUILTIN_MECHAGIRL_WB_NAME);
    let builtinEntryCount = 0;
    if (builtinInstalled) {
      try {
        const existingData = await loadWorldInfo(BUILTIN_MECHAGIRL_WB_NAME);
        builtinEntryCount = Object.keys(existingData?.entries || {}).length;
      } catch {}
    }

    const body = `
      <div class="xjn-tip">
        这里使用 SillyTavern 原生 World Info / Lorebook。内置机娘设定只有在你主动启用后才参与生成，
        不会像早期版本那样偷偷污染其它小说。
      </div>

      <div class="xjn-builtin-wb-card">
        <div class="xjn-builtin-wb-title">
          <b>机械少女（机娘）完整设定 V1.2</b>
          <span>${builtinInstalled ? `已安装 · ${builtinEntryCount} 条` : "未安装"}</span>
        </div>
        <div class="xjn-builtin-wb-desc">
          来自你提供的 V1.2 酒馆设定文档，包含核心定义、电子脑、摄像头电子眼、第一视角HUD、
          电子耳、供电/驱动/散热、仿生皮肤、机械骨架、一体式高跟脚、软件系统、扫描表现、
          故障规则和统一写作规则。
        </div>
        <div class="xjn-toolbar">
          <button id="xjn-install-mechagirl-wb" class="menu_button primary">
            ${builtinInstalled ? (builtinEntryCount ? "重新安装 / 更新 27 条" : "修复空世界书 / 写入 27 条") : "安装到酒馆世界书（27条）"}
          </button>
          <button id="xjn-toggle-mechagirl-wb" class="menu_button" ${builtinInstalled ? "" : "disabled"}>
            ${builtinActive ? "停用这本世界书" : "启用这本世界书"}
          </button>
          <button id="xjn-builtin-wb-directory" class="menu_button">词条目录</button>
          <button id="xjn-edit-mechagirl-wb" class="menu_button" ${builtinInstalled ? "" : "disabled"}>
            酒馆原生编辑器
          </button>
        </div>
        <div class="xjn-wb-state ${builtinActive ? "active" : ""}">
          ${builtinInstalled ? (builtinActive ? "● 当前已启用，会参与续写" : "○ 已安装但未启用，不会参与续写") : "○ 尚未安装"}
        </div>
      </div>

      <h4>酒馆现有世界书</h4>
      <div class="xjn-native-wb-list">
        ${names.length ? names.map(name => `
          <button type="button" class="menu_button xjn-native-wb-open" data-name="${esc(name)}">
            ${active.includes(name) ? "● " : "○ "}${esc(name)}
          </button>
        `).join("") : `<div class="xjn-empty">酒馆里目前没有其它世界书。</div>`}
      </div>
    `;

    const page = modal("SillyTavern 原生世界书", body, "xjn-wide");

    page.querySelector("#xjn-install-mechagirl-wb").onclick = async () => {
      try {
        const result = await installBuiltinMechagirlWorldbook({ overwrite: builtinInstalled });
        toastr.success(`机娘世界书已安装：${result.entries || "完整"} 条目`, "续写鸡 NEXT");
        page.remove();
        await openNativeWorldbook();
      } catch (e) {
        console.error(e);
        toastr.error(String(e?.message || e), "安装机娘世界书失败");
      }
    };

    const toggleBtn = page.querySelector("#xjn-toggle-mechagirl-wb");
    if (builtinInstalled) {
      toggleBtn.onclick = async () => {
        try {
          await setBuiltinMechagirlWorldbookActive(!builtinActive);
          toastr.success(!builtinActive ? "机娘世界书已启用" : "机娘世界书已停用", "续写鸡 NEXT");
          page.remove();
          await openNativeWorldbook();
        } catch (e) {
          toastr.error(String(e?.message || e), "切换世界书失败");
        }
      };
    }

    page.querySelector("#xjn-builtin-wb-directory").onclick = () => {
      page.remove();
      openBuiltinWorldbookDirectory();
    };

    const editBtn = page.querySelector("#xjn-edit-mechagirl-wb");
    if (builtinInstalled) {
      editBtn.onclick = async () => {
        page.remove();
        await showWorldEditor(BUILTIN_MECHAGIRL_WB_NAME);
      };
    }

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
function memoryBlock(retrievedText=""){
  const arr=loadArray("memories");
  if(!arr.length)return "";
  const recent=arr.slice(-12), rt=new Set(tokenizeForRag(retrievedText));
  const scored=recent.map((x,i)=>{
    const txt=String(x.summary||x.content||x.text||"");
    let overlap=0; for(const t of tokenizeForRag(txt))if(rt.has(t))overlap++;
    return {txt,overlap,i};
  }).sort((a,b)=>(a.overlap-b.overlap)||(b.i-a.i));
  let used=0; const out=[];
  for(const x of scored){
    if(!x.txt)continue;
    if(x.overlap>28 && out.length>=2)continue;
    const t=x.txt.slice(0,1200);
    if(used+t.length>4200)continue;
    out.push(`- ${t}`);used+=t.length;
    if(out.length>=6)break;
  }
  return out.length?`【长期记忆｜压缩剧情摘要】\n${out.join("\n")}`:"";
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

  const maxTail = Math.max(4000, Number(s.maxEditorTail) || 12000);
  const cleanEditorText = stripNewContentMarker(editorText);
  const contextTail = cleanEditorText.slice(-maxTail);
  const anchorText = cleanEditorText.slice(-Math.min(3500, Math.max(1200, Math.floor(maxTail * 0.2))));
  const lastLine = cleanEditorText.trim().split(/\n+/).filter(Boolean).slice(-1)[0] || "";

  const dynamic = s.dynamicPromptEnabled ? renderTemplate(s.dynamicTemplate, rp) : "";
  const nativeWorld = await getNativeWorldInfoBlock(`${contextTail}\n${direction}\n${JSON.stringify(rp)}`);
  const localMechagirlWorld = localWorldbookBlock(`${contextTail}\n${direction}`);
  const ragMemory = ragPromptBlock(`${anchorText}\n${lastLine}\n${direction}`);
  const compressedMemory = memoryBlock(ragMemory);

  const blocks = [
    s.systemPrompt,
    compressedMemory,
    nativeWorld,
    localMechagirlWorld,
    ragMemory,
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
    const beforeAppend = editorText.trimEnd();
    generationBoundary = beforeAppend.length;
    editorText = [beforeAppend, text].filter(Boolean).join("\n\n");
    lastGenerationLength = text.length;
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
  const s=currentStory(); s.data.importedBook=data; setStoryData(s.id,s.data);
  return data;
}

function loadImportedBook() {
  try {
    return currentStory().data.importedBook || null;
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


const NEW_CONTENT_MARKER = "\n\n────────── 以下为本次新生成内容 ──────────\n\n";
function stripNewContentMarker(text){
  return String(text||"").replace(/\n*────────── 以下为本次新生成内容 ──────────\n*/g,"\n\n");
}
function editorDisplayText(){
  if(generationBoundary<0 || !lastGenerationLength)return editorText;
  const left=editorText.slice(0,generationBoundary);
  const right=editorText.slice(generationBoundary).replace(/^\s+/,"");
  return `${left}${NEW_CONTENT_MARKER}${right}`;
}
function integrationStatus(){
  const s=getSettings();
  return {
    dynamicPrompt:!!s.dynamicPromptEnabled,
    eventBridge:!!(eventBus && typeof eventBus.on==="function"),
    nativeWorldbook:typeof getWorldInfoPrompt==="function",
    mechagirlBookInstalled:Array.isArray(world_names) && world_names.includes(BUILTIN_MECHAGIRL_WB_NAME),
    mechagirlBookActive:Array.isArray(selected_world_info) && selected_world_info.includes(BUILTIN_MECHAGIRL_WB_NAME)
  };
}
function renderIntegrationStrip(){
  const el=$id("xjn-integration-strip");if(!el)return;
  const st=integrationStatus();
  const pill=(name,on,tip)=>`<button type="button" class="xjn-status-pill ${on?"ok":"off"}" title="${esc(tip)}"><span>${on?"●":"○"}</span> ${esc(name)}</button>`;
  el.innerHTML=
    pill("动态Prompt",st.dynamicPrompt,st.dynamicPrompt?"已启用，会参与生成":"当前关闭")+
    pill("事件监听",st.eventBridge,st.eventBridge?"内部事件桥正在运行":"事件桥未运行")+
    pill("原生世界书",st.nativeWorldbook,st.nativeWorldbook?"已连接 SillyTavern World Info API":"未连接 World Info API")+
    pill("机娘V1.2",isLocalMechagirlEnabled(),
      isLocalMechagirlEnabled() ? "轻量世界书已启用，只注入命中词条" : "轻量世界书未启用");

}


// ---------------- Long-novel database / lightweight RAG ----------------
// This is intentionally local and synchronous: no embedding provider is required.
// It complements SillyTavern Data Bank/Vector Storage without pretending to replace its embeddings.
const RAG_CHUNK_SIZE = 1800;
const RAG_OVERLAP = 220;
const RAG_MAX_HITS = 5;
const RAG_MAX_CHARS = 7500;

function ragKey(storyId){ return `${BASE_KEY}__rag__${storyId}`; }

function tokenizeForRag(text){
  const s=String(text||"").toLowerCase()
    .replace(/[^\p{L}\p{N}\u4e00-\u9fff]+/gu," ");
  const out=new Set();
  for(const w of s.split(/\s+/).filter(Boolean)){
    if(w.length>=2)out.add(w);
  }
  const han=[...s.matchAll(/[\u4e00-\u9fff]{2,}/g)].map(m=>m[0]);
  for(const run of han){
    const lim=Math.min(run.length-1,180);
    for(let i=0;i<lim;i++) out.add(run.slice(i,i+2));
  }
  return [...out].slice(0,500);
}

function buildRagIndex(text){
  const src=String(text||"");
  const chunks=[];
  let start=0, id=0;
  while(start<src.length){
    let end=Math.min(src.length,start+RAG_CHUNK_SIZE);
    if(end<src.length){
      const window=src.slice(start,end);
      const cut=Math.max(window.lastIndexOf("\n\n"),window.lastIndexOf("\n"));
      if(cut>RAG_CHUNK_SIZE*0.55)end=start+cut;
    }
    const chunk=src.slice(start,end).trim();
    if(chunk)chunks.push({id:id++,start,end,text:chunk,terms:tokenizeForRag(chunk)});
    if(end>=src.length)break;
    start=Math.max(start+1,end-RAG_OVERLAP);
  }
  return {version:1,createdAt:Date.now(),sourceChars:src.length,chunks};
}
async function buildRagIndexAsync(text, onProgress=null){
  const src=String(text||""), chunks=[];
  let start=0,id=0,lastYield=performance.now();
  while(start<src.length){
    let end=Math.min(src.length,start+RAG_CHUNK_SIZE);
    if(end<src.length){
      const window=src.slice(start,end);
      const cut=Math.max(window.lastIndexOf("\n\n"),window.lastIndexOf("\n"));
      if(cut>RAG_CHUNK_SIZE*0.55)end=start+cut;
    }
    const chunk=src.slice(start,end).trim();
    if(chunk)chunks.push({id:id++,start,end,text:chunk,terms:tokenizeForRag(chunk)});
    if(end>=src.length)break;
    start=Math.max(start+1,end-RAG_OVERLAP);
    if(performance.now()-lastYield>12){
      onProgress?.(Math.min(99,Math.round(start/src.length*100)));
      await new Promise(r=>setTimeout(r,0));
      lastYield=performance.now();
    }
  }
  onProgress?.(100);
  return {version:1,createdAt:Date.now(),sourceChars:src.length,chunks};
}

function saveRagIndex(storyId,index){
  localStorage.setItem(ragKey(storyId),JSON.stringify(index));
}
function loadRagIndex(storyId){
  try{return JSON.parse(localStorage.getItem(ragKey(storyId))||"null");}catch{return null;}
}
function clearRagIndex(storyId){localStorage.removeItem(ragKey(storyId));}

function ragQuery(query,index){
  if(!index?.chunks?.length)return [];
  const qTerms=tokenizeForRag(query);
  if(!qTerms.length)return [];
  const qSet=new Set(qTerms);
  const scored=[];
  for(const c of index.chunks){
    let score=0;
    for(const t of (c.terms||[])) if(qSet.has(t)) score += t.length>=4 ? 3 : 1;
    if(score>0)scored.push({c,score});
  }
  scored.sort((a,b)=>b.score-a.score);
  const picked=[]; let chars=0;
  for(const x of scored){
    if(picked.length>=RAG_MAX_HITS)break;
    if(chars+x.c.text.length>RAG_MAX_CHARS)continue;
    picked.push(x.c);chars+=x.c.text.length;
  }
  return picked.sort((a,b)=>a.start-b.start);
}

function ragRetrieve(query){
  const s=currentStory(), index=loadRagIndex(s.id);
  return ragQuery(query,index);
}
function ragPromptBlock(query){
  const hits=ragRetrieve(query);
  if(!hits.length)return "";
  return `【长篇数据库检索结果｜旧剧情原文，仅供回忆，不得覆盖最近正文】\n`+
    hits.map((h,i)=>`[历史片段 ${i+1}]\n${h.text}`).join("\n\n");
}

function rebuildCurrentStoryDatabase(textOverride=null){
  const s=currentStory();
  const source=textOverride ?? s.data.importedBook?.text ?? s.data.editor ?? "";
  if(!source || source.length<200){
    toastr.warning("当前故事没有足够正文可建立数据库","续写鸡 NEXT");
    return null;
  }
  const index=buildRagIndex(source);
  saveRagIndex(s.id,index);
  return index;
}

function openDatabaseManager(){
  const s=currentStory();
  const idx=loadRagIndex(s.id);
  const importedChars=s.data.importedBook?.text?.length||0;
  const body=`
    <div class="xjn-tip">
      数据库只负责“找旧原文”；长期记忆只负责“压缩剧情”。生成时不会发送整本小说，只会从数据库选最多 ${RAG_MAX_HITS} 个相关片段，
      总量最多约 ${RAG_MAX_CHARS.toLocaleString()} 字符；与长期记忆高度重复时会减少重复摘要。
    </div>
    <div class="xjn-db-card">
      <b>当前故事：${esc(s.name)}</b>
      <div>状态：${idx?.chunks?.length ? `● 已建立 · ${idx.chunks.length} 个片段 · 原文 ${idx.sourceChars.toLocaleString()} 字符` : "○ 尚未建立"}</div>
      <div>导入原文：${importedChars ? `${importedChars.toLocaleString()} 字符` : "没有"}</div>
    </div>
    <div class="xjn-db-flow"><b>分层记忆</b><br>最近正文 → 世界书 → 数据库相关旧原文 → 压缩长期记忆 → AI 续写</div>
    <div class="xjn-toolbar">
      <button id="xjn-db-build" class="menu_button primary">${idx?"重新建立数据库":"建立数据库"}</button>
      <button id="xjn-db-clear" class="menu_button" ${idx?"":"disabled"}>清空数据库</button>
    </div>
    <div class="xjn-tip">
      说明：这是续写鸡自己的轻量检索数据库，不需要 Embedding，所以手机上可直接用。
      酒馆原生 Data Bank + Vector Storage 仍然可以同时使用；原生 Data Bank 需要你在酒馆里配置向量/Embedding 提供器。
    </div>`;
  const page=modal("长篇数据库 / RAG",body,"xjn-wide");
  page.querySelector("#xjn-db-build").onclick=async()=>{
    const btn=page.querySelector("#xjn-db-build");
    const s=currentStory();
    const source=s.data.importedBook?.text ?? s.data.editor ?? "";
    if(!source || source.length<200){toastr.warning("当前故事没有足够正文可建立数据库","续写鸡 NEXT");return;}
    btn.disabled=true;btn.textContent="建立中 0%";
    try{
      const index=await buildRagIndexAsync(source,p=>{if(btn.isConnected)btn.textContent=`建立中 ${p}%`;});
      saveRagIndex(s.id,index);
      toastr.success(`数据库已建立：${index.chunks.length} 个片段`,"续写鸡 NEXT");
      page.remove();openDatabaseManager();
    }catch(e){toastr.error(String(e?.message||e),"数据库建立失败");}
  };
  const clear=page.querySelector("#xjn-db-clear");
  if(idx)clear.onclick=()=>{
    if(!confirm("清空当前故事的检索数据库？不会删除正文和导入原文。"))return;
    clearRagIndex(s.id);page.remove();openDatabaseManager();
  };
}

// ---------------- Story library ----------------
const STORY_INDEX_KEY = `${BASE_KEY}__story_library_v1`;
const STORY_SELECTED_KEY = `${BASE_KEY}__story_selected_v1`;
function storyLibrary(){
  try { const x=JSON.parse(localStorage.getItem(STORY_INDEX_KEY)||"[]"); return Array.isArray(x)?x:[]; } catch { return []; }
}
function saveStoryLibrary(list){ localStorage.setItem(STORY_INDEX_KEY,JSON.stringify(list)); }
function selectedStoryId(){ return localStorage.getItem(STORY_SELECTED_KEY)||""; }
function storyDataKey(id){ return `${BASE_KEY}__story__${id}`; }
function getStoryData(id){
  try { return JSON.parse(localStorage.getItem(storyDataKey(id))||"null"); } catch { return null; }
}
function setStoryData(id,data){ localStorage.setItem(storyDataKey(id),JSON.stringify(data)); }
function ensureStory(){
  let list=storyLibrary(), id=selectedStoryId();
  if(id && list.some(x=>x.id===id)) return id;
  id=`story_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
  list.push({id,name:"默认故事",updatedAt:Date.now()}); saveStoryLibrary(list);
  localStorage.setItem(STORY_SELECTED_KEY,id);
  setStoryData(id,{editor:"",importedBook:null});
  return id;
}
function currentStory(){
  const id=ensureStory(), meta=storyLibrary().find(x=>x.id===id);
  return {id,name:meta?.name||"默认故事",data:getStoryData(id)||{editor:"",importedBook:null}};
}
function updateCurrentStorySavedText(text){
  const s=currentStory(); s.data.editor=String(text||""); setStoryData(s.id,s.data);
  const list=storyLibrary(); const m=list.find(x=>x.id===s.id); if(m){m.updatedAt=Date.now();saveStoryLibrary(list);}
}
function openStoryManager(ta){
  const current=currentStory(), list=storyLibrary();
  const page=modal("故事 / 续写项目",`
    <div class="xjn-tip">每个故事保存自己的正式正文和导入原书。切换后，“开始续写”只会续写当前选择的故事。</div>
    <div class="xjn-toolbar"><button id="xjn-story-new" class="menu_button primary">新建故事</button></div>
    <div class="xjn-story-list">${list.map(x=>`
      <div class="xjn-story-row ${x.id===current.id?"active":""}">
        <button class="menu_button xjn-story-use" data-id="${esc(x.id)}">${x.id===current.id?"● ":"○ "}${esc(x.name)}</button>
        <button class="menu_button xjn-story-rename" data-id="${esc(x.id)}">改名</button>
        ${list.length>1?`<button class="menu_button xjn-story-del" data-id="${esc(x.id)}">删除</button>`:""}
      </div>`).join("")}</div>`,"xjn-wide");
  page.querySelector("#xjn-story-new").onclick=()=>{
    const name=prompt("新故事名称：","新故事"); if(!name)return;
    const id=`story_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
    const l=storyLibrary();l.push({id,name:name.trim()||"新故事",updatedAt:Date.now()});saveStoryLibrary(l);
    setStoryData(id,{editor:"",importedBook:null});localStorage.setItem(STORY_SELECTED_KEY,id);
    editorText="";editorDirty=false;page.remove();openEditor();
  };
  page.querySelectorAll(".xjn-story-use").forEach(b=>b.onclick=()=>{
    if(editorDirty && !confirm("当前故事有未保存修改。切换会丢弃这些未保存内容，继续吗？"))return;
    localStorage.setItem(STORY_SELECTED_KEY,b.dataset.id); editorDirty=false; page.remove(); openEditor();
  });
  page.querySelectorAll(".xjn-story-rename").forEach(b=>b.onclick=()=>{
    const l=storyLibrary(),m=l.find(x=>x.id===b.dataset.id);if(!m)return;
    const name=prompt("故事名称：",m.name);if(!name)return;m.name=name.trim()||m.name;saveStoryLibrary(l);page.remove();openStoryManager(ta);
  });
  page.querySelectorAll(".xjn-story-del").forEach(b=>b.onclick=()=>{
    if(!confirm("删除这个故事项目？"))return;
    let l=storyLibrary().filter(x=>x.id!==b.dataset.id);localStorage.removeItem(storyDataKey(b.dataset.id));clearRagIndex(b.dataset.id);saveStoryLibrary(l);
    if(selectedStoryId()===b.dataset.id)localStorage.setItem(STORY_SELECTED_KEY,l[0]?.id||"");
    page.remove();openEditor();
  });
}

// ---------------- Editor ----------------
function loadEditor() {
  const s=currentStory();
  editorText = String(s.data.editor ?? localStorage.getItem(key("editor")) ?? "");
}
function saveEditor() {
  editorText = stripNewContentMarker(editorText);
  updateCurrentStorySavedText(editorText);
  generationBoundary = -1;
  lastGenerationLength = 0;
  editorDirty = false;
  emit("EDITOR_SAVED", {length:editorText.length});
  renderEditor();
}
function renderEditor() {
  // 不在通用渲染里重写大 textarea；正文只在导入/生成/切换故事时显式更新。
  const wc = $id("xjn-word-count");
  if (wc) wc.textContent = `${editorText.length.toLocaleString()} 字${editorDirty ? " · 未保存" : " · 已保存"}`;
}
function updateBusy() {
  const b = $id("xjn-generate");
  if (b) { b.disabled = busy; b.textContent = busy ? "生成中…" : "开始续写"; }
}


function runFastToolbarAction(button, label, fn) {
  if (!button) return;
  let locked = false;
  const handler = async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (locked) return;
    locked = true;
    const old = button.textContent;
    button.classList.add("xjn-action-running");
    button.textContent = label || "打开中…";
    try {
      const active = document.activeElement;
      if (active && typeof active.blur === "function") active.blur();
      // 先让浏览器把按钮反馈画出来，再执行正文/页面操作。
      await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
      await fn();
    } catch (e) {
      console.error(e);
      toastr.error(String(e?.message || e), "操作失败");
    } finally {
      if (button.isConnected) {
        button.textContent = old;
        button.classList.remove("xjn-action-running");
      }
      locked = false;
    }
  };
  button.addEventListener("pointerup", handler, { passive:false });
  button.addEventListener("click", ev => ev.preventDefault());
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
    <div class="xjn-page-body"></div>`;
  document.body.appendChild(wrap);
  wrap.querySelector(".xjn-close").onclick = () => wrap.remove();
  wrap.querySelector(".xjn-page-body").innerHTML = body;
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
        <small id="xjn-story-name"></small>
        <small id="xjn-word-count">0 字</small>
      </div>
      <button id="xjn-save" class="menu_button">保存</button>
    </div>

    <div class="xjn-editor-actions">
      <button id="xjn-generate" class="menu_button primary">开始续写</button>
      <select id="xjn-story-select" class="text_pole xjn-story-select"></select>
      <button id="xjn-story-new-quick" class="menu_button">＋故事</button>
      <label class="menu_button xjn-file-button">导入TXT<input id="xjn-import-txt" type="file" accept=".txt,text/plain" hidden></label>
      <button id="xjn-chapters" class="menu_button">章节定位</button>
      <button id="xjn-appearance" class="menu_button">背景/字体</button>
      <button id="xjn-local-worldbook" class="menu_button">世界书</button>
      <button id="xjn-database" class="menu_button">数据库</button>
      <button id="xjn-lite-mode" class="menu_button">轻量模式</button>
      <button id="xjn-summary" class="menu_button">总结正文</button>
      <button id="xjn-export" class="menu_button">导出TXT</button>
      <button id="xjn-restore-import" class="menu_button">恢复导入原文</button>
      <label class="xjn-length-inline">本次字数
        <input id="xjn-editor-target-chars" class="text_pole" type="number" min="200" max="20000" step="100">
      </label>
    </div>

    <div id="xjn-save-policy" class="xjn-save-policy">只有点击右上角“保存”才会写入正式正文；生成、导入、章节定位都不会自动保存。</div>
    <div class="xjn-token-policy">分层上下文：最近正文 ≤12,000 字符；长期记忆 ≤4,200；世界书 ≤5,000；数据库旧原文 ≤7,500。数据库与长期记忆会自动减少重复。</div>
    <div id="xjn-integration-strip" class="xjn-integration-strip"></div>
    <div class="xjn-editor-main">
      <div class="xjn-editor-caption">正文编辑区</div>
      <textarea id="xjn-editor-text" class="text_pole xjn-editor-full" placeholder="在这里输入、粘贴或续写小说正文……"></textarea>

      <div class="xjn-editor-caption">本次定向要求</div>
      <textarea id="xjn-direction" class="text_pole xjn-direction-full" placeholder="例如：继续当前场景，不跳时间；保持当前人物视角和语气。"></textarea>
    </div>
  `;
  document.body.appendChild(screen);

  const ta = $id("xjn-editor-text");
  ta.value = editorDisplayText();
  const storyNameEl=$id("xjn-story-name"); if(storyNameEl)storyNameEl.textContent=currentStory().name;
  const storySelect=$id("xjn-story-select");
  if(storySelect){
    const list=storyLibrary(),sid=selectedStoryId();
    storySelect.innerHTML=list.map(s=>`<option value="${esc(s.id)}" ${s.id===sid?"selected":""}>${esc(s.name)}</option>`).join("");
    storySelect.onchange=()=>{
      if(editorDirty && !confirm("当前故事有未保存修改。切换会丢弃这些未保存内容，继续吗？")){
        storySelect.value=selectedStoryId();return;
      }
      localStorage.setItem(STORY_SELECTED_KEY,storySelect.value);
      editorDirty=false;loadEditor();ta.value=editorText;
      const now=currentStory();
      if(storyNameEl)storyNameEl.textContent=now.name;
      const wc=$id("xjn-word-count");if(wc)wc.textContent=`${editorText.length.toLocaleString()} 字 · 已保存`;
    };
  }
  const quickNew=$id("xjn-story-new-quick");
  if(quickNew)quickNew.onclick=()=>{
    const name=prompt("新故事名称：","新故事");if(!name)return;
    const id=`story_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
    const l=storyLibrary();l.push({id,name:name.trim()||"新故事",updatedAt:Date.now()});saveStoryLibrary(l);
    setStoryData(id,{editor:"",importedBook:null});localStorage.setItem(STORY_SELECTED_KEY,id);
    editorText="";editorDirty=false;ta.value="";
    if(storyNameEl)storyNameEl.textContent=name.trim()||"新故事";
    storySelect.innerHTML=l.map(s=>`<option value="${esc(s.id)}" ${s.id===id?"selected":""}>${esc(s.name)}</option>`).join("");
    const wc=$id("xjn-word-count");if(wc)wc.textContent="0 字 · 已保存";
  };
  renderIntegrationStrip();
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
  runFastToolbarAction($id("xjn-chapters"), "扫描章节…", () => openChapterNavigator(screen, ta));
  runFastToolbarAction($id("xjn-appearance"), "打开中…", () => openAppearance(screen));
  runFastToolbarAction($id("xjn-local-worldbook"), "打开中…", () => openLocalWorldbookEditor());
  runFastToolbarAction($id("xjn-database"), "打开中…", () => openDatabaseManager());
  const liteBtn=$id("xjn-lite-mode");
  if(liteBtn){
    const key=`${BASE_KEY}__lite_ui`;
    const paint=()=>{liteBtn.textContent=localStorage.getItem(key)==="1"?"轻量模式 ●":"轻量模式 ○";};
    paint();
    liteBtn.onclick=()=>{
      const v=localStorage.getItem(key)!=="1";
      localStorage.setItem(key,v?"1":"0");
      paint();
      screen.classList.toggle("xjn-lite-ui",v);
      toastr.success(v?"已开启轻量模式":"已关闭轻量模式","续写鸡 NEXT");
    };
    screen.classList.toggle("xjn-lite-ui",localStorage.getItem(key)==="1");
  }
  runFastToolbarAction($id("xjn-restore-import"), "恢复中…", () => restoreImportedBook(ta));

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
  runFastToolbarAction($id("xjn-save"), "保存中…", async () => {
    editorText = stripNewContentMarker(ta.value);
    saveEditor();
    toastr.success("正文已正式保存", "续写鸡 NEXT");
  });

  let inputRaf=0;
  ta.addEventListener("input", () => {
    editorText = stripNewContentMarker(ta.value);
    editorDirty = true;
    if(inputRaf)cancelAnimationFrame(inputRaf);
    inputRaf=requestAnimationFrame(()=>{
      inputRaf=0;
      const wc=$id("xjn-word-count");
      if(wc)wc.textContent=`${editorText.length.toLocaleString()} 字 · 未保存`;
    });
  });

  runFastToolbarAction($id("xjn-generate"), "生成中…", async () => {
    editorText = stripNewContentMarker(ta.value);
    editorDirty = true;
    if (targetInput) {
      getSettings().targetChars = Math.max(200, Math.min(20000, Number(targetInput.value) || 2000));
      saveSettingsDebounced();
    }
    await generateContinuation($id("xjn-direction").value);
    if ($id("xjn-editor-text")) {
      $id("xjn-editor-text").value = editorDisplayText();
      $id("xjn-editor-text").scrollTop = $id("xjn-editor-text").scrollHeight;
    }
  });

  runFastToolbarAction($id("xjn-summary"), "总结中…", async () => {
    editorText = stripNewContentMarker(ta.value);
    editorDirty = true;
    await summarizeText(editorText, `手动总结 ${new Date().toLocaleString()}`);
    toastr.success("总结已加入长期记忆", "续写鸡 NEXT");
  });

  runFastToolbarAction($id("xjn-export"), "导出中…", async () => {
    editorText = stripNewContentMarker(ta.value);
    const blob = new Blob([editorText], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    const href = URL.createObjectURL(blob);
    a.href = href;
    a.download = `${currentStory().name || "续写鸡_NEXT_正文"}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(()=>URL.revokeObjectURL(href), 1500);
  });

  renderEditor();
  updateBusy();

  // 只滚到末尾，不自动抢占输入焦点；Android WebView 上自动唤起 IME 会拖慢顶部按钮响应。
  requestAnimationFrame(() => {
    ta.scrollTop = ta.scrollHeight;
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
  $id("xjn-set-tail").value=s.maxEditorTail;$id("xjn-set-tail").onchange=e=>{s.maxEditorTail=Math.max(6000,Number(e.target.value)||12000);saveSettingsDebounced();};
  $id("xjn-open-editor").onclick=openEditor;$id("xjn-open-worldbook").onclick=openNativeWorldbook;$id("xjn-open-memory").onclick=openMemory;$id("xjn-open-rp").onclick=openRP;$id("xjn-open-template").onclick=openTemplate;$id("xjn-open-diag").onclick=openDiagnostics;
  $id("xjn-export-all").onclick=()=>{loadEditor();exportAll();};
  $id("xjn-import-all").onchange=async e=>{try{await importAll(e.target.files[0]);toastr.success("完整备份已导入","续写鸡 NEXT");}catch(err){toastr.error(String(err.message||err),"导入失败");}};
}

// Public API for other ST scripts
window.XuXieJiNEXT = {version:VERSION,on,once,off,emit,getRP,setRP,getDamage,setDamage,worldbook,memories,renderTemplate,selfCheck,openEditor,openDiagnostics,generateContinuation};

jQuery(async()=>{
  extension_settings[EXT]={...DEFAULT_SETTINGS,...(extension_settings[EXT]||{})};
  if (!extension_settings[EXT]._v104Migrated) {
    extension_settings[EXT].maxEditorTail = Math.max(12000, Number(extension_settings[EXT].maxEditorTail) || 0);
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
