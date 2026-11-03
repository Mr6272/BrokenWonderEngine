/**
 * 工程脚本的**写操作内核**（纯逻辑，不碰 DOM、不碰 store）。
 *
 * ── 为什么要有这一层 ────────────────────────────────────────────────────
 * 需求是「让 AI 拥有全部修改脚本的权限」。但工程脚本的权威副本是**渲染侧内存里的
 * Project 对象**（`store.project.scripts[name].source`），磁盘上的 `.bwproj` 只是导出物，
 * `web/examples/<工程>/scripts/*.js` 只是给 VS Code 用的镜像。所以「AI 改脚本」不能只
 * 在主进程改文件 —— 那会和编辑器内存分叉，用户看到的是「AI 说改好了，界面没变」，
 * 下次保存还会把 AI 的改动覆盖掉。
 *
 * 因此写操作被拆成两半：
 *   · 主进程/工具侧：决定**改哪个脚本、改成什么**（并做参数校验）
 *   · 渲染侧（本文件）：在权威副本上执行，并把「谁在用这个脚本」算清楚
 *
 * 把规则放在纯函数里，是为了让**安全边界可单测**（`verify-script-ops.ts`）：
 * 名字校验、越界、引用检查、行级补丁定位，这些出错都是「悄悄改坏用户工程」，
 * 靠人眼看 diff 是看不出来的。
 *
 * ── 安全边界（三条，全部有对应断言）────────────────────────────────────
 * 1. **只允许工程内脚本**：目标是 `Project.scripts` 的 key，不是任意文件路径。
 *    没有 `../`、没有绝对路径、没有别的目录 —— 这一层根本不接受路径参数。
 * 2. **删除前必须查引用**：脚本被场景 `onStartScript` 或对象模块引用时，
 *    不静默删除，而是拒绝并要求先解引用（否则工程打开后运行期找不到脚本）。
 * 3. **补丁必须能唯一定位**：`PatchScript` 按「原文片段」替换，
 *    片段找不到 / 命中多处 → 失败并说明原因，**绝不猜**该改哪一处。
 */

import { defaultScriptFile, type Project, type ScriptEntry, type ScriptLang } from "./model.ts";

// ============================================================================
// 名字与语言
// ============================================================================

/** 脚本名允许的形态：字母数字中文下划线横线空格点，2~40 字；不含路径分隔符。 */
const NAME_RE = /^[\p{L}\p{N}_\- .]{1,40}$/u;

/**
 * 校验脚本名是否可用于**新建**。
 *
 * 为什么不用「safer 的文件名」那套正则（如 `[A-Za-z0-9_-]`）：BWE 的脚本名是中文的
 *（「扫雷」「脚本 1」），而且它**不是文件名** —— 导出时由 `ScriptEntry.file` 决定路径。
 * 用文件系统规则校验会把用户/模型常用的中文名全判非法。
 *
 * @returns 错误说明；合法时返回 null。
 */
export function validateScriptName(name: unknown): string | null {
  const raw = String(name ?? "").trim();
  if (!raw) return "脚本名不能为空";
  if (raw.length > 40) return `脚本名太长（${raw.length} 字，上限 40）`;
  if (/[\\/]/.test(raw)) return "脚本名不能包含 / 或 \\（它是工程内的 key，不是路径）";
  if (raw === "." || raw === "..") return "脚本名不能是 . 或 ..";
  if (!NAME_RE.test(raw)) return "脚本名只能包含文字（含中文）、数字、空格、下划线、横线、点";
  return null;
}

/** 规范化脚本名（去首尾空白）。工具侧与渲染侧用同一个函数，避免两边判定不同。 */
export function normalizeScriptName(name: unknown): string {
  return String(name ?? "").trim();
}

/** 解析语言入参：只认 "js" / "yarn"，其余按 "js"（脚本写权限的主要用途是 JS）。 */
export function normalizeScriptLang(lang: unknown, fallback: ScriptLang = "js"): ScriptLang {
  return lang === "yarn" ? "yarn" : lang === "js" ? "js" : fallback;
}

/**
 * 按语言取导出用的相对路径。
 *
 * ⚠ 直接转发 `model.ts` 的 `defaultScriptFile`，**不在这里重写一遍规则**：
 * 导出路径是「工程文件格式」的一部分，抄第二份必然分叉（一处改了另一处忘改，
 * 表现为「某些脚本导出后文件名不对」，且只有真导出时才发现）。
 */
export function scriptFileFor(name: string, lang: ScriptLang): string {
  return defaultScriptFile(name, lang);
}

// ============================================================================
// 引用关系
// ============================================================================

