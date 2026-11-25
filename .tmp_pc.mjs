import { readFileSync, writeFileSync } from "node:fs";
const p = "web/src/webplayer/player.ts";
let s = readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const before = s;

s = s.replace(
  `    const buf = await ac.decodeAudioData(bytes);
    this.ctx.audio.buffers.set(def.id, buf);
  }`,
  `    // decodeAudioData 在某些环境（headless / 无音频设备 / 移动端未解锁）会**永不 resolve**，
    // 而它在 load() 的 Promise.all 里，一旦挂住整个启动就卡死。加超时兜底：
    // 解不出来就退化成"已登记但不可播放"，让游戏先跑起来。
    const decode = ac.decodeAudioData(bytes.slice(0));
    const buf = await Promise.race([
      decode,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
    ]);
    if (buf) {
      this.ctx.audio.buffers.set(def.id, buf);
    } else {
      console.warn(\`[BWE/Web] 音频解码超时，已跳过（不阻塞启动）: \${def.id}\`);
    }
  }`,
);

if (s === before) { console.error("no change"); process.exit(1); }
writeFileSync(p, s, "utf8");
console.log("timeout guard added");
