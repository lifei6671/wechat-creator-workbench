import type { CanvasGeometry } from "../../../../packages/shared-types";

type Axis = "x" | "y";
type Match = { position: number; offset: number; node: CanvasGeometry };

const anchorPairs = [[0, 0], [0, 2], [1, 1], [2, 0], [2, 2]] as const;

function nearestAnchor(group: CanvasGeometry, targets: CanvasGeometry[], axis: Axis, tolerance: number): Match | undefined {
  const size = axis === "x" ? "width" : "height";
  let match: Match | undefined;
  for (const node of targets) {
    for (const [moving, fixed] of anchorPairs) {
      const position = node[axis] + fixed * node[size] / 2;
      const offset = position - (group[axis] + moving * group[size] / 2);
      const distance = Math.abs(offset);
      if (distance <= tolerance && (!match || distance < Math.abs(match.offset))) match = { position, offset, node };
    }
  }
  return match;
}

export function alignCollectionNodes(moving: [CanvasGeometry, ...CanvasGeometry[]], stationary: CanvasGeometry[], tolerance: number) {
  const [first, ...rest] = moving;
  const bounds = rest.reduce((group, node) => {
    const x = Math.min(group.x, node.x), y = Math.min(group.y, node.y);
    return { x, y, width: Math.max(group.x + group.width, node.x + node.width) - x,
      height: Math.max(group.y + group.height, node.y + node.height) - y };
  }, first);
  const vertical = nearestAnchor(bounds, stationary, "x", tolerance);
  const horizontal = nearestAnchor(bounds, stationary, "y", tolerance);
  const x = vertical?.offset ?? 0, y = horizontal?.offset ?? 0;
  return {
    x, y,
    vertical: vertical && { x: vertical.position, start: Math.min(bounds.y + y, vertical.node.y),
      end: Math.max(bounds.y + y + bounds.height, vertical.node.y + vertical.node.height) },
    horizontal: horizontal && { y: horizontal.position, start: Math.min(bounds.x + x, horizontal.node.x),
      end: Math.max(bounds.x + x + bounds.width, horizontal.node.x + horizontal.node.width) },
  };
}
