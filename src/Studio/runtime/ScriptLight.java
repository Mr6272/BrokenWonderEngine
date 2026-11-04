package Studio.runtime;

import org.mozilla.javascript.Context;
import org.mozilla.javascript.Scriptable;

import java.util.ArrayList;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;

/**
 * 2D 光照脚本命名空间 {@code bwe.light}（契约 {@code docs/_fragments/lighting-contract.md} §4，
 * 内部边界 {@code docs/_fragments/lighting-java-api.md} §6）。
 *
 * <h3>解决什么问题</h3>
 * 世界光照层（压暗 + 加光）由 {@link Lighting} 负责，但脚本原本没有任何手段去
 * 「入夜 / 点火把 / 打一发闪光」—— 只能改场景数据再重载工程。本类把契约 §4 的 12 个成员
 * 接到 {@link Lighting} 上，让脚本能在运行时拨亮度、挂跟随实体的光、加临时光。
 *
 * <h3>成员注册形态：全方法（不用 getter/setter）</h3>
 * 12 个成员<b>全部</b>用 {@code api.addMethod} 注册，形式是「传参 = 写、省略 = 读」
 * （例如 {@code bwe.light.darkness(0.9)} / {@code bwe.light.darkness()}）。理由：
 * <ol>
 *   <li>{@code verify-apidocs} 会把 getter/setter 归一成 {@code .darkness [属性]}，虽然
 *       {@code bwe.d.ts} 侧同名属性也能对上，但「同一名字既当方法又当属性」会让四方集合比对
 *       出现假差异。本轮纪律要求二选一并保持一致，这里选全方法。</li>
 *   <li>契约 §4 的代码块本身就是方法形态（{@code enabled(flag?) -> boolean}），逐字对齐
 *       风险最小。</li>
 *   <li>剧本作者不用记「读用属性、写用方法」两套写法。</li>
 * </ol>
 *
 * <h3>归因变量名 {@code navLight}（不要改成 ns）</h3>
 * {@code verify-apidocs} 靠 {@code api.attach("light", <变量>)} 建立「变量 → bwe.light」映射，
 * 再按<b>文件作用域</b>把 {@code api.addMethod(变量, ...)} 归到那个命名空间。仓库里已有
 * 9 个文件把命名空间对象叫 {@code ns}（写入方用限定名 {@code d.ns}）。工具已经按文件分表，
 * 但为了彻底避开「全局别名广播」那个坑（它的注释里写了实测事故），这里刻意用
 * <b>全仓唯一</b>的变量名 {@code navLight}。
 *
 * <h3>Rhino / ES5 纪律</h3>
 * <ul>
 *   <li>返回给脚本的一律是 {@code ScriptJs.Flex} / JS 原生数组 / 基本类型
 *       （{@code Boolean} / {@code Double} / {@code String}），不返回 Java 集合；</li>
 *   <li><b>任何情况下都不把 Java 异常抛进 JS</b>：非法参数返回 {@code false} 或当前值。
 *       Rhino 里一个未捕获异常会打断整段脚本，代价远大于「静默忽略」；</li>
 *   <li>参数解析统一走 {@code ScriptJs.arg/str/fnum/bool/isMissing}。</li>
 * </ul>
 *
 * <h3>与 {@link Lighting} 的分工（哪边存状态）</h3>
 * <ul>
 *   <li>{@code enabled/ambient/darkness/mode} —— 直接读写 {@link Lighting}；</li>
 *   <li>{@code add/remove} —— 走 {@code addLiveLight(null)} / {@code removeLiveLight(id)}，
 *       独立光由 {@link Lighting} 持有；</li>
 *   <li>{@code attach/detach/set} —— <b>不</b>新建 LiveLight，而是写对象的契约 §3.3 props
 *       （{@code lightRadius} / {@code lightColor} / … / {@code lightDynamic="1"}）。
 *       {@link Lighting} 每帧从 props + 模块重新收集场景光源（见它的
 *       {@code syncSceneLights()}），所以写完下一帧就生效，且实体移动时
 *       {@code Lighting} 会把该对象的 {@code (x, y)} 每帧重新同步给那盏场景光 ——
 *       位置自动跟随，不需要脚本自己刷。</li>
 * </ul>
 * 本类只在 {@link #attached} 里记「哪些实体是 {@code attach} 挂的、原来 props 是什么」，
 * 用来实现 {@code detach} 的<b>还原</b>语义（把编辑器原本的 prop 值恢复回去，而不是抹成 0）。
 */
