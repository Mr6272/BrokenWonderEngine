package Framework;

import Core.GameRenderer;

import javax.media.opengl.GL2;
import javax.media.opengl.GLAutoDrawable;

public class CameraAbility implements IAbility {
    public GameObject gameObject;
    public TransformAbility transform;
    public boolean Enable = true;
    public int index;
    public TransformAbility playerTransform;
    public boolean isFollowPlayer = false;

    public CameraAbility(TransformAbility player)
    {
        playerTransform = player;
    }
    @Override
    public void SetIndex(int index) {
        this.index = index;
    }

    @Override
    public int GetIndex() {
        return index;
    }

    @Override
    public void OnAdded(GameObject gameObject) {
        this.gameObject = gameObject;
        for (IAbility ability : gameObject.Abilitys)
            if (ability instanceof TransformAbility)
                transform = (TransformAbility) ability;
        GameRenderer.Camera = gameObject;
    }

    @Override
    public void OnInit() {

    }

    @Override
    public void SetEnable(boolean value) {
        Enable = value;
    }

    @Override
    public void OnUpdate() {
        if (isFollowPlayer)
        {
            transform.position.x = playerTransform.position.x;
            transform.position.y = playerTransform.position.y;
        }
    }

    @Override
    public boolean GetEnable() {
        return Enable;
    }

    @Override
    public void OnRemove() {

    }
}
