# 無需顯式 `/cook` 的 completion workflow 入口規格

- Status: proposed
- Scope: future product + architecture spec
- Builds on: `COOK_NATURAL_LANGUAGE_TRIGGER_PLAN.md` 已完成的 assist-mode 自然語言 handoff 基礎

## 1. 背景與動機

目前 `@linimin/pi-letscook` 已經支援：

- 以 `/cook` 作為 canonical workflow boundary
- 在主 session 討論後，用自然語言 handoff（例如 `開始做` / `開始實作` / `go ahead`）先攔截，再由 extension 提供 assist-mode 確認
- 確認後走與 `/cook` 相同的 shared cook entry 與 canonical `.agent/**` workflow

這個方向是正確的，但仍有兩個明顯 friction：

1. **使用者仍常常需要顯式輸入 `/cook`** 才能穩定進入 completion workflow。
2. **mission goal 推導常常不夠聚焦**，導致使用者會先在主 session 要求 agent 把計劃整理成 markdown，或自己補一段結構化 handoff，再用 `/cook` 接手。

第二點尤其是 UX 問題：

- 如果使用者每次都要記得先寫 `Goal / Scope / Non-goal / Done when`
- 或每次都要先把計劃落地成一份 markdown

才比較容易讓 `/cook` 抓到重點，那代表系統把本來應該自己做的結構化整理，外包給使用者了。

因此下一階段的方向不應只是「把 `/cook` 拿掉」，而是：

> 讓使用者可以在主 session 自然討論後，只要表達明確開始實作的意圖，extension 就能在 primary agent 開工之前攔截，經過使用者確認後，內部仍走同一條 canonical `/cook` driver，正式進入 completion workflow。

換句話說：

- **UX 上可以 commandless**
- **架構上仍保留 `/cook` 所代表的 canonical boundary**

## 2. 核心產品主張

### 2.1 使用者不應被要求記住模板

系統不應要求使用者每次都手打一份結構化 user message 才能穩定開始 workflow。

更合理的方式是：

- 使用者自然地說出「現在開始做」
- extension 先根據最近討論推導一版 mission focus
- 若不夠穩定，就用 **極少量 clarification** 補齊缺口
- 再讓使用者做 **Start / Keep chatting / Adjust focus** 類型的確認

### 2.2 extension 持有 workflow entry 的裁決權

這類「現在是不是該切入長流程 completion workflow」的判斷，本質上是 **control intent routing**，不是普通 prompt content。

因此：

- 不應由 primary agent 自己決定是否啟動 workflow
- 也不應靠 prompt engineering 讓 primary agent「看懂了就自己進 `/cook`」
- extension 必須在 primary agent 執行前就先做 routing 決策

### 2.3 `/cook` 仍是 canonical boundary

本規格不主張移除 `/cook`。

本規格主張的是：

- 使用者可以不需要顯式輸入 `/cook`
- 但一旦要進 workflow，系統內部仍然走 **同一個 shared cook entry**
- 也就是 commandless UX 只是 **新的入口**，不是新的 workflow implementation

### 2.4 低信心時應 clarify-first，不是要求使用者重寫

當 mission derivation 不夠穩時，系統不應期待使用者自己重新寫一份結構化 prompt。

更好的行為是：

- 直接問一到兩個極短的澄清問題
- 或讓使用者從少數候選 mission / scope 中做選擇
- 再產生一份 internal clarification capsule，餵給 shared cook entry

### 2.5 「使用者採納的計劃」可以是高訊號上下文

系統不應默默信任任何 assistant 產生的 plan / proposal / markdown。

但若使用者明確表示：

- `就照剛剛那份方案做`
- `照 docs/plan.md 開始`
- `用剛剛整理的計劃當這輪實作基礎`

那麼這個「**被使用者採納的計劃**」應該成為 mission derivation 的高權重 secondary context。

## 3. 目標

### 3.1 主要目標

