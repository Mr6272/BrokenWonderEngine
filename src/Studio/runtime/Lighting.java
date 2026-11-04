package Studio.runtime;

import javax.media.opengl.GL2;

import java.awt.image.BufferedImage;
import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * 2D 光照系统的<b>运行时层</b>（GL 绘制 + 动态贴图 + 场景光源收集）。
 *
 * <p>权威契约：{@code docs/_fragments/lighting-contract.md}；
 * 方法签名边界：{@code docs/_fragments/lighting-java-api.md} §4。
 * 数学全部在 {@link LightMap}（纯 CPU），本类只负责「收集数据 → 调数学 → 用 GL 画 quad」。
 *
 * <h3>画面模型（契约 §2.6）</h3>
 * <pre>
 *   压暗：glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA) + 纯黑 quad(alpha = darkness)
 *         ⇒ 画面 = 画面 * (1 - darkness)
 *   加光：glBlendFunc(GL_SRC_ALPHA, GL_ONE) + 光照贴图（A=255）
 *         ⇒ 画面 = 画面 + RGB
 * </pre>
 * 光照贴图每个纹素 = {@code ambient + Σ lights}（已 clamp 到 0..1，见 {@link LightMap}）。
 * 没有光的纹素 RGB=(0,0,0) ⇒ 加 0，完全无副作用 —— 这是「加光层可以把整屏盖一遍」的前提。
 *
 * <h3>⚠ 只用三种混合因子（契约 §0 第 2 条）</h3>
 * Android 的 {@code GL2Compat.mapBlend} 只认 {@code GL_SRC_ALPHA / GL_ONE / GL_ONE_MINUS_SRC_ALPHA}，
 * 其它值静默退化成 {@code GL_SRC_ALPHA}。所以本类<b>绝不</b>使用 {@code GL_ZERO} /
 * {@code GL_SRC_COLOR} / {@code GL_DST_COLOR} 这类「乘法混合」。
 *
 * <h3>⚠ 旧工程零回归（契约 §0 第 5 条）</h3>
 * {@code scene.lighting} 缺失 ⇒ {@link #isEnabled()} 恒 false ⇒ {@link #draw(GL2)} 在<b>第一行</b>
 * 就 return，<b>一个 GL 调用都不发</b>、一个状态都不改。画面与改动前逐像素一致。
 *
 * <h3>⚠ GL 上下文重建（「切窗口黑屏」的根因）</h3>
 * 纹理 id 属于某一个 GL 上下文，重建后全部失效。本类不自己 {@code glGenTextures}，
 * 而是走宿主已有的 {@code textureFromImage(BufferedImage)}（它把「Texture 对象 + 源位图」
 * 登记进 {@code pendingUploads}，由 {@code uploadTextures} 统一上传、由
 * {@code rebuildGpuResources()} 统一重排）。所以上下文重建后光照贴图会自动重建；
 * 另外 {@link #invalidateGpuResources()} 会被 {@code rebuildGpuResources()} 末尾调用，
 * 保证本类的内部状态也跟着复位。
 *
 * <h3>三层贴图的职责划分（「多算一次就过曝」的坑）</h3>
 * <pre>
 *   mode=baked           → 只画烘焙图（没有烘焙图时就画「只有环境光」的静态图）
 *   mode=dynamic         → 只画动态层（动态层含环境光 + 全部光源）
 *   mode=both + 有烘焙图  → 烘焙图（静态灯 + 环境光）+ 动态层（只含 dynamic=true 的灯，不含环境光）
 *   mode=both + 无烘焙图  → 动态层含环境光 + 全部光源
 * </pre>
 * 任何一种组合下，环境光与每盏灯都<b>恰好算一次</b>。
 */
final class Lighting {

    // ==================================================================
    //  数据结构（契约 lighting-java-api.md §4）
    // ==================================================================

    /**
     * 运行时一盏活光（场景光 + 脚本光 + 实体光）。
     *
     * <p>字段直接可写（脚本侧 {@code bwe.light.set(e, opts)} 就靠这个），改完调 {@link #markDirty()}。
     * {@code host} 非 null ⇒ 每帧由 {@code host.x/y} 覆盖 {@code x/y}（跟随实体）。
     *
     * <p><b>id 的取值域</b>：{@code > 0} = 脚本/实体光（{@link #addLiveLight} 分配，可用
     * {@link #removeLiveLight} 删）；{@code < 0} = 场景对象派生的光（由 props 每帧同步，
     * 删它请改对象的 props / {@code lightRadius}，不要走 {@code removeLiveLight}）。
     */
    static final class LiveLight {
        /** 稳定唯一 id（正 = 脚本光，负 = 场景派生光）。 */
        long id;
        /** 世界坐标（{@code host != null} 时每帧被宿主位置覆盖）。 */
        float x, y;
        float radius = 140f;
        String colorHex = "#FFC978";
        float intensity = 1f;
        /** {@code "point"} | {@code "spot"}。 */
        String type = "point";
        /** 聚光锥总角度（度）。 */
        float angleDeg = 60f;
        /** 聚光方向（度，0 = +x，90 = +y 即向下，顺时针）。 */
        float dirDeg = 0f;
        /** 锥边软化角（度）。 */
        float coneSoftDeg = 10f;
        /** 距离衰减指数（1..4）。 */
        float falloff = 2f;
        /** 是否被遮挡体挡光。 */
        boolean shadow = true;
        /** 闪烁幅度 0..1（0 = 不闪）。 */
        float flicker = 0f;
        /** true = 不进烘焙，由运行时动态层算（移动/跟随实体的光必须为 true）。 */
        boolean dynamic = false;
        /** false = 本盏暂时关闭（脚本可以关掉而不用删）。 */
        boolean enabled = true;
        /** 非 null = 跟随该实体位置（{@code attach} 的光源）。 */
        Actor host;

        /** 场景派生光的 hash 相位用 id 串（脚本光用 "L"+id）。 */
        String phaseId = "";
    }

    // ==================================================================
    //  宿主与配置
    // ==================================================================

    private final TopDownRuntime host;

    /**
     * 场景光照配置（null = 旧工程，全程不启用）。
     *
     * <p>非 final：场景切换后要重新读新场景的 {@code lighting}（否则新场景会沿用旧场景的
     * 环境光/模式，看起来像「换了关卡但灯还是上一关的颜色」）。
     */
    private GameData.RtLighting cfg;
    /** 烘焙贴图引用（null = 没有烘焙图）。同样按场景代数重读。 */
    private GameData.RtLightmap lm;

    /** 总开关的运行时值。{@code cfg == null} 时构造为 false 且无法被打开（零回归保证）。 */
    private boolean enabled;

    // ---- 光照贴图纹理（全部走宿主 textureFromImage / 纹理缓存，自己绝不 glGenTextures） ----

    /** 烘焙图纹理（懒加载，来自 {@code scene.lightmap.assetId} 对应的素材）。 */
    private Texture bakeTex;
    /**
     * 动态贴图纹理。<b>同一个实例复用</b>：每次重烘焙只换源位图（{@code pendingUploads.put}），
     * 不再 new Texture —— 否则旧 id 会留在宿主 uploadedTextures 里成为没人画的显存泄漏
     * （动态光照 15fps，很快就爆显存）。
     */
    private Texture dynTex;
    private BufferedImage dynImage;
    /** 没有烘焙图的 mode=baked 时用的「只有环境光」静态贴图。 */
    private Texture ambientTex;
    private BufferedImage ambientImage;

    private boolean bakeResolved;
    private boolean ambientResolved;

    /** 已经为哪个场景代数解析过烘焙图（场景切换后要重新解析）。 */
    private int resolvedEpoch = -1;

    // ---- 动态重建状态 ----

    /** 下一条 update 需要重建（脏标记）。 */
    private boolean dirty = true;
    /** 被 {@link #requestRebuild()} 强行要求「跳过 dynamicFps 节流」。 */
    private boolean forceRequested;
    /** 上一次重建的时间（秒，来自本类自累计的 {@link #time}）。 */
    private float lastRebuildAt = -9999f;
    /** 上一次动态重建的参数指纹（变了才重建，契约 §6「有变化才重建」）。 */
    private long dynSig = Long.MIN_VALUE;
    private long lastRebuildMs;
    private int rebuildCount;
    private int dynTexW, dynTexH;
    private int dynLightCount;
    /** 最近一帧画了几个<b>加光</b> quad（0/1/2）；压暗 quad 不计入（契约 §4 的取值域）。 */
    private int debugLightQuads;

    // ---- 活光表 ----

    /** 脚本/实体光（{@code addLiveLight} 建的，id>0，顺序稳定）。 */
    private final List<LiveLight> scriptLights = new ArrayList<LiveLight>();
    /** 场景对象派生的光（每帧从 props 重新收集，id<0）。 */
    private final List<LiveLight> sceneLights = new ArrayList<LiveLight>();
    /** {@link #lights()} 的合并缓存（避免每次问都新建 List）。 */
    private final List<LiveLight> allLights = new ArrayList<LiveLight>();
    private int allLightsScriptCount = -1;
    private int allLightsTotalCount = -1;
    /** 场景光按 Actor 身份索引：每帧复用同一 LiveLight 实例（保持 id 稳定）。 */
    private final Map<Actor, LiveLight> sceneByActor = new IdentityHashMap<Actor, LiveLight>();
    /** 本帧出现过的场景光宿主（用于淘汰已消失的）。 */
    private final Set<Actor> sceneSeen =
            Collections.newSetFromMap(new IdentityHashMap<Actor, Boolean>());

    private long nextScriptLightId = 1L;

    /** 自累计时间（秒）。宿主 {@code time} 是 private，契约允许本类自累计。 */
    private float time;

    // ==================================================================
    //  构造
    // ==================================================================

    /**
     * 构造即可，<b>不碰 GL</b>（契约 §4）。
     *
     * <p>{@code scene} 可能为 null（{@code TopDownRuntime.newStub()} 的测试桩），
     * 所以这里全部按「没有光照」处理 —— 桩上的 {@code bwe.light} 必须能调且全部安全返回。
     */
    Lighting(TopDownRuntime host) {
        this.host = host;
        reloadSceneConfig();
    }

    /** 从当前场景重新读 {@code lighting}/{@code lightmap}（构造时与每次场景切换后调）。 */
    private void reloadSceneConfig() {
        GameData.RtScene s = host == null ? null : host.scene;
        boolean wasEnabled = enabled;
        cfg = s == null ? null : s.lighting;
        lm = s == null ? null : s.lightmap;
        enabled = cfg != null && cfg.enabled;
        if (!wasEnabled && enabled) {
            dirty = true;
            forceRequested = true;
        }
        bakeResolved = false;
        bakeTex = null;
        ambientResolved = false;
        ambientTex = null;
        dynSig = Long.MIN_VALUE;
    }

    // ==================================================================
    //  契约 §4：开关 / 参数
    // ==================================================================

    /**
     * 总开关。
     *
     * <p>⚠ {@code scene.lighting} 缺失时（旧工程）恒为 {@code false}：{@code setEnabled(true)}
     * 也不会让它变 true —— 没有光照配置的工程打开光照只会得到「整屏压黑」，那是最坏的回归。
     */
    boolean isEnabled() {
        return cfg != null && enabled;
    }

    void setEnabled(boolean on) {
        if (cfg == null) {
            return;              // 旧工程：无光照配置，永远不能打开
        }
        if (enabled == on) {
            return;
        }
        enabled = on;
        // 重新打开时必须重建一次：关闭期间光源/遮挡体可能已经变了。
        dirty = true;
        forceRequested = true;
    }

    /** {@code "baked"} | {@code "dynamic"} | {@code "both"}。 */
    /**
     * {@code "baked"} | {@code "dynamic"} | {@code "both"}。
     *
     * <p>旧工程（{@code scene.lighting} 缺失）返回契约 §3.1 的<b>缺省值</b> {@code "both"}
     * —— 这是「没有配置时的默认配置」，与 {@code RtLighting.mode} 的字段初值一致。
     * 注意它<b>不代表</b>光照在生效：是否画由 {@link #isEnabled()} 决定（恒 false）。
     */
    String mode() {
        return cfg == null ? "both" : cfg.mode;
    }

    /** 设置模式；非法值忽略（契约 §4：非法值 ignore，不抛异常）。 */
    void setMode(String m) {
        if (cfg == null || m == null) {
            return;
        }
        String v = m.trim().toLowerCase(Locale.ROOT);
        if ("baked".equals(v) || "dynamic".equals(v) || "both".equals(v)) {
            if (!v.equals(cfg.mode)) {
                cfg.mode = v;
                dirty = true;
                forceRequested = true;
            }
        }
    }

    /** 压暗程度 0..1。 */
    float darkness() {
        return cfg == null ? 0f : cfg.darkness;
    }

    /**
     * 改压暗程度。压暗只是 GL quad 的 alpha，<b>不需要重烘焙</b>
     * （build 光照贴图与 darkness 无关），所以这里刻意不置脏 —— 避免「调节滑杆就 15fps 重算」。
     */
    void setDarkness(float v) {
        if (cfg == null || Float.isNaN(v)) {
            return;
        }
        float c = v < 0f ? 0f : (v > 1f ? 1f : v);
        if (c != cfg.darkness) {
            cfg.darkness = c;
        }
    }

    String ambientColorHex() {
        // 旧工程返回契约 §3.1 的缺省色（只是一个「没有配置时的默认值」，不表示光照生效）。
        return cfg == null ? "#3A4A6B" : cfg.ambientColor;
    }

    /**
     * 环境光强度。
     *
     * <p>⚠ 旧工程（{@code scene.lighting} 缺失）返回 <b>0</b>，而<b>不是</b>契约 §3.1 的缺省
     * {@code 0.35} —— 这是刻意的：{@code bwe.light.ambient()} 在旧工程上必须读回「没有环境光」，
     * 才能与 `isEnabled()==false` 的语义一致。契约 §3.1 的 0.35 是「有 lighting 段但没写这个字段」
     * 时的缺省，那种情况由 {@link GameData#readLighting} 填 0.35（见 {@code RtLighting} 字段初值）。
     */
    float ambientIntensity() {
        return cfg == null ? 0f : cfg.ambientIntensity;
    }

    /** 改环境光。{@code hex} 非法 ⇒ <b>只改强度</b>（契约 §4）。 */
    void setAmbient(String hex, float intensity) {
        if (cfg == null) {
            return;
        }
        boolean changed = false;
        if (hex != null && parseHex(hex) != null) {
            String t = hex.trim();
            if (!t.equals(cfg.ambientColor)) {
                cfg.ambientColor = t;
                changed = true;
            }
        }
        if (!Float.isNaN(intensity)) {
            float c = clamp01(intensity);
            if (c != cfg.ambientIntensity) {
                cfg.ambientIntensity = c;
                changed = true;
            }
        }
        if (changed) {
            // 环境光是加光层的「底色」，脚本改它期望立刻看到结果 → 跳过节流。
            dirty = true;
            forceRequested = true;
        }
    }

    // ==================================================================
    //  契约 §4：活光表
    // ==================================================================

    /** 全部活光（脚本光 + 场景派生光）。<b>内部表</b>，调用方不要改结构。 */
    List<LiveLight> lights() {
        int want = scriptLights.size() + sceneLights.size();
        if (allLights.size() != want || allLightsScriptCount != scriptLights.size()
                || allLightsTotalCount != want) {
            allLights.clear();
            allLights.addAll(scriptLights);
            allLights.addAll(sceneLights);
            allLightsScriptCount = scriptLights.size();
            allLightsTotalCount = want;
        }
        return allLights;
    }

    /**
     * 新建一盏脚本光（{@code host} 可为 null = 独立光）。返回的 LiveLight 由调用方填字段后调
     * {@link #markDirty()}。id 自动分配（从 1 递增，永不复用 → 脚本可以放心存 id）。
     */
    LiveLight addLiveLight(Actor hostActor) {
        LiveLight l = new LiveLight();
        l.id = nextScriptLightId++;
        l.host = hostActor;
        l.phaseId = "L" + l.id;
        if (hostActor != null) {
            l.x = hostActor.x;
            l.y = hostActor.y;
            // 跟随实体的光必须进动态层（实体每帧在动，烘焙图不可能跟上）。
            l.dynamic = true;
        }
        scriptLights.add(l);
        dirty = true;
        forceRequested = true;
        return l;
    }

    /** 删一盏脚本光。<b>只删 id>0 的脚本光</b>；场景派生光（id<0）返回 false（请改对象 props）。 */
    boolean removeLiveLight(long id) {
        for (int i = 0; i < scriptLights.size(); i++) {
            if (scriptLights.get(i).id == id) {
                scriptLights.remove(i);
                dirty = true;
                forceRequested = true;
                return true;
            }
        }
        return false;
    }

    /** 按 id 找活光（脚本光 + 场景派生光都找）。找不到返回 null。 */
    LiveLight findLiveLight(long id) {
        for (int i = 0; i < scriptLights.size(); i++) {
            if (scriptLights.get(i).id == id) {
                return scriptLights.get(i);
            }
        }
        for (int i = 0; i < sceneLights.size(); i++) {
            if (sceneLights.get(i).id == id) {
                return sceneLights.get(i);
            }
        }
        return null;
    }

    /** 把当前光源参数/位置/开关同步到下一条重建（不立刻重建）。注意：<b>会被 dynamicFps 节流</b>。 */
    void markDirty() {
        dirty = true;
    }

    /**
     * 脚本路径专用：脚本跑在 GL 上下文之外，拿不到 {@code GL2}。
     *
     * <p>只置「下一条 update 立即重建」标记，<b>跳过 dynamicFps 节流</b>；
     * 真正的 CPU 烘焙在 {@link #update}，纹理上传在宿主 {@code uploadTextures}（同一帧内），
     * 所以脚本回调里调它是安全且「本帧就生效」的（{@code bwe.light.rebuild()} 用它）。
     */
    void requestRebuild() {
        dirty = true;
        forceRequested = true;
    }

    // ==================================================================
    //  契约 §4：重建 / 绘制 / 上下文
    // ==================================================================

    /**
     * 立刻重建动态贴图。<b>GL 上下文必须 current</b>；无 GL（{@code gl==null}）安全返回 false。
     *
     * <p>实现：CPU 烘焙 → 把位图排进宿主的 {@code pendingUploads} → 调宿主
     * {@code uploadTextures(gl)} <b>当场</b>上传（否则纹理要到下一帧才可用，
     * 对「立刻重建」的语义不合格）。仅供「GL 上下文 current」的场合（像素自检）使用；
     * 脚本请用 {@link #requestRebuild()}。
     */
    boolean forceRebuild(GL2 gl) {
        if (gl == null || !isEnabled()) {
            return false;
        }
        resolveTextures();
        if (!rebuildDynamic()) {
            return false;
        }
        host.uploadTextures(gl);
        dirty = false;
        forceRequested = false;
        lastRebuildAt = time;
        return true;
    }

    /**
     * 渲染钩子：先压暗、再加光。<b>{@code gl==null} 或未启用 ⇒ 直接 return</b>（契约 §4）。
     *
     * <p>⚠ <b>未启用时连一个 GL 调用都不能发</b>：老工程的画面必须与改动前逐像素一致，
     * 任何「顺手设一下状态」都可能改变后续绘制。
     */
    void draw(GL2 gl) {
        debugLightQuads = 0;
        if (gl == null || !isEnabled()) {
            return;                          // ← 旧工程零回归的唯一保证点
        }
        float mapW = host.mapWidth();
        float mapH = host.mapHeight();
        if (!(mapW > 0f) || !(mapH > 0f)) {
            return;                          // 场景还没就绪
        }
        resolveTextures();

        // ① 先结束精灵批。批的纹理断言是「batchTexture 就是当前绑定的纹理」，
        //    我们下面要自己 bind 光照贴图，不 flush 会让残留的批拿着错的纹理继续画。
        //    flushSprites 同时把 batchTexture 复位成 -1 并 glDisable(GL_TEXTURE_2D)。
        host.flushSpritesForLighting(gl);

        // ② 只 push 矩阵不修改它：世界变换由 renderFrame 已经下发，我们的 quad 用世界坐标
        //    （与光照贴图覆盖的「场景矩形」完全重合），所以不需要 glLoadIdentity。
        //    push/pop 只是「万一以后有人在这里改了矩阵，也不会污染后续绘制」的保险。
        gl.glPushMatrix();

        // ---- 压暗：纯黑 quad，alpha = darkness（SRC_ALPHA / ONE_MINUS_SRC_ALPHA）----
        //
        // ⚠ 覆盖范围用**场景矩形**（与光照贴图完全重合），不是整屏：
        //    光照贴图只覆盖场景矩形，贴图外的像素会「只有压暗、没有加光」→ 四周一圈死黑。
        //    这正是离屏验收里「远角比别处黑得莫名其妙」的成因。
        float dark = cfg.darkness;
        if (dark > 0f) {
            gl.glDisable(GL2.GL_TEXTURE_2D);
            gl.glEnable(GL2.GL_BLEND);
            gl.glBlendFunc(GL2.GL_SRC_ALPHA, GL2.GL_ONE_MINUS_SRC_ALPHA);
            gl.glColor4f(0f, 0f, 0f, dark);
            gl.glBegin(GL2.GL_QUADS);
            gl.glVertex2f(0f, 0f);
            gl.glVertex2f(mapW, 0f);
            gl.glVertex2f(mapW, mapH);
            gl.glVertex2f(0f, mapH);
            gl.glEnd();
        }

        // ---- 加光层：烘焙图 + 动态层（最多 2 个 quad，契约 §4 的 debugLightQuads 取值域 0..2）----
        int quads = 0;
        Texture bakeLayer = bakeLayerTexture();
        if (bakeLayer != null && bakeLayer.id >= 0) {
            drawLightQuad(gl, bakeLayer, quadX(), quadY(), quadW(), quadH());
            quads++;
        }
        boolean wantDyn = hasDynamicLayer() && dynTex != null && dynTex.id >= 0
                && (dynLightCount > 0 || dynCoversStatic());
        if (wantDyn) {
            drawLightQuad(gl, dynTex, 0f, 0f, mapW, mapH);
            quads++;
        }
        if (quads == 0 && ambientTex != null && ambientTex.id >= 0) {
            // 兜底：mode=baked 且没有烘焙图 ⇒ 画「只有环境光」的静态图（契约 §3.2）。
            drawLightQuad(gl, ambientTex, 0f, 0f, mapW, mapH);
            quads++;
        }
        debugLightQuads = quads;

        // ③ 恢复状态。后续 drawUiScenes / 脚本 HUD / 摇杆都依赖「无纹理、白色、正常混合、
        //    世界矩阵仍是 renderFrame 下发的那一个」这四条前提。
        gl.glPopMatrix();
        gl.glDisable(GL2.GL_TEXTURE_2D);
        gl.glColor4f(1f, 1f, 1f, 1f);
        gl.glBlendFunc(GL2.GL_SRC_ALPHA, GL2.GL_ONE_MINUS_SRC_ALPHA);
        gl.glEnable(GL2.GL_BLEND);
        gl.glTexEnvi(GL2.GL_TEXTURE_ENV, GL2.GL_TEXTURE_ENV_MODE, GL2.GL_MODULATE);
        // batchTexture 已被 flushSprites 置 -1，我们自己 bind 的纹理不会被后续 batchSprite
        // 误认为「已绑定」，所以无需再 flush（批是空的）。
    }

    /**
     * 画一个加光 quad（光照贴图）。坐标是世界坐标，uv 0..1。
     *
     * <p>⚠ <b>贴图参数必须在这里每帧重设成 {@code GL_LINEAR} + {@code GL_CLAMP_TO_EDGE}</b>：
     * 宿主 {@code uploadImage} 统一用 {@code GL_NEAREST} + {@code GL_REPEAT}（像素画需要），
     * 而光照贴图是<b>低分辨率平滑渐变</b>：{@code NEAREST} 会把它放大成一格格马赛克，
     * {@code REPEAT} 会在边界采样到对侧纹素（画面四周出现「镜像漏光」）。
     * <b>不能改</b> {@code uploadImage}：那会一次性改变所有像素画素材的观感（真回归）。
     * 每次绑定时设一遍这两个参数，成本可忽略（纯状态设置，无上传）。
     */
    private void drawLightQuad(GL2 gl, Texture tex, float x, float y, float w, float h) {
        if (tex == null || tex.id < 0 || !(w > 0f) || !(h > 0f)) {
            return;
        }
        gl.glEnable(GL2.GL_TEXTURE_2D);
        gl.glBindTexture(GL2.GL_TEXTURE_2D, tex.id);
        gl.glTexParameteri(GL2.GL_TEXTURE_2D, GL2.GL_TEXTURE_MIN_FILTER, GL2.GL_LINEAR);
        gl.glTexParameteri(GL2.GL_TEXTURE_2D, GL2.GL_TEXTURE_MAG_FILTER, GL2.GL_LINEAR);
        gl.glTexParameteri(GL2.GL_TEXTURE_2D, GL2.GL_TEXTURE_WRAP_S, GL2.GL_CLAMP_TO_EDGE);
        gl.glTexParameteri(GL2.GL_TEXTURE_2D, GL2.GL_TEXTURE_WRAP_T, GL2.GL_CLAMP_TO_EDGE);
        gl.glTexEnvi(GL2.GL_TEXTURE_ENV, GL2.GL_TEXTURE_ENV_MODE, GL2.GL_MODULATE);
        // 加性混合：只用 SRC_ALPHA / ONE 两种因子（Android GL2Compat 唯一合法的加性组合）
        gl.glBlendFunc(GL2.GL_SRC_ALPHA, GL2.GL_ONE);
        // 白色 + MODULATE ⇒ 输出 = 纹理 RGB；A=255 ⇒ 加 RGB 本身（契约 §2.6）
        gl.glColor4f(1f, 1f, 1f, 1f);
        gl.glBegin(GL2.GL_QUADS);
        gl.glTexCoord2f(0f, 0f);
        gl.glVertex2f(x, y);
        gl.glTexCoord2f(1f, 0f);
        gl.glVertex2f(x + w, y);
        gl.glTexCoord2f(1f, 1f);
        gl.glVertex2f(x + w, y + h);
        gl.glTexCoord2f(0f, 1f);
        gl.glVertex2f(x, y + h);
        gl.glEnd();
    }

    /**
     * GL 上下文重建：丢弃「已上传」的假定，下次绘制重新解析 / 重新排队源位图。
     *
     * <p>⚠ 这里<b>不 new Texture、不 glGenTextures</b>：宿主的 {@code rebuildGpuResources()}
     * 已经把每个纹理的 id 置回 -1 并把源位图重新排进 {@code pendingUploads}，
     * 我们要做的只是「承认 id 已失效」，并保证下一次重建时把<b>最新</b>的动态图重新排一次
     * （否则会重新上传一张过期的一帧）。
     */
    void invalidateGpuResources() {
        // bakeTex / ambientTex 的源位图在宿主的 textureSources 里，宿主已重新排队 → 保留引用。
        bakeResolved = false;
        ambientResolved = false;
        resolvedEpoch = -1;
        if (dynTex != null && dynImage != null) {
            // 复用同一个 Texture 实例（id 已被宿主置 -1），把最新位图重新排队 → 下一条上传即恢复。
            host.pendingUploads.put(dynTex, dynImage);
        }
        dirty = true;
        forceRequested = true;
    }

    // ==================================================================
    //  每帧推进（宿主 TopDownRuntime.update 尾部调用）
    // ==================================================================

    /**
     * 每帧逻辑推进：同步场景光源、跟随实体位置、按 {@code dynamicFps} 节流重烘焙。
     *
     * <p><b>这里不碰 GL</b>：CPU 烘焙结果直接排进宿主的 {@code pendingUploads}，
     * 本帧随后的 {@code renderFrame → uploadTextures} 就会把它变成纹理 ——
     * 于是「重建」在本帧就能画出来（首帧也不会出现 1 帧黑）。
     */
    void update(float dt) {
        if (dt > 0f && dt < 60f && !Float.isNaN(dt)) {
            time += dt;
        }
        if (!isEnabled() || host == null || host.scene == null) {
            return;
        }
        int epoch = host.sceneEpoch;
        if (epoch != resolvedEpoch) {
            // 场景切换：烘焙图/环境光/光照配置都要按新场景重读
            reloadSceneConfig();
            resolvedEpoch = epoch;
        }
        resolveTextures();
        syncSceneLights();
        updateHostPositions();

        if (!hasDynamicLayer()) {
            return;
        }
        long sig = computeDynSignature();
        if (sig != dynSig) {
            dirty = true;
            dynSig = sig;
        }
        if (!dirty) {
            return;
        }
        float fps = cfg.dynamicFps;
        if (!(fps > 0f) || fps > 240f) {
            fps = 15f;
        }
        float interval = 1f / fps;
        // 自适应退避：若上一次重建比「节流间隔」还慢，按它的 2 倍退避，避免重建把帧率锁死
        // （2048 长边的贴图是 400 万纹素，多光源时会真的慢）。
        float minInterval = interval;
        if (lastRebuildMs > 0L && lastRebuildMs > (long) (interval * 1000f)) {
            minInterval = Math.min(5f, Math.max(interval, (lastRebuildMs / 1000f) * 2f));
        }
        boolean mayRebuild = (time - lastRebuildAt) >= minInterval;
        if (!mayRebuild && !forceRequested) {
            return;
        }
        if (!rebuildDynamic()) {
            return;
        }
        lastRebuildAt = time;
        dirty = false;
        forceRequested = false;
    }

    /** 实体光的位置同步（{@code host} 非 null ⇒ 每帧取实体位置）。 */
    private void updateHostPositions() {
        for (int i = 0; i < scriptLights.size(); i++) {
            LiveLight l = scriptLights.get(i);
            if (l.host == null || l.host.dead) {
                continue;      // 宿主已销毁：位置保持原值，本帧由 isUsable 过滤掉（不改脚本设的开关）
            }
            l.x = l.host.x;
            l.y = l.host.y;
        }
    }

    // ==================================================================
    //  场景光源收集（契约 §3.3）
    // ==================================================================

    /**
     * 每帧从场景对象重新收集光源（<b>不是只在构造时收一次</b>）。
     *
     * <p>为什么必须每帧：{@code bwe.light.attach/detach/set} 的实现就是<b>写对象的 props</b>
     * （契约 §3.3 明确「运行时与烘焙都读 props」，脚本 {@code e.setProp} 也能改），
     * 而实体本身每帧都在动。只收一次 ⇒ attach 的光永远不会亮、移动的灯不跟手。
     *
     * <p>判定（契约 §3.3）：{@code kind == "LIGHT"}，或挂 {@code look.light}/{@code render.light}
     * 模块，或 {@code props.lightRadius > 0}。
     *
     * <p>⚠ 已被脚本 {@code addLiveLight(actor)} 托管的实体<b>跳过</b>：否则同一盏灯会被
     * 「props 派生」和「脚本光」各算一次，亮度翻倍。
     */
    private void syncSceneLights() {
        sceneSeen.clear();
        List<Actor> actors = host.actors;
        for (int i = 0; i < actors.size(); i++) {
            Actor a = actors.get(i);
            if (a == null || a.o == null || a.dead) {
                continue;
            }
            if (isHostedByScriptLight(a)) {
                continue;               // 脚本托管的光源走 LiveLight，不重复收集
            }
            if (!isLightObject(a.o)) {
                continue;
            }
            sceneSeen.add(a);
            LiveLight l = sceneByActor.get(a);
            if (l == null) {
                l = new LiveLight();
                l.phaseId = a.o.id == null || a.o.id.isEmpty()
                        ? ("scene-" + (i + 1) + "-" + a.x + "-" + a.y)
                        : a.o.id;
                sceneByActor.put(a, l);
            }
            fillFromProps(a, l);
        }
        // 移除本帧已不存在的场景光（对象被销毁 / props 被清掉 / 被脚本 attach 接管）
        for (int i = sceneLights.size() - 1; i >= 0; i--) {
            LiveLight l = sceneLights.get(i);
            if (!isPresentInScene(l)) {
                sceneLights.remove(i);
            }
        }
        // 新增的场景光按场景 Actor 顺序追加（顺序稳定，id 稳定）
        for (Actor a : sceneSeen) {
            LiveLight l = sceneByActor.get(a);
            if (l != null && !sceneLights.contains(l)) {
                sceneLights.add(l);
            }
        }
        // 负 id 按当前顺序重排（脚本 list() 读到的 id 稳定可读）
        for (int i = 0; i < sceneLights.size(); i++) {
            sceneLights.get(i).id = -(i + 1);
        }
    }

    /** 该场景光是否仍在 {@link #syncSceneLights()} 本帧的收集结果里。 */
    private boolean isPresentInScene(LiveLight l) {
        for (Map.Entry<Actor, LiveLight> e : sceneByActor.entrySet()) {
            if (e.getValue() == l) {
                if (!sceneSeen.contains(e.getKey())) {
                    sceneByActor.remove(e.getKey());
                    return false;
                }
                return true;
            }
        }
        return false;
    }

    /** 该实体是否已被某个脚本光托管（{@code addLiveLight(actor)}）。 */
    private boolean isHostedByScriptLight(Actor a) {
        for (int i = 0; i < scriptLights.size(); i++) {
            if (scriptLights.get(i).host == a) {
                return true;
            }
        }
        return false;
    }

    /** 契约 §3.3：一个对象是不是光源。 */
    private boolean isLightObject(GameData.RtObject o) {
        if (o.kind != null && "LIGHT".equalsIgnoreCase(o.kind.trim())) {
            return true;
        }
        if (findLightModule(o) != null) {
            return true;
        }
        String r = prop(o, "lightRadius");
        return r != null && numOr(r, 0f) > 0f;
    }

    /**
     * 找光源模块：{@code look.light} 是桌面旧 id、{@code render.light} 是 Web 编辑器 id，
     * <b>两个都要认</b>（与 {@code ScriptApi.MODULE_ALIASES} 的别名一致）。
     */
    private GameData.RtModule findLightModule(GameData.RtObject o) {
        GameData.RtModule m = host.data.firstModule(o, "look.light", null);
        if (m != null) {
            return m;
        }
        return host.data.firstModule(o, "render.light", null);
    }

    /**
     * 把对象的 props（+ 模块参数）填进 LiveLight。
     *
     * <p><b>取值优先级</b>（契约 §3.3 末尾）：模块参数<b>优先于</b> props；
     * 颜色回退链 {@code lightColor → 模块 color → props.color → #FFC978}。
     */
    private void fillFromProps(Actor a, LiveLight l) {
        GameData.RtObject o = a.o;
        GameData.RtModule m = findLightModule(o);

        // ---- 半径：模块 radius 优先于 props.lightRadius ----
        float radius = numOr(prop(o, "lightRadius"), -1f);
        if (m != null) {
            float mr = m.num("radius", -1f);
            if (mr > 0f) {
                radius = mr;
            }
        }
        if (!(radius > 0f)) {
            radius = 140f;                      // 契约缺省
        }
        l.radius = radius;

        // ---- 颜色：lightColor → 模块 color → props.color → #FFC978 ----
        String color = prop(o, "lightColor");
        if (parseHex(color) == null && m != null) {
            String mc = m.str("color", "");
            if (parseHex(mc) != null) {
                color = mc;
            }
        }
        if (parseHex(color) == null) {
            color = prop(o, "color");
        }
        if (parseHex(color) == null) {
            color = "#FFC978";
        }
        l.colorHex = color;

        // ---- 强度：lightIntensity → 模块 strength/intensity → 1（clamp 0..4）----
        float intensity = numOr(prop(o, "lightIntensity"), Float.NaN);
        if (Float.isNaN(intensity) && m != null) {
            float mi = m.num("strength", Float.NaN);
            if (Float.isNaN(mi)) {
                mi = m.num("intensity", Float.NaN);
            }
            if (!Float.isNaN(mi)) {
                intensity = mi;
            }
        }
        if (Float.isNaN(intensity) || (!(intensity > 0f) && prop(o, "lightIntensity") == null
                && m == null)) {
            intensity = 1f;
        }
        l.intensity = clamp(intensity, 0f, 4f);

        // ---- 类型/角度/方向/软化/衰减 ----
        String type = prop(o, "lightType");
        l.type = type != null && "spot".equalsIgnoreCase(type) ? "spot" : "point";
        l.angleDeg = clamp(numOr(prop(o, "lightAngle"), 60f), 1f, 360f);
        // lightDir 缺省用对象 rotation（契约 §3.3 表格）
        l.dirDeg = numOr(prop(o, "lightDir"), o.rotation);
        l.coneSoftDeg = clamp(numOr(prop(o, "lightConeSoft"), 10f), 0f, 180f);
        l.falloff = clamp(numOr(prop(o, "lightFalloff"), 2f), 1f, 4f);

        // ---- 开关 ----
        // lightShadow 缺省 "1"（会被挡）；显式 "0"/"false"/"关" 才关掉。
        l.shadow = boolOr(prop(o, "lightShadow"), true);
        l.flicker = clamp(numOr(prop(o, "lightFlicker"), 0f), 0f, 1f);
        // 模块的 flicker 是布尔（契约 §3.3：flicker(bool) → lightFlicker = 0.25）
        if (m != null && l.flicker <= 0f && m.bool("flicker", false)) {
            l.flicker = 0.25f;
        }
        l.dynamic = boolOr(prop(o, "lightDynamic"), false);
        l.enabled = true;
        l.host = null;
        l.x = a.x;
        l.y = a.y;
    }

    // ==================================================================
    //  动态贴图重建
    // ==================================================================

    /** 本帧动态层是否应该存在（模式 = dynamic/both）。 */
    private boolean hasDynamicLayer() {
        return "dynamic".equals(cfg.mode) || "both".equals(cfg.mode);
    }

    /**
     * 动态层是否要算上环境光与静态灯。
     *
     * <p>判定依据是「烘焙图是否<b>真的可用</b>」而不是「mode 说是 both」：
     * mode=both 但没解析到烘焙图时，静态灯与环境光只能由动态层承担，否则整个场景只剩压黑。
     */
    private boolean dynCoversStatic() {
        return bakeLayerTexture() == null;
    }

    /** 指纹：参与动态烘焙的全部输入（任一变化就重建）。 */
    private long computeDynSignature() {
        long h = 0x9E3779B97F4A7C15L;
        boolean covers = dynCoversStatic();
        h = mix(h, covers ? 1f : 0f);
        if (covers) {
            float[] amb = ambientRgb();
            h = mix(h, amb[0]);
            h = mix(h, amb[1]);
            h = mix(h, amb[2]);
        }
        h = mix(h, (float) cfg.texelsPerPixel);
        h = mix(h, (float) host.scene.width);
        h = mix(h, (float) host.scene.height);
        h = mix(h, (float) host.scene.tileSize);
        h = mix(h, (float) occluderCount());
        int cap = Math.max(0, cfg.maxDynamicLights);
        int n = 0;
        int total = scriptLights.size() + sceneLights.size();
        for (int i = 0; i < total; i++) {
            LiveLight l = lightAt(i);
            if (!isUsable(l) || (!covers && !l.dynamic)) {
                continue;
            }
            if (n >= cap) {
                break;
            }
            n++;
            h = mix(h, l.x);
            h = mix(h, l.y);
            h = mix(h, l.radius);
            h = mix(h, l.intensity);
            h = mix(h, l.dirDeg);
            h = mix(h, l.angleDeg);
            h = mix(h, l.coneSoftDeg);
            h = mix(h, l.falloff);
            h = mix(h, isSpot(l) ? 1f : 0f);
            h = mix(h, l.shadow ? 1f : 0f);
            h = mix(h, tickleOf(l));
            float[] c = parseHex(l.colorHex);
            if (c == null) {
                c = new float[]{1f, 0.788f, 0.47f};
            }
            h = mix(h, c[0]);
            h = mix(h, c[1]);
            h = mix(h, c[2]);
        }
        h = mix(h, (float) n);
        return h;
    }

    /** 一盏光本帧是否参与（{@code enabled} + 宿主未销毁）。 */
    private boolean isUsable(LiveLight l) {
        if (l == null || !l.enabled) {
            return false;
        }
        if (l.host != null && l.host.dead) {
            return false;      // 跟随的实体已销毁：立刻停光，但不改脚本设的 enabled
        }
        return true;
    }

    /** 按「脚本光 → 场景光」的顺序取第 i 盏（与 {@link #lights()} 顺序一致）。 */
    private LiveLight lightAt(int i) {
        if (i < scriptLights.size()) {
            return scriptLights.get(i);
        }
        int k = i - scriptLights.size();
        return k < sceneLights.size() ? sceneLights.get(k) : null;
    }

    private static boolean isSpot(LiveLight l) {
        return l != null && "spot".equalsIgnoreCase(l.type);
    }

    /**
     * 重建动态贴图（CPU 烘焙 → 排进宿主的待上传队列）。
     *
     * @return 是否真的重建了一张新图
     */
    private boolean rebuildDynamic() {
        if (!hasDynamicLayer()) {
            return false;
        }
        long t0 = System.nanoTime();
        float mapW = host.mapWidth();
        float mapH = host.mapHeight();
        if (!(mapW > 0f) || !(mapH > 0f)) {
            return false;
        }
        boolean covers = dynCoversStatic();
        int cap = Math.max(0, cfg.maxDynamicLights);
        List<LightMap.Light> bake = new ArrayList<LightMap.Light>();
        int total = scriptLights.size() + sceneLights.size();
        for (int i = 0; i < total; i++) {
            LiveLight l = lightAt(i);
            if (!isUsable(l) || (!covers && !l.dynamic)) {
                continue;
            }
            if (bake.size() >= cap) {
                break;                  // 契约 §3.1：maxDynamicLights 上限
            }
            LightMap.Light bl = new LightMap.Light();
            bl.id = l.phaseId;
            bl.x = l.x;
            bl.y = l.y;
            bl.radius = l.radius;
            float[] c = parseHex(l.colorHex);
            if (c == null) {
                c = new float[]{1f, 0.788f, 0.47f};     // #FFC978
            }
            bl.r = c[0];
            bl.g = c[1];
            bl.b = c[2];
            bl.intensity = l.intensity;
            bl.spot = isSpot(l);
            bl.dirDeg = l.dirDeg;
            bl.angleDeg = l.angleDeg;
            bl.coneSoftDeg = l.coneSoftDeg;
            bl.falloff = l.falloff;
            bl.shadow = l.shadow;
            bl.tickle = tickleOf(l);
            bl.dynamic = l.dynamic;
            bake.add(bl);
        }
        // 动态层「只算动态灯」时不含环境光（环境光已在烘焙图里，再加一次就整体过曝）。
        float[] ambient = covers ? ambientRgb() : new float[]{0f, 0f, 0f};

        LightMap.Result res = LightMap.bake(mapW, mapH, cfg.texelsPerPixel,
                ambient, bake, collectOccluders());

        // 柔化：半径 = softness * sEff（契约 §2.5）。softness=0 时 blur 是恒等，零成本。
        int blurRadius = Math.max(0, Math.round(cfg.softness * res.sEff));
        if (blurRadius > 0) {
            res.rgb = LightMap.blur(res.rgb, res.texW, res.texH, blurRadius);
        }
        BufferedImage img = LightMap.toImage(res.rgb, res.texW, res.texH);

        if (dynTex == null) {
            dynTex = host.textureFromImage(img);
        } else {
            // 复用实例：宿主 uploadTextures 会按「同一个 Texture + 新位图」重新上传，不泄漏 id。
            host.pendingUploads.put(dynTex, img);
        }
        dynImage = img;
        dynTexW = res.texW;
        dynTexH = res.texH;
        dynLightCount = bake.size();
        lastRebuildMs = (System.nanoTime() - t0) / 1000000L;
        rebuildCount++;
        return true;
    }

    // ==================================================================
    //  烘焙图 / 环境光兜底贴图
    // ==================================================================

    /**
     * 解析贴图：烘焙图（{@code scene.lightmap}）+ mode=baked 用的环境光兜底图。
     * 幂等；场景切换 / 上下文重建后由 {@link #invalidateGpuResources()} 复位重解析。
     */
    private void resolveTextures() {
        if (resolvedEpoch != host.sceneEpoch) {
            resolvedEpoch = host.sceneEpoch;
            bakeResolved = false;
            ambientResolved = false;
        }
        if (!bakeResolved) {
            bakeResolved = true;
            bakeTex = resolveBakeTexture();
        }
        if (!ambientResolved && bakeTex == null && !hasDynamicLayer()) {
            // 只有 mode=baked 且没有烘焙图时才需要环境光兜底图
            ambientResolved = true;
            ambientTex = buildAmbientTexture();
        } else if (!ambientResolved && bakeTex != null) {
            ambientResolved = true;          // 有烘焙图就不需要兜底
        }
    }

    /**
     * 解析 {@code scene.lightmap} 指向的素材，作为「加光层」的静态底图。
     *
     * <p>走宿主 {@code firstTextureForName}（按素材 id 缓存、内部走 {@code textureFromImage}），
     * 因此<b>自动获得</b> pendingUploads 机制与上下文重建支持 —— 本类不自己 glGenTextures。
     * 解析失败（素材不存在 / 引用了 SEQUENCE 之类）⇒ 返回 null，退回「只有环境光」的兜底图。
     */
    private Texture resolveBakeTexture() {
        if (lm == null || lm.assetId == null || lm.assetId.isEmpty()) {
            return null;
        }
        GameData.RtAsset asset = host.data.assetById(lm.assetId);
        if (asset == null || asset.name == null || asset.name.isEmpty()) {
            host.logLine("[光照] 烘焙图素材不存在（assetId=" + lm.assetId + "），退回环境光贴图");
            return null;
        }
        Texture t = host.firstTextureForName(asset.name);
        if (t == null) {
            host.logLine("[光照] 烘焙图读取失败（" + asset.name + "），退回环境光贴图");
        }
        return t;
    }

    /** 烘焙层实际可用的纹理：mode=baked/both 且解析到了烘焙图。 */
    private Texture bakeLayerTexture() {
        if ("dynamic".equals(cfg.mode)) {
            return null;
        }
        return bakeTex;
    }

    /**
     * 「只有环境光」的静态贴图。
     *
     * <p>为什么需要它：{@code lightmap} 缺失时若干脆不画加光层，画面 = 场景 * (1 - darkness)，
     * 环境光就完全丢了（整个场景变成单纯的「压黑」）。而契约 §3.2 说「lightmap 缺失 ⇒
     * mode=baked 时<b>只有环境光</b>」—— 环境光必须真的加回去。
     */
    private Texture buildAmbientTexture() {
        float mapW = host.mapWidth();
        float mapH = host.mapHeight();
        if (!(mapW > 0f) || !(mapH > 0f)) {
            ambientResolved = false;         // 场景还没就绪，下次再试
            return null;
        }
        LightMap.Result res = LightMap.bake(mapW, mapH, cfg.texelsPerPixel,
                ambientRgb(), null, null);
        int blurRadius = Math.max(0, Math.round(cfg.softness * res.sEff));
        if (blurRadius > 0) {
            res.rgb = LightMap.blur(res.rgb, res.texW, res.texH, blurRadius);
        }
        BufferedImage img = LightMap.toImage(res.rgb, res.texW, res.texH);
        if (ambientTex == null) {
            ambientTex = host.textureFromImage(img);
        } else {
            host.pendingUploads.put(ambientTex, img);
        }
        ambientImage = img;
        return ambientTex;
    }

    // ==================================================================
    //  契约 §4：诊断
    // ==================================================================

    /** 光照贴图实际纹素宽（有烘焙数据时用烘焙的 texW，否则用动态层的）。 */
    int texW() {
        if (lm != null && lm.texW > 0) {
            return lm.texW;
        }
        if (dynTexW > 0) {
            return dynTexW;
        }
        return sizeGuess(true);
    }

    int texH() {
        if (lm != null && lm.texH > 0) {
            return lm.texH;
        }
        if (dynTexH > 0) {
            return dynTexH;
        }
        return sizeGuess(false);
    }

    private int sizeGuess(boolean horizontal) {
        float w = host == null || host.scene == null ? 0f : host.mapWidth();
        float h = host == null || host.scene == null ? 0f : host.mapHeight();
        float s = cfg == null ? 0.25f : cfg.texelsPerPixel;
        LightMap.Result r = LightMap.sizeFor(w, h, s);
        return horizontal ? r.texW : r.texH;
    }

    /** 动态重建次数。 */
    int rebuildCount() {
        return rebuildCount;
    }

    /** 最近一次重建耗时（ms）。 */
    long lastRebuildMs() {
        return lastRebuildMs;
    }

    /** 参与烘焙的光源数（来自 {@code scene.lightmap.lights}）。 */
    int bakedLightCount() {
        return lm == null ? 0 : Math.max(0, lm.lights);
    }

    /** 是否有烘焙图（已解析到素材）。 */
    boolean hasBakeTexture() {
        if (host != null && host.scene != null) {
            resolveTextures();
        }
        return bakeTex != null;
    }

    /** 最近一帧画了几个<b>加光</b> quad（0/1/2）。压暗 quad 不计入（契约 §4 的取值域是 0..2）。 */
    int debugLightQuads() {
        return debugLightQuads;
    }

    /** 动态层当前参与的光源数（诊断 / 自检用，不属于契约）。 */
    int debugDynamicLightCount() {
        return dynLightCount;
    }

    /** 是否正等待重建（诊断 / 自检用）。 */
    boolean debugDirty() {
        return dirty;
    }

    /** 当前时间（自累计，诊断用）。 */
    float debugTime() {
        return time;
    }

    /** 场景光照配置（诊断用；null = 旧工程）。 */
    GameData.RtLighting debugConfig() {
        return cfg;
    }

    /**
     * 遮挡体半宽/半高的诊断入口（包内可见，供 {@code LightRenderTest} 钉住尺寸）。
     *
     * <p>存在的唯一理由：{@link #occluderHalf} 是 private，而「阴影框宽 = 绘制框宽」这条
     * 必须有断言守着 —— 它曾经真的错过一次（{@code halfW} 分支被多乘了一次 scale，
     * 阴影变成实物的 2 倍宽）。自检需要能问出真实值，所以开这个只读口子。
     */
    float debugOccluderHalfW(Actor a) {
        return occluderHalf(a, true);
    }

    /** 见 {@link #debugOccluderHalfW}。 */
    float debugOccluderHalfH(Actor a) {
        return occluderHalf(a, false);
    }

    // ==================================================================
    //  内部工具
    // ==================================================================

    /** 环境光 rgb（0..1，已乘强度，未 clamp —— 与契约 §2.2 一致）。 */
    private float[] ambientRgb() {
        float[] c = parseHex(cfg == null ? null : cfg.ambientColor);
        if (c == null) {
            c = new float[]{0.227f, 0.29f, 0.42f};    // #3A4A6B
        }
        float i = cfg == null ? 0f : cfg.ambientIntensity;
        return new float[]{c[0] * i, c[1] * i, c[2] * i};
    }

    /** 收集遮挡体（契约 §2.4）。每次重建都重新收集（脚本可以随时加/删墙）。 */
    private List<LightMap.Occluder> collectOccluders() {
        List<LightMap.Occluder> out = new ArrayList<LightMap.Occluder>();
        List<Actor> actors = host.actors;
        for (int i = 0; i < actors.size(); i++) {
            Actor a = actors.get(i);
            if (a == null || a.o == null || a.dead || !isOccluder(a.o)) {
                continue;
            }
            float hw = occluderHalf(a, true);
            float hh = occluderHalf(a, false);
            if (!(hw > 0f) || !(hh > 0f)) {
                continue;                 // 退化遮挡体（零面积）不该挡光
            }
            out.add(new LightMap.Occluder(a.x, a.y, hw, hh));
        }
        return out;
    }

    /** 本帧遮挡体数量（指纹用；只数不计尺寸，避免每帧多算一遍尺寸）。 */
    private int occluderCount() {
        int n = 0;
        List<Actor> actors = host.actors;
        for (int i = 0; i < actors.size(); i++) {
            Actor a = actors.get(i);
            if (a == null || a.o == null || a.dead) {
                continue;
            }
            if (isOccluder(a.o)) {
                n++;
            }
        }
        return n;
    }

    /**
     * 契约 §2.4：是不是遮挡体。
     *
     * <pre>
     *   props.lightBlock == "0" ⇒ 永不遮挡（显式关闭优先）
     *   props.lightBlock == "1" ⇒ 遮挡
     *   否则 tags 含 "wall" / "occluder" / "lightblock" ⇒ 遮挡
     *   否则不遮挡
     * </pre>
     */
    private boolean isOccluder(GameData.RtObject o) {
        String lb = prop(o, "lightBlock");
        if (lb != null) {
            String v = lb.trim();
            if ("0".equals(v) || "false".equalsIgnoreCase(v) || "关".equals(v)) {
                return false;               // 显式关闭优先
            }
            if ("1".equals(v) || "true".equalsIgnoreCase(v) || "开".equals(v)) {
                return true;
            }
        }
        List<String> tags = o.tags;
        if (tags == null) {
            return false;
        }
        for (int i = 0; i < tags.size(); i++) {
            String t = tags.get(i);
            if (t == null) {
                continue;
            }
            String v = t.trim().toLowerCase(Locale.ROOT);
            if ("wall".equals(v) || "occluder".equals(v) || "lightblock".equals(v)) {
                return true;
            }
        }
        return false;
    }

    /**
     * 遮挡体半宽/半高 = <b>实际绘制宽度的一半</b>。
     *
     * <p>⚠ <b>不要在这里自己写尺寸优先级链</b>！直接问宿主「这个对象画多大」：
     * {@code TopDownRuntime.drawWidth/drawHeight(Actor)} 就是渲染路径真正用的那一份
     * （带尺寸缓存，规则与编辑器 {@code painter.ts} 的 {@code sizeOf} 一致）。
     *
     * <h3>为什么这是硬规则（踩过的真实跨端 bug）</h3>
     * 我最初按契约字面在光照侧又写了一遍尺寸公式，且把 {@code scale} 乘在<b>所有</b>分支上
     * （含 {@code halfW > 0}）。而 {@code sizeOf} 的 {@code halfW > 0} 分支<b>不</b>乘 scale。
     * 结果：一个 {@code halfW=30, scaleX=2} 的墙，渲染出来是 60 宽，阴影却按 120 宽算 ——
     * <b>阴影是实物的 2 倍宽</b>。这类问题「画面看着有点怪、但所有断言都绿」，只有对像素才抓得住。
     *
     * <p>更根本的理由：<b>「画布上看到的框」和「实际挡光的框」必须是同一个数字</b>。
     * 复制一份尺寸逻辑出来，迟早与绘制那份漂移；共享同一函数则不可能漂移。
     */
    private float occluderHalf(Actor a, boolean horizontal) {
        // host.drawWidth/drawHeight 是包内可见（脚本与玩法模块也用它），内部有尺寸缓存，
        // 每帧多问两次的开销可以忽略（遮挡体数量本来就少）。
        return (horizontal ? host.drawWidth(a) : host.drawHeight(a)) / 2f;
    }

    /**
     * 当前时刻的闪烁加成（实际乘数是 {@code 1 + tickle}；契约 §2.3 第 7 条）。
     *
     * <pre>
     *   scale = 1 + flicker * sin(2π * (timeSec * 1.7 + phase))，phase = hash01(lightId)
     * </pre>
     * 烘焙图里 tickle 恒为 0（静态底图不闪）；只有动态层才会随时间变。
     */
    private float tickleOf(LiveLight l) {
        if (!(l.flicker > 0f)) {
            return 0f;
        }
        float phase = LightMap.hash01(l.phaseId);
        return l.flicker * (float) Math.sin(2.0 * Math.PI * (time * 1.7 + phase));
    }

    /** 把 float 的位模式混进 64 位指纹（参数任何改动都会变）。 */
    private static long mix(long h, float v) {
        int bits = Float.floatToIntBits(v);
        h = (h ^ (long) bits) * 1099511628211L;
        return h ^ (h >>> 29);
    }

    /** 烘焙图覆盖的世界矩形（缺数据时退回场景矩形，契约 §3.2 的 x/y/w/h）。 */
    private float quadX() {
        return lm != null && lm.w > 0f ? lm.x : 0f;
    }

    private float quadY() {
        return lm != null && lm.h > 0f ? lm.y : 0f;
    }

    private float quadW() {
        return lm != null && lm.w > 0f ? lm.w : host.mapWidth();
    }

    private float quadH() {
        return lm != null && lm.h > 0f ? lm.h : host.mapHeight();
    }

    private static String prop(GameData.RtObject o, String key) {
        if (o == null || o.props == null) {
            return null;
        }
        String v = o.props.get(key);
        if (v == null) {
            return null;
        }
        v = v.trim();
        return v.isEmpty() ? null : v;
    }

    private static float numOr(String raw, float def) {
        if (raw == null) {
            return def;
        }
        try {
            return Float.parseFloat(raw);
        } catch (NumberFormatException e) {
            return def;
        }
    }

    /** {@code "1"/"true"/"开"} ⇒ true；{@code "0"/"false"/"关"} ⇒ false；其它 ⇒ 缺省。 */
    private static boolean boolOr(String raw, boolean def) {
        if (raw == null) {
            return def;
        }
        String v = raw.trim();
        if ("1".equals(v) || "true".equalsIgnoreCase(v) || "开".equals(v)) {
            return true;
        }
        if ("0".equals(v) || "false".equalsIgnoreCase(v) || "关".equals(v)) {
            return false;
        }
        return def;
    }

    private static float clamp(float v, float lo, float hi) {
        if (Float.isNaN(v)) {
            return lo;
        }
        return v < lo ? lo : (v > hi ? hi : v);
    }

    private static float clamp01(float v) {
        if (!(v > 0f)) {
            return 0f;      // 含 NaN / 负数
        }
        return v > 1f ? 1f : v;
    }

    /** {@code #rrggbb}/{@code #rgb} → 0..1 的 {r,g,b}；非法 → null。 */
    private static float[] parseHex(String s) {
        if (s == null) {
            return null;
        }
        String t = s.trim();
        if (!t.startsWith("#")) {
            return null;
        }
        String hex = t.substring(1);
        try {
            if (hex.length() == 3) {
                hex = "" + hex.charAt(0) + hex.charAt(0)
                        + hex.charAt(1) + hex.charAt(1)
                        + hex.charAt(2) + hex.charAt(2);
            }
            if (hex.length() != 6) {
                return null;
            }
            int v = Integer.parseInt(hex, 16);
            return new float[]{((v >> 16) & 0xFF) / 255f, ((v >> 8) & 0xFF) / 255f,
                    (v & 0xFF) / 255f};
        } catch (NumberFormatException e) {
            return null;
        }
    }
}
