export const morandiPalette = {
  blue: "#849AA9", green: "#879D8B", purple: "#A093AF", brown: "#AA9684", rose: "#B58D91", border: "#929292",
} as const;

const sans = '-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif';
const mono = '"SF Mono",Consolas,"Liberation Mono",monospace';
const { blue, green, border } = morandiPalette;

export const theme = {
  name: "莫兰迪",
  styles: {
    container: `width:100%;box-sizing:border-box;margin:0;padding:10px 0 20px;font-family:${sans};font-size:16px;line-height:1.85;letter-spacing:0.5px;text-align:left;color:inherit;overflow-wrap:break-word;word-break:normal;`,
    p: "margin:0 0 16px;font-size:16px;line-height:1.85;color:inherit;background-color:transparent;",
    h1: "font-size:22px;font-weight:700;line-height:1.5;margin:32px 0 20px;color:inherit;background-color:transparent;",
    h2: `font-size:19px;font-weight:700;line-height:1.5;margin:32px 0 16px;padding-left:10px;border-left:4px solid ${blue};color:inherit;background-color:transparent;`,
    h3: "font-size:17px;font-weight:600;line-height:1.5;margin:24px 0 12px;color:inherit;background-color:transparent;",
    h4: "font-size:16px;font-weight:600;line-height:1.5;margin:24px 0 12px;color:inherit;",
    h5: "font-size:15px;font-weight:600;line-height:1.5;margin:20px 0 10px;color:inherit;",
    h6: "font-size:14px;font-weight:600;line-height:1.5;margin:16px 0 8px;color:inherit;",
    strong: "font-weight:700;color:inherit;",
    em: "font-style:italic;color:inherit;",
    a: "color:inherit;text-decoration:underline;text-underline-offset:3px;overflow-wrap:anywhere;",
    ul: "margin:16px 0;padding-left:24px;color:inherit;",
    ol: "margin:16px 0;padding-left:24px;color:inherit;",
    li: "margin:8px 0;font-size:16px;line-height:1.85;color:inherit;overflow-wrap:break-word;",
    "li > p": "margin:0 0 8px;",
    blockquote: `margin:20px 0;padding:0 0 0 14px;border-left:3px solid ${green};font-size:15px;line-height:1.8;color:inherit;background-color:transparent;`,
    "blockquote > p": "margin:0 0 12px;font-size:15px;line-height:1.8;color:inherit;",
    "blockquote > p:last-child": "margin-bottom:0;",
    code: `font-family:${mono};font-size:0.9em;padding:2px 5px;border:0.5px solid ${border};border-radius:3px;color:inherit;background-color:transparent;overflow-wrap:anywhere;`,
    pre: `max-width:100%;box-sizing:border-box;margin:20px 0;padding:16px;font-family:${mono};font-size:14px;line-height:1.65;letter-spacing:normal;color:#25272A;background-color:#F4F3F0;border-radius:4px;overflow-x:auto;white-space:pre;word-break:normal;overflow-wrap:normal;`,
    "pre > code": "display:block;font-size:14px;line-height:inherit;padding:0;border:0;border-radius:0;color:inherit;background-color:transparent;white-space:pre;overflow-wrap:normal;",
    hr: `width:48px;height:2px;margin:28px auto;border:0;background-color:${blue};`,
    img: "display:block;max-width:100%;height:auto;margin:20px auto;border:0;border-radius:0;box-shadow:none;",
    table: "width:100%;max-width:100%;table-layout:fixed;margin:20px 0;border-collapse:collapse;font-size:14px;color:inherit;background-color:transparent;",
    th: `padding:10px 12px;border:0.5px solid ${border};font-size:14px;line-height:1.6;font-weight:700;text-align:left;color:inherit;background-color:transparent;overflow-wrap:anywhere;word-break:normal;`,
    td: `padding:10px 12px;border:0.5px solid ${border};font-size:14px;line-height:1.6;color:inherit;background-color:transparent;overflow-wrap:anywhere;word-break:normal;`,
    "td > p, th > p": "margin:0;font-size:14px;line-height:1.6;",
    tr: "color:inherit;background-color:transparent;",
    ".morandi-heading-line": `display:block;width:32px;height:0;margin-top:10px;font-size:0;line-height:0;border-bottom:2px solid ${blue};`,
    ".morandi-heading-dot": `display:inline-block;width:5px;height:5px;margin-right:8px;font-size:0;line-height:0;vertical-align:middle;border-radius:50%;background-color:${blue};`,
  },
};

// These follow shared publication rules so adaptive prose cannot acquire fixed callout or footnote colors.
export const morandiOverrides = {
  "mark": `background-color:transparent;color:inherit;border-bottom:1px solid ${blue};`,
  "blockquote.workbench-callout": `padding:0 0 0 14px;border:0;border-left:3px solid ${green};background-color:transparent !important;color:inherit;`,
  ".workbench-callout .workbench-callout-title, .workbench-callout .workbench-callout-title strong": "color:inherit !important;",
  ".plainly-reference-number, .footnotes-list a, .footnote-ref a": "color:inherit !important;",
};

export function applyMorandi(article: HTMLElement) {
  for (const heading of article.querySelectorAll("h1,h3")) {
    const marker = document.createElement("span");
    marker.className = heading.tagName === "H1" ? "morandi-heading-line" : "morandi-heading-dot";
    marker.textContent = "\u00a0";
    if (heading.tagName === "H1") heading.append(marker);
    else heading.prepend(marker);
  }
}
