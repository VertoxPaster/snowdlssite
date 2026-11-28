// Иконки: подставляются по ТЕКСТУ заголовков, не зависят от классов script.js
(function(){
  var IC={"edit": "<svg class=\"gi gi-fill gi-f\" viewBox=\"0 0 24 24\" fill=\"currentColor\" stroke=\"none\" aria-hidden=\"true\"><path fill=\"currentColor\" d=\"M3 21v-4.25L16.2 3.575q.3-.275.663-.425t.762-.15t.775.15t.65.45L20.425 5q.3.275.438.65T21 6.4q0 .4-.137.763t-.438.662L7.25 21zM17.6 7.8L19 6.4L17.6 5l-1.4 1.4z\"/></svg>", "settings": "<svg class=\"gi gi-fill gi-f\" viewBox=\"0 0 24 24\" fill=\"currentColor\" stroke=\"none\" aria-hidden=\"true\"><path fill=\"currentColor\" d=\"m9.25 22l-.4-3.2q-.325-.125-.612-.3t-.563-.375L4.7 19.375l-2.75-4.75l2.575-1.95Q4.5 12.5 4.5 12.338v-.675q0-.163.025-.338L1.95 9.375l2.75-4.75l2.975 1.25q.275-.2.575-.375t.6-.3l.4-3.2h5.5l.4 3.2q.325.125.613.3t.562.375l2.975-1.25l2.75 4.75l-2.575 1.95q.025.175.025.338v.674q0 .163-.05.338l2.575 1.95l-2.75 4.75l-2.95-1.25q-.275.2-.575.375t-.6.3l-.4 3.2zm2.8-6.5q1.45 0 2.475-1.025T15.55 12t-1.025-2.475T12.05 8.5q-1.475 0-2.488 1.025T8.55 12t1.013 2.475T12.05 15.5\"/></svg>", "support": "<svg class=\"gi gi-fill gi-f\" viewBox=\"0 0 512 512\" fill=\"currentColor\" stroke=\"none\" aria-hidden=\"true\"><path fill=\"currentColor\" fill-rule=\"evenodd\" d=\"M422.401 217.174c-6.613-67.84-46.72-174.507-170.666-174.507c-123.947 0-164.054 106.667-170.667 174.507c-23.2 8.805-38.503 31.079-38.4 55.893v29.867c0 32.99 26.744 59.733 59.733 59.733c32.99 0 59.734-26.744 59.734-59.733v-29.867c-.108-24.279-14.848-46.095-37.334-55.253c4.267-39.254 25.174-132.48 126.934-132.48s122.453 93.226 126.72 132.48c-22.44 9.178-37.106 31.009-37.12 55.253v29.867a59.95 59.95 0 0 0 33.92 53.76c-8.96 16.853-31.787 39.68-87.894 46.506c-11.215-17.03-32.914-23.744-51.788-16.023c-18.873 7.72-29.646 27.717-25.71 47.725s21.48 34.432 41.872 34.432a42.67 42.67 0 0 0 37.973-23.68c91.52-10.454 120.747-57.6 129.92-85.334c24.817-8.039 41.508-31.301 41.173-57.386v-29.867c.103-24.814-15.2-47.088-38.4-55.893m-302.933 85.76c0 9.425-7.641 17.066-17.067 17.066s-17.066-7.64-17.066-17.066v-29.867a17.067 17.067 0 1 1 34.133 0zm264.533-29.867c0-9.426 7.641-17.067 17.067-17.067s17.067 7.641 17.067 17.067v29.867c0 9.425-7.641 17.066-17.067 17.066s-17.067-7.64-17.067-17.066z\"/></svg>", "shield": "<svg class=\"gi gi-fill gi-f\" viewBox=\"0 0 24 24\" fill=\"currentColor\" stroke=\"none\" aria-hidden=\"true\"><path fill=\"currentColor\" d=\"M12 22q-3.475-.875-5.738-3.988T4 11.1V5l8-3l8 3v6.1q0 3.8-2.262 6.913T12 22\"/></svg>", "buy": "<svg class=\"gi gi-fill gi-buy\" viewBox=\"0 0 48 48\" fill=\"currentColor\" stroke=\"none\" aria-hidden=\"true\"><defs><mask id=\"snBuyMask\"><g fill=\"none\" stroke-width=\"4\"><path fill=\"#fff\" fill-rule=\"evenodd\" stroke=\"#fff\" stroke-linejoin=\"round\" d=\"M6 15h36l-2 27H8z\" clip-rule=\"evenodd\"/><path stroke=\"#fff\" stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M16 19V6h16v13\"/><path stroke=\"#000\" stroke-linecap=\"round\" d=\"M16 34h16\"/></g></mask></defs><path fill=\"currentColor\" d=\"M0 0h48v48H0z\" mask=\"url(#snBuyMask)\"/></svg>"};
  function key(t){
    t=(t||'').replace(/\s+/g,' ').trim().toLowerCase();
    if(/^(настройки|settings|ayarlar|ustawienia|налаштування)$/.test(t)) return 'settings';
    if(/^(поддержка|support|підтримка|wsparcie|destek)$/.test(t)) return 'support';
    if(/^(обход античитов|anticheat bypass|обхід античіту|obejście antycheat|anti-hile bypass)$/.test(t)) return 'shield';
    if(/^(интерфейс|interface|інтерфейс|interfejs|arayüz)$/.test(t)) return 'edit';
    return null;
  }
  function slot(card){
    var el=card.querySelector('svg'); if(el) return el.parentNode===card?null:el.parentNode;
    var f=card.firstElementChild; if(f && !f.textContent.trim()) return f;
    return null;
  }
  function features(){
    var grid=document.getElementById('featuresGrid'); if(!grid) return;
    Array.prototype.forEach.call(grid.children,function(card){
      var tEl=Array.prototype.find.call(card.querySelectorAll('*'),function(e){return !e.children.length&&key(e.textContent);});
      if(!tEl) return; var k=key(tEl.textContent);
      // «Настройки»-карточка получает edit, остальные — по названию
      var name=(k==='settings')?'edit':(k==='edit'?'settings':k);
      var w=slot(card);
      if(!w){ w=document.createElement('div'); w.className='feature-icon-wrap'; card.insertBefore(w,card.firstChild); }
      if(w.getAttribute('data-ic')===name) return;
      w.innerHTML=IC[name]; w.setAttribute('data-ic',name);
    });
  }
  function buy(){
    document.querySelectorAll('a,button').forEach(function(b){
      if(b.querySelector('.gi-buy')) return;
      if(/^\s*(купить|buy|kup|купити|satın al)/i.test(b.textContent)) b.insertAdjacentHTML('afterbegin',IC.buy);
    });
  }
  function apply(){features();buy();}
  var t; function sched(){clearTimeout(t);t=setTimeout(apply,30);}
  new MutationObserver(sched).observe(document.documentElement,{childList:true,subtree:true});
  document.addEventListener('DOMContentLoaded',apply); apply();
})();