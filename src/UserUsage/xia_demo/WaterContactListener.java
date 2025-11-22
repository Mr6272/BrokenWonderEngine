package UserUsage.xia_demo;

import org.jbox2d.dynamics.Body;
import org.jbox2d.dynamics.Fixture;
import org.jbox2d.dynamics.contacts.Contact;
import org.jbox2d.callbacks.ContactListener;
import org.jbox2d.callbacks.ContactImpulse;
import org.jbox2d.collision.Manifold;

public class WaterContactListener implements ContactListener {

    private final WaterArea water;

    public WaterContactListener(WaterArea water) {
        this.water = water;
    }

    @Override
    public void beginContact(Contact contact) {
        Fixture fa = contact.getFixtureA();
        Fixture fb = contact.getFixtureB();

        if (water.isWaterFixture(fa)) {
            Body other = fb.getBody();
            water.onBodyEnter(other);
        } else if (water.isWaterFixture(fb)) {
            Body other = fa.getBody();
            water.onBodyEnter(other);
        }
    }

    @Override
    public void endContact(Contact contact) {
        Fixture fa = contact.getFixtureA();
        Fixture fb = contact.getFixtureB();

        if (water.isWaterFixture(fa)) {
            Body other = fb.getBody();
            water.onBodyLeave(other);
        } else if (water.isWaterFixture(fb)) {
            Body other = fa.getBody();
            water.onBodyLeave(other);
        }
    }

    @Override
    public void preSolve(Contact contact, Manifold oldManifold) {
        // 不需要特殊处理
    }

    @Override
    public void postSolve(Contact contact, ContactImpulse impulse) {
        // 不需要特殊处理
    }
}
