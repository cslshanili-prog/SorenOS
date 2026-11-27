/**
 * 羈絆主動產出的雲端那條路（plans/bond-batch3.md 1.6、第 3d 批）：App 關著也會寫。
 * 契約在 utils/bond/outputCloudJob.ts，worker 側在 worker/amsg/src/bondOutputFire.ts。
 *
 * - 能不能交：這條線開了主動消息 2.0、主動消息那組 API 配得齊、這台 worker 認得 `bond-output`
 *   （`GET /config-check` 的 `backgroundJobKinds`；不認得就只在本機跑）。
 * - 每段關係一份 standing job（`bond-output:<bondId>`），每一種開著的類型一條每天到點的後台任務
 *   （時間落在投遞時段裡，bondOutputFireTime）；任務的 uuid 寫回 job，舊的（孤兒）任務到點看到對不上就跳過。
 * - 什麼時候重傳 job：這段關係改了（BOND_CHANGE_EVENT：寫了一份、你丟了紙條、改了設定…）、聊天有新訊息兩小時以上、
 *   一天沒刷、頁面要離開前（有新訊息就傳，讓雲端拿最新的）。
 * - 帳記在本機（localStorage）：哪段關係、哪一種、哪條任務、幾點、job 上次傳的時間。
 * - 結果回來（applyBondOutputResult，由 utils/amsgResults.ts 分派）：這一種在 job 快照之後本機寫過就丟掉，
 *   不然照本機那套收下（applyOutput），記起點、跳提示、打未讀。
 */
import type { APIConfig, BondOutputKind, CharacterProfile, UserProfile } from '../../types';
import { resolveSpace } from './space';
import { announceOutputDone, applyOutput, KIND_ANALYTICS, outputCandidates, prepareOutput } from './outputRun';
import { ActiveMsgClient } from '../../utils/activeMsgClient';
import { isAmsg2GlobalReady } from '../../utils/amsg2ToolBridge';
import { isAmsg2EnabledForChar } from '../../utils/amsg2Tasks';
import { buildCharChatCredRow } from '../../utils/amsgLlmCredentials';
import { cloudCharId } from '../../utils/amsgCloudLine';
import { withLineFields } from '../../utils/chatLine';
import { DB } from '../../utils/db';
import { EVENT_KINDS, markOutputDone, OUTPUT_KINDS, OUTPUT_LIMITS, resolveOutputChars, resolveOutputSetting, nextDueAt } from '../../utils/bond/output';
import { outputMaxTokens } from '../../utils/bond/outputPromptCore';
import { refreshBondRegistry, updateBond } from '../../utils/bond/store';
import { bondById } from '../../utils/bond/registry';
import { refreshBondEntryRegistry } from '../../utils/bond/entries';
import { refreshDiaryRegistry } from '../../utils/bond/diaryStore';
import {
    BOND_OUTPUT_KIND, BOND_OUTPUT_TEMPERATURE, BOND_OUTPUT_WISH_CAPABILITY, BOND_OUTPUT_LETTER_CAPABILITY, bondOutputFireTime, bondOutputJobId, bondOutputJobKey, buildBondOutputJob,
    nextFireLocal, parseBondOutputResult, type BondOutputJob, type BondOutputJobKind,
} from '../../utils/bond/outputCloudJob';
import { trackEvent } from '../../utils/analytics';
import type { AmsgResultContext } from '../../utils/amsgResults';

const HEADER = '💌 [BondOutput:雲端]';
const STORE_KEY = 'soren_bond_output_cloud_v1';
const HOUR = 3600_000;
/** job 多久沒刷就一定重傳（amsg:job 只活 3 天，每天刷一次就不會過期） */
const JOB_REFRESH_MS = 20 * HOUR;
/** 聊天有新訊息時，最快多久重傳一次（離開頁面時不等） */
const JOB_CHAT_REFRESH_MS = 2 * HOUR;
/** 結果晚到太多就不用了 */
const RESULT_MAX_AGE_MS = 3 * 24 * HOUR;

interface CloudTask { taskUuid: string; fireAt: string; tzId: string; maxTokens?: number }
interface CloudRecord { jobAt: number; tasks: Partial<Record<BondOutputKind, CloudTask>> }
type CloudStore = Record<string, CloudRecord>;

