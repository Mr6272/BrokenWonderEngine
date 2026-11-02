/**
 * 桌面壳 · 极简 PNG 检查（截图验收用）。
 *
 * 验收要的不是「文件存在」，而是「截出来的东西真的是页面」。
 * 所以这里只解 8bit RGB/RGBA 非隔行 PNG（Electron 的 capturePage 就产出这个），
 * 算出三个可判定的数字：
 *   - 尺寸（宽高），
 * - 非背景像素占比：以出现次数最多的颜色为「背景」，别的都算前景；
 *   - 不同颜色数：纯色截图会是 1，空窗口 / 白屏通常是 1~3。
 *
 * 不引任何解码库（离线 + 也不想为此装依赖）。解码器思路与
 * web/tools/frame-diff.mjs 里的最小解码器一致（5 种 filter 全支持）。
 */

import zlib from "node:zlib";

/** 解 PNG → {width, height, channels, rgba}。 */
export function decodePng(buf) {
  if (buf.length < 8 || buf.toString("hex", 0, 4) !== "89504e47") throw new Error("不是 PNG 文件");
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = 6;
  let interlaced = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlaced = data[12];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`只支持 8bit PNG，实际 ${bitDepth}`);
  if (interlaced !== 0) throw new Error("不支持隔行 PNG");
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : -1;
  if (channels < 0) throw new Error(`不支持的 colorType ${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const rgba = Buffer.alloc(width * height * 4);
  const prev = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    raw.copy(cur, 0, rp, rp + stride);
    rp += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = cur[x];
      if (filter === 1) v = (v + a) & 0xff;
      else if (filter === 2) v = (v + b) & 0xff;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
      cur[x] = v;
    }
    for (let x = 0; x < width; x++) {
      const si = x * channels;
      const di = (y * width + x) * 4;
      if (channels === 1) {
        rgba[di] = rgba[di + 1] = rgba[di + 2] = cur[si];
        rgba[di + 3] = 255;
      } else if (channels === 3) {
        rgba[di] = cur[si];
        rgba[di + 1] = cur[si + 1];
        rgba[di + 2] = cur[si + 2];
        rgba[di + 3] = 255;
      } else {
        rgba[di] = cur[si];
        rgba[di + 1] = cur[si + 1];
        rgba[di + 2] = cur[si + 2];
        rgba[di + 3] = cur[si + 3];
      }
    }
    cur.copy(prev);
  }
  return { width, height, channels, rgba };
}

/**
 * 统计截图内容。
 *
 * @param {Buffer} buf PNG 字节
 * @returns {{width:number,height:number,bytes:number,uniqueColors:number,backgroundRatio:number,
 *           foregroundRatio:number,background:string,backgroundLuminance:number,averageLuminance:number,
 *           isDark:boolean,isEmpty:boolean}}
 */
export function analyzePng(buf) {
  const { width, height, rgba } = decodePng(buf);
  const counts = new Map();
  // 抽样：超大截图逐像素统计也能跑，但 5 万像素足够判断「白屏 / 纯色」。
  const step = Math.max(1, Math.floor((width * height) / 120000));
  let total = 0;
  let lumSum = 0;
  // 亮度用 Rec.709 权重（人眼对绿最敏感）：判断「这是深色主题还是奶油主题」时，
  // 直接用 RGB 平均会被深蓝（高 B 低 R/G）误导。
  for (let i = 0; i < width * height; i += step) {
    const o = i * 4;
    // 量化到 5bit/通道：截图有抗锯齿与缩放，同色会略有浮动，量化后判断更稳。
    const key = ((rgba[o] >> 3) << 10) | ((rgba[o + 1] >> 3) << 5) | (rgba[o + 2] >> 3);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    lumSum += relativeLuminance(rgba[o], rgba[o + 1], rgba[o + 2]);
    total += 1;
  }
  let bgKey = 0;
  let bgCount = 0;
  for (const [k, v] of counts) {
    if (v > bgCount) {
      bgCount = v;
      bgKey = k;
    }
  }
  const bgR = ((bgKey >> 10) & 31) * 8;
  const bgG = ((bgKey >> 5) & 31) * 8;
  const bgB = (bgKey & 31) * 8;
  const bg = `#${hex2(bgR)}${hex2(bgG)}${hex2(bgB)}`;
  const backgroundLuminance = relativeLuminance(bgR, bgG, bgB);
  const averageLuminance = total ? lumSum / total : 0;
  const backgroundRatio = total ? bgCount / total : 0;
  const foregroundRatio = 1 - backgroundRatio;
  // 判定「空」：前景极少（<1.5%）或颜色数 < 8 —— 白屏、纯色、加载占位都属于这类。
  const isEmpty = foregroundRatio < 0.015 || counts.size < 8;

  /**
   * **角落采样亮度**（避开中央区域）。
   *
   * 为什么需要它：全画面众数色会被「大面积覆盖物」骗 ——
   * modal 的半透明遮罩一铺，深色遮罩就成了面积最大的颜色，
   * 于是浅色主题被误判成深色（实测：带 modal 的截图稳定误判）。
   * 而**主题是底色属性**，应该看"没有被内容覆盖的地方" —— 也就是四角。
   *
   * 做法：从四个角各取 32×32 区域，算中位亮度（不看众数、不受单点噪声影响）。
   */
  const cornerPx = 32;
  const cornerLums = [];
  const sampleRegion = (x0, y0, w, h) => {
    for (let y = y0; y < y0 + h; y += 2) {
      for (let x = x0; x < x0 + w; x += 2) {
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const o = (y * width + x) * 4;
        cornerLums.push(relativeLuminance(rgba[o], rgba[o + 1], rgba[o + 2]));
      }
    }
  };
  sampleRegion(0, 0, cornerPx, cornerPx);                                   // 左上
  sampleRegion(width - cornerPx, 0, cornerPx, cornerPx);                    // 右上
  sampleRegion(0, height - cornerPx, cornerPx, cornerPx);                   // 左下
  sampleRegion(width - cornerPx, height - cornerPx, cornerPx, cornerPx);    // 右下
  cornerLums.sort((a, b) => a - b);
  const cornerLuminance = cornerLums.length
    ? cornerLums[Math.floor(cornerLums.length / 2)]
    : backgroundLuminance;

  // 判定「深色主题」：主色亮度 < 0.35（奶油主题的白底约 0.94，深蓝约 0.09）。
  // ⚠ 但这个 isDark 是**像素判据**，会被遮罩骗 —— 真正的主题判定请看 assertTheme()，
  //   它优先用 DOM 底色。这里保留 isDark 只为「疑似深色覆盖」警告。
  const isDark = backgroundLuminance < 0.35;

  /**
   * 是否存在「大面积深色覆盖」但角落是浅色 —— 典型是 modal/遮罩/全屏对话框。
   * 用来在日志里解释「为什么这张图看起来暗」，不是失败判据。
   */
  const darkOverlayLikely = isDark && cornerLuminance >= 0.5;
  return {
    width,
    height,
    bytes: buf.length,
    uniqueColors: counts.size,
    backgroundRatio,
    foregroundRatio,
    background: bg,
    backgroundLuminance,
    averageLuminance,
    isDark,
    /** 四角采样的中位亮度（避开中央 modal/遮罩，是更可靠的"底色"代理）。 */
    cornerLuminance,
    /** 疑似有大面积深色覆盖（modal/遮罩）：众数色深、但角落浅。仅用于警告，不作失败判据。 */
    darkOverlayLikely,
    partiallyTransparent: hasAlpha(rgba),
    isEmpty
  };
}

