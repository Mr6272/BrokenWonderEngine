/**
 * 问题中心（Problems）。
 *
 * 为什么单独抽一层：诊断原本分散在三个地方 —— 剧本面板的 /api/js-check、
 * Yarn 剧本的本地静态检查、打包/试跑工作台的错误提示。它们各自在弹窗或面板里
 * 露一次脸就消失了，用户改完一处不知道还剩几处。
 *
 * 这里只做「收集 + 广播」，不做解析：谁发现问题谁把结果塞进来，底部的
 * 「问题」面板统一展示、统一计数、统一跳转。
 *
 * 纪律：
 *   - 每个来源用固定 key 覆盖写入（`js:脚本名` / `yarn:剧本名` / `package` / `run`），
 *     所以同一份诊断反复检查不会越堆越多；
 *   - 只存可复现的最小字段，不存整段源码 —— 面板只负责"带我去那一行"。
 */

export type ProblemSeverity = "error" | "warn" | "info";

export interface Problem {
  /** 稳定 id：同一条诊断重算时保持不变，面板可以据此做局部更新 */
  id: string;
  severity: ProblemSeverity;
  /** 来源：脚本检查 / Yarn 检查 / 打包 / 试跑 */
  source: "js" | "yarn" | "package" | "run" | "scene";
  /** 给用户看的来源标题（例如「剧本 · player.js」） */
  sourceLabel: string;
  /** 出问题的脚本名与语言；没有就留空（打包错误这类不指向某段脚本） */
  scriptName?: string;
  scriptLang?: "js" | "yarn";
  /** 1 开始的行号；没有具体行就留空 */
  line?: number;
  col?: number;
  message: string;
}

type Listener = () => void;

const groups = new Map<string, Problem[]>();
const listeners = new Set<Listener>();

/** 整体重算一次计数，交给订阅方（状态栏徽标、面板标题）。 */
function emit(): void {
  for (const fn of Array.from(listeners)) fn();
}

/**
 * 用一组诊断覆盖某个来源的旧结果。
 * key 必须稳定（脚本改名等于换了一份文件，用新 key 是合理的）。
 */
export function setProblems(key: string, list: Problem[]): void {
  const prev = groups.get(key);
  // 内容完全一致就不广播：每次敲键都会重跑检查，无变化时不该让整棵面板树重画
  if (prev && prev.length === list.length && list.every((p, i) => sameProblem(prev[i], p))) {
    groups.set(key, list);
    return;
  }
  if (!list.length) groups.delete(key);
  else groups.set(key, list);
  emit();
}

export function clearProblems(key: string): void {
  if (!groups.has(key)) return;
  groups.delete(key);
  emit();
}

function sameProblem(a: Problem, b: Problem): boolean {
  return (
    a.severity === b.severity &&
    a.line === b.line &&
    a.col === b.col &&
    a.message === b.message &&
    a.scriptName === b.scriptName
  );
}

/** 清空全部来源（「问题」面板的「全部清空」按钮）。
 *  只清当前快照：真正的诊断由各自来源下次检查时重新写入 —— 脚本面板每敲一次
 *  都会重跑检查，所以清空是"眼不见为净"，不是"永久忽略这条错误"。 */
export function clearAllProblems(): void {
  if (!groups.size) return;
  groups.clear();
  emit();
}

export function allProblems(): Problem[] {
  const out: Problem[] = [];
  for (const list of groups.values()) out.push(...list);
  // 错误优先、其次按来源标签与行号，保证同一批数据每次刷新顺序一致
  out.sort((a, b) => {
    const rank = severityRank(a.severity) - severityRank(b.severity);
    if (rank) return rank;
    if (a.sourceLabel !== b.sourceLabel) return a.sourceLabel < b.sourceLabel ? -1 : 1;
    return (a.line ?? 0) - (b.line ?? 0);
  });
  return out;
}

export function problemCounts(): { errors: number; warns: number } {
  let errors = 0;
  let warns = 0;
  for (const list of groups.values()) {
    for (const p of list) {
      if (p.severity === "error") errors++;
      else if (p.severity === "warn") warns++;
    }
  }
  return { errors, warns };
}

export function onProblems(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function severityRank(s: ProblemSeverity): number {
  return s === "error" ? 0 : s === "warn" ? 1 : 2;
}
