# 위젯보드 한국어 문구 기준

`ui/locales/ko/**/*.json`과 한국어 도움말에 적용하는 문체와 용어입니다. 2026-11-08 문구 정비에서 정했습니다.
기계 검사용 사본은 `tools/glossary.json`이고 `node tests/copy-glossary.mjs`가 위반을 `키: 문구`로 출력합니다.

## 1. 문체

| 규칙 | 적용 |
| --- | --- |
| 해요체 | 지시·안내는 ~하세요, 오류 뒤 행동은 ~해 주세요. 상태·결과는 ~했어요/~이에요. 확인 질문은 ~하시겠어요? |
| 외래어 기본 | 드래그, 캘린더, 볼륨, 트랙, 이미지, 프레임 없음 |
| 테두리 예외 | outline = 테두리. frame decoration = 장식 프레임 |
| 플레이스홀더 조사 금지 | `{x}(으)로`, `{x}을(를)` 대신 따옴표로 감싸고 조사를 빼거나 어순을 바꿉니다 |
| 마침표 | 토스트·상태·설정 설명은 끝 마침표 없음. 두 문장 이상이면 사이에만 찍습니다. 메뉴·버튼·탭·제목은 마침표 없음. `help.json` 본문은 문단 글이라 마침표를 다 찍습니다 |
| 따옴표·키 이름 | UI 요소는 ‘ ’로 묶습니다. Tab, Enter, Esc, Delete, Shift+방향키는 영문 그대로 |
| 수량 | {n}개 / {n}장(이미지) / {n}트랙 / {n}초 / {n}분 / 30MB |
| 메뉴 경로 | `설정 > 일반` |

## 2. 용어집 (표준어 → 금지 변형)

| 개념 | 표준어 | 금지 변형 | 비고 |
| --- | --- | --- | --- |
| Edit layout (mode) | 편집 모드 | 레이아웃 편집 | 위젯 이동·크기 변경 상태 |
| Layout preset | 위젯 프리셋 | 레이아웃, 배치 | 업무용·공부용·덕질용 + 저장한 것. `lay.*` |
| Layout export (PNG) | 보드 캡처 | 레이아웃 내보내기 | `export.name`은 파일 이름 앞말이라 ‘보드 캡처’ |
| Layout mode (grid/free) | 위젯 배치 방식 | 레이아웃 방식 | 격자 맞춤 / 자유 배치 |
| Image layout | 미리보기 방식 | 레이아웃 | 이미지 위젯: 슬라이드쇼 / 갤러리 |
| Widget library window | 위젯 보관함 | 위젯 메뉴 | 영어는 Widget menu 유지 |
| Widget right-click menu | 우클릭 메뉴 | 위젯 메뉴 | 도움말 지칭 |
| Tray menu / icon | 트레이 메뉴 / 트레이 아이콘 | 작업 표시줄 메뉴 | |
| Notes (group) | 노트 | 기록 | |
| History (memo versions) | 변경 기록 | 기록 | 설정: 메모 변경 기록 / 변경 기록 남기기 |
| Records tab (time log) | 기록 | | `lib.records_tab` |
| Laps | 랩 | 랩 기록 | |
| Focus (time category) | 집중 | | 반대말은 기타 |
| Focus mode | 이 위젯만 보기 / 전체 보기 | 집중 모드 | |
| Appearance (settings tab) | 테마 | 모양 | |
| Widget appearance (dialog) | 위젯 꾸미기 | 모양, 위젯 모양 | 메뉴 항목 ‘꾸미기…’ |
| Frame style dropdown | 프레임 꾸미기 | 모양 | 꾸미기 창 안 |
| Outline | 테두리 | 테두리 선 | |
| Frame decoration | 장식 프레임 | 테두리 장식 | |
| Frameless | 프레임 없음 | 액자 없이 | |
| Calendar | 캘린더 | 달력 | |
| Calendar entry | 일정 | 이벤트 | |
| Checklist item | 할 일 | 항목, 목표 | 체크리스트 문구 안에서 |
| Planning (group) | 플래너 | 일정 | |
| Images (group), image widget | 이미지 | 사진 | Windows ‘사진 폴더’는 예외 |
| Grid (image widget) | 갤러리 | 그리드 | |
| Track / Volume | 트랙 / 볼륨 | 곡 / 음량 | |
| Drag | 드래그 | 끌어, 끌어다 | |
| Show / Hide (verb) | 보이기 / 숨기기 | 표시(동사) | ‘항상 표시’ 같은 상태 명사는 허용 |
| Keep on top | 항상 위에 | 항상 위에 표시 | |
| Close (widget) | 삭제 | 닫기 | 보드에서 빼면 최근 삭제로 감 (소프트 삭제). 창·배너를 닫는 버튼은 닫기 |
| Recently deleted | 최근 삭제 | 최근 삭제된 항목 | |
| Delete permanently | 완전 삭제 | 영구 삭제 | |
| Restore (bin) | 복구 | 복원 | `lib.*` |
| Restore (backup) | 복원 | | |
| Undo (toast) | 실행 취소 | 되돌리기 | |
| Undo theme / preset | 이전 테마로 / 이전 프리셋으로 | 되돌리기 | |
| Reset | 초기화 | 되돌리기, 새로 세기 | |
| Pause / Stop / Resume | 일시정지 / 정지 / 재개 | 계속 | |
| Set (verb) | 설정 | 정하기, 지정 | ‘사용자 지정 휴일’은 유지 |
| Tutorial / Demo / Guide | 튜토리얼 / 체험 / 가이드 | 연습 | |
| Monitor | 모니터 | 디스플레이, 화면 | 화면은 ‘화면에서 사라져요’처럼 표면을 뜻할 때만 |
| Grid mode | 격자 맞춤 | 칸에 맞춤 | |
| Change widget type | 위젯 종류 바꾸기 | 다른 위젯으로 바꾸기 | |
| Slideshow interval | 전환 간격 | 슬라이드쇼 전환 시간 | |

삭제 모델: `menu.close` 삭제 → 위젯 보관함 > 최근 삭제 (복구 가능) → `lib.erase` 완전 삭제.

## 3. 손대지 않는 것

`_name`, 공휴일 이름, 샘플 데이터(`demo.sample.*`, `lay.sample.*`), `ck.stamp_*`, 테마 폴더 이름(`themes.seed.*`), 접근성 섹션 제목(`set.g.*`), `set.cal.custom`, `set.cal.excluded`.
