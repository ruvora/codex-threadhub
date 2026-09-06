# 실행 계약

실행 계약은 “누가 무엇을 잘하는가”와 “무엇을 할 권한이 있는가”를 분리한다. Planner의 역할 이름과 자연어 prompt는 전문화 힌트일 뿐 권한의 근거가 아니다. worker를 시작하기 전에 deterministic compiler가 Task 입력을 versioned contract로 바꾸고 preflight한다.

현재 계약 version은 `2`이며 구현 정본은 `src/execution-contracts.js`다. version 2는 프로젝트 변경 권한과 실행 중 필요한 로컬 runtime 권한을 분리한다.

모든 신규 입력은 `compileAndValidateExecutionContract()`를 사용하고, 저장 계약의 실행·retry·repair·restart recovery는 `assertExecutionContract()`를 사용한다. Planner와 단일/백그라운드/그래프 dispatch가 서로 다른 허용 범위를 갖지 않는다.

## Contract fields

| 필드 | 값/의미 |
|---|---|
| `version` | 현재 `2` |
| `taskKind` | `analysis`, `implementation`, `test`, `review`, `integration`, `release` |
| `mutatesWorkspace` | 프로젝트 파일을 변경할 의도가 있는지 |
| `requiredSandbox` | Task 의도상 필요한 최소 sandbox |
| `sandbox` | `read-only`, `workspace-write`, `danger-full-access` |
| `networkAccess` | worker의 네트워크 요구 여부 |
| `approvalPolicy` | 정상 Run Task는 `never` |
| `authorizationScope` | 현재 유일한 값 `parent_run` |
| `sideEffectPolicy` | `none`, `local-runtime`, `workspace`, `external`, `destructive` |
| `idempotencyKey` | 재전송과 재시도 식별 키. 기본은 Task key |
| `workspaceMode` | `shared` 또는 `worktree` |
| `baseRef` | managed worktree 기준 ref |
| `integrationStrategy` | `none`, `patch`, `commit` |
| `outputs` | 기대 산출물 목록 |
| `tools` | 실행에 필요한 도구 목록 |
| `executionCapabilities` | workspace와 분리된 실행 능력 목록 |
| `roleTemplate` | 적용된 역할 템플릿 이름. 권한 근거가 아님 |
| `fingerprint` | 정렬된 계약 JSON의 SHA-256 앞 20자리 |

`outputs`는 설명용 label이 아니라 Completion Gate가 실제 결과와 대응시켜야 하는 요구사항이다. `workspace-change`는 non-empty diff 또는 적용 가능한 artifact를, `report`는 비어 있지 않은 구조화 결과와 provenance를 요구한다. 이름만 선언하고 임의의 자연어 output이 존재하는 것으로 충족 처리하지 않는다.

## Default compilation

### Single-Run authorization and prose diagnostics

추가 Start 승인 여부는 구조화된 `authorizationScope=parent_run`과 실행 계약으로 결정한다. 명시된 다른 값이나 잘못된 타입은 `EXECUTION_CONTRACT_AUTHORIZATION_SCOPE`로 거부한다. 신규 Planner 출력은 이 필드가 필수이며, 기존 입력 경로의 필드 생략은 compiler의 `parent_run` 기본값을 따른다.

자연어의 추가 Start 표현 검사는 보조 진단이다. `PLAN_START_PROSE_WARNING`은 Plan의 `metadata.startPolicyDiagnostics`에 task key와 원문을 보존하며 `blocking=false`로 기록한다. 문장의 쉼표·부정 표현·번역 차이 때문에 계획을 거부하거나 재생성하지 않는다. 이 경고는 새 승인을 만들거나 기존 권한을 확대하지 않으며, worker에는 기존 Run 승인 지침이 계속 전달된다. 실제 sandbox·side-effect·fingerprint 검증과 Completion Gate도 그대로 적용된다.

명시적 `taskKind`가 없으면 title, prompt, capability, tool의 단어를 이용한 호환 추론을 사용한다. 신규 Planner 출력은 명시적으로 제공해야 한다.

