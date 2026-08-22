import { describe, expect, it, vi } from "vitest";
import { DeferredSceneUpdater } from "./whiteboard-scene-updater";

describe("DeferredSceneUpdater", () => {
  it("replays the latest scene once the Excalidraw API becomes ready", () => {
    const updater = new DeferredSceneUpdater();
    const api = { updateScene: vi.fn() };

    updater.update([{ id: "old" }]);
    updater.update([{ id: "latest" }]);
    expect(api.updateScene).not.toHaveBeenCalled();

    updater.setApi(api);

    expect(api.updateScene).toHaveBeenCalledTimes(1);
    expect(api.updateScene).toHaveBeenCalledWith({ elements: [{ id: "latest" }] });
  });

  it("applies later scenes immediately after the API is ready", () => {
    const updater = new DeferredSceneUpdater();
    const api = { updateScene: vi.fn() };

    updater.setApi(api);
    updater.update([{ id: "live" }]);

    expect(api.updateScene).toHaveBeenCalledWith({ elements: [{ id: "live" }] });
  });
});