function readStore(): CloudStore {
    try {
        const raw = localStorage.getItem(STORE_KEY);
        const obj = raw ? JSON.parse(raw) : null;
        return obj && typeof obj === 'object' ? obj as CloudStore : {};
    } catch { return {}; }
}
function writeStore(store: CloudStore): void {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch { /* 存不了就下次重排 */ }
}

/** 這幾段關係交給雲端了沒（設定頁顯示用） */
export function bondOutputCloudKinds(bondId: string): BondOutputKind[] {
    return Object.keys(readStore()[bondId]?.tasks || {}) as BondOutputKind[];
}

const dirty = new Set<string>();
/** 這幾段關係改了：下一輪重傳 job（OSContext 聽 BOND_CHANGE_EVENT 時呼叫） */
export function markBondOutputCloudDirty(ids: string[]): void {
    for (const id of ids) dirty.add(id);
}

export type BondOutputCloudGate = 'ok' | 'off' | 'no-api' | 'no-worker' | 'unsupported' | 'unknown';

const credRowFor = (view: CharacterProfile, apiConfig: APIConfig) =>
    buildCharChatCredRow({ id: cloudCharId(view) }, view.activeMsg2Config, apiConfig);

/** 這條線能不能交給雲端 */
export async function bondOutputCloudGate(view: CharacterProfile, apiConfig: APIConfig): Promise<BondOutputCloudGate> {
    if (!isAmsg2EnabledForChar(view)) return 'off';
    if (!credRowFor(view, apiConfig)) return 'no-api';
    if (!await isAmsg2GlobalReady()) return 'no-worker';
    const kind = await ActiveMsgClient.probeBackgroundJobKind(BOND_OUTPUT_KIND);
    return kind === 'supported' ? 'ok' : kind;
}

const deviceTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

let syncing = false;

/**
 * 對一次帳：該排的排、該取消的取消、該重傳的重傳。頁面開著時跟本機 tick 一起跑；`leaving` 是頁面要藏起來了。
 */
