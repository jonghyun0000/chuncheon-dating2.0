/**
 * config.js — 환경변수 설정 파일
 *
 * 배포 전 이 파일의 값을 실제 Supabase 프로젝트 값으로 교체하세요.
 *
 * Vercel 배포 방법:
 *   방법 A (권장): 이 파일에 직접 값 입력 후 GitHub push → Vercel 자동 배포
 *   방법 B: Vercel Dashboard → Settings → Environment Variables에 추가 후
 *           빌드 스크립트로 이 파일을 동적 생성
 *
 * 로컬 테스트:
 *   이 파일에 값 입력 후 브라우저에서 index.html 직접 열기
 *   또는 npx serve . 로 로컬 서버 실행
 *
 * ⚠️ 주의: anon key는 공개 키이므로 GitHub에 올려도 괜찮습니다.
 *          service_role key는 절대 프론트엔드 코드에 포함하지 마세요.
 */

window.__ENV__ = {
  // ──────────────────────────────────────────────
  // 여기에 실제 값을 입력하세요
  // ──────────────────────────────────────────────
  SUPABASE_URL:      'https://qoayzogqmwrzoyiozuvb.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_dFzSs5IahmsBA06ESAYHUg_t4eHu02S',

  // 앱 설정
  APP_NAME:          '춘천 과팅',
  VERSION:           '2.0.0',

  // 입금 계좌 정보 (변경 시 여기만 수정)
  BANK_NAME:         '신한은행',
  BANK_ACCOUNT:      '110-498-811897',
  BANK_HOLDER:       '이종현',

  // 이용료
  FEE_MALE:          3000,
  FEE_FEMALE:        1000,

  // 관리자 이메일 (환불 문의)
  ADMIN_EMAIL:       'john_1217@naver.com',
};

// 설정값 유효성 검사 (개발 환경에서 경고)
(function validateConfig() {
  const cfg = window.__ENV__;
  if (cfg.SUPABASE_URL.includes('YOUR_PROJECT_ID')) {
    console.warn(
      '[춘천 과팅] ⚠️ config.js의 SUPABASE_URL을 실제 값으로 교체해주세요.\n' +
      '  Supabase Dashboard → Settings → API → Project URL'
    );
  }
  if (cfg.SUPABASE_ANON_KEY.includes('YOUR_ANON_KEY')) {
    console.warn(
      '[춘천 과팅] ⚠️ config.js의 SUPABASE_ANON_KEY를 실제 값으로 교체해주세요.\n' +
      '  Supabase Dashboard → Settings → API → anon public'
    );
  }
})();
