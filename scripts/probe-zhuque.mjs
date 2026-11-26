// Manual, quota-consuming integration probe. Only the fixed synthetic samples below are sent.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export function inspectSegments(text, segments) {
  const scalars = [...text], bytes = Buffer.from(text);
  return segments.map(segment => {
    const position = segment.position;
    const candidates = [];
    if (Array.isArray(position) && position.length === 2 && position.every(Number.isSafeInteger)
      && position[0] >= 0 && position[1] >= 0) {
      const [from, to] = position;
      for (const [unit, length, slice] of [
        ["utf16", text.length, end => text.slice(from, end)],
        ["unicode-scalar", scalars.length, end => scalars.slice(from, end).join("")],
        ["utf8", bytes.length, end => bytes.subarray(from, end).toString("utf8")],
      ]) {
        if (to >= from && to <= length && slice(to) === segment.text) candidates.push(`${unit}:half-open`);
        if (to >= from && to + 1 <= length && slice(to + 1) === segment.text) candidates.push(`${unit}:inclusive`);
        if (from + to <= length && slice(from + to) === segment.text) candidates.push(`${unit}:start-length`);
      }
    }
    return { label: segment.label, confidence: segment.conf, order: segment.order,
      position: Array.isArray(position) ? position : null,
      textUtf16Length: typeof segment.text === "string" ? segment.text.length : null,
      exactSubstring: typeof segment.text === "string" && text.includes(segment.text), offsetCandidates: candidates };
  });
}

async function main() {
  let key = process.env.MAKERS_MODELS_KEY?.trim();
  if (process.env.MAKERS_MODELS_KEY_FILE) {
    const source = await readFile(process.env.MAKERS_MODELS_KEY_FILE, "utf8");
    key = process.env.MAKERS_MODELS_KEY_FILE.endsWith(".json") ? JSON.parse(source).key?.trim() : source.trim();
  }
  if (!key) throw new Error("Set MAKERS_MODELS_KEY_FILE or MAKERS_MODELS_KEY locally; never put a key in command arguments.");
  const unicode = "开头 A😀e\u0301。中文和 ASCII 放在同一个合成段落中。\n下一行含有另一个标记 B🦊。\n\n第三段只有合成测试内容，不包含真实文章。\n\n重复句子。\n\n重复句子。";
  let samples = [
    { id: "unicode-split", text: unicode, merge: false },
    { id: "unicode-merge", text: unicode, merge: true },
    { id: "crlf-and-whitespace", text: "  合成段落 A😀\r\n\t第二行 e\u0301。\r\n\r\n第三段保留空格。  ", merge: false },
    ...[1, 1000, 5000, 20000].map(length => ({ id: `chinese-${length}`, text: "合成验证文字".repeat(Math.ceil(length / 6)).slice(0, length), merge: false })),
  ];
  const offsets = process.argv.includes("--offsets");
  if (offsets) {
    const mixed = Array.from({length:120},(_,index)=>`${index}：中文😀e\u0301以及🦊，合成位置校验。${index%3===0?"\r\n":"\n\n"}`).join("");
    samples = [{id:"long-unicode-split",text:mixed,merge:false},{id:"long-unicode-merge",text:mixed,merge:true},
      {id:"client-cap-128kib",text:"文".repeat(43690)+"ab",merge:false}];
  }
  const report = { recordedAt: new Date().toISOString(), source: "real Makers endpoint; fixed synthetic text only", samples: [] };
  for (const sample of samples) {
    const started = performance.now();
    const record = {id:sample.id,isMerge:sample.merge,utf8Bytes:Buffer.byteLength(sample.text),utf16Length:sample.text.length,unicodeScalars:[...sample.text].length};
    try {
      const response = await fetch("https://ai-gateway.edgeone.link/v1/providers/zhuque-text/classify", {
        method: "POST", headers: {Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
        body: JSON.stringify({text:sample.text,is_merge:sample.merge}), signal:AbortSignal.timeout(60_000), redirect:"manual",
      });
      record.httpStatus = response.status;
      record.elapsedMs = Math.round(performance.now() - started);
      const raw = await response.json().catch(() => null);
      record.fields = raw && typeof raw === "object" ? Object.keys(raw) : [];
      record.businessSuccess = raw?.status === "success";
      if (record.businessSuccess) {
        record.makersTokens = raw.makers_models_usage?.total_tokens ?? null;
        record.modelTokens = raw.usage?.total_tokens ?? null;
        record.labelsRatio = raw.labels_ratio;
        record.segments = Array.isArray(raw.segment_labels) ? inspectSegments(sample.text,raw.segment_labels) : null;
        if (offsets && sample.id === "long-unicode-split" && raw.segment_labels?.every(segment => typeof segment.text === "string" && sample.text.includes(segment.text))) {
          const fixture = {text:sample.text,response:{status:raw.status,labels_ratio:raw.labels_ratio,
            ratio_confidence:raw.ratio_confidence,softmax_confidence:raw.softmax_confidence,
            segment_labels:raw.segment_labels,makers_models_usage:raw.makers_models_usage}};
          await writeFile(fileURLToPath(new URL("../src-tauri/src/review/fixtures/live-unicode.json",import.meta.url)),JSON.stringify(fixture,null,2)+"\n");
        }
      }
      report.samples.push(record);
      // No retries; stop further quota-consuming calls when authorization, rate limits or service health fail.
      if ([401,403,429].includes(response.status) || response.status >= 500) break;
    } catch {
      report.samples.push({...record,elapsedMs:Math.round(performance.now()-started),transportFailed:true,chargedTokensUnknown:true});
      break;
    }
  }
  const output = fileURLToPath(new URL(offsets?"../docs/article-quality-review-api-offsets.json":"../docs/article-quality-review-api-probe.json", import.meta.url));
  await writeFile(output, JSON.stringify(report,null,2)+"\n");
  console.log(`Recorded ${report.samples.length} synthetic probes in ${output}; no key or raw response was written.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error("Probe could not finish. Check the local key source and network; credentials were not printed."); process.exitCode=1; });
}
