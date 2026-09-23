import React, { useEffect, useState } from 'react';
import Modal from '../os/Modal';
import {
  type AmsgPacingSettings,
  DEFAULT_MAX_ACTIVE_TASKS,
  DEFAULT_MAX_UNANSWERED_SENDS,
  DEFAULT_MIN_SEND_GAP_MINUTES,
  DEFAULT_RECURRING_STOP_AFTER,
  describeMinutes,
  MAX_ACTIVE_TASKS_CEILING,
  resolveAmsgLimits,
} from '../../utils/amsgLimits';

/**
 * 「主動頻率」：用戶給這個角色定的幾條上限（主動消息 2.0 面板裡點「調整」打開）。
 *
 * 單獨成一頁、自帶保存按鈕：這幾項跟「新建任務」那張表單不是一回事，擠在一起的話，
 * 底部按鈕只能是「新建任務」，改個上限就得順手建一條任務才存得下來。
 *
 * 文案只說「會怎樣」，不講實現：用戶要知道的是「到了上限會跳過、不補發」「你手動排的
 * 算不算」，不需要知道這些閘在哪一層攔。
 */

interface ActiveMsg2PacingModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** 當前保存著的設置（沒設的項 = 用默認值）。 */
  initial: AmsgPacingSettings;
  /** TA 現在排著的、每天/每週重複的消息有幾條（關掉「可以排重複的」時會一起取消）。 */
  selfRecurringTaskCount: number;
  /** 保存。返回 true 關掉這一頁；false 表示沒存成、留在原處（調用方負責提示）。 */
  onSubmit: (next: AmsgPacingSettings) => Promise<boolean>;
}

/** 下拉框的值：'' = 跟默認值走（存 undefined），其餘是數字的字符串。 */
type SelectValue = string;

const toSelect = (value: number | undefined): SelectValue => (value === undefined ? '' : String(value));
const fromSelect = (value: SelectValue): number | undefined => (value === '' ? undefined : Number(value));

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

const GAP_OPTIONS = [5, 10, 20, 30, 60, 120, 180];
const DAILY_CAP_OPTIONS = [1, 2, 3, 5, 8, 10, 15, 20, 30];

const selectClass = 'w-full bg-white border border-slate-200 rounded-2xl px-4 py-3 text-sm';

const Field: React.FC<{ label: string; hint: string; children: React.ReactNode; warning?: string | null }> = ({
  label, hint, children, warning,
}) => (
  <div>
    <div className="font-bold text-slate-700 text-sm mb-1.5 pl-1">{label}</div>
    {children}
    <p className="text-xs text-slate-400 mt-1.5 pl-1 leading-relaxed">{hint}</p>
    {warning ? <p className="text-xs text-amber-600 mt-1 pl-1 leading-relaxed">{warning}</p> : null}
  </div>
);

const Toggle: React.FC<{ on: boolean; onClick: () => void }> = ({ on, onClick }) => (
  <button
    onClick={onClick}
    className={`w-12 h-7 rounded-full transition-colors relative shrink-0 ${on ? 'bg-fuchsia-500' : 'bg-slate-200'}`}
  >
    <span className={`absolute top-0.5 left-0.5 w-6 h-6 bg-white rounded-full shadow transition-all duration-200 ${on ? 'translate-x-5' : 'translate-x-0'}`} />
  </button>
);