export async function syncBondOutputCloud(scope: { characters: CharacterProfile[]; userProfileBase: UserProfile; apiConfig: APIConfig }, opts: { leaving?: boolean } = {}): Promise<void> {
    if (syncing) return;
    syncing = true;
    try {
        const now = Date.now();
        const store = readStore();
        const cands = await outputCandidates(scope.characters, scope.userProfileBase, now);
        const chars = scope.characters.filter(c => !c.altOf).map(c => withLineFields(scope.userProfileBase, c));
        const seen = new Set<string>();
        const tz = deviceTz();
        for (const cand of cands) {
            seen.add(cand.bondId);
            const rec: CloudRecord = store[cand.bondId] || { jobAt: 0, tasks: {} };
            const space = resolveSpace(cand.bondId, chars, scope.userProfileBase, () => true);
            if (!space || space.kind !== 'persona' || !space.view || !space.user) continue;
            const gate = cand.eligible ? await bondOutputCloudGate(space.view, scope.apiConfig) : 'off';
            if (gate === 'unknown') continue; // 問不到：這一輪不動（手上的任務可能還在跑）
            // 每一種：幾點到點、輸出上限（照篇幅算；改了篇幅要重排任務，上限是排任務時定的）
            const wanted = new Map<BondOutputKind, { fireAt: string; maxTokens: number }>();
            // 「願望」是第 4 批加的：舊 worker 不認得這一種，就只在本機寫
            const wishOk = gate === 'ok' && await ActiveMsgClient.probeBackgroundJobKind(BOND_OUTPUT_WISH_CAPABILITY) === 'supported';
            // 「信」是第 5 批加的，同上
            const letterOk = gate === 'ok' && await ActiveMsgClient.probeBackgroundJobKind(BOND_OUTPUT_LETTER_CAPABILITY) === 'supported';
            if (gate === 'ok') {
                for (const kind of OUTPUT_KINDS) {
                    if (kind === 'wish' && !wishOk) continue;
                    if (kind === 'letter' && !letterOk) continue;
                    const own = space.bond.output?.[kind];
                    const setting = resolveOutputSetting(space.bond, kind);
                    const on = own && typeof own.enabled === 'boolean' ? own.enabled : setting.enabled && cand.recentlyActive;
                    if (on) wanted.set(kind, {
                        fireAt: bondOutputFireTime(cand.bondId, kind, setting.window),
                        maxTokens: outputMaxTokens(resolveOutputChars(space.bond, kind), kind === 'essay' || kind === 'letter' ? 2000 : 1500),
                    });
                }
            }
            // 不要的、時間變了的：取消
            let changed = false;
            for (const kind of Object.keys(rec.tasks) as BondOutputKind[]) {
                const t = rec.tasks[kind]!;
                const w = wanted.get(kind);
                if (w && w.fireAt === t.fireAt && w.maxTokens === t.maxTokens && t.tzId === tz) continue;
                await ActiveMsgClient.cancelTask(t.taskUuid).catch(e => console.warn(HEADER, '取消任務失敗（可能已經沒了）', e));
                delete rec.tasks[kind];
                changed = true;
            }
            if (!wanted.size) {
                if (rec.jobAt) await ActiveMsgClient.clearBackgroundJobInput(bondOutputJobKey(cand.bondId)).catch(() => {});
                delete store[cand.bondId];
                writeStore(store);
                continue;
            }
            const missing = [...wanted.keys()].filter(k => !rec.tasks[k]);
            const needJob = changed || missing.length > 0 || dirty.has(cand.bondId)
                || now - rec.jobAt > JOB_REFRESH_MS
                || (cand.lastMessageAt > rec.jobAt && (opts.leaving || now - rec.jobAt > JOB_CHAT_REFRESH_MS));
            if (!needJob) continue;
            dirty.delete(cand.bondId);
            try {
                const job = await buildJob(space, [...wanted.keys()], rec, tz);
                const credRow = credRowFor(space.view, scope.apiConfig)!;
                for (const kind of missing) {
                    const { fireAt, maxTokens } = wanted.get(kind)!;
                    const { uuid } = await ActiveMsgClient.scheduleBackgroundJob({
                        kind: BOND_OUTPUT_KIND, charId: cloudCharId(space.view), charName: space.view.name,
                        jobKey: bondOutputJobKey(cand.bondId), jobId: bondOutputJobId(cand.bondId, kind), jobInput: job, credRow,
                        temperature: BOND_OUTPUT_TEMPERATURE, maxTokens,
                        recurring: { firstSendTime: nextFireLocal(tz, fireAt, Date.now()), recurrenceType: 'daily', tzId: tz },
                    });
                    rec.tasks[kind] = { taskUuid: uuid, fireAt, tzId: tz, maxTokens };
                    if (job.kinds[kind]) job.kinds[kind]!.taskUuid = uuid;
                    console.log(`${HEADER} ${space.view.name} 的${kind}排好了：每天 ${fireAt}（任務 ${uuid}）`);
                }
                await ActiveMsgClient.putBackgroundJobInput(bondOutputJobKey(cand.bondId), job);
                rec.jobAt = job.refreshedAt;
                store[cand.bondId] = rec;
                writeStore(store);
            } catch (e) {
                console.warn(HEADER, `${space.view.name} 的雲端產出沒排成，這輪先只在本機跑`, e);
                dirty.add(cand.bondId);
                store[cand.bondId] = rec;
                writeStore(store);
            }
        }
        // 關係沒了（刪角色、刪身份卡）：任務一起取消
        for (const bondId of Object.keys(store)) {
            if (seen.has(bondId)) continue;
            for (const t of Object.values(store[bondId].tasks)) await ActiveMsgClient.cancelTask(t!.taskUuid).catch(() => {});
            await ActiveMsgClient.clearBackgroundJobInput(bondOutputJobKey(bondId)).catch(() => {});
            delete store[bondId];
            writeStore(store);
        }
    } finally {
        syncing = false;
    }
}

