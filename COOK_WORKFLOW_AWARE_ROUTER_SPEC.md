# 每回合自動判斷的 completion workflow router 規格

- Status: proposed
- Scope: future product + architecture spec
- Extends:
  - `COOK_NATURAL_LANGUAGE_TRIGGER_PLAN.md`
  - `COOK_COMMANDLESS_ENTRY_SPEC.md`
- Current shipped baseline:
  - explicit `/cook` remains the canonical manual entry
  - assist-mode natural-language handoff can offer the same shared `/cook` flow

## 1. 背景

目前的產品方向已經證明兩件事：

1. `/cook` 應該保留為 canonical workflow boundary。
2. workflow entry 的裁決權應該由 extension 持有，而不是由 primary agent 自己臨場判斷。

但目前仍有一個明顯 UX 缺口：

- 使用者常常會自然地直接交辦 repo 變更，例如：
  - `把 login redirect 補完整，順便加測試`
  - `把 README 改成 user-facing`
  - `這輪改做 redirect loop 那個問題`
- 這類訊息如果先流進 primary agent，primary agent 很可能就直接開始：
  - 讀檔
  - 規劃
  - 改檔
  - 實作

這會破壞 `pi-letscook` 想建立的控制平面邊界：

- 長流程 repo work 應先進 completion workflow
- canonical `.agent/**` state 應先被建立或續接
- workflow 應先經過 confirmation / clarification / chooser，再由 shared driver 接手

因此，下一階段的終局 UX 不應只是「不用輸入 `/cook`」，而應是：

> 使用者安裝 extension 之後，只要正常聊天；extension 會在每個正常 user turn 進 primary agent 前，先判斷這回合應該走普通聊天，還是切入 completion workflow。

---

## 2. 核心產品主張

### 2.1 對使用者來說，workflow entry 應該是 commandless

使用者不應該需要：

- 記 `/cook`
- 記 `開始做` 之類的 trigger phrase
- 記固定模板

使用者只需要自然地說出需求、方向、限制、修正與開始意圖。

### 2.2 對系統來說，canonical boundary 仍然只有一條

即使 UX 變成 commandless，系統內部仍然只應保留一個 canonical workflow entry：

- explicit `/cook`
- commandless router intercept

兩者最終都必須走同一個 shared `runCookEntry` 路徑，而不是分裂成兩套 workflow 邏輯。

### 2.3 extension 持有 routing ownership

「這回合要不要切進 completion workflow」是 control routing，不是普通 prompt content。

因此：

- 不應交給 primary agent 自己判斷
- 不應只靠 skill 提示
- 不應把自然語言 transform 成 `/cook` 再期待 command dispatch 會回頭重跑

正確做法是：

- extension 在 pre-agent `input` 階段攔截
- 由 extension 啟動受控 LLM router classifier
- extension 做最終 routing decision

### 2.4 LLM 應該是主要語意裁決器，但不是唯一控制者

LLM 比 regex 更適合判斷：

- 多語言與 code-switching
- implementation request vs 問題 / 討論 / 分析
- startup / resume / refocus / next-round
- 使用者是否採納 assistant plan / repo markdown

但：

- LLM 只負責分類
- extension 保留最終控制權
- classifier 必須 no-tools、JSON-only、短 timeout、可觀測、可回歸測試

### 2.5 confirm-first 仍然是預設安全語意

終局 UX 不需要 `/cook`，但不代表要 silent auto-start。

預設應仍是：

- router 判斷這回合應進 workflow
- 先出現 confirmation / clarification / chooser
- 使用者確認後才正式進 shared cook entry

未來可考慮高信心 auto-start，但只能是可設定、可 rollback 的後續 phase。

---

## 3. 使用者看到的最終 UX

### 3.1 一般原則

安裝 extension 後：

- 使用者只要正常聊天
- extension 會先審視每個正常 user prompt
- 若這回合只是普通聊天，原訊息照常進 primary agent
- 若這回合應進 workflow，primary agent 不會先動手，會先由 extension 顯示 workflow UI

### 3.2 典型例子

#### 普通聊天

```text
你覺得 login redirect 應該怎麼拆比較好？
```

期望行為：
- router 判定 `normal_prompt`
- 原訊息正常送進 primary agent
- 不建立或改寫 `.agent/**`

#### 直接交辦 repo 變更

```text
把 login redirect 補完整，順便加測試
```

