export type PreviewAppearance = "light" | "dark";

function darkColor(color: string, kind: "text" | "background" | "border") {
  const [red, green, blue, alpha = 1] = color.match(/[\d.]+/g)!.map(Number);
  if (alpha === 0) return color;
  const [r, g, b] = [red / 255, green / 255, blue / 255];
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  const lightness = (max + min) / 2;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  const hue = delta === 0 ? 0 : 60 * (max === r ? ((g - b) / delta + 6) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4);
  const darkLightness = kind === "text" ? (lightness > 0.7 ? lightness : 0.9 - lightness * 0.3)
    : kind === "background" ? (lightness > 0.5 ? 0.12 + (1 - lightness) * 0.1 : lightness * 0.65)
      : 0.3 + lightness * 0.14;
  return `hsla(${hue}, ${saturation * 100}%, ${darkLightness * 100}%, ${alpha})`;
}

// Only renderer-owned inline colors are adapted; images and the source HTML stay untouched.
export function applyPreviewAppearance(content: HTMLElement, appearance: PreviewAppearance, lightStyles: WeakMap<HTMLElement, string>) {
  const nodes = content.querySelectorAll<HTMLElement>("[style]");
  for (const node of nodes) {
    const original = lightStyles.get(node);
    if (original !== undefined) node.setAttribute("style", original);
    else if (appearance === "dark") lightStyles.set(node, node.getAttribute("style")!);
  }
  if (appearance === "light") return;
  for (const node of nodes) {
    if (node.tagName === "IMG") continue;
    const computed = getComputedStyle(node);
    for (const [property, kind] of [
      ["color", "text"], ["background-color", "background"], ["text-decoration-color", "border"],
      ["border-top-color", "border"], ["border-right-color", "border"], ["border-bottom-color", "border"], ["border-left-color", "border"],
    ] as const) {
      const value = node.style.getPropertyValue(property);
      if (!value || /^(?:inherit|currentcolor|transparent)$/i.test(value)) continue;
      node.style.setProperty(property, darkColor(computed.getPropertyValue(property), kind), node.style.getPropertyPriority(property));
    }
    if (node.style.backgroundImage.includes("gradient(")) {
      node.style.backgroundImage = computed.backgroundImage.replace(/rgba?\([\d.,\s]+\)/g, color => darkColor(color, "background"));
    }
  }
}
