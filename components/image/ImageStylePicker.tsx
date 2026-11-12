import React from 'react';
import type { CharacterProfile, ImageFeature, ImageGenApiConfig } from '../../types';
import { describeDefaultPick, STYLE_NONE } from '../../utils/imageStyle';
import { getRegisteredCharacter, getWorldStyleId } from '../../utils/charNameRegistry';

export interface ImageStylePick {
    /** 空字串＝照設定（角色 > 世界 > 各處畫風 > 全域） */
    styleId: string;
    /** 空字串＝照畫風偏好的那組／全域 */
    apiId: string;
}

export const EMPTY_PICK: ImageStylePick = { styleId: '', apiId: '' };

/** 給 generateImage 的選項（空字串不送） */
export const pickOptions = (pick: ImageStylePick | undefined) => ({
    ...(pick?.styleId ? { styleId: pick.styleId } : {}),
    ...(pick?.apiId ? { apiId: pick.apiId } : {}),
});

/**
 * 生圖地方的臨時下拉（plans/image-style-presets.md 第 c 步）：這一次用哪套畫風、哪組 API。
 * 第一個選項寫「照設定」會用到什麼，沒動就跟以前一樣；API 只有一組時不顯示那一格。
 */
const ImageStylePicker: React.FC<{
    config: ImageGenApiConfig | undefined;
    feature: ImageFeature;
    char?: Pick<CharacterProfile, 'groupId' | 'altOf' | 'imageGenCharConfig'> | null;
    value: ImageStylePick;
    onChange: (pick: ImageStylePick) => void;
    className?: string;
}> = ({ config, feature, char, value, onChange, className }) => {
    const styles = config?.stylePresets || [];
    const apis = config?.apiPresets || [];
    const owner = char?.altOf ? getRegisteredCharacter<CharacterProfile>(char.altOf) : undefined;
    const def = describeDefaultPick(config, { feature, char, owner, worldStyleOf: getWorldStyleId });
    const field = 'min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-2.5 py-2 text-[12px] text-slate-600 outline-none';
    return (
        <div className={`flex flex-wrap gap-2 ${className || ''}`}>
            <select aria-label="這次的畫風" value={value.styleId} onChange={e => onChange({ ...value, styleId: e.target.value })} className={field}>
                <option value="">畫風：照設定（{def.styleName}）</option>
                <option value={STYLE_NONE}>畫風：這次不套</option>
                {styles.map(st => <option key={st.id} value={st.id}>畫風：{st.name}</option>)}
            </select>
            {apis.length > 1 && (
                <select aria-label="這次用哪組 API" value={value.apiId} onChange={e => onChange({ ...value, apiId: e.target.value })} className={field}>
                    <option value="">API：照設定{def.apiName ? `（${def.apiName}）` : ''}</option>
                    {apis.map(a => <option key={a.id} value={a.id}>API：{a.name || a.model}</option>)}
                </select>
            )}
        </div>
    );
};

export default ImageStylePicker;