期望行為：
- router 在 pre-agent 攔截
- 判定這是 workflow-start candidate
- 顯示 workflow offer，而不是讓 primary agent 先開始改檔

#### 已有 active workflow，要繼續

```text
接著把剩下的測試補完
```

期望行為：
- router 看到 active workflow + 最新指令
- 優先判定 resume 或 refocus
- 顯示 Resume workflow 或 chooser

#### 已有 active workflow，但方向變了

```text
先不要做 redirect 了，這輪改修 session timeout
```

期望行為：
- router 判定 `refocus`
- 顯示 chooser，而不是默默沿用舊 mission 或直接交給 primary agent

#### 使用者採納 plan / markdown

```text
照 docs/plan.md 做，先不要動 README
```

期望行為：
- router 識別 explicit user adoption
- adopted artifact 作為 mission derivation 的 secondary context
- docs exclusion 進 clarification / proposal context

---

## 4. 不變條件

本方案必須保留以下不變條件：

1. `/cook` 保留為 canonical manual fallback。
2. explicit `/cook` 與 commandless router 必須共用同一個 shared cook entry。
3. primary agent 不得擁有 workflow-entry 裁決權。
4. canonical `.agent/**` state、role dispatch、verification、review / audit / stop-wave semantics 不變。
5. assistant-produced plan / summary / markdown 不能自動升格為 mission truth；只有明確 user adoption 才能進高權重 context。
6. classifier 只能分類，不得讀寫 repo、不得跑 tools、不得直接實作。
7. unclear / conflicting / failure 情境不能 silently 降級成 normal prompt。

---

## 5. 目標與非目標

### 5.1 主要目標

1. 使用者不需輸入任何特定指令，就能自然進入 completion workflow。
2. extension 對每個正常 user turn 都會先做 router decision。
3. 直接實作要求應在 primary agent 開工前被攔截。
4. startup / resume / refocus / next-round 都支援 commandless routing。
5. 一般問答、分析請求、腦暴與說明仍能正常流向 primary agent。
6. 多語言與中英混用輸入下仍能穩健判斷。

### 5.2 非目標

1. 不移除 `/cook`。
2. 不把 workflow logic 複製成另一套 commandless driver。
3. 不要求使用者手寫 `Goal / Scope / Non-goal / Done when` 模板。
4. 不把所有 imperative prompt 都強制變成 workflow。
5. 不把 skill 當主要攔截機制。
6. 不在第一階段預設高信心 auto-start。

---

## 6. 模式設計

建議把目前的 trigger mode 擴展成：

```ts
type CompletionEntryMode = "off" | "assist" | "router" | "auto";
```

### `off`

- 關閉 commandless routing
- 使用者僅能手動 `/cook`

### `assist`

- 目前 shipped 模式
- 主要攔截短 handoff phrase 與採納計劃語句
- 屬於過渡期模式

### `router`

- 目標預設模式
- 每個正常 user turn 都先經過 extension router
- router 可判定 normal prompt 或 workflow offer / clarification
- workflow 入口預設仍為 confirm-first

### `auto`

- 後續可選模式
- 與 `router` 相同，但允許極高信心情境直接 auto-enter shared cook entry
- 建議只在 startup / resume 的明確情境開放
- refocus 與 next-round 仍應預設確認

---

## 7. 高階 routing pipeline

```text
User input
  -> extension hard bypass gate
  -> workflow-aware router
       -> LLM router classifier
       -> policy resolution
            -> normal prompt to primary agent
            -> workflow offer / clarification / chooser
            -> shared runCookEntry
```

### 7.1 Hard bypass gate

以下情境直接 bypass，不進語意 routing：

- slash commands
- image turns
- extension-originated turns
- completion-role subprocess turns
- non-idle / pending-message turns
- internal replay turns marked as router-bypass

### 7.2 Router review on every normal user turn

只要不是 hard bypass，該 turn 就必須先經過 router。

此處的「分析每個 prompt」是產品承諾：

- 使用者層面上，每個正常 prompt 都先由 extension 判斷去向
- primary agent 只會看到已被 router 放行的 turn

### 7.3 LLM classifier is the default semantic judge

在 `router` / `auto` 模式下，非 bypass turn 預設送入 router classifier。

理由：

