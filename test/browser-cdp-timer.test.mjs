// 응답 없는 CDP 명령의 30초 시한 타이머가 프로세스 종료를 붙잡지 않는다(#922 검수 MEDIUM-1: 주석 뒤로 밀린 timer.unref()가 실행되지 않아 30초 대기).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const mod = pathToFileURL(fileURLToPath(new URL('../src/engine/browser-tools.mjs', import.meta.url))).href;

test('Cdp.send — 응답이 오지 않아도 시한 타이머가 프로세스 종료를 막지 않는다', () => {
  const code = `const { _CdpForTest: Cdp } = await import(${JSON.stringify(mod)});
const cdp = new Cdp({ send() {}, close() {} });
cdp.send('Page.navigate', { url: 'about:blank' }).catch(() => {});`;
  const started = Date.now();
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 20_000 });
  const ms = Date.now() - started;
  assert.equal(r.error, undefined, `자식이 시한 안에 끝나야 한다(${ms}ms)`);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(ms < 10_000, `응답 없는 send가 종료를 ${ms}ms 붙잡았다`);
});