final class ScriptLight {

    /** 最近一次安装的实例（诊断/自检用，不是脚本 API）。 */
    static ScriptLight LAST;

    // ---- 契约 §3.3 的 props 键名。字符串字面量集中在这里，避免各处手写漂移。 ----
    private static final String P_RADIUS = "lightRadius";
    private static final String P_COLOR = "lightColor";
    private static final String P_INTENSITY = "lightIntensity";
    private static final String P_TYPE = "lightType";
    private static final String P_ANGLE = "lightAngle";
    private static final String P_DIR = "lightDir";
    private static final String P_CONE_SOFT = "lightConeSoft";
    private static final String P_FALLOFF = "lightFalloff";
    private static final String P_SHADOW = "lightShadow";
    private static final String P_FLICKER = "lightFlicker";
    private static final String P_DYNAMIC = "lightDynamic";

    /** {@code attach} 会写的那批键（detach 时按这张表还原）。 */
    private static final String[] ATTACH_KEYS = {
            P_RADIUS, P_COLOR, P_INTENSITY, P_TYPE,
            P_ANGLE, P_DIR, P_CONE_SOFT, P_FALLOFF,
            P_SHADOW, P_FLICKER, P_DYNAMIC,
    };

    /** 缺省值（契约 §3.3）。{@code attach} 时不传的字段直接不写，由 {@link Lighting} 用同一批缺省。 */
    private static final float DEF_RADIUS = 140f;
    private static final String DEF_COLOR = "#FFC978";
    private static final float DEF_INTENSITY = 1f;
    private static final String DEF_TYPE = "point";
    private static final float DEF_ANGLE = 60f;
    private static final float DEF_CONE_SOFT = 10f;
    private static final float DEF_FALLOFF = 2f;
    private static final boolean DEF_SHADOW = true;

    private final ScriptApi api;
    private final TopDownRuntime host;
    private final Scriptable scope;
    /**
     * 命名空间对象。变量名 {@code navLight} 是<b>全仓唯一</b>的，供
     * {@code verify-apidocs} 归因（见类注释）。
     */
    private final ScriptJs.Flex navLight;

    /**
     * 由 {@code attach} 挂上光的实体 → 它被覆盖前的 props 原值。
     *
     * <p>为什么存原值而不是「记一个标记属性」：契约 §3.3 明确「光源与遮挡体写在对象上，
     * <b>零新字段</b>」，往 props 里塞 {@code lightScript="1"} 这类私有标记就是新字段，
     * 会污染场景数据格式（编辑器导出/回写都会带上它）。用 IdentityHashMap 只存在内存里，
     * 同时让 {@code detach} 能<b>精确还原</b>编辑器原本给这盏灯写的参数，而不是一刀切成 0。
     */
    private final Map<Actor, Map<String, String>> attached =
            new IdentityHashMap<Actor, Map<String, String>>();

    private ScriptLight(ScriptApi api) {
        this.api = api;
        this.host = api.hostRef();
        this.navLight = (ScriptJs.Flex) api.newObj();
        this.scope = navLight.getParentScope();
    }

    static void install(ScriptApi api) {
        ScriptLight s = new ScriptLight(api);
        s.build();
        api.attach("light", s.navLight);
        LAST = s;
    }

    // ---------------- 命名空间 ----------------