1. 使用者在主 session 討論完後，不需要顯式輸入 `/cook` 也能開始 completion workflow。
2. extension 能在 primary agent 回應前攔截明確的開始實作意圖。
3. 在經過使用者同意後，系統走與 `/cook` 相同的 shared cook entry 與 canonical `.agent/**` workflow。
4. mission derivation 應比單純依賴長對話更聚焦，且不要求使用者每次手動寫模板或 markdown。
5. preserve 既有 canonical `.agent/**` state、role dispatch、verification、review / audit / stop-wave semantics。
6. 一般問題、普通 coding prompt、slash commands 仍然正常流向 primary agent，而不是被誤攔截進 workflow。

### 3.2 次要目標

1. 支援 startup / continue / refocus / next-round 的 commandless 入口。
2. 支援中英混用與多種自然 handoff 語氣。
3. 支援「使用者採納最新計劃」的低摩擦流程。
4. 讓 low-confidence 情境走 clarify-first，而不是直接要求使用者重講整段。
5. 保持 deterministic testability、可觀測性、與 fail-closed 行為。

## 4. 非目標

本規格 **不** 以這些事情為目標：

1. 不移除 `/cook` command。
2. 不把 workflow 啟動裁決權交給 primary agent。
3. 不預設自動啟動 workflow 而不經過使用者確認。
4. 不把任何 assistant-produced plan / summary 自動當成可執行 mission。
5. 不把所有 imperative prompt 都攔截成 completion workflow。
6. 不複製一套獨立於 `/cook` 之外的新 workflow driver。

## 5. 使用者故事

### 5.1 新 workflow

使用者先在主 session 討論一段時間，接著說：

- `開始做`
- `好，開始實作`
- `go ahead`

extension 應該攔截，顯示一張 workflow offer，讓使用者確認後開始 completion workflow。

### 5.2 繼續目前 workflow

repo 已有 active workflow，使用者說：

- `繼續做`
- `接著做`
- `下一步`

extension 應該優先判斷是否要 resume current workflow，而不是當普通聊天放行。

### 5.3 轉向其他任務

repo 已有 active workflow，但最近討論顯示使用者想做另一件事。使用者說：

- `那改做這個`
- `先做新的那個方向`
- `好，開始做這個版本`

extension 應該顯示 chooser，而不是直接 resume 既有 workflow。

### 5.4 使用者採納 assistant 計劃

assistant 剛整理出一份計劃或 proposal，使用者接著說：

- `就照剛剛那份方案做`
- `照 docs/plan.md 開始`
- `用剛剛整理的方案開始實作`

extension 應該能把「被使用者採納的 artifact」當成 secondary context，幫助 mission derivation，而不是要求使用者再寫一份結構化摘要。

### 5.5 低信心時短澄清

如果最近聊天裡混了兩個可能的 mission，使用者又只說：

- `開始做`

extension 不應亂啟動其中一個，而應問一個極短的澄清問題或顯示 chooser。

## 6. 名詞定義

### 6.1 Commandless handoff

指使用者沒有輸入 `/cook`，而是用自然語言表達「現在開始實作」的意圖，由 extension 攔截後引導進 workflow。

### 6.2 Shared cook entry

指 explicit `/cook` 與 commandless handoff 最終都呼叫的同一套 driver entrypoint。它負責：

- startup / continue / refocus / next-round routing
- canonical `.agent/**` state 讀寫
- confirmation / chooser / fail-closed behavior
- 後續 completion role dispatch

### 6.3 Workflow offer

指 extension 在攔截開始實作意圖後，於 primary agent 開工前顯示給使用者的確認卡或 chooser。

### 6.4 Clarification capsule

指系統在 low-confidence 情境下，透過極短問答或 chooser 產生的一份 internal structured summary，用來補齊：

- Goal
- Scope
- Non-goal
- preferred routing bias

它是 **system-generated + user-confirmed**，不是要求使用者手寫模板。

