import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CharacterProfile } from '../../types';
import { ORDINARY_ACTIVITIES, SAR_ACTIVITIES, rollSARActivity, sarActivityPool } from './activityChoices';
import { rollRoom } from './runSession';
import { VRScheduler } from './scheduler';
import { withLatestVRParticipation } from './participation';

const char=(state:Record<string,unknown>={}):CharacterProfile=>({id:'choices',vrState:{enabled:true,intervalMinutes:120,...state}} as CharacterProfile);
beforeEach(()=>{
    vi.stubGlobal('document',{visibilityState:'hidden',addEventListener(){},removeEventListener(){}});
    vi.stubGlobal('window',{addEventListener(){},removeEventListener(){}});
});
afterEach(()=>{VRScheduler.onTrigger(()=>{});vi.unstubAllGlobals();});

describe('自由活動排除',()=>{
    it('禁用普通房間後從候選池移除，而不是重新擲骰子補償',()=>{
        const c=char({excludedAutoRooms:['guestbook','gym','postoffice','sar']});
        for(let i=0;i<100;i++)expect(rollRoom(c,[],null,undefined,()=>i/100)).toBe('theater');
    });
    it('整間 SAR 禁用，連同全部子活動排除',()=>{
        const c=char({excludedAutoRooms:['sar']});
        expect(sarActivityPool(c,true)).toEqual([]);
        for(let i=0;i<100;i++)expect(rollRoom(c,[],null,undefined,()=>i/100)).not.toBe('sar');
    });
    it('只留某個 SAR 子活動，隨機值再大也不會落入禁用活動',()=>{
        for(const keep of SAR_ACTIVITIES){
            const c=char({excludedAutoSARActivities:SAR_ACTIVITIES.filter(a=>a.id!==keep.id).map(a=>a.id)});
            for(const random of [0,.2,.5,.9,1,NaN])expect(rollSARActivity(c,true,false,undefined,()=>random)).toBe(keep.id);
        }
    });
    it('只留箱庭但箱庭不可用時，SAR 不進入房間池',()=>{
        const c=char({excludedAutoSARActivities:SAR_ACTIVITIES.filter(a=>a.id!=='garden').map(a=>a.id)});
        expect(sarActivityPool(c,false)).toEqual([]);
        expect(rollRoom(c,[],null,undefined,()=>.999)).not.toBe('sar');
    });
    it('全部禁用返回 null，不回退且不消費隨機數',()=>{
        const c=char({excludedAutoRooms:[...ORDINARY_ACTIVITIES.map(a=>a.id),'sar']});
        const random=vi.fn(()=>.5);
        expect(rollRoom(c,[],null,undefined,random)).toBeNull();expect(random).not.toHaveBeenCalled();
        expect(rollSARActivity(c,true)).toBeNull();
    });
    it('手動指定可繞過限制，自動 forced 調用仍受約束',()=>{
        const c=char({excludedAutoRooms:['sar','gym'],excludedAutoSARActivities:['cabinet','module-shop']});
        expect(rollRoom(c,[],null,'gym',Math.random,{manual:true})).toBe('gym');
        expect(rollRoom(c,[],null,'gym',Math.random,{manual:false})).toBeNull();
        expect(rollRoom(c,[],null,'sar',Math.random,{manual:true})).toBe('sar');
        for(const a of SAR_ACTIVITIES)expect(rollSARActivity(c,false,true,a.id)).toBe(a.id);
        expect(rollSARActivity(c,true,false,'cabinet')).toBeNull();
    });
    it('舊檔未設置限制時保留原有 SAR 概率',()=>{
        const sample=(garden:boolean)=>Array.from({length:100},(_,i)=>rollSARActivity(char(),garden,false,undefined,()=>(i+.5)/100));
        for(const [id,count] of Object.entries({fishing:30,market:20,'module-shop':21,cabinet:29}))expect(sample(false).filter(a=>a===id)).toHaveLength(count);
        expect(sample(true).filter(a=>a==='garden')).toHaveLength(20);
        expect(sample(true).filter(a=>a==='module-shop')).toHaveLength(1);
    });
    it('未實現的空間和特別活動不進入普通隨機池',()=>{
        for(let i=0;i<100;i++)expect(['cafe','signal']).not.toContain(rollRoom(char(),[],null,undefined,()=>i/100));
    });
    it('活動落庫不覆蓋運行期間剛改的排除項',()=>{
        const latest=char({excludedAutoRooms:['sar'],excludedAutoSARActivities:['cabinet']});
        expect(withLatestVRParticipation(latest,{vrState:char().vrState}).vrState).toMatchObject({excludedAutoRooms:['sar'],excludedAutoSARActivities:['cabinet']});
    });
    it('手動子活動通過調度器完整傳遞，舊郵局參數位置保持不變',()=>{
        vi.stubGlobal('document',{visibilityState:'hidden',addEventListener(){},removeEventListener(){}});
        vi.stubGlobal('window',{addEventListener(){},removeEventListener(){}});
        const trigger=vi.fn();VRScheduler.onTrigger(trigger);
        VRScheduler.triggerNow('choices','sar',undefined,'module-shop');
        expect(trigger).toHaveBeenLastCalledWith('choices','sar',undefined,true,'module-shop');
        VRScheduler.triggerNow('choices','postoffice','letter-1');
        expect(trigger).toHaveBeenLastCalledWith('choices','postoffice','letter-1',true);
    });
});
