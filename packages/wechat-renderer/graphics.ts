import DOMPurify from "dompurify";

export type GraphicKind = "math-inline" | "math-block" | "mermaid";

let math: Promise<(source: string, display: boolean) => string> | undefined;
async function mathSvg(source: string, display: boolean) {
  math ??= (async () => {
    const [{ mathjax }, { TeX }, { SVG }, { liteAdaptor }, { RegisterHTMLHandler }] = await Promise.all([
      import("mathjax-full/js/mathjax.js"),
      import("mathjax-full/js/input/tex.js"),
      import("mathjax-full/js/output/svg.js"),
      import("mathjax-full/js/adaptors/liteAdaptor.js"),
      import("mathjax-full/js/handlers/html.js"),
      import("mathjax-full/js/input/tex/ams/AmsConfiguration.js"),
    ]);
    const adaptor = liteAdaptor();
    RegisterHTMLHandler(adaptor);
    const doc = mathjax.document("", {
      InputJax: new TeX({ packages: ["base", "ams"] }),
      OutputJax: new SVG({ fontCache: "local" }),
    });
    return (source: string, display: boolean) => adaptor.innerHTML(doc.convert(source, { display, em: 16, ex: 8, containerWidth: 864 }));
  })();
  return (await math)(source, display);
}

let mermaid: Promise<typeof import("mermaid").default> | undefined;
async function mermaidSvg(source: string) {
  if (/^\s*---(?:\r?\n)|%%\s*\{/m.test(source)) throw new Error("请移除 Mermaid 的配置头和初始化指令");
  mermaid ??= import("mermaid").then(({ default: engine }) => {
    engine.initialize({ startOnLoad: false, securityLevel: "strict", htmlLabels: false, suppressErrorRendering: true });
    return engine;
  });
  await document.fonts.ready;
  const engine = await mermaid;
  return (await engine.render(`wechat-diagram-${crypto.randomUUID()}`, source)).svg;
}

function dimension(value: string | null, fallback: number) {
  if (!value || value.endsWith("%")) return fallback;
  const n = parseFloat(value) * (value.endsWith("ex") ? 8 : value.endsWith("em") ? 16 : 1);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export async function graphic(kind: GraphicKind, source: string) {
  const raw = kind === "mermaid" ? await mermaidSvg(source) : await mathSvg(source, kind === "math-block");
  const sanitized = DOMPurify.sanitize(raw, {
    USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ["foreignObject"],
  });
  const svg = new DOMParser().parseFromString(sanitized, "image/svg+xml").documentElement;
  if (svg.localName !== "svg" || svg.querySelector("[data-mjx-error]")) throw new Error("无法解析数学公式或图表");
  const box = (svg.getAttribute("viewBox") ?? "").split(/[ ,]+/).map(Number);
  const width = dimension(svg.getAttribute("width"), box[2]);
  const height = dimension(svg.getAttribute("height"), box[3]);
  if (!(width > 0 && height > 0)) throw new Error("公式或图表的尺寸无效");
  const scale = Math.min(1, 2400 / Math.max(width, height));
  const finalWidth = Math.max(1, Math.ceil(width * scale));
  const finalHeight = Math.max(1, Math.ceil(height * scale));
  svg.setAttribute("width", String(finalWidth));
  svg.setAttribute("height", String(finalHeight));
  return { blob: new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" }), width: finalWidth, height: finalHeight };
}

export async function graphicPng(blob: Blob, width: number, height: number): Promise<Uint8Array> {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(width * 2);
    canvas.height = Math.ceil(height * 2);
    canvas.getContext("2d")!.drawImage(image, 0, 0, canvas.width, canvas.height);
    const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => {
      if (blob) resolve(blob);
      else reject(new Error("无法生成排版图片"));
    }, "image/png"));
    return new Uint8Array(await png.arrayBuffer());
  } finally {
    URL.revokeObjectURL(url);
  }
}
