// Supabase 프로젝트 설정 → API Keys 의 Publishable key (또는 Legacy anon key)
// anon(public) 키는 브라우저에 노출되어도 되는 공개 키입니다. service_role 키는 절대 넣지 마세요.
window.INTRANET_CONFIG = {
  SUPABASE_URL: 'https://itszlzolqfkafowbrjed.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_bZnonBpvuUuui78lOBEJzg_-MY1g14i',
  COMPANY_NAME: '제이엘',
  FIRM_NAME: '법무법인 제이엘',
  // 왼쪽 위 로고 (공식 로고 파일을 받으면 icons/logo.svg 를 바꾸거나 여기 경로를 바꾸세요)
  LOGO_URL: 'icons/logo.svg',
  // 휴대폰 푸시용 공개키 (짝이 되는 비공개키는 Supabase Secrets 에만 둔다)
  VAPID_PUBLIC_KEY: 'BMeF0hFe-LdB9ca6IBuYa3bAGtQRtouIWJforeybnQE8N9GOxuQbNQ-uNlIhtqsS3JbPauxHOuwVUhMxRbPbr0c',
};
