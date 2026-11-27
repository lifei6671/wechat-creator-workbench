import { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { Button, Theme } from "@radix-ui/themes";
import "@radix-ui/themes/styles.css";
import "../src/styles/tokens.css";
import "../src/styles/desktop-shell.css";
import "../src/styles/settings.css";
import { TooltipProvider } from "../../../packages/ui-react/Tooltip";
import { MarkdownEditor, type MarkdownEditorHandle } from "../../../packages/editor-react";
import { desktop, type ReviewCacheEntry, type ReviewResult } from "../src/desktop";
import { ReviewPanel } from "../src/workspace/ReviewPanel";
import { ReviewSettings } from "../src/workspace/ReviewSettings";
import { S3Fields, SettingsDialog, WorkspaceSettings } from "../src/workspace/Settings";
import { defaultViewShortcut } from "../src/workspace/view-shortcut";

let editor: MarkdownEditorHandle | null = null;
let revision = 0;
let configured = !new URLSearchParams(location.search).has("unconfigured");
const calls: { text: string; force: boolean }[] = [];
const connectionKeys: (string | undefined)[] = [];
const savedSettings: { enabled: boolean; key?: string }[] = [];
let records: (ReviewCacheEntry & { entryId: string })[] = new URLSearchParams(location.search).has("history") ? [
  { entryId: "article-0", id: "old", title: "旧文章的检测", scope: "document", checkedAt: Date.now() - 1000, summary: {humanRatio:.8,aiRatio:.1,suspectedRatio:.1,ratioConfidence:.8,softmaxConfidence:.9} },
  { entryId: "article-0", id: "legacy", title: "", scope: "selection", checkedAt: Date.now() - 86400000, summary: {humanRatio:.2,aiRatio:.5,suspectedRatio:.3,ratioConfidence:.8,softmaxConfidence:.9} },
  { entryId: "article-1", id: "other", title: "另一篇文章的记录", scope: "document", checkedAt: Date.now() - 1000, summary: {humanRatio:.7,aiRatio:.2,suspectedRatio:.1,ratioConfidence:.8,softmaxConfidence:.9} },
  { entryId: "", id: "unbound", title: "未知归属记录", scope: "document", checkedAt: Date.now() - 1000, summary: {humanRatio:.6,aiRatio:.3,suspectedRatio:.1,ratioConfidence:.8,softmaxConfidence:.9} },
] : [];
const deletedRecords: string[] = [];
const historyCalls: string[] = [];
let completeDeletion: (() => void) | undefined;
let completeList: (() => void) | undefined;
let reviewContext: { entryId: string; title: string; scope: "document" | "selection" } | undefined;
window.reviewSettingsHarness = { connectionKeys, savedSettings };
let resolve: (result: ReviewResult) => void;
let pendingText = "";
function result(): ReviewResult {
  return {checkerId:"zhuque_text",contentHash:"synthetic",projectionVersion:1,checkedAt:Date.now(),cacheHit:false,chargedTokens:30,cached:true,persistenceError:null,settingsRevision:revision,
    summary:{humanRatio:.2,aiRatio:.5,suspectedRatio:.3,ratioConfidence:.8,softmaxConfidence:.9},
    findings:[{id:"synthetic",category:"ai_generated",range:{from:0,to:Math.min(5,pendingText.length)},confidence:.8}]};
}
desktop.reviewSettings = async () => ({enabled:configured,hasKey:configured,revision,maxTextBytes:131072});
desktop.reviewCheck = (text, _version, force=false, context) => { reviewContext=context;pendingText=text;calls.push({text,force});return new Promise(done=>{resolve=done;}); };
desktop.reviewUsage = async () => ({month:"2026-11",knownTokens:60,unknownCalls:1,successfulCalls:3,cacheHits:2});
desktop.reviewTestConnection = async apiKey => {
  connectionKeys.push(apiKey);
  if (new URLSearchParams(location.search).has("failure")) throw new Error("合成连接失败");
  return result();
};
desktop.reviewCacheList = async entryId => {
  historyCalls.push(`list:${entryId}`);
  const selected=records.filter(record=>record.entryId===entryId);
  if (entryId==="article-0" && new URLSearchParams(location.search).has("hold-list")) await new Promise<void>(done=>{completeList=done;});
  return selected;
};
desktop.reviewCacheDelete = async (entryId, id) => {
  deletedRecords.push(id);
  if (new URLSearchParams(location.search).has("delete-failure")) throw new Error("合成删除失败");
  if (new URLSearchParams(location.search).has("hold-delete")) await new Promise<void>(done => {completeDeletion=done;});
  records=records.filter(record=>record.entryId!==entryId || record.id!==id);
};
desktop.reviewClearCache = async entryId => {
  historyCalls.push(`clear:${entryId ?? "all"}`);
  if (new URLSearchParams(location.search).has("clear-failure")) throw new Error("合成清空失败");
  records=entryId===undefined?[]:records.filter(record=>record.entryId!==entryId);
};
desktop.saveReviewSettings = async (enabled, key) => {savedSettings.push({enabled,key});configured=enabled&&key!=="";revision++;return desktop.reviewSettings();};
desktop.trashRetention = async days => days ?? 7;
desktop.closeToTray = async enabled => enabled ?? true;
desktop.gpuAcceleration = async enabled => enabled ?? true;

function SettingsFixture() {
  return <Theme appearance={new URLSearchParams(location.search).has("dark")?"dark":"light"} accentColor="indigo" grayColor="slate"
    radius="small" scaling="95%" panelBackground="solid" className="theme-root"><TooltipProvider>
    <SettingsDialog initialPage="review" onClose={()=>{}} renderPage={page=>{
      if(page==="review") return <ReviewSettings onSaved={()=>{}} />;
      if(page==="images") return <form className="settings-card" data-testid="reference-settings"><S3Fields scope="images" initial={null} hasKey={false} />
        <div className="settings-footer"><Button type="button" variant="soft">测试连接</Button><Button type="button">保存</Button></div></form>;
      if(page==="appearance") return <WorkspaceSettings page="appearance" appearance="system" shortcut={defaultViewShortcut()} workspaceShortcuts={{}}
        preferredView="edit" explorer downloadPastedImages convertLinks defaultOutline documentOpenMode="current" folderLoading="all" folderPageSize={50}
        onAppearance={()=>{}} onShortcut={()=>{}} onWorkspaceShortcut={()=>{}} onView={()=>{}} onExplorer={()=>{}}
        onDownloadPastedImages={()=>{}} onConvertLinks={()=>{}} onDefaultOutline={()=>{}} onDocumentOpenMode={()=>{}} onFolderLoading={()=>{}} onFolderPageSize={()=>{}} />;
      return null;
    }} />
  </TooltipProvider></Theme>;
}
declare global {interface Window {reviewSettingsHarness:{connectionKeys:typeof connectionKeys;savedSettings:typeof savedSettings};reviewHistoryHarness:{deletedRecords:string[];historyCalls:string[];completeDeletion():void;completeList():void;records():typeof records;context():typeof reviewContext};reviewHarness:{calls:typeof calls;complete():void;markdown():string;swap():void;configure():void;performance(length:number):Promise<{projectionMs:number;decorationMs:number;runs:number}>;selection():string}}}
window.reviewHistoryHarness={deletedRecords,historyCalls,completeDeletion:()=>completeDeletion!(),completeList:()=>completeList!(),records:()=>records,context:()=>reviewContext};
const source="# 正文标题\n\n第一段中文😀与 e\u0301 组合字符。\n\n第二段可复核文字。\n\n```js\nprivate code\n```\n\n| table |\n| --- |\n| ignored |";
function Fixture() {
  const [identity,setIdentity]=useState(0);
  const [handle,setHandle]=useState<MarkdownEditorHandle>();
  const [configurationRevision,setConfigurationRevision]=useState(0);
  const [showSettings,setShowSettings]=useState(false);
  const [panel,setPanel]=useState(true);
  const [body,setBody]=useState(source);
  window.reviewHarness={calls,complete:()=>{const value=result();records=[{id:"new",entryId:reviewContext!.entryId,title:reviewContext!.title,scope:reviewContext!.scope,checkedAt:value.checkedAt,summary:value.summary},...records.filter(record=>record.id!=="new" || record.entryId!==reviewContext!.entryId)];resolve(value);},markdown:()=>editor!.captureMarkdown().markdown,
    selection:()=>editor!.selectionText(),swap:()=>flushSync(()=>{setIdentity(value=>value+1);setHandle(undefined);}),
    configure:()=>flushSync(()=>{revision++;setConfigurationRevision(value=>value+1);}),
    async performance(length){
      flushSync(()=>{setBody(Array.from({length:length/100},()=>"> 文"+"文".repeat(99)).join("\n\n"));setIdentity(value=>value+1);setHandle(undefined);});
      while(!editor) await new Promise(requestAnimationFrame);
      const start=performance.now();const snapshot=editor.captureReview("document")!;
      const projectionMs=performance.now()-start;const before=performance.now();
      editor.showReview(snapshot,[{id:"performance",category:"ai_suspected",range:{from:0,to:snapshot.projection.text.length}}]);
      return {projectionMs,decorationMs:performance.now()-before,runs:snapshot.projection.runs.length};
    }};
  return <Theme appearance={new URLSearchParams(location.search).has("dark")?"dark":"light"} accentColor="indigo" grayColor="slate" className="theme-root"><TooltipProvider>
    <div style={{display:"grid",gridTemplateColumns:"minmax(360px,1fr) 350px",height:"100vh"}}>
      <div className="document-editor" style={{minHeight:0}}><button onClick={()=>setPanel(value=>!value)}>切换审查面板</button>
        <MarkdownEditor key={identity} entryId={`article-${identity}`} value={body} readOnly={false}
          ref={value=>{editor=value;setHandle(value??undefined);document.body.dataset.ready=String(Boolean(value));}}
          onDocumentChanged={()=>{}} onBlur={()=>{}} />
      </div>
      <aside style={{overflow:"auto",borderLeft:"0.5px solid var(--slate-a6)"}}>
        {panel&&<ReviewPanel key={identity} articleId={`article-${identity}`} articleTitle={`测试文章 ${identity}`} editor={handle} configurationRevision={configurationRevision} locked={false} selectionEnabled
          onSettings={()=>setShowSettings(value=>!value)} onNavigate={(snapshot,range)=>{handle?.revealReview(snapshot,range);}} />}
        {showSettings&&<ReviewSettings onSaved={()=>setConfigurationRevision(value=>value+1)} />}
      </aside>
    </div>
  </TooltipProvider></Theme>;
}
createRoot(document.getElementById("root")!).render(new URLSearchParams(location.search).has("settings") ? <SettingsFixture /> : <Fixture />);
