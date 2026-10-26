package Tool;

import com.jogamp.opengl.util.texture.Texture;
import com.jogamp.opengl.util.texture.TextureIO;

import javax.media.opengl.GL2;
import java.io.File;
import java.io.IOException;
import java.net.URL;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/**
 * 全局纹理缓存：以资源路径为 key 缓存 GPU 纹理，并带引用计数。
 * 同一张图片在整个引擎中只上传一次显存；引用计数归零时才真正删除 GL 纹理。
 */
public final class TextureCache {
    private static final Map<String, Entry> CACHE = new HashMap<>();
    private static final Map<Integer, String> BY_ID = new HashMap<>();

    private static final class Entry {
        int textureId;
        int refCount = 1;
    }

    private TextureCache() {
    }

    /** 单张图片：path + "/" + name + ".png" */
    public static int load(GL2 gl, String path, String name) throws IOException {
        return loadFile(gl, path + "/" + name + ".png");
    }

    /**
     * 多帧动画：加载 name1.png .. nameN.png。
     * 返回数组按下标 0..N-1 对应帧 1..N（textures[frame-1] 即第 frame 帧）。
     */
    public static int[] loadAnim(GL2 gl, String folder, String head, int count) throws IOException {
        int[] ids = new int[count];
        for (int u = 1; u <= count; u++) {
            ids[u - 1] = loadFile(gl, folder + "/" + head + u + ".png");
        }
        return ids;
    }

    /** 任意路径图片，按路径缓存。 */
    public static int loadFile(GL2 gl, String path) throws IOException {
        Entry e = CACHE.get(path);
        if (e != null) {
            e.refCount++;
            return e.textureId;
        }
        File f = new File(path);
        Texture t = TextureIO.newTexture(f, true);
        int id = t.getTextureObject(gl);
        Entry entry = new Entry();
        entry.textureId = id;
        CACHE.put(path, entry);
        BY_ID.put(id, path);
        return id;
    }

    /** 远程 URL 纹理：生命周期不可控，不进缓存。 */
    public static int loadUrl(GL2 gl, String url) throws IOException {
        URL remote = new URL(url);
        if ("file".equalsIgnoreCase(remote.getProtocol())) {
            String decoded = URLDecoder.decode(remote.getPath(), StandardCharsets.UTF_8.name());
            return loadFile(gl, decoded);
        }
        Texture t = TextureIO.newTexture(remote, true, null);
        return t.getTextureObject(gl);
    }

    /** 引用计数减一，归零时删除 GL 纹理并移出缓存。 */
    public static void release(GL2 gl, int textureId) {
        if (textureId == 0) {
            return;
        }
        String key = BY_ID.get(textureId);
        if (key == null) {
            // 不在缓存中的纹理（如 URL 纹理），直接删除
            if (gl != null) {
                gl.glDeleteTextures(1, new int[]{textureId}, 0);
            }
            return;
        }
        Entry e = CACHE.get(key);
        if (e == null) {
            return;
        }
        e.refCount--;
        if (e.refCount <= 0) {
            CACHE.remove(key);
            BY_ID.remove(textureId);
            if (gl != null) {
                gl.glDeleteTextures(1, new int[]{textureId}, 0);
            }
        }
    }
}