### 6.5 Adopted plan

指一份 assistant-produced 或 repo-local 的 plan / proposal / markdown，被使用者明確採納後，成為 mission derivation 的高訊號 secondary context。

## 7. UX 總覽

### 7.1 Happy path：新 workflow

1. 使用者在主 session 討論具體 repo 變更。
2. 使用者輸入：`開始做`。
3. extension 在 pre-agent 階段攔截。
4. classifier + recent context 推導：這是 workflow handoff 候選。
5. 顯示 workflow offer：
   - 推導出的 mission 摘要
   - 這輪預計 scope
   - 可見的 excluded items（若能推導）
6. 使用者選擇：
   - **Start workflow**
   - **Keep chatting**
   - **Adjust focus**（如果系統信心不足或 scope 還不夠穩）
7. 若使用者選 **Start workflow**，extension 呼叫 shared cook entry。
8. 後續流程與 explicit `/cook` 完全一致。

### 7.2 Happy path：resume current workflow

1. repo 中已有 canonical active workflow。
2. 使用者說：`繼續做`。
3. extension 攔截後推導出高信心 resume。
4. 顯示：
   - current mission
   - next mandatory role / current phase
   - **Resume workflow** / **Keep chatting**
5. 使用者確認後，shared cook entry 走 continue / resume routing。

### 7.3 Happy path：refocus chooser

1. repo 中已有 active workflow。
2. 最近討論已明顯轉向另一個 concrete repo change。
3. 使用者說：`好，開始做這個`。
4. extension 顯示 chooser：
   - Resume current workflow
   - Start workflow from recent discussion
   - Start alternate workflow from recent discussion（若有第二候選）
   - Keep chatting
5. 只有在使用者確認後才允許 canonical state rewrite。

### 7.4 Happy path：adopt latest plan

1. assistant 剛整理出一份 plan / markdown。
2. 使用者說：`就照剛剛那份方案做，先不要動 docs`。
3. extension 偵測到：
   - 明確開始實作意圖
   - 明確採納最近計劃
   - 額外 non-goal 修正
4. 顯示 workflow offer：
   - Mission 主要來自 recent discussion + adopted plan
   - 顯示 `docs` 被排除
5. 使用者確認後進 shared cook entry。

### 7.5 Low-confidence：clarify-first

1. 最近聊天中有兩個可能 mission。
2. 使用者只說：`開始做`。
3. extension 不直接進 workflow，也不要求使用者重寫一份 structured prompt。
4. 改成用一個簡短 clarification surface，例如：
   - `這輪主要是要做哪個？`
   - 選項 A：runtime + tests
   - 選項 B：docs + release parity
   - 選項 C：自己補充一句
5. 根據回答產生 clarification capsule。
6. 使用者確認後再進 shared cook entry。

## 8. 互動原則

### 8.1 預設仍是 confirm-first，不是 auto-start

即使 classifier 高信心，也不應預設 silent auto-start。

原因：

- workflow 會產生 canonical `.agent/**` state side effects
- 很多「開始做」在口語中不一定真的表示要進 tracked workflow
- 使用者可能只是想讓 primary agent 普通繼續聊天或回答下一步

因此第一階段與預設模式仍應維持：

- **offer first**
- **explicit user consent required**

### 8.2 Keep chatting 是 side-effect free

如果使用者選 **Keep chatting**：

- 不建立或改寫 canonical `.agent/**`
- 不把原始開始實作語句 replay 給 primary agent 當普通 prompt
- 使用者可以繼續在主 session 補充或修正方向

這和現在 assist-mode 設計一致：workflow offer 是獨立控制面，不是把原 prompt 悄悄改路由。

### 8.3 Adjust focus 只補最少必要資訊

`Adjust focus` 不應變成一張大型表單。

它的職責只是：

- 補齊當前最缺的 1~2 個資訊槽位
- 讓系統生成 clarification capsule
- 再回到 Start / Keep chatting 的簡單決策

