'use client';
// 최소 앱 버전 일시 정지 화면(유건 2026-10-13 "옛 버전 기기는 일시정지 화면에 업데이트 버튼을 띄우고, 무조건 업데이트하게 한다").
// 판정은 서버(/api/app-gate → src/app-gate.mjs)가 한다. 막힌 동안 이 기기의 동기화·메신저·알림 호출은 이미 멈춰 있고(기기 세션 관문),
// 이 화면은 닫을 수 없다. [지금 업데이트] = 앱 안 업데이트(설정 카드·상단 칩과 같은 useAppUpdate). 웹이거나 설치가 실패하면 다운로드 페이지.
// 판정은 열 때, 5분마다, 창으로 돌아올 때 다시 묻는다(로컬 요청 — 서버 확인은 30분에 한 번).
import { useCallback, useEffect, useState } from 'react';
import { useLang } from './i18n';
import { useAppUpdate } from './use-app-update';

const DOWNLOAD_URL = 'https://github.com/beyondworks/argo-agent/releases/latest';
const RECHECK_MS = 5 * 60_000;

export default function AppGate() {
  const [gate, setGate] = useState(null);
  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/app-gate', { cache: 'no-store' });
      if (!r.ok) return; // 로그인 전(401) 등 — 판정을 바꾸지 않는다
      const j = await r.json();
      setGate(j?.blocked ? { min: j.min, version: j.version } : null);
    } catch { /* 서버 재시작 중 — 다음 주기 */ }
  }, []);
  useEffect(() => {
    load();
    const iv = setInterval(load, RECHECK_MS);
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(iv); window.removeEventListener('focus', onFocus); };
  }, [load]);
  return gate ? <AppGateScreen gate={gate} /> : null;
}

export function AppGateScreen({ gate }) {
  const { t } = useLang();
  const { isApp, current, phase, install, installError } = useAppUpdate();
  const [failed, setFailed] = useState(false);
  const busy = phase === 'installing' || phase === 'ready';
  const onUpdate = async () => {
    if (!isApp) { window.open(DOWNLOAD_URL, '_blank', 'noopener'); return; }
    await install(); // 성공하면 앱이 다시 시작돼 여기로 돌아오지 않는다
    setFailed(true); // 돌아왔으면 설치 실패·재시작 실패·업데이트를 못 찾음(오프라인 등) — 다운로드 페이지로 안내
  };
  const showFail = failed || !!installError;
  return (
    <div className="app-gate" role="alertdialog" aria-modal="true" aria-labelledby="app-gate-title">
      <div className="app-gate-card">
        <h1 id="app-gate-title">{t('appGate.title')}</h1>
        <p>{t('appGate.body', { v: current || gate.version || '?', min: gate.min })}</p>
        <p className="app-gate-safe">{t('appGate.safe')}</p>
        <div className="app-gate-actions">
          <button type="button" className="btn btn-primary" onClick={onUpdate} disabled={busy}>
            {busy ? t('appGate.installing') : t('appGate.update')}
          </button>
          {showFail ? <a className="btn" href={DOWNLOAD_URL} target="_blank" rel="noopener noreferrer">{t('appGate.download')}</a> : null}
        </div>
        {showFail ? <p className="app-gate-fail">{t('appGate.failed')}</p> : null}
      </div>
    </div>
  );
}
