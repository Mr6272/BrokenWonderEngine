package TypeStructure;


import javax.imageio.ImageIO;
import javax.media.opengl.GL2;
import java.awt.image.BufferedImage;
import java.io.File;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.util.UUID;

import com.jogamp.common.nio.Buffers;

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
    public ByteBuffer buffer;

    public int Atlas_StartFrame;
    public int Atlas_EndFrame;

    public String path;

    /**
     * 加载一张图集。
     * @param path     图集文件路径（png 等）
     * @param columns  一行有多少帧
     * @param rows     一共多少行
     */
    public SpriteAtlas(String path, int columns, int rows, int start, int end, int size) {
        id = UUID.randomUUID().toString();
        Atlas_StartFrame = start;
        Atlas_EndFrame = end;
        this.path = path;
        BufferedImage image = null;
        try {
            image = ImageIO.read(new File(path));
        } catch (IOException e) {
            throw new RuntimeException(e);
        }
        this.imageWidth = image.getWidth();
        this.imageHeight = image.getHeight();
        this.columns = columns;
        this.rows = rows;
        this.frameWidth = size;
        this.frameHeight = size;
        this.frameCount = columns * rows;

        // 把 BufferedImage 转成 RGBA 的 ByteBuffer
        int[] pixels = new int[imageWidth * imageHeight];
        image.getRGB(0, 0, imageWidth, imageHeight, pixels, 0, imageWidth);

        // 每个像素 4 字节 RGBA
        buffer = Buffers.newDirectByteBuffer(imageWidth * imageHeight * 4);

        // 注意：OpenGL 的纹理原点在左下，BufferedImage 在左上
        // 为了不倒置，这里从最后一行开始写进 buffer（也可以不翻，后面算 v 的时候再倒）
        for (int y = imageHeight - 1; y >= 0; y--) {
            for (int x = 0; x < imageWidth; x++) {
                int pixel = pixels[y * imageWidth + x];

                byte a = (byte) ((pixel >> 24) & 0xFF);
                byte r = (byte) ((pixel >> 16) & 0xFF);
                byte g = (byte) ((pixel >> 8) & 0xFF);
                byte b = (byte) (pixel & 0xFF);

                buffer.put(r).put(g).put(b).put(a);
            }
        }
        buffer.flip();
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
        int row = rows - 1 - rowFromTop; // 如果你做了 buffer 翻转

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
     * 不用了记得删纹理，释放显存
     */
    public void dispose(GL2 gl) {
        if (textureId != 0) {
            int[] ids = new int[]{textureId};
            gl.glDeleteTextures(1, ids, 0);
            textureId = 0;
        }
    }
}
