// @vitest-environment jsdom
import {beforeEach,afterEach,it,expect,vi} from "vitest";
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {flushSync} from "react-dom";
import {desktop,type AssetIntegrityItem} from "../desktop";
import {AssetIntegrity} from "./AssetIntegrity";
let root:Root,container:HTMLDivElement;
const item:AssetIntegrityItem={id:"image",name:"image.png",state:"corrupt",canRestore:true,references:[{kind:"entry",id:"article",title:"Article"}]};
const button=(label:string)=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent===label)!;
beforeEach(()=>{container=document.createElement('div');document.body.append(container);root=createRoot(container);});
afterEach(()=>{flushSync(()=>root.unmount());container.remove();vi.restoreAllMocks();vi.useRealTimers();});
it('shows missing-image locations and keeps the restore result visible after the real request',async()=>{
  let complete!:()=>void;
  const recover=vi.spyOn(desktop,'assetRecoverOriginal').mockImplementation(()=>new Promise<void>(resolve=>{complete=resolve;}));
  vi.spyOn(desktop,'assetIntegrity').mockResolvedValue([{...item,state:'local'}]);
  flushSync(()=>root.render(<AssetIntegrity items={[item]} onClose={()=>{}}/>));
  expect(document.body.textContent).toContain('Article');
  vi.useFakeTimers();
  flushSync(()=>button('恢复').click());
  await vi.advanceTimersByTimeAsync(2000);
  expect(recover).toHaveBeenCalledExactlyOnceWith('image');
  expect(document.querySelector('.rt-Spinner')).not.toBeNull();
  expect(button('重新检查').disabled).toBe(true);
  await act(async()=>{complete();await vi.advanceTimersByTimeAsync(0);});
  expect(button('已恢复')).toBeDefined();
  expect(document.body.textContent).toContain('本地可用');
  await act(async()=>vi.advanceTimersByTimeAsync(1000));
  expect(button('已恢复')).toBeUndefined();
});
it('reports recovery failure near the unchanged image and leaves its location available',async()=>{
  vi.spyOn(desktop,'assetRecoverOriginal').mockRejectedValue({code:'ASSET_MISSING',message:'找不到可恢复的原图副本'});
  flushSync(()=>root.render(<AssetIntegrity items={[item]} onClose={()=>{}}/>));
  flushSync(()=>button('恢复').click());
  await vi.waitFor(()=>expect(document.querySelector('[role="alert"]')?.textContent).toContain('找不到可恢复的原图副本'));
  expect(document.body.textContent).toContain('Article');
  expect(document.body.textContent).toContain('校验失败');
});