    private void build() {
        // ---- 1. enabled(flag?) → boolean ----
        api.addMethod(navLight, "enabled", (cx, thisObj, args) -> {
            Lighting lg = lighting();
            if (lg == null) {
                return Boolean.FALSE;
            }
            Object v = ScriptJs.arg(args, 0);
            if (!ScriptJs.isMissing(v)) {
                lg.setEnabled(ScriptJs.bool(v, lg.isEnabled()));
                lg.markDirty();
            }
            return Boolean.valueOf(lg.isEnabled());
        });

        // ---- 2. ambient(color?, intensity?) → {color, intensity} ----
        api.addMethod(navLight, "ambient", (cx, thisObj, args) -> {
            Lighting lg = lighting();
            if (lg == null) {
                return ambientObj(DEF_AMBIENT_COLOR, DEF_AMBIENT_INTENSITY);
            }
            Object rawColor = ScriptJs.arg(args, 0);
            Object rawIntensity = ScriptJs.arg(args, 1);
            boolean wantsWrite = false;
            String hex = null;
            Float inten = null;
            if (!ScriptJs.isMissing(rawColor)) {
                String s = ScriptJs.str(rawColor, "");
                // 非法颜色：忽略该参数（不是整个调用失败）—— 与契约「非法输入返回当前值」一致。
                if (isHexColor(s)) {
                    hex = s;
                    wantsWrite = true;
                }
            }
            if (!ScriptJs.isMissing(rawIntensity)) {
                float f = ScriptJs.fnum(rawIntensity, lg.ambientIntensity());
                if (!Float.isNaN(f) && !Float.isInfinite(f)) {
                    inten = Float.valueOf(clamp(f, 0f, 1f));
                    wantsWrite = true;
                }
            }
            if (wantsWrite) {
                // setAmbient 的语义是「两个参数一起下发」，所以缺一个就补当前值：
                // 只改颜色时把强度传当前值，只改强度时把颜色传当前值 —— 不会误伤另一半。
                String useHex = hex != null ? hex : lg.ambientColorHex();
                float useInten = inten != null ? inten.floatValue() : lg.ambientIntensity();
                lg.setAmbient(useHex, useInten);
                lg.markDirty();
            }
            return ambientObj(lg.ambientColorHex(), lg.ambientIntensity());
        });

        // ---- 3. darkness(v?) → number ----
        api.addMethod(navLight, "darkness", (cx, thisObj, args) -> {
            Lighting lg = lighting();
            if (lg == null) {
                return Double.valueOf(0d);
            }
            Object v = ScriptJs.arg(args, 0);
            if (!ScriptJs.isMissing(v)) {
                float f = ScriptJs.fnum(v, lg.darkness());
                if (!Float.isNaN(f) && !Float.isInfinite(f)) {
                    lg.setDarkness(clamp(f, 0f, 1f));
                    lg.markDirty();
                }
            }
            return Double.valueOf(lg.darkness());
        });

        // ---- 4. mode(m?) → string ----
        api.addMethod(navLight, "mode", (cx, thisObj, args) -> {
            Lighting lg = lighting();
            if (lg == null) {
                return "both";
            }
            Object v = ScriptJs.arg(args, 0);
            if (!ScriptJs.isMissing(v)) {
                String m = ScriptJs.str(v, "");
                // 非法模式：忽略（返回当前模式），既不写也不抛。
                // 归一化（trim + 小写）与 Lighting.setMode 保持一致 —— 它本身也是这么做的，
                // 但这里先归一化才能保证 isMode 的判断与它一致（"BOTH " 也认）。
                String norm = m == null ? "" : m.trim().toLowerCase(java.util.Locale.ROOT);
                if (isMode(norm)) {
                    lg.setMode(norm);
                    lg.markDirty();
                }
            }
            return lg.mode();
        });

        // ---- 5. attach(e, opts?) → boolean ----
        api.addMethod(navLight, "attach", (cx, thisObj, args) -> {
            Actor a = api.actorOf(ScriptJs.arg(args, 0));
            if (a == null || a.dead || a.o == null) {
                return Boolean.FALSE;
            }
            if (!attached.containsKey(a)) {
                attached.put(a, snapshotLightProps(a));
            }
            applyOpts(a, ScriptJs.arg(args, 1));
            // 跟随实体的光必须由运行时动态算：烘焙图是静态底图，不可能跟着实体跑。
            // 所以这里强制 lightDynamic="1"，opts.dynamic=false 会被忽略（契约 §3.3：
            //「移动/跟随实体的光必须为 1」）。detach 时按快照还原。
            a.o.props.put(P_DYNAMIC, "1");
            touch();
            return Boolean.TRUE;
        });

        // ---- 6. detach(e) → boolean ----
        api.addMethod(navLight, "detach", (cx, thisObj, args) -> {
            Actor a = api.actorOf(ScriptJs.arg(args, 0));
            if (a == null || a.o == null) {
                return Boolean.FALSE;
            }
            Map<String, String> prev = attached.remove(a);
            if (prev == null) {
                // 不是 attach 挂的（例如场景原生的 LIGHT 对象）→ 不动它，返回 false。
                // 想关掉原生光请改 lightIntensity / visible。
                return Boolean.FALSE;
            }
            restoreLightProps(a, prev);
            touch();
            return Boolean.TRUE;
        });

        // ---- 7. set(e, opts) → boolean ----
        api.addMethod(navLight, "set", (cx, thisObj, args) -> {
            Actor a = api.actorOf(ScriptJs.arg(args, 0));
            if (a == null || a.dead || a.o == null) {
                return Boolean.FALSE;
            }
            if (!attached.containsKey(a)) {
                // set 是「改已挂的光」，不新建。没挂过就 false（用 attach 才建）。
                return Boolean.FALSE;
            }
            applyOpts(a, ScriptJs.arg(args, 1));
            // set 同样强制动态：实体光不可能进静态烘焙图（契约 §3.3）。
            a.o.props.put(P_DYNAMIC, "1");
            touch();
            return Boolean.TRUE;
        });

        // ---- 8. add(opts) → number（handle） ----
        api.addMethod(navLight, "add", (cx, thisObj, args) -> {
            Lighting lg = lighting();
            if (lg == null) {
                return Double.valueOf(-1d);
            }
            // host = null ⇒ 独立光，不跟实体。
            Lighting.LiveLight L = lg.addLiveLight(null);
            if (L == null) {
                return Double.valueOf(-1d);
            }
            applyLiveOpts(L, ScriptJs.arg(args, 0));
            lg.markDirty();
            return Double.valueOf((double) L.id);
        });

        // ---- 9. remove(handle) → boolean ----
        api.addMethod(navLight, "remove", (cx, thisObj, args) -> {
            Lighting lg = lighting();
            if (lg == null) {
                return Boolean.FALSE;
            }
            Object v = ScriptJs.arg(args, 0);
            if (ScriptJs.isMissing(v)) {
                return Boolean.FALSE;
            }
            // 必须是数字：传字符串 / 对象一律 false（不抛）。Double 转换失败也用 0 兜底。
            if (!(v instanceof Number)) {
                return Boolean.FALSE;
            }
            long id = ((Number) v).longValue();
            boolean ok = lg.removeLiveLight(id);
            if (ok) {
                lg.markDirty();
            }
            return Boolean.valueOf(ok);
        });

        // ---- 10. list() → LightEntry[] ----
        //
        // ⚠ 必须返回 **JS 原生数组**：Rhino 会把 Java List 包成 Java 对象，
        // 脚本里 .length / 下标 / for(var i...) / JSON.stringify 全都拿不到元素
        // （ScriptDebug.errors 踩过同一个坑）。
        api.addMethod(navLight, "list", (cx, thisObj, args) -> {
            Lighting lg = lighting();
            List<Object> out = new ArrayList<Object>();
            if (lg != null) {
                List<Lighting.LiveLight> lights = lg.lights();
                if (lights != null) {
                    for (int i = 0; i < lights.size(); i++) {
                        Lighting.LiveLight L = lights.get(i);
                        if (L == null) {
                            continue;
                        }
                        ScriptJs.Flex o = (ScriptJs.Flex) api.newObj();
                        ScriptJs.put(o, "id", Double.valueOf((double) L.id));
                        ScriptJs.put(o, "x", Double.valueOf((double) L.x));
                        ScriptJs.put(o, "y", Double.valueOf((double) L.y));
                        ScriptJs.put(o, "radius", Double.valueOf((double) L.radius));
                        ScriptJs.put(o, "color", L.colorHex == null ? DEF_COLOR : L.colorHex);
                        ScriptJs.put(o, "intensity", Double.valueOf((double) L.intensity));
                        ScriptJs.put(o, "type", L.type == null ? DEF_TYPE : L.type);
                        ScriptJs.put(o, "dynamic", Boolean.valueOf(L.dynamic));
                        out.add(o);
                    }
                }
            }
            return toArray(cx, out);
        });

        // ---- 11. stats() → {enabled, mode, lights, baked, dynamic, rebuilds, lastMs, texW, texH} ----
        api.addMethod(navLight, "stats", (cx, thisObj, args) -> {
            ScriptJs.Flex o = (ScriptJs.Flex) api.newObj();
            Lighting lg = lighting();
            if (lg == null) {
                ScriptJs.put(o, "enabled", Boolean.FALSE);
                ScriptJs.put(o, "mode", "both");
                ScriptJs.put(o, "lights", Double.valueOf(0d));
                ScriptJs.put(o, "baked", Double.valueOf(0d));
                ScriptJs.put(o, "dynamic", Double.valueOf(0d));
                ScriptJs.put(o, "rebuilds", Double.valueOf(0d));
                ScriptJs.put(o, "lastMs", Double.valueOf(0d));
                ScriptJs.put(o, "texW", Double.valueOf(0d));
                ScriptJs.put(o, "texH", Double.valueOf(0d));
                return o;
            }
            int dynamicCount = 0;
            List<Lighting.LiveLight> lights = lg.lights();
            if (lights != null) {
                for (int i = 0; i < lights.size(); i++) {
                    Lighting.LiveLight L = lights.get(i);
                    if (L != null && L.dynamic) {
                        dynamicCount++;
                    }
                }
            }
            ScriptJs.put(o, "enabled", Boolean.valueOf(lg.isEnabled()));
            ScriptJs.put(o, "mode", lg.mode() == null ? "both" : lg.mode());
            ScriptJs.put(o, "lights", Double.valueOf(lights == null ? 0d : (double) lights.size()));
            ScriptJs.put(o, "baked", Double.valueOf((double) lg.bakedLightCount()));
            ScriptJs.put(o, "dynamic", Double.valueOf((double) dynamicCount));
            ScriptJs.put(o, "rebuilds", Double.valueOf((double) lg.rebuildCount()));
            ScriptJs.put(o, "lastMs", Double.valueOf((double) lg.lastRebuildMs()));
            ScriptJs.put(o, "texW", Double.valueOf((double) lg.texW()));
            ScriptJs.put(o, "texH", Double.valueOf((double) lg.texH()));
            return o;
        });

        // ---- 12. rebuild() → boolean ----
        //
        // 脚本回调（onStart / onUpdate）跑在 GL 上下文**之外**，拿不到 GL2 句柄，
        // 所以这里不能调 forceRebuild(GL2)（它要求上下文 current）。
        // Lighting.requestRebuild() 的语义正是「置重建请求 + 跳过 dynamicFps 节流，
        // 下一条 draw 里真的重建/上传」。所以返回 true = 「请求已受理」，
        // 而不是「返回时贴图已经重建好」—— 文档里写清这一点。
        api.addMethod(navLight, "rebuild", (cx, thisObj, args) -> {
            Lighting lg = lighting();
            if (lg == null) {
                return Boolean.FALSE;
            }
            lg.requestRebuild();
            return Boolean.TRUE;
        });
    }

