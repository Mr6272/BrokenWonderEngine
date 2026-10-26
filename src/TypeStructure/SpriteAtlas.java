package TypeStructure;

import Tool.TextureCache;

import javax.imageio.ImageIO;
import javax.imageio.ImageReader;
import javax.imageio.stream.ImageInputStream;
import javax.media.opengl.GL2;
import java.io.InputStream;
import java.util.Iterator;
import java.util.UUID;

public class SpriteAtlas {
    public String id;
    public int textureId = 0;

    public int imageWidth;
    public int imageHeight;

    public int columns;      // 一行多少帧
    public int rows;         // 一共多少行
    public int frameWidth;
    public int frameHeight;
    public int frameCount;
    public boolean isAwake = true;

    public int Atlas_StartFrame;
    public int Atlas_EndFrame;

    public String path;

    /**
     * 加载一张图集（构造时只读图片宽高，不解码像素；GPU 纹理由 TextureCache 按路径缓存，同路径只上传一次）。
     * @param path     图集文件路径（png 等）
     * @param columns  一行有多少帧
     * @param rows     一共多少行
     */
    public SpriteAtlas(String path, int columns, int rows, int start, int end, int size) {
        id = UUID.randomUUID().toString();
        Atlas_StartFrame = start;
        Atlas_EndFrame = end;
        this.path = path;
        int[] dims = readImageSize(path);
        this.imageWidth = dims[0];
        this.imageHeight = dims[1];
        this.columns = columns;
        this.rows = rows;
        this.frameWidth = size;
        this.frameHeight = size;
        this.frameCount = columns * rows;
    }

    /** 只读图片宽高，避免整图解码（原实现会解码全部像素并构建一份从未使用的 ByteBuffer）。 */
    private static int[] readImageSize(String path) {
        try (InputStream in = new java.io.FileInputStream(path);
             ImageInputStream iis = ImageIO.createImageInputStream(in)) {
            Iterator<ImageReader> readers = ImageIO.getImageReaders(iis);
            if (readers.hasNext()) {
                ImageReader reader = readers.next();
                reader.setInput(iis, true, true);
                int w = reader.getWidth(0);
                int h = reader.getHeight(0);
                reader.dispose();
                return new int[]{w, h};
            }
        } catch (Exception ignored) {
        }
        return new int[]{0, 0};
    }

    /**
     * 计算指定帧的 UV。
     * @param frameIndex  第几帧（0 ~ frameCount-1）
     * @param uvOut       长度至少 8 的数组，按顺序填：
     *                    [u0,v0,  u1,v0,  u1,v1,  u0,v1]
     */
    public void getFrameUV(int frameIndex, float[] uvOut) {
        if (frameIndex < 0) frameIndex = 0;
        if (frameIndex >= frameCount) frameIndex = frameCount - 1;

        int col = frameIndex % columns;
        int rowFromTop = frameIndex / columns;
        int row = rows - 1 - rowFromTop;

        int frameW = frameWidth;   // imageWidth / columns
        int frameH = frameHeight;  // imageHeight / rows

        int x = col * frameW;
        int y = row * frameH;

        float u0 = (x + 0.5f) / (float) imageWidth;
        float v0 = (y + 0.5f) / (float) imageHeight;
        float u1 = (x + frameW - 0.5f) / (float) imageWidth;
        float v1 = (y + frameH - 0.5f) / (float) imageHeight;

        uvOut[0] = u0; uvOut[1] = v0;
        uvOut[2] = u1; uvOut[3] = v0;
        uvOut[4] = u1; uvOut[5] = v1;
        uvOut[6] = u0; uvOut[7] = v1;
    }

    /**
     * 释放纹理（引用计数减一，归零才真正删除显存）。
     */
    public void dispose(GL2 gl) {
        if (textureId != 0) {
            TextureCache.release(gl, textureId);
            textureId = 0;
        }
    }
}
