package Studio.data;

import java.util.LinkedHashMap;
import java.util.Map;

/** 挂在对象上的一个模块实例：选哪个积木 + 填了什么值 + 什么时候生效。 */
public class ModuleInstance {

    /** 指向 ModuleDef.id。 */
    public String defId = "";
    /** 同一对象上可以有多个同类模块，用 label 区分（可空）。 */
    public String label = "";
    /** 触发时机覆盖；空表示用定义里的默认值。 */
    public Trigger trigger = null;
    /** 参数值，键为 ParamDef.key。 */
    public Map<String, String> values = new LinkedHashMap<>();
    /** 关掉但保留，方便做 A/B 对比，不用删了再加回来。 */
    public boolean enabled = true;
    /** 折叠状态：积木默认收起，只显示一行摘要，界面更干净。 */
    public boolean collapsed = true;

    public ModuleInstance() {
    }

    public ModuleInstance(String defId) {
        this.defId = defId;
    }

    public String value(String key, String fallback) {
        String v = values.get(key);
        return v == null || v.isEmpty() ? fallback : v;
    }

    public void set(String key, String v) {
        values.put(key, v);
    }

    public int intOf(String key, int fallback) {
        try {
            return Integer.parseInt(value(key, String.valueOf(fallback)).trim());
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    public float floatOf(String key, float fallback) {
        try {
            return Float.parseFloat(value(key, String.valueOf(fallback)).trim());
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    public boolean boolOf(String key, boolean fallback) {
        String v = value(key, fallback ? "开" : "关");
        return v.equalsIgnoreCase("开") || v.equalsIgnoreCase("true") || v.equalsIgnoreCase("1") || v.equalsIgnoreCase("是");
    }
}
