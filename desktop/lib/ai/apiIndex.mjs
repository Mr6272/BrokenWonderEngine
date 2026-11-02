/**
 * AI 层 · BWE 脚本 API 索引（供 SearchApi 工具按需取）。
 *
 * 契约 §4.3 第 3 条：271 条 API 文档**不进** system prompt，改成工具按需查（一次 ≤ 5 条）。
 * 唯一事实来源是仓库里的 `web/src/data/apiDocs.ts` —— 它同时是剧本面板侧栏的数据源，
 * 所以这里**直接解析源文件**而不是抄一份 JSON：抄一份就一定会和面板分叉。
 *
 * 解析器故意做得很宽松：只认 `d("name", "signature", "desc", "group")` 这四段调用，
 * 认不出的行（注释、空行、导出语句）直接跳过。源文件改版最多让索引少几条，
 * 不会让工具报错 —— 一个用来查文档的工具自己先崩掉是最糟的。
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** 解析 apiDocs.ts 文本 → ApiDoc[]。纯函数，可单测。 */
export function parseApiDocs(source) {
  const out = [];
  // d( "name" , "signature" , "desc" , "group" [, phase2] )
  const re = /d\(\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"(?:\s*,\s*(true|false))?\s*\)/g;
  let m;
  while ((m = re.exec(source))) {
    out.push({
      name: unescapeTs(m[1]),
      signature: unescapeTs(m[2]),
      desc: unescapeTs(m[3]),
      group: m[4],
      phase2: m[5] === "true"
    });
  }
  return out;
}

function unescapeTs(s) {
  return s.replace(/\\(["'\\/])/g, "$1").replace(/\\n/g, "\n").replace(/\\t/g, "\t");
}

/** 分组的中文标签，用于搜索时按「分组名」也能命中。 */
const GROUP_LABELS = {
  life: "生命周期", world: "世界", entity: "实体", prefab: "预制", input: "输入", camera: "相机",
  time: "时间", draw: "绘制", audio: "音频", save: "存档", map: "地图", nav: "寻路",
  interact: "交互", spawner: "生成器", util: "工具", material: "材质", field: "场",
  sense: "感知", physics: "物理", scene: "场景", spatial: "空间", collision: "碰撞",
  actions: "动作", road: "道路", vehicle: "载具", combat: "战斗", debug: "调试"
};

/**
 * 建立索引（带文件内缓存；开发期文件被改后需要重启主进程，这是可接受的）。
 *
 * @param {string} apiDocsPath  apiDocs.ts 的绝对路径
 */
export function createApiIndex(apiDocsPath) {
  let docs = null;
  let loadError = null;
  /** 最近一次 search 的统计（render 用来提示「只取最相关 N 条」）。 */
  let lastQueryMeta = null;

  async function ensure() {
    if (docs) return docs;
    try {
      docs = parseApiDocs(await readFile(apiDocsPath, "utf8"));
    } catch (e) {
      docs = [];
      loadError = e?.message || String(e);
    }
    return docs;
  }

  return {
    get path() {
      return apiDocsPath;
    },
    async size() {
      return (await ensure()).length;
    },
    async error() {
      await ensure();
      return loadError;
    },

    /**
     * 模糊搜索：名字、签名、说明、分组标签都参与匹配；多词用空格分开，全部命中才算。
     * @param {string} query
     * @param {number} [limit] 契约上限 5；超过会被调用方截断，这里也兜一层
     */
    async search(query, limit = 5) {
      const list = await ensure();
      const words = String(query ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
      if (!words.length) return [];
      /**
       * 匹配语义：**按命中率排序的 OR，而不是 AND**。
       *
       * ⚠ 原来要求 `words.every(...)` —— 每个词都必须在同一条文档里出现。
       * 但模型（尤其思考模型）很自然会写一整句检索意图：
       *   SearchApi("physics collision car vehicle move") / "world findAll emit on"
       * 这 5 个词没有任何一条文档能同时含，结果是 **0 条**。
       * 实测用户那轮对话里 SearchApi 被调了 6 次、6 次全 0 —— 模型据此得出
       * 「这些 API 都不存在」，然后开始编造 API 名，最后什么都没交付。
       *
       * 正确做法：命中越多词、命中在名字里、词越少见 → 排越前；
       * 一个词都不命中的文档才排除。这样"长句子"退化成"取最相关的几条"，而不会空。
       */
      const scored = [];
      for (const doc of list) {
        const name = doc.name.toLowerCase();
        const hay = `${doc.name} ${doc.signature} ${doc.desc} ${GROUP_LABELS[doc.group] ?? ""} ${doc.group}`.toLowerCase();
        const q = words.join(" ");

        let hits = 0;
        let nameHits = 0;
        let score = 0;
        for (const w of words) {
          if (!hay.includes(w)) continue;
          hits += 1;
          if (name.includes(w)) {
            nameHits += 1;
            score += 30;
          }
          // 越少见的词越有区分度：命中在对应字段里的权重由字段位置粗略体现。
          if (doc.desc.toLowerCase().includes(w)) score += 1;
          if (`${doc.group} ${GROUP_LABELS[doc.group] ?? ""}`.toLowerCase().includes(w)) score += 4;
        }
        if (hits === 0) continue;

        // 命中率是第一排序因子：5 个词命中 4 个，必须排在命中 1 个的前面。
        const coverage = hits / words.length;
        score += coverage * 80;
        if (name === q) score += 100;
        if (name.includes(q)) score += 40;
        if (doc.phase2) score -= 3; // Phase 2 占位 API 排后面（现在调用不会有行为）
        scored.push({ doc, score, hits, coverage });
      }
      scored.sort(
        (a, b) =>
          b.hits - a.hits
          || b.score - a.score
          || a.doc.name.localeCompare(b.doc.name)
      );
      const top = scored.slice(0, Math.max(0, Math.min(limit, 5))).map((x) => x.doc);
      lastQueryMeta = { query, words, total: list.length, matched: scored.length, hits: top.length };
      return top;
    },

    async render(query, limit = 5) {
      const hits = await this.search(query, limit);
      const total = (await ensure()).length;
      if (!hits.length) {
        // 空结果也要给出**可执行的下一步**，而不是只报"没找到"。
        // 模型收到"没找到"最容易的反应就是编造 API 名 —— 必须堵住这条路。
        return `未找到匹配「${query}」的 API（库里共 ${total} 条）。`
          + "可能关键词太具体或拼写不同。**请改用 1~2 个短词重试**（例如 \"physics\" / \"collision\" / \"world\"），"
          + "仍然查不到就说明该 API 不存在，**不要凭空编造 API 名**。";
      }
      // 命中不完整的提示：长 query 常只命中一部分词，模型需要知道"这不是全部匹配"。
      const meta = lastQueryMeta;
      const partial = meta && meta.matched > hits.length
        ? `，共 ${meta.matched} 条相关，取最相关 ${hits.length} 条`
        : "";
      const lines = [`SearchApi("${query}") → ${hits.length} 条（库内共 ${total} 条${partial}）：`];
      for (const h of hits) {
        lines.push(`· ${h.signature}`);
        lines.push(`  ${h.desc}${h.phase2 ? "（Phase 2 占位，当前运行时可能无行为）" : ""}`);
      }
      return lines.join("\n");
    }
  };
}

/** 默认路径解析：仓库里 apiDocs.ts 的位置（打包后的 app 目录结构相同）。 */
export function defaultApiDocsPath(repoRoot) {
  return join(repoRoot, "web", "src", "data", "apiDocs.ts");
}
