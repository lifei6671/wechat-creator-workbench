/* Browser-only interaction prototype. It does not save, export or sync user content. */
const heroSource={name:'城市桌面.png',src:'assets/reference-desktop.png',iw:3805,ih:1911,crop:{x:578,y:207,w:2323,h:1438}};
const librarySources=[
  {name:'网页截图.png',src:'assets/page.png',iw:1080,ih:815,crop:{x:54,y:41,w:972,h:733}},
  {name:'功能说明.png',src:'assets/table.png',iw:1080,ih:542,crop:{x:54,y:27,w:972,h:488}},
  {name:'文章目录.png',src:'assets/list.png',iw:801,ih:1858,crop:{x:40,y:93,w:721,h:1672}},
];
const backgrounds=[
  {name:'雾蓝',a:'#e1d9ff',b:'#c2e5ff'}, {name:'暖沙',a:'#fff7c2',b:'#f5d90a'},
  {name:'青绿',a:'#d6f1df',b:'#caf1f6'}, {name:'晚霞',a:'#f6cee7',b:'#e4defc'},
  {name:'石墨',a:'#60646c',b:'#1c2024'}, {name:'浅灰',a:'#f0f0f3',b:'#e8e8ec'},
];
const solidColors=['#ffffff','#f0f0f3','#1c2024','#e4defc','#caf1f6','#fff7c2'];
const copyState=value=>structuredClone(value);
let scene,selected=new Set(),past=[],future=[],view={x:0,y:0,z:.6};
let tool='select',space=false,gesture=null,cropping=false,ratioLocked=true,busy=false;
let rangeBefore=null,saveTimer,backgroundUpload=false,errorMessage='';
const pickedSources=new Set(),objectUrls=new Set();
function createNode(source,x,y,w){return {...copyState(source),id:crypto.randomUUID(),x,y,w,h:w*source.crop.h/source.crop.w,rotation:0,flip:false,opacity:100};}
function initialScene(){
  if(busy)return;
  clearTimeout(saveTimer);past=[];future=[];cropping=false;errorMessage='';
  scene={width:1600,height:1112,padding:88,radius:18,shadow:24,gap:24,columns:2,layout:null,layoutIds:[],sizePolicy:'min',bgtype:'gradient',preset:0,a:backgrounds[0].a,b:backgrounds[0].b,backgroundSrc:null,format:'PNG',scale:1,nodes:[createNode(heroSource,88,115,1424)]};
  selected=new Set([scene.nodes[0].id]);$('#sync-state').value='saved';render();fitAll();
}
function pushHistory(before=copyState(scene)){past.push(before);if(past.length>40)past.shift();future=[];}
function change(action){if(busy)return;pushHistory();action();cropping=false;errorMessage='';render();saveSoon();}
function saveSoon(){clearTimeout(saveTimer);$('#status').textContent='正在保存…';saveTimer=setTimeout(renderStatus,400);}
function selectedNodes(){return scene.nodes.filter(node=>selected.has(node.id));}
function backgroundPaint(){
  if(scene.bgtype==='transparent')return 'conic-gradient(#fff 25%,#e8e8ec 0 50%,#fff 0 75%,#e8e8ec 0) 0 0 / 24px 24px';
  if(scene.bgtype==='solid')return scene.a;
  if(scene.bgtype==='wallpaper'&&scene.backgroundSrc)return `url("${scene.backgroundSrc}") center / cover`;
  if(scene.bgtype==='wallpaper')return `radial-gradient(ellipse at 0 100%,${scene.b},transparent 60%),radial-gradient(ellipse at 100% 0,${scene.a},transparent 60%),conic-gradient(from 45deg at 35% 45%,${scene.a},${scene.b},${scene.a})`;
  return `linear-gradient(135deg,${scene.a},${scene.b})`;
}
function nodeHtml(node,preview=false){
  const chosen=!preview&&selected.has(node.id),c=node.crop;
  const unavailable=$('#sync-state').value==='missing'&&node.id===scene.nodes[0]?.id;
  const picture=unavailable?`<div class="missing-node">${icon('image')}<span>原图暂不可用</span></div>`:`<div style="position:absolute;inset:0;transform:scaleX(${node.flip?-1:1})"><img draggable="false" alt="${escapeHtml(node.name)}" src="${escapeHtml(node.src)}" style="width:${node.iw/c.w*100}%;height:${node.ih/c.h*100}%;left:${-c.x/c.w*100}%;top:${-c.y/c.h*100}%"></div>`;
  return `<div class="node${chosen?' selected':''}" data-node="${node.id}" role="button" tabindex="${preview?-1:0}" aria-label="${escapeHtml(node.name)}" aria-pressed="${chosen}" style="left:${node.x}px;top:${node.y}px;width:${node.w}px;height:${node.h}px;transform:rotate(${node.rotation}deg)"><div class="node-content" style="opacity:${node.opacity/100};border-radius:${scene.radius}px;box-shadow:0 ${scene.shadow*.6}px ${scene.shadow*1.7}px #1c2024${Math.round(scene.shadow*1.6).toString(16).padStart(2,'0')}">${picture}</div>${chosen&&!cropping?['nw','ne','sw','se'].map(corner=>`<span class="handle ${corner}" data-handle="${corner}"></span>`).join(''):''}${chosen&&cropping?'<div class="crop-overlay"></div>':''}</div>`;
}
function bounds(nodes){
  let left=0,top=0,right=scene.width,bottom=scene.height;
  for(const n of nodes){const angle=n.rotation*Math.PI/180,w=Math.abs(n.w*Math.cos(angle))+Math.abs(n.h*Math.sin(angle)),h=Math.abs(n.h*Math.cos(angle))+Math.abs(n.w*Math.sin(angle));left=Math.min(left,n.x+(n.w-w)/2);top=Math.min(top,n.y+(n.h-h)/2);right=Math.max(right,n.x+(n.w+w)/2);bottom=Math.max(bottom,n.y+(n.h+h)/2);}
  return {left,top,right,bottom};
}
function renderCanvas(){
  $('#board').style.width=scene.width+'px';$('#board').style.height=scene.height+'px';$('#board-background').style.background=backgroundPaint();
  $('#nodes').innerHTML=scene.nodes.map(node=>nodeHtml(node)).join('');
  $('#world').style.transform=`translate(${view.x}px,${view.y}px) scale(${view.z})`;$('#world').style.setProperty('--z',view.z);
  $('#board-caption').textContent=`画板  ${scene.width} × ${scene.height}`;$('#board-caption').style.top=(-28/view.z)+'px';$('#board-caption').style.transform=`scale(${1/view.z})`;
  const nodes=selectedNodes();$('#selection-size').hidden=nodes.length!==1;
  if(nodes.length===1){const n=nodes[0],badge=$('#selection-size');badge.textContent=`${Math.round(n.w)} × ${Math.round(n.h)}`;badge.style.left=(n.x+n.w/2)+'px';badge.style.top=(n.y+n.h+16/view.z)+'px';badge.style.transform=`translateX(-50%) scale(${1/view.z})`;}
  $('#zoom-value').textContent=Math.round(view.z*100)+'%';$('#stage').classList.toggle('panning',tool==='pan'||space);
}
function renderLayerList(){
  const focused=document.activeElement?.closest('[data-layer]')?.dataset.layer;
  $('#layer-list').innerHTML=[...scene.nodes].reverse().map(n=>`<button class="layer-row" data-layer="${n.id}" aria-pressed="${selected.has(n.id)}"><img src="${escapeHtml(n.src)}" alt=""><span>${escapeHtml(n.name)}</span></button>`).join('');
  if(focused)$('#layer-list').querySelector(`[data-layer="${focused}"]`)?.focus();
}
function renderBackground(){
  const solid=scene.bgtype==='solid',transparent=scene.bgtype==='transparent';
  $('#background-presets').hidden=transparent;$('#color-fields').hidden=transparent;$('#second-color').hidden=solid;$('#color-arrow').hidden=solid;
  $('#background-presets').innerHTML=(solid?solidColors:backgrounds).map((p,i)=>`<button class="background-preset" data-preset="${i}" aria-label="${solid?'背景颜色 '+p:p.name}" aria-pressed="${scene.preset===i}" style="background:${solid?p:scene.bgtype==='wallpaper'?`conic-gradient(from ${i*40}deg at 30% 40%,${p.a},${p.b},${p.a})`:`linear-gradient(135deg,${p.a},${p.b})`}">${scene.preset===i?icon('check'):''}</button>`).join('');
  $('#color-a').value=scene.a;$('#color-b').value=scene.b;$('#color-a-code').textContent=scene.a.toUpperCase();$('#color-b-code').textContent=scene.b.toUpperCase();
  $$('[data-background]').forEach(button=>button.setAttribute('aria-pressed',String(scene.bgtype===button.dataset.background)));
}
function renderInspector(){
  const items=selectedNodes(),single=items.length===1,multiple=items.length>1,first=items[0];
  $('#single-properties').hidden=!single;$('#multiple-properties').hidden=!multiple;$('#board-properties').hidden=items.length!==0;
  $('#context-title').textContent=single?'图片':multiple?`已选 ${items.length} 张图片`:'画板';
  $('#context-subtitle').textContent=single?first.name:'';$('#context-subtitle').hidden=!single;
  $('#context-icon').innerHTML=icon(single?'image':multiple?'layers':'fit');
  if(first){$('#image-w').value=Math.round(first.w);$('#image-h').value=Math.round(first.h);$('#image-x').value=Math.round(first.x);$('#image-y').value=Math.round(first.y);$('#opacity').value=first.opacity;$('#opacity-value').textContent=first.opacity+'%';$('#original-size').textContent=`原图 ${Math.round(first.crop.w)} × ${Math.round(first.crop.h)}`;}
  $('#board-w').value=scene.width;$('#board-h').value=scene.height;
  for(const name of ['padding','radius','shadow','gap']){$('#'+name).value=scene[name];$('#'+name+'-value').textContent=scene[name]+(name==='shadow'?'%':' px');}
  $('#columns').value=scene.columns;$('#columns-line').hidden=scene.layout!=='grid';$('#size-policy').value=scene.sizePolicy;
  $$('[data-layout]').forEach(button=>{button.setAttribute('aria-pressed',String(button.dataset.layout===scene.layout));button.disabled=!multiple;});
  $('#single-actions').hidden=!single;$('#multi-actions').hidden=!multiple;$('#board-actions').hidden=!!items.length;
  $('#duplicate').hidden=!items.length;$('#delete').hidden=!items.length;$('#selection-divider').hidden=!items.length;
  $('#advanced').hidden=!items.length;$('#crop span:last-child').textContent=cropping?'完成裁剪':'裁剪';
  $$('[data-format]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.format===scene.format)));$('#export-scale').value=scene.scale;
  $('#output-size').textContent=`${scene.width*scene.scale} × ${scene.height*scene.scale} px`;
  $('#undo').disabled=!past.length||busy;$('#redo').disabled=!future.length||busy;
  for(const id of ['apply','copy','export'])$('#'+id).disabled=busy||!scene.nodes.length||$('#sync-state').value==='missing';
}
function renderStatus(){
  const mode=$('#sync-state').value;$('#status').textContent={saved:'草稿已保存',offline:'离线，已保存到本机',conflict:'画布有同步冲突',missing:'等待原图下载'}[mode];
  $('#status-dot').className=mode==='offline'?'offline':mode==='conflict'?'conflict':'';
  $('#error').textContent=mode==='missing'?'原图下载失败，暂时无法输出。':errorMessage;
}
function render(){renderCanvas();renderLayerList();renderBackground();renderInspector();renderStatus();}
function fitAll(){
  const rect=$('#stage').getBoundingClientRect(),right=innerWidth<=850?280:innerWidth<=1180?310:340,left=innerWidth<=850?76:100;
  const box=bounds(scene.nodes),availableW=Math.max(100,rect.width-right-left),availableH=Math.max(100,rect.height-230);
  view.z=Math.max(.02,Math.min(availableW/(box.right-box.left),availableH/(box.bottom-box.top),1));
  view.x=left+(availableW-(box.right-box.left)*view.z)/2-box.left*view.z;
  view.y=112+(availableH-(box.bottom-box.top)*view.z)/2-box.top*view.z;renderCanvas();
}
function zoomBy(factor,point){const rect=$('#stage').getBoundingClientRect(),x=point?.x??(rect.width-300)/2,y=point?.y??rect.height/2,next=Math.max(.02,Math.min(3,view.z*factor)),r=next/view.z;view.x=x-(x-view.x)*r;view.y=y-(y-view.y)*r;view.z=next;renderCanvas();}
function select(id,extend=false){if(!extend)selected.clear();if(extend&&selected.has(id))selected.delete(id);else selected.add(id);cropping=false;render();}
function selectAll(){selected=new Set(scene.nodes.map(n=>n.id));cropping=false;render();}
function arrange(mode=scene.layout){
  let nodes=selectedNodes();if(nodes.length<2&&scene.layout===mode)nodes=scene.nodes.filter(n=>scene.layoutIds.includes(n.id));if(nodes.length<2||!mode)return;
  const pad=scene.padding,gap=scene.gap,dimension=mode==='horizontal'?'h':'w';
  const target=(scene.sizePolicy==='max'?Math.max:Math.min)(...nodes.map(n=>n.crop[dimension]));
  if(mode==='horizontal'){let x=pad;for(const n of nodes){n.x=x;n.y=pad;n.h=target;n.w=target*n.crop.w/n.crop.h;n.rotation=0;x+=n.w+gap;}scene.width=Math.round(x-gap+pad);scene.height=Math.round(target+pad*2);}
  else if(mode==='vertical'){let y=pad;for(const n of nodes){n.x=pad;n.y=y;n.w=target;n.h=target*n.crop.h/n.crop.w;n.rotation=0;y+=n.h+gap;}scene.width=Math.round(target+pad*2);scene.height=Math.round(y-gap+pad);}
  else{const columns=Math.min(scene.columns,nodes.length);let y=pad;for(let i=0;i<nodes.length;i+=columns){let rowH=0;nodes.slice(i,i+columns).forEach((n,col)=>{n.x=pad+col*(target+gap);n.y=y;n.w=target;n.h=target*n.crop.h/n.crop.w;n.rotation=0;rowH=Math.max(rowH,n.h);});y+=rowH+gap;}scene.width=Math.round(columns*target+(columns-1)*gap+pad*2);scene.height=Math.round(y-gap+pad);}
  scene.layout=mode;scene.layoutIds=nodes.map(n=>n.id);
}
function command(action){
  if(!selected.size)return;
  change(()=>{
    if(action==='delete'){scene.nodes=scene.nodes.filter(n=>!selected.has(n.id));selected.clear();scene.layout=null;}
    if(action==='duplicate'){const extra=selectedNodes().map(n=>({...copyState(n),id:crypto.randomUUID(),x:n.x+40,y:n.y+40}));scene.nodes.push(...extra);selected=new Set(extra.map(n=>n.id));scene.layout=null;}
    if(action==='front')scene.nodes=[...scene.nodes.filter(n=>!selected.has(n.id)),...selectedNodes()];
    if(action==='raise')for(let i=scene.nodes.length-2;i>=0;i--){if(selected.has(scene.nodes[i].id)&&!selected.has(scene.nodes[i+1].id))[scene.nodes[i],scene.nodes[i+1]]=[scene.nodes[i+1],scene.nodes[i]];}
    if(action==='lower')for(let i=1;i<scene.nodes.length;i++){if(selected.has(scene.nodes[i].id)&&!selected.has(scene.nodes[i-1].id))[scene.nodes[i],scene.nodes[i-1]]=[scene.nodes[i-1],scene.nodes[i]];}
  });
}
function addSources(sources){
  change(()=>{const old=selected.size?new Set(selected):new Set();sources.forEach((source,i)=>{const n=createNode(source,scene.width+80+i*768,70,720);scene.nodes.push(n);old.add(n.id);});selected=old;scene.layout=null;});
  $('#add-dialog').close();fitAll();
}
function openLibrary(){pickedSources.clear();renderLibrary();$('#add-dialog').showModal();}
function renderLibrary(){$('#library').innerHTML=librarySources.map((s,i)=>`<button class="library-item" data-library="${i}" aria-label="${escapeHtml(s.name)}" aria-pressed="${pickedSources.has(i)}"><img src="${s.src}" alt=""><span>${s.name}</span></button>`).join('');$('#add-selected').disabled=!pickedSources.size;$('#add-selected').textContent=pickedSources.size?`添加 ${pickedSources.size} 张图片`:'添加所选图片';}
function backgroundContext(){selected.clear();cropping=false;render();}
$('#add').onclick=openLibrary;$('#dock-add').onclick=openLibrary;$('#close-add').onclick=()=>$('#add-dialog').close();$('#cancel-add').onclick=()=>$('#add-dialog').close();
$('#library').onclick=e=>{const button=e.target.closest('[data-library]');if(!button)return;const index=Number(button.dataset.library);if(pickedSources.has(index))pickedSources.delete(index);else pickedSources.add(index);renderLibrary();};
$('#add-selected').onclick=()=>addSources([...pickedSources].map(i=>librarySources[i]));
$('#edit-background').onclick=backgroundContext;$('#board-settings').onclick=backgroundContext;
$('#select-all').onclick=selectAll;
$('#toggle-layers').onclick=()=>{$('#layers-popover').hidden=!$('#layers-popover').hidden;$('#toggle-layers').setAttribute('aria-expanded',String(!$('#layers-popover').hidden));};
$('#close-layers').onclick=()=>{$('#layers-popover').hidden=true;$('#toggle-layers').setAttribute('aria-expanded','false');};
$('#layer-list').onclick=e=>{const row=e.target.closest('[data-layer]');if(row)select(row.dataset.layer,e.shiftKey);};
function setTool(value){tool=value;for(const id of ['select','pan']){$('#'+id+'-tool').classList.toggle('active',value===id);$('#'+id+'-tool').setAttribute('aria-pressed',String(value===id));}renderCanvas();}
$('#select-tool').onclick=()=>setTool('select');$('#pan-tool').onclick=()=>setTool('pan');
$('#undo').onclick=()=>{if(busy||!past.length)return;future.push(copyState(scene));scene=past.pop();selected=new Set([...selected].filter(id=>scene.nodes.some(n=>n.id===id)));cropping=false;render();saveSoon();};
$('#redo').onclick=()=>{if(busy||!future.length)return;past.push(copyState(scene));scene=future.pop();selected.clear();cropping=false;render();saveSoon();};
$('#zoom-in').onclick=()=>zoomBy(1.2);$('#zoom-out').onclick=()=>zoomBy(1/1.2);$('#zoom-value').onclick=()=>zoomBy(1/view.z);$('#fit').onclick=fitAll;
$('#duplicate').onclick=()=>command('duplicate');$('#delete').onclick=()=>command('delete');$('#raise').onclick=()=>command('raise');$('#lower').onclick=()=>command('lower');
$('#rotate').onclick=()=>change(()=>{selectedNodes().forEach(n=>{n.rotation=(n.rotation+90)%360;});scene.layout=null;});
$('#flip').onclick=()=>change(()=>selectedNodes().forEach(n=>{n.flip=!n.flip;}));
$('#crop').onclick=()=>{if(cropping){change(()=>selectedNodes().forEach(n=>{n.crop.x+=n.crop.w*.08;n.crop.y+=n.crop.h*.08;n.crop.w*=.84;n.crop.h*=.84;}));}else{cropping=true;renderCanvas();renderInspector();}};
$('#lock-ratio').onclick=()=>{ratioLocked=!ratioLocked;$('#lock-ratio').innerHTML=icon(ratioLocked?'lock':'unlock');$('#lock-ratio').classList.toggle('active',ratioLocked);$('#lock-ratio').setAttribute('aria-pressed',String(ratioLocked));};
for(const key of ['w','h','x','y'])$('#image-'+key).onchange=e=>{const value=Number(e.target.value),first=selectedNodes()[0];if(!first)return;if(!Number.isFinite(value)||(['w','h'].includes(key)&&(value<20||value>16000))){renderInspector();return;}change(()=>{if(key==='w'||key==='h'){const factor=value/first[key];selectedNodes().forEach(n=>{n[key]*=factor;if(ratioLocked)n[key==='w'?'h':'w']*=factor;});}else{const offset=value-first[key];selectedNodes().forEach(n=>{n[key]+=offset;});}scene.layout=null;});};
$$('[data-size]').forEach(button=>button.onclick=()=>change(()=>{selectedNodes().forEach(n=>{n.w=n.crop.w*Number(button.dataset.size)/100;n.h=n.crop.h*Number(button.dataset.size)/100;});scene.layout=null;}));
for(const [field,key] of [['w','width'],['h','height']])$('#board-'+field).onchange=e=>{const value=Number(e.target.value);if(!Number.isInteger(value)||value<100||value>16000){renderInspector();return;}change(()=>{scene[key]=value;scene.layout=null;});fitAll();};
$$('[data-board-ratio]').forEach(button=>button.onclick=()=>{change(()=>{const[w,h]=button.dataset.boardRatio.split(':').map(Number);scene.height=Math.round(scene.width*h/w);scene.layout=null;});fitAll();});
$$('[data-layout]').forEach(button=>button.onclick=()=>{change(()=>arrange(button.dataset.layout));fitAll();});
$('#free-layout').onclick=()=>change(()=>{scene.layout=null;});
$('#size-policy').onchange=e=>{change(()=>{scene.sizePolicy=e.target.value;if(scene.layout)arrange();});fitAll();};
$('#columns').onchange=e=>{const value=Number(e.target.value);if(!Number.isInteger(value)||value<1||value>4){renderInspector();return;}change(()=>{scene.columns=value;if(scene.layout==='grid')arrange();});fitAll();};
$$('[data-align]').forEach(button=>button.onclick=()=>change(()=>{selectedNodes().forEach(n=>{n.x=button.dataset.align==='left'?scene.padding:button.dataset.align==='right'?scene.width-scene.padding-n.w:(scene.width-n.w)/2;});scene.layout=null;}));
for(const name of ['padding','radius','shadow','gap','opacity']){
  const input=$('#'+name);input.addEventListener('pointerdown',()=>{rangeBefore=copyState(scene);});input.addEventListener('keydown',()=>{if(!rangeBefore)rangeBefore=copyState(scene);});
  input.oninput=()=>{if(busy)return;if(!rangeBefore)rangeBefore=copyState(scene);const value=Number(input.value);if(name==='opacity')selectedNodes().forEach(n=>{n.opacity=value;});else scene[name]=value;
    if(name==='padding'){if(scene.layout)arrange();else if(scene.nodes.length){const left=Math.min(...scene.nodes.map(n=>n.x)),top=Math.min(...scene.nodes.map(n=>n.y)),right=Math.max(...scene.nodes.map(n=>n.x+n.w)),bottom=Math.max(...scene.nodes.map(n=>n.y+n.h));scene.nodes.forEach(n=>{n.x+=value-left;n.y+=value-top;});scene.width=Math.round(right-left+value*2);scene.height=Math.round(bottom-top+value*2);}}
    if(name==='gap'&&scene.layout)arrange();$('#'+name+'-value').textContent=value+(name==='shadow'||name==='opacity'?'%':' px');renderCanvas();};
  input.onchange=()=>{if(rangeBefore)pushHistory(rangeBefore);rangeBefore=null;render();if(name==='gap'||(name==='padding'&&scene.layout))fitAll();saveSoon();};
}
$$('[data-background]').forEach(button=>button.onclick=()=>change(()=>{scene.bgtype=button.dataset.background;scene.backgroundSrc=null;scene.preset=0;if(scene.bgtype==='solid')scene.a=solidColors[0];else{scene.a=backgrounds[0].a;scene.b=backgrounds[0].b;}}));
$('#background-presets').onclick=e=>{const button=e.target.closest('[data-preset]');if(!button)return;change(()=>{scene.preset=Number(button.dataset.preset);scene.backgroundSrc=null;if(scene.bgtype==='solid')scene.a=solidColors[scene.preset];else{scene.a=backgrounds[scene.preset].a;scene.b=backgrounds[scene.preset].b;}});};
for(const field of ['a','b'])$('#color-'+field).onchange=e=>change(()=>{scene[field]=e.target.value;scene.preset=-1;});

$('#stage').addEventListener('wheel',e=>{e.preventDefault();zoomBy(Math.exp(-e.deltaY*.0015),{x:e.clientX,y:e.clientY});},{passive:false});
$('#stage').addEventListener('pointerdown',e=>{
  if(e.button!==0||busy)return;e.preventDefault();$('#stage').focus();$('#context-menu').hidden=true;
  const node=e.target.closest('[data-node]'),handle=e.target.closest('[data-handle]'),origin={x:e.clientX,y:e.clientY},before=copyState(scene);
  if(tool==='pan'||space){gesture={type:'pan',origin,x:view.x,y:view.y};$('#stage').classList.add('dragging');}
  else if(node){if(!selected.has(node.dataset.node)||e.shiftKey)select(node.dataset.node,e.shiftKey);gesture={type:handle?'resize':'move',corner:handle?.dataset.handle,id:node.dataset.node,origin,before,start:copyState(selectedNodes()),collapseTo:!handle&&!e.shiftKey&&selected.size>1?node.dataset.node:null,moved:false};}
  else{if(!e.shiftKey)selected.clear();cropping=false;gesture={type:'marquee',origin,before,initial:new Set(selected)};render();}
  $('#stage').setPointerCapture(e.pointerId);
});
$('#stage').addEventListener('pointermove',e=>{
  if(!gesture)return;const dx=e.clientX-gesture.origin.x,dy=e.clientY-gesture.origin.y;
  if(gesture.type==='pan'){view.x=gesture.x+dx;view.y=gesture.y+dy;renderCanvas();return;}
  if(gesture.type==='marquee'){const left=Math.min(e.clientX,gesture.origin.x),top=Math.min(e.clientY,gesture.origin.y),width=Math.abs(dx),height=Math.abs(dy);Object.assign($('#marquee').style,{left:left+'px',top:top+'px',width:width+'px',height:height+'px'});$('#marquee').hidden=false;selected=new Set(gesture.initial);for(const n of scene.nodes){const x=view.x+n.x*view.z,y=view.y+n.y*view.z;if(x<left+width&&x+n.w*view.z>left&&y<top+height&&y+n.h*view.z>top)selected.add(n.id);}renderCanvas();renderInspector();renderLayerList();return;}
  if(gesture.type==='move'){if(!gesture.moved&&Math.abs(dx)<3&&Math.abs(dy)<3)return;gesture.moved=true;for(const start of gesture.start){const n=scene.nodes.find(item=>item.id===start.id);n.x=start.x+dx/view.z;n.y=start.y+dy/view.z;}}
  if(gesture.type==='resize'){const start=gesture.start.find(n=>n.id===gesture.id);if(!start)return;const n=scene.nodes.find(item=>item.id===start.id),west=gesture.corner.includes('w'),north=gesture.corner.includes('n'),w=Math.max(40,start.w+(west?-dx:dx)/view.z),h=w*start.h/start.w;n.w=w;n.h=h;n.x=start.x+(west?start.w-w:0);n.y=start.y+(north?start.h-h:0);}
  renderCanvas();renderInspector();
});
function endGesture(cancel=false){if(!gesture)return;const old=gesture;gesture=null;$('#stage').classList.remove('dragging');$('#marquee').hidden=true;if(old.type==='move'||old.type==='resize'){if(cancel)scene=old.before;else if(JSON.stringify(scene)!==JSON.stringify(old.before)){pushHistory(old.before);scene.layout=null;saveSoon();}if(!cancel&&old.collapseTo&&!old.moved)selected=new Set([old.collapseTo]);}render();}
$('#stage').addEventListener('pointerup',()=>endGesture());$('#stage').addEventListener('pointercancel',()=>endGesture(true));
$('#stage').addEventListener('keydown',e=>{const node=e.target.closest('[data-node]');if(node&&e.key==='Enter'){e.preventDefault();select(node.dataset.node,e.shiftKey);}});
$('#stage').addEventListener('contextmenu',e=>{e.preventDefault();const node=e.target.closest('[data-node]');if(!node)return;select(node.dataset.node);Object.assign($('#context-menu').style,{left:Math.min(e.clientX,innerWidth-166)+'px',top:Math.min(e.clientY,innerHeight-120)+'px'});$('#context-menu').hidden=false;});
$('#context-menu').onclick=e=>{const item=e.target.closest('[data-command]');if(item){command(item.dataset.command);$('#context-menu').hidden=true;}};
document.addEventListener('click',e=>{if(!e.target.closest('#context-menu'))$('#context-menu').hidden=true;if(!e.target.closest('#preview-settings,#preview-popover'))$('#preview-popover').hidden=true;});
document.addEventListener('keydown',e=>{
  if(e.defaultPrevented||e.target.matches('input,textarea,select')||$('dialog[open]')||busy)return;const canvas=e.target.closest('#stage,#layer-list'),modifier=e.ctrlKey||e.metaKey;
  if(e.code==='Space'&&e.target.closest('#stage')){e.preventDefault();space=true;renderCanvas();}
  if(modifier&&e.key.toLowerCase()==='a'&&canvas){e.preventDefault();selectAll();}
  if(modifier&&e.key.toLowerCase()==='z'){e.preventDefault();$(e.shiftKey?'#redo':'#undo').click();}
  if((e.key==='Backspace'||e.key==='Delete')&&canvas){e.preventDefault();command('delete');}
  if(e.key.startsWith('Arrow')&&selected.size&&canvas){e.preventDefault();const amount=e.shiftKey?10:1;change(()=>{selectedNodes().forEach(n=>{if(e.key==='ArrowLeft')n.x-=amount;if(e.key==='ArrowRight')n.x+=amount;if(e.key==='ArrowUp')n.y-=amount;if(e.key==='ArrowDown')n.y+=amount;});scene.layout=null;});}
  if(e.key==='Escape'){if(gesture)endGesture(true);else if(cropping){cropping=false;render();}else{selected.clear();render();}}
});
document.addEventListener('keyup',e=>{if(e.code==='Space'){space=false;renderCanvas();}});window.addEventListener('blur',()=>{space=false;endGesture(true);});
async function importImages(files){
  const sources=[];for(const file of files){if(!['image/png','image/jpeg','image/webp'].includes(file.type)){errorMessage='请选择 PNG、JPEG 或 WebP 图片。';continue;}if(file.size>20*1024*1024){errorMessage='图片不能超过 20 MB。';continue;}
    const url=URL.createObjectURL(file);objectUrls.add(url);try{const image=new Image();image.src=url;await image.decode();if(backgroundUpload){change(()=>{scene.bgtype='wallpaper';scene.backgroundSrc=url;scene.preset=-1;});backgroundUpload=false;return;}sources.push({name:file.name,src:url,iw:image.naturalWidth,ih:image.naturalHeight,crop:{x:0,y:0,w:image.naturalWidth,h:image.naturalHeight}});}catch{URL.revokeObjectURL(url);objectUrls.delete(url);errorMessage='无法读取图片，请选择其他文件。';}}
  if(sources.length)addSources(sources);renderStatus();
}
$('#choose-file').onclick=()=>{backgroundUpload=false;$('#file-input').click();};$('#custom-background').onclick=()=>{backgroundUpload=true;$('#file-input').click();};
$('#file-input').onchange=async e=>{await importImages(e.target.files);e.target.value='';};
$('#stage').addEventListener('dragover',e=>e.preventDefault());$('#stage').addEventListener('drop',e=>{e.preventDefault();backgroundUpload=false;void importImages(e.dataTransfer.files);});
$('#add-dialog').addEventListener('dragover',e=>e.preventDefault());$('#add-dialog').addEventListener('drop',e=>{e.preventDefault();backgroundUpload=false;void importImages(e.dataTransfer.files);});
document.addEventListener('paste',e=>{if(e.target.matches('input,textarea')||($('dialog[open]')&&!$('#add-dialog').open))return;const files=[...e.clipboardData.files];if(files.length){e.preventDefault();backgroundUpload=false;void importImages(files);}});
window.addEventListener('beforeunload',()=>objectUrls.forEach(url=>URL.revokeObjectURL(url)));
$$('[data-format]').forEach(button=>button.onclick=()=>{scene.format=button.dataset.format;renderInspector();});$('#export-scale').onchange=e=>{scene.scale=Number(e.target.value);renderInspector();};
async function demonstrate(button,pending,success,action){
  if(busy||button.disabled)return;const html=button.innerHTML,iconOnly=button.classList.contains('icon-button');busy=true;button.disabled=true;button.dataset.feedback='pending';button.innerHTML=`<span class="spinner">${icon('spinner')}</span>${iconOnly?'':`<span>${pending}</span>`}`;renderInspector();
  await new Promise(resolve=>setTimeout(resolve,400));if(action)action();button.dataset.feedback='success';button.innerHTML=icon('check')+(iconOnly?'':`<span>${success}</span>`);
  await new Promise(resolve=>setTimeout(resolve,1000));button.innerHTML=html;delete button.dataset.feedback;button.disabled=false;busy=false;renderInspector();
}
$('#copy').onclick=()=>void demonstrate($('#copy'),'复制中…','已演示复制');
$('#export').onclick=()=>{const scale=Math.min(424/scene.width,226/scene.height);$('#export-preview').innerHTML=`<div style="--z:1;position:absolute;transform-origin:0 0;transform:translate(${(432-scene.width*scale)/2}px,${(250-scene.height*scale)/2}px) scale(${scale});width:${scene.width}px;height:${scene.height}px;overflow:hidden">${scene.nodes.map(n=>nodeHtml(n,true)).join('')}</div>`;$('#export-preview').firstElementChild.style.background=backgroundPaint();$('#export-filename').textContent='文章配图.'+(scene.format==='JPEG'?'jpg':scene.format.toLowerCase());$('#export-dimensions').textContent=$('#output-size').textContent;$('#export-dialog').showModal();};
$('#close-export').onclick=()=>$('#export-dialog').close();$('#cancel-export').onclick=()=>$('#export-dialog').close();$('#confirm-export').onclick=()=>void demonstrate($('#confirm-export'),'保存中…','已演示保存');
function returnToArticle(applied){$('#return-message').textContent=applied?'当前画板已在原型中应用到文章。':'本次编辑保留在当前演示中。';$('#return-dialog').showModal();}
$('#apply').onclick=()=>void demonstrate($('#apply'),'正在应用…','已应用',()=>returnToArticle(true));$('#leave').onclick=()=>{if(!busy)returnToArticle(false);};$('#reopen').onclick=()=>{$('#return-dialog').close();$('#stage').focus();};
$('#preview-settings').onclick=e=>{e.stopPropagation();$('#preview-popover').hidden=!$('#preview-popover').hidden;};$('#theme').onclick=()=>document.body.classList.toggle('dark');$('#reset').onclick=()=>{initialScene();$('#preview-popover').hidden=true;};
$('#sync-state').onchange=()=>{clearTimeout(saveTimer);render();if($('#sync-state').value==='conflict'){$('#preview-popover').hidden=true;$('#conflict-dialog').showModal();}};
$('#status-button').onclick=()=>{if($('#sync-state').value==='conflict')$('#conflict-dialog').showModal();};$('#close-conflict').onclick=()=>$('#conflict-dialog').close();
$$('[data-resolve]').forEach(button=>button.onclick=()=>{if(button.dataset.resolve==='cloud')change(()=>{scene.a=backgrounds[3].a;scene.b=backgrounds[3].b;scene.preset=3;scene.bgtype='gradient';});$('#sync-state').value='saved';$('#conflict-dialog').close();render();});
new ResizeObserver(fitAll).observe($('#stage'));initialScene();
