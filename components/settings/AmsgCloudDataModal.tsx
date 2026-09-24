/**
 * 雲端數據清點。
 *
 * 在這之前，用戶對自己那台 worker 只有兩個動作：整個清空，或者什麼都不管。而云端按
 * 角色堆著定時任務、完整的角色上下文（角色卡加最近 30 條對話原文）和幾行 API 憑據，
 * 本地刪過角色、導過別人的備份、在另一台設備上清過一輪，都會留下再沒人認領的那一份，
 * 角色命名空間在 worker 側又沒有 TTL——不主動看一眼，永遠不知道它在那兒。
 *
 * 這個界面只做兩件事：把雲端有什麼列出來，以及清掉用戶親手勾中的那些。
 *
 * **不自動清。** 「孤兒」的判據是「本地沒有這個角色」，而同一台 worker 可能被兩台設備
 * 共用——這台眼裡的孤兒正是另一台正在用的角色。所以默認勾選只是省幾下點擊，真正動手
 * 的永遠是用戶自己那一下。
 */

import React, { useCallback, useEffect, useState } from 'react';
import Modal from '../os/Modal';
import ConfirmDialog from '../os/ConfirmDialog';
import type { CharacterProfile } from '../../types';
import { purgeCloudCharById } from '../../utils/amsg2CharCleanup';
import {
  collectCloudInventory,
  formatCloudSize,
  type CloudCharEntry,
  type CloudInventory,
} from '../../utils/amsgCloudInventory';
import { readDetachedWorkers } from '../../utils/amsgDetachedWorkers';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  characters: CharacterProfile[];
  addToast: (message: string, type?: 'success' | 'error' | 'info') => void;
}

const shortCharId = (charId: string) => charId.replace(/^char-/, '').slice(-8);

/** 一行角色在雲端佔了些什麼，拼成一句話。 */
const describeEntry = (entry: CloudCharEntry): string => {
  const parts: string[] = [];
  if (entry.taskCount > 0) parts.push(`${entry.taskCount} 個定時任務`);
  if (entry.instantCount > 0) parts.push(`${entry.instantCount} 輪對話進行中`);
  if (entry.state) {
    parts.push(entry.state.entryCount > 0
      ? `上下文 ${formatCloudSize(entry.state.byteSize)}`
      : '沒有上下文');
  }
  if (entry.credPurposes.length > 0) parts.push(`${entry.credPurposes.length} 行 API 憑據`);
  return parts.length > 0 ? parts.join(' · ') : '沒有佔用';
};

