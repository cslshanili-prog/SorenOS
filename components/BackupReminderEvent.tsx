/**
 * BackupReminderEvent.tsx
 * 「該備份啦」提醒彈窗。
 *
 * 糯米機是 local-first：所有數據只躺在你這台設備的瀏覽器裡，沒有云端副本。
 * 隔一段時間（默認 7 天，可在設置裡改 1~30 天）沒導出，就溫柔彈一次提醒。
 *
 * 顯隱判定在 utils/backupReminder.ts；這裡只管長得好看 + 兩個出口：
 *  - 去備份：跳到「設置 → 備份與恢復」
 *  - 知道了：記一次提醒時間，進入冷卻，下個間隔到了才會再彈
 */

import React from 'react';
import { daysSinceLastBackup, getBackupReminderState } from '../utils/backupReminder';

interface BackupReminderPopupProps {
    /** 「知道了 / 稍後」——外層會 markBackupReminderShown 並關閉 */
    onDismiss: () => void;
    /** 「去備份」——外層跳設置備份區並關閉 */
    onGoBackup: () => void;
}

export const BackupReminderPopup: React.FC<BackupReminderPopupProps> = ({ onDismiss, onGoBackup }) => {
    const days = daysSinceLastBackup();
    const interval = getBackupReminderState().intervalDays;
    // 頂部那句"多久沒備份了"——從未備份 vs 已過 N 天，說人話。
    const gapLine = days == null
        ? '你還沒有導出過備份'
        : `距離上次備份已經過去 ${days} 天`;

    return (
        <div className="fixed inset-0 z-[9998] flex items-center justify-center p-5 animate-fade-in">
            <div className="absolute inset-0 bg-black/60 backdrop-blur-md" onClick={onDismiss} />
            <div className="relative w-full max-w-sm bg-white/95 backdrop-blur-xl rounded-[2.5rem] shadow-2xl border border-white/30 overflow-hidden animate-slide-up">
                {/* 頂部漸變頭圖 + 盾牌圖標 */}
                <div className="relative pt-8 pb-5 px-6 text-center bg-gradient-to-br from-rose-400 via-orange-300 to-amber-300">
                    <div className="w-16 h-16 mx-auto mb-3 rounded-3xl bg-white/25 backdrop-blur-sm flex items-center justify-center ring-1 ring-white/40 shadow-lg">
                        <svg viewBox="0 0 24 24" fill="none" className="w-9 h-9 text-white" aria-hidden="true">
                            <path d="M12 2.5 5 5.2v5.3c0 4.2 2.9 8.1 7 9.2 4.1-1.1 7-5 7-9.2V5.2L12 2.5Z"
                                stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
                            <path d="m9.2 12 2 2 3.6-3.8" stroke="currentColor" strokeWidth="1.7"
                                strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                    </div>
                    <h2 className="text-xl font-extrabold text-white drop-shadow-sm">該備份啦</h2>
                    <p className="text-[12px] text-white/90 mt-1 font-medium">{gapLine}</p>
                </div>

                {/* 正文 */}
                <div className="px-6 pt-5 pb-2 space-y-3">
                    <div className="bg-gradient-to-br from-rose-50 to-orange-50 border border-rose-100 rounded-2xl p-4 space-y-2.5">
                        <p className="text-[13px] text-slate-700 leading-relaxed">
                            <strong>您本週沒有進行備份，請注意。</strong>
                        </p>
                        <p className="text-[12.5px] text-slate-600 leading-relaxed">
                            糯米機的數據完全掌握在<strong className="text-rose-500">您自己手中</strong>——
                            角色、聊天記錄、記憶、設置全都只存在這台設備的瀏覽器裡，我們看不到、也幫不了你找回。
                        </p>
                        <p className="text-[12.5px] text-slate-600 leading-relaxed">
                            一旦清理瀏覽器緩存、卸載重裝、換手機，或者遇到系統抽風，
                            <strong className="text-rose-500">沒有備份就意味著這些全部丟失，無法恢復</strong>。
                        </p>
                        <p className="text-[12px] text-slate-500 leading-relaxed">
                            請養成定期導出的習慣，把 ZIP 存到網盤 / 電腦 / 雲備份，給自己留條後路 💛
                        </p>
                    </div>
                    <p className="text-[10.5px] text-slate-400 text-center leading-relaxed">
                        當前每 {interval} 天提醒一次，可在「設置 → 備份與恢復」裡調整頻率
                    </p>
                </div>

                {/* 按鈕 */}
                <div className="px-6 pb-7 pt-3 space-y-2">
                    <button
                        onClick={onGoBackup}
                        className="w-full py-3.5 font-bold rounded-2xl text-sm text-white bg-gradient-to-r from-rose-500 to-orange-500 shadow-lg shadow-rose-200 active:scale-95 transition-transform"
                    >
                        立即備份
                    </button>
                    <button
                        onClick={onDismiss}
                        className="w-full py-2.5 text-slate-400 font-medium text-[12px] active:scale-95 transition-transform"
                    >
                        知道了，稍後再說
                    </button>
                </div>
            </div>
        </div>
    );
};

interface BackupReminderControllerProps {
    onDismiss: () => void;
    onGoBackup: () => void;
}

export const BackupReminderController: React.FC<BackupReminderControllerProps> = (props) => {
    return <BackupReminderPopup {...props} />;
};
