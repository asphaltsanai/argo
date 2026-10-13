// 최소 앱 버전 판정(src/app-gate.mjs) — 화면의 일시 정지 화면(app/app-gate.jsx)이 묻는다.
// 판정은 데이터 루트 파일 기준이고, 확인 기한(30분)이 지났으면 여기서 서버에 다시 묻는다(막힌 동안에도 — 서버가 값을 낮추면 풀린다).
// 기기 세션은 관문 없는 판본으로 꺼낸다: 막힌 동안에는 관문 있는 판본이 null이라 서버에 물을 수 없다.
import { WS_ROOT } from '../../../src/workspace.mjs';
import { APP_VERSION } from '../../../src/app-version.mjs';
import { appGateState, refreshAppGate, appGateClient } from '../../../src/app-gate.mjs';
import { getFreshDeviceSessionUngated } from '../../../src/devicesession.mjs';

export async function GET() {
  const sess = await getFreshDeviceSessionUngated().catch(() => null);
  if (sess) await refreshAppGate(WS_ROOT, sess, appGateClient).catch(() => {});
  const { blocked, min } = appGateState(WS_ROOT, APP_VERSION);
  return Response.json({ blocked, min, version: APP_VERSION ?? null }, { headers: { 'cache-control': 'no-store' } });
}
