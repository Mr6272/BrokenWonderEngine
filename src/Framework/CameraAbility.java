package Framework;

import Core.GameRenderer;

public class CameraAbility implements IAbility {
    public GameObject gameObject;
    public TransformAbility transform;
    public boolean Enable = true;
    public TransformAbility playerTransform;
    public boolean isFollowPlayer = false;

    public CameraAbility(TransformAbility player)
    {
        playerTransform = player;
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

    /** 缺陷 b：统一宿主访问入口。 */
    @Override
    public GameObject getHost() {
        return gameObject;
    }

    @Override
    public void OnUpdate() {
        if (isFollowPlayer && playerTransform != null && transform != null)
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