/** 組這段關係的 standing job（每一種用本機那套 prepareOutput 組提示詞） */
async function buildJob(space: NonNullable<ReturnType<typeof resolveSpace>>, kinds: BondOutputKind[], rec: CloudRecord, tz: string): Promise<BondOutputJob> {
    const out: BondOutputJob['kinds'] = {};
    let system = '';
    let lock = '';
    for (const kind of kinds) {
        const prep = await prepareOutput(space, kind);
        if (!prep) continue; // 隨筆沒有可挑的事：這一種這輪不寫（任務留著，下次刷新有了就寫）
        system = prep.system;
        lock = prep.lock;
        const setting = resolveOutputSetting(space.bond, kind);
        const k: BondOutputJobKind = {
            dueAt: nextDueAt(space.bond, kind),
            everyDays: setting.everyDays,
            ...(setting.window ? { window: setting.window } : {}),
            ...(setting.pausedUntil ? { pausedUntil: setting.pausedUntil } : {}),
            withNotice: prep.withNotice,
            ...(rec.tasks[kind] ? { taskUuid: rec.tasks[kind]!.taskUuid } : {}),
            ...(prep.prompt ? { prompt: prep.prompt } : {}),
            ...(prep.diary ? { diary: prep.diary } : {}),
            ...(prep.replyTo ? { replyTo: prep.replyTo } : {}),
            ...(prep.tags ? { tags: prep.tags } : {}),
            ...(prep.candidateKeys ? { candidateKeys: prep.candidateKeys } : {}),
        };
        out[kind] = k;
    }
    return buildBondOutputJob({
        bondId: space.id, charId: space.char.id, charName: space.view!.name, tzId: tz, refreshedAt: Date.now(),
        system, lock, limits: OUTPUT_LIMITS, kinds: out,
    });
}

/** 關掉雲端（例如主動消息 2.0 整個關了）：全部取消 */
export async function cancelAllBondOutputCloud(): Promise<void> {
    const store = readStore();
    for (const [bondId, rec] of Object.entries(store)) {
        for (const t of Object.values(rec.tasks)) await ActiveMsgClient.cancelTask(t!.taskUuid).catch(() => {});
        await ActiveMsgClient.clearBackgroundJobInput(bondOutputJobKey(bondId)).catch(() => {});
    }
    writeStore({});
}

// ─── 收件 ─────────────────────────────────────────

/** 消化一條 `bond-output` 結果；回 true＝可以銷帳 */
export async function applyBondOutputResult(payload: unknown, context?: AmsgResultContext): Promise<boolean> {
    const r = parseBondOutputResult(payload);
    if (!r) {
        console.warn(HEADER, '結果形狀認不出來，丟棄', payload);
        return true;
    }
    const at = context?.createdAt || r.generatedAt || Date.now();
    if (Date.now() - at > RESULT_MAX_AGE_MS) {
        console.warn(HEADER, `結果太舊（${r.bondId} ${r.kind}），丟棄`);
        return true;
    }
    const [characters, saved] = await Promise.all([DB.getAllCharacters(), DB.getUserProfile().catch(() => null)]);
    // 沒存過個人資料的人，OSContext 用的也是這份預設（只有名字會用到）
    const profile: UserProfile = saved || { name: 'User', avatar: '', bio: '' };
    // 開機補收時登記表可能還沒讀好：對帳要看最新的起點、日記、紙條
    await Promise.all([refreshBondRegistry(), refreshBondEntryRegistry(), refreshDiaryRegistry(characters)]);
    const bond = bondById(r.bondId);
    const last = bond?.outputLast?.[r.kind];
    if (last && last > r.jobRefreshedAt) {
        console.log(HEADER, `${r.bondId} 的${r.kind}本機已經寫過了，雲端這份不收`);
        return true;
    }
    const chars = characters.filter(c => !c.altOf).map(c => withLineFields(profile, c));
    const space = resolveSpace(r.bondId, chars, profile, () => true);
    if (!space || space.kind !== 'persona' || !space.view || !space.user) {
        console.warn(HEADER, `找不到 ${r.bondId}（角色或身份卡刪了？），丟棄`);
        return true;
    }
    try {
        const done = await applyOutput(space, r.kind, r.raw, { dateKey: r.dateKey, replyTo: r.replyTo, tags: r.tags, candidateKeys: r.candidateKeys });
        const fromEvent = (bond?.outputEvents || []).some(e => e.at > (last || 0) && e.at <= r.generatedAt && EVENT_KINDS[r.kind].includes(e.kind));
        await updateBond(r.bondId, b => markOutputDone(b, r.kind, r.generatedAt || Date.now()));
        if (done) {
            trackEvent('主动产出完成', { 类型: KIND_ANALYTICS[r.kind], 来源: '云端', 触发: fromEvent ? '事件' : '保底' });
            announceOutputDone(done);
        }
    } catch (e) {
        // 解析不出來重試也一樣：銷帳
        console.warn(HEADER, `${r.bondId} 的${r.kind}收不下來，丟棄`, e);
    }
    return true;
}
