// 문맥 없이 도는 메신저 턴의 셸 결재 게이트(msgrShellGate)와 출처 표지(notOwnerDirect)가 재시도에서도 이어지는가(검수 1 재검수 A, #992).
// chat.mjs의 재시도 호출(러너 충돌·잠김·자가 치유 대체 러너·새 세션·모델 낮춤)은 옵션을 하나씩 나열해 chat()을 다시 부른다 — 하나라도 빠뜨리면
// 보관한 옛 1:1에서 옮긴 이어 실행이 재시도에서 메신저 고위험 셸 분류(D28)를 잃고, 풀 오토가 열린다. 실제 chat()을 가짜 CLI 러너로 돌려
// 매 실행의 권한 게이트(makePermissionGate)에 넘어간 값을 본다(가짜 러너는 chat-steer-cli.test.mjs와 같은 로더 훅 기법).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.HOME = process.env.USERPROFILE = await mkdtemp(join(tmpdir(), 'argo-gate-retry-home-'));
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-gate-retry-'));
process.env.ARGO_CACHE_DIR = join(process.env.ARGO_ROOT, 'cache');
process.env.ARGO_MODEL_CATALOG = process.env.ARGO_NATIVE_RUNNERS = 'off';
const fetchBefore = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Network disabled in gate retry test'); };
const execs = []; const gates = [];
let onExec = async () => 'reply';
globalThis.__gateRetryExec = async (args) => { execs.push(args); return onExec(execs.length, args); };
globalThis.__gateRetrySeen = (from, opts) => gates.push({ from, msgr: opts?.msgr });
const real = new URL('../src/runners.mjs', import.meta.url).href;
const runners = `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(real)};
  export const resolveRunner = async () => ({runner:'codex',available:true,fellBack:false});
  export const runnerCredType = async () => 'host'; export const runnerCredEnv = async () => ({});
  export const isBilledRunner = async () => false;
  export const externalExec = (args) => globalThis.__gateRetryExec(args);`)}`;
const gateReal = new URL('../src/permission-gate.mjs', import.meta.url).href;
const gate = `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(gateReal)};
  import { makePermissionGate as real } from ${JSON.stringify(gateReal)};
  export function makePermissionGate(wsId, slug, root, from, lang, roots, opts) { globalThis.__gateRetrySeen(from, opts); return real(wsId, slug, root, from, lang, roots, opts); }`)}`;
const connectors = `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(new URL('../src/connectors.mjs', import.meta.url).href)}; export const connectorBriefing = async () => [];`)}`;
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/src/chat.mjs') && specifier === './runners.mjs') return { url: runners, shortCircuit: true };
  if (context.parentURL?.endsWith('/src/chat.mjs') && specifier === './permission-gate.mjs') return { url: gate, shortCircuit: true };
  if (context.parentURL?.endsWith('/src/chat.mjs') && specifier === './connectors.mjs') return { url: connectors, shortCircuit: true };
  return next(specifier, context);
} });
after(() => { hooks.deregister(); globalThis.fetch = fetchBefore; delete globalThis.__gateRetryExec; delete globalThis.__gateRetrySeen; });
const { createCompany, paths } = await import('../src/workspace.mjs');
const { chat } = await import('../src/chat.mjs');

let n = 0;
async function setup() {
  const ws = `gate-retry-${++n}`;
  await createCompany(ws, 'Gate retry fixture', 'owner');
  await mkdir(paths(ws).agents, { recursive: true });
  await writeFile(join(paths(ws).agents, 'alpha.md'), '---\nname: Alpha\nrunner: codex\n---\nFixture agent');
  execs.length = 0; gates.length = 0;
  return ws;
}

test('러너가 충돌해 같은 러너로 다시 돌 때도 메신저 셸 결재 게이트와 출처 표지가 이어진다', async () => {
  const ws = await setup();
  onExec = async (i) => { if (i === 1) throw new Error('Codex process exited with code 3221225477'); return '다시 돌아 끝남'; };
  const r = await chat(ws, 'alpha', '정리해 줘', null, { source: 'messenger', msgrShellGate: {}, notOwnerDirect: 'msgr-origin', journal: { off: true } });
  assert.equal(execs.length, 2, `충돌 뒤 한 번 다시 돌았다(실행 ${execs.length}번)`);
  assert.match(String(r.reply ?? ''), /다시 돌아 끝남/);
  assert.ok(gates.length >= 2, `실행마다 권한 게이트(${gates.length}개)`);
  for (const [i, g] of gates.entries()) {
    assert.deepEqual(g.msgr, {}, `${i + 1}번째 게이트도 메신저 셸 결재(D28)가 켜져 있다`);
    assert.equal(g.from, 'msgr-origin', `${i + 1}번째 게이트도 주인 직접 턴이 아니다`);
  }
});

test('대조: 메신저 밖 턴(문맥·게이트 인자 없음)은 재시도에서도 게이트 꺼짐 그대로', async () => {
  const ws = await setup();
  onExec = async (i) => { if (i === 1) throw new Error('Codex process exited with code 3221225477'); return '끝'; };
  await chat(ws, 'alpha', '정리해 줘', null, { journal: { off: true } });
  assert.equal(execs.length, 2);
  assert.ok(gates.length >= 2 && gates.every((g) => g.msgr == null), '게이트 목적지 없음');
});

// 보조 불변식(행동 핀은 충돌 경로 하나만 돈다): 옵션을 나열해 chat()을 다시 부르는 재시도 호출은 runChat이 받는 일반 인자(__로 시작하지 않는 것)를
// 하나도 빠뜨리지 않는다 — 새 인자를 더할 때 재시도 7곳 중 하나를 잊으면 여기서 실패한다(이번 결함의 모양: msgrShellGate가 7곳 모두에서 빠졌다).
test('재시도 호출은 runChat의 일반 인자를 전부 넘긴다(새 인자를 더할 때 빠뜨리지 않게)', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/chat.mjs', import.meta.url), 'utf8');
  const head = src.match(/async function runChat\(wsId, agentSlug, userMsg, sessionId = null, \{([^}]*)\} = \{\}\)/);
  assert.ok(head, 'runChat 인자 목록을 찾는다');
  const params = head[1].split(',').map((x) => x.trim().split(/\s*=\s*/)[0]).filter((x) => x && !x.startsWith('__'));
  assert.ok(params.includes('msgrShellGate') && params.includes('notOwnerDirect') && params.includes('mirrorCtx'));
  const calls = [...src.matchAll(/chat\(wsId, agentSlug, userMsg, [^,]+, \{ (__turnControl[^}]*)\}\)/g)].map((m) => m[1]);
  assert.ok(calls.length >= 7, `재시도 호출 ${calls.length}곳`);
  for (const body of calls) {
    const keys = new Set(body.split(',').map((x) => x.trim().split(':')[0].trim()));
    const missing = params.filter((p) => !keys.has(p));
    assert.deepEqual(missing, [], `재시도 호출이 빠뜨린 인자 ${missing} — ${body.slice(0, 80)}…`);
  }
});
