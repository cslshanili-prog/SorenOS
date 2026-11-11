/**
 * 沙盒 iframe（sandbox="allow-scripts"、不給 allow-same-origin）共用的小墊片。
 * 不透明來源裡一碰 localStorage / sessionStorage 就拋錯，匯入的第三方程式碼常常一上來就讀，
 * 這裡塞一個記憶體版的替身（不跨 iframe、不保存）。見面的裝飾卡片、桌面的自訂小組件都用它。
 */
export const STORAGE_SHIM = `<script>(function(){function mk(){var d={};return{getItem:function(k){return Object.prototype.hasOwnProperty.call(d,k)?d[k]:null},setItem:function(k,v){d[k]=String(v)},removeItem:function(k){delete d[k]},clear:function(){d={}},key:function(i){return Object.keys(d)[i]||null},get length(){return Object.keys(d).length}}}['localStorage','sessionStorage'].forEach(function(n){try{window[n].getItem('__probe')}catch(e){try{Object.defineProperty(window,n,{value:mk(),configurable:true})}catch(_){}}})})();</script>`;

/**
 * 換內容的 srcdoc iframe 要整個換一個新的，不能改舊的 srcdoc 屬性：
 * 已經載入過的 iframe 改 srcdoc 是一次「導覽」，會在瀏覽器的上一頁歷史裡塞一筆。
 * 桌面小組件剛出現時會換好幾次內容（頭像、最後一則訊息陸續讀到），歷史就多了好幾筆，
 * 外殼的返回守衛（PhoneShell）按返回時跳進 iframe 的歷史，iOS 主螢幕 App 會打開一頁 about:srcdoc、退出後黑屏。
 * 新插進去的 iframe 第一次載入是取代、不進歷史，所以用這個當 React key：內容一變就換一個 iframe。
 */
let sandboxFrameSeq = 0;
export const nextSandboxFrameKey = () => ++sandboxFrameSeq;
