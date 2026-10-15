// 게이트 B — 바쁜 크루 보류(F2) 시나리오를 이 체크아웃 코드로 돌려 칸별 수치를 JSON으로 낸다(npm test에 들지 않는다: *.test.mjs가 아니다).
// 배포본 체크아웃과 새 코드 체크아웃에서 각각 `GATE_OUT=파일 node test/msgr-busy-hold.gate.mjs`로 돌려 비교한다(경우 표: PR 본문).
// 시간은 줄여서 돈다: 턴 2초, 보류 재조회 1.5초(운영 15초). 지연은 '앞 답 게시 → 다음 턴 시작'.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-busy-gate-'));
process.env.ARGO_ENC_VAULT = '0';
const M = await import('../src/gateway/msgr.mjs');
const Q = await import('../src/gateway/queue.mjs');
const { paths } = await import('../src/workspace.mjs');
const H = await import('./helpers/msgr-busy-harness.mjs');

const TURN = 2000, POLL = 1500;
const gaps = (server, starts) => server.posted.slice(0, -1).map((p, i) => { const next = starts.find((s) => s.id === server.posted[i + 1]?.msgId); return next ? next.at - p.at : null; });
const summary = (server, devs) => ({
  order: server.posted.map((p) => p.msgId), by: server.posted.map((p) => p.who),
  replies: Object.fromEntries([...new Set(server.posted.map((p) => p.msgId))].map((id) => [id, server.posted.filter((p) => p.msgId === id).length])),
  cursor: server.row.cursor_msg_id, calls: server.counts, drains: Object.fromEntries(devs.map((d) => [d.name, d.dev.stats().drains])),
  starts: Object.fromEntries(devs.map((d) => [d.name, d.dev.starts.map((x) => x.id)])),
});

async function scenario(name, ws, body) {
  await H.seedCompany(paths, ws);
  const server = H.makeServer();
  const out = await body(server, ws);
  return { name, ...out };
}
const results = [];

// S0 유휴 — 크루 한가·새 글 없음, 6초 동안 브리지가 돈다(보류가 없으면 폴링도 없다)
results.push(await scenario('S0 idle', 'gate-s0', async (server, ws) => {
  const A = await H.startDevice({ M, Q, server, who: 'A', ws, turnMs: TURN, pollMs: POLL });
  await A.drainOnce(); await H.sleep(6000); A.kill();
  return summary(server, [{ name: 'A', dev: A }]);
}));

// S1 한 글 — 도착 → 답
results.push(await scenario('S1 one', 'gate-s1', async (server, ws) => {
  const A = await H.startDevice({ M, Q, server, who: 'A', ws, turnMs: TURN, pollMs: POLL });
  const t0 = Date.now(); server.send(); await A.drainOnce();
  await H.waitPosted(server, 1); A.kill();
  return { ...summary(server, [{ name: 'A', dev: A }]), firstStartMs: A.starts[0] ? A.starts[0].at - t0 : null };
}));

// S2 바쁜 동안 뒤 글 3개 — 순서·각 1회·앞 답 → 다음 턴 시작 지연
results.push(await scenario('S2 busy+3', 'gate-s2', async (server, ws) => {
  const A = await H.startDevice({ M, Q, server, who: 'A', ws, turnMs: TURN, pollMs: POLL });
  server.send(); await A.drainOnce(); await H.sleep(500);
  for (let i = 0; i < 3; i++) { server.send(); await A.drainOnce(); await H.sleep(100); }
  await H.waitPosted(server, 4); await H.sleep(300); A.kill();
  return { ...summary(server, [{ name: 'A', dev: A }]), gapsMs: gaps(server, A.starts) };
}));

// S3 한 번에 3개(크루 한가)
results.push(await scenario('S3 burst3', 'gate-s3', async (server, ws) => {
  const A = await H.startDevice({ M, Q, server, who: 'A', ws, turnMs: TURN, pollMs: POLL });
  server.send(); server.send(); server.send(); await A.drainOnce();
  await H.waitPosted(server, 3); await H.sleep(300); A.kill();
  return { ...summary(server, [{ name: 'A', dev: A }]), gapsMs: gaps(server, A.starts) };
}));

// F2' 바쁜 동안 뒤 글 → A 강제 종료 → B(한가, 같은 회사)가 drain
results.push(await scenario("F2' failover", 'gate-f2', async (server, ws) => {
  const A = await H.startDevice({ M, Q, server, who: 'A', ws, turnMs: 4000, pollMs: POLL });
  server.send(); await A.drainOnce();
  while (!A.starts.length) await H.sleep(50); // A가 첫 글(m11) 실행권을 잡고 턴을 시작했다
  server.send(); await A.drainOnce(); await H.sleep(200);
  A.kill(); // 첫 턴(m11)은 A가 실행권을 잡았다 — 끝까지 돌아 답은 남는다(실행 중 꺼짐 F3는 이 시나리오 밖)
  const B = await H.startDevice({ M, Q, server, who: 'B', ws, turnMs: 500, pollMs: POLL, queue: false });
  await B.drainOnce(); await H.waitPosted(server, 2, 8000); B.kill();
  return summary(server, [{ name: 'A', dev: A }, { name: 'B', dev: B }]);
}));

const { writeFile } = await import('node:fs/promises');
await writeFile(process.env.GATE_OUT || 'gate-busy-hold.json', JSON.stringify(results, null, 1)); // 앱 로그가 표준 출력에 섞이므로 파일로
process.exit(0);
