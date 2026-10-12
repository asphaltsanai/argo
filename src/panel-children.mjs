// 오피스 패널 턴의 동기 위임(2단계 PR3)으로 띄운 동료 턴 등록부 — 패널의 '중단'(원본 글 id 기준)이 조율자만이 아니라 그 동료 턴도 멈추게(검수 M2).
// 동료 턴은 다른 slug·다른 control이라 조율자 중단(interruptTurn slug+tag)으로는 닿지 않는다. 등록은 위임하는 동안만, 끝나면 지운다(쌓이지 않는다).
// globalThis: Next 라우트 번들 사본끼리 한 등록부(turn-abort.mjs와 같은 방식).
import { interruptTurn } from './turn-abort.mjs';

const CHILDREN = (globalThis.__argoPanelChildren ??= new Map()); // `${wsId}:${msgId}` → Map(slug → 수)
export const panelChildTag = (msgId) => `panel:${msgId}`;

/** 위임 시작·끝에 부른다. 반환: 지우는 함수 */
export function trackPanelChild(wsId, msgId, slug) {
  const k = `${wsId}:${msgId}`;
  const m = CHILDREN.get(k) ?? new Map(); m.set(slug, (m.get(slug) ?? 0) + 1); CHILDREN.set(k, m);
  return () => { const cur = CHILDREN.get(k); if (!cur) return; const n = (cur.get(slug) ?? 1) - 1; if (n > 0) cur.set(slug, n); else cur.delete(slug); if (!cur.size) CHILDREN.delete(k); };
}

/** 패널 원본 글의 중단 — 그 글에서 띄운 동료 턴을 모두 멈춘다. 반환: 멈춘 동료 수 */
export async function stopPanelChildren(wsId, msgId) {
  const m = CHILDREN.get(`${wsId}:${msgId}`);
  if (!m) return 0;
  const hits = await Promise.all([...m.keys()].map((slug) => interruptTurn(wsId, slug, { source: 'delegate', tag: panelChildTag(msgId) }).catch(() => false)));
  return hits.filter(Boolean).length;
}