## 9. Routing pipeline

### 9.1 Stage 0：candidate gate

只有以下條件全部滿足，才進入 commandless handoff pipeline：

- 使用者輸入不是 slash command
- 不是 extension-sourced event
- 不是 completion-role subprocess turn
- 不是 image turn / attachment-only turn
- 目前沒有 active running role surface 正在執行
- repo state 與 session 狀態允許做 pre-agent routing

### 9.2 Stage 1：context collection

extension 收集：

- 最近 main-chat user turns
- 最近 main-chat assistant turns（低權重，只做 context，不直接當 mission source）
- canonical `.agent/**` state（若存在）
- 最近可能被使用者採納的 plan / proposal artifact
- 當前輸入文字

### 9.3 Stage 2：start-intent classifier

使用 isolated、no-tool、JSON-only、short-timeout classifier 做 routing decision。

最低需求 schema：

```json
{
  "decision": "offer_workflow" | "normal_prompt" | "unclear",
  "confidence": 0.0,
  "workflow_bias": "startup" | "resume" | "refocus" | "next_round" | "unknown",
  "focus_hint": "string or null",
  "requires_clarification": true,
  "clarification_slots": ["goal", "scope", "non_goal"],
  "adopted_artifact": {
    "kind": "recent_plan" | "repo_markdown" | "none",
    "path": "string or null",
    "basis": "explicit_user_adoption" | "none"
  },
  "risk_flags": ["ambiguous_scope", "multiple_candidate_missions"]
}
```

### 9.4 Stage 3：offer / clarification builder

根據 classifier 結果：

- `offer_workflow` + 高信心：直接顯示 workflow offer
- `offer_workflow` + 需要 clarification：先顯示 clarification UI
- `normal_prompt`：放行給 primary agent
- `unclear`：保守 fail-closed 或短 clarification（視 rollout phase）

### 9.5 Stage 4：shared cook entry handoff

只有在使用者確認後，extension 才呼叫 shared cook entry。

commandless path **不能**：

- 直接 transform input 成 `"/cook ..."`
- 走 command redispatch hack
- 複製一套獨立 workflow 邏輯

它只能把整理好的 handoff payload 傳給同一個 shared cook entry。

## 10. Shared cook entry contract

建議把 shared cook entry 明確抽象成一個可被多入口呼叫的 API。

概念介面：

```ts
runCookEntry({
  source: "explicit_command" | "natural_language_handoff",
  triggerText: string | null,
  explicitHint: string | null,
  preferredRoutingBias: "startup" | "resume" | "refocus" | "next_round" | "unknown",
  adoptedArtifactPath: string | null,
  clarificationCapsule: {
    goal?: string,
    scope?: string[],
    nonGoal?: string[],
    doneWhen?: string[]
  } | null,
  confirmationContext: {
    classifierConfidence: number,
    riskFlags: string[]
  }
})
```

### 10.1 explicit `/cook` 與 commandless handoff 的差異只在入口，不在 driver

- explicit `/cook`：使用者顯式要求 workflow entry
- commandless handoff：extension 根據自然語言 intent 提供 entry offer

一旦使用者確認，shared cook entry 的後續 routing 應完全一致。

## 11. Mission derivation 的新優先順序

這是本規格最重要的 quality 改進點之一。

目前使用者常覺得 `/cook` 沒切中重點，是因為它過度依賴長對話推導，而缺少高訊號 focus anchor。

commandless 版本應明確定義 mission derivation precedence：

1. **本次 clarification capsule**（如果有）
2. **使用者明確採納的 plan / proposal artifact**
3. **最近 main-chat 的 user discussion**
4. **當前 handoff trigger text 與 classifier focus hint**
5. **assistant-produced summaries / proposals（未被採納）只作低權重背景**

### 11.1 關鍵原則

