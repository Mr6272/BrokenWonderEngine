package Framework;

import Core.GameRenderer;
import Tool.ImgLoader;
import TypeStructure.Sprite;
import TypeStructure.SpriteType;

import javax.media.opengl.GL;
import javax.media.opengl.GL2;
import javax.media.opengl.GLAutoDrawable;
import java.io.IOException;

/*
 * todo:
 * 主要控制渲染次序
 * 以及精灵图片显示
 * 还得做一个animation组件，来控制精灵图片切换
 *
 * */
/// 变量：
/// Sprite精灵图（一个/多个）
public class Renderer2DAbility implements IAbility, IRenderer {
    float[] uv = new float[8];
    GameObject gameObject;
    TransformAbility transfrom;
    int animIndex;
    float timer;
    public float Frame;
    public Sprite SpriteObj;
    private int abilityIndex;
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
    public void SetIndex(int index) {
        abilityIndex = index;
    }

    @Override
    public int GetIndex() {
        return abilityIndex;
    }

    @Override
    public void OnAdded(GameObject go) {
        gameObject = go;
        for(IAbility abc : go.Abilitys)
        {
            if (abc.GetIndex() == -1)
            {
                transfrom = (TransformAbility) abc;
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
        final GL2 gl = glAutoDrawable.getGL().getGL2();
        if (SpriteObj.isAwake)
        {
            if (SpriteObj.SpType == SpriteType.Single)
            {
                try
                {
                    SpriteObj.texture = SpriteObj.ils.loadImg(gl, SpriteObj.single_filePath, SpriteObj.single_name);
                }
                catch (IOException ex)
                {
                    System.err.println(ex);
                }
            }
            if (SpriteObj.SpType == SpriteType.Multiple)
            {
                try
                {
                    SpriteObj.textures = new int[SpriteObj.multiple_endCount];
                    SpriteObj.textures = SpriteObj.ils.loadImg(gl, SpriteObj.multiple_floderPath, SpriteObj.multiple_fileHeadName, SpriteObj.multiple_endCount);
                }
                catch (IOException ex)
                {
                    System.err.println(ex);
                }
            }
            if (SpriteObj.SpType == SpriteType.Atlas)
            {
                try {
                    SpriteObj.Atlas.textureId =  SpriteObj.ils.loadImg(gl, SpriteObj.Atlas.path);
                } catch (IOException e) {
                    throw new RuntimeException(e);
                }
            }
            SpriteObj.isAwake = false;
        }

        if (!GameRenderer.isVisible(gameObject))
        {
            return;
        }

        if (SpriteObj.SpType == SpriteType.Multiple)
        {
            timer += 1f / Frame;
            if(timer >= 2 / Frame){//这里的8是8帧
                timer = 0;
                animIndex += 1;
                if(animIndex >= SpriteObj.multiple_endCount){
                    animIndex = 1;
                }
            }

            if (animIndex >= SpriteObj.textures.length) {
                gl.glBindTexture(GL2.GL_TEXTURE_2D, SpriteObj.textures[SpriteObj.textures.length - 1]);
            } else {
                gl.glBindTexture(GL2.GL_TEXTURE_2D, SpriteObj.textures[animIndex]);
            }


            gl.glPushMatrix();
            gl.glTranslatef(transfrom.position.x, transfrom.position.y, 0f);
            gl.glRotatef(transfrom.rotation, 0, 0, 1);
            gl.glEnable(GL.GL_DEPTH_TEST);
            gl.glEnable(GL2.GL_ALPHA_TEST);
            gl.glDepthFunc(GL.GL_LESS);
            gl.glAlphaFunc(GL.GL_GREATER, 0.2f);
            gl.glBegin(GL2.GL_QUADS);

            gl.glTexCoord2f(0.0f, 0.0f);
            gl.glVertex3f(-transfrom.scale.x, -transfrom.scale.y, order);
            gl.glTexCoord2f(1.0f, 0.0f);
            gl.glVertex3f(transfrom.scale.x, -transfrom.scale.y, order);
            gl.glTexCoord2f(1.0f, 1.0f);
            gl.glVertex3f(transfrom.scale.x, transfrom.scale.y, order);
            gl.glTexCoord2f(0.0f, 1.0f);
            gl.glVertex3f(-transfrom.scale.x, transfrom.scale.y, order);

            gl.glEnd();
            gl.glPopMatrix();
            gl.glFlush();
        }
        if (SpriteObj.SpType == SpriteType.Atlas)
        {
            timer += 1f / Frame;
            if(timer >= 2 / Frame){//这里的8是8帧
                timer = 0;
                animIndex += 1;
                if(animIndex >= SpriteObj.Atlas.Atlas_EndFrame){
                    animIndex = SpriteObj.Atlas.Atlas_StartFrame;
                }
                if(animIndex < SpriteObj.Atlas.Atlas_StartFrame){
                    animIndex = SpriteObj.Atlas.Atlas_StartFrame;
                }
            }
            SpriteObj.Atlas.getFrameUV(animIndex, uv);
            gl.glBindTexture(GL2.GL_TEXTURE_2D, SpriteObj.Atlas.textureId);

            gl.glPushMatrix();
            gl.glTranslatef(transfrom.position.x, transfrom.position.y, 0f);
            gl.glRotatef(transfrom.rotation, 0, 0, 1);
            gl.glEnable(GL.GL_DEPTH_TEST);
            gl.glEnable(GL2.GL_ALPHA_TEST);
            gl.glDepthFunc(GL.GL_LESS);
            gl.glAlphaFunc(GL.GL_GREATER, 0.2f);
            gl.glBegin(GL2.GL_QUADS);

            gl.glTexCoord2f(uv[0], uv[1]);
            gl.glVertex3f(-transfrom.scale.x, -transfrom.scale.y, order);
            gl.glTexCoord2f(uv[2], uv[3]);
            gl.glVertex3f(transfrom.scale.x, -transfrom.scale.y, order);
            gl.glTexCoord2f(uv[4], uv[5]);
            gl.glVertex3f(transfrom.scale.x, transfrom.scale.y, order);
            gl.glTexCoord2f(uv[6], uv[7]);
            gl.glVertex3f(-transfrom.scale.x, transfrom.scale.y, order);

            gl.glEnd();
            gl.glPopMatrix();
            gl.glFlush();
        }
        if (SpriteObj.SpType == SpriteType.Single)
        {
            gl.glBindTexture(GL2.GL_TEXTURE_2D, SpriteObj.texture);
            gl.glPushMatrix();
            gl.glTranslatef(transfrom.position.x, transfrom.position.y, 0f);
            gl.glRotatef(transfrom.rotation, 0, 0, 1);
            gl.glEnable(GL.GL_DEPTH_TEST);
            gl.glEnable(GL2.GL_ALPHA_TEST);
            gl.glDepthFunc(GL.GL_LESS);
            gl.glAlphaFunc(GL.GL_GREATER, 0.2f);
            gl.glBegin(GL2.GL_QUADS);

            gl.glTexCoord2f(0.0f, 0.0f);
            gl.glVertex3f(-transfrom.scale.x, -transfrom.scale.y, order);
            gl.glTexCoord2f(1.0f, 0.0f);
            gl.glVertex3f(transfrom.scale.x, -transfrom.scale.y, order);
            gl.glTexCoord2f(1.0f, 1.0f);
            gl.glVertex3f(transfrom.scale.x, transfrom.scale.y, order);
            gl.glTexCoord2f(0.0f, 1.0f);
            gl.glVertex3f(-transfrom.scale.x, transfrom.scale.y, order);

            gl.glEnd();
            gl.glPopMatrix();
            gl.glFlush();
        }
//        if (SpriteObj != null && SpriteObj.Atlas != null)
//        {
//            System.out.println("Render sprite = " + SpriteObj +
//                    "  atlasStart=" + SpriteObj.Atlas.Atlas_StartFrame +
//                    "  animIndex=" + animIndex);
//        }
    }
}
