/**
 * AI 层 · 本地零 token 路由。
 *
 * 为什么要在本地判定：每发一次 LLM 调用，光 system prompt + 工具定义就要几千 token。
 * 「你好」「这个字段叫什么」这类问题用 pro 模型是纯浪费；而「重构这段脚本」「为什么
 * 掉帧」这类问题用 flash 又会多来回两轮。所以先用一张关键词表 + 长度做一次**纯本地**
 * 判断，不产生任何网络请求 —— 这正是 deepx「零延迟、零 token 起手」的做法。
 *
 * 判定顺序（先命中先返回）：
 *   1. 显式锁定（manualModel / intent 指定的模型）；
 *   2. pro 关键词（中英双语）→ pro；
 *   3. flash 关键词 + 足够短 → flash；
 *   4. 长度兜底：长文本默认 pro，很短默认 flash。
 *
 * 本文件不 import 任何 Electron / 网络模块，可以单独 node 跑单测。
 */

const PRO_KEYWORDS = [
  // 中文
  "重构", "架构", "设计", "排查", "为什么", "原因", "根因", "分析", "性能", "优化", "掉帧", "卡顿",
  "内存泄漏", "崩溃", "报错", "错误", "失败", "修复", "审查", "评审", "多文件", "整体", "全工程",
  "方案", "对比", "取舍", "复杂度", "并发", "线程", "算法", "实现一个", "写一个", "生成代码", "补全",
  "迁移", "改造", "梳理", "解释一下", "怎么才能", "如何保证", "边界情况", "测试", "单测",
  // 英文
  "refactor", "architect", "architecture", "design", "debug", "why", "root cause", "profile",
  "performance", "optimi", "leak", "crash", "error", "fix", "review", "multi-file", "whole repo",
  "tradeoff", "complexity", "concurrency", "algorithm", "implement", "migrate", "plan", "explain",
  "edge case", "test", "unit test", "panic", "stack trace"
];

const FLASH_KEYWORDS = [
  // 中文
  "你好", "您好", "hi", "hello", "在吗", "谢谢", "这是什么", "这个字段", "叫什么", "怎么拼",
  "在哪", "快捷键", "怎么打开", "说明", "一句话", "简单说", "格式", "语法", "示例", "列出",
  "改名", "重命名", "翻译", "颜色", "字体", "按钮",
  // 英文
  "thanks", "rename", "what is", "shortcut", "where is", "format", "syntax", "example",
  "list", "translate", "color", "font", "button", "hi"
];

/** 超过这个字符数就当复杂任务（中英混合下 ~1 字符 ≈ 0.6 token）。 */
const LONG_CHARS = 480;
/** 低于这个字符数且没命中 pro 关键词时，可以放心走 flash。 */
const SHORT_CHARS = 48;

export const ROUTER_VERSION = "bwe-router-v1";

function textOf(request) {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  // 只看最近一条用户消息 + 上一轮摘要：再往前的历史已经被摘要过，不代表本轮复杂度。
  return messages
    .slice(-2)
    .map((m) => String(m?.text ?? ""))
    .join("\n");
}

function contextText(request) {
  const ctx = request?.context ?? {};
  const parts = [];
  if (ctx.sceneDigest) parts.push(String(ctx.sceneDigest));
  if (ctx.activeScript?.code) parts.push(String(ctx.activeScript.code));
  if (Number(ctx.diagnostics?.errors ?? 0) > 0) parts.push("有脚本错误");
  return parts.join("\n");
}

function matches(text, keywords) {
  const lower = text.toLowerCase();
  return keywords.find((k) => lower.includes(k.toLowerCase())) ?? null;
}

/**
 * 纯本地路由。
 *
 * @param {{messages?: {role:string,text:string}[], intent?: string, context?: object}} request
 * @param {{autoRoute?: boolean, manualModel?: ""|"flash"|"pro", thresholdHint?: number}} [options]
 * @returns {{model:"flash"|"pro", reason:string, localOnly:true, signals:string[]}}
 */
export function routeModel(request, options = {}) {
  const autoRoute = options.autoRoute !== false;
  const manual = options.manualModel ?? "";

  // 意图优先：这些意图本身就需要更强推理，不受关键词影响。
  const intentModel = intentToModel(request?.intent);
  if (manual === "flash" || manual === "pro") {
    return done(
      manual,
      `手动锁定为 ${manual}${autoRoute ? "（自动路由已关闭）" : ""}`,
      ["manual"]
    );
  }
  if (intentModel) {
    return done(intentModel.model, intentModel.reason, intentModel.signals);
  }

  const userText = textOf(request);
  const ctxText = contextText(request);
  const all = `${userText}\n${ctxText}`;

  const proHit = matches(userText, PRO_KEYWORDS);
  if (proHit) {
    const len = userText.length;
    return done("pro", `命中复杂任务关键词「${proHit}」（本地判定，${len} 字）`, [`kw:${proHit}`]);
  }
  // 上下文里有脚本错误 / 长脚本，本身就意味着要读代码。
  if (Number(request?.context?.diagnostics?.errors ?? 0) > 0) {
    return done("pro", "上下文带脚本错误，需要读代码定位", ["diagnostics"]);
  }
  const codeLen = String(request?.context?.activeScript?.code ?? "").length;
  if (codeLen > 1200) {
    return done("pro", `当前脚本 ${codeLen} 字符，需要通读`, ["long-script"]);
  }

  const flashHit = matches(userText, FLASH_KEYWORDS.filter((k) => k !== "hi"));
  if (flashHit) {
    return done("flash", `命中轻量关键词「${flashHit}」（本地判定）`, [`kw:${flashHit}`]);
  }

  const len = userText.length;
  if (len >= LONG_CHARS) {
    return done("pro", `输入 ${len} 字，超过 ${LONG_CHARS} 字按复杂任务处理`, ["length"]);
  }
  if (len <= SHORT_CHARS) {
    return done("flash", `输入 ${len} 字，短问题走 flash`, ["length"]);
  }
  return done("flash", `输入 ${len} 字，未命中复杂关键词，先用 flash（可随时升级）`, ["default"]);

  function done(model, reason, signals) {
    return { model, reason, localOnly: true, signals };
  }
}

function intentToModel(intent) {
  if (intent === "explain-error") {
    return { model: "pro", reason: "intent=explain-error 需要读报错上下文", signals: ["intent"] };
  }
  if (intent === "edit-script") {
    return { model: "pro", reason: "intent=edit-script 要保证改动正确", signals: ["intent"] };
  }
  if (intent === "scene-review") {
    return { model: "pro", reason: "intent=scene-review 要通读工程摘要", signals: ["intent"] };
  }
  return null;
}

/** 关键词表导出给单测与设置页「路由调试」。 */
export const KEYWORDS = { pro: PRO_KEYWORDS, flash: FLASH_KEYWORDS, LONG_CHARS, SHORT_CHARS };
