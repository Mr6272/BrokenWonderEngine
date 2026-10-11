package Studio.data;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * 规则包 —— 模块"拼接"的落地形式。
 *
 * 用法：把一组已经调好的积木（例如「巡逻 + 发现玩家 + 追击 + 进范围说话」）存成一个包，
 * 之后拖到任何对象上，整包生效。包里可以再用一个"参数出口"把关键数值（如速度）
 * 提升为可调参数，这样同一个包能复用在不同强度的敌人身上。
 */
public class RulePack {

    public String id = UUID.randomUUID().toString();
    public String name = "新规则包";
    public String blurb = "";

    /** 包里用到的积木，直接内嵌模块实例（自包含，方便整包拷贝/分享）。 */
    public List<ModuleInstance> modules = new ArrayList<>();

    /** 对外暴露的可调参数：键为参数名，值为默认值。 */
    public Map<String, String> exposed = new LinkedHashMap<>();
    /** 暴露参数的中文说明，面板上照此显示。 */
    public Map<String, String> exposedLabel = new LinkedHashMap<>();

    public static RulePack of(String name, String blurb, ModuleInstance... mods) {
        RulePack p = new RulePack();
        p.name = name;
        p.blurb = blurb;
        for (ModuleInstance m : mods) {
            p.modules.add(m);
        }
        return p;
    }

    public RulePack expose(String key, String label, String def) {
        exposed.put(key, def);
        exposedLabel.put(key, label);
        return this;
    }

    /** 生成一个挂载副本：对象上保存的是拷贝，之后改包不会影响已放置的对象。 */
    public List<ModuleInstance> instantiate() {
        List<ModuleInstance> out = new ArrayList<>();
        for (ModuleInstance src : modules) {
            ModuleInstance c = new ModuleInstance(src.defId);
            c.label = src.label;
            c.trigger = src.trigger;
            c.enabled = src.enabled;
            c.collapsed = src.collapsed;
            c.values.putAll(src.values);
            out.add(c);
        }
        return out;
    }
}