- 如果仍用 phrase list 當主入口，最終 UX 仍會退回「記 trigger」
- 如果只在少量 candidate 才叫 classifier，會持續漏掉直接實作要求
- 終局目標就是讓 extension 成為 workflow-aware chat router

### 7.4 Policy resolution

classifier 回傳後，extension 依 repo state、workflow state、信心與風險標記決定：

- 放行給 primary agent
- 顯示 workflow offer
- 顯示 clarification / chooser
- 在 failure 時要求 retry 或明確 fallback

---

## 8. Router classifier 合約

### 8.1 設計原則

router classifier 必須：

- no-tools
- no-session
- no-extensions
- JSON-only
- short timeout
- 僅做分類，不做實作
- 可獨立快照與回歸測試

### 8.2 建議輸出 schema

```json
{
  "decision": "offer_workflow | normal_prompt | unclear",
  "workflow_bias": "startup | resume | refocus | next_round | unknown",
  "confidence": 0.0,
  "reason": "short sentence",
  "evidence": ["short grounded strings"],
  "risk_flags": ["machine-readable flags"],
  "focus_hint": "optional short hint",
  "requires_clarification": true,
  "clarification_slots": ["goal", "scope", "non_goal"],
  "adopted_artifact": {
    "kind": "recent_plan | repo_markdown",
    "basis": "explicit_user_adoption",
    "path": "optional",
    "title": "short title"
  }
}
```

### 8.3 輸入上下文

classifier 應至少看到：

- current input
- recent discussion window
- canonical workflow context
  - mission anchor
  - continuation policy
  - current phase
  - next mandatory role
  - active slice summary
  - latest completed / verified slice
- adopted artifact snapshot（若存在）

### 8.4 重要判斷要求

classifier prompt 應明講：

1. 以語意而非關鍵字分類。
2. 輸入可能是任何語言或多語混用。
3. 直接實作要求不應因為沒出現 `/cook` 或 `開始做` 就被視為普通聊天。
4. 普通問題、分析請求、風險討論、`先不要動手` 之類的 turn 應留在 normal prompt。
5. 不確定時寧可回 `unclear`。
6. adopted plan / markdown 只有在 explicit user adoption 時才可提升權重。

---

## 9. 多語言策略

要做到跨語言可用，核心不是列舉 trigger phrase，而是把問題定義成：

> 在目前上下文下，這一句是否應該在 primary agent 動手前被 workflow boundary 接住？

### 9.1 多語策略原則

1. 直接看原文，不先翻譯。
2. 用多語能力穩定的 router model。
3. schema 保持小而穩定。
4. 以 recent discussion + workflow context 補足語意。
5. 不確定就 `unclear`，不要猜。

### 9.2 Phrase list 的角色降級

- regex / phrase list 只保留給 hard bypass 與少量 artifact hint
- 不再作為主要語意裁決來源

---

## 10. Policy resolution 規則

### 10.1 `normal_prompt`

- 原訊息送進 primary agent
- 不改 canonical `.agent/**`
- 若 repo 中已有 active workflow，仍允許 normal prompt 存在，不應強制一切都走 workflow

### 10.2 `offer_workflow`

依 `workflow_bias` 顯示對應 UI：

- `startup` -> Start workflow
- `resume` -> Resume workflow
- `refocus` -> Refocus workflow
- `next_round` -> Start next round
- `unknown` -> generic workflow offer

### 10.3 `unclear`

進 minimal clarification / chooser：

- 問最少量的澄清問題
- 或顯示 startup / resume / refocus / next_round chooser
- 不直接讓 primary agent 先動手

### 10.4 classifier failure

router mode 下，classifier failure 不能 silently 降級成 normal prompt。

建議 recovery UI：

- Retry routing
- Send as normal chat once
- Cancel
- Run `/cook` manually
- Disable router for this session（可選）

其中：

- `Send as normal chat once` 必須是明確使用者選擇，不可自動發生
- 該 replay turn 必須帶 router-bypass 標記，避免遞迴攔截
- `Cancel` 則為 side-effect free，不重播原訊息

這樣才能同時滿足：

- fail-closed
- 不 silently 放行
- router outage 時仍有明確人工 fallback

---

## 11. UX surface 設計

### 11.1 Offer card 行為

router-by-default 模式下，建議把目前的 `Keep chatting` 語意調整為更明確的動作：

- **Start / Resume / Refocus / Start next round**
- **Send as normal chat**
- **Cancel**

理由：

