// 루트 app/ 화면 파일의 규칙 잠금 — 오피스 core.test.mjs '사전 밖 한글 문자열 금지'를 본체에 옮긴 것(2026-10-12 페퍼 규칙 점검 후속).
// 1) 모든 UI 문자열은 app/i18n.jsx 사전(t·tr)으로만. 2) 색·그림자는 graphite 토큰(var(--…))으로 — 대체 hex·검정 그림자 하드코딩 금지.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const APP = new URL('../app/', import.meta.url).pathname;
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const rel = (p) => p.slice(APP.length);
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const ui = walk(APP).filter((p) => /\.(jsx?|mjs)$/.test(p) && !rel(p).startsWith('api/'));

// 파일 전체 예외 — 화면 글자가 아니거나 사전 자체다.
//   i18n.jsx = 사전. apimsg.mjs·authmsg.mjs = 서버 오류 코드 → 문구 사전([ko, en] 쌍). auth.mjs = 서버 가드의 401·403 문구(요청 언어로 분기).
//   legal/page.jsx = 약관 전문 — 문서 서식이라 사전 키로 쪼개지 않는다(오피스 docs/* 서식과 같은 예외).
const WHOLE = new Set(['i18n.jsx', 'apimsg.mjs', 'authmsg.mjs', 'auth.mjs', 'legal/page.jsx']);
// 파일별로 허용하는 한글 — 화면에 그대로 나가지 않는 것만(입력 별칭·서버/에이전트 문구 판독·데이터 키·언어 자기 이름).
const ALLOW = {
  'c/[ws]/crew/[slug]/envelope.mjs': ['최근 대화', '지시', '현재 페이지 컨텍스트'], // 에이전트 봉투 절 이름(판독)
  'c/[ws]/crew/[slug]/fail-display.mjs': ['AI 러너가 하나도 연결돼 있지 않습니다', '연결된 러너는 더 이상 제공되지 않습니다'], // 서버 문구 판독
  'c/[ws]/crew/[slug]/via-summary.mjs': ['## 회의 대화'], // 회의록 절 이름(판독)
  'c/[ws]/crew/[slug]/page.jsx': ['중단됨', '가-힣', '취향', '결정', '금지', '## 일하는 방식'], // 서버 중단 문구 판독·명령 이름 정규식·데이터 키(표시는 t(`chat.boss.sec.${s}`))
  'c/[ws]/room/page.jsx': ['전체'], // @전체 멘션 입력 별칭
  'c/[ws]/market/page.jsx': ['가-힣'], // 슬러그 정규식
  'c/[ws]/settings/page.jsx': ['한국어'], // 언어 선택지는 그 언어 자기 이름으로 쓴다
  'c/[ws]/settings/sync-error.mjs': ['동기화 자격 없음', '만료', '다른 프로세스가 동기화 중', '동기화 파일', '건 실패', '계정 키 미확보 — 파일', '개'], // 데몬 문구 → 사전 키 판독
};
// 개발자 로그·내부 오류(화면 문자열 아님)
const DEV_LINE = /\bconsole\.(log|warn|error|info)\(|throw new Error\(/;
// 명령 입력 별칭 — 사람이 치는 말이라 화면 문자열이 아니다. 배열 안만 지운다(같은 단어가 화면 문자열로 들어오면 잡힌다)
const ALIASES = /aliases:\s*\[[^\]]*\]/g;

const offenders = (src, allow = []) => {
  let s = strip(src).split('\n').filter((l) => !DEV_LINE.test(l)).join('\n').replace(ALIASES, 'aliases: []');
  for (const a of [...allow].sort((x, y) => y.length - x.length)) s = s.split(a).join('');
  return s.split('\n').map((l, i) => [i + 1, l.trim()]).filter(([, l]) => /[가-힣]/.test(l));
};

test('app/ 화면 파일: 사전 밖 한글 문자열 금지(허용 목록 밖)', () => {
  const bad = [];
  for (const p of ui) {
    const r = rel(p);
    if (WHOLE.has(r)) continue;
    for (const [n, l] of offenders(readFileSync(p, 'utf8'), ALLOW[r])) bad.push(`${r}:${n}: ${l.slice(0, 120)}`);
  }
  assert.deepEqual(bad, [], '화면 문자열은 app/i18n.jsx 사전으로(훅 밖이면 tr(lang, key)) — 화면에 안 나가는 글자면 ALLOW에 이유와 함께');
});

test('허용 목록이 낡지 않았다 — 적힌 글자는 그 파일에 실제로 있다', () => {
  for (const [r, list] of Object.entries(ALLOW)) {
    const s = strip(readFileSync(join(APP, r), 'utf8'));
    for (const a of list) assert.ok(s.includes(a), `${r}: '${a}'가 없다 — 목록에서 지운다`);
  }
});

test('app/ 화면 파일: 검정 그림자·대체 hex 하드코딩 금지(graphite 토큰으로)', () => {
  const bad = [];
  for (const p of ui) {
    const src = strip(readFileSync(p, 'utf8'));
    src.split('\n').forEach((l, i) => {
      if (/rgba\(\s*0\s*,\s*0\s*,\s*0\s*,[^)]*\)/.test(l) && /shadow/i.test(l)) bad.push(`${rel(p)}:${i + 1}: 그림자는 var(--shadow-float)·var(--shadow-card)`);
      if (/var\(--[a-z0-9-]+,\s*#[0-9a-f]{3,8}\s*\)/i.test(l)) bad.push(`${rel(p)}:${i + 1}: 토큰 대체 hex — 토큰은 항상 정의돼 있다`);
    });
  }
  assert.deepEqual(bad, []);
});

test('훅 밖 사전 조회 tr이 Provider의 t와 같은 함수다(사전 두 벌 금지)', () => {
  const i18n = readFileSync(join(APP, 'i18n.jsx'), 'utf8');
  assert.match(i18n, /export function tr\(lang, key, vars\)/);
  assert.match(i18n, /const t = useCallback\(\(key, vars\) => tr\(lang, key, vars\), \[lang\]\)/);
  for (const k of ['time.justNow', 'time.minAgo', 'time.hourAgo', 'time.dayAgo', 'notice.billingOpenFail', 'notice.saveTooLarge', 'notice.saveFailed']) {
    assert.match(i18n, new RegExp(`'${k.replace('.', '\\.')}': \\['[^']*[가-힣][^']*', '[^가-힣']+'\\]`), k);
  }
});
