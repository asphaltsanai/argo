// 오피스 패널 단계 보기(2단계 PR2, 유건 10/10 요구 4 "처리 과정을 펼쳐 볼 수 있다"). 진행 중에는 progress 방송(DB 0)에 이 턴의 최근 단계를 싣고,
// 끝나면 답 글 meta.office_steps에 요약(최대 20단계)만 남긴다 — 글자 단위 흐름·생각 원문은 싣지 않는다(9/23 DB 사고와 같은 쓰기 폭주 방지).
// 단계 = 작업 과정 기록(turn-trace, 이 턴의 control에 붙은 기록)의 도구 단계 { stage, detail } — 크루당 하나인 상태 파일이 아니라 턴별 기록이라 다른 턴과 섞이지 않는다.
// detail은 turn-status detailForTool이 가린 값(비밀 가림)이다. 주인 혼자 보는 1:1에서만 싣는다(msgr.mjs가 ownerSoloRoom으로 확인).
export const LIVE_STEPS = 12;
export const KEPT_STEPS = 20;
const DETAIL_MAX = 80;

const clip = (v) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s.length > DETAIL_MAX ? `${s.slice(0, DETAIL_MAX)}…` : s; };

/** 기록기 → 화면용 단계 목록 [{ stage, detail }] (최근 n개). 기록기가 없거나 단계가 없으면 [] */
export function panelSteps(trace, n = LIVE_STEPS) {
  if (!trace || typeof trace.compact !== 'function') return [];
  return trace.compact(n).map((s) => ({ stage: String(s.stage ?? 'work'), detail: clip(s.detail) }));
}

/** 답 글 meta에 실을 단계 요약 — 도구 단계가 없으면 싣지 않는다 */
export function stepsMeta(trace) {
  const n = trace?.toolCount ?? 0;
  return n > 0 ? { office_steps: { n, steps: panelSteps(trace, KEPT_STEPS) } } : {};
}
