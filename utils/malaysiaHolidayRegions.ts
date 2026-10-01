/** Malaysia Holiday API codes mapped to ISO 3166-2 for portable user settings. */
export const MALAYSIA_HOLIDAY_REGIONS = [
    { sourceCode: 'JHR', code: 'MY-01', name: '柔佛', english: 'Johor' },
    { sourceCode: 'KDH', code: 'MY-02', name: '吉打', english: 'Kedah' },
    { sourceCode: 'KTN', code: 'MY-03', name: '吉蘭丹', english: 'Kelantan' },
    { sourceCode: 'MLK', code: 'MY-04', name: '馬六甲', english: 'Melaka' },
    { sourceCode: 'NSN', code: 'MY-05', name: '森美蘭', english: 'Negeri Sembilan' },
    { sourceCode: 'PHG', code: 'MY-06', name: '彭亨', english: 'Pahang' },
    { sourceCode: 'PNG', code: 'MY-07', name: '檳城', english: 'Pulau Pinang' },
    { sourceCode: 'PRK', code: 'MY-08', name: '霹靂', english: 'Perak' },
    { sourceCode: 'PLS', code: 'MY-09', name: '玻璃市', english: 'Perlis' },
    { sourceCode: 'SGR', code: 'MY-10', name: '雪蘭莪', english: 'Selangor' },
    { sourceCode: 'TRG', code: 'MY-11', name: '登嘉樓', english: 'Terengganu' },
    { sourceCode: 'SBH', code: 'MY-12', name: '沙巴', english: 'Sabah' },
    { sourceCode: 'SWK', code: 'MY-13', name: '砂拉越', english: 'Sarawak' },
    { sourceCode: 'KUL', code: 'MY-14', name: '吉隆坡', english: 'Kuala Lumpur' },
    { sourceCode: 'LBN', code: 'MY-15', name: '納閩', english: 'Labuan' },
    { sourceCode: 'PJY', code: 'MY-16', name: '布城', english: 'Putrajaya' },
] as const;

export const malaysiaHolidayRegion = (code: string) => MALAYSIA_HOLIDAY_REGIONS.find(r => r.code === code);
