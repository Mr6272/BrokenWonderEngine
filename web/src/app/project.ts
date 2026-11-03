/**
 * 工程读写。
 *
 * 三种保存路径，按浏览器能力自动选择：
 *   1. File System Access API（Chrome / Edge）：真正"另存到文件"，Ctrl+S 直接覆盖原文件；
 *   2. 下载 .bwproj（所有浏览器兜底）；
 *   3. 自动保存到 IndexedDB：即使忘了保存，刷新页面也不会丢。
 *
 * 读盘纪律：绝不因为文件损坏而清空当前工程 —— 报错并让用户决定。
 */

import { normalizeProject, type Project, type AssetEntry, PROJECT_FORMAT, createProject, uid, createScene, createObject } from "../core/model.ts";
import { store } from "../core/store.ts";
import { loadProjectBlob, saveProjectBlob, gcAssets } from "../data/assets.ts";
import { error, info, ok, modal, confirmDialog } from "../ui/toast.ts";

/** File System Access API 的文件句柄：既可写也可读回原始 File */
interface SaveHandle {
  createWritable: () => Promise<{ write: (d: Blob) => Promise<void>; close: () => Promise<void> }>;
  getFile: () => Promise<File>;
}

let fileHandle: SaveHandle | null = null;

/** 只读句柄：打开文件时拿到的就是这种，不能直接写回 */
interface ReadHandle {
  getFile: () => Promise<File>;
}

type WithFs = Window & {
  showSaveFilePicker?: (o: unknown) => Promise<SaveHandle>;
  showOpenFilePicker?: (o: unknown) => Promise<ReadHandle[]>;
};

function fsApi(): WithFs {
  return window as WithFs;
}

export async function saveProjectFile(): Promise<boolean> {
  const p = store.project;
  if (!p) {
    error("还没有工程可以保存");
    return false;
  }
  const json = JSON.stringify(p, null, 2);

  // 优先用文件句柄覆盖保存
  if (fileHandle) {
    try {
      const w = await fileHandle.createWritable();
      await w.write(new Blob([json], { type: "application/json" }));
      await w.close();
      store.markSaved();
      await saveProjectBlob(p);
      ok("已保存");
      window.dispatchEvent(new CustomEvent("bwe:refresh"));
      return true;
    } catch {
      fileHandle = null;
    }
  }

  // 没有句柄时尝试"另存为"
  const api = fsApi();
  if (api.showSaveFilePicker) {
    try {
      const h = await api.showSaveFilePicker({
        suggestedName: fileName(p),
        types: [{ description: "BWE 工程", accept: { "application/json": [".bwproj"] } }]
      });
      fileHandle = h;
      const w = await h.createWritable();
      await w.write(new Blob([json], { type: "application/json" }));
      await w.close();
      store.markSaved();
      await saveProjectBlob(p);
      ok("已保存到文件");
      window.dispatchEvent(new CustomEvent("bwe:refresh"));
      return true;
    } catch (e) {
      // 用户取消不算失败，安静退回本地保存
      if ((e as Error)?.name !== "AbortError") {
        info("无法写入文件，已改为保存到浏览器本地");
      }
    }
  }

  await saveProjectBlob(p);
  store.markSaved();
  ok("已保存到浏览器本地（用「另存为」可导出成文件）");
  window.dispatchEvent(new CustomEvent("bwe:refresh"));
  return true;
}