    // ---------------- 参数落地 ----------------

    /**
     * 把 opts 写进实体的契约 §3.3 props。
     *
     * <p>语义是<b>局部更新</b>：opts 里没出现的字段一律不动（{@code attach} 第一次挂时
     * 就是「什么都不写，让 Lighting 用缺省」）。只有出现的合法值才写 —— 非法值跳过该字段，
     * 不影响其它字段生效。
     *
     * <p><b>这里不处理 {@code dynamic}</b>：实体光恒为动态（跟随实体不可能进静态烘焙图），
     * 由 {@code attach} / {@code set} 的调用点统一强制 {@code lightDynamic="1"}。
     */
    private void applyOpts(Actor a, Object opts) {
        if (ScriptJs.isMissing(opts)) {
            return;
        }
        Map<String, String> props = a.o.props;

        // radius —— 世界像素，>= 0（0 = 不发光，合法值，不算非法）。
        Object v = ScriptJs.get(opts, "radius");
        if (!ScriptJs.isMissing(v)) {
            float f = fnumIfFinite(v);
            if (f >= 0f) {
                props.put(P_RADIUS, fmt(f));
            }
        }

        Object c = ScriptJs.get(opts, "color");
        if (!ScriptJs.isMissing(c)) {
            String s = ScriptJs.str(c, "");
            if (isHexColor(s)) {
                props.put(P_COLOR, s);
            }
        }

        Object in = ScriptJs.get(opts, "intensity");
        if (!ScriptJs.isMissing(in)) {
            float f = fnumIfFinite(in);
            if (f >= 0f) {
                props.put(P_INTENSITY, fmt(clamp(f, 0f, 4f)));
            }
        }

        Object t = ScriptJs.get(opts, "type");
        if (!ScriptJs.isMissing(t)) {
            String s = ScriptJs.str(t, "");
            if ("point".equals(s) || "spot".equals(s)) {
                props.put(P_TYPE, s);
            }
        }

        Object ang = ScriptJs.get(opts, "angle");
        if (!ScriptJs.isMissing(ang)) {
            float f = fnumIfFinite(ang);
            if (f > 0f) {
                props.put(P_ANGLE, fmt(clamp(f, 0f, 360f)));
            }
        }

        Object dir = ScriptJs.get(opts, "dir");
        if (!ScriptJs.isMissing(dir)) {
            float f = fnumIfFinite(dir);
            // 方向允许任意角度（会 normalizeToPi），只要不是 NaN/Inf。
            if (f == f) {
                props.put(P_DIR, fmt(f));
            }
        }

        Object cs = ScriptJs.get(opts, "coneSoft");
        if (!ScriptJs.isMissing(cs)) {
            float f = fnumIfFinite(cs);
            if (f >= 0f) {
                props.put(P_CONE_SOFT, fmt(clamp(f, 0f, 180f)));
            }
        }

        Object fo = ScriptJs.get(opts, "falloff");
        if (!ScriptJs.isMissing(fo)) {
            float f = fnumIfFinite(fo);
            if (f > 0f) {
                props.put(P_FALLOFF, fmt(clamp(f, 1f, 4f)));
            }
        }

        Object sh = ScriptJs.get(opts, "shadow");
        if (!ScriptJs.isMissing(sh)) {
            props.put(P_SHADOW, ScriptJs.bool(sh, DEF_SHADOW) ? "1" : "0");
        }

        Object fl = ScriptJs.get(opts, "flicker");
        if (!ScriptJs.isMissing(fl)) {
            float f = fnumIfFinite(fl);
            if (f >= 0f) {
                props.put(P_FLICKER, fmt(clamp(f, 0f, 1f)));
            }
        }
        // dynamic 见方法注释：实体光恒为动态，由调用点强制写 1，这里刻意不读该字段。
    }

