# MiniMax T2A（HTTP）接入速記

> 來源：`https://platform.minimaxi.com/docs/api-reference/speech-t2a-http` 對應 OpenAPI。

## 1) 基礎接口

- 主地址：`https://api.minimaxi.com/v1/t2a_v2`
- 文檔提到備用地址：`https://api-bj.minimaxi.com/v1/t2a_v2`
- 音色查詢接口：`https://api.minimaxi.com/v1/get_voice`（查詢當前帳號可用 voice_id）
- 鑑權：`Authorization: Bearer <API_KEY>`
- `Content-Type: application/json`

## 2) 最小可用請求（非流式）

```bash
curl -X POST 'https://api.minimaxi.com/v1/t2a_v2' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <API_KEY>' \
  -d '{
    "model": "speech-2.8-hd",
    "text": "你好，歡迎使用 MiniMax 文本轉語音。",
    "stream": false,
    "voice_setting": {"voice_id": "male-qn-qingse"},
    "audio_setting": {"format": "mp3", "sample_rate": 32000, "bitrate": 128000, "channel": 1},
    "output_format": "url"
  }'
```

## 3) 關鍵字段

- 必填：`model`、`text`
- 常用：
  - `stream`：是否流式，默認 `false`
  - `voice_setting`：`voice_id/speed/vol/pitch/emotion`
  - `audio_setting`：`format/sample_rate/bitrate/channel`
  - `output_format`：`url` 或 `hex`（非流式可選，流式僅 hex）
- 文本上限：< 10000 字符；> 3000 時建議流式。

## 4) 返回值

- `data.audio`：音頻內容（hex 或 URL，取決於 `output_format`）
- `extra_info`：時長、採樣率、bitrate、計費字符數等
- `base_resp.status_code`：業務狀態（`0` 為成功）
- `trace_id`：排障必備，建議全鏈路打日誌。

## 5) 接入建議（工程實踐）

1. **先跑非流式 + output_format=url**，減少你本地對 hex 解碼和落盤處理負擔。  
2. **文本切片**：按 200~500 字切片併發合成（保序拼接），避免長文本單次失敗。  
3. **重試策略**：只對超時/限流錯誤做指數退避重試，鑑權與參數錯誤直接告警。  
4. **兜底音色**：主 `voice_id` 不可用時回落到系統默認音色。  
5. **可觀測性**：記錄 `trace_id`、模型、文本長度、耗時、狀態碼。  
6. **字幕需求**：需要句級時間戳時啟用 `subtitle_enable`（僅非流式有效）。

## 6) 角色音色（可先做“音色 App”）

- 可以先做一個“角色音色管理”頁：
  1) 拉取 `/v1/get_voice` 獲取系統/復刻/文生音色；
  2) 角色上保存 `voice_id`；
  3) TTS 請求時直接把該 `voice_id` 寫入 `voice_setting.voice_id`。
- 已有 voice_id 的用戶可**直接跳過查詢接口**，粘貼後即可調用合成。
