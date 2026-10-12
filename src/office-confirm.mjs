// 되돌리기 어려운 오피스 동작 판정 한 곳 — argo office CLI·MCP의 승인(office-tools-cli.mjs)과 오피스 패널 확인 카드(gateway/office-proposals.mjs)가 같이 쓴다.
// 의존 없는 작은 모듈로 둔다 — 게이트웨이(msgr.mjs)가 가져오므로 무거운 도구 모듈을 끌어오지 않게.
/** 되돌리기 어려운 동작 — 바깥(CLI·MCP)에서는 사람이 승인한 뒤에만 실행한다(유건 10/11 "승인 받고 진행").
    CLI는 터미널 확인 질문, MCP는 붙은 클라이언트의 확인 창(elicitation). 둘 다 못 하면 실행하지 않는다. 아르고 본체 에이전트는 이 규칙 밖(자기 결재 흐름).
    반환: 무엇을 바꾸는지 한 문장 | null(확인 없이 실행) */
export function confirmNeeded(name, a = {}, lang = 'ko') {
  const say = (ko, en) => (lang === 'en' ? en : ko);
  const id = a.id ? ` (id ${a.id})` : '';
  if (name === 'office_deals' && a.action === 'deal_next' && a.to === 'contract') return say(`거래를 계약 확정으로 넘깁니다${id}.`, `Moves the deal to a confirmed contract${id}.`);
  if (name === 'office_deals' && a.action === 'deal_next' && a.to === 'cancel') return say(`거래를 취소합니다${id}.`, `Cancels the deal${id}.`);
  if (name === 'office' && a.action === 'eval_add') return say(`평가를 기록합니다(대상: ${a.subject_name || a.subject_user || '?'}).`, `Records an evaluation (subject: ${a.subject_name || a.subject_user || '?'}).`);
  if (name === 'office_briefing' && a.action === 'brief_add' && a.recipient === 'org') return say('조직 전체에 브리핑을 보냅니다.', 'Sends a briefing to the whole organization.');
  if (name === 'office_work' && a.action === 'page_edit' && a.mode === 'replace') return say(`페이지 본문을 통째로 바꿉니다${id}.`, `Replaces the whole page body${id}.`);
  if (name === 'office_work' && a.action === 'task_set' && a.note_mode === 'replace' && a.note != null) return say(`할 일 메모를 통째로 바꿉니다${id}.`, `Replaces the whole task note${id}.`);
  if (name === 'office_files' && a.action === 'drive_export') return say(`문서함 파일을 구글 드라이브로 내보냅니다${id}.`, `Exports the Office file to Google Drive${id}.`);
  return null;
}