    /** 把 opts 写进一盏独立光（{@code add} 用；字段语义与 {@link #applyOpts} 相同）。 */
    private void applyLiveOpts(Lighting.LiveLight L, Object opts) {
        if (ScriptJs.isMissing(opts)) {
            L.dynamic = true;   // 缺省 opts = 一盏动态光（不污染烘焙底图）
            return;
        }
        Object x = ScriptJs.get(opts, "x");
        if (!ScriptJs.isMissing(x)) {
            float f = fnumIfFinite(x);
            if (f == f) {
                L.x = f;
            }
        }
        Object y = ScriptJs.get(opts, "y");
        if (!ScriptJs.isMissing(y)) {
            float f = fnumIfFinite(y);
            if (f == f) {
                L.y = f;
            }
        }
        Object r = ScriptJs.get(opts, "radius");
        if (!ScriptJs.isMissing(r)) {
            float f = fnumIfFinite(r);
            if (f >= 0f) {
                L.radius = f;
            }
        }
        Object c = ScriptJs.get(opts, "color");
        if (!ScriptJs.isMissing(c)) {
            String s = ScriptJs.str(c, "");
            if (isHexColor(s)) {
                L.colorHex = s;
            }
        }
        Object in = ScriptJs.get(opts, "intensity");
        if (!ScriptJs.isMissing(in)) {
            float f = fnumIfFinite(in);
            if (f >= 0f) {
                L.intensity = clamp(f, 0f, 4f);
            }
        }
        Object t = ScriptJs.get(opts, "type");
        if (!ScriptJs.isMissing(t)) {
            String s = ScriptJs.str(t, "");
            if ("point".equals(s) || "spot".equals(s)) {
                L.type = s;
            }
        }
        Object ang = ScriptJs.get(opts, "angle");
        if (!ScriptJs.isMissing(ang)) {
            float f = fnumIfFinite(ang);
            if (f > 0f) {
                L.angleDeg = clamp(f, 0f, 360f);
            }
        }
        Object dir = ScriptJs.get(opts, "dir");
        if (!ScriptJs.isMissing(dir)) {
            float f = fnumIfFinite(dir);
            if (f == f) {
                L.dirDeg = f;
            }
        }
        Object cs = ScriptJs.get(opts, "coneSoft");
        if (!ScriptJs.isMissing(cs)) {
            float f = fnumIfFinite(cs);
            if (f >= 0f) {
                L.coneSoftDeg = clamp(f, 0f, 180f);
            }
        }
        Object fo = ScriptJs.get(opts, "falloff");
        if (!ScriptJs.isMissing(fo)) {
            float f = fnumIfFinite(fo);
            if (f > 0f) {
                L.falloff = clamp(f, 1f, 4f);
            }
        }
        Object sh = ScriptJs.get(opts, "shadow");
        if (!ScriptJs.isMissing(sh)) {
            L.shadow = ScriptJs.bool(sh, DEF_SHADOW);
        }
        Object fl = ScriptJs.get(opts, "flicker");
        if (!ScriptJs.isMissing(fl)) {
            float f = fnumIfFinite(fl);
            if (f >= 0f) {
                L.flicker = clamp(f, 0f, 1f);
            }
        }
        Object dy = ScriptJs.get(opts, "dynamic");
        if (!ScriptJs.isMissing(dy)) {
            L.dynamic = ScriptJs.bool(dy, false);
        } else {
            // 契约没写 add 的 dynamic 缺省。按「烘焙底图不该被脚本临时光污染」定：缺省动态。
            L.dynamic = true;
        }
    }

