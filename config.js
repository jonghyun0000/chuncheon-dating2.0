// config.js — 춘천 과팅 설정
// ⚠️ GitHub 공개 저장소에 올리지 마세요
(function() {
  'use strict';
  const _d = function(s) {
    const k = 0x5A;
    return atob(s).split('').map(c => String.fromCharCode(c.charCodeAt(0) ^ k)).join('');
  };
  // 분산 저장된 설정값 — 수정 시 obfuscate() 함수로 재생성
  const _p = [
    'Mi4uKilgdXUrNTsjIA==','NT0rNy0oIDUjMzUgLw==','LDh0KS8qOzg7KT90OTU='
  ];
  const _q = [
    'KTgFKi84NjMpMjs4Nj8F','PhwgCSlvEzsyNykYG2ps','HwkbAxIPPQUubj8SL2poCQ=='
  ];
  window.__ENV__ = {
    get SUPABASE_URL()      { return _d(_p[0])+_d(_p[1])+_d(_p[2]); },
    get SUPABASE_ANON_KEY() { return _d(_q[0])+_d(_q[1])+_d(_q[2]); },
    APP_NAME:    '춘천 과팅',
    VERSION:     '2.1.0',
    BANK_NAME:   '신한은행',
    BANK_ACCOUNT:'110-498-811897',
    BANK_HOLDER: '이종현',
    FEE_MALE:    5000,
    FEE_FEMALE:  3000,
    ADMIN_EMAIL: 'john_1217@naver.com',
  };
})();
