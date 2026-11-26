import { createRoot } from "react-dom/client";
import { Theme } from "@radix-ui/themes";
import "@radix-ui/themes/styles.css";
import "../src/styles/tokens.css";
import "../src/styles/desktop-shell.css";
import { desktop } from "../src/desktop";
import { EditorRecovery } from "../src/workspace/EditorRecovery";
import type { Entry } from "../../../packages/shared-types";
const changed=new URLSearchParams(location.search).has("changed");
const entry:Entry={id:"draft",kind:"article",title:"文章",contentMd:"正式正文",status:"draft",categoryId:null,tags:[],summary:"",source:null,publishedAt:null,publishedUrl:"",version:changed?5:4,updatedAt:0,deletedAt:null,links:[]};
desktop.entry=async()=>entry;
desktop.recoveryGet=async()=>({...entry,contentMd:"恢复正文"});
let completeRecovery: () => void;
declare global { interface Window { editorRecoveryHarness: { calls: number; complete(): void } } }
window.editorRecoveryHarness = { calls: 0, complete: () => completeRecovery() };
desktop.recoveryRestore=async()=>{
  window.editorRecoveryHarness.calls++;
  await new Promise<void>(resolve=>{completeRecovery=resolve;});
  return {...entry,contentMd:"恢复正文",version:5};
};
desktop.recoveryDiscard=async()=>{};
createRoot(document.getElementById("root")!).render(<Theme><EditorRecovery drafts={[{entryId:"draft",sessionId:"session",title:"文章",baseVersion:4,localRevision:2,updatedAt:1}]} onClose={()=>document.body.dataset.closed="true"} onRecovered={()=>document.body.dataset.recovered="true"}/></Theme>);
