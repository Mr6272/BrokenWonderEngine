/**
 * 输出中心（Output）。
 *
 * 为什么单独一层：打包/试跑/脚本检查会把过程日志写进各自的弹窗，
 * 弹窗一关日志就没了。这里留一个环形缓冲区，底部「输出」标签随时能翻回去看，
 * 也让"打包为什么会失败"这类事后复盘不需要重跑一遍。
 *
 * 纪律：
 *   - 只保留最近 N 行（默认 2000），编辑器可能开一整天，不能无限涨内存；
 *   - 写入按行合并，同一帧里连刷几十行只在下一帧通知一次，避免日志滚动把界面拖卡；
 *   - 不做格式化/着色逻辑，颜色由 level 决定（info/ok/warn/error）。
 */

export type OutputLevel = "info" | "ok" | "warn" | "error";

export interface OutputLine {
  /** 自增序号：面板据此判断"有没有新行"，比比较内容可靠 */
  seq: number;
  /** 来源标签（打包 / 试跑 / 脚本检查 / 编辑器） */
  channel: string;
  level: OutputLevel;
  text: string;
  at: number;
}

const MAX_LINES = 2000;
let lines: OutputLine[] = [];
let seq = 0;
let pending: OutputLine[] = [];
let flushScheduled = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of Array.from(listeners)) fn();
}

/** 追加一行。channel 用于区分来源，例如「打包」「试跑」。 */
export function appendOutput(channel: string, text: string, level: OutputLevel = "info"): void {
  // 多行文本按行拆开：日志面板按行渲染，塞一坨含 \n 的字符串会破坏对齐
  for (const raw of String(text ?? "").split("\n")) {
    pending.push({ seq: ++seq, channel, level, text: raw, at: Date.now() });
  }
  if (pending.length > MAX_LINES) pending.splice(0, pending.length - MAX_LINES);
  if (!flushScheduled) {
    flushScheduled = true;
    // 合并到下一帧：一次打包可能连刷上百行，逐行通知会让面板重画上百次
    requestAnimationFrame(() => {
      flushScheduled = false;
      lines.push(...pending);
      pending = [];
      if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
      notify();
    });
  }
}

/** 追加多行（常用于把服务端日志整段灌进来）。 */
export function appendOutputLines(channel: string, texts: string[], level: OutputLevel = "info"): void {
  for (const t of texts) appendOutput(channel, t, level);
}

export function outputLines(): OutputLine[] {
  return lines;
}

export function clearOutput(): void {
  lines = [];
  pending = [];
  notify();
}

export function onOutput(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
