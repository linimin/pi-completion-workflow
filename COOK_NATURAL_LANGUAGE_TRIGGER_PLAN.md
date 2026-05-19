# 自然語言執行意圖轉接到 `/cook` 的整體方案

## 1. 背景與問題定義

目前 `@linimin/pi-letscook` 的 completion workflow 以 `/cook` 作為正式啟動邊界：

- `/cook` 會從最近主聊天推導 startup / continue / refocus / next-round proposal
- `/cook` 會建立或更新 canonical `.agent/**` 狀態
- 後續 workflow 由 driver + `completion_role` 子程序持續推進到 `done / blocked / await_user_input / paused`

但實際使用時，使用者往往會先在主 session 討論方向，接著自然地輸入：

- 「開始做」
- 「開始實作」
- 「那就做吧」
- 「go ahead」
- 「照這個方向落地」

如果這些自然語句直接進入 primary agent，primary agent 很可能在 `/cook` 尚未接手前就直接開始：

- 規劃
- 讀檔
- 改檔
- 實作

這會破壞 `pi-letscook` 想要建立的控制平面邊界：

- workflow 應由 extension / canonical `.agent/**` state 接管
- 不應由 primary agent 自行決定是否開始長流程 completion work

因此需要一套方案，讓「自然語言的開始執行意圖」能在 **primary agent 開工之前** 被識別並導向 `/cook` 對應的 driver 流程。

---

## 2. 核心結論

### 2.1 控制權應在 extension，不在 primary agent

這類訊號本質上是 **control intent**，不是普通 task content。

因此：

- **不應交給 primary agent 自己判斷** 是否應切入 `/cook`
- **最終裁決權應由 extension 持有**
- 但 **語意理解可以由 extension 控制下的 LLM classifier 輔助**

### 2.2 不採用純 deterministic rules 當主判斷層

純規則無法可靠處理：

- 多語言
- 多種語氣
- 含蓄 handoff
- 上下文指代
- 否定 / 反問 / 引述 / 條件句

因此不應採用：

- 只靠 regex 判斷所有 start intent

而應採用：

- extension 先攔截
- 在模糊語意上交給受控 LLM classifier
- extension 再根據 classifier 結果決定是否啟動 `/cook`

### 2.3 `/cook` 仍然是 canonical workflow boundary

自然語言 start intent 的目標不是取代 `/cook`，而是：

- **把自然語言 handoff 轉接到 `/cook` 的同一套核心啟動邏輯**

換句話說：

- 對使用者來說，可以輸入自然語句
- 對系統來說，仍然是 `/cook` 所代表的 workflow 邊界在接管

---

## 3. 方案目標

### 3.1 主要目標

1. 在主 session 討論完成後，使用者可用自然語言表達「現在開始執行」。
2. 該自然語句在 primary agent 執行前就被 extension 攔截。
3. extension 能根據語意判斷：
   - 這是不是應該 handoff 到 `/cook`
4. 若是，則直接進入與 `/cook` 相同的 driver 流程。
5. 若不是，則放行給 primary agent 當普通 prompt 處理。
6. 保持現有 canonical `.agent/**`、role dispatch、verification、review / audit / stop-wave 設計不被破壞。

### 3.2 次要目標

1. 支援中英混用與多語氣 handoff。
2. 保持行為可測試、可回歸驗證、可觀測。
3. 不要求 skill 才能成立。
4. 可分階段 rollout，不需要一次打開全自動行為。

---

## 4. 非目標

本方案 **不** 以這些事情為目標：

1. 不移除 `/cook`。
2. 不把 workflow handoff 裁決權交給 primary agent。
3. 不把所有 imperative prompt 都改成 `/cook`。
4. 不在第一階段重寫現有 `/cook` 的 startup / refocus / confirmation 核心語意。
5. 不要求 skill 成為 hard dependency。
6. 不要求靠 deterministic rules 完全解決多語言語意問題。

---

## 5. Pi 能力與設計約束

依 Pi extension 機制，流程順序是：

1. extension commands checked first
2. `input` event
3. skill / prompt template expansion
4. agent turn 開始

這代表：

- `input` hook 是唯一能在 primary agent 開始前攔下自然語句的正確位置
- skill 只能做提示，不是可靠攔截點
- 將自然語句 `transform` 成 `"/cook"` 並不保證 command dispatch 會回頭重跑，因此 **不應只靠 input transform**

