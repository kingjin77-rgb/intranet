// 휴대폰 푸시 알림 보내기 (Supabase Edge Function)
// DB 트리거(send_push)가 이 함수를 부르면, 대상 직원들의 구독으로 알림을 보낸다.
//
// 필요한 Secrets (Supabase 대시보드 → Edge Functions → Secrets)
//   PUSH_SECRET        push_config.secret 과 같은 아무 긴 문자열
//   VAPID_PUBLIC_KEY   config.js 의 VAPID_PUBLIC_KEY 와 같은 값
//   VAPID_PRIVATE_KEY  위 공개키의 짝 (저장소에 올리지 말 것)
//   VAPID_SUBJECT      mailto:관리자이메일
// 이 함수는 JWT 검증을 끈 상태로 배포한다 (x-push-secret 으로 확인).
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2.117.3';

const env = (k: string) => Deno.env.get(k) ?? '';

webpush.setVapidDetails(env('VAPID_SUBJECT') || 'mailto:admin@example.com', env('VAPID_PUBLIC_KEY'), env('VAPID_PRIVATE_KEY'));

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });
  if (!env('PUSH_SECRET') || req.headers.get('x-push-secret') !== env('PUSH_SECRET')) {
    return new Response('unauthorized', { status: 401 });
  }

  const { user_ids, title, body, url } = await req.json();
  if (!Array.isArray(user_ids) || !user_ids.length) return Response.json({ sent: 0 });

  const sb = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));
  const { data: subs, error } = await sb.from('push_subscriptions').select('*').in('user_id', user_ids);
  if (error) return new Response(error.message, { status: 500 });

  const payload = JSON.stringify({ title, body, url });
  let sent = 0, removed = 0;
  await Promise.all((subs ?? []).map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 60 * 60 * 24 });
      sent++;
    } catch (e) {
      // 앱을 지웠거나 알림을 끈 기기: 구독을 정리한다
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) {
        await sb.from('push_subscriptions').delete().eq('endpoint', s.endpoint);
        removed++;
      }
    }
  }));
  return Response.json({ sent, removed });
});