const CharRow: React.FC<{
  entry: CloudCharEntry;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}> = ({ entry, checked, disabled, onToggle }) => (
  <button
    type="button"
    onClick={onToggle}
    disabled={disabled}
    className={`w-full flex items-start gap-3 rounded-2xl border p-3 text-left transition-colors disabled:opacity-60 ${
      checked ? 'border-rose-200 bg-rose-50' : 'border-slate-200 bg-white'
    }`}
  >
    <span
      className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-bold ${
        checked ? 'border-rose-400 bg-rose-500 text-white' : 'border-slate-300 bg-white text-transparent'
      }`}
      aria-hidden
    >
      ✓
    </span>
    <span className="min-w-0 flex-1">
      <span className="block truncate text-sm font-bold text-slate-700">
        {entry.local ? entry.local.name : `已刪除的角色 ${shortCharId(entry.charId)}`}
      </span>
      <span className="mt-0.5 block text-xs text-slate-500">{describeEntry(entry)}</span>
    </span>
  </button>
);

const AmsgCloudDataModal: React.FC<Props> = ({ isOpen, onClose, characters, addToast }) => {
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [inventory, setInventory] = useState<CloudInventory | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [purging, setPurging] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [detached, setDetached] = useState<string[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const next = await collectCloudInventory(characters);
      setInventory(next);
      // 孤兒默認勾上（它們是這個界面存在的理由），還在用的角色一個都不預選——
      // 清掉在用角色的上下文雖然能自愈，但那是用戶要自己權衡的事。
      setSelected(new Set(next.orphans.map((entry) => entry.charId)));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
      setInventory(null);
    } finally {
      setLoading(false);
    }
  }, [characters]);

  // 只在打開那一刻拉一次：命名空間清單要在 worker 上按用戶掃一遍 client_state，
  // 做成自動刷新就是白掃 D1。用戶想重看有「重新清點」。
  useEffect(() => {
    if (!isOpen) return;
    setDetached(readDetachedWorkers().map((record) => record.url));
    void load();
  }, [isOpen, load]);

  const toggle = (charId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(charId)) next.delete(charId);
      else next.add(charId);
      return next;
    });
  };

  const selectedLiveCount = inventory
    ? inventory.live.filter((entry) => selected.has(entry.charId)).length
    : 0;

  const runPurge = async () => {
    setConfirmOpen(false);
    setPurging(true);
    let cleared = 0;
    const failed: string[] = [];
    try {
      for (const charId of selected) {
        const result = await purgeCloudCharById(charId);
        if (result.status === 'failed') failed.push(charId);
        else cleared += 1;
      }
      if (failed.length > 0) {
        addToast(`清掉了 ${cleared} 個，還有 ${failed.length} 個沒清成，可以再試一次。`, 'error');
      } else {
        addToast(`已清掉 ${cleared} 個角色在雲端的數據。`, 'success');
      }
      await load();
    } finally {
      setPurging(false);
    }
  };

  const busy = loading || purging;

  return (
    <>
      <Modal
        isOpen={isOpen}
        title="雲端數據"
        onClose={onClose}
        footer={
          <div className="flex w-full gap-2">
            <button
              onClick={onClose}
              disabled={purging}
              className="flex-1 rounded-2xl bg-slate-100 py-3 font-bold text-slate-600 disabled:opacity-50"
            >
              關閉
            </button>
            <button
              onClick={() => setConfirmOpen(true)}
              disabled={busy || selected.size === 0}
              className="flex-1 rounded-2xl bg-rose-500 py-3 font-bold text-white shadow-lg shadow-rose-200 disabled:opacity-40"
            >
              {purging ? '清理中…' : `清理選中 (${selected.size})`}
            </button>
          </div>
        }
      >
        <div className="space-y-4">
          {loading && (
            <p className="py-6 text-center text-sm text-slate-400">正在問雲端要清單…</p>
          )}

          {!loading && loadError && (
            <div className="space-y-2 rounded-2xl border border-rose-100 bg-rose-50 p-4">
              <p className="text-sm font-bold text-rose-600">讀不到雲端清單</p>
              <p className="text-xs text-rose-500 break-all">{loadError}</p>
              <button
                onClick={() => void load()}
                className="w-full rounded-xl bg-white py-2 text-sm font-bold text-rose-600"
              >
                再試一次
              </button>
            </div>
          )}

          {!loading && inventory && (
            <>
              {inventory.orphans.length > 0 && (
                <section className="space-y-2">
                  <div className="flex items-baseline justify-between">
                    <h3 className="text-sm font-bold text-slate-700">本地已經沒有的角色</h3>
                    <span className="text-xs text-rose-500">{inventory.orphans.length} 個</span>
                  </div>
                  <p className="text-xs text-slate-500">
                    這些角色在本地找不到了，雲端那份再沒有人會刷新或清掉它。如果你在別的設備上還用著同一台
                    Worker，先確認那邊也不要了再清。
                  </p>
                  <div className="space-y-2">
                    {inventory.orphans.map((entry) => (
                      <CharRow
                        key={entry.charId}
                        entry={entry}
                        checked={selected.has(entry.charId)}
                        disabled={busy}
                        onToggle={() => toggle(entry.charId)}
                      />
                    ))}
                  </div>
                </section>
              )}

              <section className="space-y-2">
                <div className="flex items-baseline justify-between">
                  <h3 className="text-sm font-bold text-slate-700">還在用的角色</h3>
                  <span className="text-xs text-slate-400">{inventory.live.length} 個</span>
                </div>
                {inventory.live.length === 0 ? (
                  <p className="text-xs text-slate-400">雲端還沒有這些角色的數據。</p>
                ) : (
                  <>
                    <p className="text-xs text-slate-500">
                      清掉只是丟掉雲端那份緩存，下次聊天或排程會重新傳一份。但 ta 名下已經排好的定時任務
                      到點會失敗一次，直到你再聊一輪把上下文補回去。
                    </p>
                    <div className="space-y-2">
                      {inventory.live.map((entry) => (
                        <CharRow
                          key={entry.charId}
                          entry={entry}
                          checked={selected.has(entry.charId)}
                          disabled={busy}
                          onToggle={() => toggle(entry.charId)}
                        />
                      ))}
                    </div>
                  </>
                )}
              </section>

              {inventory.globals.length > 0 && (
                <section className="space-y-2">
                  <h3 className="text-sm font-bold text-slate-700">不屬於某個角色的</h3>
                  <div className="rounded-2xl border border-slate-200 bg-white p-3">
                    {inventory.globals.map((item) => (
                      <div key={item.namespace} className="flex items-baseline justify-between py-0.5 text-xs">
                        <span className="truncate text-slate-600">{describeGlobalNamespace(item.namespace)}</span>
                        <span className="shrink-0 pl-2 text-slate-400">{formatCloudSize(item.usage.byteSize)}</span>
                      </div>
                    ))}
                  </div>
                  <p className="text-xs text-slate-400">
                    工具憑據、天氣熱搜緩存和後台活兒的一次性輸入。它們不按角色分，要清請用「清空雲端數據」。
                  </p>
                </section>
              )}

              {inventory.gaps.length > 0 && (
                <section className="space-y-1 rounded-2xl border border-amber-100 bg-amber-50 p-3">
                  <p className="text-xs font-bold text-amber-700">這份清單不是全集</p>
                  {inventory.gaps.map((gap) => (
                    <p key={gap.kind} className="text-xs text-amber-600">
                      {gapLabel(gap.kind)}：{gap.message}
                    </p>
                  ))}
                </section>
              )}

              {detached.length > 0 && (
                <section className="space-y-1 rounded-2xl border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs font-bold text-slate-600">你還斷開過這些 Worker</p>
                  {detached.map((url) => (
                    <p key={url} className="break-all text-xs text-slate-500">{url}</p>
                  ))}
                  <p className="text-xs text-slate-400">
                    斷開時沒有動那邊的數據。要清的話，把地址填回上面的配置裡，連上之後再來這一頁。
                  </p>
                </section>
              )}

              <button
                onClick={() => void load()}
                disabled={busy}
                className="w-full rounded-xl border border-slate-200 py-2 text-xs font-bold text-slate-500 disabled:opacity-50"
              >
                重新清點
              </button>
            </>
          )}
        </div>
      </Modal>

      <ConfirmDialog
        isOpen={confirmOpen}
        title="清掉這些角色的雲端數據"
        message={
          selectedLiveCount > 0
            ? `選中的 ${selected.size} 個裡有 ${selectedLiveCount} 個是還在用的角色。清掉之後它們的定時任務到點會失敗一次，直到你再跟 ta 聊一輪。確定繼續嗎？`
            : `將清掉這 ${selected.size} 個角色在雲端的上下文、API 憑據和定時任務。此操作不可撤銷。`
        }
        confirmText="清理"
        cancelText="取消"
        variant="danger"
        onConfirm={() => void runPurge()}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
};

const gapLabel = (kind: string): string => {
  if (kind === 'tasks') return '任務清單沒讀到';
  if (kind === 'credentials') return '憑據清單沒讀到';
  return '命名空間清單沒讀到';
};

/** 全局命名空間的人話名字；認不出來的就照原樣顯示。 */
const describeGlobalNamespace = (namespace: string): string => {
  if (namespace === 'amsg:global') return '工具憑據與實時世界緩存';
  if (namespace === 'amsg:job') return '後台活兒的一次性輸入';
  return namespace;
};

export default AmsgCloudDataModal;
