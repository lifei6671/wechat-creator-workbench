import { expect, it } from "vitest";
import { alignCollectionNodes } from "./collection-alignment";

it("uses the nearest eligible edge and ignores anchors outside the tolerance", () => {
  const moving = { x: 96, y: 60, width: 80, height: 40 };
  const fixed = { x: 100, y: 200, width: 120, height: 80 };
  expect(alignCollectionNodes([moving], [fixed], 3)).toEqual({ x: 0, y: 0, vertical: undefined, horizontal: undefined });
  expect(alignCollectionNodes([moving], [fixed, { ...fixed, x: 95 }], 6)).toEqual({
    x: -1, y: 0, vertical: { x: 95, start: 60, end: 280 }, horizontal: undefined,
  });
});

it("aligns the group's outside edges and shares a single translation", () => {
  expect(alignCollectionNodes([
    { x: 14, y: 24, width: 20, height: 10 }, { x: 44, y: 54, width: 20, height: 10 },
  ], [{ x: 66, y: 200, width: 20, height: 30 }, { x: 200, y: 27, width: 24, height: 90 }], 6)).toEqual({
    x: 2, y: 3, vertical: { x: 66, start: 27, end: 230 }, horizontal: { y: 27, start: 16, end: 224 },
  });
});

it("matches centers when cards have different widths", () => {
  const moving = { x: 52, y: 20, width: 100, height: 40 };
  const fixed = { x: 40, y: 200, width: 120, height: 80 };
  expect(alignCollectionNodes([moving], [fixed], 6)).toEqual({
    x: -2, y: 0, vertical: { x: 100, start: 20, end: 280 }, horizontal: undefined,
  });
});
