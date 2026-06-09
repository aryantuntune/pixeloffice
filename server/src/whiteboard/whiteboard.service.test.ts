// ---------------------------------------------------------------------------
// WhiteboardService — per-board Excalidraw element storage: isolation, version
// reconciliation (last-writer-wins), clear, and the memory cap (tombstone
// pruning). State transitions for the collaborative whiteboard.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { WhiteboardService, WB_MAX_ELEMENTS } from "./whiteboard.service";
import type { WhiteboardElement } from "@pixeloffice/shared";

const el = (id: string, version = 1, extra: Partial<WhiteboardElement> = {}): WhiteboardElement => ({
  id,
  version,
  type: "rectangle",
  ...extra,
});

describe("WhiteboardService", () => {
  it("starts every board empty", () => {
    const wb = new WhiteboardService();
    expect(wb.elements("Engineering")).toEqual([]);
  });

  it("stores and returns elements per board in insertion order", () => {
    const wb = new WhiteboardService();
    wb.applyElements("Engineering", [el("a"), el("b")]);
    expect(wb.elements("Engineering").map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("keeps boards isolated from each other", () => {
    const wb = new WhiteboardService();
    wb.applyElements("Engineering", [el("eng")]);
    wb.applyElements("Design", [el("des")]);
    expect(wb.elements("Engineering").map((e) => e.id)).toEqual(["eng"]);
    expect(wb.elements("Design").map((e) => e.id)).toEqual(["des"]);
  });

  it("keeps the newer version of an element and reports it as applied", () => {
    const wb = new WhiteboardService();
    wb.applyElements("Engineering", [el("a", 1)]);
    const applied = wb.applyElements("Engineering", [el("a", 2, { type: "ellipse" })]);
    expect(applied.map((e) => e.id)).toEqual(["a"]);
    expect(wb.elements("Engineering")).toHaveLength(1);
    expect(wb.elements("Engineering")[0].version).toBe(2);
    expect(wb.elements("Engineering")[0].type).toBe("ellipse");
  });

  it("drops a stale (older or equal) version and reports nothing applied", () => {
    const wb = new WhiteboardService();
    wb.applyElements("Engineering", [el("a", 5)]);
    const applied = wb.applyElements("Engineering", [el("a", 3)]);
    expect(applied).toEqual([]);
    expect(wb.elements("Engineering")[0].version).toBe(5);
  });

  it("breaks version ties by versionNonce (last-writer-wins)", () => {
    const wb = new WhiteboardService();
    wb.applyElements("Engineering", [el("a", 1, { versionNonce: 10 })]);
    const win = wb.applyElements("Engineering", [el("a", 1, { versionNonce: 20 })]);
    expect(win).toHaveLength(1);
    const lose = wb.applyElements("Engineering", [el("a", 1, { versionNonce: 5 })]);
    expect(lose).toEqual([]);
    expect(wb.elements("Engineering")[0].versionNonce).toBe(20);
  });

  it("clear() wipes only the named board", () => {
    const wb = new WhiteboardService();
    wb.applyElements("Engineering", [el("eng")]);
    wb.applyElements("Design", [el("des")]);
    wb.clear("Engineering");
    expect(wb.elements("Engineering")).toEqual([]);
    expect(wb.elements("Design").map((e) => e.id)).toEqual(["des"]);
  });

  it("returns defensive copies (mutating the result never affects the store)", () => {
    const wb = new WhiteboardService();
    wb.applyElements("Engineering", [el("a")]);
    const got = wb.elements("Engineering");
    got[0].version = 999;
    got.push(el("z"));
    expect(wb.elements("Engineering")).toHaveLength(1);
    expect(wb.elements("Engineering")[0].version).toBe(1);
  });

  it("prunes deleted tombstones first once past the cap", () => {
    const wb = new WhiteboardService();
    // Seed one deleted element, then fill past the cap with live ones.
    wb.applyElements("Engineering", [el("ghost", 1, { isDeleted: true })]);
    const batch: WhiteboardElement[] = [];
    for (let i = 0; i < WB_MAX_ELEMENTS; i++) batch.push(el(`live${i}`));
    wb.applyElements("Engineering", batch);
    const ids = wb.elements("Engineering").map((e) => e.id);
    expect(ids).toHaveLength(WB_MAX_ELEMENTS);
    expect(ids).not.toContain("ghost"); // tombstone pruned, live elements kept
  });
});
