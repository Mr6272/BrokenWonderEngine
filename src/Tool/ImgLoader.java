package Tool;

import com.jogamp.opengl.util.texture.Texture;
import com.jogamp.opengl.util.texture.TextureIO;

import javax.media.opengl.GL2;
import java.io.File;
import java.io.IOException;

public class ImgLoader {
    private int[] textures;
    private int texture2;

    public int[] loadImg(GL2 gl, String path, String name, int animPicCount) throws IOException {
        textures = new int[animPicCount];
        File f;
        for (int u = 1; u < animPicCount; u++){
            f = new File(path + "/" + name + u + ".png");
            Texture t = TextureIO.newTexture(f, true);
            textures[u] = t.getTextureObject(gl);
        }
        return textures;
    }

    public int loadImg(GL2 gl, String path, String name) throws IOException {
        texture2 = 0;
        File f;
        f = new File(path + "/" + name + ".png");
        Texture t = TextureIO.newTexture(f, true);
        texture2 = t.getTextureObject(gl);
        return texture2;
    }

    public int loadImg(GL2 gl, String path) throws IOException {
        texture2 = 0;
        File f;
        f = new File(path);
        Texture t = TextureIO.newTexture(f, true);
        texture2 = t.getTextureObject(gl);
        return texture2;
    }

    public int[] getTexs(){
        return textures;
    }
    public int[] getTex(){
        return textures;
    }
}