- 既然每個 prompt 都可能被 router 接住，false positive 時不應要求使用者重打原句
- `Send as normal chat` 是一個明確且可觀測的使用者決策
- `Cancel` 保留 side-effect free

### 11.2 Clarification UI

clarification 應以最少操作補齊關鍵差異，例如：

- 這是開始新任務還是繼續目前 workflow？
- 你要沿用目前 mission 還是改做另一個方向？
- `README` / `docs` 要不要排除？

### 11.3 不暴露 chain-of-thought

UI 可顯示：

- 簡短 reason
- evidence 摘要
- candidate mission / focus
- risk 提示

但不應要求模型吐出長篇自由推理。

---

## 12. Shared cook entry contract

無論是 explicit `/cook` 還是 router intercept，都必須交給同一個 shared entry，且可攜帶以下 metadata：

```ts
{
  origin: "explicit-cook" | "router",
  originalInput: string,
  triggerText?: string,
  preferredRoutingBias?: "startup" | "resume" | "refocus" | "next_round" | "unknown",
  hintText?: string,
  clarificationCapsule?: {
    goal?: string,
    scope?: string[],
    nonGoal?: string[],
    doneWhen?: string[]
  },
  adoptedArtifact?: {
    kind: "recent_plan" | "repo_markdown",
    basis: "explicit_user_adoption",
    path?: string,
    title: string,
    preview?: string
  }
}
```

此 contract 必須保證：

1. 既有 `/cook` 路徑不被破壞。
2. router 只是提供更早的 entry 與更完整的 context。
3. canonical state rewrite 仍由 shared cook entry 控制。

---

## 13. Primary agent 與 skill 的角色

### 13.1 Primary agent

primary agent 只應處理：

- router 放行的 `normal_prompt`
- 明確經使用者選擇 `Send as normal chat` 的 replay turn

primary agent 不應負責：

- 決定是否進 workflow
- 在動手後才回頭建議 `/cook`
- 接管 workflow-routing control plane

### 13.2 Skill

skill 可以作為 secondary guardrail，但不是主機制。

可做的事：

- 告訴 primary agent：若發現疑似長流程 repo work 且沒有 workflow boundary，應先保守提醒
- 在少數漏網情境下降低 primary agent 直接動手的機率

不可期待 skill 達成的事：

- 可靠攔截
- fail-closed routing
- canonical workflow ownership

---

## 14. Model、延遲與可靠性要求

因為 router 模式會分析每個正常 prompt，所以不能直接沿用「偶爾跑一次的重型 classifier」思路。

### 14.1 建議模型策略

1. 使用專用 router model 設定，而不是綁死 primary session model。
2. 優先選擇低延遲、穩定、多語能力夠好的模型。
3. 保留可切換 model 的 extension 設定，方便 calibration 與 rollback。

### 14.2 建議 SLA

- soft target: 1.5s ～ 3s
- hard timeout: 5s ～ 8s
- timeout 後走 explicit recovery UI，而不是直接失敗放行

### 14.3 可選的後續優化

後續若 router mode 成本過高，可考慮：

- 將極少數明確 normal cases 做 local fast path
- 低信心時才升級到更強 model
- 對短期重複上下文做小範圍 cache

但這些都不應改變產品語意：

- 每個正常 user turn 都先由 extension router 擁有去向裁決權

---

## 15. 觀測與指標

router-by-default 若要可控，必須加強觀測：

### 15.1 事件紀錄

至少要可觀測：

- bypass reason
- classifier latency
- classifier timeout / invalid_output / error rate
- decision distribution
  - normal_prompt
  - offer_workflow
  - unclear
- workflow bias distribution
- 使用者在 offer 上的 action
  - start
  - send_normal_chat
  - cancel
- clarification action distribution
- router failure recovery action distribution

### 15.2 產品指標

建議追蹤：

- false-positive proxy：offer 後選 `Send as normal chat` 的比率
- false-negative proxy：normal prompt 後短時間內手動 `/cook` 的比率
- router timeout rate
- average routing latency
- workflow acceptance rate by bias

---

## 16. 測試矩陣

### 16.1 基本類型

1. normal question
2. analysis-only request
3. direct implementation request
4. active workflow resume
5. active workflow refocus
6. done workflow next_round
7. adopted recent plan
8. adopted repo markdown
9. unclear acknowledgement
10. classifier timeout / invalid JSON / subprocess error

