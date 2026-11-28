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
