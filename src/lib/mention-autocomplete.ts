/**
 * @mention autocomplete for comment textareas.
 *
 * Injects a floating dropdown when the user types `@` followed by at least
 * one character. Fetches `/api/users/suggest?q=<prefix>` and renders up to
 * 8 matching usernames. Arrow-key navigation + Enter/Tab to select.
 *
 * Usage: call `mentionAutocompleteScript()` and inject the return value
 * into a `<script dangerouslySetInnerHTML={{ __html: ... }} />` tag inside
 * any page that has comment textareas. The script attaches itself to ALL
 * textareas on the page via event delegation.
 */

export function mentionAutocompleteScript(): string {
  return `(function(){
  var _mc_popup=null,_mc_ta=null,_mc_idx=0,_mc_items=[];
  var _mc_css=[
    '.mc-popup{position:fixed;z-index:9999;background:var(--bg-elevated,#1c2128);border:1px solid var(--border,#30363d);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.40);overflow:hidden;min-width:180px;max-width:280px;}',
    '.mc-item{display:flex;align-items:center;gap:8px;padding:8px 12px;font-size:13px;cursor:pointer;color:var(--text,#e6edf3);}',
    '.mc-item:hover,.mc-item.is-sel{background:var(--bg-hover,#21262d);}',
    '.mc-item-at{color:var(--text-muted,#8b949e);font-size:12px;}',
    '.mc-item-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;}',
  ].join('');
  function injectStyle(){if(!document.getElementById('mc-style')){var s=document.createElement('style');s.id='mc-style';s.textContent=_mc_css;document.head.appendChild(s);}}
  function getCaretCoords(ta){
    var mirror=document.createElement('div');
    var cs=getComputedStyle(ta);
    ['fontFamily','fontSize','fontWeight','letterSpacing','lineHeight','padding','border','boxSizing','whiteSpace','wordWrap','overflowWrap'].forEach(function(p){mirror.style[p]=cs[p];});
    mirror.style.position='absolute';mirror.style.top='-9999px';mirror.style.left='-9999px';mirror.style.width=ta.offsetWidth+'px';mirror.style.height='auto';
    var text=ta.value.slice(0,ta.selectionStart);
    mirror.textContent=text;
    var span=document.createElement('span');span.textContent='@';mirror.appendChild(span);
    document.body.appendChild(mirror);
    var r=ta.getBoundingClientRect();
    var rect=span.getBoundingClientRect();
    document.body.removeChild(mirror);
    return{top:rect.top,left:rect.left};
  }
  function showPopup(ta,items,atPos){
    injectStyle();hidePopup();
    if(!items.length)return;
    _mc_ta=ta;_mc_items=items;_mc_idx=0;
    _mc_popup=document.createElement('div');_mc_popup.className='mc-popup';
    items.forEach(function(u,i){
      var d=document.createElement('div');d.className='mc-item'+(i===0?' is-sel':'');
      d.innerHTML='<span class="mc-item-at">@</span><span class="mc-item-name">'+escHtml(u.username)+'</span>';
      d.addEventListener('mousedown',function(e){e.preventDefault();insertMention(u.username,atPos);});
      _mc_popup.appendChild(d);
    });
    var coords=getCaretCoords(ta);
    _mc_popup.style.top=(coords.top+20)+'px';
    _mc_popup.style.left=coords.left+'px';
    document.body.appendChild(_mc_popup);
  }
  function hidePopup(){if(_mc_popup){_mc_popup.remove();_mc_popup=null;}_mc_ta=null;_mc_items=[];_mc_idx=0;}
  function setSelection(i){_mc_idx=i;var els=_mc_popup?_mc_popup.querySelectorAll('.mc-item'):[];els.forEach(function(el,j){el.classList.toggle('is-sel',j===i);});}
  function insertMention(username,atPos){
    if(!_mc_ta)return;
    var val=_mc_ta.value;var before=val.slice(0,atPos);var after=val.slice(_mc_ta.selectionStart);
    var newVal=before+'@'+username+' '+after;
    _mc_ta.value=newVal;
    var pos=atPos+username.length+2;
    _mc_ta.setSelectionRange(pos,pos);
    hidePopup();
    _mc_ta.dispatchEvent(new Event('input',{bubbles:true}));
  }
  function escHtml(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
  var _mc_timer=null;
  document.addEventListener('input',function(e){
    var ta=e.target;
    if(ta.tagName!=='TEXTAREA')return;
    clearTimeout(_mc_timer);
    var val=ta.value;var pos=ta.selectionStart;
    var lastAt=val.lastIndexOf('@',pos-1);
    if(lastAt===-1){hidePopup();return;}
    var afterAt=val.slice(lastAt+1,pos);
    if(/\\s/.test(afterAt)||afterAt.length===0){hidePopup();return;}
    if(afterAt.length>20){hidePopup();return;}
    var atPos=lastAt;
    _mc_timer=setTimeout(function(){
      fetch('/api/users/suggest?q='+encodeURIComponent(afterAt)).then(function(r){return r.json();}).then(function(data){
        if(!ta.isConnected){hidePopup();return;}
        showPopup(ta,data.users||[],atPos);
      }).catch(function(){hidePopup();});
    },120);
  });
  document.addEventListener('keydown',function(e){
    if(!_mc_popup)return;
    if(e.key==='ArrowDown'){e.preventDefault();setSelection(Math.min(_mc_idx+1,_mc_items.length-1));}
    else if(e.key==='ArrowUp'){e.preventDefault();setSelection(Math.max(_mc_idx-1,0));}
    else if(e.key==='Enter'||e.key==='Tab'){
      if(_mc_popup){e.preventDefault();insertMention(_mc_items[_mc_idx].username,_mc_popup._atPos||0);
      // re-read atPos from last known
      var u=_mc_items[_mc_idx];if(u&&_mc_ta){var val=_mc_ta.value;var p=_mc_ta.selectionStart;var lastAt=val.lastIndexOf('@',p-1);insertMention(u.username,lastAt);}}
    }
    else if(e.key==='Escape'){hidePopup();}
  });
  document.addEventListener('click',function(e){if(_mc_popup&&!_mc_popup.contains(e.target))hidePopup();});
  document.addEventListener('blur',function(e){if(e.target.tagName==='TEXTAREA')setTimeout(function(){if(_mc_popup&&!_mc_popup.matches(':hover'))hidePopup();},150);},true);
})();`;
}
