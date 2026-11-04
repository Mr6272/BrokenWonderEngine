# 2D 光照 · Java 侧内部接口边界（Lead 定，java-core 与 script-api 必须逐字遵守）

> 配合 `docs/_fragments/lighting-contract.md`（数学与数据格式的权威来源）。
> 本文件只管**两个实现方之间的方法签名**，避免并行开发时互相等编译。

## 1. 归属

| 文件 | 归属 |
|---|---|
| `src/Studio/runtime/LightMap.java` | java-core |
| `src/Studio/runtime/LightMapTest.java` | java-core |
| `src/Studio/runtime/Lighting.java` | java-core |
| `src/Studio/runtime/GameData.java`（只加 `RtLighting` / `RtLightmap` 解析） | java-core |
| `src/Studio/runtime/TopDownRuntime.java`（只加 3 处钩子 + 字段 + 访问器） | java-core |
| `src/Studio/runtime/ScriptLight.java` | script-api |
| `src/Studio/runtime/ScriptLightTest.java` | script-api |
| `src/Studio/runtime/ScriptApi.java`（只加 `installSafely("light", ...)` 与 alias 一行） | script-api |

两边**不得**改对方的任何一个字节。

## 2. `GameData` 新增（java-core 提供）

```java
public static final class RtLighting {
    public boolean enabled = false;
    public String mode = "both";           // baked | dynamic | both
    public String ambientColor = "#3A4A6B";
    public float ambientIntensity = 0.35f;
    public float darkness = 0.35f;
    public float softness = 16f;
    public float texelsPerPixel = 0.25f;
    public float dynamicFps = 15f;
    public int maxDynamicLights = 8;
}

public static final class RtLightmap {
    public String assetId = "";
    public float x = 0f, y = 0f, w = 0f, h = 0f;
    public int texW = 0, texH = 0;
    public float texelsPerPixel = 0f;
    public int lights = 0;
    public int version = 0;
}

// RtScene 新增两个字段，缺省 null（= 旧工程，零行为变化）
public RtLighting lighting;   // null = 没有光照配置
public RtLightmap lightmap;   // null = 没有烘焙图
```

## 3. `LightMap`（纯 CPU，java-core 提供）

```java
final class LightMap {
    static final int VERSION = 1;

    /** 一盏灯（烘焙与动态共用）。颜色已拆成 0..1 的 r/g/b，避免每纹素解析字符串。 */
    static final class Light {
        String id = "";
        float x, y;
        float radius = 140f;
        float r = 1f, g = 0.788f, b = 0.47f;   // #FFC978
        float intensity = 1f;
        boolean spot;
        float dirDeg = 0f;        // 0 = +x，90 = +y（向下），顺时针
        float angleDeg = 60f;     // 锥总角度
        float coneSoftDeg = 10f;
        float falloff = 2f;       // 1..4
        boolean shadow = true;
        float tickle = 0f;        // 「闪烁幅度」在当前时刻的**已算出**倍率加成（0 = 不闪）
        boolean dynamic;
    }

    static final class Occluder {
        float x, y, hw, hh;
        Occluder() {}
        Occluder(float x, float y, float hw, float hh) { this.x = x; this.y = y; this.hw = hw; this.hh = hh; }
    }

    static final class Result {
        int texW, texH;
        float sEff;            // 实际「纹素 / 世界像素」
        float[] rgb;           // 长度 texW*texH*3，已 clamp 到 0..1
        long ms;               // 本次耗时（诊断用）
    }

    /** 尺寸推导（契约 §2.1）。给定世界宽高与 s，返回 {texW, texH, sEff}；Java 侧无数组分配。 */
    static Result sizeFor(float worldW, float worldH, float texelsPerPixel);

    /**
     * 烘焙主入口：**不含模糊**（模糊由 {@link #blur} 单独跑，软半径 = softness*sEff）。
     * 不得返回 null；世界宽高 <= 0 ⇒ 返回 texW=texH=1、sEff=1、rgb 全 0。
     */
    static Result bake(float worldW, float worldH, float texelsPerPixel,
                       float[] ambientRgb, java.util.List<Light> lights,
                       java.util.List<Occluder> occluders);

    /** 契约 §2.5：2 遍方框模糊，就地或返回新数组均可（必须返回非 null）。 */
    static float[] blur(float[] rgb, int texW, int texH, int radiusTexels);

    /** 契约 §2.7 的 hash01。 */
    static float hash01(String id);

    /** float rgb(0..1) → 不透明 BufferedImage（A=255）。 */
    static java.awt.image.BufferedImage toImage(float[] rgb, int texW, int texH);

    /** 全黑贴图（用于「没有烘焙图」时的加光层，避免 upload 空指针）。 */
    static java.awt.image.BufferedImage black(int texW, int texH);
}
```

## 4. `Lighting`（GL 层，java-core 提供；script-api 只调它的 public/package 方法）

