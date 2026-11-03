/**
 * 项目知识库面板。
 *
 * ── 它解决什么问题 ────────────────────────────────────────────────────
 * 「每轮 AI 执行完把当前工程沉淀进知识库，每个项目独立」这个功能，如果没有任何界面，
 * 就是**完全不可见的**：用户不知道沉淀有没有在工作、攒了多少、记了什么、能不能删。
 * 一个看不见的自动功能等于不存在 —— 出了问题也没人发现。
 *
 * ── 三条界面纪律 ───────────────────────────────────────────────────────
 *
 * 1. **空知识库不是错误。** 刚装/刚开的工程本来就没有沉淀，这时要显示引导
 *    （「AI 每执行完一轮就会自动记到这里」），而不是红条或错误码。
 *
 * 2. **项目是按 key 分片的，不是按名字。** 列表里显示工程名，但所有查询用 `key`
 *    （目录名，含路径 hash）。两个同名工程会各占一行、各有各的记忆 ——
 *    界面上要能看出这一点（名字后面标出路径哈希），否则用户会以为「怎么重复了」。
 *
 * 3. **渲染失败不能让面板白屏。** 整个面板的渲染包在 try/catch 里，最差也要显示
 *    「读取知识库失败 + 原因」，而不是一片空白（白屏在排查时等于没有任何信息）。
 */

import { el, button } from "../core/dom.ts";
import { I } from "../ui/icons.ts";
import { info, warn } from "../ui/toast.ts";
import { store } from "../core/store.ts";
import {
  knowledgeAvailable,
  knowledgeList,
  knowledgeProject,
  knowledgeRootPath,
  type KnowledgeProjectEntry,
  type KnowledgeRound
} from "../core/host.ts";

/** 当前展开的项目 key（模块级：切面板后还停在同一项目上）。 */
let activeKey = "";
/** 上次拉到的列表（避免每次重画都打一次 IPC）。 */
let lastProjects: KnowledgeProjectEntry[] = [];
/**
 * 上一次渲染注册的「知识库已更新」监听器卸载函数。
 *
 * ⚠ 声明必须在 renderKnowledgePanel 之前：用 `let` 声明在模块底部、却在上方函数里引用，
 * 会命中**暂时性死区**（TDZ）—— 第一次渲染就抛 ReferenceError，且只在"打开知识库面板"时触发，
 * 很容易被当成"面板坏了"。所以放在最上面。
 */
let previousSettledListener: (() => void) | null = null;

/**
 * 渲染知识库面板。
 * @param host 挂载点
 * @param onRepaint 外壳注入的重画请求
 */
