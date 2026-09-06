# 후속 실행 증거 충돌 수정 — 2026-09-06

## 원인과 수정

Fold와 Workspace의 최근 실행은 각각 명령 여러 개를 포함한 shell invocation 하나에서 충돌로 오판정됐다. 기존 보정은 commandActions가 하나일 때만 구조화된 command를 비교했고, 둘 이상이면 단순 문자열 비교로 되돌아갔다. 앱 표시 문자열의 따옴표/역슬래시 escaping 때문에 같은 원본 argv를 다르다고 판단했다.

- Fold: Turn `01a07530-04ee-73c3-abc0-3d45d47d9a06`, item `exec-1400695e-5663-465a-9409-092ba0811ffc`.
- Workspace: Turn `01a07530-60bc-7b00-ab2b-753a7d27dc4f`, item `exec-992897c9-699c-473a-8c04-b7a504790de2`.

두 항목의 native 원본과 저장된 projection은 cwd, process ID, exit 0 및 aggregated output이 일치했다. 새 코드는 표시 문자열의 literal shell argv를 실행 없이 해석해 native argv 전체와 비교한다. script 내부 연산자는 재구성하거나 의미상 동일하다고 추론하지 않는다. cwd/process 검사도 모든 비교 경로에 적용한다. 확장·추가 명령·연산자 변경·잘못된 실행 경로/종료 코드/출력은 여전히 거절한다.

실제 두 사례를 사용자 경로만 익명화한 회귀 fixture로 추가했다. 원본 기록 재독 결과는 [JSON](MULTI_ACTION_RECONCILIATION_2026-09-06.json)에 있다. 각 31개 실행 항목, Fold 8개/Workspace 12개 worker receipts를 보존하며 각각 충돌 1→0이다. 작업과 명령을 재실행하지 않은 증거 비교이며 과거 판정을 소급 수정하지 않았다.

Fold 수정 중단은 요청 작성자의 모호한 문구도 원인이었다. `플러그인 구현 자체는 수정하지 마세요`가 실행 플러그인만 제외하려던 의도와 달리 ThreadFold 제품 구현까지 금지하는 것으로 읽혔다. 런타임 실행 계약은 workspace-write였고 실제 승인 거절이 아니었다. 스킬에 금지 대상을 정확한 프로젝트 경로로 지정하고 허용된 제품 수정을 명시하도록 추가했다.

## 제품 보완

Fold COV-01은 현재 consolidation의 conflicts에 들어간 claim ID들을 coverage.status=conflict로 반영하도록 수정했다. 원문/evidenceRefs 보존 및 비충돌 상태를 기존 회귀에 추가했고 이전 발행 기록과 로그는 재작성하지 않았다. 상세: ../threadfold/docs/COV01_REPAIR_2026-09-06.md.

Workspace가 참조하는 Hub 파일 4개와 Fold model 1개의 변경 전후 해시를 docs/verification/incident-repair/pin-update.json에 보존하고 현재 검증된 파일로 lock을 갱신했다. 이전 lock은 같은 폴더 workspace-lock-before.json으로 보존했다. commit 값은 원래 기반 커밋이며 uncommitted 구현의 정확한 내용은 files 해시가 고정한다. native 호스트 지원을 승격하지 않았다.

## 이번 실행 검증

- Hub 전체 node --test: exit 0, 374/374, 실패/취소/skip/todo 0, 31603.44175 ms. 원출력: [log](MULTI_ACTION_TESTS_2026-09-06.log).
- Fold 전체 node --test: exit 0, 76/76, 실패/취소/skip/todo 0, 10798.561458 ms. 제품 docs/verification/2026-09-06-continuation/coverage-fix-tests.log.
- Workspace 전체 node --test: exit 0, 33/33, 실패/취소/skip/todo 0, 1755.367417 ms. 제품 docs/verification/incident-repair/full-tests.log.
- Workspace fixture demo: shell 완료 exit 0, 정리/복원 applied; nativeThreadsCreated/nativeArchives는 0. 원출력 같은 폴더 demo.log.
- Workspace source pins: 원본 2개 해시 및 Hub 47/Graph 28/Fold 7/Port 11개 일치 출력. 같은 폴더 source-pins.log. 구조·로컬 일치 검증이며 native handshake가 아니다.
- 공식 실행 플러그인 구조 검증 및 수정 스킬 quick_validate 통과.
- 소스/설치 runtime parity: missing/extra/changed 모두 빈 배열, identical=true.
- 설치본으로 두 원본 기록을 다시 읽어 각각 충돌 0 확인.

명령 도구 패치 한 번은 마지막 skill 문맥이 맞지 않아 전체 적용 전에 거절됐고 정확한 문맥으로 다시 적용했다. runtime-parity의 미지원 --help 조회는 usage 오류였으며 이후 올바른 --target을 사용한 실제 검증은 통과했다. 이 진단 오류를 테스트 실패 또는 성공 영수증으로 바꾸지 않는다.

## 설치와 보존 경계

설치 버전 `0.6.0+codex.20260906055409`, runtime `0.14.0+5eae32ab7324`, protocol 2, 시작 2026-09-06T05:54:22.864Z, healthy. 교체 전 activeTasks=0, live cache proxies=0을 확인했다.

이번 수리에서 제품 task/Run/worker를 새로 만들거나 재시작하지 않았다. 과거 registry의 failed/rejected 기록을 그대로 보존했다. 로컬 수정과 기록 재조정은 새 독립 validator 수용 판정이 아니므로 기존 실패를 성공으로 표기하지 않는다. Port의 기존 조건부 수용을 유지한다. G0/G3, 실제 Hub 정리/승인/복원, native 이전, 설치/UI·계정 간 재개는 여전히 미검증이다. 새 스킬은 새 대화의 카탈로그부터 읽히며 runtime 수정은 현재 설치본에 이미 적용됐다.
