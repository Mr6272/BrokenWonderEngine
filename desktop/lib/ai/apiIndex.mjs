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
      const scored = [];
      for (const doc of list) {
        const hay = `${doc.name} ${doc.signature} ${doc.desc} ${GROUP_LABELS[doc.group] ?? ""} ${doc.group}`.toLowerCase();
        if (!words.every((w) => hay.includes(w))) continue;
        // 名字整词命中排前面，其次名字前缀，再其次说明命中。
        let score = 0;
        const q = words.join(" ");
        if (doc.name.toLowerCase() === q) score += 100;
        if (doc.name.toLowerCase().includes(words[0])) score += 40;
        if (words.every((w) => doc.name.toLowerCase().includes(w))) score += 20;
        if (doc.phase2) score -= 3; // Phase 2 占位 API 排后面（现在调用不会有行为）
        scored.push({ doc, score });
      }
      scored.sort((a, b) => b.score - a.score || a.doc.name.localeCompare(b.doc.name));
      return scored.slice(0, Math.max(0, Math.min(limit, 5))).map((x) => x.doc);
    },

    /** 把命中的几条渲染成给模型看的紧凑文本（省 token：不要 JSON 缩进）。 */
    async render(query, limit = 5) {
      const hits = await this.search(query, limit);
      if (!hits.length) {
        return `未找到匹配「${query}」的 API。可能名字不完整，换用更短的关键词（例如只要 "camera" 或 "world"）。`;
      }
      const lines = [`SearchApi("${query}") → ${hits.length} 条（库内共 ${(await ensure()).length} 条���：`];
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
