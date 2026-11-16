/**
 * JS 编辑器的**代码智能客户端**（补全 / 悬浮 / 跳转定义 / 查找引用 / 编译）。
 *
 * 为什么单独一层：这五个能力都走同一条「本地语言服务」通道（网页版 `/api/*`，
 * 桌面版由 `bwe:api` 转给同一份 `api-core`），失败处理与降级策略也是同一套。
 * 如果每个能力各写一遍 fetch + catch，就会长成五份略有差异的代码 ——
 * 而它们之间任一处的差异都会表现成「补全能用、提示不能用」这类难查的不一致。
 *
 * 纪律（每条都对应一个具体失败模式）：
 *   1. **失败静默降级**：语言服务不可用时（没跑 `npm run serve`、桌面主进程还没起），
 *      编辑器必须还能正常打字。所以这里永不抛异常，只在「输出」面板留**首次**一次痕，
 *      避免每个按键都往输出里刷一行。
 *   2. **响应序号丢弃**：快速打字时会有多个请求在途，晚到的旧响应必须丢掉，
 *      否则提示框会闪回上一个位置的类型（看着像"提示不准"）。
 *   3. `offset` 一律用 `textarea.selectionStart`（UTF-16 code unit），
 *      与 TypeScript 的约定一致 —— 绝不自己按字符数算（中英混排会错位）。
 */

import { appendOutput } from "../core/output.ts";
import { apiFetch } from "../core/host.ts";

export interface CompletionEntry {
  name: string;
  kind?: string;
  detail?: string;
  docs?: string;
  insertText?: string;
}

export interface QuickInfo {
  display: string;
  docs: string;
  kind: string;
}

/** 一条引用命中（名字是**脚本名**，不是文件名）。 */
export interface ReferenceHit {
  name: string;
  /** 1 起 */
  line: number;
  /** 1 起 */
  col: number;
  text: string;
  isDefinition?: boolean;
}

export interface Diagnostic {
  line: number;
  col?: number;
  severity: "error" | "warn" | "info";
  message: string;
}

export interface ScriptFiles {
  /** 脚本名 → 源码。跨脚本能力（引用/定义）需要全部脚本，单文件能力只要当前那份。 */
  [name: string]: string;
}

/** 失败只记一次痕：语言服务是旁路能力，坏掉时不该打断任何输入。 */
let loggedOnce = false;
function traceFailure(what: string, err: unknown): void {
  if (loggedOnce) return;
  loggedOnce = true;
  const msg = err instanceof Error ? err.message : String(err);
  appendOutput("脚本语言服务", `${what}不可用，已降级（不影响编辑与保存）：${msg}`, "warn");
}

/** 统一的 POST 小工具：返回 null 表示"这条路不通，请按降级处理"。 */
async function postJson<T>(path: string, body: unknown, what: string): Promise<T | null> {
  try {
    const resp = await apiFetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!resp.ok) {
      traceFailure(what, `HTTP ${resp.status}`);
      return null;
    }
    return (await resp.json()) as T;
  } catch (e) {
    traceFailure(what, e);
    return null;
  }
}

/** 语言服务是否至少成功过一次（用于界面上"要不要显示这个按钮的提示"）。 */
let serviceSeenOk = false;
export function languageServiceReady(): boolean {
  return serviceSeenOk;
}

// ============================================================================
// 1. 补全
// ============================================================================

export async function requestCompletion(
  source: string,
  offset: number
): Promise<{ entries: CompletionEntry[]; isMemberAccess: boolean } | null> {
  const data = await postJson<{ ok?: boolean; entries?: CompletionEntry[]; isMemberAccess?: boolean; error?: string }>(
    "/api/script-complete",
    { source, offset },
    "补全"
  );
  if (!data || data.ok === false) return null;
  serviceSeenOk = true;
  return { entries: Array.isArray(data.entries) ? data.entries : [], isMemberAccess: Boolean(data.isMemberAccess) };
}

// ============================================================================
// 2. 悬浮提示
// ============================================================================