    // ---------------- props 快照 / 还原（detach 用） ----------------

    /** 快照 {@code attach} 会写的那批键的原值（不存在的键也记下来，值为 null）。 */
    private static Map<String, String> snapshotLightProps(Actor a) {
        Map<String, String> prev = new java.util.LinkedHashMap<String, String>();
        for (int i = 0; i < ATTACH_KEYS.length; i++) {
            // 用 containsKey 区分「原本没有」与「原本是空串」—— 还原时必须一模一样。
            prev.put(ATTACH_KEYS[i], a.o.props.get(ATTACH_KEYS[i]));
        }
        return prev;
    }

    /** 精确还原：原本存在的键写回原值，原本不存在的键删掉（不留空串污染场景数据）。 */
    private static void restoreLightProps(Actor a, Map<String, String> prev) {
        Map<String, String> props = a.o.props;
        for (int i = 0; i < ATTACH_KEYS.length; i++) {
            String k = ATTACH_KEYS[i];
            String v = prev.get(k);
            if (v == null) {
                props.remove(k);
            } else {
                props.put(k, v);
            }
        }
    }

    // ---------------- 工具 ----------------

    /** 宿主的光照实例；宿主还没建好时返回 null（调用方一律按「安全无操作」处理）。 */
    private Lighting lighting() {
        return host == null ? null : host.lighting;
    }

