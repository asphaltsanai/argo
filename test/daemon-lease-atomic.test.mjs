// 데몬 리스 파일은 쓰는 도중에도 다른 프로세스에게 빈 내용·반쪽 JSON으로 보이지 않는다(임시 파일 + rename).
// 원래 결함(2026-10-13 재현): writeFile 덮어쓰기는 파일을 먼저 비운 뒤 내용을 쓴다. 그 사이에 다른 프로세스가 읽으면 빈 문자열을 보고
// "쓰다 만 내용 → 선점"으로 살아 있는 보유자의 리스를 가져갔다. 넘어가는 1~2초 동안 게이트웨이·스케줄러를 도는 프로세스가 0개였다
// (sync-lock-leader "재시작 경쟁" CI 실패 2회의 끝 상태 B={proc:false,cloud:true} A'={proc:true,cloud:false}).
// 실제 디스크·실제 두 프로세스로 잰다: 자식이 짧은 박자로 리스를 계속 갱신하고, 부모는 같은 파일을 쉬지 않고 읽어 JSON으로 풀리지 않는 횟수를 센다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';
import { srcUrl, childEnv } from './helpers/sync-child.mjs';

test('리스 갱신 중에 읽어도 늘 완전한 기록이다 — 빈 내용·반쪽 JSON 0회, 임시 파일도 남지 않는다', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'argo-lease-atomic-'));
  // 3초 동안 2ms 박자로 갱신한 뒤 박자 타이머를 멈추고, 진행 중인 쓰기가 끝날 때까지 기다렸다 나간다. Windows는 남이 열어 둔 파일 위로
  // rename하지 못해 renameRetry가 최대 3초 다시 시도한다 — 그 도중에 process.exit로 끊으면 임시 파일이 남는 것은 시험의 끊기 때문이다(10/13 windows CI).
  const script = `const timers = []; const si = globalThis.setInterval; globalThis.setInterval = (...a) => { const t = si(...a); timers.push(t); return t; };
const { daemonLease } = await import(${JSON.stringify(srcUrl('lock.mjs'))});
const l = daemonLease('gateway', { ttl: 2000, beat: 2 }); await l.ready; process.stdout.write('ready\\n');
setTimeout(() => { for (const t of timers) clearInterval(t); process.stdout.write('stopped\\n'); setTimeout(() => process.exit(0), 4000); }, 3000);`;
  const p = spawn(process.execPath, ['--input-type=module', '-e', script], { env: childEnv(root), stdio: ['ignore', 'pipe', 'pipe'] });
  let err = ''; p.stderr.on('data', (c) => { err += c; });
  await new Promise((r, j) => { p.stdout.on('data', (c) => { if (String(c).includes('ready')) r(); }); p.on('exit', () => j(new Error(`자식이 먼저 끝났다\n${err}`))); });
  const file = join(root, '.gateway.lock');
  let reads = 0; let torn = 0; let sample = '';
  const exited = new Promise((r) => p.on('exit', r));
  let done = false; p.stdout.on('data', (c) => { if (String(c).includes('stopped')) done = true; }); exited.then(() => { done = true; });
  while (!done) {
    let text;
    try { text = await readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT' || e.code === 'EPERM' || e.code === 'EBUSY') continue; throw e; }
    reads++;
    try { JSON.parse(text); } catch { torn++; sample ||= JSON.stringify(text.slice(0, 40)); }
  }
  await exited; // 진행 중이던 갱신(재시도 포함)이 끝난 뒤 남은 파일을 센다
  assert.ok(reads > 200, `읽기 ${reads}회 — 경합을 잴 만큼 읽지 못했다`);
  assert.equal(torn, 0, `읽기 ${reads}회 중 ${torn}회가 완전한 기록이 아니었다(예: ${sample}) — 다른 프로세스가 이 순간 읽으면 리스를 빼앗는다`);
  const left = (await readdir(root)).filter((n) => n.startsWith('.tmp-lease-'));
  assert.deepEqual(left, [], '임시 파일이 남았다');
});
