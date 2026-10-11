package Studio.app;

import Studio.ui.Toast;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;

/**
 * 编辑器全局状态。
 *
 * 单一事实来源：所有面板都从这里读"现在选中了什么、在什么模式"，
 * 通过订阅得到变化通知，绝不互相直接持有引用 —— 否则面板一多就会变成蜘蛛网。
 */
public final class AppState {

    /** 选中对象变化。 */
    public interface SelListener {
        void onSelectionChanged();
    }

    /** 选中场景变化。 */
    public interface SceneListener {
        void onSceneChanged();
    }

    /** 工程内容被改动（用于标记脏数据与刷新列表）。 */
    public interface DirtyListener {
        void onDirtyChanged();
    }

    private final List<SelListener> selListeners = new ArrayList<>();
    private final List<SceneListener> sceneListeners = new ArrayList<>();
    private final List<DirtyListener> dirtyListeners = new ArrayList<>();

    private Studio.data.Project project;
    private java.io.File projectFile;
    private boolean dirty;

    /** 当前操作模式。 */
    public enum Tool {
        SELECT("选择", "点选与拖动对象"),
        BRUSH("刷子", "连续涂地面块"),
        ERASE("橡皮", "点掉对象"),
        ZONE("画区", "拖出一个触发范围"),
        PAN("抓手", "拖动画面（空格键也可临时切换）");

        public final String cn;
        public final String hint;

        Tool(String cn, String hint) {
            this.cn = cn;
            this.hint = hint;
        }

        @Override
        public String toString() {
            return cn;
        }
    }

    private Tool tool = Tool.SELECT;
    private Studio.data.SceneModel scene;
    private final List<Studio.data.SceneObject> selection = new ArrayList<>();
    private Studio.data.SceneObject clipboard;

    // 画布视图
    public double zoom = 1.0;
    public double camX = 0;
    public double camY = 0;
    public boolean snapToGrid = true;
    public boolean showGrid = true;
    public boolean showColliders = true;
    public boolean showZones = true;

    public AppState(Studio.data.Project p) {
        this.project = p;
        if (p != null && !p.scenes.isEmpty()) {
            scene = p.scenes.get(0);
        }
    }

    public Studio.data.Project project() {
        return project;
    }

    public void setProject(Studio.data.Project p, java.io.File file) {
        this.project = p;
        this.projectFile = file;
        this.selection.clear();
        this.scene = (p != null && !p.scenes.isEmpty()) ? p.scenes.get(0) : null;
        dirty = false;
        fireScene();
        fireSelection();
        fireDirty();
    }

    public java.io.File projectFile() {
        return projectFile;
    }

    public void setProjectFile(java.io.File f) {
        projectFile = f;
    }

    public Studio.data.SceneModel scene() {
        return scene;
    }

    public void setScene(Studio.data.SceneModel s) {
        if (s == scene) {
            return;
        }
        scene = s;
        selection.clear();
        fireScene();
        fireSelection();
    }

    public Tool tool() {
        return tool;
    }

    public void setTool(Tool t) {
        if (tool == t) {
            return;
        }
        tool = t;
        fireSelection();
    }

    // ---------- 选择 ----------

    public List<Studio.data.SceneObject> selection() {
        return selection;
    }

    public Studio.data.SceneObject first() {
        return selection.isEmpty() ? null : selection.get(0);
    }

    public boolean isSelected(Studio.data.SceneObject o) {
        return selection.contains(o);
    }

    public void select(Studio.data.SceneObject o) {
        selection.clear();
        if (o != null) {
            selection.add(o);
        }
        fireSelection();
    }

    public void selectAll(List<Studio.data.SceneObject> list) {
        selection.clear();
        if (list != null) {
            selection.addAll(list);
        }
        fireSelection();
    }

    public void toggleSelect(Studio.data.SceneObject o) {
        if (o == null) {
            return;
        }
        if (!selection.remove(o)) {
            selection.add(o);
        }
        fireSelection();
    }

    public void clearSelection() {
        if (selection.isEmpty()) {
            return;
        }
        selection.clear();
        fireSelection();
    }

    public void forget(Studio.data.SceneObject o) {
        if (selection.remove(o)) {
            fireSelection();
        }
    }

    public Studio.data.SceneObject clipboard() {
        return clipboard;
    }

    public void setClipboard(Studio.data.SceneObject o) {
        clipboard = o;
    }

    // ---------- 脏标记 ----------

    public boolean isDirty() {
        return dirty;
    }

    public void markDirty() {
        if (!dirty) {
            dirty = true;
            fireDirty();
        }
    }

    public void clearDirty() {
        if (dirty) {
            dirty = false;
            fireDirty();
        }
    }

    /** 标题栏文案：未保存时用 ● 标记，用户一眼知道有没有存过。 */
    public String title() {
        String f = projectFile == null ? (project == null ? "未命名" : project.name) : projectFile.getName();
        return (dirty ? "● " : "") + f + " — BWE Studio";
    }

    // ---------- 订阅 ----------

    public void addSelectionListener(SelListener l) {
        selListeners.add(l);
    }

    public void addSceneListener(SceneListener l) {
        sceneListeners.add(l);
    }

    public void addDirtyListener(DirtyListener l) {
        dirtyListeners.add(l);
    }

    private void fireSelection() {
        for (SelListener l : new ArrayList<>(selListeners)) {
            try {
                l.onSelectionChanged();
            } catch (RuntimeException e) {
                Toast.error("界面刷新出错：" + e.getMessage());
            }
        }
    }

    private void fireScene() {
        for (SceneListener l : new ArrayList<>(sceneListeners)) {
            try {
                l.onSceneChanged();
            } catch (RuntimeException e) {
                Toast.error("场景刷新出错：" + e.getMessage());
            }
        }
    }

    private void fireDirty() {
        for (DirtyListener l : new ArrayList<>(dirtyListeners)) {
            try {
                l.onDirtyChanged();
            } catch (RuntimeException e) {
                Toast.error("状态刷新出错：" + e.getMessage());
            }
        }
    }

    /** 便捷：把某个动作包成"改了工程"的语义。 */
    public void edit(Runnable r) {
        r.run();
        markDirty();
    }

    /** 状态栏临时提示的转发口（面板不必持有 MainWindow 引用）。 */
    public void statusHint(String text) {
        if (statusSink != null) {
            statusSink.accept(text);
        }
    }

    private Consumer<String> statusSink;

    public void setStatusSink(Consumer<String> sink) {
        statusSink = sink;
    }

    /** 便捷订阅：一次性注册三种通知（多数面板都关心）。 */
    public void subscribe(Runnable refresh) {
        Consumer<Object> noop = o -> refresh.run();
        addSelectionListener(refresh::run);
        addSceneListener(refresh::run);
        addDirtyListener(refresh::run);
    }
}
