// 실행기 출력 스트림이 한글 글자 가운데에서 나뉘어 와도 사용자에게 가는 글이 깨지지 않는다(2026-10-13 — #981에서 시험 가짜 서버의
// `b += c`가 한글 3바이트를 조각 경계에서 U+FFFD 세 개로 깨뜨린 것을 찾고, 같은 모양을 제품 코드에서 전수 수색).
// 조각(Buffer)을 하나씩 문자열로 바꿔 이으면 경계에 걸린 글자가 깨진다 — StringDecoder로 경계를 잇는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

const { runAppServerSession } = await import('../src/runners/codex-appserver.mjs');
const { createCodexJsonReader } = await import('../src/runners/codex-json.mjs');

/** 줄(JSON)을 '일'(3바이트)의 첫 바이트 뒤에서 잘라 두 번에 쓴다 — 받는 쪽이 'data'를 두 번 받게 사이를 둔다 */
async function writeSplit(stream, line) {
  const buf = Buffer.from(line); const cut = buf.indexOf(Buffer.from('일')) + 1;
  stream.write(buf.subarray(0, cut));
  await new Promise((r) => setTimeout(r, 20));
  stream.write(buf.subarray(cut));
}

test('codex 앱 서버 — 에이전트 답 줄이 한글 가운데서 나뉘어 와도 답이 그대로다', async () => {
  const input = new PassThrough(); const output = new PassThrough();
  const emit = (m) => output.write(JSON.stringify(m) + '\n');
  let buf = '';
  input.on('data', (d) => {
    buf += d.toString(); let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (m.method === 'initialize') emit({ id: m.id, result: { userAgent: 'fake' } });
      else if (m.method === 'thread/start') emit({ id: m.id, result: { thread: { id: 't1' } } });
      else if (m.method === 'turn/start') {
        emit({ id: m.id, result: { turn: { id: 'u1', status: 'inProgress' } } });
        (async () => {
          await writeSplit(output, JSON.stringify({ method: 'item/completed', params: { item: { type: 'agentMessage', id: 'a1', text: '지시한 파일 수정 완료' } } }) + '\n');
          emit({ method: 'turn/completed', params: { turn: { id: 'u1', status: 'completed' } } });
        })();
      }
    }
  });
  const { reply } = await runAppServerSession({ input, output, prompt: 'p', cwd: '/w', timeoutMs: 5000, judge: async () => 'accept' });
  assert.equal(reply, '지시한 파일 수정 완료', `답이 깨졌다: ${reply}`);
});

test('codex JSON 읽기 — 이벤트 줄이 한글 가운데서 나뉜 Buffer로 와도 그대로 읽는다', () => {
  const events = [];
  const reader = createCodexJsonReader({ onEvent: (ev) => events.push(ev) });
  const line = Buffer.from(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '지시한 파일 수정 완료' } }) + '\n');
  const cut = line.indexOf(Buffer.from('일')) + 1;
  reader.push(line.subarray(0, cut)); reader.push(line.subarray(cut)); reader.end();
  assert.equal(events.length, 1);
  assert.equal(events[0].item.text, '지시한 파일 수정 완료', `깨졌다: ${events[0].item.text}`);
});