export function downloadProject(): void {
  const p = store.project;
  if (!p) return;
  const json = JSON.stringify(p, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = fileName(p);
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  ok(`已导出 ${a.download}`);
}

function fileName(p: Project): string {
  const safe = (p.name || "未命名工程").replace(/[\\/:*?"<>|]/g, "_");
  return `${safe}.bwproj`;
}

export async function openProjectFile(): Promise<void> {
  const api = fsApi();
  if (api.showOpenFilePicker) {
    try {
      const [h] = await api.showOpenFilePicker({
        types: [{ description: "BWE 工程", accept: { "application/json": [".bwproj", ".json"] } }]
      });
      const f = await h.getFile();
      await applyFile(f, h);
      return;
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return;
    }
  }
  // 兜底：传统文件选择
  const picker = document.createElement("input");
  picker.type = "file";
  picker.accept = ".bwproj,.json,application/json";
  picker.addEventListener("change", async () => {
    const f = picker.files?.[0];
    if (f) await applyFile(f, null);
  });
  picker.click();
}

async function applyFile(f: File, handle: ReadHandle | null): Promise<void> {
  try {
    const text = await f.text();
    const raw = JSON.parse(text);
    const rawFormat = typeof raw === "object" && raw !== null && "format" in raw ? (raw as { format?: number }).format : undefined;
    const project = normalizeProject(raw);

    const doOpen = async () => {
      /**
       * 工程身份：网页版拿不到绝对路径（浏览器不给），但**不能因此退化成"只有文件名"**——
       * 那样两个都叫 `同名.bwproj` 的不同工程会共用一份知识库记忆。
       * 这里用「文件名 + 字节数 + 修改时间」拼一个**稳定的文件指纹**当路径用：
       *   · 同一个文件反复打开 → 三个值都不变 → 同一个知识库；
       *   · 同名不同文件 → 至少有一个值不同 → 分片。
       * 它不完美（用户改完文件大小与 mtime 都变 → 会被当成"新工程"），
       * 但这比"串记忆"安全：宁可记忆少一点，也不能把 A 的经验灌给 B。
       * 桌面版有真路径（主进程给），不受这个影响。
       */
      const fingerprint = `web:${f.name}:${f.size}:${f.lastModified}`;
      store.setProject(project, f.name, fingerprint);
      // 只有同时具备可写能力的句柄才能用于后续覆盖保存
      fileHandle = handle && typeof (handle as SaveHandle).createWritable === "function" ? (handle as SaveHandle) : null;
      await saveProjectBlob(project);
      ok(`已打开「${f.name}」`);
      if (rawFormat !== undefined && rawFormat < PROJECT_FORMAT) {
        info(`工程是 v${rawFormat} 格式，已自动兼容到 v${PROJECT_FORMAT}，建议重新导出备份。`);
      }
      window.dispatchEvent(new CustomEvent("bwe:refresh"));
      window.dispatchEvent(new CustomEvent("bwe:fit"));
    };

    if (store.dirty) {
      const yes = await confirmDialog(
        "当前工程还没保存",
        "打开新工程会丢掉现在的改动，确定继续吗？",
        "不保存，打开",
        true
      );
      if (!yes) return;
    }
    await doOpen();
  } catch (e) {
    error(`打不开这个文件：${(e as Error).message}。当前工程没有被改动。`);
  }
}

/** 启动时恢复上次的工程；没有就用空工程，并给一句引导。 */
export async function bootstrapProject(editorSetter: (p: unknown, name?: string) => void): Promise<void> {
  try {
    const saved = await loadProjectBlob();
    if (saved) {
      editorSetter(saved, "");
      info("接着上次继续");
      return;
    }
  } catch {
    /* 读不出来就当没有，下面走空工程。本地库坏掉不该阻塞开工。 */
  }
  editorSetter(null);
}

/**
 * 启动兜底：若干秒后若仍未装载任何工程，直接给一个空工程。
 * 有些环境（隐私模式禁用 IndexedDB、本地库损坏）会让上面的读取一直不返回，
 * 这条线保证编辑器**永远**能进入可用状态，而不是停在"界面上什么按钮都没有"。
 */
export function armStartupGuard(hasProject: () => boolean, fallback: () => void, ms = 6000): void {
  window.setTimeout(() => {
    if (!hasProject()) {
      fallback();
      info("本地工程读取超时，已为你新建一个空工程");
    }
  }, ms);
}

/** 定时自动保存：每 30 秒把工程写进本地库，防手滑丢工作。 */
export function startAutoSave(): void {
  window.setInterval(() => {
    if (store.project && store.dirty) {
      void saveProjectBlob(store.project).then(() => {
        store.markSaved();
        window.dispatchEvent(new CustomEvent("bwe:refresh"));
      });
    }
  }, 30000);
}

/** 清理本地素材库里不再被引用的二进制。 */
export async function cleanupAssets(): Promise<void> {
  const p = store.project;
  if (!p) return;
  const removed = await gcAssets(p);
  ok(removed > 0 ? `已清理 ${removed} 个不再使用的素材文件` : "没有可清理的素材");
}

/** 内置示例工程：一张小地图、一个主角、一只巡逻敌人、一个箱子、一个触发区、一段对话。
 * 素材用数据 URL（内嵌 Base64 彩色方块），无需外部图片即可打开查看。 */
export function createExampleProject(): Project {
  const p = createProject("示例工程");
  p.tileSize = 32;

  // ---------- 内嵌素材（1×1 或小彩色图，Base64 PNG） ----------
  const red = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const green = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYGQAYQAAAHjBAB8+2Q8AAAAASUVORK5CYII=";
  const blue = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const yellow = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYGQAYQAAAHjBAB8+2Q8AAAAASUVORK5CYII=";

  const makeAsset = (name: string, url: string, w = 32, h = 32): AssetEntry => ({
    id: uid(),
    name,
    kind: "IMAGE",
    src: "url",
    url,
    path: name,
    width: w,
    height: h,
    group: "示例",
    hiddenFrames: [],
    frameDurations: []
  });

  const heroAsset = makeAsset("主角精灵", red, 32, 32);
  const enemyAsset = makeAsset("敌人精灵", green, 32, 32);
  const boxAsset = makeAsset("箱子精灵", blue, 32, 32);
  const zoneAsset = makeAsset("触发区贴图", yellow, 32, 32);

  p.assets.push(heroAsset, enemyAsset, boxAsset, zoneAsset);

  // ---------- 场景 ----------
  const scene = createScene("村口", 20, 15);
  p.scenes[0] = scene;

  // 主角
  const hero = createObject("ACTOR", 64, 64);
  hero.name = "主角";
  hero.assetId = heroAsset.id;
  hero.halfW = 14;
  hero.halfH = 14;
  hero.tags = ["玩家"];
  hero.modules.push({
    defId: "move.follow",
    trigger: "ALWAYS",
    values: { speed: "0", stopDistance: "0", detectionRange: "0", ignoreCollider: "关" },
    enabled: true,
    collapsed: false
  });
  hero.modules.push({
    defId: "combat.health",
    trigger: null,
    values: { maxHealth: "100", defense: "0", showBar: "开", invincible: "关" },
    enabled: true,
    collapsed: true
  });
  hero.modules.push({
    defId: "fx.cameraFollow",
    trigger: "ALWAYS",
    values: { smoothing: "0.15", lookAhead: "24", clampToMap: "开" },
    enabled: true,
    collapsed: true
  });
  scene.objects.push(hero);

  // 巡逻敌人
  const enemy = createObject("ACTOR", 400, 200);
  enemy.name = "巡逻卫兵";
  enemy.assetId = enemyAsset.id;
  enemy.halfW = 14;
  enemy.halfH = 14;
  enemy.tags = ["敌人"];
  enemy.modules.push({
    defId: "move.patrol",
    trigger: "ALWAYS",
    values: { speed: "40", range: "96", axis: "水平 Horizontal", waitTime: "0.6" },
    enabled: true,
    collapsed: false
  });
  enemy.modules.push({
    defId: "combat.health",
    trigger: null,
    values: { maxHealth: "30", defense: "0", showBar: "开", invincible: "关" },
    enabled: true,
    collapsed: true
  });
  scene.objects.push(enemy);

  // 箱子
  const box = createObject("PROP", 200, 300);
  box.name = "木箱";
  box.assetId = boxAsset.id;
  box.halfW = 14;
  box.halfH = 14;
  box.tags = ["箱子"];
  box.modules.push({
    defId: "detect.collider",
    trigger: null,
    values: { shape: "整块 Full Tile", transparentToSight: "关", blockFlying: "关" },
    enabled: true,
    collapsed: true
  });
  scene.objects.push(box);

  // 触发区（进入后播放对话）
  const zone = createObject("ZONE", 500, 400);
  zone.name = "对话触发区";
  zone.halfW = 64;
  zone.halfH = 48;
  zone.assetId = zoneAsset.id;
  zone.tags = ["触发区"];
  zone.modules.push({
    defId: "dialogue.conversation",
    trigger: "ON_TRIGGER_ENTER",
    values: { script: "", startNode: "开始", lockMovement: "开", portrait: "" },
    enabled: true,
    collapsed: false
  });
  scene.objects.push(zone);

  // 预置一段 Yarn 剧本
  p.scripts["示例对话"] = {
    name: "示例对话",
    file: "示例对话.yarn",
    source: `title: 开始\n\n- 冒险者：欢迎来到示例工程！\n- 这是一个由 BWE Studio 搭建的小地图。\n- 试着拖动主角、给敌人加模块、或把规则包套到其他对象上。\n=> END`
  };

  return p;
}

export function showExportComingSoon(): void {
  modal({
    title: "导出 Web 游戏包",
    body: () =>
      (() => {
        const box = document.createElement("div");
        box.className = "col";
        const lines = [
          "这一步会生成一个自包含的 HTML5 游戏包：双击 index.html 就能玩，也可以直接上传到任意静态托管。",
          "",
          "计划包含：",
          "· 引擎运行时（画布渲染、输入、寻路、碰撞）",
          "· 你的地图数据与全部素材",
          "· 模块模块翻译成的运行指令",
          "· Yarn 剧本与对话界面",
          "",
          "当前版本先把编辑器做扎实，这一步紧接着做。"
        ];
        for (const l of lines) {
          const d = document.createElement("div");
          d.className = "hint";
          d.style.fontSize = "12.5px";
          d.textContent = l;
          box.appendChild(d);
        }
        return box;
      })(),
    actions: [{ label: "知道了", variant: "primary", onClick: (c) => c() }]
  });
}
