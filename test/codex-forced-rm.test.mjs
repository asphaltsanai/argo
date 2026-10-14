// codex 강제 삭제 거절 안내(셀프호스트 제보 2026-10-14). codex exec 경로는 승인 정책 Never라 codex 자체 정책이 `rm -f`·`rm -rf`를
// 묻지 않고 거절한다("rm -f style commands are not permitted" — codex-rs core exec_policy.rs ForcedRm). Argo 결재 승인은 codex 안으로
// 전달되지 않아, 승인된 폴더 삭제도 막혀 에이전트가 멈췄다. 실행 권한은 새로 열지 않고 두 가지를 더한다:
//  ① codex exec 턴의 지시문에만 "승인된 삭제는 -f 없이 rm -r" 한 줄 — app-server(게이트 경유)·SDK·다른 CLI 턴에는 넣지 않는다.
//  ② 답에 그 거절 문구가 있으면 사용자 안내 한 줄(ko·en) — 파일 권한 안내(fs)는 붙이지 않는다(원인이 권한이 아니다).
// 가짜 codex를 PATH에 두어 실제 chat() CLI 분기를 돌린다(room-work-folder 하네스와 같은 방식) — 프롬프트는 stdin.
import { mkdir, writeFile, chmod, readFile, rm } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = await mkdtemp(join(tmpdir(), 'argo-codex-forced-rm-'));
process.env.ARGO_ROOT = ROOT; // workspace.mjs 임포트 전 — 실데이터 미접촉
Object.assign(process.env, { ARGO_ENC_VAULT: '0', ARGO_MODEL_CATALOG: 'off', ARGO_NATIVE_RUNNERS: 'off' });
delete process.env.ARGO_CODEX_ENGINE;
for (const k of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) delete process.env[k];
const BIN = join(ROOT, 'bin');
const CAP = join(ROOT, 'captured-prompt.txt');
const REPLY = join(ROOT, 'fake-reply.txt'); // 가짜 codex의 마지막 답(시험마다 바꾼다)
await mkdir(BIN, { recursive: true });
await writeFile(join(BIN, 'codex'), `#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex-cli 0.0.0-fake"; exit 0; fi
OUT=""; prev=""; P=""; after=0
for a in "$@"; do
  if [ "$after" = "1" ]; then P="$a"; after=0; fi
  if [ "$prev" = "--output-last-message" ]; then OUT="$a"; fi
  if [ "$a" = "--" ]; then after=1; fi
  prev="$a"
done
[ "$P" = "-" ] && P="$(cat)"
printf '%s' "$P" > "${CAP}"
[ -n "$OUT" ] && cat "${REPLY}" > "$OUT"
exit 0
`);
await chmod(join(BIN, 'codex'), 0o755);
process.env.PATH = `${BIN}:${process.env.PATH}`;
process.env.ARGO_CODEX_PREFER_PATH = '1'; // 관리본(핀)보다 가짜 codex가 잡히게 — 하네스 전용 해치

const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { createCompany, paths } = await import('../src/workspace.mjs');
const { chat, commonDirectives } = await import('../src/chat.mjs');
const { detectForcedRmRejection, forcedRmNote } = await import('../src/runner-denial.mjs');

const WIN_SKIP = process.platform === 'win32' ? 'POSIX 셸 하네스 — 배선 검증은 macOS CI가 담당' : false;
const LINE_KO = '결재로 승인된 뒤에도 마찬가지다. 삭제는 위 결재 규칙대로 결재를 먼저 올리고, 승인된 뒤에는 `-f` 없이 `rm -r <경로>`로 지워라.';
const LINE_EN = 'once it is approved, delete with `rm -r <path>` (no `-f`)';
const REJECT = "exec_command failed: CreateProcess { message: \"Rejected(\\\"`/bin/zsh -lc 'rm -rf ./old'` rejected: rm -f style commands are not permitted. Use a safer approach\\\")\" }";

