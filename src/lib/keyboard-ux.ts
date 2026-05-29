/**
 * Keyboard UX enhancements for comment/form pages.
 *
 * Two self-contained IIFE scripts injected via
 * `<script dangerouslySetInnerHTML={{ __html: ... }} />`:
 *
 *   - `ctrlEnterSubmitScript()` — Ctrl+Enter / Cmd+Enter submits the
 *     closest form from any focused <textarea>.
 *   - `codeBlockCopyScript()` — adds a "Copy" button to every
 *     `<pre><code>` block inside rendered markdown containers.
 */

/**
 * Returns an IIFE string that intercepts Ctrl+Enter (and Cmd+Enter on Mac)
 * on any <textarea> and submits its parent <form>.
 *
 * If the form has a primary submit button it is clicked (triggering any
 * formaction / validation logic); otherwise `form.submit()` is called as
 * a fallback.
 */
export function ctrlEnterSubmitScript(): string {
  return `(function(){
  try{
    document.addEventListener('keydown',function(e){
      if(!(e.ctrlKey||e.metaKey))return;
      if(e.key!=='Enter')return;
      var ta=e.target;
      if(!ta||ta.tagName!=='TEXTAREA')return;
      e.preventDefault();
      var form=ta.closest('form');
      if(!form)return;
      var submitBtn=form.querySelector('button[type="submit"],input[type="submit"]');
      if(submitBtn){submitBtn.click();}else{form.submit();}
    });
  }catch(ex){}
})();`;
}

/**
 * Returns an IIFE string that adds a floating "Copy" button to every
 * `<pre>` inside rendered markdown containers (.markdown-content,
 * .prs-comment-body, .prs-body, .issue-body, .iss-body, .markdown-body).
 *
 * The button is injected on DOMContentLoaded and re-checked whenever new
 * nodes are added via MutationObserver (for dynamically loaded content).
 *
 * Scoped CSS is injected once into <head>; a data attribute guards against
 * double-injection on the same <pre>.
 */
export function codeBlockCopyScript(): string {
  return `(function(){
  try{
    var _ccCss='.code-copy-btn{position:absolute;top:6px;right:6px;padding:3px 8px;font-size:11px;font-weight:600;border-radius:6px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.70);cursor:pointer;opacity:0;transition:opacity 120ms;}.pre:hover .code-copy-btn,.code-copy-btn:focus{opacity:1;}pre:hover .code-copy-btn,.code-copy-btn:focus{opacity:1;}.code-copy-btn.copied{color:#34d399;border-color:rgba(52,211,153,0.40);}.code-copy-wrap{position:relative;}';
    function injectCss(){if(document.getElementById('cc-style'))return;var s=document.createElement('style');s.id='cc-style';s.textContent=_ccCss;document.head.appendChild(s);}

    function addCopyButtons(){
      injectCss();
      var pres=document.querySelectorAll('.markdown-content pre,.prs-comment-body pre,.prs-body pre,.issue-body pre,.iss-body pre,.markdown-body pre');
      for(var i=0;i<pres.length;i++){
        var pre=pres[i];
        if(pre.getAttribute('data-copy-wired'))continue;
        pre.setAttribute('data-copy-wired','1');

        /* Wrap in a position:relative container if not already wrapped */
        var parent=pre.parentElement;
        var wrap;
        if(parent&&parent.classList&&parent.classList.contains('code-copy-wrap')){
          wrap=parent;
        }else{
          wrap=document.createElement('div');
          wrap.className='code-copy-wrap';
          parent.insertBefore(wrap,pre);
          wrap.appendChild(pre);
        }

        /* Build the copy button */
        var btn=document.createElement('button');
        btn.type='button';
        btn.className='code-copy-btn';
        btn.textContent='Copy';
        btn.setAttribute('aria-label','Copy code to clipboard');
        (function(b,p){
          b.addEventListener('click',function(){
            var text=p.textContent||'';
            if(!navigator.clipboard){
              /* Fallback for non-HTTPS or older browsers */
              try{
                var ta=document.createElement('textarea');
                ta.value=text;ta.style.position='fixed';ta.style.top='-9999px';
                document.body.appendChild(ta);ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
              }catch(er){return;}
              b.classList.add('copied');b.textContent='Copied!';
              setTimeout(function(){b.classList.remove('copied');b.textContent='Copy';},1500);
              return;
            }
            navigator.clipboard.writeText(text).then(function(){
              b.classList.add('copied');b.textContent='Copied!';
              setTimeout(function(){b.classList.remove('copied');b.textContent='Copy';},1500);
            }).catch(function(){});
          });
        })(btn,pre);

        wrap.appendChild(btn);
      }
    }

    if(document.readyState==='loading'){
      document.addEventListener('DOMContentLoaded',addCopyButtons);
    }else{
      addCopyButtons();
    }

    /* Watch for dynamically inserted markdown containers */
    if(typeof MutationObserver!=='undefined'){
      var obs=new MutationObserver(function(mutations){
        for(var m=0;m<mutations.length;m++){
          if(mutations[m].addedNodes&&mutations[m].addedNodes.length){
            addCopyButtons();
            break;
          }
        }
      });
      obs.observe(document.body,{childList:true,subtree:true});
    }
  }catch(ex){}
})();`;
}