```java
final class Lighting {
    /** 运行时一盏活光（场景光 + 脚本光 + 实体光）。字段直接可写，改完调 markDirty()。 */
    static final class LiveLight {
        long id;                // 稳定唯一，脚本 fire-and-forget 用
        float x, y;             // 世界坐标（host 非 null 时每帧由 host 覆盖）
        float radius = 140f;
        String colorHex = "#FFC978";
        float intensity = 1f;
        String type = "point";      // point | spot
        float angleDeg = 60f;
        float dirDeg = 0f;
        float coneSoftDeg = 10f;
        float falloff = 2f;
        boolean shadow = true;
        float flicker = 0f;         // 0..1
        boolean dynamic = false;    // true = 不进烘焙
        boolean enabled = true;
        Actor host;                 // 非 null = 跟随该实体位置
    }

    Lighting(TopDownRuntime host);         // 构造即可，不碰 GL；读 scene.lighting / lightmap

    boolean isEnabled();
    void setEnabled(boolean on);
    String mode();                          // "baked" | "dynamic" | "both"
    void setMode(String m);                 // 非法值忽略
    float darkness();
    void setDarkness(float v);              // clamp 0..1
    String ambientColorHex();
    float ambientIntensity();
    void setAmbient(String hex, float intensity);   // hex 非法 ⇒ 只改强度

    /** 全部活光（含场景 LIGHT 对象派生的）。返回的 List 是内部表，不要改结构。 */
    java.util.List<LiveLight> lights();

    /** 新建一盏脚本光（host 可为 null = 独立光）。返回的 LiveLight 由调用方填字段后调 markDirty()。 */
    LiveLight addLiveLight(Actor host);
    boolean removeLiveLight(long id);
    LiveLight findLiveLight(long id);

    /** 把当前光源参数/位置/开关同步下一条重建（不立刻重建）。 */
    void markDirty();

    /** 立刻重建动态贴图（GL 上下文必须 current；无 GL 时安全返回 false）。 */
    boolean forceRebuild(javax.media.opengl.GL2 gl);

    /** 渲染钩子：压暗 + 加光。gl==null ⇒ 直接 return。 */
    void draw(javax.media.opengl.GL2 gl);

    /** GL 上下文重建：丢弃贴图 id、下次绘制重新上传。 */
    void invalidateGpuResources();

    /** 每帧逻辑推进（由 TopDownRuntime.update 调）：同步场景光、处理动态节流。 */
    void update(float dt);

    // ---- 诊断/自检（ScriptLightTest 与像素测试都用这些） ----
    int texW();
    int texH();
    int rebuildCount();
    long lastRebuildMs();
    int bakedLightCount();
    boolean hasBakeTexture();
    int debugLightQuads();          // 最近一帧画了几个 quad（0/1/2）
}
```

## 5. `TopDownRuntime` 新增（java-core 提供，只加不删）

```java
final Lighting lighting;                    // 构造末尾创建；旧工程 lighting.enabled()==false
// 构造：this.lighting = new Lighting(this);（放在 scene 载入、spawn 之后、scripts 之前或之后都行，
//       但必须在 scripts 建立之前，因为脚本 onSceneStart 可能马上调 bwe.light.*）

// update(dt) 尾部： lighting.update(dt);
// renderFrame：drawActors(gl) 之后、drawUiScenes(gl) 之前： lighting.draw(gl);
// rebuildGpuResources()：末尾 lighting.invalidateGpuResources();
```

`Lighting` 需要用到的宿主能力（都是 `TopDownRuntime` 已有的包内访问）：
`scene`、`actors`、`assetRoot`、`data`、`view`、`mapWidth()`、`mapHeight()`、`textureForFile(File)`、
`textureFromImage(BufferedImage)`、`pendingUploads`、`time`（可用 `lighting.update` 自累计）。
**不要**为此改动这些成员的名字或语义。

## 6. `ScriptLight`（script-api 提供）

```java
final class ScriptLight {
    static void install(ScriptApi api);   // api.attach("light", ns)
}
```
成员与语义见 `lighting-contract.md` §4（10 个方法，名字逐字固定）。
`ScriptApi.buildOpenWorld()` 里追加：

```java
installSafely("light", new Runnable() {
    @Override
    public void run() {
        ScriptLight.install(ScriptApi.this);
    }
});
```
并在 `MODULE_ALIASES` 里加一行 `{"render.light", "look.light"}`。

## 7. 并行纪律

- 编译一律**用自己的输出目录**，不要抢 `.tmp_build/bin`（那是 verify 阶段 Lead 用的）：
  `javac -d .tmp_light_jc -encoding utf-8 -cp "lib/*" <该成员负责的 .java + 依赖>`
  实际最省事的做法是 `javac -d .tmp_light_jc -encoding utf-8 -cp "lib/*" $(全仓 src 下 *.java)`，
  **但每次都要带自己的 `-d`**。
- java-core 先落地 `LightMap`/`GameData`/`Lighting`/`TopDownRuntime`，编译通过后再交棒；
  script-api 在此期间只写 `ScriptLight.java`（按 §4 的签名写），**不要**先改 `ScriptApi.java`，
  等 `Lighting` 就绪再加注册行并编译。
- 两方都不使用 Java 9+ API（`javac --release 8` 会挂在打包链路）。
