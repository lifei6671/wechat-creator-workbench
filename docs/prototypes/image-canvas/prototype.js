/* Independent interaction prototype. No application IPC, database or cloud requests. */
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const paths = {
  image:'<rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><path d="m21 15-5-5L5 21"></path>',
  pointer:'<path d="m4 3 7 18 2-8 8-2Z"></path>',
  hand:'<path d="M8 13V6a2 2 0 0 1 4 0v6-8a2 2 0 0 1 4 0v8-6a2 2 0 0 1 4 0v9c0 5-3 7-7 7-3 0-5-2-6-4l-4-6c-1-2 1-4 3-2l2 3"></path>',
  plus:'<path d="M12 5v14M5 12h14"></path>',minus:'<path d="M5 12h14"></path>',
  layers:'<path d="m12 3 10 5-10 5L2 8Zm-10 9 10 5 10-5M2 17l10 5 10-5"></path>',
  undo:'<path d="m9 5-5 5 5 5M4 10h10a6 6 0 0 1 0 12"></path>',
  redo:'<path d="m15 5 5 5-5 5m5-5H10a6 6 0 0 0 0 12"></path>',
  copy:'<rect x="8" y="8" width="13" height="13" rx="2"></rect><path d="M16 8V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h4"></path>',
  download:'<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"></path>',
  check:'<path d="m5 12 4 4L19 6"></path>',close:'<path d="m6 6 12 12M6 18 18 6"></path>',
  sun:'<circle cx="12" cy="12" r="4"></circle><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"></path>',
  fit:'<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"></path><rect x="8" y="8" width="8" height="8" rx="1"></rect>',
  crop:'<path d="M6 3v15h15M3 6h15v15"></path>',
  rotate:'<path d="M20 11a8 8 0 1 0-2 7M20 4v7h-7"></path>',
  flip:'<path d="M12 3v18M3 6l6 3v6l-6 3Zm18 0-6 3v6l6 3Z"></path>',
  lock:'<rect x="5" y="10" width="14" height="11" rx="2"></rect><path d="M8 10V6a4 4 0 0 1 8 0v4M12 14v3"></path>',
  unlock:'<rect x="5" y="10" width="14" height="11" rx="2"></rect><path d="M8 10V6a4 4 0 0 1 7.5-2M12 14v3"></path>',
  trash:'<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"></path>',
  horizontal:'<rect x="2" y="5" width="8" height="14" rx="1"></rect><rect x="14" y="5" width="8" height="14" rx="1"></rect>',
  vertical:'<rect x="5" y="2" width="14" height="8" rx="1"></rect><rect x="5" y="14" width="14" height="8" rx="1"></rect>',
  grid:'<rect x="3" y="3" width="7" height="7" rx="1"></rect><rect x="14" y="3" width="7" height="7" rx="1"></rect><rect x="3" y="14" width="7" height="7" rx="1"></rect><rect x="14" y="14" width="7" height="7" rx="1"></rect>',
  'align-left':'<path d="M4 3v18"></path><rect x="8" y="5" width="12" height="5" rx="1"></rect><rect x="8" y="14" width="8" height="5" rx="1"></rect>',
  'align-center':'<path d="M12 2v3m0 5v4m0 5v3"></path><rect x="3" y="5" width="18" height="5" rx="1"></rect><rect x="6" y="14" width="12" height="5" rx="1"></rect>',
  'align-right':'<path d="M20 3v18"></path><rect x="4" y="5" width="12" height="5" rx="1"></rect><rect x="8" y="14" width="8" height="5" rx="1"></rect>',
  front:'<rect x="8" y="3" width="13" height="13" rx="1"></rect><path d="M16 16v5H3V8h5"></path>',
  back:'<rect x="3" y="8" width="13" height="13" rx="1"></rect><path d="M8 8V3h13v13h-5"></path>',
  'arrow-right':'<path d="M4 12h16m-5-5 5 5-5 5"></path>',
  folder:'<path d="M3 7V4h6l2 3h10v14H3Z"></path>',
  eye:'<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"></path><circle cx="12" cy="12" r="3"></circle>',
  cloud:'<path d="M7 18a5 5 0 1 1 1-10 6 6 0 0 1 11 2 4 4 0 0 1-1 8Z"></path>',
  monitor:'<rect x="2" y="3" width="20" height="14" rx="2"></rect><path d="M8 21h8m-4-4v4"></path>',
  spinner:'<path d="M21 12a9 9 0 1 1-9-9"></path>',
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.image}</svg>`;
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
$$('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon); });

const sources = [
  {key:'table',name:'功能说明.png',src:'assets/table.png',iw:1080,ih:542,crop:{x:54,y:27,w:972,h:488}},
  {key:'page',name:'网页截图.png',src:'assets/page.png',iw:1080,ih:815,crop:{x:54,y:41,w:972,h:733}},
  {key:'list',name:'文章目录.png',src:'assets/list.png',iw:801,ih:1858,crop:{x:40,y:93,w:721,h:1672}},
];
const gradientPresets = [
  {name:'暖金',a:'#ffe3a2',b:'#ab6400'}, {name:'雾紫',a:'#e4defc',b:'#d6409f'},
  {name:'晴空',a:'#c2e5ff',b:'#00a2c7'}, {name:'青绿',a:'#d6f1df',b:'#299764'},
  {name:'暮色',a:'#8e8c99',b:'#1c2024'}, {name:'浅灰',a:'#f0f0f3',b:'#cdced6'},
];
const solidPresets = ['#ffffff','#f0f0f3','#1c2024','#ffe3a2','#e4defc','#caf1f6'];
let state;
let selected = new Set();
let undoStack = [], redoStack = [];
let view = {x:0,y:0,z:0.6};
let mode = 'select', spaceHeld = false, activeTab = 'artboard', lockedRatio = true;
let gesture = null, cropMode = false, rangeBefore = null, saveTimer;
let addingBackground = false, uiBusy = false;
const ownedUrls = new Set();
const clone = data => structuredClone(data);
const snapshot = () => clone(state);
function layer(source, x=64, y=64, width=952) {
  return {...clone(source),id:crypto.randomUUID(),x,y,w:width,h:width*source.crop.h/source.crop.w,rotation:0,flip:false};
}
function setup(scenario) {
  if(uiBusy)return;
  clearTimeout(saveTimer);selected.clear();
  state = {scenario,width:1080,height:640,padding:64,radius:16,shadow:30,gap:24,columns:2,layout:null,bgtype:'gradient',preset:0,a:gradientPresets[0].a,b:gradientPresets[0].b,format:'PNG',scale:1,layers:[layer(sources[0])],backgroundSrc:null};
  if (scenario === 'collage') {
    state.layers = [layer(sources[0]),layer(sources[1]),layer(sources[2])];
    state.preset=2;state.a=gradientPresets[2].a;state.b=gradientPresets[2].b;
    state.layout='horizontal';arrange();
  } else fitSingle();
  undoStack=[];redoStack=[];cropMode=false;activeTab='artboard';
  $('#sync-demo').value='saved';$('#operation-error').textContent='';
  $$('dialog[open]').forEach(dialog=>dialog.close());
  render();fit();
}
function remember(before=snapshot()) {undoStack.push(before);if(undoStack.length>40)undoStack.shift();redoStack=[];}
function mutate(action) {if(uiBusy)return;remember();action();cropMode=false;render();saveSoon();}
function saveSoon() {
  clearTimeout(saveTimer);$('#footer-status').textContent='正在保存…';
  saveTimer=setTimeout(renderSync,420);
}
function fitSingle() {
  if (state.layers.length!==1)return;
  const node=state.layers[0], ratio=node.crop.w/node.crop.h;
  node.w=Math.min(state.width-state.padding*2,(state.height-state.padding*2)*ratio);
  node.w=Math.max(20,node.w);node.h=node.w/ratio;node.x=(state.width-node.w)/2;node.y=(state.height-node.h)/2;
}
function arrange() {
  const ids=selected.size>1?selected:new Set(state.layers.map(node=>node.id));
  const nodes=state.layers.filter(node=>ids.has(node.id));
  if(!nodes.length)return;
  const pad=state.padding,gap=state.gap;
  if(state.layout==='horizontal') {
    const height=410;let x=pad;
    for(const node of nodes){node.x=x;node.y=pad;node.h=height;node.w=height*node.crop.w/node.crop.h;node.rotation=0;x+=node.w+gap;}
    state.width=Math.round(x-gap+pad);state.height=height+pad*2;
  } else if(state.layout==='vertical') {
    const width=720;let y=pad;
    for(const node of nodes){node.x=pad;node.y=y;node.w=width;node.h=width*node.crop.h/node.crop.w;node.rotation=0;y+=node.h+gap;}
    state.width=width+pad*2;state.height=Math.round(y-gap+pad);
  } else if(state.layout==='grid') {
    const cols=Math.min(state.columns,nodes.length),width=480;let y=pad;
    for(let i=0;i<nodes.length;i+=cols){let rowHeight=0;nodes.slice(i,i+cols).forEach((node,col)=>{node.x=pad+col*(width+gap);node.y=y;node.w=width;node.h=width*node.crop.h/node.crop.w;node.rotation=0;rowHeight=Math.max(rowHeight,node.h);});y+=rowHeight+gap;}
    state.width=cols*width+(cols-1)*gap+pad*2;state.height=Math.round(y-gap+pad);
  }
}
function backgroundCss() {
  if(state.backgroundSrc&&state.bgtype==='wallpaper')return `url("${state.backgroundSrc}") center / cover`;
  if(state.bgtype==='transparent')return 'conic-gradient(#ffffff 25%,#e8e8ec 0 50%,#ffffff 0 75%,#e8e8ec 0) 0 0 / 24px 24px';
  if(state.bgtype==='solid')return state.a;
  if(state.bgtype==='wallpaper')return `radial-gradient(ellipse at 10% 90%,${state.b} 0,transparent 55%),radial-gradient(ellipse at 90% 10%,${state.a} 10%,transparent 55%),conic-gradient(from ${state.preset*30}deg at 35% 45%,${state.a},${state.b},${state.a})`;
  return `linear-gradient(130deg,${state.a},${state.b})`;
}
function nodeMarkup(node, preview=false) {
  const isSelected=!preview&&selected.has(node.id);
  const crop=node.crop;
  const missing=$('#sync-demo').value==='missing'&&node.id===state.layers[0]?.id;
  const content=missing?`<div class="missing-placeholder">${icon('image')}<span>原图暂不可用</span></div>`:`<div style="position:absolute;inset:0;transform:scaleX(${node.flip?-1:1})"><img src="${escapeHtml(node.src)}" alt="${escapeHtml(node.name)}" draggable="false" style="width:${node.iw/crop.w*100}%;height:${node.ih/crop.h*100}%;left:${-crop.x/crop.w*100}%;top:${-crop.y/crop.h*100}%"></div>`;
  return `<div class="node${isSelected?' selected':''}${isSelected&&cropMode?' crop-mode':''}" data-id="${node.id}" role="button" tabindex="${preview?'-1':'0'}" aria-label="${escapeHtml(node.name)}" aria-pressed="${isSelected}" style="left:${node.x}px;top:${node.y}px;width:${node.w}px;height:${node.h}px;transform:rotate(${node.rotation}deg)"><div class="node-inner" style="border-radius:${state.radius}px;box-shadow:0 ${state.shadow/2}px ${state.shadow*1.4}px #1c2024${Math.round(state.shadow/100*180).toString(16).padStart(2,'0')}">${content}</div>${isSelected&&!cropMode?['nw','ne','sw','se'].map(corner=>`<span class="handle ${corner}" data-handle="${corner}"></span>`).join(''):''}${isSelected&&cropMode?'<div class="crop-lines"></div>':''}</div>`;
}
function renderCanvas() {
  $('#artboard').style.width=`${state.width}px`;$('#artboard').style.height=`${state.height}px`;
  $('#background').style.background=backgroundCss();
  $('#images').innerHTML=state.layers.map(node=>nodeMarkup(node)).join('');
  $('#artboard-label').textContent=`画板  ${state.width} × ${state.height}`;
  $('#artboard-label').style.transform=`scale(${1/view.z})`;
  $('#artboard-label').style.top=`${-28/view.z}px`;
  $('#world').style.setProperty('--zoom',view.z);
  $('#world').style.transform=`translate(${view.x}px,${view.y}px) scale(${view.z})`;
  $('#zoom-value').textContent=`${Math.round(view.z*100)}%`;
  $('#stage').classList.toggle('panning',mode==='pan'||spaceHeld);
}
function renderLayers() {
  $('#layer-count').textContent=state.layers.length;
  $('#layer-list').innerHTML=[...state.layers].reverse().map(node=>`<button class="layer-row${selected.has(node.id)?' selected':''}" data-layer="${node.id}" type="button" aria-pressed="${selected.has(node.id)}"><img class="layer-thumbnail" src="${escapeHtml(node.src)}" alt=""><span class="layer-name">${escapeHtml(node.name)}</span><span class="layer-eye">${icon('eye')}</span></button>`).join('');
}
function renderSwatches() {
  $('#swatches').hidden=state.bgtype==='transparent';$('#color-row').hidden=state.bgtype==='transparent';
  const solid=state.bgtype==='solid';
  $('#second-color').hidden=solid;$('#color-arrow').hidden=solid;
  $('#custom-background').hidden=state.bgtype!=='wallpaper';
  $('#swatches').innerHTML=(solid?solidPresets:gradientPresets).map((preset,i)=>{
    const paint=solid?preset:state.bgtype==='wallpaper'?`conic-gradient(from ${i*30}deg at 30% 40%,${preset.a},${preset.b},${preset.a})`:`linear-gradient(130deg,${preset.a},${preset.b})`;
    return `<button class="swatch" type="button" data-swatch="${i}" aria-label="${solid?'背景颜色 '+preset:preset.name}" aria-pressed="${state.preset===i}" style="background:${paint}">${state.preset===i?`<span class="swatch-check">${icon('check')}</span>`:''}</button>`;
  }).join('');
  $('#color-a').value=state.a;$('#color-a-label').textContent=state.a.toUpperCase();
  $('#color-b').value=state.b;$('#color-b-label').textContent=state.b.toUpperCase();
  $$('[data-bgtype]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.bgtype===state.bgtype)));
}
function renderInspector() {
  $('#board-width').value=state.width;$('#board-height').value=state.height;
  for(const property of ['padding','radius','shadow']){$('#'+property).value=state[property];$('#'+property+'-value').textContent=state[property]+(property==='shadow'?'%':' px');}
  $('#gap').value=state.gap;$('#columns').value=state.columns;
  $('#column-field').hidden=state.layout!=='grid';
  $$('[data-layout]').forEach(button=>{button.setAttribute('aria-pressed',String(state.layout===button.dataset.layout));button.disabled=state.layers.length<2;});
  $('#tab-artboard').setAttribute('aria-selected',String(activeTab==='artboard'));$('#tab-image').setAttribute('aria-selected',String(activeTab==='image'));
  $('#tab-artboard').tabIndex=activeTab==='artboard'?0:-1;$('#tab-image').tabIndex=activeTab==='image'?0:-1;
  $('#panel-artboard').hidden=activeTab!=='artboard';$('#panel-image').hidden=activeTab!=='image';
  $('#selected-count').hidden=selected.size<2;$('#selected-count').textContent=selected.size;
  const node=state.layers.find(item=>selected.has(item.id));
  $('#no-selection').hidden=!!node;$('#image-properties').hidden=!node;
  if(node){$('#image-name').textContent=selected.size>1?`已选 ${selected.size} 张图片`:node.name;for(const [field,key] of [['x','x'],['y','y'],['width','w'],['height','h']])$('#image-'+field).value=Math.round(node[key]);}
  $('#crop span:last-child').textContent=cropMode?'完成裁剪':'裁剪';
  $$('[data-align],#front,#back,#crop,#rotate,#flip').forEach(button=>{button.disabled=!node;});
  $$('[data-format]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.format===state.format)));
  $('#export-scale').value=state.scale;
  $('#output-size').textContent=`${state.width*state.scale} × ${state.height*state.scale} px`;$('#output-format').textContent=state.format;
  $('#undo').disabled=!undoStack.length;$('#redo').disabled=!redoStack.length;
  const missing=$('#sync-demo').value==='missing';
  for(const id of ['apply','export','copy'])$('#'+id).disabled=missing||!state.layers.length||uiBusy;
  $$('[data-scenario]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.scenario===state.scenario)));
}
function renderSync() {
  const value=$('#sync-demo').value;
  const text={saved:'草稿已保存',offline:'已保存到本机',conflict:'同步需要处理',missing:'草稿已保存'}[value];
  $('#footer-status').textContent=value==='offline'?'离线，联网后同步':value==='conflict'?'画布有同步冲突':value==='missing'?'等待原图下载':text;
  $('.status-dot').className='status-dot'+(value==='offline'?' offline':value==='conflict'?' conflict':'');
  $('#footer-sync').style.cursor=value==='conflict'?'pointer':'default';
  $('#operation-error').textContent=value==='missing'?'原图下载失败，请恢复连接后重试。':'';
}
function render() {renderCanvas();renderLayers();renderInspector();renderSwatches();renderSync();}
function fit() {
  const rect=$('#stage').getBoundingClientRect();
  view.z=Math.min((rect.width-180)/state.width,(rect.height-200)/state.height,1);
  view.z=Math.max(.08,view.z);view.x=(rect.width-state.width*view.z)/2;view.y=90+(rect.height-190-state.height*view.z)/2;
  renderCanvas();
}
function zoom(factor,point) {
  const rect=$('#stage').getBoundingClientRect(),x=point?.x??rect.width/2,y=point?.y??rect.height/2;
  const next=Math.max(.08,Math.min(3,view.z*factor));const ratio=next/view.z;
  view.x=x-(x-view.x)*ratio;view.y=y-(y-view.y)*ratio;view.z=next;renderCanvas();
}
function selectNode(id,add=false) {
  if(!add)selected.clear();
  if(add&&selected.has(id))selected.delete(id);else selected.add(id);
  activeTab='image';cropMode=false;render();
}
function deleteSelection() {
  if(!selected.size)return;
  mutate(()=>{state.layers=state.layers.filter(node=>!selected.has(node.id));selected.clear();});
}
function command(name) {
  if(name==='delete')return deleteSelection();
  if(!selected.size)return;
  mutate(()=>{
    if(name==='duplicate'){const additions=state.layers.filter(node=>selected.has(node.id)).map(node=>({...clone(node),id:crypto.randomUUID(),x:node.x+30,y:node.y+30}));state.layers.push(...additions);selected=new Set(additions.map(node=>node.id));}
    else if(name==='front')state.layers=[...state.layers.filter(node=>!selected.has(node.id)),...state.layers.filter(node=>selected.has(node.id))];
    else if(name==='raise'){for(let i=state.layers.length-2;i>=0;i--){if(selected.has(state.layers[i].id)&&!selected.has(state.layers[i+1].id))[state.layers[i],state.layers[i+1]]=[state.layers[i+1],state.layers[i]];}}
    else if(name==='lower'){for(let i=1;i<state.layers.length;i++){if(selected.has(state.layers[i].id)&&!selected.has(state.layers[i-1].id))[state.layers[i],state.layers[i-1]]=[state.layers[i-1],state.layers[i]];}}
  });
}
function addSource(source) {
  mutate(()=>{const width=Math.max(40,Math.min(500,state.width-state.padding*2));const node=layer(source,(state.width-width)/2,state.padding,width);state.layers.push(node);selected=new Set([node.id]);activeTab='image';state.layout=null;});
  $('#add-popover').hidden=true;
}

$('#sample-picker').innerHTML=sources.map(source=>`<button type="button" data-sample="${source.key}"><img src="${source.src}" alt=""><span>${source.name.replace('.png','')}</span></button>`).join('');
$$('[data-scenario]').forEach(button=>button.onclick=()=>setup(button.dataset.scenario));
$('#theme').onclick=()=>{document.body.classList.toggle('dark');$('#theme').setAttribute('aria-pressed',String(document.body.classList.contains('dark')));};
$('#tab-artboard').onclick=()=>{activeTab='artboard';cropMode=false;render();};
$('#tab-image').onclick=()=>{activeTab='image';render();};
$('.inspector-tabs').onkeydown=event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();activeTab=event.key==='Home'?'artboard':event.key==='End'?'image':activeTab==='artboard'?'image':'artboard';render();$('#tab-'+activeTab).focus();};
$('#select-tool').onclick=()=>setMode('select');$('#pan-tool').onclick=()=>setMode('pan');
function setMode(value){mode=value;$('#select-tool').classList.toggle('active',mode==='select');$('#select-tool').setAttribute('aria-pressed',String(mode==='select'));$('#pan-tool').classList.toggle('active',mode==='pan');$('#pan-tool').setAttribute('aria-pressed',String(mode==='pan'));renderCanvas();}
$('#layers-toggle').onclick=()=>{const panel=$('#layer-panel');panel.hidden=!panel.hidden;$('#layers-toggle').setAttribute('aria-pressed',String(!panel.hidden));};
$('#add-image').onclick=event=>{event.stopPropagation();$('#add-popover').hidden=!$('#add-popover').hidden;};
$('#choose-file').onclick=()=>{addingBackground=false;$('#file-input').click();};
$('#custom-background').onclick=()=>{addingBackground=true;$('#file-input').click();};
$('#sample-picker').onclick=event=>{const button=event.target.closest('[data-sample]');if(button)addSource(sources.find(source=>source.key===button.dataset.sample));};
document.addEventListener('click',event=>{if(!event.target.closest('#add-popover,#add-image'))$('#add-popover').hidden=true;if(!event.target.closest('#context-menu'))$('#context-menu').hidden=true;});
$('#layer-list').onclick=event=>{const row=event.target.closest('[data-layer]');if(row)selectNode(row.dataset.layer,event.shiftKey);};
for(const field of ['width','height'])$('#board-'+field).onchange=event=>{const value=Number(event.target.value);if(!Number.isFinite(value)||value<100||value>4000){event.target.value=state[field];$('#operation-error').textContent='原型画板尺寸支持 100–4000 px。';return;}mutate(()=>{state[field]=Math.round(value);state.layout=null;fitSingle();});fit();};
$$('[data-ratio]').forEach(button=>button.onclick=()=>{mutate(()=>{const ratio=button.dataset.ratio;if(ratio==='original'){state.width=1080;state.height=640;}else{const[w,h]=ratio.split(':').map(Number);state.height=Math.round(state.width*h/w);}state.layout=null;fitSingle();});$$('[data-ratio]').forEach(item=>item.setAttribute('aria-pressed',String(item===button)));fit();});
$$('[data-bgtype]').forEach(button=>button.onclick=()=>mutate(()=>{state.bgtype=button.dataset.bgtype;state.preset=0;state.backgroundSrc=null;if(state.bgtype==='solid')state.a=solidPresets[0];else{state.a=gradientPresets[0].a;state.b=gradientPresets[0].b;}}));
$('#swatches').onclick=event=>{const button=event.target.closest('[data-swatch]');if(!button)return;mutate(()=>{state.preset=Number(button.dataset.swatch);state.backgroundSrc=null;if(state.bgtype==='solid')state.a=solidPresets[state.preset];else{state.a=gradientPresets[state.preset].a;state.b=gradientPresets[state.preset].b;}});};
for(const field of ['a','b'])$('#color-'+field).onchange=event=>mutate(()=>{state[field]=event.target.value;state.preset=-1;});
for(const property of ['padding','radius','shadow']){
  const input=$('#'+property);
  input.addEventListener('pointerdown',()=>{rangeBefore=snapshot();});
  input.addEventListener('keydown',()=>{if(!rangeBefore)rangeBefore=snapshot();});
  input.oninput=()=>{if(!rangeBefore)rangeBefore=snapshot();state[property]=Number(input.value);if(property==='padding'){if(state.layout)arrange();else fitSingle();}renderCanvas();$('#'+property+'-value').textContent=state[property]+(property==='shadow'?'%':' px');};
  input.onchange=()=>{if(rangeBefore)remember(rangeBefore);rangeBefore=null;render();if(property==='padding'&&state.layout)fit();saveSoon();};
}
$$('[data-layout]').forEach(button=>button.onclick=()=>{mutate(()=>{state.layout=button.dataset.layout;arrange();});fit();});
for(const property of ['gap','columns'])$('#'+property).onchange=event=>{const value=Number(event.target.value),max=property==='gap'?100:4,min=property==='gap'?0:1;if(!Number.isInteger(value)||value<min||value>max){event.target.value=state[property];return;}mutate(()=>{state[property]=value;if(state.layout)arrange();});fit();};
for(const [field,key] of [['x','x'],['y','y'],['width','w'],['height','h']])$('#image-'+field).onchange=event=>{
  const value=Number(event.target.value);if(!Number.isFinite(value)||(['w','h'].includes(key)&&(value<20||value>4000))){renderInspector();return;}
  mutate(()=>{const first=state.layers.find(node=>selected.has(node.id));if(!first)return;const old=first[key],factor=value/old;for(const node of state.layers.filter(node=>selected.has(node.id))){if(key==='x'||key==='y')node[key]+=value-old;else{node[key]*=factor;if(lockedRatio)node[key==='w'?'h':'w']*=factor;}}state.layout=null;});
};
$('#ratio-lock').onclick=()=>{lockedRatio=!lockedRatio;$('#ratio-lock').innerHTML=icon(lockedRatio?'lock':'unlock');$('#ratio-lock').classList.toggle('active',lockedRatio);$('#ratio-lock').setAttribute('aria-pressed',String(lockedRatio));};
$('#rotate').onclick=()=>mutate(()=>{state.layers.filter(node=>selected.has(node.id)).forEach(node=>{node.rotation=(node.rotation+90)%360;});state.layout=null;});
$('#flip').onclick=()=>mutate(()=>state.layers.filter(node=>selected.has(node.id)).forEach(node=>{node.flip=!node.flip;}));
$('#delete-image').onclick=deleteSelection;$('#front').onclick=()=>command('raise');$('#back').onclick=()=>command('lower');
$$('[data-align]').forEach(button=>button.onclick=()=>mutate(()=>{state.layers.filter(node=>selected.has(node.id)).forEach(node=>{node.x=button.dataset.align==='left'?state.padding:button.dataset.align==='right'?state.width-state.padding-node.w:(state.width-node.w)/2;});state.layout=null;}));
$('#crop').onclick=()=>{if(!selected.size)return;if(cropMode){mutate(()=>{state.layers.filter(node=>selected.has(node.id)).forEach(node=>{node.crop.x+=node.crop.w*.08;node.crop.y+=node.crop.h*.08;node.crop.w*=.84;node.crop.h*=.84;});state.layout=null;});}else{cropMode=true;renderCanvas();renderInspector();}};
$('#undo').onclick=()=>{if(!undoStack.length)return;redoStack.push(snapshot());state=undoStack.pop();selected=new Set([...selected].filter(id=>state.layers.some(node=>node.id===id)));cropMode=false;render();saveSoon();};
$('#redo').onclick=()=>{if(!redoStack.length)return;undoStack.push(snapshot());state=redoStack.pop();selected.clear();cropMode=false;render();saveSoon();};
$('#fit').onclick=fit;$('#zoom-in').onclick=()=>zoom(1.2);$('#zoom-out').onclick=()=>zoom(1/1.2);$('#zoom-value').onclick=()=>zoom(1/view.z);
$('#stage').addEventListener('wheel',event=>{event.preventDefault();const rect=$('#stage').getBoundingClientRect();zoom(Math.exp(-event.deltaY*.0015),{x:event.clientX-rect.left,y:event.clientY-rect.top});},{passive:false});
$('#stage').addEventListener('pointerdown',event=>{
  if(event.button!==0||uiBusy)return;
  event.preventDefault();$('#stage').focus();$('#context-menu').hidden=true;
  const rect=$('#stage').getBoundingClientRect(),nodeEl=event.target.closest('.node'),handle=event.target.closest('[data-handle]');
  const origin={x:event.clientX,y:event.clientY},before=snapshot();
  if(mode==='pan'||spaceHeld){gesture={type:'pan',origin,x:view.x,y:view.y};$('#stage').classList.add('dragging');}
  else if(nodeEl){const id=nodeEl.dataset.id;if(!selected.has(id)||event.shiftKey)selectNode(id,event.shiftKey);gesture={type:handle?'resize':'move',corner:handle?.dataset.handle,id,origin,before,start:clone(state.layers.filter(node=>selected.has(node.id)))};}
  else{if(!event.shiftKey)selected.clear();activeTab='artboard';gesture={type:'marquee',origin,before,rect,initial:new Set(selected)};render();}
  $('#stage').setPointerCapture(event.pointerId);
});
$('#stage').addEventListener('pointermove',event=>{
  if(!gesture)return;const dx=event.clientX-gesture.origin.x,dy=event.clientY-gesture.origin.y;
  if(gesture.type==='pan'){view.x=gesture.x+dx;view.y=gesture.y+dy;renderCanvas();return;}
  if(gesture.type==='marquee'){
    const {rect,origin}=gesture,left=Math.min(origin.x,event.clientX)-rect.left,top=Math.min(origin.y,event.clientY)-rect.top,width=Math.abs(dx),height=Math.abs(dy);
    const box=$('#marquee');box.hidden=false;Object.assign(box.style,{left:left+'px',top:top+'px',width:width+'px',height:height+'px'});
    selected=new Set(gesture.initial);for(const node of state.layers){const x=view.x+node.x*view.z,y=view.y+node.y*view.z;if(x<left+width&&x+node.w*view.z>left&&y<top+height&&y+node.h*view.z>top)selected.add(node.id);}
    if(selected.size)activeTab='image';renderCanvas();renderLayers();renderInspector();return;
  }
  if(gesture.type==='move'){for(const start of gesture.start){const node=state.layers.find(item=>item.id===start.id);node.x=start.x+dx/view.z;node.y=start.y+dy/view.z;}}
  if(gesture.type==='resize'){
    const start=gesture.start.find(node=>node.id===gesture.id);if(!start)return;
    const node=state.layers.find(item=>item.id===gesture.id),left=gesture.corner.includes('w'),top=gesture.corner.includes('n');
    const width=Math.max(40,start.w+(left?-dx:dx)/view.z),height=width*start.h/start.w;
    node.w=width;node.h=height;node.x=start.x+(left?start.w-width:0);node.y=start.y+(top?start.h-height:0);
  }
  renderCanvas();renderInspector();
});
function finishGesture(cancel=false){if(!gesture)return;const current=gesture;gesture=null;$('#stage').classList.remove('dragging');$('#marquee').hidden=true;if(current.type==='move'||current.type==='resize'){if(cancel)state=current.before;else if(JSON.stringify(state)!==JSON.stringify(current.before)){remember(current.before);state.layout=null;saveSoon();}}render();}
$('#stage').addEventListener('pointerup',()=>finishGesture());$('#stage').addEventListener('pointercancel',()=>finishGesture(true));
$('#stage').addEventListener('keydown',event=>{const node=event.target.closest('.node');if(node&&event.key==='Enter'){event.preventDefault();selectNode(node.dataset.id,event.shiftKey);}});
$('#stage').addEventListener('contextmenu',event=>{event.preventDefault();const node=event.target.closest('.node');if(!node)return;selectNode(node.dataset.id);const rect=$('#stage').getBoundingClientRect(),menu=$('#context-menu');menu.style.left=Math.min(event.clientX-rect.left,rect.width-160)+'px';menu.style.top=Math.min(event.clientY-rect.top,rect.height-112)+'px';menu.hidden=false;});
$('#context-menu').onclick=event=>{const button=event.target.closest('[data-command]');if(button){command(button.dataset.command);$('#context-menu').hidden=true;}};

async function importFiles(files){
  for(const file of files){
    if(!['image/png','image/jpeg','image/webp'].includes(file.type)){$('#operation-error').textContent='原型支持 PNG、JPEG 和 WebP 图片。';continue;}
    if(file.size>20*1024*1024){$('#operation-error').textContent='请选择不超过 20 MB 的图片。';continue;}
    const url=URL.createObjectURL(file);ownedUrls.add(url);
    try{const image=new Image();image.src=url;await image.decode();if(addingBackground){mutate(()=>{state.backgroundSrc=url;state.bgtype='wallpaper';state.preset=-1;});addingBackground=false;break;}addSource({key:crypto.randomUUID(),name:file.name,src:url,iw:image.naturalWidth,ih:image.naturalHeight,crop:{x:0,y:0,w:image.naturalWidth,h:image.naturalHeight}});}
    catch{$('#operation-error').textContent='图片无法读取，请选择其他图片。';URL.revokeObjectURL(url);ownedUrls.delete(url);}
  }
}
$('#file-input').onchange=async event=>{await importFiles(event.target.files);event.target.value='';};
$('#stage').addEventListener('dragover',event=>event.preventDefault());
$('#stage').addEventListener('drop',event=>{event.preventDefault();addingBackground=false;void importFiles(event.dataTransfer.files);});
document.addEventListener('paste',event=>{if(event.target.matches('input,textarea')||$('dialog[open]'))return;const files=[...event.clipboardData.files];if(files.length){event.preventDefault();addingBackground=false;void importFiles(files);}});
window.addEventListener('beforeunload',()=>ownedUrls.forEach(url=>URL.revokeObjectURL(url)));
document.addEventListener('keydown',event=>{
  if(event.defaultPrevented||event.target.matches('input,select,textarea')||$('dialog[open]')||uiBusy)return;
  const modifier=event.ctrlKey||event.metaKey;
  const canvasFocused=event.target.closest('#stage,#layer-list');
  if(event.code==='Space'&&event.target.closest('#stage')){event.preventDefault();spaceHeld=true;renderCanvas();}
  if(modifier&&event.key.toLowerCase()==='z'){event.preventDefault();$(event.shiftKey?'#redo':'#undo').click();}
  if(modifier&&event.key.toLowerCase()==='a'&&canvasFocused){event.preventDefault();selected=new Set(state.layers.map(node=>node.id));activeTab='image';render();}
  if((event.key==='Delete'||event.key==='Backspace')&&canvasFocused){event.preventDefault();deleteSelection();}
  if(event.key==='Escape'){if(gesture)finishGesture(true);else if(cropMode){cropMode=false;render();}else if(!$('#add-popover').hidden)$('#add-popover').hidden=true;else closeEditor(false);}
  if(event.key.startsWith('Arrow')&&selected.size&&canvasFocused){event.preventDefault();const d=event.shiftKey?10:1;mutate(()=>{state.layers.filter(node=>selected.has(node.id)).forEach(node=>{if(event.key==='ArrowLeft')node.x-=d;if(event.key==='ArrowRight')node.x+=d;if(event.key==='ArrowUp')node.y-=d;if(event.key==='ArrowDown')node.y+=d;});state.layout=null;});}
});
document.addEventListener('keyup',event=>{if(event.code==='Space'){spaceHeld=false;renderCanvas();}});
window.addEventListener('blur',()=>{spaceHeld=false;finishGesture(true);});
$$('[data-format]').forEach(button=>button.onclick=()=>{state.format=button.dataset.format;renderInspector();});
$('#export-scale').onchange=event=>{state.scale=Number(event.target.value);renderInspector();};

const wait=duration=>new Promise(resolve=>setTimeout(resolve,duration));
async function feedback(button,pending,done,action){
  if(button.disabled||button.dataset.feedback)return false;
  const old=button.innerHTML;uiBusy=true;button.disabled=true;button.dataset.feedback='pending';button.innerHTML=`<span class="busy-icon">${icon('spinner')}</span><span>${pending}</span>`;renderInspector();
  await wait(430);if(action)action();button.dataset.feedback='success';button.innerHTML=`<span>${icon('check')}</span><span>${done}</span>`;
  await wait(1000);button.innerHTML=old;delete button.dataset.feedback;button.disabled=false;uiBusy=false;renderInspector();return true;
}
$('#copy').onclick=()=>void feedback($('#copy'),'复制中…','已演示复制');
$('#apply').onclick=()=>void feedback($('#apply'),'正在应用…','已应用',()=>{closeEditor(true);});
$('#close-editor').onclick=()=>closeEditor(false);
function closeEditor(applied){if(uiBusy&&!applied)return;$('#closed-message').textContent=applied?'当前画板已在原型中替换文章图片。':'未应用的编辑已保留为本次演示草稿。';$('#closed-dialog').showModal();$('#reopen').focus();}
$('#reopen').onclick=()=>{$('#closed-dialog').close();$('#stage').focus();};
$('#export').onclick=()=>{
  const preview=$('#export-preview'),scale=Math.min(390/state.width,192/state.height);
  preview.innerHTML=`<div class="world" style="--zoom:1;transform:translate(${(414-state.width*scale)/2}px,${(218-state.height*scale)/2}px) scale(${scale})"><div class="artboard" style="width:${state.width}px;height:${state.height}px;overflow:hidden"><div class="artboard-background" style="background:${backgroundCss()}"></div>${state.layers.map(node=>nodeMarkup(node,true)).join('')}</div></div>`;
  $('#export-filename').textContent=`图片.${state.format==='JPEG'?'jpg':state.format.toLowerCase()}`;$('#export-dimensions').textContent=$('#output-size').textContent;$('#export-dialog').showModal();
};
$('#export-confirm').onclick=()=>void feedback($('#export-confirm'),'保存中…','已演示保存');
$('#sync-demo').onchange=()=>{clearTimeout(saveTimer);render();if($('#sync-demo').value==='conflict')$('#conflict-dialog').showModal();};
$('#footer-sync').onclick=()=>{if($('#sync-demo').value==='conflict')$('#conflict-dialog').showModal();};
$('#close-conflict').onclick=()=>$('#conflict-dialog').close();
function resolveConflict(choice){if(choice==='cloud'){remember();state.preset=1;state.a=gradientPresets[1].a;state.b=gradientPresets[1].b;state.bgtype='gradient';state.layers.forEach(node=>{node.x+=12;});}$('#sync-demo').value='saved';$('#conflict-dialog').close();render();}
$$('[data-resolve]').forEach(button=>button.onclick=()=>resolveConflict(button.dataset.resolve));
$('#keep-both').onclick=()=>resolveConflict('both');
new ResizeObserver(()=>fit()).observe($('#stage'));
setup('single');