- 不是 markdown 本身有魔法
- 而是「被使用者採納的結構化內容」是高訊號上下文
- 系統應優先使用這類高訊號，而不是期待使用者每次重新手打一份 structured prompt

## 12. Clarify-first 設計

### 12.1 何時進 clarification

以下情境進 clarification，而不是直接 workflow offer：

- 兩個以上 plausible mission 同時存在
- classifier 對 scope 邊界低信心
- active workflow 存在，但是 resume / refocus / next-round 分不清
- 使用者說的是明確開始意圖，但最近上下文不足以決定 non-goal

### 12.2 clarification 形式

優先順序：

1. chooser / option select
2. 單句短答
3. 最小自由輸入

不應要求：

- 大段作文
- 完整 Goal / Scope / Non-goal / Done when 表單
- 先產出 markdown 再回來

### 12.3 clarification 產物

clarification UI 的輸出應是 internal capsule，例如：

```json
{
  "goal": "先做 extension-owned 的自然語言 handoff routing",
  "scope": ["input interception", "classifier", "assist confirmation", "tests"],
  "nonGoal": ["README", "CHANGELOG", "auto mode"]
}
```

之後再交給 shared cook entry。

## 13. State machine

### 13.1 新增的前置狀態

在 primary agent 前新增這組 transient states：

- `idle`
- `candidate_detected`
- `workflow_offer`
- `clarification_pending`
- `confirmed_handoff`
- `keep_chatting`

### 13.2 狀態轉移

| From | Event | To |
|---|---|---|
| idle | candidate gate hit | candidate_detected |
| candidate_detected | classifier says normal_prompt | idle + pass through |
| candidate_detected | classifier says offer_workflow | workflow_offer |
| candidate_detected | classifier says unclear + clarify allowed | clarification_pending |
| workflow_offer | Start workflow | confirmed_handoff |
| workflow_offer | Keep chatting | keep_chatting |
| workflow_offer | Adjust focus | clarification_pending |
| clarification_pending | user answered enough | workflow_offer |
| clarification_pending | user canceled | keep_chatting |
| confirmed_handoff | shared cook entry accepted | canonical completion workflow |

### 13.3 canonical `.agent/**` 邊界不變

上述狀態為 transient UI/routing 狀態。真正的 canonical workflow state 仍只由 shared cook entry 與 completion protocol 更新 `.agent/**`。

## 14. 安全閘與 fail-closed 規則

### 14.1 必要跳過條件

下列情境一律不做 commandless workflow entry：

- slash commands
- extension generated messages
- completion role subprocesses
- image-only or attachment-only turns
- non-idle / streaming-time risky path（第一階段不處理）
- active tool execution path 中的二次攔截

### 14.2 classifier failure 行為

若 classifier timeout / malformed JSON / provider failure：

- 不可 silently fall through 給 primary agent
- extension 應保守處理並提示：
  - `我無法安全判斷是否要開始 workflow，請直接輸入 /cook`
- canonical `.agent/**` state 不應被改動

### 14.3 assistant artifact trust boundary

若最近有 plan / proposal / markdown，但沒有使用者明確採納訊號：

- 它可以作為低權重背景
- 不能被視為 adopted plan
- 不能作為 workflow start 的唯一依據

### 14.4 active workflow 保守策略

當 canonical workflow 已存在時：

- resume / refocus / next-round 必須比 startup 更保守
- 不可因單句 `開始做` 就直接覆寫 current mission
- 有歧義時必須 chooser 或 clarification

## 15. Edge cases

### 15.1 短附和語

以下類型不應預設視為 workflow handoff：

- `好`
- `可以`
- `那就這樣`
- `嗯`

除非最近上下文非常強、且 classifier 高信心判定這是 explicit start intent。

### 15.2 普通 coding prompt

像：

- `幫我看看這段錯在哪`
- `先列一下方案`
- `你覺得哪個做法比較好`

都應放行，不應進 workflow offer。

