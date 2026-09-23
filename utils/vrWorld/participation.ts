import type { CharacterProfile, VRWorldCharState } from '../../types';
import { VR_DEFAULT_INTERVAL_MIN } from './constants';

/** 舊接入沿用自動設置；新接入默認等待用戶邀請。 */
export const joinVRState = (previous?: VRWorldCharState): VRWorldCharState => ({
    ...previous,
    enabled: true,
    activityMode: previous?.activityMode ?? (previous?.enabled ? 'scheduled' : 'manual'),
    intervalMinutes: previous?.intervalMinutes || VR_DEFAULT_INTERVAL_MIN,
});

export const allowsAutomaticVR = (state?: VRWorldCharState): boolean =>
    Boolean(state?.enabled && state.activityMode !== 'manual');

/** Connecting to Kanata alone does not place a character in SAR. */
export const isSARActivityOccupant = (char: Pick<CharacterProfile,'vrState'>): boolean => {
    const state=char.vrState;
    return !!state?.enabled&&state.currentRoom==='sar'&&
        ['cabinet','module-shop','fishing','market','garden'].includes(state.sarActivity||'');
};

/** 一輪生成期間用戶可能切換接入方式；保存活動結果不能恢復會話開始時的舊開關。 */
export const withLatestVRParticipation = (current: CharacterProfile, patch: Partial<CharacterProfile>): Partial<CharacterProfile> => {
    if (!patch.vrState) return patch;
    return {
        ...patch,
        vrState: {
            ...patch.vrState,
            title: current.vrState?.title,
            titleRevision: current.vrState?.titleRevision,
            novelReadingMode: current.vrState?.novelReadingMode,
            preferredNovelIds: current.vrState?.preferredNovelIds,
            preferredNovelCategoryIds: current.vrState?.preferredNovelCategoryIds,
            excludedAutoRooms: current.vrState?.excludedAutoRooms,
            excludedAutoSARActivities: current.vrState?.excludedAutoSARActivities,
            enabled: current.vrState?.enabled ?? false,
            activityMode: current.vrState?.activityMode,
            intervalMinutes: current.vrState?.intervalMinutes || VR_DEFAULT_INTERVAL_MIN,
        },
    };
};