    /** 标脏：让下一帧重建（不立刻重建，见 {@link #build} 的 rebuild 说明）。 */
    private void touch() {
        Lighting lg = lighting();
        if (lg != null) {
            lg.markDirty();
        }
    }

    private ScriptJs.Flex ambientObj(String color, float intensity) {
        ScriptJs.Flex o = (ScriptJs.Flex) api.newObj();
        ScriptJs.put(o, "color", color == null ? DEF_AMBIENT_COLOR : color);
        ScriptJs.put(o, "intensity", Double.valueOf((double) intensity));
        return o;
    }

    /** Java List → JS 原生数组（见 list 的说明，不能直接返回 List）。 */
    private Object toArray(Context cx, List<Object> items) {
        Object[] arr = items.toArray(new Object[items.size()]);
        return cx == null ? arr : cx.newArray(scope, arr);
    }

    /**
     * 取一个「可能是非法值」的数字：缺失 / 非数字 → {@code NaN}，由调用方判
     * {@code f >= 0} / {@code f == f} 决定要不要写。{@code NaN} 与自身比较恒 false，
     * 所以 {@code f == f} 就是「不是 NaN」（顺带排除 ±Inf 的只有下面 {@code isFinite} 版本）。
     */
    private static float fnumIfFinite(Object v) {
        float f = ScriptJs.fnum(v, Float.NaN);
        if (Float.isInfinite(f)) {
            return Float.NaN;
        }
        return f;
    }

