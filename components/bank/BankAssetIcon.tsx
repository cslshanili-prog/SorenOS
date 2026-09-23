import React from 'react';
import { isImageValue } from '../../utils/blobRef';
import TokenImg from '../os/TokenImg';

/**
 * 銀行資產圖標的值是「一張圖」還是「一段直接顯示的文字（emoji）」。
 * 判斷本身收口在 utils/blobRef 的 isImageValue（認 blobref 令牌 / data: / http(s) / 站內路徑），
 * 這裡只保留名字，方便 BankDollhouse 等調用方照舊引用。
 */
export const isBankAssetUrl = (value?: string | null): value is string => isImageValue(value);

interface BankAssetIconProps {
    value?: string | null;
    alt?: string;
    imgClassName: string;
    textClassName: string;
}

const BankAssetIcon: React.FC<BankAssetIconProps> = ({
    value,
    alt = '',
    imgClassName,
    textClassName,
}) => {
    if (!value) return null;

    if (isBankAssetUrl(value)) {
        return <TokenImg value={value} alt={alt} className={imgClassName} draggable={false} />;
    }

    return <span className={textClassName}>{value}</span>;
};

export default BankAssetIcon;