/** 一处「谁在用这个脚本」的引用。 */
export interface ScriptRef {
  /** 场景名 */
  scene: string;
  /** 引用方式 */
  kind: "sceneStartScript" | "objectModule";
  /** 对象名（kind=objectModule 时有效） */
  object?: string;
  /** 模块定义 id（kind=objectModule 时有效） */
  moduleId?: string;
}

/**
 * 找出工程里所有引用该脚本的位置。
 *
 * 为什么删除前必须查：`scripts[name]` 被删掉后，场景 `onStartScript` 与对象的
 * `script.js` 模块里仍存着这个名字 —— 工程能打开、不报错，**一运行就是空引用**。
 * 这类问题在编辑器里看不出来，只有跑起来才发现「脚本没执行」。
 */
export function findScriptRefs(project: Project | null, name: string): ScriptRef[] {
  const target = normalizeScriptName(name);
  if (!project || !target) return [];
  const out: ScriptRef[] = [];

  for (const scene of project.scenes ?? []) {
    if (normalizeScriptName(scene.onStartScript) === target) {
      out.push({ scene: scene.name, kind: "sceneStartScript" });
    }
    for (const obj of scene.objects ?? []) {
      for (const m of obj.modules ?? []) {
        // 脚本名的存法在历史数据里有两种 key（见 aiPanel 的 scriptsOfScene）：
        // 统一读两种，否则「看起来没人引用」的脚本被删掉后运行期才炸。
        const s = m.values?.["script"] ?? m.values?.["scriptName"];
        if (typeof s === "string" && normalizeScriptName(s) === target) {
          out.push({ scene: scene.name, kind: "objectModule", object: obj.name, moduleId: m.defId });
        }
      }
    }
  }
  return out;
}

// ============================================================================
// 写操作结果
// ============================================================================

/**
 * 一次写操作的结果。
 *
 * `ok:false` 是**业务拒绝**（名字非法 / 脚本不存在 / 有引用 / 补丁定位失败），
 * 不是异常 —— 工具层要把 `error` 原样给模型看，让它自己纠正，而不是抛到对话外层。
 */
export interface ScriptOpResult {
  ok: boolean;
  /** 给人/模型看的结论（成功时说明改了什么，失败时说清为什么） */
  message: string;
  /** 失败原因分类（模型据此选下一步动作；成功时不带） */
  reason?:
    | "invalid-name"
    | "exists"
    | "not-found"
    | "in-use"
    | "patch-no-match"
    | "patch-ambiguous"
    | "no-project";
  /** 改动后的脚本名 */
  name?: string;
  /** 改动是否真的发生了（false = 幂等无变化，例如写入完全相同的内容） */
  changed?: boolean;
  /** 改动前/后的源码（供 diff 预览与撤销核对） */
  before?: string;
  after?: string;
  /** withRefs 时返回引用清单 */
  refs?: ScriptRef[];
}

// ============================================================================
// 读
// ============================================================================

