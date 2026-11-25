import { useState } from "react";
import { Button, Dialog, IconButton } from "@radix-ui/themes";
import { X } from "lucide-react";
import { desktop, type AssetIntegrityItem } from "../desktop";
import { ActionError,useButtonFeedback } from "../button-feedback";

const labels={local:"本地可用",sync:"待从同步恢复",hosted:"待从图床恢复",missing:"文件缺失",corrupt:"校验失败"} as const;
export function AssetIntegrity({items:initial,onClose}:{items:AssetIntegrityItem[];onClose():void}) {
  const [items,setItems]=useState(initial);
  const feedback=useButtonFeedback();
  const [busy,setBusy]=useState(false);
  async function check(id?:string){
    if(busy)return;
    setBusy(true);
    const key=id??"check";
    await feedback.run(key,async()=>{
      if(id)await desktop.assetRecoverOriginal(id);
      setItems(await desktop.assetIntegrity());
    });
    setBusy(false);
  }
  return <Dialog.Root open onOpenChange={open=>{if(!open&&!busy)onClose();}}>
    <Dialog.Content className="asset-integrity-dialog" aria-describedby={undefined} onPointerDownOutside={event=>event.preventDefault()}>
      <div className="asset-integrity-heading"><Dialog.Title>素材完整性</Dialog.Title><IconButton variant="ghost" size="1" aria-label="关闭" disabled={busy} onClick={onClose}><X size={16}/></IconButton></div>
      <div className="asset-integrity-scroll"><table><thead><tr><th>图片名</th><th>状态</th><th>引用文档</th><th>操作</th></tr></thead>
        <tbody>{items.map(item=><tr key={item.id}><td title={item.id}>{item.name||item.id}</td><td>{labels[item.state]}</td>
          <td>{item.references.map(reference=><div key={`${reference.kind}:${reference.id}`} title={reference.id}>{reference.title||"未命名"}</div>)}</td>
          <td>{(item.state!=="local"||feedback.status(item.id))&&<Button size="1" variant="soft" loading={feedback.status(item.id)==="pending"} {...feedback.props(item.id,busy||!item.canRestore)} onClick={()=>void check(item.id)}>{feedback.label(item.id,"恢复","已恢复")}</Button>}</td></tr>)}</tbody></table></div>
      <ActionError error={feedback.error()}/>
      <div className="asset-integrity-footer"><Button size="1" variant="soft" loading={feedback.status("check")==="pending"} {...feedback.props("check",busy)} onClick={()=>void check()}>{feedback.label("check","重新检查","检查完成")}</Button></div>
    </Dialog.Content>
  </Dialog.Root>;
}