因此本方案必須以 **extension 的 `pi.on("input")`** 為主軸。

---

## 6. 整體方案總覽

採用 **extension-only + classifier-assisted routing**：

### 6.1 主設計

- 在 completion extension 內新增 `input` hook
- 攔截可能是「開始執行 handoff」的自然語句
- 由 extension 啟動一個受控的、只做分類的 LLM classifier
- classifier 判斷該訊息是否應轉接到 `/cook`
- extension 持有最終 routing 權

### 6.2 高階架構

```text
User input
  -> extension command? yes -> existing /cook path
  -> else input hook
       -> fast safety gate
       -> trigger-intent classifier (isolated, no tools)
       -> extension decision
            -> route into shared cook entry
            -> or confirm
            -> or let primary agent handle
```

### 6.3 關鍵原則

1. **primary agent 不參與 trigger 裁決**
2. **classifier 只做分類，不做實作**
3. **extension 決定是否切到 cook flow**
4. **`/cook` 與自然語言 handoff 最終走同一套 driver 核心邏輯**

---

## 7. UX / 產品語意

## 7.1 保留 `/cook` 為正式入口

顯式 `/cook` 仍是最清晰的 canonical workflow start boundary。

### 用途

- 使用者明確要啟動 completion workflow
- 使用者想要可預期、無歧義、直接的行為

## 7.2 自然語言 handoff 作為等價捷徑

當使用者在主聊天完成方向討論後，以下語句可被視為候選 handoff：

- 「開始做」
- 「開始實作」
- 「那就做吧」
- 「照這個方向往下做」
- 「go ahead」
- 「proceed」
- 其他語義上表示從討論切換到執行的短句

這些語句若被 classifier 判定為 workflow handoff，則：

- **不進入 primary agent 普通回合**
- **改走 `/cook` 的共享啟動流程**

## 7.3 第一階段保留現有 `/cook` 安全語意

為避免一次改太大，第一階段建議：

- 自然語言 handoff 只負責「導向與 `/cook` 等價的 flow」
- 不直接改掉目前 `/cook` 既有的：
  - fail-closed 行為
  - chooser / approval-only confirmation
  - active workflow refocus 保守策略

也就是說：

- 自然語言 handoff != 立刻取消所有確認
- 自然語言 handoff = 觸發 `/cook` 的同一套核心判斷與流程

---

## 8. 推薦 rollout 模式

新增設定模式：

```ts
type NaturalLanguageCookTriggerMode = "off" | "router" | "auto";
```

### `off`

- 完全關閉
- 維持現狀

### `router`

- 偵測到 workflow-worthy handoff 時，不直接自動啟動
- 先詢問使用者：
  - 「要把目前討論交給 `/cook` 接管嗎？」
- 作為 shipped 的 confirm-first 模式，降低誤觸風險

### `auto`

- 高信心 handoff 直接走共享 cook 啟動流程
- 中信心則確認
- 適合穩定後作為預設模式候選

### 建議 rollout

- 第一階段預設：`router`
- 測試成熟後再考慮預設 `auto`

---

## 9. 分層責任設計

## 9.1 Extension 層：最終控制者

責任：

- 攔截 raw input
- 呼叫 classifier
- 判定是否切到 cook flow
- 啟動共享 driver 邏輯
- 決定確認 / 放行 / fail-closed 行為

## 9.2 Classifier 層：受控語意判斷器

責任：

- 只判斷「這是不是 workflow handoff / start intent」
- 不實作
- 不拿 repo mutation tools
- 不做 driver dispatch

## 9.3 Primary agent：普通執行者

責任：

- 只有在 extension 放行後，才接收原始 prompt
- 不負責裁決是否應切到 `/cook`

---

## 10. 具體控制流

## 10.1 正常 `/cook`

```text
User types /cook
  -> existing extension command path
  -> shared cook entry
  -> proposal / continue / refocus / next-round logic
```

無變更。

## 10.2 自然語言 start intent

```text
User types "開始做"
  -> input hook intercepts
  -> fast safety gate passes
  -> trigger-intent classifier runs
  -> classifier returns route_to_cook
  -> extension calls shared cook entry
  -> original natural-language message is not sent to primary agent
```

## 10.3 普通問題 / 普通 coding prompt