export function renderKnowledgePanel(host: HTMLElement, onRepaint?: () => void): void {
  const repaint = onRepaint ?? (() => {});
  host.replaceChildren();

  const wrap = el("div", { class: "kb-panel" });
  host.appendChild(wrap);

  // 网页版没有本地磁盘：整个功能不可用。**明确说明**而不是显示空列表 —
  // 空列表会被理解成"没有沉淀"，而实际是"这个宿主根本没有这个能力"。
  if (!knowledgeAvailable()) {
    wrap.appendChild(
      el(
        "div",
        { class: "hint kb-empty" },
        "知识库需要本地磁盘：网页版读不到 %APPDATA%，请用桌面客户端（BWE Studio.exe）。\n"
        + "AI 的每轮沉淀只写在桌面版本机，不会上传到任何服务器。"
      )
    );
    return;
  }

  const head = el("div", { class: "row tight" });
  head.appendChild(el("div", { class: "group-label" }, "项目知识库"));
  head.appendChild(el("div", { class: "spacer" }));
  // 「每轮自动沉淀」这条规则要写出来：用户否则不知道这些条目是哪来的。
  const autoHint = el("span", { class: "kb-auto-hint" }, "每轮 AI 执行完自动记录");
  head.appendChild(autoHint);
  wrap.appendChild(head);

  const list = el("div", { class: "kb-list" });
  const detail = el("div", { class: "kb-detail" });
  wrap.appendChild(list);
  wrap.appendChild(detail);

  /** 拉列表并重画（每次打开面板 / 沉淀事件后调用）。 */
  async function refresh(): Promise<void> {
    try {
      const res = await knowledgeList();
      if (!res.ok && res.error) {
        // 失败要说清原因：知识库坏了不该看起来像"空的"。
        list.replaceChildren(el("div", { class: "hint kb-error" }, `读取知识库失败：${res.error}`));
        return;
      }
      lastProjects = res.projects;
      renderList(res.root ?? "");
      // 之前选中的项目如果还在，继续显示它；否则展开第一个（用户少一次点击）
      const stillThere = lastProjects.some((p) => p.key === activeKey);
      if (!stillThere) activeKey = lastProjects[0]?.key ?? "";
      if (activeKey) await renderDetail(activeKey);
      else renderDetailEmpty();
    } catch (e) {
      list.replaceChildren(el("div", { class: "hint kb-error" }, `读取知识库失败：${(e as Error).message}`));
    }
  }

  function renderList(root: string): void {
    list.replaceChildren();
    if (!lastProjects.length) {
      list.appendChild(
        el(
          "div",
          { class: "hint kb-empty" },
          "还没有任何项目沉淀。\n"
          + "在编辑器里打开工程并让 AI 跑一轮，这一轮就会自动记进来（改了什么脚本、什么被拒绝、结论是什么）。"
        )
      );
      return;
    }

    for (const p of lastProjects) {
      const row = el("button", {
        type: "button",
        class: "kb-row" + (p.key === activeKey ? " active" : ""),
        title: p.file || `${p.name}（无磁盘路径）`
      });
      row.dataset.kbKey = p.key;

      const title = el("span", { class: "kb-row-name" }, p.name);
      row.appendChild(title);

      // 路径哈希后缀：同名工程靠它区分。不显示的话用户会以为列表重复了。
      if (p.file) {
        const hash = p.key.split("-").pop() ?? "";
        row.appendChild(el("span", { class: "kb-row-hash" }, `#${hash.slice(0, 4)}`));
      } else {
        row.appendChild(el("span", { class: "kb-row-hash" }, "本地"));
      }

      const meta = el("span", { class: "kb-row-meta" }, `${p.roundCount} 轮 · ${p.pointCount} 条`);
      row.appendChild(meta);

      row.addEventListener("click", () => {
        if (activeKey === p.key) return;
        activeKey = p.key;
        renderList(root);
        void renderDetail(p.key);
      });
      list.appendChild(row);
    }

    // 打开知识库目录：用户要能直接看到/备份这些 markdown 与 jsonl 文件。
    if (root) {
      const foot = el("div", { class: "row tight kb-foot" });
      foot.appendChild(
        button(
          "打开知识库文件夹",
          () => {
            void (async () => {
              const r = await knowledgeRootPath();
              if (!r) {
                warn("拿不到知识库目录");
                return;
              }
              // 走已有的「在资源管理器里显示」通道（网页版没有，按可选调用）
              const h = (window as unknown as { bweHost?: { revealInExplorer?: (p: string) => Promise<void> } }).bweHost;
              if (h?.revealInExplorer) void h.revealInExplorer(r);
              else info(`知识库目录：${r}`);
            })();
          },
          { size: "sm", variant: "ghost", iconPath: I.explorer, title: root }
        )
      );
      list.appendChild(foot);
    }
  }

  function renderDetailEmpty(): void {
    detail.replaceChildren();
    detail.appendChild(el("div", { class: "hint" }, "选一个项目，看它沉淀了什么。"));
  }

  async function renderDetail(key: string): Promise<void> {
    detail.replaceChildren();
    const loading = el("div", { class: "hint" }, "读取中…");
    detail.appendChild(loading);
    try {
      const res = await knowledgeProject(key, 80);
      detail.replaceChildren();
      if (!res.ok && res.error) {
        detail.appendChild(el("div", { class: "hint kb-error" }, `读取失败：${res.error}`));
        return;
      }
      const project = lastProjects.find((p) => p.key === key);
      const idx = res.index ?? {};

      const headBox = el("div", { class: "kb-detail-head" });
      headBox.appendChild(el("div", { class: "kb-detail-name" }, project?.name ?? idx.name ?? key));
      const facts: string[] = [];
      if (project?.file || idx.file) facts.push(`工程文件：${project?.file || idx.file}`);
      else facts.push("无磁盘路径（示例/未保存工程，只按工程名归档）");
      facts.push(`累计 ${res.rounds.length} 轮（显示上限 80）· 最近更新 ${String(idx.updatedAt ?? "—").replace("T", " ").slice(0, 16)}`);
      headBox.appendChild(el("div", { class: "hint" }, facts.join("\n")));
      detail.appendChild(headBox);

      if (!res.rounds.length) {
        detail.appendChild(
          el(
            "div",
            { class: "hint" },
            "这个项目还没有可读的记录。\n"
            + "注意：坏行会被跳过（JSONL 容错），所以「这里显示的条数少于 index 的 roundCount」是正常的。"
          )
        );
        return;
      }

      const roundsBox = el("div", { class: "kb-rounds" });
      for (const r of res.rounds) roundsBox.appendChild(renderRound(r));
      detail.appendChild(roundsBox);
    } catch (e) {
      detail.replaceChildren();
      detail.appendChild(el("div", { class: "hint kb-error" }, `读取失败：${(e as Error).message}`));
    }
  }

  function renderRound(r: KnowledgeRound): HTMLElement {
    const box = el("div", { class: "kb-round" });
    const row = el("div", { class: "kb-round-head" });
    // 时间显示到分钟就够（秒对用户没有意义，反而占地方）
    row.appendChild(el("span", { class: "kb-round-time" }, String(r.at ?? "").replace("T", " ").slice(0, 16)));
    row.appendChild(el("span", { class: "kb-round-sum" }, r.summary || "（无概括）"));
    if (r.stopReason) {
      // 异常收尾要显眼：这些轮往往"没正常完成"，是下次要避开的形态
      const tag = el("span", { class: "kb-tag warn" }, String(r.stopReason));
      row.appendChild(tag);
    }
    if (r.meaningful === false) {
      row.appendChild(el("span", { class: "kb-tag" }, "无要点"));
    }
    box.appendChild(row);

    const ul = el("ul", { class: "kb-points" });
    for (const p of r.points ?? []) ul.appendChild(el("li", null, p));
    if (!r.points?.length) ul.appendChild(el("li", { class: "hint" }, "（这一轮没有提取到要点）"));
    box.appendChild(ul);
    return box;
  }

  void refresh();

  /**
   * 沉淀事件到达时刷新：用户正开着知识库面板时，能直接看到新的一轮"长"出来。
   *
   * ⚠ **必须每次渲染前先摘掉上一个监听器**。
   * `renderKnowledgePanel` 会被反复调用（切标签、沉淀事件、面板重画），
   * 每次都 addEventListener 而不移除 = 监听器无限累积 → 一次沉淀触发 N 次全量刷新
   * → 越用越卡（本仓库历史上「编辑器开久了变卡」正是这类累积源）。
   * 所以卸载旧监听、注册新监听，一对一。
   */
  previousSettledListener?.();
  const onSettled = (): void => {
    void refresh();
  };
  window.addEventListener("bwe:knowledge-updated", onSettled);
  previousSettledListener = () => window.removeEventListener("bwe:knowledge-updated", onSettled);
}
