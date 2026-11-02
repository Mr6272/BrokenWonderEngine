/**
 * 错误结构化展示的单测。
 *
 * 为什么必须断言：
 *   · 映射错档 → 把「我们自己客户端的缺陷」说成「你的 Key 坏了」，
 *     用户会跑去重填 Key，白折腾；
 *   · `request_id` 抽错 → 用户贴给服务商的东西是错的，排查直接卡住；
 *   · 认不出的错误乱猜 → 比原样显示更糟（会给出错误的自救动作）。
 *
 * 跑法：
 *   node node_modules/esbuild/bin/esbuild web/tools/ui-checks/verify-error-view.ts \
 *     --bundle --platform=node --format=esm --outfile=.tmp_ui/verify-error.mjs
 *   node .tmp_ui/verify-error.mjs
 */
import { presentError } from "../../src/panels/aiErrorView.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

/** 断言标题/分类等关键字段 */
function expect(raw: string, kind: string, titleHas: string, opts?: {
  retryable?: boolean; requestId?: string; rawHas?: string;
}) {
  const p = presentError(raw);
  check(`${kind}：分类正确`, p.kind === kind, `实际 ${p.kind}`);
  check(`${kind}：标题含「${titleHas}」`, p.title.includes(titleHas), p.title);
  if (opts?.retryable !== undefined) {
    check(`${kind}：retryable=${opts.retryable}`, p.retryable === opts.retryable, String(p.retryable));
  }
  if (opts?.requestId !== undefined) {
    check(`${kind}：request_id 抽出`, p.requestId === opts.requestId, `实际「${p.requestId}」`);
  }
  if (opts?.rawHas) {
    check(`${kind}：原文含「${opts.rawHas}」`, p.rawMessage.includes(opts.rawHas), p.rawMessage);
  }
}

// ---- 用户实际遇到的那条（kimi 400 reasoning_content） ----
const KIMI_400 = '400 {"error":{"message":"The `reasoning_content` in the thinking mode must be passed back to the API.","type":"invalid_request_error","code":"invalid_request_error"}}';
expect(KIMI_400, "reasoning-content", "思考模式需要回传推理内容", {
  retryable: false,
  rawHas: "reasoning_content"
});
{
  const p = presentError(KIMI_400);
  // 关键：必须明确说是"我们的问题"，不能让用户以为是自己配错了
  check("reasoning：明确说明是客户端问题", p.hint.includes("我们客户端的问题"), p.hint);
  // 原始 JSON 不应出现在标题里
  check("reasoning：标题不含 JSON", !p.title.includes("{") && !p.title.includes('"'), p.title);
}

// ---- 带 request_id 的 ----
expect(
  '400 {"error":{"message":"bad thing","type":"invalid_request_error"},"request_id":"req_abc123def456"}',
  "bad-request",
  "请求被服务端拒绝",
  { requestId: "req_abc123def456" }
);

// ---- 工具格式不兼容 ----
expect(
  '400 {"error":{"message":"tool_calls is not supported for this model"}}',
  "tool-format",
  "工具调用格式与模型服务不兼容"
);

// ---- 认证 ----
expect('401 {"error":{"message":"Invalid API key provided"}}', "auth", "API Key 无效", {
  retryable: false
});
expect("HTTP 401 Unauthorized", "auth", "API Key 无效");

// ---- 限流 ----
expect('429 {"error":{"message":"rate limit exceeded"}}', "rate-limit", "请求太频繁", {
  retryable: true
});

// ---- 服务端 ----
expect("500 Internal Server Error", "server", "模型服务端故障", { retryable: true });
expect("503 Service Unavailable", "server", "模型服务端故障", { retryable: true });
{
  const p = presentError("502 Bad Gateway");
  check("server：说明与用户无关", p.hint.includes("和你无关"), p.hint);
}

// ---- 网络 ----
expect("connect ECONNREFUSED 127.0.0.1:9", "network", "连不上模型服务");
expect("timeout of 3000ms exceeded", "network", "连不上模型服务");

// ---- 其它 400：原文第一行 ----
expect(
  '400 {"error":{"message":"max_tokens must be positive\\nsecond line ignored"}}',
  "bad-request",
  "请求被服务端拒绝",
  { rawHas: "max_tokens must be positive" }
);
{
  const p = presentError('400 {"error":{"message":"line1\\nline2\\nline3"}}');
  check("bad-request：rawMessage 只取第一行", !p.rawMessage.includes("line2"), p.rawMessage);
}

// ---- 认不出的：不猜 ----
{
  const p = presentError("something totally unknown happened");
  check("unknown：分类是 unknown", p.kind === "unknown");
  check("unknown：标题不说具体原因", !p.title.includes("Key"), p.title);
  check("unknown：hint 指向技术详情", p.hint.includes("技术详情"), p.hint);
}

// ---- 边界 ----
{
  const p = presentError("");
  check("空字符串不崩", typeof p.title === "string" && p.title.length > 0, p.title);
}
{
  const p = presentError("400 {\"error\":{\"message\":\"broken json");
  check("半个 JSON 不崩（退回纯文本）", p.kind === "bad-request", p.kind);
}
{
  // 纯文本错误（没有 JSON），应该原样作为 rawMessage
  const p = presentError("Plain text error without json");
  check("纯文本错误保留原文", p.rawMessage.includes("Plain text"), p.rawMessage);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
