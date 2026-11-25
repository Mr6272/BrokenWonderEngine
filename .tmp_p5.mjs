import { readFileSync, writeFileSync } from "node:fs";

// ============ A. player.ts: 音频素材不该当贴图加载 ============
{
  const p = "web/src/webplayer/player.ts";
  let s = readFileSync(p, "utf8").replace(/\r\n/g, "\n");
  const before = s;

  if (!s.includes("loadAudioAsset")) {
    s = s.replace(
      `        const def = assets[i];
        try {
          await this.renderer.loadTexture(this.baseUrl, def);
        } catch (e) {
          console.warn(\`[BWE/Web] 素材加载失败 \${def.id}:\`, e);
        }`,
      `        const def = assets[i];
        try {
          // 按素材类型分流：音频进 AudioContext 的 buffer 池，其余才当贴图。
          // 早先所有素材都走 loadTexture，WAV 被当成图片解码，必然失败并刷一屏警告。
          if (isAudioAsset(def)) await this.loadAudioAsset(def);
          else await this.renderer.loadTexture(this.baseUrl, def);
        } catch (e) {
          console.warn(\`[BWE/Web] 素材加载失败 \${def.id}:\`, e);
        }`,
    );

    // 加 isAudioAsset + loadAudioAsset 方法
    const anchor = "  /**\n   * 把 ES5 脚本源码求值成一个可调用的模块。";
    if (!s.includes(anchor)) { console.error("load anchor miss"); process.exit(1); }
    const add = `  /** 素材是不是音频。boot.json 里 path 就是真实文件名，按扩展名判断最稳。 */
  private isAudioAsset(def: AssetDef): boolean {
    const p = String(def.path ?? "").toLowerCase();
    if (/\\.(wav|mp3|ogg|m4a|aac|flac)$/.test(p)) return true;
    const t = String((def as unknown as { type?: string }).type ?? "").toLowerCase();
    return t === "audio" || t === "sound" || t === "music";
  }

  /** 音频素材：fetch + decodeAudioData，塞进 ctx.audio.buffers 供 bwe.audio 取用。 */
  private async loadAudioAsset(def: AssetDef): Promise<void> {
    const url = new URL(def.path, this.baseUrl).href;
    const res = await fetch(url);
    if (!res.ok) throw new Error(\`音频加载失败: HTTP \${res.status} \${url}\`);
    const bytes = await res.arrayBuffer();
    // AudioContext 必须在用户交互后才能创建/恢复，但 decode 可以先做：
    // 没有 ctx 时就建一个 suspended 的，播放时再 resume。
    let ac = this.ctx.audio.ctx;
    if (!ac) {
      const Ctor = (window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
      if (!Ctor) throw new Error("浏览器不支持 WebAudio");
      ac = new Ctor();
      this.ctx.audio.ctx = ac;
    }
    const buf = await ac.decodeAudioData(bytes);
    this.ctx.audio.buffers.set(def.id, buf);
  }

`;
    s = s.replace(anchor, add + anchor);
  }

  if (s === before) { console.error("player no change"); process.exit(1); }
  writeFileSync(p, s, "utf8");
  console.log("A ok: audio=" + s.includes("loadAudioAsset"));
}

// ============ B. api.ts: Entity.props / prop / setProp ============
{
  const p = "web/src/webplayer/api.ts";
  let s = readFileSync(p, "utf8").replace(/\r\n/g, "\n");
  const before = s;

  s = s.replace(
    `    "asset", "animMode", "animFps",
  ]);`,
    `    "asset", "animMode", "animFps", "props", "prop", "setProp",
  ]);`,
  );

  s = s.replace(
    `      if (prop === "asset") return target.assetId;
      if (SUPPORTED.has(prop)) return target[prop];`,
    `      if (prop === "asset") return target.assetId;
      // props 是脚本挂在对象上的自定义键值袋（Java 侧 Entity 就有）。没有就建一个空的。
      if (prop === "props") {
        const t = target as unknown as { props?: Record<string, unknown> };
        if (!t.props || typeof t.props !== "object") t.props = {};
        return t.props;
      }
      if (prop === "prop") {
        return (k: string, dflt?: unknown) => {
          const t = target as unknown as { props?: Record<string, unknown> };
          const v = t.props ? t.props[String(k)] : undefined;
          return v === undefined ? dflt : v;
        };
      }
      if (prop === "setProp") {
        return (k: string, v: unknown) => {
          const t = target as unknown as { props?: Record<string, unknown> };
          if (!t.props || typeof t.props !== "object") t.props = {};
          t.props[String(k)] = v;
        };
      }
      if (SUPPORTED.has(prop)) return target[prop];`,
  );

  // set 分支也要允许自由写 props 袋里的键不至于报 miss
  s = s.replace(
    `      if (prop === "asset") { target.assetId = String(value); return true; }
      if (SUPPORTED.has(prop)) { target[prop] = value; return true; }`,
    `      if (prop === "asset") { target.assetId = String(value); return true; }
      if (SUPPORTED.has(prop)) { target[prop] = value; return true; }`,
  );

  if (s === before) { console.error("api Entity no change"); process.exit(1); }
  writeFileSync(p, s, "utf8");
  console.log("B ok: props=" + s.includes('"setProp"'));
}