```text
User types "幫我看這個 function 為什麼壞掉"
  -> input hook intercepts
  -> classifier returns normal_prompt
  -> extension returns continue
  -> primary agent handles normally
```

## 10.4 模糊語句

```text
User types "那就照這個方向下去"
  -> input hook intercepts
  -> classifier returns unclear / medium confidence route_to_cook
  -> extension asks confirmation
  -> yes => shared cook entry
  -> no => continue to primary agent
```

## 10.5 Classifier 故障 / timeout

若訊息已進入 handoff 候選流程，但 classifier 超時或失敗：

- **不要靜默放行給 primary agent**
- 應採保守策略：
  - notify: 「無法安全判斷是否要切入 `/cook`，若要開始 workflow 請明確使用 `/cook`。」
  - 對該次輸入 `handled`

這樣可避免本來要 handoff 的訊號失敗後又直接讓 primary agent偷跑。

---

## 11. 候選訊息範圍與 gating 策略

因為不希望每一則訊息都打 classifier，應先做一層窄化 gating。

## 11.1 必須滿足的前置條件

以下條件不滿足時，直接放行給 primary agent：

1. 目前輸入是 slash command
2. `event.source === "extension"`（避免遞迴）
3. 處於 completion role subprocess 環境（`PI_COMPLETION_ROLE`）
4. 使用者附帶圖片或大型結構化內容
5. agent / workflow 正在繁忙流式執行中（第一階段建議僅在 idle 時啟用）

## 11.2 候選觸發 envelope

僅對這類輸入進一步送 classifier：

1. 短輸入（例如 1~120 字元）
2. 非 command
3. 近期有主 session implementation 討論跡象
4. 當前 repo 存在 completion workflow 上下文或使用者剛完成明顯的實作方向討論

## 11.3 為何仍保留少量 deterministic gate

這層 deterministic gate **不是最終語意判斷**，只用來：

- 降低 classifier 成本
- 避免明顯無關訊息都送模型
- 處理技術性保護（遞迴、command、streaming 中）

它不是主要語意判斷層。

---

## 12. Classifier 設計

## 12.1 角色定位

這是一個 **isolated, no-tool, JSON-only** classifier。

參考現有 `analyzeContextProposalWithAgent()` 的模式，但用途更窄：

- 不做 proposal 產生
- 不做 scope/acceptance 推導
- 只做 handoff intent classification

## 12.2 建議 schema

```ts
type CookTriggerIntent = "route_to_cook" | "normal_prompt" | "unclear";

type CookTriggerClassification = {
  intent: CookTriggerIntent;
  confidence: number; // 0..1
  reason: string;
  focusHint?: string;
  evidence: string[];
  riskFlags: string[];
};
```

### 欄位說明

- `intent`
  - `route_to_cook`: 使用者意圖是把目前討論切到 completion workflow
  - `normal_prompt`: 這仍是普通 prompt，應交給 primary agent
  - `unclear`: 看不準，不應自動路由

- `confidence`
  - 模型主觀信心，用於 extension 決策閾值

- `focusHint`
  - 若 handoff 成立，可提供一段短的 cue 給 driver 作為附加線索
  - 不是 mission override

- `evidence`
  - 支持判斷的訊息片段摘要
  - 用於確認 UI / 測試快照 / 除錯

- `riskFlags`
  - 例如：
    - `ambiguous-approval`
    - `possible-normal-agent-request`
    - `active-workflow-refocus-risk`

## 12.3 建議 decision policy

### `router` 模式

- `route_to_cook` 且 `confidence >= 0.80`
  - 顯示簡短確認
- `route_to_cook` 且 `0.60 <= confidence < 0.80`
  - 顯示更明確確認 / chooser
- `unclear`
  - 放行給 primary agent 或提示更明確使用 `/cook`
- `normal_prompt`
  - 放行

### `auto` 模式

- `route_to_cook` 且 `confidence >= 0.85`
  - 直接共享 cook entry
- `route_to_cook` 且 `0.60 <= confidence < 0.85`
  - 先確認
- `unclear`
  - 放行
- `normal_prompt`
  - 放行

### classifier failure / timeout

- 保守 handled + notify
- 建議使用者明確輸入 `/cook`

---

## 13. Prompt 設計原則

## 13.1 classifier 輸入材料

建議包含：