/**
 * 取光标处的类型/签名。
 *
 * 返回 null 是**正常结果**（光标在括号、空白、关键字上都没有符号），
 * 调用方据此隐藏提示框，不要当错误处理 —— 否则用户每移到空白处都会看到一次失败。
 */
export async function requestQuickInfo(source: string, offset: number): Promise<QuickInfo | null> {
  const data = await postJson<{ ok?: boolean; info?: QuickInfo | null; error?: string }>(
    "/api/script-quickinfo",
    { source, offset },
    "悬浮提示"
  );
  if (!data || data.ok === false) return null;
  serviceSeenOk = true;
  return data.info ?? null;
}

// ============================================================================
// 3. 跳转定义 / 查找引用（跨脚本）
// ============================================================================

export interface DefinitionResult {
  defs: ReferenceHit[];
  /** 服务不可用时为 false：调用方据此退回"本文件内文本搜索" */
  ok: boolean;
}

/**
 * 查找定义。
 *
 * `files` 必须是**全工程的 JS 脚本**：BWE 的脚本之间靠全局函数互相调用
 * （没有 import/require，见 docs/scripting-api.md §1），所以跨文件是常态而不是特例。
 */
export async function requestDefinition(
  files: ScriptFiles,
  active: string,
  offset: number
): Promise<DefinitionResult> {
  const data = await postJson<{ ok?: boolean; defs?: ReferenceHit[]; error?: string }>(
    "/api/script-definition",
    { files, active, offset },
    "跳转定义"
  );
  if (!data || data.ok === false) return { defs: [], ok: false };
  serviceSeenOk = true;
  return { defs: Array.isArray(data.defs) ? data.defs : [], ok: true };
}

export async function requestReferences(
  files: ScriptFiles,
  active: string,
  offset: number
): Promise<{ refs: ReferenceHit[]; ok: boolean }> {
  const data = await postJson<{ ok?: boolean; refs?: ReferenceHit[]; error?: string }>(
    "/api/script-references",
    { files, active, offset },
    "查找引用"
  );
  if (!data || data.ok === false) return { refs: [], ok: false };
  serviceSeenOk = true;
  return { refs: Array.isArray(data.refs) ? data.refs : [], ok: true };
}

// ============================================================================
// 4. 编译（诊断 + ES5 产物）
// ============================================================================

export interface CompileResult {
  ok: boolean;
  /** 语言服务是否带上了 bwe.d.ts（false 表示只做了语法检查） */
  hasTypes: boolean;
  diagnostics: Diagnostic[];
  /** 降级到 ES5 后的代码（运行期 Rhino 只认 ES5.1，见 docs/scripting-api.md §0.1） */
  transpiled: string;
}

/**
 * 编译一次脚本。
 *
 * 「编译」在 BWE 里就是**语法检查 + 降级到 ES5**这两件事（打包时做的是同一套动作）。
 * 编辑器里直接做，是为了让用户不用等打包才发现"这段 `??=` 运行期会炸"。
 */
export async function requestCompile(source: string, name: string): Promise<CompileResult | null> {
  const data = await postJson<{
    ok?: boolean;
    hasTypes?: boolean;
    diagnostics?: { line?: number; col?: number; severity?: string; message?: string }[];
    transpiled?: string;
    error?: string;
  }>("/api/js-check", { source, name }, "编译");
  if (!data) return null;
  serviceSeenOk = true;
  const diagnostics: Diagnostic[] = [];
  for (const raw of data.diagnostics ?? []) {
    if (!raw) continue;
    const sev = String(raw.severity ?? "error").toLowerCase();
    diagnostics.push({
      line: Number(raw.line) > 0 ? Number(raw.line) : 1,
      col: Number(raw.col) > 0 ? Number(raw.col) : undefined,
      severity: sev === "warn" || sev === "warning" ? "warn" : sev === "info" ? "info" : "error",
      message: String(raw.message ?? "（没有说明）")
    });
  }
  return {
    ok: data.ok !== false,
    hasTypes: Boolean(data.hasTypes),
    diagnostics,
    transpiled: String(data.transpiled ?? "")
  };
}