/** 列出工程里全部脚本（名字 / 语言 / 行数 / 字符数），供模型先看清单再决定改哪个。 */
export function listScripts(project: Project | null): {
  name: string;
  lang: ScriptLang;
  lines: number;
  chars: number;
  file: string;
}[] {
  const scripts = project?.scripts ?? {};
  return Object.keys(scripts)
    .map((name) => {
      const s = scripts[name];
      const lang: ScriptLang = s?.lang === "js" ? "js" : "yarn";
      const src = String(s?.source ?? "");
      return {
        name,
        lang,
        lines: src ? src.split(/\r?\n/).length : 0,
        chars: src.length,
        file: String(s?.file ?? scriptFileFor(name, lang))
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "zh"));
}

/** 取一个脚本（含语言与行数）。不存在返回 null。 */
export function readScript(
  project: Project | null,
  name: unknown
): { name: string; lang: ScriptLang; file: string; source: string; lines: number } | null {
  const key = normalizeScriptName(name);
  const s: ScriptEntry | undefined = project?.scripts?.[key];
  if (!s) return null;
  const lang: ScriptLang = s.lang === "js" ? "js" : "yarn";
  const source = String(s.source ?? "");
  return {
    name: key,
    lang,
    file: String(s.file ?? scriptFileFor(key, lang)),
    source,
    lines: source ? source.split(/\r?\n/).length : 0
  };
}

// ============================================================================
// 写：整体替换
// ============================================================================

/**
 * 整体写入一个脚本（新建或覆盖）。
 *
 * @param opts.create  true = 只允许新建（已存在则拒绝）；false = 只允许覆盖；
 *                     undefined = 两者皆可（模型常用「写进去，没有就建」）。
 *
 * 为什么把 create 做成三态而不是布尔：模型很容易在「我以为它不存在」时覆盖掉
 * 用户手写的脚本。三态让它能显式表达意图，工具描述里也照着教它。
 */
export function writeScript(
  project: Project | null,
  name: unknown,
  source: unknown,
  opts: { lang?: unknown; create?: boolean } = {}
): ScriptOpResult {
  if (!project) return { ok: false, reason: "no-project", message: "没有打开的工程，无法写入脚本" };

  const key = normalizeScriptName(name);
  const bad = validateScriptName(key);
  if (bad) return { ok: false, reason: "invalid-name", message: bad };

  const exists = Boolean(project.scripts?.[key]);
  if (opts.create === true && exists) {
    return {
      ok: false,
      reason: "exists",
      name: key,
      message: `脚本「${key}」已存在（create=true 只允许新建）。要改现有脚本请用 WriteScript 且不带 create，或先用 ReadScript 读它。`
    };
  }
  if (opts.create === false && !exists) {
    return {
      ok: false,
      reason: "not-found",
      name: key,
      message: `脚本「${key}」不存在（create=false 只允许覆盖）。新建请带 create=true。`
    };
  }

  const text = typeof source === "string" ? source : String(source ?? "");
  if (!text) return { ok: false, reason: "invalid-name", name: key, message: "source 为空，拒绝写入空脚本" };

  const before = exists ? String(project.scripts[key].source ?? "") : "";
  // 语言：已有脚本一律沿用它的语言（改脚本时不该顺手把它从 yarn 变成 js）；
  // 新建时用传入值，缺省 js。
  const lang: ScriptLang = exists
    ? (project.scripts[key].lang === "js" ? "js" : "yarn")
    : normalizeScriptLang(opts.lang, "js");

  // 导出路径：已有脚本沿用它的 file（用户可能改过导出目录，不能擅自覆盖）；
  // 新建时按语言生成默认路径。
  const file = exists
    ? String(project.scripts[key].file ?? "") || scriptFileFor(key, lang)
    : scriptFileFor(key, lang);

  if (exists && before === text) {
    return {
      ok: true,
      changed: false,
      name: key,
      before,
      after: text,
      message: `脚本「${key}」内容未变化（写入的源码与现有内容字节相同），没有产生改动。`
    };
  }

  project.scripts[key] = {
    name: key,
    file,
    source: text,
    lang
  };

  return {
    ok: true,
    changed: true,
    name: key,
    before,
    after: text,
    message: exists
      ? `已覆盖脚本「${key}」（${lang}，${text.split(/\r?\n/).length} 行）。`
      : `已新建脚本「${key}」（${lang}，${text.split(/\r?\n/).length} 行）。`
  };
}

// ============================================================================
// 写：片段补丁
// ============================================================================

/**
 * 用「原文片段 → 新片段」做一次精确替换（模型改几行时用它，比整篇重写安全）。
 *
 * 三条纪律：
 *   1. **找不到不猜**：片段不在源码里就失败，并给出可执行下一步（先用 ReadScript 看真实内容）。
 *   2. **多处命中不猜**：命中 >1 处时失败并要求带更多上下文 —— 改错一处的后果是静默的逻辑错误。
 *   3. **空片段拒绝**：避免「把空串替换成 X」变成在文件开头插入。
 */
export function patchScript(
  project: Project | null,
  name: unknown,
  find: unknown,
  replace: unknown
): ScriptOpResult {
  if (!project) return { ok: false, reason: "no-project", message: "没有打开的工程，无法修改脚本" };

  const key = normalizeScriptName(name);
  const cur = readScript(project, key);
  if (!cur) {
    return {
      ok: false,
      reason: "not-found",
      name: key,
      message: `脚本「${key}」不存在。可先用 ListScripts 看现有脚本清单，或用 WriteScript 带 create=true 新建。`
    };
  }

  const findText = typeof find === "string" ? find : "";
  if (!findText.trim()) {
    return {
      ok: false,
      reason: "patch-no-match",
      name: key,
      message: "find 为空。补丁必须给出要被替换的原文片段（含足够上下文，确保只命中一处）。"
    };
  }
  const replaceText = typeof replace === "string" ? replace : String(replace ?? "");

  const before = cur.source;
  // 行尾归一：工程里可能是 CRLF，而模型给的片段通常用 \n。
  // 只对**比较**归一，写回时仍用原文的行尾风格（否则整篇会被改行尾，diff 变噪音）。
  const norm = (s: string): string => s.replace(/\r\n/g, "\n");
  const hay = norm(before);
  const needle = norm(findText);

  const count = hay.split(needle).length - 1;
  if (count === 0) {
    return {
      ok: false,
      reason: "patch-no-match",
      name: key,
      message:
        `在脚本「${key}」里找不到 find 片段。`
        + "请先用 ReadScript 读真实内容（缩进/行尾/注释都可能与你记忆里的不同），再照抄一段原文过来。"
    };
  }
  if (count > 1) {
    return {
      ok: false,
      reason: "patch-ambiguous",
      name: key,
      message:
        `find 片段在脚本「${key}」里命中 ${count} 处，无法确定要改哪一处。`
        + "请把 find 扩成带更多上下文的片段（例如连带上一行缩进或函数名），确保只命中 1 处。"
    };
  }

  const idx = hay.indexOf(needle);
  // 用归一后的文本做拼接，再还原原行尾风格 —— 保证除目标片段外一个字节都不动。
  const afterNorm = hay.slice(0, idx) + norm(replaceText) + hay.slice(idx + needle.length);
  const crlf = /\r\n/.test(before);
  const after = crlf ? afterNorm.replace(/\n/g, "\r\n") : afterNorm;

  if (after === before) {
    return {
      ok: true,
      changed: false,
      name: key,
      before,
      after,
      message: `脚本「${key}」补丁命中，但替换结果与原文相同（无实质改动）。`
    };
  }

  project.scripts[key].source = after;
  return {
    ok: true,
    changed: true,
    name: key,
    before,
    after,
    message: `已修改脚本「${key}」：替换 1 处（${needle.split("\n").length} 行 → ${norm(replaceText).split("\n").length} 行）。`
  };
}

// ============================================================================
// 写：删除
// ============================================================================

/**
 * 删除一个脚本。
 *
 * ⚠ **有引用时默认拒绝**（不是警告后照删）：删掉被场景/对象引用的脚本，
 * 工程仍能打开、不报错，但一运行就是空引用 —— 这类事故在编辑器里不可见。
 * 要真的删，必须显式 `force:true`（工具描述里要求模型先向用户确认）。
 */
export function deleteScript(
  project: Project | null,
  name: unknown,
  opts: { force?: boolean } = {}
): ScriptOpResult {
  if (!project) return { ok: false, reason: "no-project", message: "没有打开的工程，无法删除脚本" };

  const key = normalizeScriptName(name);
  if (!project.scripts?.[key]) {
    return {
      ok: false,
      reason: "not-found",
      name: key,
      message: `脚本「${key}」不存在。可先用 ListScripts 看现有脚本清单。`
    };
  }

  const refs = findScriptRefs(project, key);
  if (refs.length && opts.force !== true) {
    const where = refs
      .slice(0, 6)
      .map((r) =>
        r.kind === "sceneStartScript"
          ? `场景「${r.scene}」的场景脚本`
          : `场景「${r.scene}」的对象「${r.object ?? "?"}」(${r.moduleId ?? "?"})`
      )
      .join("、");
    return {
      ok: false,
      reason: "in-use",
      name: key,
      refs,
      message:
        `脚本「${key}」仍被 ${refs.length} 处引用（${where}${refs.length > 6 ? " 等" : ""}），拒绝删除。`
        + "请先在这些位置解引用（把场景脚本/对象模块里的脚本名清空或指向别的脚本），或向用户确认后带 force=true。"
    };
  }

  const before = String(project.scripts[key].source ?? "");
  delete project.scripts[key];
  return {
    ok: true,
    changed: true,
    name: key,
    before,
    refs,
    message: refs.length
      ? `已删除脚本「${key}」（force=true，仍有 ${refs.length} 处引用未解，运行期会找不到脚本）。`
      : `已删除脚本「${key}」。`
  };
}

// ============================================================================
// 供工具层直接复用的一句话清单（省 token：模型先看清单再决定）
// ============================================================================

/** 脚本清单摘要（每行一条，含行数）。没有脚本时给出可执行下一步。 */
export function describeScriptList(project: Project | null): string {
  const list = listScripts(project);
  if (!list.length) {
    return "工程里还没有任何脚本。可以用 WriteScript 带 create=true 新建一个（lang=js，source 给完整源码）。";
  }
  const lines = [`工程「${project?.name ?? "未命名工程"}」共 ${list.length} 个脚本：`];
  for (const s of list) {
    lines.push(`- ${s.name}（${s.lang}，${s.lines} 行 / ${s.chars} 字符）→ ${s.file}`);
  }
  return lines.join("\n");
}
