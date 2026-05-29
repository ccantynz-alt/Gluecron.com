/**
 * Write/Preview tab toggle for Markdown comment textareas.
 *
 * Upgrades every `<textarea data-md-preview>` on the page with a small
 * tab strip above it. "Write" shows the textarea, "Preview" replaces it
 * with a rendered HTML panel fetched from POST /api/markdown/preview.
 *
 * Call `markdownPreviewScript()` and inject into a `<script dangerouslySetInnerHTML>`.
 */

export function markdownPreviewScript(): string {
  return `(function(){
  var CSS=[
    '.mdpv-wrap{position:relative;}',
    '.mdpv-tabs{display:flex;gap:0;margin-bottom:0;border-bottom:1px solid var(--border,#30363d);}',
    '.mdpv-tab{padding:6px 14px;font-size:12.5px;font-weight:600;cursor:pointer;background:none;border:none;color:var(--text-muted,#8b949e);border-bottom:2px solid transparent;margin-bottom:-1px;transition:color 120ms;}',
    '.mdpv-tab:hover{color:var(--text,#e6edf3);}',
    '.mdpv-tab.is-active{color:var(--text,#e6edf3);border-bottom-color:var(--accent,#58a6ff);}',
    '.mdpv-preview{min-height:80px;padding:10px 12px;border:1px solid var(--border,#30363d);border-top:none;border-radius:0 0 8px 8px;background:var(--bg-secondary,#161b22);font-size:14px;line-height:1.6;color:var(--text,#e6edf3);overflow-x:auto;}',
    '.mdpv-preview-loading{opacity:0.5;font-style:italic;font-size:13px;}',
  ].join('');
  function injectStyle(){if(!document.getElementById('mdpv-style')){var s=document.createElement('style');s.id='mdpv-style';s.textContent=CSS;document.head.appendChild(s);}}
  function upgrade(ta){
    if(ta._mdpvDone)return;ta._mdpvDone=true;
    injectStyle();
    var parent=ta.parentElement;
    if(!parent)return;
    // Wrap textarea
    var wrap=document.createElement('div');wrap.className='mdpv-wrap';
    parent.insertBefore(wrap,ta);
    wrap.appendChild(ta);
    // Tab strip
    var tabs=document.createElement('div');tabs.className='mdpv-tabs';
    var writeTab=document.createElement('button');writeTab.type='button';writeTab.className='mdpv-tab is-active';writeTab.textContent='Write';
    var previewTab=document.createElement('button');previewTab.type='button';previewTab.className='mdpv-tab';previewTab.textContent='Preview';
    tabs.appendChild(writeTab);tabs.appendChild(previewTab);
    wrap.insertBefore(tabs,ta);
    // Preview panel
    var panel=document.createElement('div');panel.className='mdpv-preview';panel.style.display='none';
    wrap.appendChild(panel);
    // Switch to write
    writeTab.addEventListener('click',function(){
      writeTab.classList.add('is-active');previewTab.classList.remove('is-active');
      ta.style.display='';panel.style.display='none';
    });
    // Switch to preview
    previewTab.addEventListener('click',function(){
      previewTab.classList.add('is-active');writeTab.classList.remove('is-active');
      ta.style.display='none';panel.style.display='';
      panel.innerHTML='<span class="mdpv-preview-loading">Rendering…</span>';
      fetch('/api/markdown/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:ta.value})})
        .then(function(r){return r.json();})
        .then(function(d){panel.innerHTML=d.html||'<em style="opacity:.5">Nothing to preview</em>';})
        .catch(function(){panel.innerHTML='<em style="opacity:.5">Preview unavailable</em>';});
    });
  }
  function scan(){document.querySelectorAll('textarea[data-md-preview]').forEach(upgrade);}
  scan();
  var ob=new MutationObserver(function(){scan();});
  ob.observe(document.body,{childList:true,subtree:true});
})();`;
}
