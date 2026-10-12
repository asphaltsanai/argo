// OAuth 동의 화면 사전(2026-10-13 오피스 원격 MCP) — ko/en 둘 다
export const OAUTH_DICT = {
  'oauth.title': ['아르고 오피스 연결 허용', 'Allow access to Argo Office'],
  'oauth.lead': ['{client}이(가) 내 계정({email})으로 아르고 오피스를 쓰려고 합니다.', '{client} wants to use Argo Office as {email}.'],
  'oauth.can': ['할 수 있는 일', 'What it can do'],
  'oauth.read': ['내가 볼 수 있는 일정·할 일·페이지·거래처·거래·문서함·메일을 읽습니다(평가·계좌 같은 민감한 값은 빼고).', 'Read the calendar, tasks, pages, customers, deals, files and mail you can see (without sensitive values such as evaluations and bank details).'],
  'oauth.write': ['바꾸는 일은 바로 하지 않고 "확인할 변경"으로 올립니다. 오피스 에이전트 창에서 [실행]을 눌러야 반영됩니다.', 'Changes are not made right away — they are filed as pending changes and apply only when you press Run in the Office agent panel.'],
  'oauth.scope': ['요청 범위: {scope}', 'Requested scope: {scope}'],
  'oauth.allow': ['허용', 'Allow'],
  'oauth.deny': ['거부', 'Deny'],
  'oauth.missing': ['연결 요청 정보가 없습니다. 연결을 다시 시작해 주세요.', 'The connection request is missing. Start connecting again.'],
  'oauth.fail': ['연결 요청을 처리하지 못했습니다. 연결을 다시 시작해 주세요.', 'Could not process the connection request. Start connecting again.'],
  'oauth.redirecting': ['연결한 앱으로 돌아가는 중…', 'Returning to the app…'],
  'oauth.unknownClient': ['이름 없는 앱', 'An unnamed app'],
};
