/* Language dropdown shared component
 * Usage: Add HTML below to page, include this JS file.
 * <div class="pp-langdrop" id="langDrop">
 *   <button class="pp-langdrop-btn" aria-label="Language">
 *     <svg class="ic"><use href="#i-globe"/></svg>
 *     <span class="pp-langdrop-cur">VI</span>
 *     <svg class="chev"><use href="#i-chevron-down"/></svg>
 *   </button>
 *   <div class="pp-langdrop-menu" role="listbox">
 *     <button class="pp-langdrop-item" data-lang="vi"><span class="code">VI</span><span class="name">Tiếng Việt</span></button>
 *     <button class="pp-langdrop-item" data-lang="en"><span class="code">EN</span><span class="name">English</span></button>
 *     <button class="pp-langdrop-item" data-lang="zh"><span class="code">中文</span><span class="name">中文</span></button>
 *     <button class="pp-langdrop-item" data-lang="ko"><span class="code">한국어</span><span class="name">한국어</span></button>
 *   </div>
 * </div>
 */
(function(){
  var LANGS = {vi:"VI", en:"EN", zh:"中文", ko:"한국어"};
  function getLang(){
    // Một key duy nhất "elab_uiLang", chuỗi thường (RULES.md 8).
    // Migrate bản cũ từng ghi JSON-quoted ("\"vi\"").
    try{
      var raw = localStorage.getItem("elab_uiLang");
      var l = (raw || "").replace(/"/g, "");
      if(l === "vi" || l === "en" || l === "zh" || l === "ko"){
        if(raw !== l) try{ localStorage.setItem("elab_uiLang", l); }catch(e){}
        return l;
      }
    }catch(e){}
    return "en";
  }
  function setLang(l){
    try{ localStorage.setItem("elab_uiLang", l); }catch(e){}
    // Update all dropdowns on page
    document.querySelectorAll(".pp-langdrop").forEach(function(drop){
      var cur = drop.querySelector(".pp-langdrop-cur");
      if(cur) cur.textContent = LANGS[l] || "VI";
      drop.querySelectorAll(".pp-langdrop-item").forEach(function(item){
        item.classList.toggle("active", item.getAttribute("data-lang")===l);
      });
    });
    // Update settings card labels (redesign 2026-10-13): card nằm ngoài .pp-langdrop
    document.querySelectorAll("#langCard .pp-langdrop-cur").forEach(function(cur){
      cur.textContent = LANGS[l] || "VI";
    });
    // Trigger page's i18n update if available
    if(window.__elabSetLang) { try{ window.__elabSetLang(l); }catch(e){} }
    // Dispatch custom event for pages listening
    try{ document.dispatchEvent(new CustomEvent("elab-lang-change", {detail:{lang:l}})); }catch(e){}
  }
  function init(){
    var lang = getLang();
    document.querySelectorAll(".pp-langdrop").forEach(function(drop){
      var btn = drop.querySelector(".pp-langdrop-btn");
      var cur = drop.querySelector(".pp-langdrop-cur");
      if(cur) cur.textContent = LANGS[lang] || "VI";
      drop.querySelectorAll(".pp-langdrop-item").forEach(function(item){
        var l = item.getAttribute("data-lang");
        item.classList.toggle("active", l===lang);
        item.addEventListener("click", function(e){
          e.stopPropagation();
          setLang(l);
          drop.classList.remove("open");
        });
      });
      if(btn){
        btn.addEventListener("click", function(e){
          e.stopPropagation();
          // Close other dropdowns
          document.querySelectorAll(".pp-langdrop.open").forEach(function(d){
            if(d!==drop) d.classList.remove("open");
          });
          drop.classList.toggle("open");
        });
      }
    });
    // Close on outside click
    document.addEventListener("click", function(){
      document.querySelectorAll(".pp-langdrop.open").forEach(function(d){
        d.classList.remove("open");
      });
    });
    // Close on Escape
    document.addEventListener("keydown", function(e){
      if(e.key==="Escape"){
        document.querySelectorAll(".pp-langdrop.open").forEach(function(d){
          d.classList.remove("open");
        });
      }
    });
  }
  if(document.readyState==="loading"){
    document.addEventListener("DOMContentLoaded", init);
  }else{
    init();
  }
  // Expose for manual use
  window.__ppLangDrop = {get:getLang, set:setLang, init:init};
})();
