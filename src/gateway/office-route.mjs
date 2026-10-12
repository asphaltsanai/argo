// 오피스 패널 직무별 배분(2단계 PR3, 유건 10/10 요구 2·3 "에이전트를 따로 고르지 않고 대화창 하나로", 안전장치 "배분 결과를 보이고 바꿀 수 있게").
// 패널 턴의 답하는 에이전트 = 조율자. 같은 워크스페이스 동료를 delegate(동기 — chat.mjs가 패널 턴에서 채널 넘김 대신 직접 실행)로 불러 결과를 검토해 답한다.
// 사용자가 패널의 '다른 에이전트에게 맡기기'로 고르면 그 글의 meta.office_route = 동료 이름 — 조율자에게 그 동료에게 맡기라고 알린다.
// office_route는 사람이 쓴 값이라 지시문에는 세척한 이름만 싣고, 실제 대상은 delegate가 동료 명단(같은 워크스페이스)에서만 찾는다.
const ROUTE_MAX = 40;

/** 패널 글의 '맡길 동료' 이름 — 한 줄·40자 안, 없으면 null */
export function routeOf(message) {
  const v = message?.meta?.office_route;
  if (typeof v !== 'string') return null;
  const name = v.replace(/[\r\n\t\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  return name && name.length <= ROUTE_MAX ? name : null;
}

/** 조율자 지시 — 패널 턴 머리말 뒤에 붙는다 */
export function panelCoordinatorHint(route = null, lang = 'ko') {
  const name = route ? JSON.stringify(route) : null;
  if (lang === 'en') return `\n[Office agent panel: you coordinate this request. If a colleague's role fits it better, hand that part to them with delegate (you get their result in this turn), review it and answer here. If you delegated, start your reply with one line naming who handled it and their role.${name ? ` The user chose ${name} for this request — delegate it to that colleague (match by name or slug); if no such colleague exists, say so and do it yourself.` : ''}]`;
  return `\n[오피스 에이전트 창: 너는 이 요청의 조율자다. 직무가 더 맞는 동료가 있으면 그 부분을 delegate로 맡기고(이 턴 안에 결과가 돌아온다) 검토해서 여기서 답하라. 맡겼으면 답 첫 줄에 누가(직무) 맡았는지 한 줄로 밝혀라.${name ? ` 사용자가 이 요청을 ${name}에게 맡기라고 골랐다 — 그 동료에게 delegate로 맡겨라(이름이나 slug로 찾는다). 그런 동료가 없으면 그렇다고 알리고 직접 하라.` : ''}]`;
}
