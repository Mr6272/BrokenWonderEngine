package Studio.app;

import Studio.ui.Toast;

import java.awt.datatransfer.DataFlavor;
import java.awt.datatransfer.Transferable;
import java.awt.datatransfer.UnsupportedFlavorException;
import java.io.File;
import java.util.ArrayList;
import java.util.List;

/**
 * 面板之间拖拽传递的载荷。
 *
 * 为什么要自定义 Transferable 而不是用文本：
 * 素材面板、模块面板、画布三方都需要区分"拖的是素材还是模块、是哪一个"，
 * 用字符串拼前缀迟早会出解析错误，这里用结构化载荷一次说清。
 */
public final class DragPayload implements Transferable {

    public static final DataFlavor FLAVOR = new DataFlavor(DragPayload.class, "BWE 载荷");

    /** 拖的是什么。 */
    public enum What {ASSET, MODULE, OBJECT, PACK}

    public final What what;
    /** 素材 id / 模块 defId / 对象 id。 */
    public final String id;
    /** 附加信息：模块类别名、素材名等，用于落点提示。 */
    public final String label;

    public DragPayload(What what, String id, String label) {
        this.what = what;
        this.id = id;
        this.label = label;
    }

    @Override
    public DataFlavor[] getTransferDataFlavors() {
        return new DataFlavor[]{FLAVOR};
    }

    @Override
    public boolean isDataFlavorSupported(DataFlavor flavor) {
        return FLAVOR.equals(flavor);
    }

    @Override
    public Object getTransferData(DataFlavor flavor) {
        return this;
    }

    /** 从剪贴板载荷里安全取出本类实例；不是本类则返回 null（不做异常传播）。 */
    public static DragPayload of(Transferable t) {
        if (t == null || !t.isDataFlavorSupported(FLAVOR)) {
            return null;
        }
        try {
            Object o = t.getTransferData(FLAVOR);
            return o instanceof DragPayload ? (DragPayload) o : null;
        } catch (UnsupportedFlavorException | java.io.IOException e) {
            return null;
        }
    }

    /** 从系统剪贴板取出拖进来的文件（从资源管理器拖图进来时用）。 */
    public static List<File> files(Transferable t) {
        List<File> out = new ArrayList<>();
        if (t == null || !t.isDataFlavorSupported(DataFlavor.javaFileListFlavor)) {
            return out;
        }
        try {
            Object o = t.getTransferData(DataFlavor.javaFileListFlavor);
            if (o instanceof List<?> list) {
                for (Object it : list) {
                    if (it instanceof File f) {
                        out.add(f);
                    }
                }
            }
        } catch (UnsupportedFlavorException | java.io.IOException ignored) {
            Toast.warn("读不到拖进来的文件");
        }
        return out;
    }
}