1. 當前輸入文字
2. 最近 3~8 則 user/custom 討論摘要
3. 當前 completion snapshot 摘要（若存在）
   - current mission anchor
   - continuation policy
   - current phase
   - next mandatory role
4. 明確說明：
   - 你不是執行器
   - 你不是 planner
   - 你只回答是否要把控制權交給 `/cook`

## 13.2 classifier 輸出要求

- 只輸出 JSON object
- 不可輸出 markdown
- 不可進行任務規劃
- 不可建議直接改 code

## 13.3 prompt 責任邊界

模型需要回答的問題應明確限制為：

> 根據目前輸入與最近討論，使用者現在是否在把討論切換為 completion workflow handoff？

而不是：

- 使用者的最終 mission 是什麼？
- 應該做哪個 slice？
- 現在該改哪些檔？

那些是 `/cook` driver 與 proposal / reground 流程的責任。

---

## 14. 與現有模組的整合方式

## 14.1 `extensions/completion/index.ts`

新增：

- `pi.on("input", ...)`

職責：

- 掛載自然語言 handoff 路由
- 委派給新模組處理

### 第一階段不建議把主要邏輯寫回 `index.ts`

應保持 `index.ts` 薄：

- 只組裝 deps
- 只註冊 hook

## 14.2 `extensions/completion/driver.ts`

新增共享入口函式，例如：

```ts
startCookFromTrigger(pi, ctx, deps, options)
```

或

```ts
runCookEntry(pi, ctx, deps, options)
```

### 目標

讓兩條入口共用同一套邏輯：

1. `/cook` command
2. natural-language trigger route

### 禁止做法

- 不要在 input hook 內單純 `transform` 成 `/cook`
- 不要依賴 command dispatch 重新執行

## 14.3 新增 `extensions/completion/input-routing.ts`

建議新增一個專責模組，職責：

- input gating
- classifier 呼叫
- confidence policy
- confirm / router / auto 決策
- 呼叫 driver shared entry

### 建議 public API

```ts
handleCookNaturalLanguageTrigger(pi, ctx, event, deps)
```

## 14.4 `extensions/completion/role-runner.ts`

新增 classifier 子程序執行 helper，例如：

```ts
classifyCookTriggerIntentWithAgent(...)
```

或抽象為更一般的：

```ts
runJsonClassifierSubprocess(...)
```

### 設計要求

- `--mode json`
- `-p`
- `--no-session`
- 無 tools 或極少只讀能力
- 短超時
- 小 token 預算

## 14.5 `extensions/completion/prompt-surfaces.ts`

新增：

- `buildCookTriggerClassifierPrompt(...)`
- 可選：`maybeWriteCookTriggerSnapshot(...)`

## 14.6 `extensions/completion/types.ts`

新增型別：

- `NaturalLanguageCookTriggerMode`
- `CookTriggerIntent`
- `CookTriggerClassification`
- `CookTriggerDecision`

## 14.7 `extensions/completion/proposal.ts`

可選輕量調整：

- 匯出輕量 helper，用於判斷近期是否存在 implementation discussion envelope
- 但第一階段不建議在 input hook 直接重跑完整 proposal derivation

---

## 15. 建議模組切分

```text
extensions/completion/
  index.ts                 # 掛載 input hook
  driver.ts                # 共享 cook entry
  input-routing.ts         # 新增：input interception + policy
  role-runner.ts           # 新增 trigger-intent classifier subprocess helper
  prompt-surfaces.ts       # 新增 classifier prompt builder
  proposal.ts              # 可選導出輕量 gating helper
  types.ts                 # 新增 classifier / mode 型別
```

---

## 16. 自然語言 trigger 與 `/cook` 共享入口的具體設計

## 16.1 共用入口函式責任

共享入口函式應處理：

1. 讀當前 completion snapshot
2. 決定 startup / continue / refocus / next-round
3. 必要時跑 proposal derivation
4. 必要時 chooser / confirmation
5. 設定 session name
6. queue driver prompt

## 16.2 入口 metadata

共享入口可接收來源 metadata：

```ts
type CookInvocationOrigin = "command" | "natural-language-trigger";

type CookInvocationOptions = {
  origin: CookInvocationOrigin;
  originalInput?: string;
  focusHint?: string;
  autoTriggered?: boolean;
};
```

### 用途

