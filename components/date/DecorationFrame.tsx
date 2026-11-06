import React, { useEffect, useMemo, useRef, useState } from 'react';

// 預設美化正則產出的 HTML（文字標題、摘要卡片…）放進沙盒 iframe 顯示。
// sandbox 只給 allow-scripts、不給 allow-same-origin：裡面的腳本是匯入的第三方程式碼，
// 拿不到 Soren 的資料、IndexedDB、API Key。代價是 localStorage 在不透明來源裡一碰就拋錯，
// 這裡先塞一個記憶體版的替身（不跨卡片、不保存）。高度由裡面量好 postMessage 回來。

const STORAGE_SHIM = `<script>(function(){function mk(){var d={};return{getItem:function(k){return Object.prototype.hasOwnProperty.call(d,k)?d[k]:null},setItem:function(k,v){d[k]=String(v)},removeItem:function(k){delete d[k]},clear:function(){d={}},key:function(i){return Object.keys(d)[i]||null},get length(){return Object.keys(d).length}}}['localStorage','sessionStorage'].forEach(function(n){try{window[n].getItem('__probe')}catch(e){try{Object.defineProperty(window,n,{value:mk(),configurable:true})}catch(_){}}})})();</script>`;

// 量的是內容本身多高（body 和各子元素的底），不是 documentElement.scrollHeight——後者至少等於 iframe 自己的高度，
// 卡片只會長高、縮不回來，矮卡片下面就多一塊空白。
const RESIZE_SCRIPT = `<script>(function(){function measure(){var b=document.body;if(!b)return 0;var h=b.getBoundingClientRect().height;for(var i=0;i<b.children.length;i++){var el=b.children[i],cs=getComputedStyle(el);if(cs.position==='fixed')continue;var bottom=el.getBoundingClientRect().bottom+(parseFloat(cs.marginBottom)||0);if(bottom>h)h=bottom}return h}function post(){parent.postMessage({sorenDecorationHeight:measure()},'*')}try{var ro=new ResizeObserver(post);ro.observe(document.documentElement);if(document.body)ro.observe(document.body)}catch(e){}window.addEventListener('load',post);setTimeout(post,50);setTimeout(post,600);setTimeout(post,2000)})();</script>`;

const MAX_HEIGHT = 4000;

const buildSrcDoc = (html: string, light: boolean): string => {
    const base = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;padding:0;background:transparent;color:${light ? '#44403c' : '#e2e8f0'};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}*{box-sizing:border-box;}img{max-width:100%;}</style>${STORAGE_SHIM}`;
    const trimmed = html.trim();
    if (/^<!doctype|^<html/i.test(trimmed)) {
        // 完整文件：替身要搶在它自己的腳本之前跑，量高度的放最後
        const withHead = /<head[^>]*>/i.test(trimmed)
            ? trimmed.replace(/<head[^>]*>/i, match => `${match}${base}`)
            : trimmed.replace(/<html[^>]*>/i, match => `${match}<head>${base}</head>`);
        return /<\/body>/i.test(withHead) ? withHead.replace(/<\/body>/i, `${RESIZE_SCRIPT}</body>`) : `${withHead}${RESIZE_SCRIPT}`;
    }
    return `<!DOCTYPE html><html><head>${base}</head><body>${trimmed}${RESIZE_SCRIPT}</body></html>`;
};

const DecorationFrame: React.FC<{ html: string; light: boolean }> = ({ html, light }) => {
    const ref = useRef<HTMLIFrameElement>(null);
    const [height, setHeight] = useState(120);
    const srcDoc = useMemo(() => buildSrcDoc(html, light), [html, light]);

    useEffect(() => {
        const onMessage = (event: MessageEvent) => {
            if (event.source !== ref.current?.contentWindow) return;
            const next = Number(event.data?.sorenDecorationHeight);
            if (Number.isFinite(next) && next > 0) setHeight(Math.min(MAX_HEIGHT, Math.ceil(next)));
        };
        window.addEventListener('message', onMessage);
        return () => window.removeEventListener('message', onMessage);
    }, []);

    return (
        <iframe
            ref={ref}
            title="預設裝飾"
            className="date-decoration block w-full border-0 my-3"
            style={{ height }}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            srcDoc={srcDoc}
            onClick={(e) => e.stopPropagation()}
        />
    );
};

export default DecorationFrame;