const ActiveMsg2PacingModal: React.FC<ActiveMsg2PacingModalProps> = ({
  isOpen, onClose, initial, selfRecurringTaskCount, onSubmit,
}) => {
  const [maxUnanswered, setMaxUnanswered] = useState<SelectValue>('');
  const [minGap, setMinGap] = useState<SelectValue>('');
  const [dailyCap, setDailyCap] = useState<SelectValue>('');
  const [recurringStop, setRecurringStop] = useState<SelectValue>('');
  const [maxTasks, setMaxTasks] = useState<SelectValue>('');
  const [allowRecurring, setAllowRecurring] = useState(false);
  const [allowForce, setAllowForce] = useState(false);
  const [saving, setSaving] = useState(false);

  // 每次打開都從保存值重新填：上次沒保存就關掉的改動不該留著。只認「打開」這一下：
  // initial 跟著角色配置走，這一頁開著時角色在聊天裡排了條任務，配置對象就換了一個，
  // 跟著它重填的話用戶正在改的幾項會被悄悄沖掉。
  useEffect(() => {
    if (!isOpen) return;
    const resolved = resolveAmsgLimits(initial);
    setMaxUnanswered(toSelect(initial.maxUnansweredSends));
    setMinGap(toSelect(initial.minSendGapMinutes));
    // 每日上限的 0 和「沒設」是同一個意思（不限），下拉里只留一個「不限」。
    setDailyCap(initial.dailySendCap ? String(initial.dailySendCap) : '');
    setRecurringStop(toSelect(initial.recurringStopAfter));
    setMaxTasks(toSelect(initial.maxActiveTasks));
    setAllowRecurring(resolved.allowSelfRecurring);
    setAllowForce(resolved.allowSelfForce);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const wasAllowingRecurring = resolveAmsgLimits(initial).allowSelfRecurring;
  const willCancelRecurring = wasAllowingRecurring && !allowRecurring && selfRecurringTaskCount > 0;

  const handleSave = async () => {
    setSaving(true);
    try {
      const closed = await onSubmit({
        maxUnansweredSends: fromSelect(maxUnanswered),
        minSendGapMinutes: fromSelect(minGap),
        dailySendCap: fromSelect(dailyCap),
        recurringStopAfter: fromSelect(recurringStop),
        maxActiveTasks: fromSelect(maxTasks),
        allowSelfRecurring: allowRecurring,
        allowSelfForce: allowForce,
      });
      if (closed) onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      title="主動頻率"
      onClose={onClose}
      footer={(
        <>
          <button onClick={onClose} className="flex-1 py-3 bg-slate-100 text-slate-500 font-bold rounded-2xl active:scale-95 transition-transform">
            取消
          </button>
          <button onClick={() => void handleSave()} disabled={saving} className="flex-1 py-3 bg-fuchsia-500 text-white font-bold rounded-2xl active:scale-95 transition-transform disabled:opacity-50">
            {saving ? '保存中...' : '保存'}
          </button>
        </>
      )}
    >
      <div className="space-y-5 text-sm text-slate-600">
        <p className="text-xs leading-relaxed text-slate-500">
          這裡管的是 TA 主動來找你的消息。你們正常聊天時 TA 的回覆不算在內。
        </p>

        <div className="space-y-4">
          <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block pl-1">多久找你一次</label>

          <Field
            label="你沒回時，最多連著發幾條"
            hint="TA 自己排的後續都算在裡面，你回一句就重新數。到了上限，TA 排的後續到點會直接跳過、不補發。你自己排的不受影響。想讓 TA 在你睡著時隔一陣報備一句的話，就調大些。"
            warning={maxUnanswered === '0' ? '選了不限，你不回的時候 TA 可以一直接著發，每一條都要消耗一次 API 額度。' : null}
          >
            <select value={maxUnanswered} onChange={(e) => setMaxUnanswered(e.target.value)} className={selectClass}>
              <option value="">默認（{DEFAULT_MAX_UNANSWERED_SENDS} 條）</option>
              {range(1, 10).map((n) => <option key={n} value={String(n)}>{n} 條</option>)}
              <option value="0">不限</option>
            </select>
          </Field>

          <Field
            label="兩條之間至少隔多久"
            hint="只管 TA 自己排的，免得一條接一條地刷屏。"
          >
            <select value={minGap} onChange={(e) => setMinGap(e.target.value)} className={selectClass}>
              <option value="">默認（{describeMinutes(DEFAULT_MIN_SEND_GAP_MINUTES)}）</option>
              {GAP_OPTIONS.map((m) => <option key={m} value={String(m)}>{describeMinutes(m)}</option>)}
              <option value="0">不限制</option>
            </select>
          </Field>

          <Field
            label="每天最多主動找你幾次"
            hint="你手動排的也算在內（寫好固定內容的那種不算）。到了上限，當天剩下的會跳過、不補發，第二天重新數。"
          >
            <select value={dailyCap} onChange={(e) => setDailyCap(e.target.value)} className={selectClass}>
              <option value="">不限（默認）</option>
              {DAILY_CAP_OPTIONS.map((n) => <option key={n} value={String(n)}>{n} 次</option>)}
            </select>
          </Field>

          <Field
            label="重複的消息，連續幾次沒回就先停"
            hint="對每天、每週重複的消息生效，你手動排的也算（寫好固定內容的那種不算）。停下以後，你回一句話它就會恢復。"
          >
            <select value={recurringStop} onChange={(e) => setRecurringStop(e.target.value)} className={selectClass}>
              <option value="">默認（{DEFAULT_RECURRING_STOP_AFTER} 次）</option>
              {range(1, 10).map((n) => <option key={n} value={String(n)}>{n} 次</option>)}
              <option value="0">不停</option>
            </select>
          </Field>

          <Field
            label="最多同時排著幾條"
            hint="你和 TA 排的共用這些名額。"
          >
            <select value={maxTasks} onChange={(e) => setMaxTasks(e.target.value)} className={selectClass}>
              <option value="">默認（{DEFAULT_MAX_ACTIVE_TASKS} 條）</option>
              {range(1, MAX_ACTIVE_TASKS_CEILING).map((n) => <option key={n} value={String(n)}>{n} 條</option>)}
            </select>
          </Field>
        </div>

        <div className="space-y-3 pt-1 border-t border-slate-100">
          <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block pl-1 pt-3">TA 自己能排什麼</label>

          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 pl-1">
              <div className="font-bold text-slate-700">可以排每天、每週重複的消息</div>
              <div className="text-xs text-slate-400 mt-1 leading-relaxed">關著時 TA 只能排一次性的。</div>
              {willCancelRecurring ? (
                <div className="text-xs text-amber-600 mt-1 leading-relaxed">
                  保存後，TA 現在排著的 {selfRecurringTaskCount} 條重複消息會一起取消。
                </div>
              ) : null}
            </div>
            <Toggle on={allowRecurring} onClick={() => setAllowRecurring(!allowRecurring)} />
          </div>

          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 pl-1">
              <div className="font-bold text-slate-700">可以排「到點必發」的消息</div>
              <div className="text-xs text-slate-400 mt-1 leading-relaxed">
                比如答應了 8 點叫你起床，到點你正好在跟 TA 聊天也照發。關著時，碰上這種情況 TA 會改成在聊天裡自然提起。
              </div>
            </div>
            <Toggle on={allowForce} onClick={() => setAllowForce(!allowForce)} />
          </div>
        </div>
      </div>
    </Modal>
  );
};

export default React.memo(ActiveMsg2PacingModal);
