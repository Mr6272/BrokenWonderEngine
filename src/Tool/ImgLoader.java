package Tool;

import javax.media.opengl.GL2;
import java.io.IOException;

/**
 * 纹理加载门面：全部委托给 TextureCache。
 * 无内部可变状态，可安全共享；同一资源在整个引擎中只上传一次 GPU。
 */
public class ImgLoader {

    /**
     * 多帧动画：加载 name1.png .. nameN.png。
     * 修复：原实现循环从 1 到 N-1，textures[0] 恒为 0 且最后一帧不加载。
     */
    public int[] loadImg(GL2 gl, String path, String name, int animPicCount) throws IOException {
        return TextureCache.loadAnim(gl, path, name, animPicCount);
    }

    public int loadImg(GL2 gl, String path, String name) throws IOException {
        return TextureCache.load(gl, path, name);
    }

    public int loadImg(GL2 gl, String path) throws IOException {
        return TextureCache.loadFile(gl, path);
    }

    public int loadImgUrl(GL2 gl, String url) throws IOException {
        return TextureCache.loadUrl(gl, url);
    }
}
