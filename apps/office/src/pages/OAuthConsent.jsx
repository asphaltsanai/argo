// OAuth 2.1 동의 화면(2026-10-13 오피스 독립 앱 분리) — 에이전트(Argo 원격 MCP 커넥터·Claude Code·Codex 등)가 오피스 원격 MCP(api/mcp.js)에 붙을 때
// Supabase Auth(OAuth 2.1 서버)가 사람을 이 주소(사이트 주소 + 인가 경로)로 보낸다. 로그인한 사람이 허용·거부를 고르면 Supabase가 연결한 앱으로 돌려보낸다.
// 토큰 발급·회전·자동 등록은 Supabase Auth가 한다 — 이 화면은 결정만 전한다.
import { useEffect, useState } from 'react';
import { t, useLang, registerDict } from '../core/i18n.js';
import { getClient } from '../core/supabase.js';
import { OAUTH_DICT } from './oauth-i18n.js';

registerDict(OAUTH_DICT);

export const CONSENT_KEY = 'argo-office-oauth-consent';

export default function OAuthConsent({ query }) {
  useLang();
  const id = new URLSearchParams(query ?? '').get('authorization_id') ?? '';
  const [state, setState] = useState({ step: id ? 'loading' : 'missing' });
  useEffect(() => {
    if (!id) return undefined;
    let alive = true;
    (async () => {
      const sb = await getClient();
      const { data, error } = await sb.auth.oauth.getAuthorizationDetails(id);
      if (!alive) return;
      if (error || !data) return setState({ step: 'fail' });
      if (data.redirect_url) { setState({ step: 'redirecting' }); location.assign(data.redirect_url); return; } // 이미 허용한 앱
      setState({ step: 'ask', d: data });
    })().catch(() => alive && setState({ step: 'fail' }));
    return () => { alive = false; };
  }, [id]);
  const decide = async (allow) => {
    setState((s) => ({ ...s, busy: true }));
    try {
      const sb = await getClient();
      const fn = allow ? sb.auth.oauth.approveAuthorization : sb.auth.oauth.denyAuthorization;
      const { data, error } = await fn.call(sb.auth.oauth, id, { skipBrowserRedirect: true });
      if (error || !data?.redirect_url) return setState({ step: 'fail' });
      setState({ step: 'redirecting' }); location.assign(data.redirect_url);
    } catch { setState({ step: 'fail' }); }
  };
  const d = state.d;
  return (
    <main className="login">
      <div className="login-card">
        <img className="login-mark" src="/icon-192.png" alt="" />
        <h1>{t('oauth.title')}</h1>
        {state.step === 'loading' && <p className="dim" role="status">…</p>}
        {state.step === 'missing' && <p className="dim">{t('oauth.missing')}</p>}
        {state.step === 'fail' && <p className="dim" role="alert">{t('oauth.fail')}</p>}
        {state.step === 'redirecting' && <p className="dim" role="status">{t('oauth.redirecting')}</p>}
        {state.step === 'ask' && <>
          <p>{t('oauth.lead', { client: d.client?.name || t('oauth.unknownClient'), email: d.user?.email ?? '' })}</p>
          {d.client?.uri && <p className="dim small">{d.client.uri}</p>}
          <div className="login-dev">
            <span className="label">{t('oauth.can')}</span>
            <p className="small">{t('oauth.read')}</p>
            <p className="small">{t('oauth.write')}</p>
            {d.scope && <p className="dim small">{t('oauth.scope', { scope: d.scope })}</p>}
          </div>
          <div className="login-buttons">
            <button type="button" className="btn block primary" disabled={state.busy} onClick={() => decide(true)}>{t('oauth.allow')}</button>
            <button type="button" className="btn block" disabled={state.busy} onClick={() => decide(false)}>{t('oauth.deny')}</button>
          </div>
        </>}
      </div>
    </main>
  );
}