- UI / notify 文案
- 測試快照
- 後續除錯

## 16.3 是否要把自然語句寫回 session

第一階段建議：

- 不把原始自然語句重新送給 primary agent
- 但可考慮記錄一筆非 LLM custom message 或 transient notify：
  - `Auto-routed natural-language start intent to /cook`

這不是必要，但對觀測與測試很有幫助。

---

## 17. 確認 UX 設計

## 17.1 `router` 模式確認文案

當 classifier 高信心判斷為 handoff 時：

```text
你剛才的輸入看起來是在把目前討論交給 completion workflow 執行。
要由 /cook 接管並從最近討論啟動 workflow 嗎？

- Start /cook
- Keep chatting
```

## 17.2 `auto` 模式通知文案

高信心自動路由時：

```text
Detected execution handoff from recent discussion; routing to /cook.
```

## 17.3 模糊時的 chooser

若 classifier 輸出 `unclear` 或中信心 handoff：

```text
這句話可能表示：
1. 把目前討論交給 /cook 開始 workflow
2. 繼續讓主 agent 直接回應

請選擇：
- Start /cook
- Continue chatting
- Cancel
```

---

## 18. 安全策略

## 18.1 Primary safety boundary

當 input hook 已經進入 trigger routing 流程時：

- 在 classifier 結果出來前，不應把該輸入交給 primary agent

## 18.2 classifier failure 安全策略

若 classifier 失敗：

- 不應 fallback 成「當普通 prompt 丟給 primary agent」
- 應保守 handled + notify

## 18.3 避免遞迴

需明確略過：

- `event.source === "extension"`
- 原始輸入已是 `/cook`
- completion role subprocess 環境

## 18.4 避免 streaming 中攔截複雜化

第一階段建議只在 idle 時啟用。

若 agent 正在 streaming：

- 不進行自然語言自動 handoff
- 使用者若要強制 handoff，請顯式 `/cook`

後續若要支援 streaming 中 handoff，再另行設計 `deliverAs: "steer" / "followUp"` 行為。

---

## 19. 與現有 proposal analyst 的關係

本方案不應把 trigger classifier 與 proposal analyst 混成同一層。

### trigger classifier 負責

- 判斷是否 handoff 到 `/cook`

### proposal analyst 負責

- handoff 成立後，從最近討論推導 mission / scope / constraints / acceptance

這樣可以保持責任清晰：

1. 先判斷「是否切 workflow」
2. 再判斷「workflow 應該做什麼」

---

## 20. 測試與驗證方案

## 20.1 新增測試腳本

建議新增：

### `scripts/cook-trigger-routing-test.sh`

驗證：

- 明確自然語言 handoff 會走共享 cook entry
- 普通 prompt 不會被誤攔截
- classifier failure 走保守 handled 路徑
- `event.source === "extension"` 不遞迴
- `/cook` command 路徑不受影響

### `scripts/cook-trigger-classifier-test.sh`

驗證：

- JSON schema parser
- `confidence` 閾值策略
- 多語言 fixture
- 風險 flag / focusHint 處理

## 20.2 建議測試 fixture 類型

### 應 route_to_cook

- `開始做`
- `開始實作`
- `那就做吧`
- `go ahead`
- `可以開始落地了`
- `照剛剛討論的方向往下做`

### 應 normal_prompt

- `幫我看這個 function`
- `為什麼這裡會壞？`
- `請解釋剛才那個設計`
- `你覺得這樣拆合理嗎`

### 應 unclear

- `好`
- `可以`
- `那就這樣`
- `先照這個走`

## 20.3 既有測試需更新的地方

- `npm run smoke-test`
- `npm run refocus-test`
- `npm run context-proposal-test`
- `npm run release-check`

應加入：

- explicit `/cook` 行為未退化
- 自然語言 trigger 模式開關可控
- active workflow continue / refocus 不被破壞

## 20.4 測試 override / snapshot 慣例

此 repo 目前已有大量 `PI_COMPLETION_TEST_*` env override 慣例。

建議新增：

- `PI_COMPLETION_TEST_TRIGGER_CLASSIFIER_OUTPUT`
- `PI_COMPLETION_TEST_TRIGGER_CLASSIFIER_SNAPSHOT_PATH`
- `PI_COMPLETION_TEST_TRIGGER_MODE`
- `PI_COMPLETION_TEST_TRIGGER_ORIGINAL_INPUT`

