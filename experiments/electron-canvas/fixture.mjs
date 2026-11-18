export const fixture = String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8"><title>实时网页测试</title>
<style>
:root { color-scheme:light; --amber-3:#fff7c2; --slate-12:#1c2024; --blue-9:#0090ff; }
* { box-sizing:border-box; }
html, body { margin:0; background:var(--amber-3); color:var(--slate-12); font:14px/1.8 system-ui,sans-serif; }
body { padding:24px; min-height:2600px; }
h1 { font-size:18px; margin:0 0 24px; }
a { color:var(--blue-9); }
#ticker { position:fixed; right:12px; top:12px; padding:3px 8px; background:var(--blue-9); color:white; font-variant-numeric:tabular-nums; }
#paint-target { position:fixed; right:10px; bottom:10px; width:100px; height:100px; background:var(--amber-3); }
#pulse { height:40px; }
</style></head><body>
<h1>实时网页测试</h1><a id="next" href="/fixture/next">打开下一页</a>
<p id="paragraph"></p><p>缩放与裁切保持正文排版和滚动位置。</p>
<div id="ticker"></div><div id="paint-target"><div id="pulse"></div></div>
<script>
document.querySelector('#paragraph').textContent='固定排版宽度验证，中文与 English words 混排。'.repeat(100);
window.probe={birth:crypto.randomUUID(),frames:0,resizes:[],initialWidth:innerWidth};
addEventListener('resize',()=>probe.resizes.push({width:innerWidth,height:innerHeight,scroll:scrollY}));
function tick(){probe.frames++;document.querySelector('#ticker').textContent=String(probe.frames);document.querySelector('#pulse').style.background=probe.frames%24<12?'#0090ff':'#46a758';requestAnimationFrame(tick)}tick();
if(location.pathname.endsWith('/next')) { document.title='第二个测试网页'; document.querySelector('h1').textContent='第二个测试网页'; }
</script></body></html>`;
