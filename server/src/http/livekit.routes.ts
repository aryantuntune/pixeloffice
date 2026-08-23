// ---------------------------------------------------------------------------
// LiveKit REST routes: exposes config state and generates room access tokens.
// Framework-free router mounted at /api/livekit.
// ---------------------------------------------------------------------------

import { Router, type Request, type Response } from "express";
import { AccessToken } from "livekit-server-sdk";

export interface LiveKitConfig {
  url?: string;
  apiKey?: string;
  apiSecret?: string;
}

export function createLiveKitRouter(config: LiveKitConfig = {}): Router {
  const router = Router();
  const enabled = Boolean(config.url && config.apiKey && config.apiSecret);

  router.get("/config", (_req: Request, res: Response) => {
    if (!enabled) {
      res.json({ enabled: false });
      return;
    }
    res.json({ enabled: true, url: config.url });
  });

  router.post("/token", async (req: Request, res: Response) => {
    if (!enabled || !config.apiKey || !config.apiSecret || !config.url) {
      res.status(404).json({ error: "LiveKit is not configured on this server." });
      return;
    }

    const { room, identity, name } = req.body as { room?: unknown; identity?: unknown; name?: unknown };

    if (typeof room !== "string" || !room.trim() || room.length > 128) {
      res.status(400).json({ error: "Invalid or missing room name." });
      return;
    }

    if (typeof identity !== "string" || !identity.trim() || identity.length > 128) {
      res.status(400).json({ error: "Invalid or missing identity." });
      return;
    }

    try {
      const at = new AccessToken(config.apiKey, config.apiSecret, {
        identity: identity.trim(),
        name: typeof name === "string" ? name.trim().slice(0, 64) : identity.trim(),
      });

      at.addGrant({
        roomJoin: true,
        room: room.trim(),
        canPublish: true,
        canSubscribe: true,
      });

      const token = await at.toJwt();
      res.json({ token, url: config.url });
    } catch (err) {
      console.error("[LiveKit] failed to generate access token:", err);
      res.status(500).json({ error: "Failed to generate token." });
    }
  });

  return router;
}
