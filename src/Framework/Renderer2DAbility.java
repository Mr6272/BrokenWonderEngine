package Framework;

import Core.GameRenderer;
import TypeStructure.Sprite;
import TypeStructure.SpriteType;

import javax.media.opengl.GL;
import javax.media.opengl.GL2;
import javax.media.opengl.GLAutoDrawable;
import java.io.IOException;

/*
 * 精灵渲染能力：单图 / 多帧序列 / 图集三种模式。
 * 三种模式共用同一段四边形绘制（修复：原实现三个分支重复约 120 行）；
 * 纹理按路径缓存（TextureCache）；动画按真实时间推进。
 * 帧编号约定：第 frame 帧（1..N）对应 textures[frame-1]。
 * */
public class Renderer2DAbility implements IAbility, IRenderer {
    /** 整张纹理的 UV（单图 / 多帧序列使用） */
    private static final float[] UV_FULL = {0f, 0f, 1f, 0f, 1f, 1f, 0f, 1f};

    private final float[] uv = new float[8];
    GameObject gameObject;
    TransformAbility transfrom;
    int animIndex = 1;
    float timer;
    /** 动画帧率（帧/秒），Multiple / Atlas 使用 */
    public float Frame;
    public Sprite SpriteObj;
    public float order;
    private boolean isActive;

    public void ResetIndex()
    {
        if (SpriteObj != null && SpriteObj.SpType == SpriteType.Atlas) {
            animIndex = SpriteObj.Atlas.Atlas_StartFrame;
            return;
        }
        animIndex = 1;
    }

    public Renderer2DAbility()
    {
        Frame = 30;
        isActive = true;
        timer = 0;
        ResetIndex();
    }

    @Override
    public void OnAdded(GameObject go) {
        gameObject = go;
        for (IAbility abc : go.Abilitys)
        {
            if (abc instanceof TransformAbility)
            {
                transfrom = (TransformAbility) abc;
                break;
            }
        }
    }

    @Override
    public void OnInit() {

    }

    @Override
    public void SetEnable(boolean value) {
        isActive = value;
    }

    @Override
    public void OnUpdate() {

    }

    @Override
    public boolean GetEnable() {
        return isActive;
    }

    @Override
    public void OnRemove() {

    }

    @Override
    public void Draw(GLAutoDrawable glAutoDrawable) {
        if (!isActive)
            return;
        if (SpriteObj == null || gameObject == null || transfrom == null)
            return;
        final GL2 gl = glAutoDrawable.getGL().getGL2();

        ensureTextureLoaded(gl);
        if (!GameRenderer.isVisible(gameObject))
            return;

        float[] quadUv = UV_FULL;
        int texId = 0;

        if (SpriteObj.SpType == SpriteType.Single) {
            texId = SpriteObj.texture;
        } else if (SpriteObj.SpType == SpriteType.Multiple) {
            if (SpriteObj.textures == null || SpriteObj.textures.length == 0)
                return;
            advanceAnimation();
            if (animIndex < 1)
                animIndex = 1;
            if (animIndex > SpriteObj.textures.length)
                animIndex = 1;
            texId = SpriteObj.textures[animIndex - 1]; // 帧 1..N -> 下标 0..N-1
        } else if (SpriteObj.SpType == SpriteType.Atlas && SpriteObj.Atlas != null) {
            advanceAnimation();
            if (animIndex < SpriteObj.Atlas.Atlas_StartFrame)
                animIndex = SpriteObj.Atlas.Atlas_StartFrame;
            if (animIndex > SpriteObj.Atlas.Atlas_EndFrame)
                animIndex = SpriteObj.Atlas.Atlas_StartFrame;
            SpriteObj.Atlas.getFrameUV(animIndex, uv);
            quadUv = uv;
            texId = SpriteObj.Atlas.textureId;
        }

        if (texId == 0)
            return;

        gl.glBindTexture(GL2.GL_TEXTURE_2D, texId);
        gl.glPushMatrix();
        gl.glTranslatef(transfrom.position.x, transfrom.position.y, 0f);
        gl.glRotatef(transfrom.rotation, 0, 0, 1);
        gl.glEnable(GL.GL_DEPTH_TEST);
        gl.glEnable(GL2.GL_ALPHA_TEST);
        gl.glDepthFunc(GL.GL_LESS);
        gl.glAlphaFunc(GL.GL_GREATER, 0.2f);
        gl.glBegin(GL2.GL_QUADS);

        gl.glTexCoord2f(quadUv[0], quadUv[1]);
        gl.glVertex3f(-transfrom.scale.x, -transfrom.scale.y, order);
        gl.glTexCoord2f(quadUv[2], quadUv[3]);
        gl.glVertex3f(transfrom.scale.x, -transfrom.scale.y, order);
        gl.glTexCoord2f(quadUv[4], quadUv[5]);
        gl.glVertex3f(transfrom.scale.x, transfrom.scale.y, order);
        gl.glTexCoord2f(quadUv[6], quadUv[7]);
        gl.glVertex3f(-transfrom.scale.x, transfrom.scale.y, order);

        gl.glEnd();
        gl.glPopMatrix();
        gl.glFlush();
    }

    /** 动画计时：按真实时间推进，每帧动画保持 2 个逻辑帧时长（保持原行为，Frame=60 时约 30 帧/秒）。 */
    private void advanceAnimation() {
        timer += GameRenderer.deltaTime;
        if (timer >= 2f / Frame) {
            timer = 0f;
            animIndex += 1;
        }
    }

    /** 首次绘制时加载纹理（走全局缓存，同路径只上传一次）。 */
    private void ensureTextureLoaded(GL2 gl) {
        if (!SpriteObj.isAwake)
            return;
        try {
            if (SpriteObj.SpType == SpriteType.Single) {
                SpriteObj.texture = SpriteObj.ils.loadImg(gl, SpriteObj.single_filePath, SpriteObj.single_name);
            } else if (SpriteObj.SpType == SpriteType.Multiple) {
                SpriteObj.textures = SpriteObj.ils.loadImg(gl, SpriteObj.multiple_floderPath, SpriteObj.multiple_fileHeadName, SpriteObj.multiple_endCount);
            } else if (SpriteObj.SpType == SpriteType.Atlas && SpriteObj.Atlas != null) {
                SpriteObj.Atlas.textureId = SpriteObj.ils.loadImg(gl, SpriteObj.Atlas.path);
            }
            SpriteObj.isAwake = false;
        } catch (IOException ex) {
            System.err.println("Renderer2DAbility: 纹理加载失败 -> " + ex.getMessage());
        }
    }
}
