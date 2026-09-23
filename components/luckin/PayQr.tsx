import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/**
 * 瑞幸支付二維碼
 *
 * createOrder 返回:
 *  - payOrderUrl: weixin://wxpay/bizpayurl?pr=xxx  (微信支付 code-url, 掃碼即付)
 *  - payOrderQrCodeUrl: https://.../transfer/qrcode?token=xxx (瑞幸託管的二維碼鏈接)
 *
 * 瀏覽器裡點 weixin:// 拉不起微信, 所以這裡**本地把 payOrderUrl 生成二維碼**,
 * 用戶用微信掃一下就付了, 不用回瑞幸 app。
 * 兜底: 本地生成失敗時退回瑞幸官方託管二維碼圖; 移動端額外給一個"點我用微信打開"。
 */
const PayQr: React.FC<{ payUrl?: string; qrImageUrl?: string; size?: number }> = ({ payUrl, qrImageUrl, size = 168 }) => {
    const [dataUrl, setDataUrl] = useState<string>('');
    const [genFailed, setGenFailed] = useState(false);

    useEffect(() => {
        let cancelled = false;
        if (!payUrl) { setDataUrl(''); return; }
        QRCode.toDataURL(payUrl, { width: size * 2, margin: 1, errorCorrectionLevel: 'M' })
            .then((url) => { if (!cancelled) { setDataUrl(url); setGenFailed(false); } })
            .catch(() => { if (!cancelled) setGenFailed(true); });
        return () => { cancelled = true; };
    }, [payUrl, size]);

    // 優先本地生成的碼; 沒有 payUrl 或生成失敗時退回官方託管二維碼圖
    const imgSrc = (!genFailed && dataUrl) ? dataUrl : (qrImageUrl || '');
    if (!imgSrc) {
        // 實在沒碼: 退回一個跳轉鏈接 (移動端有效)
        if (payUrl || qrImageUrl) {
            return (
                <a href={payUrl || qrImageUrl} target="_blank" rel="noreferrer"
                    className="block text-center px-3 py-2 bg-[#0B1F3A] text-white text-[12px] font-bold rounded-xl active:scale-95">
                    去微信支付 →
                </a>
            );
        }
        return null;
    }

    return (
        <div className="flex flex-col items-center gap-1.5">
            <div className="bg-white p-2 rounded-xl border border-[#E6DFCF]" style={{ width: size + 16, height: size + 16 }}>
                <img src={imgSrc} alt="支付二維碼" className="w-full h-full object-contain" referrerPolicy="no-referrer"
                    onError={() => { if (dataUrl && imgSrc !== dataUrl) { /* already on fallback */ } else if (qrImageUrl) setGenFailed(true); }} />
            </div>
            <div className="text-[11px] text-[#0B1F3A]/70 font-bold">微信掃碼支付</div>
            {payUrl && (
                <a href={payUrl} target="_blank" rel="noreferrer" className="text-[10px] text-[#16386F] underline">手機上點這裡直接用微信打開</a>
            )}
        </div>
    );
};

export default PayQr;