| 의도 | 기본 계약 |
|---|---|
| 비변경 분석·검토 | `read-only`, `shared`, `sideEffectPolicy=none`, output `report` |
| 구현·통합·release | `workspace-write`, `worktree`, `sideEffectPolicy=workspace`, `integrationStrategy=patch` |
| 기본 test 실행 | `mutatesWorkspace=false`, `outputs=[report]`; 임시 파일을 위한 writable runtime과 프로젝트 변경은 별개. 테스트 코드 작성·수정은 명시적 `mutatesWorkspace=true` 필요 |
| 로컬 daemon/process 수명주기 | 명시적 `sideEffectPolicy=local-runtime` |

`mutatesWorkspace=false`는 프로젝트 파일을 바꾸지 않는다는 뜻이지 운영체제 수준의 모든 쓰기와 local listener를 금지한다는 뜻이 아니다.

## Execution capabilities

| Capability | 의미 |
|---|---|
| `process-execution` | 명령이나 로컬 프로세스 실행 |
| `temporary-filesystem-write` | 테스트용 임시 파일·디렉터리 생성 |
| `localhost-connect` | 로컬 서비스 연결 |
| `localhost-listen` | 테스트 서버나 socket listener 생성 |
| `external-network` | 외부 네트워크 접근 |
| `browser-inspection` | 실제 브라우저 렌더링·상호작용 검증 |
| `workspace-write` | 프로젝트 파일 변경 |
| `git-integration` | patch 또는 commit artifact 통합 |

`temporary-filesystem-write`와 `localhost-listen`은 writable runtime sandbox를 요구하지만 `workspace-write`를 의미하지 않는다. `browser-inspection`은 `browser`, `chrome`, `computer-use` 중 하나가 tools에 있어야 한다. `localhost-listen`은 `process-execution`을 함께 요구한다. `external-network`와 `networkAccess`, `workspace-write`와 `mutatesWorkspace`, `git-integration`과 `integrationStrategy`는 서로 일치해야 한다.

현재 실행 어댑터는 loopback 전용 권한을 별도로 부여하지 못한다. 따라서 `localhost-listen` + `sandbox=workspace-write` + `networkAccess=false`는 지원 불가능한 계약으로 실행 전에 거부한다. 인터넷 권한이나 sandbox 권한을 자동 확대하지 않는다. 실제 서버 테스트는 허가된 호스트에서 별도로 수행한다. `test/work-panel.test.js`는 소켓 없는 화면 테스트이며, 실제 서버·토큰 통합 검증은 `test/work-panel-http.test.js`에 유지한다. 전체 `node --test`에는 둘 다 포함되며 통합 검증을 건너뛴 것을 성공으로 처리하지 않는다.

Compiler는 구조화된 `acceptanceCriteria`에서 실제 브라우저·viewport·반응형 렌더링, localhost listener, 임시 파일 요구를 보수적으로 추출한다. 선언된 tool과 sandbox가 이 요구를 충족하지 못하면 graph persistence 전에 거부한다. 자연어 prompt는 권한을 추가하지 않는다.

## Preflight invariants

다음 조건은 worker thread 생성 전에 거부한다.

1. `sandbox`가 지원 목록에 없다.
2. 실제 sandbox가 `requiredSandbox`보다 약하다.
3. `read-only` sandbox에서 network access를 요청한다.
4. `authorizationScope`가 `parent_run`이 아니다.
5. mutating worktree Task인데 integration strategy가 `none`이다.
6. side effect가 `external` 또는 `destructive`다.
7. persisted contract에 fingerprint가 없거나 canonical payload와 일치하지 않는다.
8. version, enum, boolean, array, nullable string 필드의 타입이 schema와 다르다.
9. mutation, side-effect, workspace mode, integration strategy가 서로 모순된다.
10. execution capability가 sandbox, tool 또는 기존 호환 필드와 모순된다.
11. `implementation`, `integration`, `release` Task에 명시적 criterion과 계약 기반 output·mutation 조건이 모두 없다.
12. test Task의 완료 결과에 실제 test command evidence가 없다. 이 항목은 실행 후 Completion Gate에서 판정한다.

검증은 두 경계에서 실행한다.

- claim 전: 실패 시 attempt, worker, Agent, lease를 만들지 않고 `failed` 또는 `blocked_by_policy`로 수렴한다.
- claim 직후: 저장 경쟁이나 손상된 caller payload를 다시 검사하고, 실패 시 같은 claim을 fenced failure로 종료해 `running`에 남기지 않는다.

