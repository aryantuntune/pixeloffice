// ---------------------------------------------------------------------------
// Whiteboard service — framework-free in-memory store of per-board Excalidraw
// elements. One collaborative board PER DEPARTMENT (the board key is the
// department name). The room is the only Colyseus-aware caller: it validates
// inbound elements, this service merges + stores them, and the room broadcasts
// to the board's subscribers. State is in-memory (cleared on restart) — the
// zero-config ethos; a durable backend can replace this behind the same surface.
//
// CONFLICT RESOLUTION: elements are keyed by id and reconciled by Excalidraw's
// monotonic `version` (with `versionNonce` as a last-writer-wins tiebreak), so
// two people editing the same board converge without a central lock.
//
// PRIVACY (Constitution: presence, not surveillance): a board holds only the
// drawing content. We never record who drew what, when, or any per-user history.
// ---------------------------------------------------------------------------

import type { WhiteboardElement } from "@pixeloffice/shared";

/** Max elements retained per board (deleted tombstones pruned first past this). */
export const WB_MAX_ELEMENTS = 8000;

/** True if `next` should win over `prev` (higher version, nonce tiebreak). */
function isNewer(next: WhiteboardElement, prev: WhiteboardElement): boolean {
  if (next.version !== prev.version) return next.version > prev.version;
  return (next.versionNonce ?? 0) > (prev.versionNonce ?? 0);
}

export class WhiteboardService {
  // board -> (elementId -> latest element). A Map preserves insertion order so
  // a late opener receives elements roughly in creation order.
  private readonly boards = new Map<string, Map<string, WhiteboardElement>>();

  /** Current elements for a board, oldest-first, as defensive copies. */
  elements(board: string): WhiteboardElement[] {
    const m = this.boards.get(board);
    if (!m) return [];
    return [...m.values()].map((e) => ({ ...e }));
  }

  /**
   * Merge incoming (already-validated) elements, keeping the newer of each by
   * version. Returns the elements that were actually applied (new or newer), so
   * the caller only rebroadcasts real changes — echoes are dropped.
   */
  applyElements(board: string, incoming: WhiteboardElement[]): WhiteboardElement[] {
    let m = this.boards.get(board);
    if (!m) {
      m = new Map();
      this.boards.set(board, m);
    }
    const applied: WhiteboardElement[] = [];
    for (const el of incoming) {
      const prev = m.get(el.id);
      if (!prev || isNewer(el, prev)) {
        m.set(el.id, { ...el });
        applied.push({ ...el });
      }
    }
    this.prune(m);
    return applied;
  }

  /** Wipe a board. */
  clear(board: string): void {
    this.boards.set(board, new Map());
  }

  /** Bound memory: past the cap, drop deleted tombstones (oldest first). */
  private prune(m: Map<string, WhiteboardElement>): void {
    if (m.size <= WB_MAX_ELEMENTS) return;
    for (const [id, el] of m) {
      if (m.size <= WB_MAX_ELEMENTS) break;
      if (el.isDeleted) m.delete(id);
    }
  }
}
