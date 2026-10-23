# 사내 미니 인트라넷

카톡에 제안서 파일을 올리는 대신 **문서 링크만** 공유하고, 확인·의견·결재는 인트라넷에 남기는 작은 웹앱입니다.

| 기능 | 설명 |
|---|---|
| 문서 공유 | PDF·PPT·엑셀·한글·이미지 업로드 (50MB까지). PDF는 휴대폰에서도 바로 보기 |
| 열람 확인 | 누가 언제 몇 번 봤는지, 아직 안 본 사람은 누구인지. 미열람자 독촉 문구 복사 |
| 코멘트 | 문서별 의견 (페이지 번호 지정 가능), 실시간 반영 |
| 순차 결재 | 작성자가 결재선 지정 → 차례대로 승인/반려 (반려 시 사유 필수) |
| 카톡 연동 | "카톡 공유용 링크 복사" 버튼 → 카톡방에 붙여넣기 |
| 직원관리 | 관리자가 등록한 이메일만 로그인 가능. 퇴사자는 비활성화 |

구성: GitHub Pages(무료 호스팅) + [Supabase](https://supabase.com) 무료 플랜(DB·로그인·파일 저장). 서버는 따로 필요 없습니다.

```
./          index.html(문서함) doc.html(문서 상세) upload.html login.html admin.html app.js style.css config.js
supabase/   schema.sql (DB 테이블·보안 정책·결재 로직)
```

---

## 설치 (약 20분, 한 번만)

### 1. Supabase 프로젝트 만들기
1. https://supabase.com 가입 → **New project**
2. Region: **Northeast Asia (Seoul)** 선택, DB 비밀번호는 아무거나 저장해 둠

### 2. DB 만들기
1. 왼쪽 메뉴 **SQL Editor** → New query
2. `supabase/schema.sql` 내용을 통째로 붙여넣기
3. 맨 아래 **7번 첫 관리자 등록** 부분의 주석(`--`)을 지우고 본인 이메일·이름으로 바꾸기
4. **Run** — `Success` 가 나오면 완료

### 3. 로그인 메일 설정
1. **Authentication → Sign In / Providers → Email**: Enable Email provider 켜기, *Confirm email* 켜기
2. **Authentication → Email Templates → Magic Link** 본문을 아래처럼 바꾸기 (6자리 코드가 메일에 나오게)
   ```html
   <h2>사내 인트라넷 로그인</h2>
   <p>인증 코드: <b style="font-size:24px">{{ .Token }}</b></p>
   <p>또는 <a href="{{ .ConfirmationURL }}">여기를 눌러 로그인</a></p>
   ```
   **Confirm signup** 템플릿도 같은 내용으로 바꾸세요 (처음 로그인하는 직원은 이 메일을 받습니다).
3. **Authentication → URL Configuration**
   - Site URL: `https://kingjin77-rgb.github.io/intranet/login.html`
   - Redirect URLs 에도 같은 주소 추가
4. ⚠️ **메일 발송 서버(SMTP) 연결 — 필수**
   Supabase 기본 메일은 Supabase 팀 멤버에게만, 시간당 몇 통만 보내집니다. 직원들이 쓰려면
   **Authentication → Emails → SMTP Settings** 에서 직접 메일 서버를 연결해야 합니다.
   - 간단한 방법: [Resend](https://resend.com) 무료(하루 100통) 가입 → SMTP 정보 입력
   - 또는 회사 Gmail/Google Workspace: 앱 비밀번호 발급 후 `smtp.gmail.com:465` 입력

### 4. 사이트에 Supabase 연결
1. **Project Settings → API** 에서 `Project URL` 과 `anon public` 키 복사
2. `config.js` 에 붙여넣고 회사 이름도 수정 → 커밋
   (anon 키는 공개돼도 되는 키입니다. **service_role 키는 절대 넣지 마세요**)

### 5. GitHub Pages 켜기
1. GitHub 저장소 → **Settings → Pages** → Source: *Deploy from a branch*, Branch: `main` / `(root)` → Save
2. 1~2분 뒤 `https://kingjin77-rgb.github.io/intranet/` 접속

### 6. 직원 등록
1. 관리자 계정으로 로그인 → **직원관리** → 이메일·이름·부서 입력해서 등록
2. **초대 안내 문구 복사** → 회사 카톡방에 붙여넣기

---

## 사용 흐름

1. 작성자: **＋ 올리기** → 파일·제목·결재선 지정 → 올리기 → **카톡 공유용 링크 복사** → 카톡방에 붙여넣기
2. 직원: 카톡 링크 클릭 → (첫 1회 로그인) → 문서 확인 → 자동으로 열람 기록됨 → 의견 남기기
3. 결재자: 문서함의 **내 결재 대기** 탭 또는 링크 → 승인/반려
4. 작성자: 열람 현황에서 **미열람자 독촉 메시지 복사** → 카톡방에 붙여넣기

팁
- PPT는 **PDF로 저장해서** 올리면 휴대폰에서 바로 보입니다.
- 카톡 안에서 링크를 열면 메일 링크로는 로그인이 안 되니, **메일의 6자리 코드**를 입력하세요. 한 번 로그인하면 계속 유지됩니다.
- 반려된 문서는 수정본을 새로 올리면 됩니다 (제목에 v2 등 표기).

## 알아둘 점
- Supabase 무료 플랜: DB 500MB, 파일 1GB, 파일당 50MB. 1주일간 접속이 없으면 프로젝트가 일시정지되며, 대시보드에서 다시 켤 수 있습니다.
- 파일은 비공개 저장소에 있고, 로그인한 직원에게만 1시간짜리 임시 주소로 열립니다. 링크가 외부에 유출돼도 로그인 없이는 볼 수 없습니다.
- 결재 순서·권한은 DB 함수(`act_on_step`)가 검사하므로 화면을 조작해도 남의 차례에 결재할 수 없습니다.
- 카톡 미리보기에는 모든 문서가 같은 제목("문서 확인 요청")으로 보입니다. 실제 제목은 복사되는 문구에 들어갑니다.

## 설치 후 확인 체크리스트
- [ ] 관리자 이메일로 로그인 (코드 입력) 성공
- [ ] 등록 안 된 이메일은 "초대되지 않은 이메일" 오류
- [ ] 직원 2명 등록 → 각자 로그인
- [ ] PDF 업로드 (결재선: 직원A → 직원B) → 휴대폰에서 문서 보임
- [ ] 직원B가 먼저 들어가면 승인 버튼이 안 보임, 직원A 승인 후 보임
- [ ] 다른 사람 화면에서 코멘트가 새로고침 없이 나타남
- [ ] 열람 현황에 본 사람/안 본 사람이 맞게 표시
- [ ] 직원 비활성화 → 그 계정으로는 문서가 안 보임
