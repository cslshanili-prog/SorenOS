import React, { useEffect, useMemo } from 'react';
import { useOS } from '../context/OSContext';
import RealBalancePanel from '../components/bank/RealBalancePanel';
import { ensureRealBalanceState } from '../utils/realBalance';
import { buildUserOwnerContext } from '../utils/financeGenerate';

/**
 * 桌面「銀行」App（2026-10 取代存錢罐的咖啡館經營遊戲，見 plans/finance-wallet-design.md）。
 * 打開就是用戶自己的錢包，跟個人檔案「主頁」裡的 Real Balance 是同一份（userProfile.realBalance）。
 * 存錢罐的舊資料（DB 的 bank_* 表）原樣留在資料庫裡，只是沒有入口了。
 */
const BankApp: React.FC = () => {
    const { closeApp, userProfile, updateUserProfile, addToast, apiConfig } = useOS();
    const state = useMemo(() => ensureRealBalanceState(userProfile.realBalance), [userProfile.realBalance]);
    // 還沒建過錢包的人第一次打開才落庫，跟個人檔案那邊一樣
    useEffect(() => {
        if (!userProfile.realBalance) updateUserProfile({ realBalance: state });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [userProfile.realBalance]);

    return (
        <div className="h-full w-full bg-slate-50 flex flex-col animate-fade-in" style={{ paddingTop: 'var(--safe-top)' }}>
            <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar overscroll-contain" style={{ paddingBottom: 'var(--safe-bottom)' }}>
                <RealBalancePanel
                    state={state}
                    onCommit={next => updateUserProfile({ realBalance: next })}
                    onBack={closeApp}
                    addToast={addToast}
                    ai={{ ownerName: userProfile.name, system: () => buildUserOwnerContext(userProfile), api: apiConfig }}
                />
            </div>
        </div>
    );
};

export default BankApp;
