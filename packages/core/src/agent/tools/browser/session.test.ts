import { describe, expect, test } from "bun:test";
import { type BrowserSession, BrowserSessions } from "./session";

interface FakeSession {
  readonly session: BrowserSession;
  readonly closes: () => number;
}

function fakeSession(): FakeSession {
  let closes = 0;
  const session = {
    close: async () => {
      closes += 1;
    },
  } as unknown as BrowserSession;
  return { session, closes: () => closes };
}

describe("BrowserSessions", () => {
  test("launches once and shares the browser between calls", async () => {
    const sessions = new BrowserSessions();
    const fake = fakeSession();
    let launches = 0;
    const launch = async () => {
      launches += 1;
      return fake.session;
    };

    const [first, second] = await Promise.all([sessions.obtain(launch), sessions.obtain(launch)]);
    const third = await sessions.obtain(launch);

    expect(launches).toBe(1);
    expect(first).toBe(fake.session);
    expect(second).toBe(fake.session);
    expect(third).toBe(fake.session);
  });

  test("never launches a browser for a run that does not browse", async () => {
    const sessions = new BrowserSessions();

    await sessions.close();

    expect(sessions.peek()).toBeUndefined();
  });

  test("closes the browser once when the run ends, however often it is asked", async () => {
    const sessions = new BrowserSessions();
    const fake = fakeSession();
    await sessions.obtain(async () => fake.session);

    await Promise.all([sessions.close(), sessions.close()]);
    await sessions.close();

    expect(fake.closes()).toBe(1);
  });

  test("refuses to launch after the run ended", async () => {
    const sessions = new BrowserSessions();
    await sessions.close();
    let launches = 0;

    await expect(
      sessions.obtain(async () => {
        launches += 1;
        return fakeSession().session;
      }),
    ).rejects.toThrow("The browser for this run is closed.");
    expect(launches).toBe(0);
  });

  test("closes a browser whose launch is still pending when the run ends", async () => {
    const sessions = new BrowserSessions();
    const fake = fakeSession();
    let finishLaunch: (session: BrowserSession) => void = () => undefined;
    const pending = sessions.obtain(
      () =>
        new Promise<BrowserSession>((resolve) => {
          finishLaunch = resolve;
        }),
    );

    const closing = sessions.close();
    finishLaunch(fake.session);
    await closing;

    expect(await pending).toBe(fake.session);
    expect(fake.closes()).toBe(1);
  });

  test("lets a fresh browser launch after release, and closes the old one", async () => {
    const sessions = new BrowserSessions();
    const first = fakeSession();
    const second = fakeSession();
    await sessions.obtain(async () => first.session);

    await sessions.release();
    const reopened = await sessions.obtain(async () => second.session);

    expect(first.closes()).toBe(1);
    expect(reopened).toBe(second.session);

    await sessions.close();
    expect(second.closes()).toBe(1);
  });

  test("forgets a failed launch so the next call can retry", async () => {
    const sessions = new BrowserSessions();
    const fake = fakeSession();

    await expect(
      sessions.obtain(async () => {
        throw new Error("no chrome");
      }),
    ).rejects.toThrow("no chrome");
    const retried = await sessions.obtain(async () => fake.session);

    expect(retried).toBe(fake.session);
  });

  test("closing after a failed launch does not throw", async () => {
    const sessions = new BrowserSessions();
    await sessions
      .obtain(async () => {
        throw new Error("no chrome");
      })
      .catch(() => undefined);

    await expect(sessions.close()).resolves.toBeUndefined();
  });
});
