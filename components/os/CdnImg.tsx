import React, { useMemo, useState, useEffect } from 'react';
import { assetMirrors, mirrorsForUrl } from '../../utils/assetUrl';

/**
 * <img>，但加載失敗會自動切到下一個 CDN 鏡像，全掛完才真的算失敗（見 utils/assetUrl.ts）。
 * 專治 jsDelivr 被牆 / raw.githubusercontent 全球慢導致的「看不到圖」。
 *
 * 用法二選一：
 *   · path：倉庫相對路徑（推薦），如 <CdnImg path="img/MOON.png" />
 *   · src ：完整素材 url（歷史寫死鏈接），會盡量反解成鏡像鏈；認不出就退化成普通 <img>
 */
type Props = { path?: string; src?: string } & Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'src'>;

const CdnImg: React.FC<Props> = ({ path, src, onError, ...rest }) => {
    const chain = useMemo(() => {
        if (path) return assetMirrors(path);
        if (src) return mirrorsForUrl(src);
        return [] as string[];
    }, [path, src]);

    const [idx, setIdx] = useState(0);
    useEffect(() => { setIdx(0); }, [chain[0]]); // 換圖時從主源重來

    return (
        <img
            src={chain[idx] ?? undefined}
            {...rest}
            onError={(e) => {
                if (idx < chain.length - 1) setIdx(idx + 1); // 還有鏡像 → 切下一個
                else onError?.(e);                            // 全掛完 → 交給調用方
            }}
        />
    );
};

export default CdnImg;
