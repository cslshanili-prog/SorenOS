import React, { useEffect, useState } from 'react';
import { CalendarCheck } from '@phosphor-icons/react';
import { browserHolidayCache, deviceTimeZone, HOLIDAY_COUNTRIES, holidayCountryName, loadHolidayCalendar, renderUserHoliday, type HolidayCalendar, type UserHolidayConfig } from '../../utils/userHolidays';
import { getLocalDateKey } from '../../utils/localDate';
import { MALAYSIA_HOLIDAY_REGIONS, malaysiaHolidayRegion } from '../../utils/malaysiaHolidayRegions';

// 台灣置頂，其餘照中文名排序
const countryOptions = HOLIDAY_COUNTRIES.map(c => ({ code: c.countryCode, name: c.name, label: holidayCountryName(c.countryCode) }))
    .sort((a, b) => (a.code === 'TW' ? -1 : b.code === 'TW' ? 1 : a.label.localeCompare(b.label, 'zh-TW')));

const SOURCE_NOTE: Record<string, string> = {
    TW: '台灣用人事行政總處「政府行政機關辦公日曆表」（含補假、補行上班），年度公布後才有資料。',
    CN: '中國的年度安排照國務院公告整理（含調休補班）。',
    MY: '馬來西亞用 Malaysia Holiday API 整理的政府公告，建議選州屬；只提醒資料源收錄的日期，不自己推算補假或臨時假。',
};

/** 設置 → 實時感知 → 節假日感知。說明見 docs/user-holidays.md。 */
export default function UserHolidaySettings({ value, onChange }: { value: UserHolidayConfig; onChange: (value: UserHolidayConfig) => void }) {
    const [calendar, setCalendar] = useState<HolidayCalendar | null>(null);
    const [loading, setLoading] = useState(false);
    const [search, setSearch] = useState('');
    useEffect(() => {
        let active = true;
        setCalendar(null);
        if (!value.enabled || !value.countryCode) { setLoading(false); return; }
        setLoading(true);
        loadHolidayCalendar(value.countryCode, new Date().getFullYear(), browserHolidayCache).then(data => {
            if (active) { setCalendar(data); setLoading(false); }
        }).catch(() => { if (active) setLoading(false); });
        return () => { active = false; };
    }, [value.enabled, value.countryCode]);

    const toggle = (enabled: boolean) => {
        // 第一次打開、設備又在台北時區，先幫忙選好台灣；選錯了照樣能改
        const guess = enabled && !value.countryCode && deviceTimeZone() === 'Asia/Taipei' ? 'TW' : value.countryCode;
        onChange({ ...value, enabled, countryCode: guess });
    };
    const regions = value.countryCode === 'MY' ? MALAYSIA_HOLIDAY_REGIONS.map(r => r.code)
        : [...new Set(calendar?.days.flatMap(d => d.regions || []) || [])].sort();
    const today = calendar ? renderUserHoliday(value, getLocalDateKey(new Date()), calendar.days, '你') : '';
    const needle = search.trim().toLowerCase();

    return (
        <div className="bg-amber-50/60 p-4 rounded-2xl space-y-3">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <CalendarCheck size={20} weight="fill" className="text-amber-600" />
                    <span className="text-sm font-bold text-amber-800">節假日感知</span>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                    <input type="checkbox" aria-label="開啟節假日感知" checked={value.enabled} onChange={e => toggle(e.target.checked)} className="sr-only peer" />
                    <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-amber-500"></div>
                </label>
            </div>
            <p className="text-[11px] text-amber-900/70 leading-relaxed">選你生活的國家／地區。遇到國定假日或補班日，角色會知道「你那邊今天放假／要補班」，私聊、見面、通話、主動消息都看得到；平常日子不多說一個字。</p>
            {value.enabled && (
                <div className="space-y-2">
                    <input aria-label="搜尋國家或地區" placeholder="搜尋國家／地區" value={search} onChange={e => setSearch(e.target.value)} className="w-full bg-white/80 border border-amber-200 rounded-xl px-3 py-2 text-sm" />
                    <select aria-label="生活所在國家或地區" value={value.countryCode} onChange={e => onChange({ ...value, countryCode: e.target.value, subdivisionCode: undefined })} className="w-full bg-white/80 border border-amber-200 rounded-xl px-3 py-2 text-sm">
                        <option value="">請選擇國家／地區</option>
                        {countryOptions
                            .filter(c => c.code === value.countryCode || !needle || c.label.toLowerCase().includes(needle) || c.name.toLowerCase().includes(needle) || c.code.toLowerCase().includes(needle))
                            .map(c => <option key={c.code} value={c.code}>{c.label}</option>)}
                    </select>
                    {regions.length > 0 && (
                        <label className="block space-y-1">
                            <span className="text-[10px] font-bold text-slate-400 block">{value.countryCode === 'MY' ? '州屬／聯邦直轄區（可選）' : '地區範圍（可選，ISO 地區代碼）'}</span>
                            <select aria-label="節假日地區範圍" value={value.subdivisionCode || ''} onChange={e => onChange({ ...value, subdivisionCode: e.target.value || undefined })} className="w-full bg-white/80 border border-amber-200 rounded-xl px-3 py-2 text-sm">
                                <option value="">只看全國性的假日</option>
                                {value.subdivisionCode && !regions.includes(value.subdivisionCode) && <option value={value.subdivisionCode}>{value.subdivisionCode}（已保存）</option>}
                                {regions.map(code => {
                                    const region = value.countryCode === 'MY' ? malaysiaHolidayRegion(code) : undefined;
                                    return <option key={code} value={code}>{region ? `${region.name} · ${region.english}` : code}</option>;
                                })}
                            </select>
                        </label>
                    )}
                    {value.countryCode && (
                        <div role="status" className="text-xs text-amber-900 leading-relaxed bg-white/60 rounded-xl px-3 py-2">
                            {loading ? '正在讀取今年的行事曆…' : calendar ? <>
                                <div className="font-bold">已載入 {calendar.year} 年行事曆</div>
                                <div className="mt-1">{today || '今天不是假日也不是補班日，不會多加提醒。'}</div>
                            </> : <div>暫時讀不到今年的資料（網路不通或還沒公布），不會亂猜放假安排。</div>}
                        </div>
                    )}
                    <p className="text-[10px] text-amber-900/60 leading-relaxed">
                        日期跟你的設備時區走（{deviceTimeZone()}），跟角色的時區分開。實際有沒有休息以你自己的日程和說法為準；角色關掉時間感知、見面用架空模式時不會收到。
                        {' '}{SOURCE_NOTE[value.countryCode] || '其他國家／地區用 Nager.Date；沒選地區時，只在部分地區放的假不算。'}
                    </p>
                </div>
            )}
        </div>
    );
}