function hex2(v) {
  return Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
}

/** Rec.709 相对亮度（0=黑，1=白）。 */
function relativeLuminance(r, g, b) {
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function hasAlpha(rgba) {
  // 全不透明就返回 false：capturePage 的 PNG 有时带 alpha 通道但全 255。
  for (let i = 3; i < rgba.length; i += 4 * 97) {
    if (rgba[i] !== 255) return true;
  }
  return false;
}

/** 一行可读结论（--shot 模式打到 stdout，验收直接看这行）。 */
export function describePng(stats) {
  const pct = (v) => `${(v * 100).toFixed(1)}%`;
  return [
    `尺寸 ${stats.width}x${stats.height}`,
    `${stats.bytes} 字节`,
    `颜色数 ${stats.uniqueColors}`,
    `背景 ${stats.background} ${pct(stats.backgroundRatio)}`,
    `非背景像素 ${pct(stats.foregroundRatio)}`,
    `亮度 ${stats.backgroundLuminance.toFixed(2)}`,
    stats.isEmpty ? "判定：空白/纯色截图" : "判定：有内容"
  ].join(" · ");
}

/**
 * 把 CSS 颜色字符串（`rgb(r,g,b)` / `rgba(...)` / `#rrggbb`）解析成 Rec.709 亮度。
 *
 * 为什么放在 Node 侧而不是渲染侧的注入脚本里：那段脚本写在模板字符串内，
 * 正则的反斜杠要穿透两层转义（写错就会让整个注入脚本抛错，表现为所有字段 undefined ——
 * 比"算错一个值"难查得多）。放在这里，正则只经过一层 JS 字符串，所见即所得。
 *
 * @returns {number|null} 解析失败返回 null（调用方据此降级到像素判据）
 */
export function cssColorLuminance(css) {
  const text = String(css ?? "").trim();
  if (!text) return null;

  // #rrggbb / #rgb
  const hex = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/.exec(text);
  if (hex) {
    const h = hex[1];
    const expand = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
    const r = parseInt(expand.slice(0, 2), 16);
    const g = parseInt(expand.slice(2, 4), 16);
    const b = parseInt(expand.slice(4, 6), 16);
    return relativeLuminance(r, g, b);
  }

  // rgb(...) / rgba(...)
  const rgb = /^rgba?\(([^)]+)\)/i.exec(text);
  if (rgb) {
    const parts = rgb[1].split(",").map((s) => Number(s.trim()));
    if (parts.length >= 3 && parts.slice(0, 3).every((n) => Number.isFinite(n))) {
      return relativeLuminance(parts[0], parts[1], parts[2]);
    }
  }
  return null;
}

