package Studio.runtime;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 场景里一个「活动对象」的运行期形态（位置、朝向、血量、动画计时等）。
 *
 * <p>原本是 {@code TopDownRuntime} 的内部类；玩法模块（扫雷棋盘、换装、脚本实体）
 * 都要引用它，因此提升为包级类，让玩法文件可以独立存在而不必依赖宿主类内部结构。
 */
final class Actor {
    GameData.RtObject o;
    float x;
    float y;
    float faceX = 0f;
    float faceY = 1f;
    float hp = 10f;
    float hpMax = 10f;
    boolean dead;
    float animT;
    int animIdx;

    /**
     * 稳定唯一 id（首次被 {@code bwe.collision} 用到时由静态计数器分配）。
     *
     * <p>为什么不用 {@code o.id}：脚本 {@code spawn()} 出来的实体的 {@code o.id}
     * 可能是空串或重复（编辑器生成的 uuid 与运行期生成的对象混在一起）。
     * 碰撞 pair 的 key 必须<b>严格唯一且稳定</b>，否则会出现"同一对物体反复 enter/exit"。
     */
    long uid;

    /** 是否传感器（触发区）：不参与碰撞求解，只派发 trigger 事件。 */
    boolean trigger;

    /**
     * 实体当前所在楼层序号（<b>空间归属的权威值</b>）。
     *
     * <p>为什么必须存状态、不能只按坐标现算：俯视角下各楼层在 2D 空间上
     * <b>完全重叠</b>（二楼房间的 AABB 与一楼一模一样）。只按 (x,y) 反查区域，
     * 永远只能查到"后建的那个 zone"，等于分不出楼层 —— NPC 就会"穿楼板"。
     * 所以楼层归属由 <b>link 驱动</b>：走楼梯 / 电梯时改写这个值；只有通过 link
     * 才能改变层级。这正是任务书「NPC 不能穿过楼板寻路」的落地方式。
     *
     * <p>缺省 -1 = 尚未解析（由位置推导一次，见 {@code ScriptSpatial.resolveLevel}）。
     */
    int floorLevel = -1;

    GameData.RtAsset asset;
    final List<Texture> textures = new ArrayList<>();
    final List<TopDownRuntime.Frame> frames = new ArrayList<>();
    int texW;
    int texH;

    TopDownRuntime.DressPart dress;
    Minesweeper mine;

    float baseX;
    float baseY;
    float wanderT;
    float wanderDirX;
    float wanderDirY;

    /**
     * 纯色块颜色的解析缓存（{@code props.color}）。
     *
     * <p>无贴图对象每帧都要取颜色，而 HashMap 查 props + 解析 "#rrggbb" 是热路径开销。
     * 缓存按「props 表身份 + 原始字符串」校验，所以脚本改了 color 会立刻生效。
     */
    java.util.Map<String, String> colorCacheProps;
    String colorCacheRaw;
    java.awt.Color colorCache;

    /**
     * 染色（0~1 的 r,g,b,a 乘数）。{@code null} = 不染色，走最快的原路径。
     * 由脚本 {@code e.setColor(r,g,b,a)} 设置 —— 存在 Actor 上而不是 Map 里，
     * 因为这是每帧每精灵都要读的热字段；Map 查询会让染色实例的绘制成本翻倍。
     */
    float[] tint;
    /** 染色乘数缓存（避免每帧从 float[] 拆包 4 次）。 */
    float tintR = 1f;
    float tintG = 1f;
    float tintB = 1f;
    float tintA = 1f;
    /** 染色版本号：脚本改了颜色就 +1，渲染侧据此决定要不要重新拆包。 */
    int tintVersion;
    int tintAppliedVersion = -1;

    /**
     * 绘制尺寸的缓存 + 它的原始输入。{@code sizeOf()} 要读 props 的 "w"/"h"
     * （HashMap 查找 + parseFloat），而 drawActor/drawHp 一帧内会问 5~7 次。
     * 缓存<b>按输入校验</b>（不是按帧），所以脚本在同一帧内改尺寸也能立刻生效。
     */
    float cachedW;
    float cachedH;
    /** 缓存失效标记：-1 = 从没算过。 */
    int sizeStamp = -1;
    // 缓存对应的原始输入（用于下次校验）
    float sigHalfW;
    float sigHalfH;
    float sigScaleX;
    float sigScaleY;
    int sigTexW;
    int sigTexH;
    GameData.RtAsset sigAsset;
    float sigPropsW;
    float sigPropsH;
    }