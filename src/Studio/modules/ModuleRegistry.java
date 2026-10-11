package Studio.modules;

import Studio.data.ModuleCategory;
import Studio.data.ModuleDef;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** 模块目录：全部可用积木的注册处。内置模块在 BuiltinModules 中一次性登记。 */
public final class ModuleRegistry {

    private static final ModuleRegistry INSTANCE = new ModuleRegistry();

    private final Map<String, ModuleDef> byId = new LinkedHashMap<>();

    private ModuleRegistry() {
        BuiltinModules.register(this);
    }

    public static ModuleRegistry get() {
        return INSTANCE;
    }

    public void add(ModuleDef d) {
        if (d == null || d.id == null) {
            return;
        }
        byId.put(d.id, d);
    }

    public ModuleDef def(String id) {
        return byId.get(id);
    }

    public List<ModuleDef> all() {
        return new ArrayList<>(byId.values());
    }

    public List<ModuleDef> byCategory(ModuleCategory c) {
        List<ModuleDef> out = new ArrayList<>();
        for (ModuleDef d : byId.values()) {
            if (d.category == c) {
                out.add(d);
            }
        }
        return out;
    }

    /** 按关键字搜模块（名字 / 说明 / 参数名都参与匹配），支持中文与拼音首字母以外的模糊词。 */
    public List<ModuleDef> search(String q) {
        if (q == null || q.trim().isEmpty()) {
            return all();
        }
        String k = q.trim().toLowerCase();
        List<ModuleDef> out = new ArrayList<>();
        for (ModuleDef d : byId.values()) {
            if (d.title.toLowerCase().contains(k)
                    || d.blurb.toLowerCase().contains(k)
                    || d.detail.toLowerCase().contains(k)
                    || d.category.cn.contains(k)) {
                out.add(d);
                continue;
            }
            for (Studio.data.ParamDef p : d.params) {
                if (p.label != null && p.label.toLowerCase().contains(k)) {
                    out.add(d);
                    break;
                }
            }
        }
        return out;
    }
}
