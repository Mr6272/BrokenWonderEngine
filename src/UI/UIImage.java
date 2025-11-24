package UI;

import Tool.ImgLoader;
import TypeStructure.Sprite;
import TypeStructure.SpriteAtlas;
import TypeStructure.SpriteType;

import javax.media.opengl.GL;
import javax.media.opengl.GL2;
import com.jogamp.opengl.util.awt.TextRenderer;
import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.File;
import java.io.IOException;

/**
 * Sprite-backed UI element (screen-space).
 */
public class UIImage extends UIElement {
    private final ImgLoader loader = new ImgLoader();
    private Sprite sprite;
    private int currentFrame = 0;
    private float frameRate = 12f;
    private boolean autoPlay = false;
    private float frameTimer = 0f;
    private long lastTimeNs = System.nanoTime();
    private final float[] uv = new float[8];

    public UIImage(String name, Sprite sprite, float x, float y, float width, float height) {
        super(name, x, y, width, height);
        this.sprite = sprite;
    }

    public void setSprite(Sprite sprite) {
        this.sprite = sprite;
    }

    public Sprite getSprite() {
        return sprite;
    }

    public void setFrame(int frame) {
        this.currentFrame = Math.max(0, frame);
    }

    public void setFrameRate(float frameRate) {
        this.frameRate = Math.max(0.1f, frameRate);
    }

    public void setAutoPlay(boolean autoPlay) {
        this.autoPlay = autoPlay;
    }

    /**
     * Adjust this element's size to match the sprite's pixel dimensions (single / first frame / atlas frame).
     */
    public void fitToSpriteSize() {
        if (sprite == null) {
            return;
        }
        try {
            if (sprite.SpType == SpriteType.Single) {
                setSizeByFile(sprite.single_filePath + "/" + sprite.single_name + ".png");
            } else if (sprite.SpType == SpriteType.Multiple) {
                setSizeByFile(sprite.multiple_floderPath + "/" + sprite.multiple_fileHeadName + "1.png");
            } else if (sprite.SpType == SpriteType.Atlas && sprite.Atlas != null) {
                setSize(sprite.Atlas.frameWidth, sprite.Atlas.frameHeight);
            }
        } catch (Exception ex) {
            System.err.println("UIImage fitToSpriteSize failed: " + ex.getMessage());
        }
    }

    private void setSizeByFile(String path) {
        BufferedImage img = null;
        try {
            img = ImageIO.read(new File(path));
        } catch (IOException e) {
            // TODO Auto-generated catch block
            e.printStackTrace();
        }
        if (img != null) {
            setSize(img.getWidth(), img.getHeight());
        }
    }

    @Override
    public void update(UIMouse mouse) {
        float dt = advanceTime();
        if (autoPlay && sprite != null && (sprite.SpType == SpriteType.Multiple || sprite.SpType == SpriteType.Atlas)) {
            frameTimer += dt;
            float frameDur = 1f / frameRate;
            while (frameTimer >= frameDur) {
                frameTimer -= frameDur;
                stepFrame();
            }
        }
        super.update(mouse);
    }

    @Override
    protected void drawSelf(GL2 gl, TextRenderer textRenderer) {
        if (sprite == null) {
            return;
        }
        ensureLoaded(gl);
        gl.glEnable(GL2.GL_TEXTURE_2D);
        gl.glEnable(GL.GL_BLEND);
        if (sprite.SpType == SpriteType.Single) {
            gl.glBindTexture(GL2.GL_TEXTURE_2D, sprite.texture);
            drawQuad(gl, 0f, 0f, 1f, 1f);
        } else if (sprite.SpType == SpriteType.Multiple) {
            int idx = Math.min(Math.max(currentFrame, 1), sprite.textures.length - 1);
            gl.glBindTexture(GL2.GL_TEXTURE_2D, sprite.textures[idx]);
            drawQuad(gl, 0f, 0f, 1f, 1f);
        } else if (sprite.SpType == SpriteType.Atlas && sprite.Atlas != null) {
            SpriteAtlas atlas = sprite.Atlas;
            atlas.getFrameUV(currentFrame, uv);
            gl.glBindTexture(GL2.GL_TEXTURE_2D, atlas.textureId);
            drawQuad(gl, uv[0], uv[1], uv[2], uv[5]);
        }
    }

    private void drawQuad(GL2 gl, float u0, float v0, float u1, float v1) {
        float ax = getAbsoluteX();
        float ay = getAbsoluteY();
        gl.glBegin(GL2.GL_QUADS);
        gl.glTexCoord2f(u0, v0);
        gl.glVertex2f(ax, ay);
        gl.glTexCoord2f(u1, v0);
        gl.glVertex2f(ax + width, ay);
        gl.glTexCoord2f(u1, v1);
        gl.glVertex2f(ax + width, ay + height);
        gl.glTexCoord2f(u0, v1);
        gl.glVertex2f(ax, ay + height);
        gl.glEnd();
    }

    private void ensureLoaded(GL2 gl) {
        if (sprite == null || gl == null || !sprite.isAwake) {
            return;
        }
        try {
            if (sprite.SpType == SpriteType.Single) {
                sprite.texture = loader.loadImg(gl, sprite.single_filePath, sprite.single_name);
            } else if (sprite.SpType == SpriteType.Multiple) {
                sprite.textures = loader.loadImg(gl, sprite.multiple_floderPath, sprite.multiple_fileHeadName, sprite.multiple_endCount);
                currentFrame = 1;
            } else if (sprite.SpType == SpriteType.Atlas && sprite.Atlas != null) {
                sprite.Atlas.textureId = loader.loadImg(gl, sprite.Atlas.path);
                currentFrame = sprite.Atlas.Atlas_StartFrame;
            }
            sprite.isAwake = false;
        } catch (Exception ex) {
            System.err.println("UIImage load sprite failed: " + ex.getMessage());
        }
    }

    private void stepFrame() {
        if (sprite == null) {
            return;
        }
        if (sprite.SpType == SpriteType.Multiple && sprite.textures != null && sprite.textures.length > 1) {
            currentFrame++;
            if (currentFrame >= sprite.textures.length) {
                currentFrame = 1;
            }
        } else if (sprite.SpType == SpriteType.Atlas && sprite.Atlas != null) {
            currentFrame++;
            if (currentFrame > sprite.Atlas.Atlas_EndFrame) {
                currentFrame = sprite.Atlas.Atlas_StartFrame;
            }
        }
    }

    private float advanceTime() {
        long now = System.nanoTime();
        long delta = now - lastTimeNs;
        lastTimeNs = now;
        return delta / 1_000_000_000f;
    }
}