정상 저장 Task는 metadata에 다음 validation marker를 가진다.

- `contractStatus=validated`
- `contractVersion`
- `contractFingerprint`
- `contractRevision`
- `contractValidatedAt`

Task claim SQL은 `contractStatus=validated`이고 marker fingerprint가 저장 계약 fingerprint와 같을 때만 attempt를 증가시킨다. marker가 없거나 불일치하면 scheduler preflight가 구조화된 configuration/policy failure로 종료한다.

단일 Task의 managed worktree 계약은 repository inspection을 마친 뒤 저장한다. 그래프 Task는 전체 계약 compile/policy 검사와 Run-level workspace preflight가 성공한 뒤 하나의 transaction으로 저장한다. 실제 worktree는 claim 이후에만 생성한다.

외부·파괴적 side effect는 dashboard나 계약 복구 UI에서 승인할 수 없다. 별도 사용자 요청과 별도 실행 경계가 필요하다.

## Run authorization

사용자의 Control Plane 요청은 부모 Run을 한 번 승인한다. 다음 구성요소는 그 권한을 상속하며 별도 Start를 요구하지 않는다.

- dependency Task
- Validator
- retry와 validator feedback 기반 rework
- artifact finalize와 계약에 포함된 integration

이 권한은 요청 범위를 넓히지 않는다. 원격 시스템 변경, 파괴적 작업, 새 후속 작업은 상속되지 않는다.

## Workspace rules

### Shared

- 비변경 작업의 기본 workspace다.
- shared mutation은 project-scoped writer lease를 획득해야 한다.
- 직접 변경이므로 별도 artifact integration은 없다.

### Managed worktree

- 병렬 mutation의 기본 workspace다.
- dirty main workspace는 사용자 index를 바꾸지 않는 임시 index로 synthetic baseline commit을 만든다.
- worker 결과는 commit과 binary patch artifact로 finalize한다.
- `patch`: `git apply --check` 후 main workspace에 적용한다.
- `commit`: main workspace가 clean일 때만 check 후 cherry-pick한다.
- conflict 시 cherry-pick을 abort하고 artifact/worktree를 `integration_blocked`로 보존한다.

`mutatesWorkspace=true`이고 계약이 workspace 변경 output을 요구하면 빈 diff는 성공이 아니다. Worktree integration이 끝난 것과 제품 작업이 완료된 것은 구분한다. 계약이 요구하면 destination workspace에서 postcondition을 다시 확인한 뒤 Completion Gate가 terminal 상태를 결정한다.

## Completion boundary

실행 계약은 성공 자체를 선언하지 않는다. terminal Turn 이후 [COMPLETION_GATE.md](./COMPLETION_GATE.md)가 명령, output, workspace, validation, integration과 postcondition evidence를 같은 contract fingerprint에 결합한다. `completeClaim()` 계열 상태 변경은 유효한 CompletionVerdict 없이 성공 상태를 만들 수 없어야 한다.

## Role and routing separation

- role template은 developer instruction, capabilities, tools, model/effort 선호를 제공한다.
- Router는 project, role, capabilities, tools, branch, contract compatibility, availability를 비교한다.
- capability와 tool 요구는 가산점이 아니라 eligibility 조건이다.
- Router는 계약보다 강한 sandbox를 임의로 부여하거나 side-effect policy를 바꿀 수 없다.
- `reuseExisting=true`일 때만 eligible idle thread에 append한다. leased/busy/unsafe thread는 fork 또는 새 thread로 대체한다.

## Contract repair

terminal Task가 권한·workspace 설정 오류로 끝나면 sandbox, network, execution capabilities, workspace mode, integration strategy를 명시적으로 수정해 해당 Task를 다시 queue할 수 있다.

- 이전 contract와 failure는 history에 보존한다.
- 새 fingerprint와 변경 필드를 기록한다.
- 외부·파괴적 side effect는 repair로 허용하지 않는다.
- Run 전체나 이미 성공한 sibling Task를 다시 시작하지 않는다.

## 변경 규칙

계약 필드나 기본값을 변경할 때는 다음을 함께 갱신한다.

- compiler와 assertion
- Planner schema/prompt
- MCP input schema
- Router compatibility check
- persisted metadata와 dashboard projection
- contract fingerprint 호환 정책
- 단위 및 E2E 테스트
