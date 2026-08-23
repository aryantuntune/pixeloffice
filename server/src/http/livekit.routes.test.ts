import { describe, expect, it } from "vitest";
import express from "express";
import { createLiveKitRouter } from "./livekit.routes";

async function request(
  app: express.Express,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const addr = server.address();
        if (!addr || typeof addr === "string") throw new Error("bad addr");
        const url = `http://127.0.0.1:${addr.port}${path}`;
        const res = await fetch(url, {
          method,
          headers: body ? { "Content-Type": "application/json" } : undefined,
          body: body ? JSON.stringify(body) : undefined,
        });
        const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        server.close(() => resolve({ status: res.status, body: json }));
      } catch (err) {
        server.close(() => reject(err));
      }
    });
  });
}

describe("livekit.routes", () => {
  it("returns enabled: false when unconfigured", async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/livekit", createLiveKitRouter({}));

    const res = await request(app, "GET", "/api/livekit/config");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: false });
  });

  it("returns 404 on token request when unconfigured", async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/livekit", createLiveKitRouter({}));

    const res = await request(app, "POST", "/api/livekit/token", {
      room: "test-room",
      identity: "user-1",
    });
    expect(res.status).toBe(404);
  });

  it("generates a valid JWT token when configured", async () => {
    const app = express();
    app.use(express.json());
    app.use(
      "/api/livekit",
      createLiveKitRouter({
        url: "wss://my-livekit.cloud",
        apiKey: "devkey",
        apiSecret: "secretsecretsecretsecretsecretsecret32bytes",
      }),
    );

    const configRes = await request(app, "GET", "/api/livekit/config");
    expect(configRes.status).toBe(200);
    expect(configRes.body).toEqual({ enabled: true, url: "wss://my-livekit.cloud" });

    const tokenRes = await request(app, "POST", "/api/livekit/token", {
      room: "room-abc",
      identity: "user-123",
      name: "Alice",
    });
    expect(tokenRes.status).toBe(200);
    expect(typeof tokenRes.body.token).toBe("string");
    expect(tokenRes.body.url).toBe("wss://my-livekit.cloud");
  });

  it("rejects invalid room or identity parameters", async () => {
    const app = express();
    app.use(express.json());
    app.use(
      "/api/livekit",
      createLiveKitRouter({
        url: "wss://my-livekit.cloud",
        apiKey: "devkey",
        apiSecret: "secretsecretsecretsecretsecretsecret32bytes",
      }),
    );

    const res1 = await request(app, "POST", "/api/livekit/token", {
      room: "",
      identity: "user-123",
    });
    expect(res1.status).toBe(400);

    const res2 = await request(app, "POST", "/api/livekit/token", {
      room: "room-123",
      identity: "",
    });
    expect(res2.status).toBe(400);
  });
});
