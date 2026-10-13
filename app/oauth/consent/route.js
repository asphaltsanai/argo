// Supabase OAuth 2.1 서버의 동의 화면 경로(Authorization Path) — 오피스 동의 화면으로 302 넘김만 한다. 근거는 src/oauth-consent.mjs.
import { NextResponse } from 'next/server';
import { officeConsentTarget } from '../../../src/oauth-consent.mjs';

export function GET(req) {
  return NextResponse.redirect(officeConsentTarget(req.url), { status: 302 });
}
