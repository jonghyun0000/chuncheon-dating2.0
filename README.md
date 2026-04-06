# 🌸 춘천 과팅 v2 — 보안 강화 배포 가이드

## ✅ v2에서 수정된 핵심 문제

| 문제 | v1 (이전) | v2 (수정 후) |
|------|----------|-------------|
| 로그인 | 아무 값이나 입력해도 통과 | Supabase Auth 실제 검증 |
| 관리자 | 아이디만 맞으면 접근 가능 | role=admin DB 확인 필수 |
| RLS | USING(true) 8개 존재 | 완전 제거, 세밀한 정책 적용 |
| Storage | uid 경로 미강제 | verifications/{auth_uid}/ 강제 |
| 환경변수 | `__PLACEHOLDER__` 방식 (Vercel에서 미치환) | config.js 방식으로 교체 |
| XSS | innerHTML에 사용자 데이터 직접 삽입 | esc() 함수 전체 적용 |
| team_members | USING(true) 아무나 접근 | 팀장/관련자/관리자만 접근 |

---

## 📁 파일 구조

```
chuncheon-dating/
├── index.html    ← 메인 앱 (UI 화면)
├── app.js        ← 실제 동작 로직 (Supabase 연동)
├── config.js     ← 환경변수 설정 ★ 배포 전 값 입력 필수
├── schema.sql    ← DB 완전 재작성 (RLS 포함)
├── vercel.json   ← Vercel 배포 설정
└── README.md     ← 이 파일
```

---

## 1️⃣ 배포 전 필수: config.js 설정

```javascript
// config.js 파일을 열고 아래 두 값을 실제 값으로 교체하세요

window.__ENV__ = {
  SUPABASE_URL:      'https://여기에실제값.supabase.co',  // ← 교체
  SUPABASE_ANON_KEY: '여기에실제anon키',                  // ← 교체
  // 나머지는 필요 시 수정
};
```

**값 확인 위치**: Supabase Dashboard → Settings → API

---

## 2️⃣ Supabase 설정

### 2-1. 프로젝트 생성
- https://supabase.com → New Project
- Region: Northeast Asia (Seoul)

### 2-2. 이메일 확인 비활성화
```
Authentication → Providers → Email
→ "Confirm email" 토글 OFF → Save
```

### 2-3. schema.sql 실행
```
SQL Editor → 전체 붙여넣기 → Run
```

### 2-4. Storage 버킷
schema.sql에 포함됨. 또는 수동으로:
- Storage → New Bucket → `student-verifications`
- Public: OFF (비공개)

### 2-5. 관리자 계정 생성
```
1. Authentication → Users → Add User
   Email: john1217@chuncheon-dating.local
   Password: king1217

2. SQL Editor에서:
   UPDATE users SET role = 'admin', profile_active = TRUE
   WHERE auth_id = '위에서_생성된_UUID';
```

---

## 3️⃣ GitHub + Vercel 배포

```bash
# 1. GitHub 저장소 생성 후
git init && git add . && git commit -m "🌸 춘천 과팅 v2"
git remote add origin https://github.com/계정/chuncheon-dating.git
git push -u origin main

# 2. Vercel Dashboard → Import Project
#    Framework: Other
#    Output Directory: . (루트)
#    → Deploy
```

---

## 🧪 테스트 체크리스트

### 인증 테스트
- [ ] 없는 아이디 → "아이디 또는 비밀번호가 올바르지 않습니다."
- [ ] 맞는 아이디 + 틀린 비밀번호 → 동일 오류
- [ ] 맞는 아이디 + 맞는 비밀번호 → 홈으로 이동
- [ ] is_banned=true 계정 → 즉시 차단 메시지
- [ ] 일반 계정으로 관리자 로그인 → "관리자 권한이 없습니다."
- [ ] 새로고침 후 로그인 상태 유지
- [ ] 로그아웃 → 랜딩 화면

### 권한 테스트
- [ ] 비로그인 상태에서 신청내역 탭 → 가입 유도 모달
- [ ] 비로그인 상태에서 관리자 화면 직접 접근 → 차단
- [ ] 일반 사용자가 타인 deposits 조회 시도 → RLS 차단 (빈 결과)
- [ ] 비활성화 사용자가 팀 등록 → "서비스 활성화가 필요합니다"

### 보안 테스트
- [ ] 팀 카드에 `<script>alert(1)</script>` 포함된 닉네임 → 그냥 텍스트로 표시
- [ ] 관리자 아닌 사용자로 adminApproveVerif 직접 호출 → DB RLS 차단

---

## 🔐 보안 체크리스트

- ✅ 비밀번호 bcrypt 저장 (Supabase Auth 자동 처리)
- ✅ USING(true) 정책 0개
- ✅ 팀원 테이블 아무나 접근 차단
- ✅ match_requests 관련 팀만 조회
- ✅ messages 관련 팀만 조회
- ✅ reports 신고자+관리자만 조회
- ✅ admin_logs 관리자만 접근
- ✅ Storage 경로 본인 uid 강제
- ✅ XSS: esc() 함수 전체 적용
- ✅ ID 형식 검증 (UUID regex)
- ✅ 입력값 maxlength 제한
- ✅ 서버사이드 RLS 이중 방어

---

## ⚠️ 남아있는 한계 및 추후 개선

1. **메시지 기능**: 현재 로컬 메모리 임시 구현 → Supabase Realtime 연동 필요
2. **이미지 삭제**: auto_delete_at 기록만 됨 → Supabase Edge Function/pg_cron으로 실제 삭제 구현 필요
3. **matches INSERT**: 현재 admin만 직접 생성 → acceptMatchRequest 시 DB 함수로 자동 생성 권장
4. **파일 업로드 MIME 검증**: 클라이언트 type 체크만 → 서버사이드 MIME 검증 추가 권장
5. **Rate limiting**: Supabase 기본 Rate limit 외 추가 제한 없음