### 15.3 已完成 workflow 後的聊天

若上一個 workflow 已 `done`，但最近聊天只是在回顧已做的內容：

- `開始做` 不應 reopening finished mission
- 必須 fail-closed 或要求 clarifying new mission

### 15.4 docs-only work

如果最近討論很清楚是在做 README / CHANGELOG / release-check 類的 tracked docs work：

- 它仍然可以是有效 workflow mission
- 不應因為是 docs work 就被視為 planning-only artifact

### 15.5 採納舊計劃

如果使用者說：

- `照 docs/plan.md 做`

但 repo 中有多份 plan 或該 plan 明顯過期：

- extension 應要求 disambiguation
- 不可默默抓一份最像的

## 16. 可觀測性

應新增或保留以下訊號：

- commandless handoff candidate detected
- classifier decision / confidence / risk flags
- adopted plan detected or not
- clarification entered or skipped
- final user action：Start workflow / Keep chatting / Adjust focus
- routed into shared cook entry with source=`natural_language_handoff`

UI 上至少應讓使用者看得到：

- 系統理解的 mission summary
- 是否來自 recent discussion 或 adopted plan
- 為何當前是 offer / chooser / clarification

## 17. 測試矩陣

### 17.1 正向案例

1. 新 workflow：最近討論清楚，`開始做` → workflow offer → Start → shared cook entry
2. active workflow resume：`繼續做` → resume offer → confirm
3. active workflow refocus：最近討論轉向 → chooser → confirm new mission
4. next-round：前一輪 done，最近討論是新任務 → next-round offer
5. adopted plan：assistant 先整理方案，使用者明確採納 → adopted plan 被用於 mission derivation
6. clarification path：低信心時問一個短問題，回答後成功進 workflow

### 17.2 負向案例

1. 普通問題 prompt 不應被攔截
2. 短附和語在一般情境下不應觸發 workflow offer
3. slash command 不應進 commandless pipeline
4. extension event / subprocess turn 不應被攔截
5. image turn 不應被攔截
6. classifier failure 不可 silently fall through
7. 未被採納的 assistant plan 不可自動成為 mission source

### 17.3 非回歸案例

1. explicit `/cook` 行為不變
2. 既有 startup / continue / refocus / next-round semantics 不變
3. `.agent/**` canonical contract 不變
4. review / audit / stop-wave 不變
5. active workflow continue/refocus chooser semantics 不變
6. `Keep chatting` 不改寫 canonical state

## 18. Rollout 建議

### Phase 1：commandless startup assist

- 只針對新 workflow startup 做 commandless offer
- active workflow 仍偏保守
- 維持 confirm-first

### Phase 2：commandless resume / refocus / next-round

- active workflow 與 done workflow 也支援 commandless entry
- 增加 chooser / clarification coverage

### Phase 3：adopted plan integration

- 對「使用者採納最近計劃」提供更明確的 UX
- 例如 offer card 顯示 `Start from latest adopted plan`

### Phase 4：clarify-first 深化

- mission derivation 低信心時，優先用 guided clarification 而不是單純 fail-closed
- 進一步降低使用者必須寫 markdown 或 structured message 的需求

## 19. 結論

這份規格的核心不是「刪掉 `/cook`」，而是：

> 讓使用者在自然討論後，可以不用顯式輸入 `/cook`，只要表達明確開始實作的意圖，extension 就能在 primary agent 前攔截，經過使用者確認後，內部仍走同一條 canonical `/cook` driver，正式啟動 completion workflow。

這樣的設計同時滿足：

- 更自然的 UX
- extension-owned routing control
- preserve canonical `.agent/**` boundary
- 不要求使用者記住結構化模板
- 允許 clarify-first 與 adopted plan 作為 mission focus 輔助

也就是：

- **commandless UX**
- **same canonical workflow boundary**
- **confirm-first by default**
- **clarify-first when low confidence**