讓 routing 與 classifier 行為可用 deterministic fixture 驗證。

---

## 21. 實作階段建議

## Phase 1：共享入口抽取

### 目標

- 先把 `/cook` command handler 的核心邏輯抽成共用函式

### 產出

- `driver.ts` 暴露 shared cook entry
- `/cook` command 改成 wrapper

### 驗收

- 現有 `/cook` 行為不變
- 既有 smoke / refocus / context tests 全綠

## Phase 2：trigger classifier 與 input hook

### 目標

- 新增 `input-routing.ts`
- 新增 classifier subprocess helper
- `router` confirm-first 模式先落地

### 驗收

- 自然語言 handoff 能在 router 模式下彈確認
- 普通 prompt 不誤攔
- classifier failure 保守 handled

## Phase 3：`auto` 模式與觀測補強

### 目標

- 開啟高信心自動路由
- 增加 notify / session custom message / snapshot

### 驗收

- 高信心 handoff 可直接進入 shared cook entry
- 誤觸率可接受
- release-check 綠

## Phase 4：文件與 public contract 更新

### 目標

- 更新 README / CHANGELOG
- 補充自然語言 handoff 語意與模式設定

---

## 22. 成功驗收標準

完成後，應能滿足：

1. 在主 session 討論完方向後，輸入自然語言「開始做 / 開始實作 / go ahead」時，不會讓 primary agent 直接開始改 repo。
2. 該訊息若屬於 workflow handoff，會進入與 `/cook` 等價的共享 driver 流程。
3. 顯式 `/cook` 行為不退化。
4. active workflow 的 continue / refocus / next-round 邏輯不退化。
5. classifier timeout / failure 不會導致靜默放行給 primary agent。
6. 行為可用 deterministic fixture 測試與 release-check 覆蓋。
7. 整套方案不依賴 skill 才能成立。

---

## 23. 風險與對應

## 23.1 誤觸風險

### 風險

普通短句被誤判成 handoff。

### 對應

- 先以 `router` confirm-first 為預設 rollout
- `auto` 僅對高信心啟用
- 增加 confirmation 與 chooser

## 23.2 classifier 成本 / 延遲

### 風險

每次短訊息都打模型太慢。

### 對應

- 前置 gating 窄化候選訊息
- 小 token / 短 timeout
- 可選專用小模型設定

## 23.3 行為不透明

### 風險

使用者不知道為何突然進 `/cook`。

### 對應

- notify 文案
- router mode confirmation
- snapshot / custom message 記錄

## 23.4 與既有 `/cook` confirmation 語意衝突

### 風險

自然語言 handoff 與目前 approval-only gate 交互複雜。

### 對應

- 第一階段不改掉現有 `/cook` confirmation contract
- 只把 handoff 轉接到同一條共享入口

---

## 24. 不建議的替代方案

## 24.1 只靠 skill 引導

問題：

- skill 只是 prompt / capability instruction
- 不能保證 primary agent 不先動手
- 不能做可靠 input interception

## 24.2 完全交給 primary agent 自己判斷

問題：

- primary agent 同時是判斷者與執行者
- 可能先讀檔 / 改檔，再想到應該走 `/cook`
- 破壞控制平面邊界

## 24.3 純 regex / deterministic rules

問題：

- 多語言、多語氣、上下文指代表現差
- 難以穩定處理真實使用情境

---

## 25. 最終建議

### 核心推薦

採用：

- **extension `input` hook 攔截**
- **isolated LLM classifier 做 handoff intent 判斷**
- **extension 持有最終 routing 權**
- **自然語言 handoff 與 `/cook` 共用 driver 核心入口**

### 第一階段實作建議

1. 先抽 `driver.ts` 共享 cook entry
2. 新增 `input-routing.ts`
3. 新增 classifier helper（可掛在 `role-runner.ts`）
4. 以 `router` confirm-first 模式先落地
5. 補 `cook-trigger-routing-test.sh`
6. 全綠後再考慮 `auto`

### 一句話總結

> 這個問題不該靠 primary agent 自己理解後再決定是否 handoff；而應由 extension 在 agent 開工前攔截，再用受控 classifier 輔助語意判斷，最後由 extension 把控制權安全地轉接到 `/cook`。
