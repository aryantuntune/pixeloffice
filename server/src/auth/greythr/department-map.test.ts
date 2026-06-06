import { describe, expect, it } from "vitest";
import { mapGreytHrDepartment } from "./department-map";

describe("mapGreytHrDepartment", () => {
  it("maps an exact office department (case-insensitive)", () => {
    expect(mapGreytHrDepartment("Engineering")).toBe("Engineering");
    expect(mapGreytHrDepartment("engineering")).toBe("Engineering");
    expect(mapGreytHrDepartment("  HR  ")).toBe("HR");
    expect(mapGreytHrDepartment("Product")).toBe("Product");
    expect(mapGreytHrDepartment("Design")).toBe("Design");
  });

  it("maps known aliases onto office departments", () => {
    expect(mapGreytHrDepartment("Engg")).toBe("Engineering");
    expect(mapGreytHrDepartment("Software Development")).toBe("Engineering");
    expect(mapGreytHrDepartment("Human Resources")).toBe("HR");
    expect(mapGreytHrDepartment("People Ops")).toBe("HR");
    expect(mapGreytHrDepartment("UI/UX")).toBe("Design");
    expect(mapGreytHrDepartment("Product Management")).toBe("Product");
  });

  it("returns null for unmapped / empty / non-string labels (caller defaults)", () => {
    expect(mapGreytHrDepartment("Finance")).toBeNull();
    expect(mapGreytHrDepartment("")).toBeNull();
    expect(mapGreytHrDepartment("   ")).toBeNull();
    expect(mapGreytHrDepartment(null)).toBeNull();
    expect(mapGreytHrDepartment(undefined)).toBeNull();
  });
});
