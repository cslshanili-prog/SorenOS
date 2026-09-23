import React from 'react';
import { Row, Toggle } from './ChatSettingsControls';
import { DELAYED_REPLY_MAX_MINUTES } from '../../utils/delayedReply';
import type { DelayedReplySettings } from '../../types';

const numberClass = 'w-20 rounded-xl bg-slate-50 border border-slate-200 px-3 py-2.5 text-center text-base text-slate-700 outline-none focus:border-primary/30 focus:bg-white';

/**
 * 聊天設定頁 Scenario 裡的「延遲自動回覆」：開關＋回覆時間範圍。只改草稿，存檔跟著「完成」。
 * 邏輯見 utils/delayedReply.ts。
 */
const DelayedReplySettingsPanel: React.FC<{
    value: DelayedReplySettings;
    onChange: (next: DelayedReplySettings) => void;
}> = ({ value, onChange }) => {
    const set = (patch: Partial<DelayedReplySettings>) => onChange({ ...value, ...patch });
    const toMinutes = (raw: string) => Math.min(DELAYED_REPLY_MAX_MINUTES, Math.max(0, Math.round(Number(raw) || 0)));

    return (
        <>
            <Row label="延遲自動回覆" hint="發完訊息不用按回覆鍵，TA 會在下面的時間內自己回。多快回看 TA 當下在忙什麼、你們是不是正聊得起勁">
                <Toggle on={value.enabled} onToggle={() => set({ enabled: !value.enabled })} label="延遲自動回覆" />
            </Row>
            {value.enabled && (
                <div className="px-5 py-4 space-y-2.5">
                    <div className="text-[15px] font-bold text-slate-800">回覆時間</div>
                    <div className="flex items-center gap-2.5 text-sm text-slate-600">
                        <input
                            type="number" inputMode="numeric" min={0} max={DELAYED_REPLY_MAX_MINUTES}
                            value={value.minMinutes}
                            onChange={e => set({ minMinutes: toMinutes(e.target.value) })}
                            aria-label="最短幾分鐘"
                            className={numberClass}
                        />
                        <span>到</span>
                        <input
                            type="number" inputMode="numeric" min={0} max={DELAYED_REPLY_MAX_MINUTES}
                            value={value.maxMinutes}
                            onChange={e => set({ maxMinutes: toMinutes(e.target.value) })}
                            aria-label="最長幾分鐘"
                            className={numberClass}
                        />
                        <span>分鐘內</span>
                    </div>
                    {value.maxMinutes < value.minMinutes && (
                        <p className="text-[10px] text-amber-600">最長比最短還短，存檔時會拉成一樣。</p>
                    )}
                    <p className="text-[10px] leading-relaxed text-slate-400">
                        手動按回覆鍵會直接回、不再等。離開聊天也照樣會回；App 被完全關掉的話，下次打開時補回。
                        在睡覺會拖到範圍的尾巴，在忙會在後半段，正聊著又沒事就回得快。開了這個，這個角色就不套用「輸入與發送」裡的 2 秒自動回覆。
                    </p>
                </div>
            )}
        </>
    );
};

export default DelayedReplySettingsPanel;
