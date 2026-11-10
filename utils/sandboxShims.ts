/**
 * 沙盒 iframe（sandbox="allow-scripts"、不給 allow-same-origin）共用的小墊片。
 * 不透明來源裡一碰 localStorage / sessionStorage 就拋錯，匯入的第三方程式碼常常一上來就讀，
 * 這裡塞一個記憶體版的替身（不跨 iframe、不保存）。見面的裝飾卡片、桌面的自訂小組件都用它。
 */
export const STORAGE_SHIM = `<script>(function(){function mk(){var d={};return{getItem:function(k){return Object.prototype.hasOwnProperty.call(d,k)?d[k]:null},setItem:function(k,v){d[k]=String(v)},removeItem:function(k){delete d[k]},clear:function(){d={}},key:function(i){return Object.keys(d)[i]||null},get length(){return Object.keys(d).length}}}['localStorage','sessionStorage'].forEach(function(n){try{window[n].getItem('__probe')}catch(e){try{Object.defineProperty(window,n,{value:mk(),configurable:true})}catch(_){}}})})();</script>`;
