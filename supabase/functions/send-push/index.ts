// 휴대폰 푸시 알림 보내기 (Supabase Edge Function, 배포 이름: swift-handler)
// DB 의 send_push() 가 이 함수를 부르면, 대상 직원들의 구독으로 알림을 보낸다.
//
// 수동으로 넣을 Secrets 는 없다.
//   - 호출 확인: 요청의 x-push-secret 을 DB push_config.secret 과 비교
//   - 알림 키(VAPID): DB push_keys 에 보관, 없으면 처음 실행 때 만들어 저장 (013_push_fix.sql)
//   - SUPABASE_URL · SUPABASE_SERVICE_ROLE_KEY 는 Supabase 가 자동으로 넣어 준다
// JWT 검증을 끈 상태(verify_jwt=false)로 배포한다.
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2.117.3';

const sb = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
const SUBJECT = 'mailto:admin@intranet.invalid';

let keys: { public_key: string; private_key: string } | null = null;
async function loadKeys() {
  if (keys) return keys;
  let { data } = await sb.from('push_keys').select('public_key,private_key').eq('id', 1).maybeSingle();
  if (!data) {
    // 처음 실행: 키를 만들어 저장. 동시에 두 번 실행돼도 먼저 저장된 것을 쓴다
    const k = webpush.generateVAPIDKeys();
    await sb.from('push_keys').upsert({ id: 1, public_key: k.publicKey, private_key: k.privateKey }, { onConflict: 'id', ignoreDuplicates: true });
    ({ data } = await sb.from('push_keys').select('public_key,private_key').eq('id', 1).maybeSingle());
  }
  if (!data) throw new Error('push_keys 를 만들지 못했습니다 (013_push_fix.sql 실행 필요)');
  keys = data;
  webpush.setVapidDetails(SUBJECT, data.public_key, data.private_key);
  return keys;
}

let secret = '';
async function checkSecret(req: Request) {
  if (!secret) {
    const { data } = await sb.from('push_config').select('secret').eq('id', 1).maybeSingle();
    secret = data?.secret ?? '';
  }
  return !!secret && req.headers.get('x-push-secret') === secret;
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });
  if (!(await checkSecret(req))) return new Response('unauthorized', { status: 401 });

  const body = await req.json().catch(() => ({}));
  try { await loadKeys(); } catch (e) { return new Response(String((e as Error).message), { status: 500 }); }
  if (body.action === 'init') return Response.json({ ready: true });

  const { user_ids, title, url } = body;
  if (!Array.isArray(user_ids) || !user_ids.length) return Response.json({ sent: 0, removed: 0, failed: 0 });

  const { data: subs, error } = await sb.from('push_subscriptions').select('*').in('user_id', user_ids);
  if (error) return new Response(error.message, { status: 500 });

  const payload = JSON.stringify({ title, body: body.body, url });
  let sent = 0, removed = 0, failed = 0;
  await Promise.all((subs ?? []).map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 60 * 60 * 24, urgency: 'high' });
      sent++;
    } catch (e) {
      // 앱을 지웠거나, 알림을 껐거나, 예전 키로 등록된 기기: 구독을 정리한다 (앱을 다시 열면 새로 등록됨)
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 403 || code === 404 || code === 410) {
        await sb.from('push_subscriptions').delete().eq('endpoint', s.endpoint);
        removed++;
      } else {
        failed++;
        console.warn('push 실패', code, (e as Error).message);
      }
    }
  }));
  return Response.json({ sent, removed, failed });
});