### 16.2 多語樣本

至少覆蓋：

- English
- zh-TW
- zh-CN
- code-switching

範例：

#### 應進 workflow

- `把 login redirect 補完整，順便加測試`
- `finish the login redirect flow and add tests`
- `把 login redirect flow finish 掉，順便補 tests`
- `照 docs/plan.md 做，先不要動 README`

#### 應留在 normal prompt

- `你覺得 login redirect 應該怎麼拆？`
- `先分析，不要動手`
- `幫我整理成 plan`
- `這樣改會不會太 risky？`

#### 應進 unclear / clarification

- `ok`
- `好`
- `那就這樣`
- `先做這個吧`

### 16.3 決策一致性要求

回歸測試應驗證：

- explicit `/cook` 與 router intercept 最終走同一 shared driver
- `Send as normal chat` 會 replay 原訊息且 bypass router recursion
- `Cancel` side-effect free
- classifier failure 不會 silently 放行 candidate turn
- missing adopted markdown path 仍 fail closed

---

## 17. 預計改動 surfaces

第一輪實作預計涉及：

- `extensions/completion/index.ts`
  - mode 設定與入口 wiring
- `extensions/completion/input-routing.ts`
  - assist-mode trigger routing 升級成 per-turn router
  - explicit replay / bypass 標記
- `extensions/completion/role-runner.ts`
  - 專用 router classifier subprocess
  - model config、timeout、snapshot
- `extensions/completion/prompt-surfaces.ts`
  - offer / clarification / recovery UI
  - `Send as normal chat` surface
- `extensions/completion/types.ts`
  - 新 mode、new action types、router metadata
- `extensions/completion/driver.ts`
  - shared `runCookEntry` metadata thread-through
- `scripts/cook-trigger-routing-test.sh`
  - 擴充成 per-turn router regression suite
- `README.md`
  - 對外說明從「assist-mode shortcut」升級為「workflow-aware router」
- `CHANGELOG.md`
  - 行為與 migration 說明

---

## 18. Rollout 建議

### Phase 0：現況

- explicit `/cook`
- assist-mode natural-language handoff

### Phase 1：shadow router

- 每個正常 turn 都做 router classifier，但只記錄、不攔截
- 建立多語 calibration dataset
- 對照 false-positive / false-negative proxy

### Phase 2：router confirm mode

- 新增 `router` mode
- 每個正常 turn 先經 router
- `offer_workflow` / `unclear` 會攔截並顯示 UI
- `Send as normal chat` 成為主要 false-positive 吸收機制
- 這應是第一個可對外預設的 commandless 版本

### Phase 3：default router mode

- `router` 成為預設
- `assist` 保留一段時間作為 fallback
- README 改為 commandless-first 說明

### Phase 4：optional auto mode

- 僅對高信心 startup / resume 考慮 auto-enter
- refocus / next-round 預設仍確認
- 保留一鍵降回 `router` mode

---

## 19. 最小可交付版本（MVP）

若要先做一版最有價值且風險可控的落地，建議 MVP 定義為：

1. 新增 `router` mode。
2. 每個非 bypass 的正常 user turn 都先進 router classifier。
3. direct implementation request 能在 primary agent 前被攔下。
4. offer UI 提供：
   - Start workflow
   - Send as normal chat
   - Cancel
5. unclear 走 minimal clarification。
6. classifier failure 提供 explicit recovery UI，不 silently 放行。
7. 所有 workflow path 仍走 shared `runCookEntry`。

這個 MVP 已經能實現使用者最重要的感知變化：

- 不需要 `/cook`
- 不需要記 trigger phrase
- primary agent 不會在長流程 repo work 上搶先動手

---

## 20. 結論

本規格的核心不是「把 `/cook` 拿掉」，而是把產品升級成：

> 一個由 extension 擁有控制權的 workflow-aware chat router。

對使用者來說：

- 只要自然聊天即可
- 不用記任何 command
- extension 會在每個正常 prompt 前先判斷是否該進 completion workflow

對系統來說：

- `/cook` 仍然是 canonical boundary
- explicit `/cook` 與 commandless routing 共享同一個 driver
- primary agent 不再擁有 workflow-entry 裁決權
- LLM 是主要語意裁決器，但 extension 才是最終 routing owner

這是從目前 assist-mode handoff 走向真正 commandless-by-default completion workflow 的完整終局方案。
