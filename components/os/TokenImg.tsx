import React from 'react';
import { useBlobRefUrl } from '../../utils/blobRef';

/**
 * 圖片改存 Blob 後的通用渲染組件（見 utils/blobRef.ts）。
 * 把「blobref 令牌 / 舊 data: / http(s)」統一解析成可直接用的 url 再餵給 <img>，
 * 令牌解析出的 objectURL 會在卸載 / value 變化時自動回收，不洩漏。
 * 非令牌值原樣透傳，行為與普通 <img> 一致。
 */
const TokenImg: React.FC<{ value?: string | null } & React.ImgHTMLAttributes<HTMLImageElement>> = ({ value, ...rest }) => {
    const src = useBlobRefUrl(value ?? undefined);
    return <img src={src} {...rest} />;
};

export default TokenImg;
