package Studio.data;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * 场景中的一个实例（角色 / 物件 / 地面块 / 触发区 / 出生点 …）。
 * 一切行为都来自挂在它上面的模块（ModuleInstance），对象自身只描述"是什么、在哪"。
 */
public class SceneObject {

    public String id = UUID.randomUUID().toString();
    public String name = "新对象";

    /** 对象大类：决定画布上的默认外观与可选模块范围。 */
    public ObjKind kind = ObjKind.PROP;

    public float x = 0;
    public float y = 0;
    /** 绘制层级序号，数值大的盖住小的；同层时按 z 排序。 */
    public int z = 0;
    public float rotation = 0;
    public float scaleX = 1;
    public float scaleY = 1;
    /** 是否作为碰撞体的半宽半高（像素），0 表示不参与碰撞。 */
    public float halfW = 0;
    public float halfH = 0;

    public String layerId = "";
    public boolean visible = true;
    public boolean locked = false;

    /** 外观：素材库条目 id。为空时画布画占位方框。 */
    public String assetId = "";
    /** 播放模式覆盖：跟随素材默认 / 只显示首帧 / 循环 / 单次。 */
    public String animMode = "默认";
    public float animFps = 8;

    /** 挂在这个对象上的全部模块（行为积木）。 */
    public List<ModuleInstance> modules = new ArrayList<>();
    /** 自定义键值，供剧本与模块取值。 */
    public Map<String, String> props = new LinkedHashMap<>();
    /** 标签：供"范围检查""寻路目标"等模块按标签批量选中对象。 */
    public List<String> tags = new ArrayList<>();

    public String tag(String key) {
        String v = props.get(key);
        return v == null ? "" : v;
    }

    public boolean hasTag(String t) {
        return tags.contains(t);
    }
}
