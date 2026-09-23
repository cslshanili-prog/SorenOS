import React, { useEffect, useState } from 'react';
import Modal from '../os/Modal';
import { useOS } from '../../context/OSContext';
import { generateVapidKeyPair } from '../../utils/vapidGen';
import { loadPushVapid, savePushVapid, clearPushVapid } from '../../utils/pushVapid';
import { trackEvent } from '../../utils/analytics';

interface PushVapidSettingsModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * 推送憑據 (VAPID) 配置面板.
 *
 * 這對密鑰是主動消息 2.0 Worker 籤推送用的: 一鍵部署時自動沿用, 手動部署時照著填進
 * Worker env. 整個站點只有一個 pushManager 訂閱, 所以它放在設置頂層當全局推送憑據管.
 *
 * 私鑰也存 localStorage 方便複製到 CF Worker env, 這裡不當成一次性密鑰處理.
 */
export const PushVapidSettingsModal: React.FC<PushVapidSettingsModalProps> = ({ open, onClose }) => {
  const { addToast } = useOS();

  const [publicKey, setPublicKey] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [showPrivateKey, setShowPrivateKey] = useState(false);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    if (!open) return;
    const v = loadPushVapid();
    setPublicKey(v.vapidPublicKey);
    setPrivateKey(v.vapidPrivateKey);
    setShowPrivateKey(false);
  }, [open]);

  const persist = (pub: string, priv: string) => {
    savePushVapid({ vapidPublicKey: pub, vapidPrivateKey: priv });
  };

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const kp = await generateVapidKeyPair();
      setPublicKey(kp.publicKey);
      setPrivateKey(kp.privateKey);
      persist(kp.publicKey, kp.privateKey);
      setShowPrivateKey(true);
      addToast('已生成新的 VAPID 密鑰對', 'success');
      // 只報「這次生成成沒成」。不帶「之前配沒配過」——那等於上報憑據配置狀態。
      trackEvent('生成 VAPID 密钥对', { result: 'success' });
    } catch (e) {
      const err = e as { message?: string } | null;
      addToast(err?.message ?? '生成失敗', 'error');
      // 只報「失敗了」這一件事：報錯原文可能帶路徑，留在 toast / console 裡就夠。
      trackEvent('生成 VAPID 密钥对', { result: 'error' });
    } finally {
      setGenerating(false);
    }
  };

  const handleClear = () => {
    if (!confirm('確定清空 VAPID 密鑰對？之後重新部署的 Worker 會換成新的一對，推送訂閱需要重建。')) {
      trackEvent('清空 VAPID 密钥对', { confirmed: false });
      return;
    }
    trackEvent('清空 VAPID 密钥对', { confirmed: true });
    clearPushVapid();
    setPublicKey('');
    setPrivateKey('');
    addToast('VAPID 已清空', 'success');
  };

  const handleCopyPublicKey = async () => {
    if (!publicKey) return;
    await navigator.clipboard.writeText(publicKey);
    addToast('公鑰已複製', 'success');
    trackEvent('复制 VAPID 公钥');
  };

  const handleCopyPrivateKey = async () => {
    if (!privateKey) {
      addToast('私鑰尚未生成', 'error');
      return;
    }
    await navigator.clipboard.writeText(privateKey);
    addToast('私鑰已複製', 'success');
    trackEvent('复制 VAPID 私钥');
  };

  const handleCopyEnv = async () => {
    let pub = publicKey.trim();
    let priv = privateKey.trim();
    if (!pub || !priv) {
      await handleGenerate();
      const v = loadPushVapid();
      pub = v.vapidPublicKey;
      priv = v.vapidPrivateKey;
      if (!pub || !priv) return;
    }
    const lines = [
      `VAPID_PUBLIC_KEY=${pub}`,
      `VAPID_PRIVATE_KEY=${priv}`,
      `# 可選：`,
      `# VAPID_EMAIL=mailto:you@example.com`,
    ];
    await navigator.clipboard.writeText(lines.join('\n'));
    addToast('env 已複製（含真實密鑰）', 'success');
    trackEvent('复制 Worker env 清单');
  };

  const handleSave = () => {
    persist(publicKey.trim(), privateKey.trim());
    addToast('推送憑據已保存', 'success');
    onClose();
  };

  const maskedPrivateKey = privateKey
    ? privateKey.slice(0, 4) + '•'.repeat(Math.max(8, privateKey.length - 8)) + privateKey.slice(-4)
    : '';

  return (
    <Modal
      isOpen={open}
      title="推送憑據 (VAPID)"
      onClose={onClose}
      footer={
        <div className="flex gap-2 w-full">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl text-sm"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="flex-1 py-3 bg-indigo-500 text-white font-bold rounded-2xl shadow-lg shadow-indigo-200 text-sm"
          >
            保存
          </button>
        </div>
      }
    >
      <div className="space-y-5 text-sm">

        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-3 text-[11px] text-amber-800 leading-relaxed">
          <p className="font-bold mb-1">⚠ 一份 VAPID, 兩個用法</p>
          <p>
            瀏覽器訂閱 push 用<b>公鑰</b>; Worker 簽名 push 用<b>私鑰</b>.
            主動消息 2.0 部署 Worker 時<b>用的就是這一對</b> ——
            Worker 上的公鑰和瀏覽器訂閱綁的不一致時, 推送會被 403 拒掉.
          </p>
          <p className="mt-1">
            生成 / 改了之後, 你的 CF Worker env (<code>VAPID_PUBLIC_KEY</code> + <code>VAPID_PRIVATE_KEY</code>) 也要同步更新, 否則簽名校驗會失敗.
          </p>
        </div>

        {/* 公鑰 */}
        <div className="bg-slate-50 rounded-2xl p-4 space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-[11px] text-slate-500 font-medium">VAPID 公鑰</label>
            {publicKey && (
              <button
                type="button"
                onClick={() => void handleCopyPublicKey()}
                className="text-[11px] text-slate-500 hover:text-slate-700 font-medium"
              >
                複製
              </button>
            )}
          </div>
          <input
            type="text"
            value={publicKey}
            onChange={(e) => setPublicKey(e.target.value)}
            placeholder="BA…（點下方「生成新密鑰對」自動生成）"
            className="w-full text-[11px] font-mono bg-white border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:border-indigo-400"
          />
        </div>

        {/* 私鑰 */}
        <div className="bg-slate-50 rounded-2xl p-4 space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-[11px] text-slate-500 font-medium">VAPID 私鑰</label>
            <div className="flex items-center gap-3">
              {privateKey && (
                <>
                  <button
                    type="button"
                    onClick={() => setShowPrivateKey((s) => !s)}
                    className="text-[11px] text-slate-500 hover:text-slate-700 font-medium"
                  >
                    {showPrivateKey ? '隱藏' : '顯示'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleCopyPrivateKey()}
                    className="text-[11px] text-indigo-500 hover:text-indigo-600 font-medium"
                  >
                    複製
                  </button>
                </>
              )}
            </div>
          </div>
          {showPrivateKey ? (
            <textarea
              value={privateKey}
              onChange={(e) => setPrivateKey(e.target.value)}
              rows={3}
              placeholder="點下方「生成新密鑰對」自動生成"
              className="w-full font-mono text-[11px] bg-white border border-slate-200 rounded-xl p-2 resize-none leading-relaxed focus:outline-none focus:border-indigo-400"
            />
          ) : (
            <div className="w-full text-[11px] font-mono bg-white border border-slate-200 rounded-xl px-3 py-2 text-slate-500 select-none break-all">
              {maskedPrivateKey || '尚未生成'}
            </div>
          )}
          <p className="text-[10px] text-slate-400 leading-relaxed">
            私鑰常駐 localStorage 方便複製到 Worker env. 本機數據已經夠多 secret, 多這一個不改變威脅模型.
          </p>
        </div>

        {/* 操作 */}
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => void handleGenerate()}
            disabled={generating}
            className={`py-2.5 rounded-xl text-[11px] font-bold ${generating ? 'bg-slate-200 text-slate-400' : 'bg-indigo-500 text-white hover:bg-indigo-600'}`}
          >
            {generating ? '生成中…' : (publicKey ? '🔄 重新生成密鑰對' : '生成新密鑰對')}
          </button>
          <button
            type="button"
            onClick={() => void handleCopyEnv()}
            disabled={generating}
            className={`py-2.5 rounded-xl text-[11px] font-bold border border-slate-200 ${generating ? 'bg-slate-100 text-slate-400' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
          >
            複製 env 清單
          </button>
        </div>

        {(publicKey || privateKey) && (
          <div className="text-center">
            <button
              type="button"
              onClick={handleClear}
              className="text-[11px] text-rose-500 hover:text-rose-600 font-medium underline-offset-2 hover:underline"
            >
              清空 VAPID（重新部署後推送訂閱要重建）
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
};