    private static float clamp(float v, float lo, float hi) {
        return v < lo ? lo : (v > hi ? hi : v);
    }

    /** 格式化成 props 里的文本（去掉多余小数位；解析侧是 parseFloat，都认）。 */
    private static String fmt(float f) {
        if (f == (int) f) {
            return Integer.toString((int) f);
        }
        return Float.toString(f);
    }

    /** `"#rrggbb"` / `"#rgb"` / 无 `#` 的六位十六进制。解析由 Lighting 负责，这里只挡明显非法值。 */
    private static boolean isHexColor(String s) {
        if (s == null) {
            return false;
        }
        int i = s.startsWith("#") ? 1 : 0;
        int n = s.length() - i;
        if (n != 6 && n != 3) {
            return false;
        }
        for (int k = i; k < s.length(); k++) {
            char c = s.charAt(k);
            boolean hex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
            if (!hex) {
                return false;
            }
        }
        return true;
    }

    private static boolean isMode(String m) {
        return "baked".equals(m) || "dynamic".equals(m) || "both".equals(m);
    }

    private static final String DEF_AMBIENT_COLOR = "#3A4A6B";
    private static final float DEF_AMBIENT_INTENSITY = 0.35f;

    // ---------------- 包内测试入口 ----------------
    //
    // 不是脚本 API（不走 api.addMethod）。

    /** 通过 {@code attach} 挂上光的实体数（自检用）。 */
    int attachedCount() {
        return attached.size();
    }

    /** 某个实体是否由 {@code attach} 挂了光（自检用）。 */
    boolean isAttached(Actor a) {
        return a != null && attached.containsKey(a);
    }

    /** 场景卸载：实体已经没了，清掉还原表，避免 IdentityHashMap 长期持有死 Actor。 */
    void clearSceneState() {
        attached.clear();
    }

    /** 包内可见的缺省值，自检断言用（避免测试里各写一份字面量）。 */
    static float defaultRadius() {
        return DEF_RADIUS;
    }

    static String defaultColor() {
        return DEF_COLOR;
    }

    static float defaultIntensity() {
        return DEF_INTENSITY;
    }
}
