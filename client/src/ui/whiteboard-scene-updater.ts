export interface WhiteboardSceneApi {
  updateScene(scene: { elements: readonly unknown[] }): void;
}

export class DeferredSceneUpdater {
  private api: WhiteboardSceneApi | null = null;
  private pending: readonly unknown[] | null = null;

  setApi(api: WhiteboardSceneApi): void {
    this.api = api;
    this.flush();
  }

  update(elements: readonly unknown[]): void {
    this.pending = elements;
    this.flush();
  }

  clearApi(api: WhiteboardSceneApi): void {
    if (this.api === api) this.api = null;
  }

  private flush(): void {
    if (!this.api || !this.pending) return;
    const elements = this.pending;
    this.pending = null;
    this.api.updateScene({ elements });
  }
}