async function seed(ws, lang = 'ko') {
  await createCompany(ws, ws, 'owner', null, lang);
  await mkdir(paths(ws).agents, { recursive: true });
  await writeFile(join(paths(ws).agents, 'x.md'), '---\nname: 엑스\nrole: 정리\nrunner: codex\n---\n정리 담당.\n');
  await writeFile(join(paths(ws).root, '.secrets.json'), JSON.stringify({ runners: { codex: { type: 'apikey', value: 'sk-fake-not-a-real-key' } } }));
}
const turn = async (ws, reply) => { await writeFile(REPLY, reply); await rm(CAP, { force: true }); const r = await chat(ws, 'x', '예전 보고서 폴더를 지워 줘', null, {}); return { r, prompt: await readFile(CAP, 'utf8') }; };
const text = (r) => String(r?.reply ?? r?.text ?? r ?? '');

test('① codex exec 턴(기본 경로) — 실제 지시문에 강제 삭제 거절·승인 뒤 rm -r 안내가 들어간다(ko)', { skip: WIN_SKIP }, async () => {
  await seed('frm-ko');
  const { prompt } = await turn('frm-ko', '알겠습니다.');
  assert.ok(prompt.includes(LINE_KO), 'codex exec 지시문에 안내 줄이 없다');
  assert.ok(prompt.indexOf('## 결재 규칙') < prompt.indexOf(LINE_KO), "안내가 가리키는 '위 결재 규칙'이 실제로 위에 있다");
});

test('① 같은 함수 — app-server(게이트 경유)·SDK·다른 CLI 러너 턴에는 넣지 않는다, en은 영어 줄', () => {
  const has = (o) => commonDirectives({ lang: 'ko', ...o }).includes(LINE_KO);
  assert.equal(has({ runner: 'codex', gated: false }), true, 'codex exec');
  assert.equal(has({ runner: 'codex', gated: true }), false, 'codex app-server — 승인 요청이 Argo 게이트로 간다');
  for (const runner of ['claude', 'gemini', 'antigravity', 'glm', null]) assert.equal(has({ runner, gated: false }), false, String(runner));
  assert.ok(commonDirectives({ lang: 'en', runner: 'codex', gated: false }).includes(LINE_EN));
  assert.ok(!commonDirectives({ lang: 'en', runner: 'codex', gated: true }).includes(LINE_EN));
  // 결재 규칙과 충돌하지 않는다 — 풀 오토에서도 삭제는 결재 대상으로 남고, 안내는 "결재를 먼저"를 그대로 말한다
  const full = commonDirectives({ lang: 'ko', runner: 'codex', gated: false, fullAuto: true });
  assert.ok(full.includes(LINE_KO) && /삭제, 돈이 나가는 일/.test(full));
});

test('② 답에 codex 강제 삭제 거절이 있으면 안내 한 줄이 붙고, 파일 권한 안내는 붙지 않는다', { skip: WIN_SKIP }, async () => {
  await seed('frm-note');
  const { r } = await turn('frm-note', `폴더를 지우려 했지만 막혔습니다.\n${REJECT}\n쓰기가 차단돼 진행하지 않았습니다.`);
  const out = text(r);
  assert.ok(out.includes(forcedRmNote('ko').trim()), out.slice(-400));
  assert.doesNotMatch(out, /파일 접근이 막힌 것으로 보입니다|쓰기가 막혔습니다/, '권한 후보 안내가 같이 붙으면 원인을 잘못 짚는다');
  const { r: r2 } = await turn('frm-note', '정리했습니다.');
  assert.ok(!text(r2).includes('codex 러너가 강제 삭제'), '거절이 없는 답에는 붙지 않는다');
});

test('② 분류 — 원문·옮겨 적은 문장·코드펜스 안 모두 잡고, 다른 거부 문구는 잡지 않는다', () => {
  assert.equal(detectForcedRmRejection(REJECT), true);
  assert.equal(detectForcedRmRejection('일지: 승인 뒤 "rm -f style commands are not permitted"로 실행이 차단됐다'), true);
  assert.equal(detectForcedRmRejection('```\nRejected: rm -f style commands are not permitted\n```'), true);
  for (const s of ['zsh:1: operation not permitted: /tmp/x', 'rejected: blocked by policy', 'rm -rf ./old 를 실행했습니다', '', null]) assert.equal(detectForcedRmRejection(s), false, String(s));
  assert.match(forcedRmNote('ko'), /에이전트에게 다시 맡겨 주세요 — `-f` 없이\(`rm -r`\) 지웁니다/);
  assert.match(forcedRmNote('en'), /ask the agent again — it will delete without `-f` \(`rm -r`\)/);
});
