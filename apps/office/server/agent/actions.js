// 원격 MCP 쓰기 판정과 승인 카드 문구(2026-10-13 오피스 분리) — 본체 gateway/office-proposals.mjs의 쓰기 목록·카드 한 줄과 office-confirm.mjs의 되돌리기 어려운 동작 문장을 옮겼다.
// 원격 MCP의 쓰기는 전부 바로 실행하지 않고 대기 변경(office_agent_actions)으로 올린다 — 사람이 오피스 화면에서 [실행]을 눌러야 실행된다.

/** 쓰기 동작 — 나머지(목록·읽기)는 바로 실행한다 */
export const WRITES = {
  calendar: ['create', 'update', 'delete'],
  office: ['company_set', 'eval_add'],
  office_files: ['attach', 'drive_import', 'drive_mkdir', 'drive_export'],
  office_work: ['task_add', 'task_set', 'page_add', 'page_edit'],
  office_deals: ['customer_add', 'customer_set', 'deal_add', 'deal_next', 'deal_due'],
  office_mail: ['mail_draft', 'mail_star'],
  office_briefing: ['brief_add'],
};
export const isWrite = (name, a) => !!WRITES[name]?.includes(a?.action);

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

const clip = (v, n = 60) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n)}…` : s; };

/** 카드에 보일 한 줄 — 사용자가 무엇을 승인하는지 알 수 있게 동작과 대상을 적는다 */
export function proposalSummary(name, a = {}, lang = 'ko') {
  const say = (ko, en) => (lang === 'en' ? en : ko);
  const risky = confirmNeeded(name, a, lang);
  if (risky) return risky;
  const t = clip(a.title), id = a.id ? ` (id ${clip(a.id, 40)})` : '';
  switch (`${name}.${a.action}`) {
    case 'calendar.create': return say(`일정 만들기: ${t || '(제목 없음)'}${a.start ? ` · ${clip(a.start, 20)}` : ''}`, `Create event: ${t || '(untitled)'}${a.start ? ` · ${clip(a.start, 20)}` : ''}`);
    case 'calendar.update': return say(`일정 고치기${t ? `: ${t}` : ''}${id}`, `Update event${t ? `: ${t}` : ''}${id}`);
    case 'calendar.delete': return say(`일정 삭제${id} — 되돌릴 수 없습니다`, `Delete event${id} — cannot be undone`);
    case 'office.company_set': return say(`회사 정보 고치기: ${clip(a.label || a.key || a.id, 30)}`, `Update company info: ${clip(a.label || a.key || a.id, 30)}`);
    case 'office_files.attach': return say(`문서함에 올리기: ${clip(a.title || a.path)}`, `Upload to Office files: ${clip(a.title || a.path)}`);
    case 'office_files.drive_import': return say('드라이브 파일을 문서함으로 가져오기', 'Import a Drive file into Office files');
    case 'office_files.drive_mkdir': return say(`드라이브 폴더 만들기: ${clip(a.name)}`, `Create Drive folder: ${clip(a.name)}`);
    case 'office_work.task_add': return say(`할 일 추가: ${t}${a.due_on ? ` · 기한 ${clip(a.due_on, 12)}` : ''}`, `Add task: ${t}${a.due_on ? ` · due ${clip(a.due_on, 12)}` : ''}`);
    case 'office_work.task_set': return say(`할 일 고치기${a.status === 'done' ? '(끝내기)' : ''}${t ? `: ${t}` : ''}${id}`, `Update task${a.status === 'done' ? ' (finish)' : ''}${t ? `: ${t}` : ''}${id}`);
    case 'office_work.page_add': return say(`페이지 만들기: ${t || '(제목 없음)'}`, `Create page: ${t || '(untitled)'}`);
    case 'office_work.page_edit': return say(`페이지에 덧붙이기${id}`, `Append to page${id}`);
    case 'office_deals.customer_add': return say(`거래처 추가: ${clip(a.name)}`, `Add customer: ${clip(a.name)}`);
    case 'office_deals.customer_set': return say(`거래처 고치기${a.name ? `: ${clip(a.name)}` : ''}${id}`, `Update customer${a.name ? `: ${clip(a.name)}` : ''}${id}`);
    case 'office_deals.deal_add': return say(`거래 추가: ${t}`, `Add deal: ${t}`);
    case 'office_deals.deal_next': return say(`거래 단계 넘기기(${clip(a.to, 12)})${id}`, `Move deal stage (${clip(a.to, 12)})${id}`);
    case 'office_deals.deal_due': return say(`입금 예정일 바꾸기: ${clip(a.due_on, 12)}${id}`, `Set payment due date: ${clip(a.due_on, 12)}${id}`);
    case 'office_mail.mail_draft': return say(`메일 초안 쓰기${a.subject ? `: ${clip(a.subject)}` : ''}${a.to ? ` → ${clip(a.to, 40)}` : ''}`, `Write mail draft${a.subject ? `: ${clip(a.subject)}` : ''}${a.to ? ` → ${clip(a.to, 40)}` : ''}`);
    case 'office_mail.mail_star': return say(`메일 별표 ${a.starred === false ? '떼기' : '달기'}${id}`, `${a.starred === false ? 'Unstar' : 'Star'} mail${id}`);
    case 'office_briefing.brief_add': return say(`브리핑 쓰기: ${t || '(제목 없음)'}`, `Write briefing: ${t || '(untitled)'}`);
    default: return say(`오피스 ${name} ${a.action}`, `Office ${name} ${a.action}`);
  }
}