/**
 * 主题断言：只看**底色**亮度，不看全画面众数色。
 *
 * ── 为什么改（真实误判）────────────────────────────────────────────────
 * 原实现用「全画面出现次数最多的颜色」当背景色。问题是：**大面积覆盖的东西会赢**。
 * modal 的半透明遮罩一铺，深色遮罩就成了面积最大的颜色 ——
 * 于是**浅色主题被误判成深色**。B 的隔离实验证明了这点：
 *   · 只点 demo-key-broken（不弹 modal）→ cream ✓
 *   · 只点 data-ai-rekey-all（弹 modal）→ cream ✓
 *   · 两个都点（modal 叠在演示态上）→ midnight ✗
 * 而真机视觉就是 cream —— **探测算法被遮罩骗了，不是主题坏了**。
 *
 * ── 现在的判据优先级 ───────────────────────────────────────────────────
 *   ① **DOM 底色**（最可靠）：`getComputedStyle(body).backgroundColor`
 *      这是"文档底色"属性，**不受任何遮罩影响**，也不需要沿像素猜。
 *   ② **四角采样亮度**（像素兜底）：拿不到 DOM 值时用，避开中央区域的 modal。
 *   （全画面众数色只在上面两者都不可用时才用，并明确标注为低置信度。）
 *
 * @param {object} stats        analyzePng 的结果
 * @param {object} [opts]
 * @param {number|null} [opts.domLuminance]  DOM 底色解析出的亮度（有就用它，优先级最高）
 * @param {string|null} [opts.domColor]      DOM 底色原文（写进 detail 便于排查）
 * @returns {{theme:"cream"|"dark"|"unknown", detail:string, ok:boolean, source:string, overlayWarning:string|null}}
 */
export function assertTheme(stats, opts = {}) {
  if (stats.isEmpty) {
    return { theme: "unknown", ok: false, detail: "截图空白，无法判断主题", source: "none", overlayWarning: null };
  }

  const domLum = typeof opts.domLuminance === "number" && Number.isFinite(opts.domLuminance)
    ? opts.domLuminance
    : null;
  const cornerLum = typeof stats.cornerLuminance === "number" && Number.isFinite(stats.cornerLuminance)
    ? stats.cornerLuminance
    : null;

  // ---- 选判据：DOM 底色 > 四角采样 > 全画面众数（置信度依次降低）----
  let luminance;
  let source;
  let judgedBy;
  if (domLum !== null) {
    luminance = domLum;
    source = "dom";
    judgedBy = `DOM 底色 ${opts.domColor ?? ""}（亮度 ${domLum.toFixed(2)}）`.replace(" （", "（");
  } else if (cornerLum !== null) {
    luminance = cornerLum;
    source = "corner";
    judgedBy = `四角采样（亮度 ${cornerLum.toFixed(2)}）`;
  } else {
    luminance = stats.backgroundLuminance;
    source = "mode";
    judgedBy = `全画面众数色 ${stats.background}（亮度 ${luminance.toFixed(2)}，低置信度）`;
  }

  const dark = luminance < 0.35;

  // ---- 「疑似深色覆盖」警告：众数色深、但底色浅 → 大概率是 modal/遮罩 ----
  // 这不是失败，只是让人知道"为什么这张图看起来暗"，避免下次又被它误导。
  let overlayWarning = null;
  if (!dark && stats.isDark) {
    overlayWarning =
      `画面上有大面积深色覆盖（全画面众数色 ${stats.background}，亮度 ${stats.backgroundLuminance.toFixed(2)}），`
      + `但底色是浅色 —— 很可能是 modal/遮罩。主题判据已改用 ${source === "dom" ? "DOM 底色" : "四角采样"}。`;
  }

  if (dark) {
    return {
      theme: "dark",
      ok: false,
      detail: `${judgedBy} 是深色 —— 预期是奶油主题 #f7f4ee（亮度约 0.94）。`
        + "检查 web/index.html 是否加载了 styles/cream.css，或 html 上是否被加了 theme-midnight。",
      source,
      overlayWarning
    };
  }
  return {
    theme: "cream",
    ok: true,
    detail: `${judgedBy}，浅底主题`,
    source,
    overlayWarning
  };
}
