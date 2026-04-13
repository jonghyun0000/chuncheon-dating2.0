/**
 * app.js — 춘천 과팅 메인 애플리케이션
 * v2.0 전면 재작성: 실제 Supabase Auth 기반 인증, XSS 방어, RLS 연동
 * v2.1 업데이트: 조인 외래키 명시, 카카오링크 검증, Auth 세션 예외 처리 강화
 * v2.2 업데이트: 남녀팀 통합 목록, 인증팀 상단 노출, 전화번호 전용 연락처,
 *               아이디/비번 찾기(생년월일+학번+전화), 팀 등록 인증 선택화
 */

'use strict';

// ============================================================
// 1. Supabase 클라이언트 초기화 (config.js의 값 사용)
// ============================================================
const cfg = window.__ENV__;

if (!cfg || !cfg.SUPABASE_URL || cfg.SUPABASE_URL.includes('YOUR_PROJECT')) {
  document.body.innerHTML = `
    <div style="padding:40px;text-align:center;font-family:sans-serif;">
      <h2>⚠️ 설정 오류</h2>
      <p>config.js의 SUPABASE_URL과 SUPABASE_ANON_KEY를 실제 값으로 교체해주세요.</p>
    </div>`;
  throw new Error('config.js 환경변수 미설정');
}

const _sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
  auth: {
    persistSession:     true,   // 새로고침 후 세션 유지
    autoRefreshToken:   true,   // 토큰 자동 갱신
    detectSessionInUrl: true    // 이메일 링크 자동 처리
  }
});

// ============================================================
// 2. 전역 상태 (단일 진실 원천)
// ============================================================
const state = {
  authUser:      null,   // Supabase auth.user
  profile:       null,   // users 테이블 row
  currentScreen: 'screen-landing',
  screenHistory: [],
  isPreviewMode: false,
  regData:       null,   // 회원가입 임시 데이터
  uploadedFile:  null    // 학생증 파일 객체
};
window.state = state;

// ============================================================
// 3. XSS 방어 유틸 (innerHTML 사용 시 반드시 통과)
// ============================================================
function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#x27;')
    .replace(/\//g, '&#x2F;');
}

// textContent 사용 헬퍼
function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text ?? '';
}

// ============================================================
// 4. 토스트 / 로딩 상태
// ============================================================
let _toastTimer;
function showToast(msg, duration = 2800) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;     // textContent로 XSS 방어
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

function setBtnLoading(id, loading, originalText) {
  const el = document.getElementById(id);
  if (!el) return;
  el.disabled = loading;
  el.textContent = loading ? '처리 중...' : originalText;
}

// ============================================================
// 5. 화면 전환 (보호 라우팅 포함)
// ============================================================
const PROTECTED_SCREENS = new Set([
  'screen-team-register','screen-apply','screen-requests',
  'screen-reviews','screen-mypage','screen-match-success'
]);
const ADMIN_SCREENS = new Set(['screen-admin']);

function showScreen(id) {
  // 보호된 화면 접근 제어
  if (PROTECTED_SCREENS.has(id) && !state.profile) {
    showAuthGateModal('default');
    return;
  }
  if (ADMIN_SCREENS.has(id) && state.profile?.role !== 'admin') {
    showToast('❌ 관리자 권한이 필요합니다.');
    return;
  }

  if (state.currentScreen !== id) {
    state.screenHistory.push(state.currentScreen);
  }
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const target = document.getElementById(id);
  if (target) {
    target.classList.add('active');
    state.currentScreen = id;
    target.scrollTop = 0;
  }
}
window.showScreen = showScreen;

window.history.back = function () {
  if (state.screenHistory.length > 0) showScreen(state.screenHistory.pop());
  else showScreen('screen-landing');
};

// ============================================================
// 6. 탭 전환 (비로그인 게이트)
// ============================================================
const TAB_SCREEN = {
  home: 'screen-home', find: 'screen-team-register',
  requests: 'screen-requests', messages: 'screen-reviews', mypage: 'screen-mypage'
};

function switchTab(tab) {
  if (!state.profile && tab !== 'home') {
    const actionMap = { find:'team', requests:'request', messages:'message', mypage:'mypage' };
    showAuthGateModal(actionMap[tab] || 'default');
    return;
  }
  showScreen(TAB_SCREEN[tab]);
  if (tab === 'requests') { loadAndRenderRequests('sent'); updateBadges(); }
  if (tab === 'messages') { loadReviews(); }
  if (tab === 'home')     { loadTeams(); updateHomeStats(); updateBadges(); }
}
window.switchTab = switchTab;

// ============================================================
// 7. 인증 게이트 모달
// ============================================================
function showAuthGateModal(action) {
  const msgs = {
    apply:   { emoji:'💌', title:'과팅 신청은 회원만',   desc:'가입하고 마음에 드는 팀에게 신청해보세요!' },
    team:    { emoji:'👥', title:'팀 등록은 회원만',     desc:'가입 후 인증을 완료하면 팀을 등록할 수 있어요.' },
    request: { emoji:'📬', title:'신청 내역은 회원만',   desc:'가입하면 보낸·받은 신청을 확인할 수 있어요.' },
    message: { emoji:'💬', title:'채팅은 회원만',       desc:'가입하고 매칭된 팀과 안전하게 대화해보세요!' },
    mypage:  { emoji:'👤', title:'마이페이지는 회원만',  desc:'가입하면 내 정보와 매칭 현황을 확인할 수 있어요.' },
    default: { emoji:'🌸', title:'회원 전용 기능',      desc:'가입하고 모든 기능을 이용해보세요!' }
  };
  const m = msgs[action] || msgs.default;
  setText('gate-emoji', m.emoji);
  setText('gate-title', m.title);
  setText('gate-desc', m.desc);
  document.getElementById('modal-auth-gate')?.classList.add('show');
}
window.showAuthGateModal = showAuthGateModal;

// ============================================================
// 8. 앱 초기화 (세션 복원)
// ============================================================
async function initApp() {
  try {
    const { data: { session } } = await _sb.auth.getSession();
    if (session?.user) {
      state.authUser = session.user;
      await loadProfile(session.user.id);
      if (state.profile) {
        enterAuthenticatedApp();
        return;
      }
    }
  } catch (e) {
    console.error('[initApp]', e);
  }

  // Auth 상태 변경 리스너
  _sb.auth.onAuthStateChange(async (event, session) => {
    if (event === 'SIGNED_IN' && session?.user) {
      state.authUser = session.user;
      await loadProfile(session.user.id);
    } else if (event === 'SIGNED_OUT') {
      state.authUser = null;
      state.profile  = null;
    }
  });

  // 미로그인 — 랜딩 화면 초기화
  renderPreviewTeamList();
  updateHomeStats();
}

async function loadProfile(authUserId) {
  const { data, error } = await _sb
    .from('users')
    .select('*')
    .eq('auth_id', authUserId)
    .is('deleted_at', null)
    .single();

  if (error || !data) { state.profile = null; return null; }
  state.profile = data;
  return data;
}

function enterAuthenticatedApp() {
  const p = state.profile;
  if (!p) return;
  // textContent 사용으로 XSS 방어
  setText('home-username', p.nickname + '님');
  setText('my-nickname', p.nickname);
  setText('my-info', `${p.university} · ${p.department} · ${new Date().getFullYear() - p.birth_year + 1}세`);
  const guestBanner = document.getElementById('guest-banner');
  if (guestBanner) guestBanner.style.display = 'none';

  // 2️⃣ 관리자 모드 버튼 표시/숨김
  const adminBtnEl = document.getElementById('btn-admin-mode');
  if (adminBtnEl) {
    adminBtnEl.style.display = p.role === 'admin' ? 'flex' : 'none';
  }

  // 5️⃣ 마이페이지 역할 뱃지 현재값 채우기
  const badgeInput = document.getElementById('my-custom-badge');
  if (badgeInput) badgeInput.value = p.custom_badge || '';

  updateMyPageStatus();
  loadTeams();
  updateHomeStats();
  updateBadges();   // 4️⃣ 배지 카운트 초기화
  showScreen('screen-home');
}

// ============================================================
// 9. ★★★ 로그인 — 실제 Supabase Auth 검증 (가짜 로그인 완전 제거) ★★★
// ============================================================
async function doLogin() {
  const usernameRaw = document.getElementById('login-id')?.value.trim();
  const password    = document.getElementById('login-pw')?.value;

  // 클라이언트 사전 검증
  if (!usernameRaw) { showToast('아이디를 입력해주세요'); return; }
  if (!password)    { showToast('비밀번호를 입력해주세요'); return; }
  if (usernameRaw.length < 4) { showToast('아이디는 4자 이상이어야 합니다'); return; }

  setBtnLoading('btn-login', true, '로그인');
  try {
    // username → 내부 이메일 변환
    const email = `${usernameRaw}@chuncheon-dating.local`;

    // ★ 실제 Supabase Auth 검증 (비밀번호 불일치 시 자동 실패)
    const { data, error } = await _sb.auth.signInWithPassword({ email, password });

    if (error) {
      // 한국어 오류 메시지
      if (error.message.toLowerCase().includes('invalid login')) {
        throw new Error('아이디 또는 비밀번호가 올바르지 않습니다.');
      }
      if (error.message.toLowerCase().includes('email not confirmed')) {
        throw new Error('이메일 인증이 필요합니다. 관리자에게 문의하세요.');
      }
      throw new Error('로그인 실패: ' + error.message);
    }

    // users 테이블 프로필 조회
    const profile = await loadProfile(data.user.id);
    if (!profile) {
      await _sb.auth.signOut();
      throw new Error('사용자 정보를 찾을 수 없습니다. 관리자에게 문의하세요.');
    }

    // ★ 제재 계정 즉시 차단
    if (profile.is_banned) {
      await _sb.auth.signOut();
      state.profile = null;
      throw new Error('이용이 제한된 계정입니다. 관리자에게 문의하세요.');
    }

    // 입력 필드 초기화
    document.getElementById('login-id').value = '';
    document.getElementById('login-pw').value = '';

    enterAuthenticatedApp();
    showToast('환영합니다 🌸');

  } catch (err) {
    showToast('❌ ' + err.message);
  } finally {
    setBtnLoading('btn-login', false, '로그인');
  }
}
window.doLogin = doLogin;

// ============================================================
// 9-1. 비밀번호 찾기 — Supabase resetPasswordForEmail
//
// HTML 연결 방법 (예시):
//   <button onclick="showForgotPasswordModal()">비밀번호를 잊으셨나요?</button>
//   <!-- 모달 -->
//   <div id="modal-forgot-pw" class="modal-overlay">
//     <div class="modal-sheet">
//       <div style="padding:24px;">
//         <h3 style="margin-bottom:16px;">🔑 비밀번호 재설정</h3>
//         <p style="font-size:13px;color:var(--gray-600);margin-bottom:12px;">
//           가입 시 사용한 아이디를 입력하세요.<br>
//           관리자가 재설정 링크를 발송해드립니다.
//         </p>
//         <input class="form-input" type="text" id="forgot-pw-id"
//           placeholder="아이디 입력" style="height:48px;margin-bottom:12px;">
//         <button class="btn btn-primary" id="btn-forgot-pw"
//           onclick="doForgotPassword()" style="width:100%;">재설정 메일 발송</button>
//         <button class="btn btn-outline" style="width:100%;margin-top:8px;"
//           onclick="closeModal('modal-forgot-pw')">취소</button>
//       </div>
//     </div>
//   </div>
// ============================================================

// ============================================================
// 9-1. 아이디 찾기 / 비밀번호 재설정
//      생년월일 + 학번 + 전화번호로 본인 확인
// ============================================================

/**
 * 아이디·비밀번호 찾기 모달 표시
 * mode: 'id' | 'pw'
 */
function showFindAccountModal(mode) {
  const modalId = 'modal-find-account';
  let el = document.getElementById(modalId);

  if (!el) {
    el = document.createElement('div');
    el.id        = modalId;
    el.className = 'modal-overlay';
    el.addEventListener('click', e => { if (e.target === el) el.classList.remove('show'); });
    document.body.appendChild(el);
  }

  // ★ 모드를 전역에 저장 — innerHTML 내부의 onclick에서 접근 가능
  window._findAccountMode = (mode === 'pw') ? 'pw' : 'id';
  const isId = (window._findAccountMode === 'id');

  el.innerHTML = `
    <div class="modal-sheet" style="border-radius:20px 20px 0 0;padding:0;overflow:hidden;
      max-height:90vh;overflow-y:auto;">
      <div style="background:linear-gradient(135deg,var(--pink),var(--purple));
        padding:20px 20px 16px;color:white;text-align:center;position:sticky;top:0;z-index:1;">
        <div style="font-size:22px;font-weight:800;margin-bottom:4px;">
          ${isId ? '🔍 아이디 찾기' : '🔑 비밀번호 재설정'}
        </div>
        <div style="font-size:12px;opacity:0.85;">가입 시 입력한 정보로 본인을 확인해요</div>
      </div>
      <div style="padding:20px 16px 28px;">
        <div class="form-group" style="margin-bottom:10px;">
          <label class="form-label">출생연도 <span class="required">*</span></label>
          <select class="form-select" id="find-birth-year" style="height:48px;">
            <option value="">선택해주세요</option>
            ${(()=>{ const o=[],cy=new Date().getFullYear();
              for(let y=cy-19;y>=1980;y--) o.push(`<option value="${y}">${y}년</option>`);
              return o.join(''); })()}
          </select>
        </div>
        <div class="form-group" style="margin-bottom:10px;">
          <label class="form-label">학번 <span class="required">*</span></label>
          <input class="form-input" type="text" id="find-student-num"
            style="height:48px;" placeholder="학번 입력 (예: 20201234)"
            maxlength="20" autocomplete="off">
        </div>
        <div class="form-group" style="margin-bottom:${isId ? '16px' : '10px'};">
          <label class="form-label">전화번호 <span class="required">*</span></label>
          <input class="form-input" type="tel" id="find-phone"
            style="height:48px;" placeholder="010-0000-0000"
            maxlength="15" autocomplete="off">
        </div>
        ${!isId ? `
        <div class="form-group" style="margin-bottom:10px;">
          <label class="form-label">새 비밀번호 <span class="required">*</span></label>
          <input class="form-input" type="password" id="find-new-pw"
            style="height:48px;" placeholder="새 비밀번호 (8자 이상)"
            maxlength="50" autocomplete="new-password">
        </div>
        <div class="form-group" style="margin-bottom:16px;">
          <label class="form-label">새 비밀번호 확인 <span class="required">*</span></label>
          <input class="form-input" type="password" id="find-new-pw2"
            style="height:48px;" placeholder="새 비밀번호 재입력"
            maxlength="50" autocomplete="new-password">
        </div>` : ''}
        <div id="find-account-result"
          style="font-size:13px;min-height:20px;margin-bottom:12px;
            text-align:center;white-space:pre-line;line-height:1.6;"></div>
        <!-- ★ onclick에 window._findAccountMode 사용 → 항상 현재 모드 참조 -->
        <button class="btn btn-primary"
          onclick="doFindAccount(window._findAccountMode)"
          style="width:100%;height:50px;font-size:15px;">
          ${isId ? '아이디 확인' : '비밀번호 재설정'}
        </button>
        <button class="btn btn-outline" style="width:100%;margin-top:8px;"
          onclick="closeModal('modal-find-account')">취소</button>
      </div>
    </div>`;

  el.classList.add('show');
}
window.showFindAccountModal = showFindAccountModal;

function showForgotPasswordModal() { showFindAccountModal('pw'); }
window.showForgotPasswordModal = showForgotPasswordModal;

/**
 * 아이디 찾기 또는 비밀번호 재설정
 * mode: 'id' | 'pw'
 */
async function doFindAccount(mode) {
  const birthYear  = document.getElementById('find-birth-year')?.value;
  const studentNum = document.getElementById('find-student-num')?.value.trim();
  const phone      = document.getElementById('find-phone')?.value.trim();
  const resultEl   = document.getElementById('find-account-result');
  // ★ 버튼에 id가 없으므로 모달 내 첫 번째 .btn-primary 버튼을 참조
  const modalEl    = document.getElementById('modal-find-account');
  const btnEl      = modalEl?.querySelector('button.btn.btn-primary');

  const setResult = (msg, ok) => {
    if (!resultEl) return;
    resultEl.textContent = msg;
    resultEl.style.color = ok ? '#388E3C' : '#D32F2F';
    resultEl.style.fontWeight = '600';
  };

  // 공통 검증
  if (!birthYear)  { showToast('출생연도를 선택해주세요'); return; }
  if (!studentNum) { showToast('학번을 입력해주세요'); return; }
  if (!phone)      { showToast('전화번호를 입력해주세요'); return; }

  // 비밀번호 모드 전용 검증
  let newPw = null;
  if (mode === 'pw') {
    newPw = document.getElementById('find-new-pw')?.value;
    const newPw2 = document.getElementById('find-new-pw2')?.value;
    if (!newPw || newPw.length < 8) { showToast('새 비밀번호는 8자 이상이어야 합니다'); return; }
    if (newPw !== newPw2)           { showToast('새 비밀번호가 일치하지 않습니다'); return; }
  }

  // 버튼 로딩
  if (btnEl) { btnEl.disabled = true; btnEl.textContent = '처리 중...'; }
  try {
    // ── DB 조회: birth_year + student_number 일치
    // phone_number 컬럼이 없을 수 있으므로 select에서 안전하게 처리
    const { data: matched, error: qErr } = await _sb
      .from('users')
      .select('id, username, auth_id, phone_number, student_number')
      .eq('birth_year',     parseInt(birthYear))
      .eq('student_number', studentNum)
      .is('deleted_at', null)
      .maybeSingle();

    if (qErr) {
      // phone_number 컬럼 없음 오류 → 컬럼 없이 재조회
      if (qErr.message?.includes('phone_number') || qErr.code === 'PGRST204') {
        const { data: matched2, error: qErr2 } = await _sb
          .from('users')
          .select('id, username, auth_id, student_number')
          .eq('birth_year',     parseInt(birthYear))
          .eq('student_number', studentNum)
          .is('deleted_at', null)
          .maybeSingle();
        if (qErr2) throw new Error('조회 오류: ' + qErr2.message);
        if (!matched2) {
          setResult('❌ 일치하는 회원 정보를 찾을 수 없습니다.\n출생연도·학번을 다시 확인해주세요.', false);
          return;
        }
        // phone_number 컬럼이 없으면 전화번호 대조 불가 → 학번+생년으로만 확인
        if (mode === 'id') {
          setResult(`✅ 아이디를 찾았어요!\n\n아이디: ${matched2.username}\n\n※ 전화번호 컬럼이 DB에 없어 학번으로만 확인했습니다.`, true);
          showToast(`✅ 아이디: ${matched2.username}`, 6000);
        } else {
          setResult(`✅ 본인 확인 완료!\n아이디: ${matched2.username}\n관리자(${esc(cfg.ADMIN_EMAIL||'')})에게 비밀번호 재설정을 요청하세요.`, true);
          showToast('✅ 관리자에게 비밀번호 재설정을 요청해주세요.', 6000);
        }
        return;
      }
      throw new Error('조회 오류: ' + qErr.message);
    }

    // 전화번호 숫자만 추출해 대조
    const digitsOnly = s => (s || '').replace(/\D/g, '');
    const phoneMatch = matched && (
      !matched.phone_number ||             // DB에 저장된 전화번호가 없으면 스킵
      digitsOnly(matched.phone_number) === digitsOnly(phone)
    );

    if (!matched || !phoneMatch) {
      setResult('❌ 일치하는 회원 정보를 찾을 수 없습니다.\n출생연도·학번·전화번호를 다시 확인해주세요.', false);
      return;
    }

    // ── 아이디 찾기
    if (mode === 'id') {
      setResult(`✅ 아이디를 찾았어요!\n\n아이디: ${matched.username}`, true);
      showToast(`✅ 아이디: ${matched.username}`, 6000);
      return;
    }

    // ── 비밀번호 재설정
    //    1) Supabase Auth: 해당 내부 이메일로 임시 로그인 시도
    //    2) 성공하면 updateUser로 비밀번호 변경
    //    → 프론트에서 비밀번호를 바꾸려면 현재 세션이 필요하므로
    //      "signInWithPassword(임시)" 대신 관리자 안내로 처리하고
    //      pw_reset_requests 테이블에 요청 기록을 남긴다
    const { error: rpcErr } = await _sb.from('pw_reset_requests').insert({
      user_id:    matched.id,
      username:   matched.username,
      new_pw_hash: newPw,           // ⚠️ 실제 운영 시 서버에서 해시 처리 권장
      status:     'pending',
      created_at: new Date().toISOString()
    }).select();

    // pw_reset_requests 테이블이 없으면 관리자 직접 처리 안내로 폴백
    if (rpcErr) {
      console.warn('[doFindAccount] pw_reset_requests 저장 실패 (테이블 없을 수 있음):', rpcErr.message);
      setResult(
        `✅ 본인 확인 완료!\n\n관리자에게 아래 정보를 전달해주세요:\n아이디: ${matched.username}\n문의: ${esc(cfg.ADMIN_EMAIL||'')}`,
        true
      );
      showToast('✅ 본인 확인 완료! 관리자에게 비밀번호 재설정을 요청해주세요.', 6000);
      return;
    }

    setResult('✅ 비밀번호 재설정 요청이 접수되었습니다.\n관리자 처리 후 로그인 가능합니다.', true);
    showToast('✅ 비밀번호 재설정 요청이 접수되었습니다!', 5000);
    setTimeout(() => closeModal('modal-find-account'), 3500);

  } catch(err) {
    console.error('[doFindAccount]', err);
    setResult('❌ ' + err.message, false);
    showToast('❌ ' + err.message);
  } finally {
    if (btnEl) {
      btnEl.disabled    = false;
      btnEl.textContent = mode === 'id' ? '아이디 확인' : '비밀번호 재설정';
    }
  }
}
window.doFindAccount = doFindAccount;

function doForgotPassword() { doFindAccount('pw'); }
window.doForgotPassword = doForgotPassword;
async function doAdminLogin() {
  const usernameRaw = document.getElementById('admin-id')?.value.trim();
  const password    = document.getElementById('admin-pw')?.value;

  if (!usernameRaw || !password) { showToast('아이디와 비밀번호를 입력하세요'); return; }

  setBtnLoading('btn-admin-login', true, '관리자 로그인');
  try {
    const email = `${usernameRaw}@chuncheon-dating.local`;

    const { data, error } = await _sb.auth.signInWithPassword({ email, password });
    if (error) throw new Error('아이디 또는 비밀번호가 올바르지 않습니다.');

    const profile = await loadProfile(data.user.id);
    if (!profile) {
      await _sb.auth.signOut();
      throw new Error('사용자 정보를 찾을 수 없습니다.');
    }

    // ★ role = admin 반드시 확인 — 아니면 즉시 세션 종료
    if (profile.role !== 'admin') {
      await _sb.auth.signOut();
      state.profile = null;
      throw new Error('관리자 권한이 없습니다. 일반 회원 로그인 화면을 이용해주세요.');
    }

    if (profile.is_banned) {
      await _sb.auth.signOut();
      throw new Error('이용이 제한된 계정입니다.');
    }

    document.getElementById('admin-pw').value = '';
    // 관리자 화면으로 이동 (showScreen에서 role 체크)
    showScreen('screen-admin');
    renderAdminDashboard();
    showToast('관리자로 로그인되었습니다 🛠');

  } catch (err) {
    showToast('❌ ' + err.message);
  } finally {
    setBtnLoading('btn-admin-login', false, '관리자 로그인');
  }
}
window.doAdminLogin = doAdminLogin;

// ============================================================
// 11. 로그아웃 (세션 완전 삭제)
// ============================================================
async function doLogout() {
  await _sb.auth.signOut();
  // 로컬 상태 완전 초기화
  state.authUser = null;
  state.profile  = null;
  state.regData  = null;
  state.uploadedFile = null;
  state.screenHistory = [];
  showScreen('screen-landing');
  showToast('로그아웃 되었습니다');
}
window.doLogout = doLogout;

// ============================================================
// 12. 비로그인 게스트 탐색
// ============================================================
function enterGuestBrowse() {
  state.profile = null;
  state.isPreviewMode = false;
  const banner = document.getElementById('guest-banner');
  if (banner) banner.style.display = 'block';
  setText('home-username', '게스트님');
  loadTeams();
  updateHomeStats();
  showScreen('screen-home');
}
window.enterGuestBrowse = enterGuestBrowse;

// ============================================================
// 4️⃣ 실시간 배지 카운트 업데이트
// ============================================================
async function updateBadges() {
  const profile = state.profile;
  if (!profile) {
    // 비로그인: 배지 숨김
    const b = document.getElementById('badge-requests');
    const n = document.getElementById('badge-notif');
    if (b) b.style.display = 'none';
    if (n) n.style.display = 'none';
    return;
  }

  try {
    // 내 팀 조회
    const { data: myTeam } = await _sb
      .from('teams').select('id').eq('leader_id', profile.id).single();

    let pendingCount = 0;
    if (myTeam) {
      // 받은 신청 중 pending 카운트
      const col = profile.gender === 'male' ? 'male_team_id' : 'female_team_id';
      const { count } = await _sb
        .from('match_requests')
        .select('id', { count: 'exact', head: true })
        .eq(col, myTeam.id)
        .eq('status', 'pending');
      pendingCount = count || 0;
    }

    const badgeReq  = document.getElementById('badge-requests');
    const badgeNotif = document.getElementById('badge-notif');

    if (badgeReq) {
      if (pendingCount > 0) {
        badgeReq.textContent = pendingCount;
        badgeReq.style.display = 'flex';
      } else {
        badgeReq.style.display = 'none';
      }
    }
    if (badgeNotif) {
      if (pendingCount > 0) {
        badgeNotif.textContent = pendingCount;
        badgeNotif.style.display = 'flex';
        document.getElementById('btn-notif-bell').onclick =
          () => switchTab('requests');
      } else {
        badgeNotif.style.display = 'none';
      }
    }
  } catch(e) {
    console.warn('[updateBadges]', e.message);
  }
}
window.updateBadges = updateBadges;

// ============================================================
// 13. 홈 통계 — Supabase 직접 집계
// ============================================================
async function updateHomeStats() {
  try {
    const results = await Promise.allSettled([
      // 등록팀 수 — teams는 보통 anon도 접근 가능
      _sb.from('teams').select('id', { count:'exact', head:true })
        .eq('status','recruiting').eq('is_visible',true),
      // 매칭 성사 수 — teams.status = matched
      _sb.from('teams').select('id', { count:'exact', head:true })
        .eq('status','matched'),
      // 남성 회원 — RLS 막힐 수 있으므로 실패해도 OK
      _sb.from('users').select('id', { count:'exact', head:true })
        .eq('gender','male').is('deleted_at',null),
      // 여성 회원
      _sb.from('users').select('id', { count:'exact', head:true })
        .eq('gender','female').is('deleted_at',null),
    ]);

    const safe = r => {
      if (r.status !== 'fulfilled') return null;
      const v = r.value;
      if (v?.error) return null;
      if (typeof v?.count === 'number') return v.count;
      if (Array.isArray(v?.data)) return v.data.length;
      return null;
    };

    const teams   = safe(results[0]);
    const matched = safe(results[1]);
    const males   = safe(results[2]);
    const females = safe(results[3]);

    if (teams   !== null) setText('stat-teams',   teams);
    if (matched !== null) setText('stat-matched', matched);
    if (males   !== null && females !== null) setText('stat-members', males + females);
    else if (males !== null) setText('stat-members', males);
    else if (females !== null) setText('stat-members', females);
  } catch(e) { console.warn('[updateHomeStats]', e.message); }
}
window.updateHomeStats = updateHomeStats;

// ============================================================
// 14. 회원가입 — 실제 DB 저장
// ============================================================

/**
 * 아이디 중복 확인 (버튼 클릭 또는 goToVerification 내부에서 호출)
 *
 * @param {string}  username     확인할 아이디 (이미 trim된 값)
 * @param {boolean} silent       true면 토스트 없이 boolean만 반환 (goToVerification 내부용)
 * @returns {Promise<boolean>}   사용 가능하면 true, 중복이면 false
 */
async function _checkUsernameAvailable(username, silent = false) {
  if (!username || username.length < 4) {
    if (!silent) showToast('아이디는 4자 이상이어야 합니다');
    return false;
  }
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    if (!silent) showToast('아이디는 영문·숫자·밑줄만 사용 가능합니다');
    return false;
  }
  const { data } = await _sb
    .from('users').select('id').eq('username', username).maybeSingle();
  if (data) {
    if (!silent) showToast('❌ 이미 사용 중인 아이디입니다');
    return false;
  }
  if (!silent) showToast('✅ 사용 가능한 아이디입니다');
  return true;
}

/**
 * 아이디 중복 확인 버튼 핸들러 (HTML에서 onclick="checkUsernameBtn()" 으로 호출)
 * 버튼 ID: btn-check-username  /  입력 ID: reg-username
 * 결과 표시 영역 ID: username-check-result
 */
async function checkUsernameBtn() {
  const input = document.getElementById('reg-username');
  const username = input?.value.trim() ?? '';
  const resultEl = document.getElementById('username-check-result');

  setBtnLoading('btn-check-username', true, '확인');
  try {
    const ok = await _checkUsernameAvailable(username, true);

    // 결과 영역이 HTML에 있으면 인라인으로도 표시
    if (resultEl) {
      resultEl.textContent = ok ? '✅ 사용 가능한 아이디입니다' : '❌ 이미 사용 중인 아이디입니다';
      resultEl.style.color = ok ? 'var(--success, #388E3C)' : 'var(--error, #D32F2F)';
      resultEl.style.fontSize = '12px';
      resultEl.style.marginTop = '4px';
    }
    // 입력 필드 테두리로 즉각 피드백
    if (input) input.style.borderColor = ok ? 'var(--success, #388E3C)' : 'var(--error, #D32F2F)';

    // 중복이면 토스트로도 알림
    if (!ok) showToast('❌ 이미 사용 중인 아이디입니다');
    else      showToast('✅ 사용 가능한 아이디입니다');
  } catch(err) {
    showToast('❌ 중복 확인 중 오류: ' + err.message);
  } finally {
    setBtnLoading('btn-check-username', false, '확인');
  }
}
window.checkUsernameBtn = checkUsernameBtn;

// 아이디 입력란 변경 시 이전 결과 초기화 (UX 보조)
function onUsernameInput() {
  const resultEl = document.getElementById('username-check-result');
  const input    = document.getElementById('reg-username');
  if (resultEl) resultEl.textContent = '';
  if (input)    input.style.borderColor = '';
}
window.onUsernameInput = onUsernameInput;

async function goToVerification() {
  // ── 필수 동의 검증
  // ── index.html 회원가입 폼에 필요한 전화번호 필드 (없으면 추가):
  //   <div class="form-group">
  //     <label class="form-label">전화번호 <span class="required">*</span></label>
  //     <input class="form-input" type="tel" id="reg-phone"
  //       placeholder="010-0000-0000" maxlength="15" autocomplete="tel">
  //   </div>
  const required = document.querySelectorAll('.required-agree');
  for (const cb of required) {
    if (!cb.checked) { showToast('필수 항목에 모두 동의해주세요'); return; }
  }

  // 폼 값 수집
  const username   = document.getElementById('reg-username')?.value.trim();
  const password   = document.getElementById('reg-password')?.value;
  const password2  = document.getElementById('reg-password2')?.value;
  const gender     = document.querySelector('input[name="gender"]:checked')?.value;
  const university = document.getElementById('reg-univ')?.value;
  const department = document.getElementById('reg-dept')?.value.trim();
  const studentNum = document.getElementById('reg-student-num')?.value.trim();
  const birthYear  = parseInt(document.getElementById('birth-year')?.value || '0');
  const nickname   = document.getElementById('reg-nickname')?.value.trim();
  const phoneNum   = document.getElementById('reg-phone')?.value.trim() || null;
  const mbti       = document.getElementById('reg-mbti')?.value || null;
  const smoking    = document.querySelector('input[name="smoking"]:checked')?.value === 'yes';
  const bio        = document.getElementById('reg-bio')?.value.trim() || null;
  const marketing  = !!document.getElementById('agree-marketing')?.checked;
  const customBadge = document.getElementById('reg-custom-badge')?.value.trim() || null;

  // 입력값 클라이언트 검증
  if (!username || username.length < 4) { showToast('아이디는 4자 이상이어야 합니다'); return; }
  if (!/^[a-zA-Z0-9_]+$/.test(username)){ showToast('아이디는 영문·숫자·밑줄만 사용 가능합니다'); return; }
  if (!password || password.length < 8)  { showToast('비밀번호는 8자 이상이어야 합니다'); return; }
  if (password !== password2)            { showToast('비밀번호가 일치하지 않습니다'); return; }
  if (!gender)                           { showToast('성별을 선택해주세요'); return; }
  if (!university || university === '')  { showToast('대학교를 선택해주세요'); return; }
  if (!department || department.length < 2){ showToast('학과를 입력해주세요'); return; }
  if (!studentNum || studentNum.length < 6){ showToast('학번을 입력해주세요'); return; }
  // 2007년생(만 19세) 허용 — 대학 신입생 기준 완화
  if (!birthYear || birthYear < 1980 || birthYear > new Date().getFullYear() - 17) {
    showToast('출생연도를 다시 확인해주세요 (1980년 이후~2007년생까지 가입 가능)'); return;
  }
  if (!nickname || nickname.length < 2)  { showToast('닉네임은 2자 이상이어야 합니다'); return; }
  if (!phoneNum || !/^[0-9\-+\s]{9,15}$/.test(phoneNum)) {
    showToast('전화번호를 올바르게 입력해주세요 (예: 010-0000-0000)'); return;
  }

  // ── 아이디 중복 확인 (DB 재확인 — silent 모드로 호출, 결과는 토스트로 표시)
  const usernameOk = await _checkUsernameAvailable(username, false);
  if (!usernameOk) return;

  // 임시 저장
  state.regData = {
    username, password, gender, university, department,
    student_number: studentNum, birth_year: birthYear,
    nickname, phone_number: phoneNum, mbti, smoking, bio, marketing_agree: marketing,
    custom_badge: customBadge,
    consents: {
      isAdult:           document.querySelectorAll('.required-agree')[0]?.checked,
      termsAgree:        document.querySelectorAll('.required-agree')[1]?.checked,
      privacyAgree:      document.querySelectorAll('.required-agree')[2]?.checked,
      verificationAgree: document.querySelectorAll('.required-agree')[3]?.checked,
      depositAgree:      document.querySelectorAll('.required-agree')[4]?.checked,
      falsifyAgree:      document.querySelectorAll('.required-agree')[5]?.checked,
      marketingAgree:    marketing
    }
  };

  showScreen('screen-verification');
}
window.goToVerification = goToVerification;

// ============================================================
// 15. 학생증 업로드 + 회원가입 최종 완료
// ============================================================

/**
 * _waitForSession: signUp 직후 세션이 아직 클라이언트에 반영되지 않은 경우를 대비해
 * 최대 maxMs 동안 폴링으로 세션 확정을 기다린다.
 * "Confirm Email = OFF" 환경에서는 첫 시도에 바로 반환된다.
 *
 * @param {string}  expectedUid  authData.user.id — 세션의 uid가 이것과 일치해야 한다
 * @param {number}  maxMs        최대 대기 시간 (ms), 기본 3000
 * @param {number}  intervalMs   폴링 간격 (ms), 기본 300
 * @returns {{ session, userId } | null}  확정된 세션 정보, 또는 timeout 시 null
 */
async function _waitForSession(expectedUid, maxMs = 3000, intervalMs = 300) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const { data: { session } } = await _sb.auth.getSession();
    if (session?.user?.id === expectedUid) {
      return { session, userId: session.user.id };
    }
    // 아직 세션이 없거나 uid 불일치 → 짧게 대기 후 재시도
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return null; // timeout
}

async function submitVerification() {
  const d = state.regData;
  if (!d) { showToast('회원가입 정보가 없습니다. 처음부터 다시 시작해주세요.'); return; }

  // ── 파일 검증
  const fileInput = document.getElementById('file-input');
  const file      = fileInput?.files?.[0];
  if (!file) { showToast('학생증 이미지를 업로드해주세요'); return; }

  const ALLOWED_TYPES = ['image/jpeg','image/png','image/webp'];
  const ALLOWED_EXTS  = ['jpg','jpeg','png','webp'];
  const fileExt       = file.name.split('.').pop().toLowerCase().replace(/[^a-z]/g,'');
  const fileSizeMB    = (file.size / (1024*1024)).toFixed(2);

  if (!ALLOWED_TYPES.includes(file.type)) {
    showToast(`❌ JPG·PNG·WEBP 파일만 업로드 가능합니다 (현재: ${esc(file.type||'알 수 없음')})`);
    return;
  }
  if (!ALLOWED_EXTS.includes(fileExt)) {
    showToast(`❌ 파일 확장자가 올바르지 않습니다 (.${esc(fileExt)})`);
    return;
  }
  if (file.size > 10*1024*1024) {
    showToast(`❌ 파일 크기 초과: ${fileSizeMB}MB (최대 10MB)`);
    return;
  }

  setBtnLoading('btn-verify', true, '업로드 완료');
  try {

    // ════════════════════════════════════════════════════
    // STEP 1 — Auth 계정 확보 (멱등: 이미 있으면 로그인으로 복구)
    // ════════════════════════════════════════════════════
    const email = `${d.username}@chuncheon-dating.local`;
    let signUpUid = null;

    // 1-a. 현재 세션이 이미 이 이메일이면 재사용
    const { data: { session: curSession } } = await _sb.auth.getSession().catch(() => ({ data:{session:null} }));
    if (curSession?.user?.email === email) {
      signUpUid = curSession.user.id;
      console.info('[SV] 세션 재사용:', signUpUid);
    }

    // 1-b. 세션 없음 → signUp 시도
    if (!signUpUid) {
      const { data: signUpData, error: signUpErr } = await _sb.auth.signUp({
        email,
        password: d.password,
        options: { data: { username: d.username } }
      });

      if (!signUpErr && signUpData?.user?.id) {
        // 신규 가입 성공
        signUpUid = signUpData.user.id;
        console.info('[SV] 신규 signUp 성공:', signUpUid);

        // 세션 확정 대기 (Confirm Email OFF 환경: 바로 발급, ON 환경: timeout)
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          const { data: { session: s } } = await _sb.auth.getSession().catch(() => ({ data:{session:null} }));
          if (s?.user?.id === signUpUid) break;
          await new Promise(r => setTimeout(r, 300));
        }

      } else if (signUpErr) {
        // 1-c. "already registered" → 이전 시도에서 Auth만 만들어진 경우 → 로그인으로 복구
        const isAlready =
          signUpErr.message.toLowerCase().includes('already registered') ||
          signUpErr.message.toLowerCase().includes('user_already_exists');

        if (isAlready) {
          console.warn('[SV] Auth 계정 이미 있음, signIn으로 uid 복구 시도');
          const { data: signInData, error: signInErr } = await _sb.auth.signInWithPassword({ email, password: d.password });
          if (signInErr) {
            // 비번 불일치 → 진짜 다른 사람 계정 → 안전하게 초기화
            state.regData = null;
            throw new Error('이 아이디는 이미 다른 계정에서 사용 중입니다. 다른 아이디로 처음부터 다시 시작해주세요.');
          }
          signUpUid = signInData.user.id;
          console.info('[SV] signIn으로 uid 복구:', signUpUid);
        } else {
          throw new Error(`계정 생성 실패: ${signUpErr.message}`);
        }
      } else {
        throw new Error('계정 생성 응답이 올바르지 않습니다. 잠시 후 다시 시도해주세요.');
      }
    }

    if (!signUpUid) throw new Error('계정 uid를 확인할 수 없습니다.');

    // UUID 형식 검증
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(signUpUid)) {
      throw new Error(`uid 형식 오류: ${esc(signUpUid)}`);
    }

    // ════════════════════════════════════════════════════
    // STEP 2 — users 프로필 저장 (멱등: 이미 있으면 스킵)
    // ════════════════════════════════════════════════════
    let profile = null;

    // 기존 프로필 조회 — .catch() 금지, try/catch로 처리
    let existingProfile = null;
    try {
      const { data: ep } = await _sb
        .from('users').select('*').eq('auth_id', signUpUid).maybeSingle();
      existingProfile = ep;
    } catch(_) { existingProfile = null; }

    if (existingProfile) {
      profile = existingProfile;
      console.info('[SV] 기존 프로필 재사용:', profile.id);
    } else {
      // ★ phone_number는 users 테이블에 컬럼이 없을 수 있으므로
      //   payload를 동적으로 구성해 컬럼이 있을 때만 포함
      const insertPayload = {
        auth_id:         signUpUid,
        username:        d.username,
        nickname:        d.nickname,
        gender:          d.gender,
        role:            'user',
        university:      d.university,
        department:      d.department,
        student_number:  d.student_number,
        birth_year:      d.birth_year,
        smoking:         d.smoking,
        mbti:            d.mbti,
        bio:             d.bio,
        marketing_agree: d.marketing_agree,
        profile_active:  false
      };
      // phone_number 컬럼이 DB에 추가된 경우에만 포함
      if (d.phone_number) insertPayload.phone_number = d.phone_number;
      // custom_badge 컬럼이 DB에 있는 경우에만 포함 (없으면 무시)
      if (d.custom_badge) insertPayload.custom_badge = d.custom_badge;

      let newP, profileErr;
      ({ data: newP, error: profileErr } = await _sb.from('users').insert(insertPayload).select().single());

      // ★ 컬럼 없음(PGRST204) 또는 schema cache 오류 → 선택 컬럼 제거 후 재시도
      const isMissingCol = (e) =>
        e?.code === 'PGRST204' ||
        e?.message?.includes('schema cache') ||
        e?.message?.includes('Could not find');

      if (profileErr && isMissingCol(profileErr)) {
        console.warn('[SV] 선택 컬럼 오류, 필수 컬럼만으로 재시도:', profileErr.message);
        // custom_badge, phone_number 제거 후 재시도
        delete insertPayload.custom_badge;
        delete insertPayload.phone_number;
        ({ data: newP, error: profileErr } = await _sb.from('users').insert(insertPayload).select().single());
      }

      if (profileErr) {
        if (profileErr.code === '23505') {
          // 중복 시 재조회
          let retryProfile = null;
          try {
            const { data: rp } = await _sb
              .from('users').select('*').eq('auth_id', signUpUid).maybeSingle();
            retryProfile = rp;
          } catch(_) {}

          if (retryProfile) {
            profile = retryProfile;
          } else {
            state.regData = null;
            throw new Error('아이디 중복 오류입니다. 다른 아이디로 다시 시작해주세요.');
          }
        } else if (profileErr.code === '42501') {
          throw new Error('RLS 권한 오류: Supabase → SQL Editor에서 users 테이블 INSERT 정책을 확인하세요. (auth.uid() = auth_id 조건 필요)');
        } else if (profileErr.code === '23514') {
          // birth_year 체크 제약 위반 → 제약 해제 SQL 안내
          throw new Error(
            `출생연도(${d.birth_year})가 DB 제약 조건에 걸렸습니다.\n` +
            'Supabase SQL Editor에서 아래 SQL을 실행해주세요:\n' +
            'ALTER TABLE users DROP CONSTRAINT IF EXISTS users_birth_year_check;'
          );
        } else if (isMissingCol(profileErr)) {
          // 재시도 후에도 컬럼 오류 → 핵심 컬럼만으로 3차 시도
          throw new Error(`프로필 저장 실패 (컬럼 없음): ${profileErr.message}\nSupabase 스키마 캐시를 새로고침 해주세요.`);
        } else {
          throw new Error(`프로필 저장 실패 [${profileErr.code}]: ${profileErr.message}`);
        }
      } else {
        profile = newP;
      }
    }

    if (!profile) throw new Error('프로필을 확보할 수 없습니다. 관리자에게 문의하세요.');

    // ── STEP 3: 동의 항목 (이미 있으면 무시 — .catch() 금지)
    const c = d.consents;
    const { error: consentErr } = await _sb.from('terms_consents').insert({
      user_id: profile.id, is_adult: true, terms_agree: true,
      privacy_agree: true, verification_agree: true,
      deposit_agree: true, falsify_agree: true,
      marketing_agree: !!c.marketingAgree
    });
    if (consentErr && consentErr.code !== '23505') {
      console.warn('[SV] 동의 저장 실패(무시):', consentErr.message);
    }

    // ════════════════════════════════════════════════════
    // STEP 4 — Storage 업로드
    //
    // ★ RLS 핵심: Storage 버킷 정책이
    //   "name LIKE 'verifications/' || auth.uid() || '/%'"
    //   형태여야 한다. 세션이 없으면(Confirm Email ON) 업로드가 막힘.
    //
    // → upsert:true 사용으로 동일 경로 재시도 허용
    // → 실패 시 에러 코드별 상세 안내
    // ════════════════════════════════════════════════════
    const safeName = `${Date.now()}_${Math.random().toString(36).slice(2,7)}.${fileExt}`;
    const filePath = `verifications/${signUpUid}/${safeName}`;

    const { error: uploadErr } = await _sb.storage
      .from('student-verifications')
      .upload(filePath, file, { contentType: file.type, upsert: true });

    if (uploadErr) {
      const code = uploadErr.statusCode ?? '';
      const msg  = uploadErr.message ?? '';
      let guide  = '';

      if (msg.includes('Bucket not found') || msg.includes('bucket')) {
        guide = '스토리지 버킷(student-verifications)이 없습니다. ' +
                'Supabase → Storage에서 "student-verifications" 버킷을 생성하세요.';
      } else if (code === '403' || msg.includes('security') || msg.includes('policy') || msg.includes('RLS')) {
        guide = 'Storage 권한 오류입니다. Supabase → Storage → Policies에서\n' +
                '"student-verifications" 버킷에 아래 INSERT 정책을 추가하세요:\n' +
                'USING: bucket_id = \'student-verifications\'\n' +
                'CHECK: name LIKE \'verifications/\' || auth.uid() || \'/%\'';
      } else if (code === '409' || msg.includes('Duplicate') || msg.includes('already exists')) {
        // upsert:true인데도 409면 RLS가 UPDATE도 막는 것 → 정책 안내
        guide = '파일 중복 오류입니다. 잠시 후 다시 시도해주세요.';
      } else if (msg.includes('size') || msg.includes('limit') || msg.includes('too large')) {
        guide = `파일 크기 제한 초과 (${fileSizeMB}MB). 10MB 이하 파일을 사용해주세요.`;
      } else {
        guide = `이미지 업로드 실패 [${code}]: ${msg}`;
      }
      throw new Error(guide);
    }

    // ── STEP 5: student_verifications 저장 (이미 있으면 무시)
    const { error: verifErr } = await _sb.from('student_verifications').insert({
      user_id: profile.id, image_path: filePath, status: 'pending'
    });
    if (verifErr && verifErr.code !== '23505') {
      throw new Error(`인증 정보 저장 실패 [${verifErr.code}]: ${verifErr.message}`);
    }

    // ── STEP 6: deposits 초기 레코드 (이미 있으면 무시 — .catch() 금지)
    const fee = profile.gender === 'female' ? cfg.FEE_FEMALE : cfg.FEE_MALE;
    const { error: depositErr } = await _sb.from('deposits').insert({
      user_id: profile.id, depositor_name: profile.nickname,
      amount: fee, status: 'pending_confirm'
    });
    if (depositErr && depositErr.code !== '23505') {
      console.warn('[SV] deposits 저장 실패(무시):', depositErr.code, depositErr.message);
    }

    // ── 완료
    state.profile = profile;
    state.regData = null;
    setText('home-username', profile.nickname + '님');
    showToast('🎉 가입 완료! 학생증 검토 후 활성화됩니다');
    showScreen('screen-deposit');

  } catch (err) {
    console.error('[submitVerification]', err);
    showToast('❌ ' + err.message, 5000);
  } finally {
    setBtnLoading('btn-verify', false, '업로드 완료');
  }
}
window.submitVerification = submitVerification;

// ============================================================
// 16. 입금 신청 → DB 저장
// ============================================================
async function submitDeposit() {
  const profile = state.profile;
  if (!profile) { showToast('로그인이 필요합니다'); return; }

  const name = document.getElementById('depositor-name')?.value.trim();
  if (!name || name.length < 2) { showToast('입금자명을 정확히 입력해주세요'); return; }

  const amount = profile.gender === 'female' ? cfg.FEE_FEMALE : cfg.FEE_MALE;

  setBtnLoading('btn-deposit', true, '입금 완료했습니다 ✓');
  try {
    const { error } = await _sb.from('deposits').upsert(
      { user_id: profile.id, depositor_name: name, amount, status: 'pending_confirm' },
      { onConflict: 'user_id' }
    );
    if (error) throw new Error('입금 신청 저장 실패 (RLS 정책 오류 — Supabase SQL Editor에서 deposits 테이블 INSERT 정책을 확인하세요): ' + error.message);

    showToast('💳 입금 신청 완료! 관리자 확인 후 서비스가 활성화됩니다');
    showScreen('screen-pending');
  } catch(err) {
    showToast('❌ ' + err.message);
  } finally {
    setBtnLoading('btn-deposit', false, '입금 완료했습니다 ✓');
  }
}
window.submitDeposit = submitDeposit;

// ============================================================
// 17. 회원 완전삭제 (deleteAccount) — 연관 데이터 전체 제거
// ============================================================
async function deleteAccount() {
  const profile = state.profile;
  const authUser = state.authUser;
  if (!profile || !authUser) return;
  if (!confirm('정말 탈퇴하시겠습니까?\n모든 데이터가 즉시 삭제되며 복구할 수 없습니다.')) return;

  const safeDelete = async (table, filter) => {
    try {
      let q = _sb.from(table).delete();
      for (const [col, val] of Object.entries(filter)) {
        if (Array.isArray(val)) q = q.in(col, val);
        else                    q = q.eq(col, val);
      }
      const { error } = await q;
      if (error) console.warn(`[deleteAccount] ${table} 삭제 경고:`, error.message);
    } catch(e) {
      console.warn(`[deleteAccount] ${table} 삭제 오류:`, e.message);
    }
  };

  try {
    // STEP 1: soft delete (재가입 방지)
    const { error: softErr } = await _sb
      .from('users')
      .update({ deleted_at: new Date().toISOString(), profile_active: false })
      .eq('id', profile.id);
    if (softErr) throw new Error('탈퇴 처리 실패 (users 업데이트): ' + softErr.message);

    // STEP 2: 내 팀 ID 목록 수집
    const { data: myTeams } = await _sb.from('teams').select('id').eq('leader_id', profile.id);
    const myTeamIds = (myTeams || []).map(t => t.id);

    // STEP 3: 외래키 순서대로 삭제 — 자식 테이블 먼저

    // 3-1: messages (team_id 또는 sender_id 기준)
    if (myTeamIds.length > 0) await safeDelete('messages', { team_id: myTeamIds });
    await safeDelete('messages', { sender_id: profile.id });

    // 3-2: match_requests (팀 ID 기준 양방향)
    if (myTeamIds.length > 0) {
      await safeDelete('match_requests', { male_team_id: myTeamIds });
      await safeDelete('match_requests', { female_team_id: myTeamIds });
    }

    // 3-3: team_members (내 팀의 멤버 + 내가 멤버로 있는 다른 팀)
    if (myTeamIds.length > 0) await safeDelete('team_members', { team_id: myTeamIds });
    // 내 닉네임으로 다른 팀에 등록된 팀원 행 삭제
    if (profile.nickname) await safeDelete('team_members', { nickname: profile.nickname });

    // 3-4: teams (내가 팀장인 팀)
    if (myTeamIds.length > 0) await safeDelete('teams', { id: myTeamIds });

    // 3-5: deposits, student_verifications
    await safeDelete('deposits',              { user_id: profile.id });
    await safeDelete('student_verifications', { user_id: profile.id });

    // 3-6: reports (신고자 기록)
    await safeDelete('reports', { reporter_id: profile.id });

    // STEP 4: users 행 완전 삭제
    const { error: userDelErr } = await _sb.from('users').delete().eq('id', profile.id);
    if (userDelErr) {
      // RLS나 외래키로 인해 실패할 수 있음 — soft delete로 대체 유지
      console.warn('[deleteAccount] users 행 삭제 실패 (soft delete 유지):', userDelErr.message);
    }

    // STEP 5: Auth 세션 종료
    await _sb.auth.signOut();

    // STEP 6: 로컬 상태 초기화
    state.authUser = null; state.profile = null;
    state.regData  = null; state.uploadedFile = null;
    state.screenHistory = [];

    closeModal('modal-withdraw');
    showScreen('screen-landing');
    showToast('탈퇴가 완료되었습니다. 이용해주셔서 감사합니다.');

  } catch (err) {
    console.error('[deleteAccount]', err);
    // 롤백: soft delete 취소
    try {
      await _sb.from('users')
        .update({ deleted_at: null, profile_active: !!profile.profile_active })
        .eq('id', profile.id);
    } catch(e) { console.error('[deleteAccount] 롤백 실패:', e.message); }
    showToast('❌ 탈퇴 처리 중 오류 (외래키 또는 RLS): ' + err.message, 5000);
  }
}
window.deleteAccount = deleteAccount;

// 하위 호환용 alias
async function doWithdraw() { await deleteAccount(); }
window.doWithdraw = doWithdraw;

// ============================================================
// 18. 팀 목록 (DB에서 로드) — 남녀팀 모두 표시
// ============================================================
let _cachedTeams = [];

async function loadTeams(filterVal) {
  const container = document.getElementById('team-list');
  if (!container) return;
  container.innerHTML = '<div style="text-align:center;padding:40px;"><div class="spinner"></div></div>';

  try {
    // 남녀 모두 조회 (성별 필터 제거)
    let query = _sb
      .from('teams')
      .select('*, team_members(*)')
      .eq('status', 'recruiting')
      .eq('is_visible', true)
      .order('created_at', { ascending: false });

    if (filterVal && filterVal !== 'all' && filterVal !== '비흡연'
        && filterVal !== 'male' && filterVal !== 'female') {
      query = query.ilike('university', `%${filterVal}%`);
    }
    if (filterVal === 'male' || filterVal === 'female') {
      query = query.eq('gender', filterVal);
    }

    const { data, error } = await query;
    if (error) throw error;

    let teams = data || [];
    if (filterVal === '비흡연') {
      teams = teams.filter(t => t.team_members?.every(m => !m.smoking));
    }

    // ── 인증완료(is_verified=true) 팀을 상단 노출, 나머지 최신순
    teams.sort((a, b) => {
      const av = a.is_verified ? 1 : 0;
      const bv = b.is_verified ? 1 : 0;
      if (bv !== av) return bv - av;                         // 인증팀 먼저
      return new Date(b.created_at) - new Date(a.created_at); // 동일하면 최신순
    });

    _cachedTeams = teams;
    renderTeamList();
  } catch(err) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">⚠️</div>
        <div class="empty-title">팀 목록을 불러올 수 없습니다</div>
        <div class="empty-desc">${esc(err.message)}</div>
      </div>`;
  }
}
window.loadTeams = loadTeams;

// ============================================================
// 19. 팀 목록 렌더 (XSS 방어 적용) — 성별 배지 + 인증 배지
// ============================================================
const EMOJIS_M = ['👨‍💻','🎮','🎸','☕','✈️','🎨','💪','🎳','🕹️','📚'];
const EMOJIS_F = ['👩‍🎨','🌸','🎵','📖','🧁','💃','🌿','🎀','🦋','☀️'];
const EMOJIS   = EMOJIS_M; // 하위 호환용
const COLORS_M = ['#C77DFF','#7B2FF7','#48CAE4','#F77F00','#4CAF50'];
const COLORS_F = ['#FF6B9D','#FF4D7D','#F8BBD9','#FF8C69','#E91E8C'];
const COLORS   = COLORS_M;

function renderTeamList() {
  const container = document.getElementById('team-list');
  if (!container) return;

  const isGuest = !state.profile;
  const teams   = _cachedTeams;

  if (teams.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🌸</div>
        <div class="empty-title">아직 등록된 팀이 없어요</div>
        <div class="empty-desc" style="margin-bottom:20px;">첫 번째로 팀을 등록하고 매칭의 주인공이 되어보세요!</div>
        <button class="btn btn-primary" style="width:auto;padding:0 28px;" onclick="switchTab('find')">팀 등록하기 →</button>
      </div>`;
    return;
  }

  container.innerHTML = teams.map((team, ti) => {
    const isMale   = team.gender === 'male';
    const emojis   = isMale ? EMOJIS_M : EMOJIS_F;
    const colors   = isMale ? COLORS_M : COLORS_F;
    const members  = team.team_members || [];
    const avgAge   = members.length
      ? Math.round(members.reduce((s,m) => s + (m.age || 22), 0) / members.length) : 22;

    // 성별 배지
    const genderBadge = isMale
      ? `<span class="chip chip-purple" style="font-size:11px;">👨 남성팀</span>`
      : `<span class="chip chip-pink"   style="font-size:11px;">👩 여성팀</span>`;

    // 인증 완료 배지
    const verifBadge = team.is_verified
      ? `<span class="chip chip-green" style="font-size:11px;">✅ 인증완료</span>` : '';

    // 인증팀 상단 강조 테두리
    const cardBorder = team.is_verified
      ? 'border:2px solid #4CAF50;' : '';

    const memberRows = members.slice(0, 3).map((m, i) => `
      <div class="team-card-member">
        <div class="team-member-emoji">${emojis[(ti * 3 + i) % emojis.length]}</div>
        <div class="team-member-details">
          <div class="team-member-name">${esc(m.nickname)} · ${esc(String(m.age))}세 · ${esc(m.department)}</div>
          <div style="display:flex;gap:4px;margin-top:3px;flex-wrap:wrap;">
            ${m.mbti ? `<span class="chip chip-purple" style="font-size:10px;padding:2px 7px;">${esc(m.mbti)}</span>` : ''}
            ${m.custom_badge ? `<span class="chip" style="font-size:10px;padding:2px 7px;background:#FFF0F5;color:var(--pink);border:1px solid var(--pink-light);">${esc(m.custom_badge)}</span>` : ''}
            <span class="chip" style="font-size:10px;padding:2px 7px;
              background:${m.smoking ? '#FFF3E0' : '#E8F5E9'};color:${m.smoking ? '#E65100' : '#388E3C'};">
              ${m.smoking ? '🚬' : '🚭'}
            </span>
          </div>
          ${m.intro ? `<p style="font-size:11px;color:var(--gray-600);margin-top:3px;">"${esc(m.intro)}"</p>` : ''}
        </div>
      </div>`).join('');

    // 신청 버튼: 매칭완료 팀은 신청 불가
    let applyBtn = '';
    if (team.status === 'matched') {
      applyBtn = `<button class="btn btn-outline btn-sm" style="flex:1;cursor:default;opacity:0.5;" disabled>🎉 매칭완료</button>`;
    } else if (isGuest) {
      applyBtn = `<button class="btn btn-primary btn-sm" style="flex:1;" onclick="showAuthGateModal('apply')">💌 신청하기</button>`;
    } else if (isMale) {
      if (state.profile?.gender === 'female') {
        applyBtn = `<button class="btn btn-primary btn-sm" style="flex:1;" onclick="openApplyScreen('${esc(team.id)}')">💌 신청하기</button>`;
      } else {
        applyBtn = `<button class="btn btn-outline btn-sm" style="flex:1;cursor:default;opacity:0.5;" disabled>👨 남성팀 (신청 불가)</button>`;
      }
    } else {
      if (state.profile?.gender === 'male') {
        applyBtn = `<button class="btn btn-primary btn-sm" style="flex:1;" onclick="openApplyScreen('${esc(team.id)}')">💌 신청하기</button>`;
      } else {
        applyBtn = `<button class="btn btn-outline btn-sm" style="flex:1;cursor:default;opacity:0.5;" disabled>👩 여성팀 (신청 불가)</button>`;
      }
    }

    return `
    <div class="team-card" style="${cardBorder}" onclick="openTeamDetail('${esc(team.id)}')">
      ${team.is_verified ? `<div style="background:linear-gradient(90deg,#E8F5E9,#F1F8E9);
        padding:4px 12px;text-align:center;font-size:11px;font-weight:700;color:#388E3C;">
        ✅ 인증 완료 팀 — 우선 노출
      </div>` : ''}
      ${isGuest ? `<div style="background:#FFF8E1;padding:5px 12px;text-align:center;font-size:11px;color:#795548;">
        👀 구경 중 — 신청은 <span style="color:var(--pink);font-weight:700;cursor:pointer;"
          onclick="event.stopPropagation();showScreen('screen-register')">가입 후</span> 가능해요
      </div>` : ''}
      <div class="team-card-header">
        <div class="team-avatar-group">
          ${members.slice(0, 3).map((_, i) => `
            <div class="team-avatar" style="background:${colors[(ti * 3 + i) % colors.length]}20;font-size:18px;">
              ${emojis[(ti * 3 + i) % emojis.length]}
            </div>`).join('')}
        </div>
        <div class="team-card-info">
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:3px;">
            <div class="team-card-title" style="margin-bottom:0;">${esc(team.title)}</div>
            ${genderBadge}
            ${verifBadge}
          </div>
          <div class="team-card-sub">${esc(team.university)} · 평균 ${esc(String(avgAge))}세 · ${members.length}명</div>
        </div>
        ${team.status === 'matched'
          ? `<span class="chip chip-green">🎉 매칭완료</span>`
          : `<span class="chip chip-pink">모집중</span>`}
      </div>
      <div class="team-card-members">${memberRows}</div>
      <div class="team-card-footer">
        ${applyBtn}
        <button class="btn btn-outline btn-sm" style="width:80px;"
          onclick="event.stopPropagation();openTeamDetail('${esc(team.id)}')">상세보기</button>
      </div>
    </div>`;
  }).join('');
}
window.renderTeamList = renderTeamList;

// ============================================================
// 20. 팀 필터
// ============================================================
function filterTeams(el, val) {
  document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  loadTeams(val);
}
window.filterTeams = filterTeams;

// ============================================================
// 21. 팀 상세
// ============================================================
async function openTeamDetail(teamId) {
  // 보안: ID 형식 검증
  if (!/^[0-9a-f-]{36}$/i.test(teamId)) return;

  const team = _cachedTeams.find(t => t.id === teamId);
  if (!team) return;

  // 현재 상세보기 팀 ID 저장 (신청 버튼에서 참조)
  window._currentDetailTeamId = teamId;

  // textContent로 안전하게 설정
  setText('detail-title', team.title);
  setText('detail-univ', team.university);

  const membersEl = document.getElementById('detail-members');
  if (membersEl) {
    const members = team.team_members || [];
    membersEl.innerHTML = members.map((m,i) => `
      <div class="member-row">
        <div class="member-avatar" style="background:rgba(255,107,157,0.15);color:var(--pink);">
          ${EMOJIS[i % EMOJIS.length]}
        </div>
        <div class="member-info">
          <div class="member-name">${esc(m.nickname)} · ${esc(String(m.age))}세</div>
          <div class="member-meta">${esc(m.department)}</div>
          <div class="member-chips">
            ${m.mbti ? `<span class="chip chip-purple">${esc(m.mbti)}</span>` : ''}
            ${m.custom_badge ? `<span class="chip" style="background:#FFF0F5;color:var(--pink);border:1px solid var(--pink-light);">${esc(m.custom_badge)}</span>` : ''}
            <span class="chip" style="background:${m.smoking?'#FFF3E0':'#E8F5E9'};color:${m.smoking?'#E65100':'#388E3C'};">
              ${m.smoking?'🚬 흡연':'🚭 비흡연'}
            </span>
          </div>
          ${m.intro ? `<p style="font-size:12px;color:var(--gray-600);margin-top:4px;">"${esc(m.intro)}"</p>` : ''}
        </div>
      </div>`).join('');
  }
  showScreen('screen-team-detail');
}
window.openTeamDetail = openTeamDetail;

// ============================================================
// 22. 팀 등록 — 인스타그램ID 필수, 카카오ID 선택, 인증완료 팀 상단 노출
// ============================================================
async function registerTeam() {
  const profile = state.profile;
  if (!profile) { showToast('로그인이 필요합니다'); return; }
  // ★ 인증 필수 → 선택: profile_active 체크 제거
  // 단, 로그인 자체는 필요

  const title = document.getElementById('team-title')?.value.trim();
  if (!title || title.length < 2) { showToast('팀 제목을 2자 이상 입력해주세요'); return; }

  // ── 팀원 수집: 1번 필수, 2·3번 선택
  const members = [];
  for (let i = 1; i <= 3; i++) {
    const nickname = document.getElementById(`m${i}-nickname`)?.value.trim();
    const age      = parseInt(document.getElementById(`m${i}-age`)?.value || '0');
    const dept     = document.getElementById(`m${i}-dept`)?.value.trim();

    if (i > 1 && !nickname) continue; // 2·3번은 비어있으면 건너뜀

    if (!nickname) { showToast(`팀원 ${i}의 닉네임을 입력해주세요`); return; }
    if (!age || age < 19 || age > 60) { showToast(`팀원 ${i}의 나이는 19~60세여야 합니다`); return; }
    if (!dept || dept.length < 2)     { showToast(`팀원 ${i}의 학과를 입력해주세요`); return; }

    if (i > 1) {
      if (!document.getElementById(`verif-confirm-${i}`)?.checked) {
        showToast(`팀원 ${i}의 인증 확인 체크박스를 체크해주세요`); return;
      }
    }

    const smoking = document.querySelector(`input[name="smoke${i}"]:checked`)?.id === `s${i}`;
    const mbtiEl  = document.getElementById(`m${i}-mbti`);
    const introEl = document.getElementById(`m${i}-intro`);
    const badgeEl = document.getElementById(`m${i}-badge`);
    members.push({
      nickname, age, department: dept, smoking,
      mbti:         mbtiEl?.value  || null,
      intro:        introEl?.value.trim() || null,
      custom_badge: badgeEl?.value.trim() || null,
      is_leader: i === 1, sort_order: i - 1
    });
  }
  if (members.length === 0) { showToast('최소 1명의 팀원 정보를 입력해주세요'); return; }

  // ── 연락처 수집 (인스타그램 ID 필수, 카카오 ID 선택)
  const phoneNum  = document.getElementById('contact-phone')?.value.trim() || null;
  const kakaoId   = document.getElementById('contact-kakao')?.value.trim() || null;
  if (!phoneNum) { showToast('인스타그램 ID를 입력해주세요'); return; }

  // ── 인증 여부
  const isVerified = !!profile.profile_active;

  setBtnLoading('btn-team-register', true, '팀 등록하기 🎉');
  try {
    const isMissingCol = (err) =>
      err?.message?.includes('schema cache') ||
      err?.message?.includes('Could not find') ||
      err?.code === 'PGRST204';

    // 시도 1: 전체 컬럼
    let team, teamErr;
    ({ data: team, error: teamErr } = await _sb.from('teams').insert({
      leader_id:     profile.id,
      gender:        profile.gender,
      title,
      university:    profile.university,
      status:        'recruiting',
      contact_phone: phoneNum  || null,
      contact_kakao: kakaoId   || null,
      is_verified:   isVerified
    }).select().single());

    // 시도 2: is_verified 제외
    if (teamErr && isMissingCol(teamErr)) {
      ({ data: team, error: teamErr } = await _sb.from('teams').insert({
        leader_id:     profile.id,
        gender:        profile.gender,
        title,
        university:    profile.university,
        status:        'recruiting',
        contact_phone: phoneNum || null,
        contact_kakao: kakaoId  || null
      }).select().single());
    }

    // 시도 3: contact_kakao 제외
    if (teamErr && isMissingCol(teamErr)) {
      ({ data: team, error: teamErr } = await _sb.from('teams').insert({
        leader_id:     profile.id,
        gender:        profile.gender,
        title,
        university:    profile.university,
        status:        'recruiting',
        contact_phone: phoneNum || null
      }).select().single());
    }

    // 시도 4: contact_phone도 제외
    if (teamErr && isMissingCol(teamErr)) {
      ({ data: team, error: teamErr } = await _sb.from('teams').insert({
        leader_id:  profile.id,
        gender:     profile.gender,
        title,
        university: profile.university,
        status:     'recruiting'
      }).select().single());
    }

    // 시도 5: contact_phone도 제외
    if (teamErr && isMissingCol(teamErr)) {
      ({ data: team, error: teamErr } = await _sb.from('teams').insert({
        leader_id:  profile.id,
        gender:     profile.gender,
        title,
        university: profile.university,
        status:     'recruiting'
      }).select().single());
    }

    if (teamErr) throw new Error('팀 등록 실패: ' + teamErr.message);

    const memberRows = members.map(m => ({ ...m, team_id: team.id }));
    const { error: memberErr } = await _sb.from('team_members').insert(memberRows);
    if (memberErr) throw new Error('팀원 등록 실패: ' + memberErr.message);

    showToast(`🎉 팀이 등록되었습니다! (팀원 ${members.length}명)`);
    await loadTeams();
    showScreen('screen-home');
  } catch(err) {
    showToast('❌ ' + err.message);
  } finally {
    setBtnLoading('btn-team-register', false, '팀 등록하기 🎉');
  }
}
window.registerTeam = registerTeam;

// ============================================================
// 4️⃣ 과팅 후기 시스템
// ============================================================
async function loadReviews() {
  const container = document.getElementById('reviews-list');
  if (!container) return;
  container.innerHTML = '<div style="text-align:center;padding:24px;"><div class="spinner"></div></div>';

  try {
    // 승인된 후기만 표시
    const { data: reviews, error } = await _sb
      .from('reviews')
      .select('*')
      .eq('status', 'approved')
      .order('created_at', { ascending: false });

    if (error) {
      // reviews 테이블 없는 경우
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">💬</div>
          <div class="empty-title">후기를 불러올 수 없습니다</div>
          <div class="empty-desc">SQL Editor에서 reviews 테이블을 생성해주세요</div>
        </div>`;
      return;
    }

    if (!reviews || reviews.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🌸</div>
          <div class="empty-title">아직 후기가 없어요</div>
          <div class="empty-desc">매칭 성사 후 첫 후기를 남겨보세요!</div>
        </div>`;
      return;
    }

    container.innerHTML = reviews.map(r => `
      <div class="card card-p" style="margin-bottom:12px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
          <div style="font-size:24px;">${r.emoji || '🌸'}</div>
          <div>
            <div style="font-size:13px;font-weight:700;">${esc(r.team_name || '익명팀')}</div>
            <div style="font-size:11px;color:var(--gray-400);">
              ${new Date(r.created_at).toLocaleDateString('ko-KR')}
            </div>
          </div>
          <div style="margin-left:auto;">
            ${'⭐'.repeat(Math.min(r.rating || 5, 5))}
          </div>
        </div>
        <p style="font-size:14px;color:var(--gray-700);line-height:1.6;">"${esc(r.comment)}"</p>
      </div>`).join('');
  } catch(e) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div>
      <div class="empty-title">오류: ${esc(e.message)}</div></div>`;
  }
}
window.loadReviews = loadReviews;

async function submitReview() {
  const profile = state.profile;
  if (!profile) { showToast('로그인이 필요합니다'); return; }

  const emoji   = document.getElementById('review-emoji')?.value || '🌸';
  const rating  = parseInt(document.getElementById('review-rating')?.value || '5');
  const comment = document.getElementById('review-comment')?.value.trim();

  if (!comment || comment.length < 5) { showToast('후기를 5자 이상 입력해주세요'); return; }

  setBtnLoading('btn-submit-review', true, '후기 제출');
  try {
    const { error } = await _sb.from('reviews').insert({
      user_id:   profile.id,
      team_name: profile.nickname + '팀',
      emoji, rating, comment,
      status: 'pending' // 관리자 승인 후 게시
    });
    if (error) throw error;
    closeModal('modal-review-write');
    showToast('✅ 후기가 제출되었습니다! 관리자 승인 후 게시됩니다');
    document.getElementById('review-comment').value = '';
  } catch(err) {
    showToast('❌ 후기 제출 실패: ' + err.message);
  } finally {
    setBtnLoading('btn-submit-review', false, '후기 제출');
  }
}
window.submitReview = submitReview;

// ============================================================
// 23. 과팅 신청
// ============================================================
// 23. 과팅 신청 — 등록된 팀 정보 그대로 사용
// ============================================================

// 신청 화면 열기: 내 팀 정보를 DB에서 조회해 미리보기로 표시
async function openApplyScreen(teamId) {
  if (!state.profile) { showAuthGateModal('apply'); return; }

  window._applyTargetTeamId = teamId;

  // 대상팀 이름 표시
  const targetTeam = _cachedTeams.find(t => t.id === teamId);
  const nameEl = document.getElementById('apply-target-team-name');
  if (nameEl) nameEl.textContent = targetTeam?.title || '—';

  // 신청 완료 버튼 일단 숨김
  const submitBtn = document.getElementById('btn-submit-apply');
  const noBanner  = document.getElementById('apply-no-team-banner');
  const preview   = document.getElementById('apply-my-team-preview');
  if (submitBtn) submitBtn.style.display = 'none';
  if (noBanner)  noBanner.style.display  = 'none';
  if (preview)   preview.innerHTML = '<div style="text-align:center;padding:24px;"><div class="spinner"></div></div>';

  showScreen('screen-apply');

  try {
    // 내 팀 + 팀원 조회
    const { data: myTeam, error } = await _sb.from('teams')
      .select('*, team_members(*)')
      .eq('leader_id', state.profile.id)
      .single();

    if (error || !myTeam) {
      if (preview)  preview.innerHTML = '';
      if (noBanner) noBanner.style.display = 'block';
      // 신청 버튼 숨김 확실히
      if (submitBtn) submitBtn.style.display = 'none';
      return;
    }

    // 내 팀 미리보기 렌더
    const members = myTeam.team_members || [];
    const EMOJIS_APPLY = ['🙋','🙋‍♀️','👤'];
    if (preview) {
      preview.innerHTML = `
        <div class="card" style="overflow:hidden;margin-bottom:4px;">
          <div style="background:linear-gradient(135deg,var(--pink),var(--purple));
            padding:12px 16px;color:white;">
            <div style="font-size:15px;font-weight:700;">${esc(myTeam.title)}</div>
            <div style="font-size:12px;opacity:0.85;margin-top:2px;">
              ${esc(myTeam.university)} · 팀원 ${members.length}명
            </div>
          </div>
          <div style="padding:12px 16px;display:flex;flex-direction:column;gap:8px;">
            ${members.length === 0
              ? `<p style="font-size:13px;color:var(--gray-400);text-align:center;padding:8px 0;">
                  팀원 정보가 없습니다. 팀등록에서 팀원을 추가해주세요.</p>`
              : members.map((m, i) => `
                <div style="display:flex;align-items:center;gap:10px;
                  background:var(--gray-50);border-radius:var(--radius-sm);padding:10px 12px;">
                  <div style="font-size:22px;">${EMOJIS_APPLY[i] || '👤'}</div>
                  <div style="flex:1;">
                    <div style="font-size:13px;font-weight:700;">
                      ${esc(m.nickname)} · ${esc(String(m.age))}세
                      ${m.is_leader ? '<span class="chip chip-pink" style="font-size:10px;padding:2px 6px;margin-left:4px;">팀장</span>' : ''}
                    </div>
                    <div style="display:flex;gap:4px;margin-top:4px;flex-wrap:wrap;">
                      <span style="font-size:11px;color:var(--gray-500);">${esc(m.department || '')}</span>
                      ${m.mbti ? `<span class="chip chip-purple" style="font-size:10px;padding:2px 6px;">${esc(m.mbti)}</span>` : ''}
                      <span style="font-size:10px;" class="chip ${m.smoking ? '' : 'chip-green'}"
                        style="background:${m.smoking?'#FFF3E0':'#E8F5E9'};color:${m.smoking?'#E65100':'#388E3C'};">
                        ${m.smoking ? '🚬' : '🚭'}
                      </span>
                    </div>
                    ${m.intro ? `<div style="font-size:11px;color:var(--gray-500);margin-top:3px;">"${esc(m.intro)}"</div>` : ''}
                  </div>
                </div>`).join('')
            }
          </div>
        </div>
        <p style="font-size:11px;color:var(--gray-400);text-align:center;margin-bottom:4px;">
          ✏️ 정보 수정은 <span style="color:var(--pink);cursor:pointer;"
            onclick="showScreen('screen-team-register')">팀등록 탭</span>에서 할 수 있어요
        </p>`;
    }

    // 팀원이 있으면 신청 버튼 표시
    if (submitBtn) submitBtn.style.display = members.length > 0 ? 'block' : 'none';

  } catch(err) {
    if (preview) preview.innerHTML = `<div style="color:var(--error);font-size:13px;text-align:center;padding:12px;">
      팀 정보를 불러오지 못했습니다: ${esc(err.message)}</div>`;
  }
}
window.openApplyScreen = openApplyScreen;

async function submitApply() {
  const profile = state.profile;
  if (!profile) { showToast('로그인이 필요합니다'); return; }

  const targetTeamId = window._applyTargetTeamId;
  if (!targetTeamId) { showToast('신청 대상팀 정보가 없습니다. 팀 카드에서 다시 신청해주세요.'); return; }

  // _cachedTeams에서 먼저 찾고, 없으면 DB에서 직접 조회
  let targetTeam = _cachedTeams.find(t => t.id === targetTeamId);
  if (!targetTeam) {
    const { data: fetched } = await _sb
      .from('teams').select('id, gender, title, status')
      .eq('id', targetTeamId).single();
    targetTeam = fetched;
  }
  if (!targetTeam) { showToast('❌ 대상팀 정보를 찾을 수 없습니다.'); return; }

  // 매칭완료 팀에는 신청 불가
  if (targetTeam.status === 'matched') {
    showToast('❌ 이미 매칭이 완료된 팀입니다.'); return;
  }

  // 성별 교차 검증 (남→여성팀 / 여→남성팀)
  if (profile.gender === 'male' && targetTeam.gender !== 'female') {
    showToast('❌ 남성 회원은 여성팀에만 신청할 수 있습니다.'); return;
  }
  if (profile.gender === 'female' && targetTeam.gender !== 'male') {
    showToast('❌ 여성 회원은 남성팀에만 신청할 수 있습니다.'); return;
  }

  setBtnLoading('btn-submit-apply', true, '💌 신청 완료');
  try {
    // 내 팀 조회
    const { data: myTeam, error: teamErr } = await _sb.from('teams')
      .select('id')
      .eq('leader_id', profile.id)
      .single();

    if (teamErr || !myTeam) {
      showToast('❌ 등록된 팀이 없습니다. 팀 등록 탭에서 팀을 먼저 등록해주세요.'); return;
    }

    // 자기 팀에는 신청 불가
    if (myTeam.id === targetTeamId) {
      showToast('❌ 자신의 팀에는 신청할 수 없습니다.'); return;
    }

    const message = document.getElementById('apply-message')?.value.trim() || '';

    const insertData = { status: 'pending', created_at: new Date().toISOString() };
    if (message) insertData.message = message;

    // ★ 규칙: female_team_id=신청자, male_team_id=피신청자 (성별 무관)
    // 보낸신청: female_team_id=내팀 / 받은신청: male_team_id=내팀
    insertData.female_team_id = myTeam.id;
    insertData.male_team_id   = targetTeamId;

    const { error } = await _sb.from('match_requests').insert(insertData);

    if (error) {
      if (error.code === '23505') {
        showToast('이미 이 팀에 신청했습니다.'); return;
      }
      if (error.code === '42501' || error.message?.includes('row-level security')) {
        throw new Error(
          'RLS 정책 오류 — Supabase SQL Editor에서 실행:\n' +
          'DROP POLICY IF EXISTS "match_requests_insert" ON match_requests;\n' +
          'CREATE POLICY "match_requests_insert" ON match_requests FOR INSERT WITH CHECK (\n' +
          '  male_team_id IN (SELECT id FROM teams WHERE leader_id IN (SELECT id FROM users WHERE auth_id = auth.uid()))\n' +
          '  OR female_team_id IN (SELECT id FROM teams WHERE leader_id IN (SELECT id FROM users WHERE auth_id = auth.uid()))\n' +
          ');'
        );
      }
      throw error;
    }

    const msgEl = document.getElementById('apply-message');
    if (msgEl) msgEl.value = '';

    showToast('💌 과팅 신청이 완료되었습니다!');
    showScreen('screen-requests');
    loadAndRenderRequests('sent');

  } catch(err) {
    showToast('❌ 신청 오류: ' + err.message, 6000);
  } finally {
    setBtnLoading('btn-submit-apply', false, '💌 신청 완료');
  }
}
window.submitApply = submitApply;

// ============================================================
// 24. 신청 내역
// ============================================================
async function loadAndRenderRequests(tab) {
  const container = document.getElementById('requests-content');
  if (!container) return;

  container.innerHTML = '<div style="text-align:center;padding:24px;"><div class="spinner"></div></div>';

  try {
    // 내 팀 조회
    const { data: myTeam } = await _sb.from('teams')
      .select('id').eq('leader_id', state.profile?.id).single();

    if (!myTeam) {
      container.innerHTML = `<div class="empty-state">
        <div class="empty-icon">${tab==='sent'?'💌':'📬'}</div>
        <div class="empty-title">팀이 없습니다</div>
        <div class="empty-desc">팀을 등록하면 신청 내역이 표시됩니다</div>
      </div>`;
      return;
    }

    const STATUS_LABEL = {
      pending:'⏳ 검토 대기', reviewing:'🔍 검토중', accepted:'✅ 수락',
      rejected:'❌ 거절', matched:'🎉 매칭완료', expired:'만료'
    };
    const STATUS_CLS = {
      pending:'chip-orange', reviewing:'chip-purple', accepted:'chip-green',
      rejected:'chip-red', matched:'chip-green', expired:'chip-gray'
    };

    let data, error;
    const profile = state.profile;
    const gender  = profile?.gender;

    // ★ 규칙: female_team_id=신청자, male_team_id=피신청자 (성별 무관)
    if (tab === 'sent') {
      // 보낸신청 = 내가 신청자 = female_team_id가 내 팀
      ({ data, error } = await _sb.from('match_requests')
        .select('*, teams!match_requests_male_team_id_fkey(title,university)')
        .eq('female_team_id', myTeam.id)
        .order('created_at', { ascending: false }));
    } else {
      // 받은신청 = 상대가 신청자 = male_team_id가 내 팀
      ({ data, error } = await _sb.from('match_requests')
        .select('*, teams!match_requests_female_team_id_fkey(title,university)')
        .eq('male_team_id', myTeam.id)
        .order('created_at', { ascending: false }));
    }

    if (error) throw error;

    if (!data || data.length === 0) {
      container.innerHTML = `<div class="empty-state">
        <div class="empty-icon">${tab==='sent'?'💌':'📬'}</div>
        <div class="empty-title">${tab==='sent'?'보낸 신청이 없어요':'받은 신청이 없어요'}</div>
      </div>`;
      return;
    }

    container.innerHTML = data.map(r => {
      const teamData = tab === 'sent' ? r.teams : r['teams'];
      const teamName = teamData?.title || '-';
      const teamUniv = teamData?.university || '-';
      const label    = STATUS_LABEL[r.status] || r.status;
      const cls      = STATUS_CLS[r.status]   || 'chip-gray';
      const date     = new Date(r.created_at).toLocaleDateString('ko-KR');
      const isMatched   = r.status === 'matched';
      const isPendingRecv = r.status === 'pending' && tab === 'received';
      return `
      <div class="card card-p">
        <div style="display:flex;justify-content:space-between;margin-bottom:10px;">
          <div>
            <p style="font-size:16px;font-weight:700;">${esc(teamName)}</p>
            <p style="font-size:12px;color:var(--gray-500);">${esc(teamUniv)} · ${esc(date)}</p>
          </div>
          <span class="chip ${cls}">${esc(label)}</span>
        </div>
        <div style="display:flex;gap:8px;">
          ${isMatched
            ? `<button class="btn btn-primary btn-sm" style="flex:1;"
                onclick="showMatchSuccess('${esc(r.id)}')">🎉 연결 정보 보기</button>`
            : ''}
          ${isPendingRecv
            ? `<button class="btn btn-primary btn-sm" style="flex:1;"
                onclick="acceptMatchRequest('${esc(r.id)}')">✅ 수락</button>
               <button class="btn btn-outline btn-sm" style="flex:1;"
                onclick="rejectMatchRequest('${esc(r.id)}')">❌ 거절</button>`
            : ''}
          ${!isMatched && !isPendingRecv
            ? `<button class="btn btn-outline btn-sm"
                onclick="switchTab('messages')">💬 후기</button>`
            : ''}
        </div>
      </div>`;
    }).join('');
  } catch(err) {
    container.innerHTML = `<div class="empty-state">
      <div class="empty-icon">⚠️</div>
      <div class="empty-title">오류가 발생했습니다</div>
      <div class="empty-desc">${esc(err.message)}</div>
    </div>`;
  }
}
window.loadAndRenderRequests = loadAndRenderRequests;

// 탭 전환 버튼
function switchRequestTab(tab) {
  const sent = document.getElementById('tab-sent');
  const recv = document.getElementById('tab-received');
  if (tab === 'sent') {
    sent.style.cssText += 'color:var(--pink);border-bottom:2px solid var(--pink);font-weight:700;';
    recv.style.cssText += 'color:var(--gray-500);border-bottom:2px solid transparent;font-weight:500;';
  } else {
    recv.style.cssText += 'color:var(--pink);border-bottom:2px solid var(--pink);font-weight:700;';
    sent.style.cssText += 'color:var(--gray-500);border-bottom:2px solid transparent;font-weight:500;';
  }
  loadAndRenderRequests(tab);
}
window.switchRequestTab = switchRequestTab;

// 매칭 성사 화면 표시 — 상대팀 정보를 직접 받아 표시
async function showMatchSuccess(requestId, preloadedData) {
  showScreen('screen-match-success');

  // preloadedData가 있으면 DB 조회 없이 바로 표시
  if (preloadedData) {
    setText('match-success-team-name', preloadedData.teamName || '상대팀');
    const phoneEl = document.getElementById('match-contact-phone');
    if (phoneEl) phoneEl.textContent = preloadedData.phone || '미등록';
    const kakaoEl = document.getElementById('match-contact-kakao');
    if (kakaoEl) kakaoEl.textContent = preloadedData.kakao || '미등록';
    window._matchContactPhone = preloadedData.phone || '';
    window._matchContactKakao = preloadedData.kakao || '';
    window._matchContactName  = preloadedData.teamName || '상대팀';
    return;
  }

  // requestId로 조회 (기존 방식 — fallback)
  if (!requestId || !/^[0-9a-f-]{36}$/i.test(requestId)) return;

  try {
    const profile = state.profile;
    if (!profile) return;

    // 내 팀 조회
    const { data: myTeam } = await _sb
      .from('teams').select('id').eq('leader_id', profile.id).single();
    if (!myTeam) return;

    // match_requests 조회 — RLS SELECT 정책이 있어야 동작
    const { data: req, error: reqErr } = await _sb
      .from('match_requests')
      .select('male_team_id, female_team_id')
      .eq('id', requestId)
      .single();

    if (reqErr || !req) {
      // RLS로 조회 안 되는 경우 — matched 상태인 내 팀의 상대팀을 다른 방법으로 찾기
      // male/female 둘 다 시도
      const { data: altReq } = await _sb
        .from('match_requests')
        .select('male_team_id, female_team_id')
        .or(`male_team_id.eq.${myTeam.id},female_team_id.eq.${myTeam.id}`)
        .eq('status', 'matched')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (!altReq) { console.warn('[showMatchSuccess] 매칭 정보 조회 실패'); return; }

      const oppId = altReq.male_team_id === myTeam.id
        ? altReq.female_team_id : altReq.male_team_id;
      await _fetchAndShowOpponentTeam(oppId);
      return;
    }

    const opponentTeamId = myTeam.id === req.male_team_id
      ? req.female_team_id : req.male_team_id;

    if (!opponentTeamId) return;
    await _fetchAndShowOpponentTeam(opponentTeamId);

  } catch(e) {
    console.warn('[showMatchSuccess]', e.message);
  }
}
window.showMatchSuccess = showMatchSuccess;

async function _fetchAndShowOpponentTeam(opponentTeamId) {
  const { data: oppTeam } = await _sb
    .from('teams')
    .select('title, contact_phone, contact_kakao')
    .eq('id', opponentTeamId)
    .single();

  if (oppTeam) {
    setText('match-success-team-name', oppTeam.title || '상대팀');
    const phoneEl = document.getElementById('match-contact-phone');
    if (phoneEl) phoneEl.textContent = oppTeam.contact_phone || '미등록';
    const kakaoEl = document.getElementById('match-contact-kakao');
    if (kakaoEl) kakaoEl.textContent = oppTeam.contact_kakao || '미등록';
    window._matchContactPhone = oppTeam.contact_phone || '';
    window._matchContactKakao = oppTeam.contact_kakao || '';
    window._matchContactName  = oppTeam.title || '상대팀';
  }
}

// 연락처 저장 (vCard 다운로드)
function saveMatchContact() {
  const phone = (window._matchContactPhone || '').trim();
  const kakao = (window._matchContactKakao || '').trim();
  const name  = (window._matchContactName  || '상대팀').trim();
  if (!phone && !kakao) { showToast('저장할 연락처가 없습니다.'); return; }

  if (phone) {
    // vCard 형식으로 생성
    const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${name} (춘천과팅)\nTEL;TYPE=CELL:${phone}${kakao ? `\nNOTE:카카오ID: ${kakao}` : ''}\nEND:VCARD`;
    const blob = new Blob([vcard], { type: 'text/vcard' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `${name}_춘천과팅.vcf`;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
    showToast('✅ 연락처가 저장되었습니다!');
  }
  if (kakao) {
    // 카카오 ID 클립보드 복사
    navigator.clipboard?.writeText(kakao).then(() => {
      if (!phone) showToast(`✅ 카카오 ID "${kakao}" 복사됨!`);
    }).catch(() => {});
  }
}
window.saveMatchContact = saveMatchContact;

// 수락
async function acceptMatchRequest(requestId) {
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) return;
  try {
    // STEP1: 양쪽 팀 ID 파악 (maybeSingle — single은 실패 시 throw)
    const { data: reqBefore } = await _sb
      .from('match_requests')
      .select('male_team_id, female_team_id')
      .eq('id', requestId)
      .maybeSingle();

    if (!reqBefore?.male_team_id || !reqBefore?.female_team_id) {
      showToast('❌ 신청 정보를 찾을 수 없습니다.'); return;
    }

    const maleTeamId   = reqBefore.male_team_id;
    const femaleTeamId = reqBefore.female_team_id;

    // STEP2: 연락처 먼저 조회 (status 변경 전 — 변경 후엔 RLS에 막힘)
    const { data: myTeam } = await _sb.from('teams').select('id')
      .eq('leader_id', state.profile?.id)
      .order('created_at', { ascending: false }).limit(1).maybeSingle();

    const opponentTeamId = myTeam?.id === maleTeamId ? femaleTeamId : maleTeamId;

    let preloaded = null;
    if (opponentTeamId) {
      const { data: oppTeam } = await _sb.from('teams')
        .select('title, contact_phone, contact_kakao, leader_id')
        .eq('id', opponentTeamId).maybeSingle();
      if (oppTeam) {
        let phone = oppTeam.contact_phone || '';
        if (!phone && oppTeam.leader_id) {
          const { data: leader } = await _sb.from('users')
            .select('phone_number').eq('id', oppTeam.leader_id).maybeSingle();
          if (leader?.phone_number) phone = leader.phone_number;
        }
        preloaded = { teamName: oppTeam.title, phone, kakao: oppTeam.contact_kakao };
      }
    }

    // STEP3: match_request → matched
    const { error: reqErr } = await _sb.from('match_requests').update({
      status: 'matched', responded_at: new Date().toISOString()
    }).eq('id', requestId);
    if (reqErr) throw reqErr;

    // STEP4: ★ 양쪽 팀 각각 개별 UPDATE (in()은 RLS에서 일부만 적용될 수 있음)
    await _sb.from('teams').update({ status: 'matched', is_visible: false }).eq('id', maleTeamId);
    await _sb.from('teams').update({ status: 'matched', is_visible: false }).eq('id', femaleTeamId);

    showToast('🎉 수락했습니다! 매칭이 성사되었어요');
    await showMatchSuccess(requestId, preloaded);
    updateHomeStats();
  } catch(err) {
    showToast('❌ 수락 처리 오류: ' + err.message);
  }
}
window.acceptMatchRequest = acceptMatchRequest;

// 거절
async function rejectMatchRequest(requestId) {
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) return;
  try {
    await _sb.from('match_requests').update({
      status: 'rejected', responded_at: new Date().toISOString()
    }).eq('id', requestId);
    showToast('신청을 거절했습니다');
    loadAndRenderRequests('received');
  } catch(err) {
    showToast('❌ ' + err.message);
  }
}
window.rejectMatchRequest = rejectMatchRequest;

// ============================================================
// 25. 메시지 — 상대팀 선택 + 고정 메시지
// ============================================================
// 팀별 메시지 저장소 { [teamId]: [{mine, text, time}] }
const _teamMessages = {};
let _currentChatTeamId = null;

// 메시지 탭 진입 시 신청한 팀 목록 로드
async function loadChatTeams() {
  const sel = document.getElementById('chat-team-select');
  if (!sel) return;

  const profile = state.profile;
  if (!profile) {
    sel.innerHTML = '<option value="">로그인이 필요합니다</option>';
    return;
  }

  try {
    // 내 팀 조회
    const { data: myTeam } = await _sb
      .from('teams').select('id').eq('leader_id', profile.id).single();

    if (!myTeam) {
      sel.innerHTML = '<option value="">등록된 팀이 없습니다</option>';
      renderMessages();
      return;
    }

    // 내 팀이 신청한 / 신청받은 match_requests 조회 (sent + received)
    const col = profile.gender === 'male' ? 'male_team_id' : 'female_team_id';
    const oppCol = profile.gender === 'male' ? 'female_team_id' : 'male_team_id';

    const { data: reqs } = await _sb
      .from('match_requests')
      .select(`id, status, ${oppCol}`)
      .eq(col, myTeam.id)
      .in('status', ['pending', 'matched'])
      .order('created_at', { ascending: false });

    if (!reqs || reqs.length === 0) {
      sel.innerHTML = '<option value="">신청/수신한 팀이 없습니다</option>';
      renderMessages();
      return;
    }

    // 상대팀 ID 목록
    const oppTeamIds = [...new Set(reqs.map(r => r[oppCol]).filter(Boolean))];

    // 상대팀 이름 조회
    const { data: oppTeams } = await _sb
      .from('teams').select('id, title, status').in('id', oppTeamIds);

    const teamMap = {};
    (oppTeams || []).forEach(t => { teamMap[t.id] = t; });

    // 셀렉트 옵션 구성
    sel.innerHTML = '<option value="">💌 대화할 팀을 선택하세요</option>';
    reqs.forEach(r => {
      const oppId = r[oppCol];
      const t = teamMap[oppId];
      if (!t) return;
      const statusLabel = r.status === 'matched' ? '🎉 매칭완료' : '⏳ 검토중';
      const opt = document.createElement('option');
      opt.value = oppId;
      opt.textContent = `${t.title} [${statusLabel}]`;
      sel.appendChild(opt);
    });

    // 첫 번째 팀 자동 선택
    if (oppTeamIds.length > 0) {
      sel.value = oppTeamIds[0];
      switchChatTeam(oppTeamIds[0]);
    } else {
      renderMessages();
    }

  } catch(e) {
    console.warn('[loadChatTeams]', e.message);
    sel.innerHTML = '<option value="">팀 목록 로드 실패</option>';
  }
}
window.loadChatTeams = loadChatTeams;

// 대화 상대팀 전환
function switchChatTeam(teamId) {
  _currentChatTeamId = teamId || null;

  // 헤더 타이틀 업데이트
  const sel = document.getElementById('chat-team-select');
  const selected = sel?.options[sel.selectedIndex];
  const header = document.querySelector('#screen-messages .header-title');
  if (header) {
    header.textContent = teamId && selected?.textContent
      ? `💬 ${selected.textContent.split(' [')[0]}`
      : '💬 매칭 채팅';
  }

  renderMessages();
}
window.switchChatTeam = switchChatTeam;

function renderMessages() {
  const container = document.getElementById('chat-messages');
  if (!container) return;

  const messages = _currentChatTeamId
    ? (_teamMessages[_currentChatTeamId] || [])
    : [];

  if (!_currentChatTeamId) {
    container.innerHTML = `
      <div class="empty-state" style="padding:40px 20px;">
        <div class="empty-icon">💬</div>
        <div class="empty-title">대화할 팀을 선택해주세요</div>
        <div class="empty-desc">위 드롭다운에서 신청한 팀을 선택하면 채팅이 시작됩니다</div>
      </div>`;
    return;
  }

  if (messages.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="padding:40px 20px;">
        <div class="empty-icon">💬</div>
        <div class="empty-title">아직 메시지가 없어요</div>
        <div class="empty-desc">아래 버튼으로 첫 메시지를 보내보세요!</div>
      </div>`;
    return;
  }

  container.innerHTML = '';
  for (const m of messages) {
    const group = document.createElement('div');
    group.className = 'chat-group';
    group.style.alignItems = m.mine ? 'flex-end' : 'flex-start';

    const bubble = document.createElement('div');
    bubble.className = `chat-bubble ${m.mine ? 'mine' : 'theirs'}`;
    bubble.textContent = m.text;

    const time = document.createElement('div');
    time.className = 'chat-time';
    time.style.textAlign = m.mine ? 'right' : 'left';
    time.style.padding = '0 4px';
    time.textContent = m.time;

    group.appendChild(bubble);
    group.appendChild(time);
    container.appendChild(group);
  }
  container.scrollTop = container.scrollHeight;
}
window.renderMessages = renderMessages;

function _buildTimeStr() {
  const now = new Date();
  const h  = now.getHours();
  const mi = String(now.getMinutes()).padStart(2, '0');
  return h >= 12 ? `오후 ${h - 12 || 12}:${mi}` : `오전 ${h}:${mi}`;
}

function sendFixedMessage(text) {
  if (!state.profile) { showToast('로그인이 필요합니다'); return; }
  if (!_currentChatTeamId) { showToast('먼저 대화할 팀을 선택해주세요'); return; }
  if (!_teamMessages[_currentChatTeamId]) _teamMessages[_currentChatTeamId] = [];
  _teamMessages[_currentChatTeamId].push({ mine: true, text, time: _buildTimeStr() });
  renderMessages();
}
window.sendFixedMessage = sendFixedMessage;

function sendMessage() {
  if (!state.profile) { showToast('로그인이 필요합니다'); return; }
  if (!_currentChatTeamId) { showToast('먼저 대화할 팀을 선택해주세요'); return; }
  const input = document.getElementById('chat-input');
  const text  = input?.value.trim();
  if (!text) return;
  if (text.length > 200) { showToast('메시지는 200자 이하로 입력해주세요'); return; }
  if (!_teamMessages[_currentChatTeamId]) _teamMessages[_currentChatTeamId] = [];
  _teamMessages[_currentChatTeamId].push({ mine: true, text, time: _buildTimeStr() });
  input.value = '';
  renderMessages();
}
window.sendMessage = sendMessage;

// ============================================================
// 26. 마이페이지 상태 업데이트
// ============================================================
async function updateMyPageStatus() {
  const profile = state.profile;
  if (!profile) return;

  try {
    const [{ data: verif }, { data: deposit }] = await Promise.all([
      _sb.from('student_verifications').select('status').eq('user_id', profile.id).single(),
      _sb.from('deposits').select('status').eq('user_id', profile.id).single()
    ]);

    const V_LABEL = { pending:'⏳ 검토중', approved:'✅ 승인', rejected:'❌ 반려' };
    const D_LABEL = { pending_confirm:'⏳ 확인대기', confirmed:'✅ 완료', rejected:'❌ 반려' };

    const verifEl   = document.querySelector('[data-status="verif"]');
    const depositEl = document.querySelector('[data-status="deposit"]');
    const teamEl    = document.querySelector('[data-status="team"]');

    if (verifEl)   verifEl.textContent   = V_LABEL[verif?.status]   || '미제출';
    if (depositEl) depositEl.textContent = D_LABEL[deposit?.status] || '미입금';
    if (teamEl)    teamEl.textContent    = profile.profile_active ? '활성' : '대기';
  } catch(e) { /* 무시 */ }
}
window.updateMyPageStatus = updateMyPageStatus;

// ============================================================
// 5️⃣ 역할 뱃지 저장
// ============================================================
async function saveCustomBadge() {
  const profile = state.profile;
  if (!profile) { showToast('로그인이 필요합니다'); return; }
  const badge = document.getElementById('my-custom-badge')?.value.trim() || null;

  try {
    const { error } = await _sb
      .from('users')
      .update({ custom_badge: badge })
      .eq('id', profile.id);

    if (error) {
      // custom_badge 컬럼이 DB에 없는 경우 안내
      if (error.code === 'PGRST204' || error.message?.includes('custom_badge') || error.message?.includes('schema cache')) {
        showToast('⚠️ DB에 custom_badge 컬럼이 없습니다. SQL Editor에서: ALTER TABLE users ADD COLUMN custom_badge TEXT;');
        return;
      }
      throw error;
    }
    state.profile.custom_badge = badge;
    showToast(badge ? `✅ 뱃지 저장: ${badge}` : '뱃지가 삭제되었습니다');
  } catch(err) {
    showToast('❌ 저장 실패: ' + err.message);
  }
}
window.saveCustomBadge = saveCustomBadge;

// ============================================================
// 내 팀 등록 취소 (마이페이지)
// ============================================================
async function confirmDeleteMyTeam() {
  const profile = state.profile;
  if (!profile) { showToast('로그인이 필요합니다'); return; }

  // 내 팀 조회
  const { data: myTeam } = await _sb
    .from('teams')
    .select('id, title, status')
    .eq('leader_id', profile.id)
    .single();

  if (!myTeam) {
    showToast('등록된 팀이 없습니다');
    return;
  }

  if (myTeam.status === 'matched') {
    showToast('❌ 매칭 완료된 팀은 삭제할 수 없습니다. 관리자에게 문의해주세요.');
    return;
  }

  if (!confirm(`"${myTeam.title}" 팀을 삭제하시겠습니까?\n팀원 정보와 신청 내역이 모두 삭제됩니다.`)) return;

  await deleteMyTeam(myTeam.id);
}
window.confirmDeleteMyTeam = confirmDeleteMyTeam;

async function deleteMyTeam(teamId) {
  const ignore = async (p) => { try { await p; } catch(e) { console.warn('[deleteTeam]', e.message); } };

  try {
    // FK 순서대로 삭제
    await ignore(_sb.from('match_requests').delete().eq('male_team_id',   teamId));
    await ignore(_sb.from('match_requests').delete().eq('female_team_id', teamId));
    await ignore(_sb.from('team_members').delete().eq('team_id', teamId));

    const { error } = await _sb.from('teams').delete().eq('id', teamId);
    if (error) throw new Error('팀 삭제 실패 (RLS): ' + error.message);

    showToast('✅ 팀 등록이 취소되었습니다');
    await loadTeams();
    updateHomeStats();
  } catch(err) {
    showToast('❌ ' + err.message);
  }
}
window.deleteMyTeam = deleteMyTeam;

// ============================================================
// 신고 안내 (준비중)
// ============================================================
function showReportNotice() {
  document.getElementById('modal-report')?.classList.add('show');
}
window.showReportNotice = showReportNotice;

function copyReportEmail() {
  const email = 'john_1217@naver.com';
  navigator.clipboard?.writeText(email)
    .then(() => showToast('✅ 이메일 주소가 복사되었습니다!'))
    .catch(() => showToast('이메일: ' + email));
}
window.copyReportEmail = copyReportEmail;
function showReport() { showReportNotice(); }
function showWithdraw()  { document.getElementById('modal-withdraw')?.classList.add('show'); }
window.showReport   = showReport;
window.showWithdraw = showWithdraw;

async function submitReport() {
  const type = document.getElementById('report-type')?.value;
  const desc = document.getElementById('report-desc')?.value.trim();
  if (!type) { showToast('신고 유형을 선택해주세요'); return; }
  if (!desc || desc.length < 5) { showToast('신고 내용을 5자 이상 입력해주세요'); return; }
  const profile = state.profile;
  if (!profile) { showToast('로그인이 필요합니다'); return; }

  setBtnLoading('btn-submit-report', true, '신고 접수');
  try {
    // target_user_id 없이 최소 필드로 INSERT (컬럼 없으면 오류 방지)
    const { error } = await _sb.from('reports').insert({
      reporter_id: profile.id,
      report_type: type,
      description: desc,
      status:      'pending'
    });
    if (error) {
      if (error.code === '42501' || error.message?.includes('row-level security')) {
        throw new Error('신고 권한 없음 (RLS) — Supabase SQL Editor에서:\n' +
          'CREATE POLICY "reports_insert_own" ON reports FOR INSERT WITH CHECK\n' +
          '(reporter_id IN (SELECT id FROM users WHERE auth_id = auth.uid()));');
      }
      // 컬럼 오류면 더 줄여서 재시도
      if (error.code === 'PGRST204' || error.message?.includes('schema cache')) {
        const { error: e2 } = await _sb.from('reports').insert({
          reporter_id: profile.id, description: desc, status: 'pending'
        });
        if (e2) throw e2;
      } else { throw error; }
    }
    closeModal('modal-report');
    showToast('🚨 신고가 접수되었습니다. 검토 후 처리해드릴게요');
    const typeEl = document.getElementById('report-type');
    const descEl = document.getElementById('report-desc');
    if (typeEl) typeEl.value = '';
    if (descEl) descEl.value = '';
  } catch(err) {
    showToast('❌ 신고 접수 실패: ' + err.message, 5000);
  } finally {
    setBtnLoading('btn-submit-report', false, '신고 접수');
  }
}
window.submitReport = submitReport;

// ============================================================
// 28. 관리자 기능 (role=admin 확인 후 실행)
// ============================================================

// 관리자 권한 체크 래퍼
function assertAdmin() {
  if (state.profile?.role !== 'admin') {
    showToast('❌ 관리자 권한이 필요합니다');
    throw new Error('UNAUTHORIZED');
  }
}

// 관리자 액션 로그 (DB 함수 호출)
async function writeAdminLog(action, targetType, targetId, detail) {
  try {
    await _sb.rpc('log_admin_action', {
      p_action:      action,
      p_target_type: targetType,
      p_target_id:   targetId,
      p_detail:      detail || null
    });
  } catch(e) {
    console.error('[adminLog]', e);
  }
}

// 대시보드 통계
async function renderAdminDashboard() {
  try { assertAdmin(); } catch { return; }

  const container = document.getElementById('admin-content');
  if (!container) return;
  container.innerHTML = '<div style="padding:24px;text-align:center;"><div class="spinner"></div></div>';

  try {
    const results = await Promise.allSettled([
      _sb.from('users').select('*', { count:'exact', head:true }).is('deleted_at', null),
      _sb.from('users').select('*', { count:'exact', head:true }).eq('gender','male').is('deleted_at', null),
      _sb.from('users').select('*', { count:'exact', head:true }).eq('gender','female').is('deleted_at', null),
      _sb.from('student_verifications').select('*', { count:'exact', head:true }).eq('status', 'pending'),
      _sb.from('deposits').select('*', { count:'exact', head:true }).eq('status', 'pending_confirm'),
      _sb.from('teams').select('*', { count:'exact', head:true }).eq('gender', 'male').eq('status', 'recruiting'),
      _sb.from('teams').select('*', { count:'exact', head:true }).eq('gender', 'female').eq('status', 'recruiting'),
      _sb.from('matches').select('*', { count:'exact', head:true }),
      _sb.from('reports').select('*', { count:'exact', head:true }).eq('status', 'pending'),
      // 확정된 입금 합계
      _sb.from('deposits').select('amount').eq('status', 'confirmed'),
      // 후기 승인 대기
      _sb.from('reviews').select('*', { count:'exact', head:true }).eq('status', 'pending'),
    ]);

    const safeCount = (r, idx) => {
      if (r.status === 'rejected') { console.warn(`[dashboard] 쿼리${idx}:`, r.reason); return 0; }
      if (r.value?.error) { console.warn(`[dashboard] 쿼리${idx}:`, r.value.error.message); return 0; }
      return r.value?.count ?? 0;
    };

    const totalUsers     = safeCount(results[0], 0);
    const maleUsers      = safeCount(results[1], 1);
    const femaleUsers    = safeCount(results[2], 2);
    const pendingVerif   = safeCount(results[3], 3);
    const pendingDeposit = safeCount(results[4], 4);
    const maleTeams      = safeCount(results[5], 5);
    const femaleTeams    = safeCount(results[6], 6);
    const matched        = safeCount(results[7], 7);
    const reports        = safeCount(results[8], 8);
    const pendingReviews = safeCount(results[10], 10);

    // 누적 입금액 계산
    let totalDeposit = 0;
    if (results[9].status === 'fulfilled' && !results[9].value?.error) {
      const rows = results[9].value?.data || [];
      totalDeposit = rows.reduce((s, r) => s + (r.amount || 0), 0);
    }

    container.innerHTML = `
      <!-- 회원 현황 카드 (남녀 분리) -->
      <div style="margin:12px 16px 4px;background:white;border-radius:14px;
        border:1px solid var(--gray-100);overflow:hidden;">
        <div style="padding:10px 14px;background:var(--gray-50);font-size:12px;
          font-weight:700;color:var(--gray-600);">👥 회원 현황</div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;text-align:center;padding:12px 0;">
          <div>
            <div style="font-size:22px;font-weight:800;color:var(--gray-800);">${totalUsers}</div>
            <div style="font-size:11px;color:var(--gray-500);margin-top:2px;">전체</div>
          </div>
          <div style="border-left:1px solid var(--gray-100);border-right:1px solid var(--gray-100);">
            <div style="font-size:22px;font-weight:800;color:#7B2FF7;">👨 ${maleUsers}</div>
            <div style="font-size:11px;color:var(--gray-500);margin-top:2px;">남성</div>
          </div>
          <div>
            <div style="font-size:22px;font-weight:800;color:var(--pink);">👩 ${femaleUsers}</div>
            <div style="font-size:11px;color:var(--gray-500);margin-top:2px;">여성</div>
          </div>
        </div>
      </div>

      <!-- 누적 입금액 카드 -->
      <div style="margin:4px 16px 4px;background:linear-gradient(135deg,#E8F5E9,#F1F8E9);
        border:1px solid #A5D6A7;border-radius:14px;padding:14px 16px;
        display:flex;align-items:center;justify-content:space-between;">
        <div>
          <div style="font-size:12px;color:#388E3C;font-weight:600;margin-bottom:4px;">💰 누적 확정 입금액</div>
          <div style="font-size:24px;font-weight:800;color:#2E7D32;">
            ${totalDeposit.toLocaleString()}원
          </div>
          <div style="font-size:11px;color:#66BB6A;margin-top:2px;">
            남성 ${cfg.FEE_MALE?.toLocaleString()||3000}원 · 여성 ${cfg.FEE_FEMALE?.toLocaleString()||1000}원 기준
          </div>
        </div>
        <div style="font-size:40px;opacity:0.3;">💳</div>
      </div>

      <!-- 나머지 통계 그리드 -->
      <div class="admin-stat-grid" style="margin-top:4px;">
        ${adminStat('인증 대기',     pendingVerif,   pendingVerif>0?'⚠️':'✅', "switchAdminTab('verif',null)",   pendingVerif>0?'var(--warning)':'var(--success)')}
        ${adminStat('입금 확인 대기', pendingDeposit, pendingDeposit>0?'⚠️':'✅', "switchAdminTab('deposit',null)", pendingDeposit>0?'var(--warning)':'var(--success)')}
        ${adminStat('매칭 성사',     matched,    '', '', 'var(--success)')}
        ${adminStat('활성 남성팀',   maleTeams,  '', "switchAdminTab('teams',null)")}
        ${adminStat('활성 여성팀',   femaleTeams,'', "switchAdminTab('teams',null)")}
        ${adminStat('신고 접수',     reports,    '', "switchAdminTab('reports',null)", reports>0?'var(--error)':'')}
        ${adminStat('후기 대기',     pendingReviews, pendingReviews>0?'✏️':'', "switchAdminTab('reviews',null)", pendingReviews>0?'var(--warning)':'')}
      </div>

      <div style="padding:0 16px 16px;">
        <div style="font-size:13px;font-weight:700;color:var(--gray-700);margin-bottom:10px;">⚡ 빠른 처리</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn btn-secondary btn-sm" style="flex:1;min-width:90px;" onclick="switchAdminTab('users',null)">👤 회원 (${totalUsers})</button>
          <button class="btn btn-secondary btn-sm" style="flex:1;min-width:90px;" onclick="switchAdminTab('verif',null)">🎓 인증 (${pendingVerif})</button>
          <button class="btn btn-secondary btn-sm" style="flex:1;min-width:90px;" onclick="switchAdminTab('deposit',null)">💳 입금 (${pendingDeposit})</button>
          <button class="btn btn-danger btn-sm"    style="flex:1;min-width:90px;" onclick="switchAdminTab('reports',null)">🚨 신고 (${reports})</button>
          <button class="btn btn-secondary btn-sm" style="flex:1;min-width:90px;" onclick="switchAdminTab('reviews',null)">✏️ 후기 (${pendingReviews})</button>
        </div>
      </div>`;
  } catch(err) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div>
      <div class="empty-title">데이터 로드 실패</div>
      <div class="empty-desc">${esc(err.message)}</div></div>`;
  }
}
window.renderAdminDashboard = renderAdminDashboard;

function adminStat(label, num, icon='', onclick='', color='') {
  return `<div class="admin-stat-card" ${onclick?`onclick="${onclick}" style="cursor:pointer;"`:''}>
    <div class="admin-stat-label">${esc(label)}</div>
    <div class="admin-stat-num" ${color?`style="color:${color};"`:''}>${num}</div>
    <div class="admin-stat-trend">${icon}</div>
  </div>`;
}

// 관리자 탭 전환
async function switchAdminTab(tab, el) {
  try { assertAdmin(); } catch { return; }

  if (el) {
    document.querySelectorAll('#admin-tabs button').forEach(b => {
      b.style.borderBottom = 'none'; b.style.color = '';
    });
    el.style.borderBottom = '2px solid var(--pink)';
    el.style.color = 'var(--pink)';
  }

  if (tab === 'dashboard') { renderAdminDashboard(); return; }

  const container = document.getElementById('admin-content');
  if (!container) return;
  container.innerHTML = '<div style="padding:24px;text-align:center;"><div class="spinner"></div></div>';

  // ── 회원 목록 (★ 수정 1: 외래키 충돌 방지를 위해 테이블 명시)
  if (tab === 'users') {
    const { data: users, error } = await _sb
      .from('users')
      .select('*, student_verifications!student_verifications_user_id_fkey(status), deposits!deposits_user_id_fkey(status,amount,depositor_name)')
      .is('deleted_at', null)          // 삭제된 회원 제외
      .not('username', 'like', '__del_%')  // 비활성화된 회원 제외
      .order('created_at', { ascending: false });

    if (error) { container.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-title">${esc(error.message)}</div></div>`; return; }

    container.innerHTML = `
      <div style="padding:12px 16px;background:white;border-bottom:1px solid var(--gray-100);">
        <input class="form-input" type="text" id="admin-search" placeholder="🔍 닉네임, 아이디 검색..."
          style="height:42px;font-size:13px;" oninput="filterAdminUsers(this.value)">
      </div>
      <div id="admin-user-list">
        ${(users||[]).map(u => renderAdminUserRow(u)).join('') ||
          '<div class="empty-state"><div class="empty-icon">👤</div><div class="empty-title">가입자 없음</div></div>'}
      </div>`;
    window._adminUsers = users || [];
    return;
  }

  // ── 인증 목록
  if (tab === 'verif') {
    const { data: verifs, error: verifListErr } = await _sb
      .from('student_verifications')
      .select('*, users!student_verifications_user_id_fkey(id,nickname,username,university,gender)')
      .order('created_at', { ascending: false });

    if (verifListErr) {
      container.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div>
        <div class="empty-title">인증 목록 조회 실패</div>
        <div class="empty-desc">${esc(verifListErr.message)}</div></div>`;
      return;
    }

    // 서명된 URL 생성 (5분 유효) — 병렬 처리
    const rows = await Promise.all((verifs || []).map(async v => {
      if (v.image_path) {
        const { data: urlData } = await _sb.storage
          .from('student-verifications').createSignedUrl(v.image_path, 300);
        v.signed_url = urlData?.signedUrl || null;
      }
      return v;
    }));

    container.innerHTML = `
      <div style="padding:12px 16px 8px;font-size:14px;font-weight:700;">🎓 인증 관리 (총 ${rows.length}건)</div>
      <div class="menu-list">
        ${rows.length === 0
          ? '<div class="empty-state"><div class="empty-icon">🎓</div><div class="empty-title">인증 요청 없음</div></div>'
          : rows.map(v => `
            <div class="admin-list-item">
              <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
                <div>
                  <span style="font-weight:700;">${esc(v.users?.nickname||'-')}</span>
                  <span style="font-size:12px;color:var(--gray-500);margin-left:6px;">${esc(v.users?.university||'-')}</span>
                  <span class="chip ${v.users?.gender==='male'?'chip-purple':'chip-pink'}"
                    style="font-size:10px;margin-left:4px;">${v.users?.gender==='male'?'남':'여'}</span>
                </div>
                <span class="chip ${v.status==='pending'?'chip-orange':v.status==='approved'?'chip-green':'chip-red'}">
                  ${v.status==='pending'?'⏳ 대기':v.status==='approved'?'✅ 승인':'❌ 반려'}
                </span>
              </div>
              ${v.signed_url ? `<a href="${esc(v.signed_url)}" target="_blank" rel="noopener"
                style="display:inline-block;margin-bottom:8px;font-size:12px;color:var(--pink);text-decoration:underline;">
                📷 학생증 이미지 보기 (5분 유효)</a>` : ''}
              ${v.reject_reason ? `<div style="background:#FFEBEE;border-radius:6px;padding:6px 10px;
                font-size:12px;color:var(--error);margin-bottom:6px;">반려 사유: ${esc(v.reject_reason)}</div>` : ''}
              <div style="display:flex;gap:6px;">
                ${v.users?.id ? `<button class="btn btn-outline btn-sm"
                  onclick="openAdminUserDetail('${esc(v.users.id)}')">👤 프로필</button>` : ''}
                ${v.status === 'pending' ? `
                  <button class="btn btn-primary btn-sm" style="flex:1;"
                    onclick="adminApproveVerif('${esc(v.id)}','${esc(v.users?.id)}')">✅ 승인</button>
                  <button class="btn btn-danger btn-sm" style="flex:1;"
                    onclick="adminRejectVerif('${esc(v.id)}','${esc(v.users?.id)}')">❌ 반려</button>
                ` : '<span style="font-size:12px;color:var(--gray-400);">처리 완료</span>'}
              </div>
            </div>`).join('')}
      </div>`;
    return;
  }

  // ── 입금 목록
  if (tab === 'deposit') {
    const { data: deposits, error: depositListErr } = await _sb
      .from('deposits')
      .select('*, users!deposits_user_id_fkey(id,nickname,username,gender,deleted_at)')
      .order('created_at', { ascending: false });

    if (depositListErr) {
      container.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div>
        <div class="empty-title">입금 목록 조회 실패</div>
        <div class="empty-desc">${esc(depositListErr.message)}</div></div>`;
      return;
    }

    // deleted_at 있는 유저의 입금 내역 제외
    const activeDeposits = (deposits||[]).filter(d => !d.users?.deleted_at);

    container.innerHTML = `
      <div style="padding:12px 16px 8px;font-size:14px;font-weight:700;">💳 입금 관리</div>
      <div style="padding:8px 16px;background:#FFF9E7;font-size:12px;color:#795548;">
        ⚠️ ${esc(cfg.BANK_NAME)} ${esc(cfg.BANK_ACCOUNT)} (예금주: ${esc(cfg.BANK_HOLDER)}) 확인 후 처리하세요
      </div>
      <div class="menu-list">
        ${activeDeposits.length === 0
          ? '<div class="empty-state"><div class="empty-icon">💳</div><div class="empty-title">입금 요청 없음</div></div>'
          : activeDeposits.map(d => `
            <div class="admin-list-item">
              <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
                <div>
                  <span style="font-weight:700;">${esc(d.depositor_name)}</span>
                  <span class="chip ${d.users?.gender==='male'?'chip-purple':'chip-pink'}"
                    style="margin-left:6px;font-size:11px;">
                    ${d.users?.gender==='male'?'남성':'여성'} ${(d.amount||0).toLocaleString()}원
                  </span>
                </div>
                <span class="chip ${d.status==='confirmed'?'chip-green':d.status==='rejected'?'chip-red':'chip-orange'}">
                  ${d.status==='confirmed'?'✅ 완료':d.status==='rejected'?'❌ 반려':'⏳ 대기'}
                </span>
              </div>
              <div style="font-size:12px;color:var(--gray-500);margin-bottom:8px;">
                회원: ${esc(d.users?.nickname||'-')}
              </div>
              <div style="display:flex;gap:6px;">
                ${d.users?.id ? `<button class="btn btn-outline btn-sm"
                  onclick="openAdminUserDetail('${esc(d.users.id)}')">👤 프로필</button>` : ''}
                ${d.status === 'pending_confirm' ? `
                  <button class="btn btn-primary btn-sm" style="flex:1;"
                    onclick="adminConfirmDeposit('${esc(d.id)}','${esc(d.users?.id)}')">✅ 입금 확인</button>
                  <button class="btn btn-danger btn-sm" style="flex:1;"
                    onclick="adminRejectDeposit('${esc(d.id)}')">❌ 반려</button>
                ` : '<span style="font-size:12px;color:var(--gray-400);">처리 완료</span>'}
              </div>
            </div>`).join('')}
      </div>`;
    return;
  }

  // ── 신고 목록
  if (tab === 'reports') {
    const { data: reps } = await _sb
      .from('reports')
      .select('*, reporter:users!reports_reporter_id_fkey(nickname), target_user:users!reports_target_user_id_fkey(id,nickname)')
      .order('created_at', { ascending: false });

    container.innerHTML = `
      <div style="padding:12px 16px 8px;font-size:14px;font-weight:700;">🚨 신고 목록</div>
      <div class="menu-list">
        ${(reps||[]).length === 0
          ? '<div class="empty-state"><div class="empty-icon">🚨</div><div class="empty-title">신고 없음</div></div>'
          : (reps||[]).map(r => `
            <div class="admin-list-item">
              <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
                <span class="chip chip-red">${esc(r.report_type)}</span>
                <span class="chip ${r.status==='pending'?'chip-orange':'chip-gray'}">${esc(r.status)}</span>
              </div>
              <p style="font-size:13px;margin-bottom:4px;">
                신고자: <strong>${esc(r.reporter?.nickname||'-')}</strong> →
                피신고자: <strong>${esc(r.target_user?.nickname||'-')}</strong>
              </p>
              <p style="font-size:12px;color:var(--gray-600);margin-bottom:8px;">
                "${esc(r.description)}"
              </p>
              ${r.status === 'pending' ? `
                <div style="display:flex;gap:6px;flex-wrap:wrap;">
                  ${r.target_user?.id ? `<button class="btn btn-outline btn-sm"
                    onclick="openAdminUserDetail('${esc(r.target_user.id)}')">👤 프로필</button>` : ''}
                  <button class="btn btn-danger btn-sm"
                    onclick="adminBanUser('${esc(r.target_user?.id||'')}','${esc(r.id)}')">🚫 제재</button>
                  <button class="btn btn-outline btn-sm"
                    onclick="adminDismissReport('${esc(r.id)}')">기각</button>
                </div>` : ''}
            </div>`).join('')}
      </div>`;
    return;
  }

  // ── 후기 관리
  if (tab === 'reviews') {
    const { data: reviews, error: revErr } = await _sb
      .from('reviews')
      .select('*, users!reviews_user_id_fkey(nickname,username)')
      .order('created_at', { ascending: false });

    if (revErr) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">⚠️</div>
          <div class="empty-title">후기 조회 실패</div>
          <div class="empty-desc">${esc(revErr.message)}<br><br>
            reviews 테이블이 없다면 아래 SQL을 실행하세요:<br>
            <code style="font-size:11px;background:#f5f5f5;padding:4px 8px;border-radius:4px;display:block;margin-top:8px;text-align:left;word-break:break-all;">
              CREATE TABLE IF NOT EXISTS reviews (
                id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
                user_id uuid REFERENCES users(id),
                team_name text, emoji text DEFAULT '🌸',
                rating int DEFAULT 5, comment text NOT NULL,
                status text DEFAULT 'pending',
                created_at timestamptz DEFAULT now()
              );
            </code>
          </div>
        </div>`;
      return;
    }

    const pending  = (reviews||[]).filter(r => r.status === 'pending');
    const approved = (reviews||[]).filter(r => r.status === 'approved');
    const rejected = (reviews||[]).filter(r => r.status === 'rejected');

    const STATUS_CHIP = {
      pending:  'chip-orange',
      approved: 'chip-green',
      rejected: 'chip-red'
    };
    const STATUS_LABEL = {
      pending:  '⏳ 대기',
      approved: '✅ 승인',
      rejected: '❌ 반려'
    };

    const renderReview = (r) => `
      <div class="admin-list-item">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;">
          <div>
            <div style="font-size:14px;font-weight:700;">
              ${esc(r.emoji||'🌸')} ${esc(r.team_name||'익명')}
              <span style="font-size:12px;color:var(--gray-500);font-weight:400;">
                · @${esc(r.users?.username||'-')}
              </span>
            </div>
            <div style="margin-top:4px;">
              ${'⭐'.repeat(Math.min(r.rating||5, 5))}
              <span style="font-size:11px;color:var(--gray-400);margin-left:6px;">
                ${new Date(r.created_at).toLocaleDateString('ko-KR')}
              </span>
            </div>
          </div>
          <span class="chip ${STATUS_CHIP[r.status]||'chip-gray'}" style="flex-shrink:0;">
            ${STATUS_LABEL[r.status]||r.status}
          </span>
        </div>
        <p style="font-size:13px;color:var(--gray-700);line-height:1.6;
          background:var(--gray-50);border-radius:var(--radius-sm);padding:10px 12px;margin-bottom:10px;">
          "${esc(r.comment)}"
        </p>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          ${r.status !== 'approved' ? `
            <button class="btn btn-primary btn-sm"
              onclick="adminApproveReview('${esc(r.id)}')">✅ 승인</button>` : ''}
          ${r.status !== 'rejected' ? `
            <button class="btn btn-danger btn-sm"
              onclick="adminRejectReview('${esc(r.id)}')">❌ 반려</button>` : ''}
          <button class="btn btn-outline btn-sm"
            onclick="adminDeleteReview('${esc(r.id)}')">🗑️ 삭제</button>
        </div>
      </div>`;

    container.innerHTML = `
      <div style="padding:12px 16px 4px;font-size:14px;font-weight:700;">
        ✏️ 후기 관리
        <span style="font-size:12px;font-weight:400;color:var(--gray-500);margin-left:8px;">
          대기 ${pending.length} · 승인 ${approved.length} · 반려 ${rejected.length}
        </span>
      </div>

      ${pending.length > 0 ? `
        <div style="padding:8px 16px 4px;font-size:12px;font-weight:700;color:var(--warning);">
          ⏳ 승인 대기 (${pending.length}건)
        </div>
        <div class="menu-list" style="margin-bottom:8px;">
          ${pending.map(renderReview).join('')}
        </div>` : ''}

      ${approved.length > 0 ? `
        <div style="padding:8px 16px 4px;font-size:12px;font-weight:700;color:var(--success);">
          ✅ 승인된 후기 (${approved.length}건)
        </div>
        <div class="menu-list" style="margin-bottom:8px;">
          ${approved.map(renderReview).join('')}
        </div>` : ''}

      ${rejected.length > 0 ? `
        <div style="padding:8px 16px 4px;font-size:12px;font-weight:700;color:var(--error);">
          ❌ 반려된 후기 (${rejected.length}건)
        </div>
        <div class="menu-list">
          ${rejected.map(renderReview).join('')}
        </div>` : ''}

      ${(reviews||[]).length === 0 ? `
        <div class="empty-state">
          <div class="empty-icon">✏️</div>
          <div class="empty-title">후기가 없습니다</div>
          <div class="empty-desc">사용자가 후기를 작성하면 여기에 표시됩니다</div>
        </div>` : ''}`;
    return;
  }

  // ── 팀 목록
  if (tab === 'teams') {
    const { data: teams, error: teamsErr } = await _sb
      .from('teams').select('*, team_members(*)')
      .order('created_at', { ascending: false });

    if (teamsErr) {
      container.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div>
        <div class="empty-title">팀 목록 조회 실패</div>
        <div class="empty-desc">${esc(teamsErr.message)}</div></div>`;
      return;
    }

    const recruitingCount = (teams||[]).filter(t => t.status === 'recruiting').length;
    const hiddenCount     = (teams||[]).filter(t => t.status === 'hidden').length;

    container.innerHTML = `
      <div style="padding:12px 16px 8px;font-size:14px;font-weight:700;">
        👥 팀 관리
        <span style="font-size:12px;font-weight:400;color:var(--gray-500);margin-left:8px;">
          모집중 ${recruitingCount} · 숨김 ${hiddenCount}
        </span>
      </div>
      <div class="menu-list">
        ${(teams||[]).length === 0
          ? '<div class="empty-state"><div class="empty-icon">👥</div><div class="empty-title">등록된 팀 없음</div></div>'
          : (teams||[]).map(t => {
              const isRecruiting = t.status === 'recruiting';
              return `
              <div class="admin-list-item">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                  <span style="font-weight:700;">${esc(t.title)}</span>
                  <span class="chip ${isRecruiting ? 'chip-green' : 'chip-gray'}">
                    ${isRecruiting ? '🟢 모집중' : '⚫ 숨김'}
                  </span>
                </div>
                <p style="font-size:12px;color:var(--gray-500);margin-bottom:10px;">
                  ${esc(t.university)} · ${t.gender==='male'?'남성':'여성'} · 팀원 ${(t.team_members||[]).length}명
                  · ${new Date(t.created_at).toLocaleDateString('ko-KR')}
                </p>
                <div style="display:flex;gap:6px;flex-wrap:wrap;">
                  ${isRecruiting
                    ? `<button class="btn btn-outline btn-sm"
                        onclick="adminHideTeam('${esc(t.id)}')">⏸️ 숨김</button>`
                    : `<button class="btn btn-primary btn-sm"
                        onclick="adminRestoreTeam('${esc(t.id)}')">▶️ 복원</button>`}
                  <button class="btn btn-danger btn-sm"
                    onclick="adminDeleteTeam('${esc(t.id)}')">🗑️ 삭제</button>
                </div>
              </div>`;
            }).join('')}
      </div>`;
  }
}
window.switchAdminTab = switchAdminTab;

// 관리자 회원 행
function renderAdminUserRow(u) {
  const v = u.student_verifications?.[0] || {};
  const d = u.deposits?.[0] || {};
  const VC = { pending:'chip-orange', approved:'chip-green', rejected:'chip-red' };
  const DC = { pending_confirm:'chip-orange', confirmed:'chip-green', rejected:'chip-red' };
  return `
  <div class="admin-list-item" style="cursor:pointer;" onclick="openAdminUserDetail('${esc(u.id)}')">
    <div style="display:flex;align-items:center;gap:10px;">
      <div style="width:44px;height:44px;min-width:44px;border-radius:50%;
        background:${u.is_banned?'var(--gray-300)':u.gender==='male'?'linear-gradient(135deg,#C77DFF,#7B2FF7)':'linear-gradient(135deg,#FF6B9D,#FF4D7D)'};
        display:flex;align-items:center;justify-content:center;font-size:20px;">
        ${u.is_banned?'🚫':u.gender==='male'?'🙋':'🙋‍♀️'}
      </div>
      <div style="flex:1;min-width:0;">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;flex-wrap:wrap;">
          <span style="font-size:15px;font-weight:700;">${esc(u.nickname||'-')}</span>
          <span class="chip ${u.gender==='male'?'chip-purple':'chip-pink'}"
            style="font-size:10px;padding:2px 6px;">${u.gender==='male'?'남성':'여성'}</span>
          ${u.is_banned?'<span class="chip chip-red" style="font-size:10px;">🚫 제재</span>':''}
          ${u.profile_active&&!u.is_banned?'<span class="chip chip-green" style="font-size:10px;">활성</span>':''}
        </div>
        <div style="font-size:12px;color:var(--gray-500);">
          @${esc(u.username||'-')} · ${esc(u.university||'-')}
        </div>
        <div style="display:flex;gap:4px;margin-top:4px;flex-wrap:wrap;">
          <span class="chip ${VC[v.status]||'chip-gray'}" style="font-size:10px;padding:2px 6px;">
            ${{pending:'⏳ 인증대기',approved:'✅ 인증완료',rejected:'❌ 인증반려'}[v.status]||'미제출'}
          </span>
          <span class="chip ${DC[d.status]||'chip-gray'}" style="font-size:10px;padding:2px 6px;">
            ${{pending_confirm:'⏳ 입금대기',confirmed:'✅ 입금완료',rejected:'❌ 반려'}[d.status]||'미입금'}
          </span>
        </div>
      </div>
      <div style="font-size:18px;color:var(--gray-300);">›</div>
    </div>
  </div>`;
}
window.renderAdminUserRow = renderAdminUserRow;

// 회원 검색 필터
function filterAdminUsers(q) {
  const users = window._adminUsers || [];
  const filtered = q.trim()
    ? users.filter(u =>
        (u.nickname||'').toLowerCase().includes(q.toLowerCase()) ||
        (u.username||'').toLowerCase().includes(q.toLowerCase())
      )
    : users;
  const list = document.getElementById('admin-user-list');
  if (list) {
    list.innerHTML = filtered.map(u => renderAdminUserRow(u)).join('') ||
      '<div class="empty-state"><div class="empty-icon">🔍</div><div class="empty-title">검색 결과 없음</div></div>';
  }
}
window.filterAdminUsers = filterAdminUsers;

// 관리자 회원 상세 (★ 수정 2: 외래키 충돌 방지를 위해 테이블 명시)
async function openAdminUserDetail(userId) {
  try { assertAdmin(); } catch { return; }
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return;

  const { data: u } = await _sb.from('users')
    .select('*, student_verifications!student_verifications_user_id_fkey(*), deposits!deposits_user_id_fkey(*)')
    .eq('id', userId).single();
  if (!u) return;

  const v   = u.student_verifications?.[0] || {};
  const d   = u.deposits?.[0] || {};
  const age = u.birth_year ? new Date().getFullYear() - u.birth_year + 1 : '-';

  // 팀 정보도 조회
  const { data: myTeam } = await _sb
    .from('teams').select('id, title, status, contact_phone, contact_kakao, team_pin, created_at')
    .eq('leader_id', userId).maybeSingle();

  document.getElementById('admin-user-modal-body').innerHTML = `
    <!-- 프로필 헤더 -->
    <div style="background:linear-gradient(135deg,var(--pink),var(--purple));
      border-radius:var(--radius);padding:20px;margin-bottom:16px;text-align:center;color:white;">
      <div style="font-size:24px;font-weight:800;margin-bottom:4px;">${esc(u.nickname||'-')}</div>
      <div style="font-size:13px;opacity:0.85;">@${esc(u.username||'-')}</div>
      <div style="margin-top:8px;display:flex;gap:6px;justify-content:center;flex-wrap:wrap;">
        <span class="chip" style="background:rgba(255,255,255,0.2);color:white;font-size:11px;">
          ${u.gender==='male'?'👨 남성':'👩 여성'}
        </span>
        <span class="chip" style="background:rgba(255,255,255,0.2);color:white;font-size:11px;">
          ${u.profile_active ? '✅ 활성' : '⏳ 대기'}
        </span>
        ${u.is_banned ? '<span class="chip" style="background:#B71C1C;color:white;font-size:11px;">🚫 차단됨</span>' : ''}
      </div>
    </div>

    <!-- 기본 정보 -->
    <div style="background:white;border-radius:var(--radius-sm);border:1px solid var(--gray-100);
      overflow:hidden;margin-bottom:12px;">
      <div style="padding:10px 14px;background:var(--gray-50);font-size:12px;font-weight:700;
        color:var(--gray-600);">📋 기본 정보</div>
      ${iRow('🏫 대학교',    esc(u.university||'-'))}
      ${iRow('📚 학과',      esc(u.department||'-'))}
      ${iRow('🎂 출생연도',  u.birth_year ? u.birth_year+'년생 ('+age+'세)' : '-')}
      ${iRow('🧬 MBTI',      esc(u.mbti||'-'))}
      ${iRow('🚬 흡연',      u.smoking ? '🚬 흡연' : '🚭 비흡연')}
      ${u.bio ? iRow('📝 자기소개', esc(u.bio)) : ''}
      ${u.custom_badge ? iRow('🏷️ 역할뱃지', esc(u.custom_badge)) : ''}
    </div>

    <!-- 관리자 전용 개인정보 -->
    <div style="background:white;border-radius:var(--radius-sm);border:1.5px solid var(--navy);
      overflow:hidden;margin-bottom:12px;">
      <div style="padding:10px 14px;background:var(--navy);font-size:12px;font-weight:700;
        color:rgba(255,255,255,0.85);">🔐 개인정보 (관리자 전용)</div>
      ${iRow('🆔 학번',      esc(u.student_number||'-'))}
      ${iRow('💬 카카오톡 ID (가입)', esc(u.phone_number||'-'))}
      ${iRow('📅 가입일',    u.created_at ? new Date(u.created_at).toLocaleString('ko-KR') : '-')}
      ${iRow('🔑 Auth UID',  `<span style="font-size:10px;word-break:break-all;">${esc(u.auth_id||'-')}</span>`)}
      ${iRow('📢 마케팅 동의', u.marketing_agree ? '✅ 동의' : '❌ 미동의')}
    </div>

    <!-- 서비스 상태 -->
    <div style="background:white;border-radius:var(--radius-sm);border:1px solid var(--gray-100);
      overflow:hidden;margin-bottom:12px;">
      <div style="padding:10px 14px;background:var(--gray-50);font-size:12px;font-weight:700;
        color:var(--gray-600);">📊 서비스 상태</div>
      ${iRow('🎓 인증상태',  {pending:'⏳ 검토중',approved:'✅ 승인',rejected:'❌ 반려'}[v.status]||'미제출')}
      ${v.reject_reason ? iRow('❌ 반려사유', esc(v.reject_reason)) : ''}
      ${iRow('💳 입금상태',  {pending_confirm:'⏳ 확인대기',confirmed:'✅ 완료',rejected:'❌ 반려'}[d.status]||'미입금')}
      ${d.depositor_name ? iRow('💳 입금자명',  esc(d.depositor_name)) : ''}
      ${d.amount         ? iRow('💰 입금액',    d.amount.toLocaleString()+'원') : ''}
      ${iRow('🔓 서비스 활성', u.profile_active ? '✅ 활성화' : '⏳ 비활성')}
    </div>

    <!-- 팀 정보 -->
    ${myTeam ? `
    <div style="background:white;border-radius:var(--radius-sm);border:1px solid var(--gray-100);
      overflow:hidden;margin-bottom:12px;">
      <div style="padding:10px 14px;background:var(--gray-50);font-size:12px;font-weight:700;
        color:var(--gray-600);">👥 등록 팀</div>
      ${iRow('📛 팀 이름',    esc(myTeam.title||'-'))}
      ${iRow('📊 팀 상태',    {recruiting:'🟢 모집중',matched:'🎉 매칭완료',hidden:'⚫ 숨김'}[myTeam.status]||myTeam.status||'-')}
      ${myTeam.contact_phone ? iRow('📸 인스타그램 ID', esc(myTeam.contact_phone)) : ''}
      ${myTeam.contact_kakao ? iRow('💬 카카오톡 ID', esc(myTeam.contact_kakao)) : ''}
      ${iRow('📅 팀 등록일', myTeam.created_at ? new Date(myTeam.created_at).toLocaleDateString('ko-KR') : '-')}
    </div>` : ''}

    <!-- 관리 버튼 -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">
      ${!u.is_banned
        ? `<button class="btn btn-danger btn-sm" onclick="adminBanUser('${esc(u.id)}',null)">🚫 이용 제한</button>`
        : `<button class="btn btn-primary btn-sm" onclick="adminUnbanUser('${esc(u.id)}')">✅ 제재 해제</button>`}
      ${u.profile_active
        ? `<button class="btn btn-outline btn-sm" onclick="adminDeactivateUser('${esc(u.id)}')">⏸️ 비활성화</button>`
        : `<button class="btn btn-secondary btn-sm" onclick="adminActivateUser('${esc(u.id)}')">▶️ 활성화</button>`}
    </div>
    <button class="btn btn-danger btn-sm"
      style="width:100%;margin-bottom:8px;background:#B71C1C;"
      onclick="adminDeleteUser('${esc(u.id)}')">🗑️ 회원 완전 삭제</button>
    <button class="btn btn-outline btn-sm" style="width:100%;"
      onclick="closeModal('modal-admin-user')">닫기</button>`;

  document.getElementById('modal-admin-user')?.classList.add('show');
}
window.openAdminUserDetail = openAdminUserDetail;

function iRow(label, value) {
  return `<div style="display:flex;align-items:center;padding:10px 14px;border-bottom:1px solid var(--gray-50);">
    <span style="font-size:12px;color:var(--gray-500);min-width:90px;font-weight:600;">${label}</span>
    <span style="font-size:13px;flex:1;text-align:right;">${value}</span>
  </div>`;
}

// 인증 승인
async function adminApproveVerif(verifId, userId) {
  try { assertAdmin(); } catch { return; }
  if (!confirm('인증을 승인하시겠습니까?')) return;

  const adminProfile = state.profile;
  try {
    await _sb.from('student_verifications').update({
      status: 'approved', reviewed_by: adminProfile.id,
      reviewed_at: new Date().toISOString(),
      auto_delete_at: new Date(Date.now() + 30*24*60*60*1000).toISOString()
    }).eq('id', verifId);

    await writeAdminLog('verification_approve','student_verifications', verifId, { user_id: userId });
    showToast('✅ 인증이 승인되었습니다');
    switchAdminTab('verif', null);
  } catch(err) {
    showToast('❌ ' + err.message);
  }
}
window.adminApproveVerif = adminApproveVerif;

// 인증 반려
async function adminRejectVerif(verifId, userId) {
  try { assertAdmin(); } catch { return; }
  const reason = prompt('반려 사유를 입력하세요 (회원에게 표시됩니다):');
  if (reason === null) return;

  try {
    await _sb.from('student_verifications').update({
      status: 'rejected',
      reject_reason: reason || '기재 내용 확인 불가',
      reviewed_by: state.profile.id,
      reviewed_at: new Date().toISOString()
    }).eq('id', verifId);

    await writeAdminLog('verification_reject','student_verifications', verifId, { reason, user_id: userId });
    showToast('❌ 인증이 반려되었습니다');
    switchAdminTab('verif', null);
  } catch(err) {
    showToast('❌ ' + err.message);
  }
}
window.adminRejectVerif = adminRejectVerif;

// 입금 확인
async function adminConfirmDeposit(depositId, userId) {
  try { assertAdmin(); } catch { return; }
  if (!confirm('입금을 확인 처리하시겠습니까?')) return;

  try {
    await _sb.from('deposits').update({
      status: 'confirmed',
      confirmed_by: state.profile.id,
      confirmed_at: new Date().toISOString()
    }).eq('id', depositId);

    await writeAdminLog('deposit_confirm','deposits', depositId, { user_id: userId });
    showToast('✅ 입금 확인 완료!');
    switchAdminTab('deposit', null);
  } catch(err) {
    showToast('❌ ' + err.message);
  }
}
window.adminConfirmDeposit = adminConfirmDeposit;

// 입금 반려
async function adminRejectDeposit(depositId) {
  try { assertAdmin(); } catch { return; }
  const reason = prompt('반려 사유를 입력하세요:');
  if (reason === null) return;

  try {
    await _sb.from('deposits').update({
      status: 'rejected', reject_reason: reason || '입금 확인 불가'
    }).eq('id', depositId);

    await writeAdminLog('deposit_reject','deposits', depositId, { reason });
    showToast('❌ 입금이 반려되었습니다');
    switchAdminTab('deposit', null);
  } catch(err) {
    showToast('❌ ' + err.message);
  }
}
window.adminRejectDeposit = adminRejectDeposit;

// 회원 제재
async function adminBanUser(userId, reportId) {
  try { assertAdmin(); } catch { return; }
  if (!userId || !/^[0-9a-f-]{36}$/i.test(userId)) return;
  if (!confirm('이 회원을 이용 제한하시겠습니까?')) return;

  try {
    await _sb.from('users').update({ is_banned: true, profile_active: false }).eq('id', userId);
    if (reportId) {
      await _sb.from('reports').update({
        status: 'resolved', resolved_by: state.profile.id, resolved_at: new Date().toISOString()
      }).eq('id', reportId);
    }
    await writeAdminLog('user_ban','users', userId);
    closeModal('modal-admin-user');
    showToast('🚫 이용 제한 완료');
    switchAdminTab('users', null);
  } catch(err) {
    showToast('❌ ' + err.message);
  }
}
window.adminBanUser = adminBanUser;

// 제재 해제
async function adminUnbanUser(userId) {
  try { assertAdmin(); } catch { return; }
  if (!confirm('제재를 해제하시겠습니까?')) return;

  try {
    await _sb.from('users').update({ is_banned: false }).eq('id', userId);
    await writeAdminLog('user_unban','users', userId);
    closeModal('modal-admin-user');
    showToast('✅ 제재가 해제되었습니다');
    switchAdminTab('users', null);
  } catch(err) {
    showToast('❌ ' + err.message);
  }
}
window.adminUnbanUser = adminUnbanUser;

// ============================================================
// 후기 관리 (승인 / 반려 / 삭제)
// ============================================================
async function adminApproveReview(reviewId) {
  try { assertAdmin(); } catch { return; }
  if (!/^[0-9a-f-]{36}$/i.test(reviewId)) return;
  try {
    const { error } = await _sb.from('reviews')
      .update({ status: 'approved' }).eq('id', reviewId);
    if (error) throw error;
    showToast('✅ 후기가 승인되었습니다. 후기 탭에 게시됩니다.');
    switchAdminTab('reviews', null);
  } catch(err) {
    showToast('❌ 승인 실패: ' + err.message);
  }
}
window.adminApproveReview = adminApproveReview;

async function adminRejectReview(reviewId) {
  try { assertAdmin(); } catch { return; }
  if (!/^[0-9a-f-]{36}$/i.test(reviewId)) return;
  if (!confirm('이 후기를 반려하시겠습니까?')) return;
  try {
    const { error } = await _sb.from('reviews')
      .update({ status: 'rejected' }).eq('id', reviewId);
    if (error) throw error;
    showToast('후기가 반려되었습니다');
    switchAdminTab('reviews', null);
  } catch(err) {
    showToast('❌ 반려 실패: ' + err.message);
  }
}
window.adminRejectReview = adminRejectReview;

async function adminDeleteReview(reviewId) {
  try { assertAdmin(); } catch { return; }
  if (!/^[0-9a-f-]{36}$/i.test(reviewId)) return;
  if (!confirm('이 후기를 완전히 삭제하시겠습니까?')) return;
  try {
    const { error } = await _sb.from('reviews')
      .delete().eq('id', reviewId);
    if (error) throw error;
    showToast('🗑️ 후기가 삭제되었습니다');
    switchAdminTab('reviews', null);
  } catch(err) {
    showToast('❌ 삭제 실패: ' + err.message);
  }
}
window.adminDeleteReview = adminDeleteReview;
async function adminDeleteUser(userId) {
  try { assertAdmin(); } catch { return; }
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return;
  if (!confirm('⚠️ 이 회원을 삭제하시겠습니까?\n\n' +
    '• 팀, 신청내역, 입금 내역이 모두 제거됩니다\n' +
    '• 이 작업은 되돌릴 수 없습니다')) return;

  const ignore = async (p) => { try { await p; } catch(e) { console.warn('[adminDel]', e.message); } };

  const btn = event?.target;
  if (btn) { btn.disabled = true; btn.textContent = '처리 중...'; }

  try {
    // STEP 1: 팀 관련 데이터 삭제
    const { data: myTeams } = await _sb.from('teams').select('id').eq('leader_id', userId);
    const teamIds = (myTeams || []).map(t => t.id);
    if (teamIds.length) {
      await ignore(_sb.from('match_requests').delete().in('male_team_id',   teamIds));
      await ignore(_sb.from('match_requests').delete().in('female_team_id', teamIds));
      await ignore(_sb.from('team_members').delete().in('team_id', teamIds));
      await ignore(_sb.from('teams').delete().in('id', teamIds));
    }

    // STEP 2: 사용자 관련 데이터 삭제
    await ignore(_sb.from('student_verifications').delete().eq('user_id', userId));
    await ignore(_sb.from('deposits').delete().eq('user_id', userId));
    await ignore(_sb.from('terms_consents').delete().eq('user_id', userId));
    await ignore(_sb.from('reports').delete().eq('reporter_id', userId));
    await ignore(_sb.from('reviews').delete().eq('user_id', userId));

    // STEP 3: users 행 완전 삭제 시도
    const { error: delErr } = await _sb.from('users').delete().eq('id', userId);

    if (delErr) {
      // 완전 삭제 실패 → 완전 비활성화 (모든 목록/카운트에서 자동 제외)
      // deleted_at IS NOT NULL → 회원목록·홈통계·입금목록 모두 필터링됨
      const deletedUsername = `__del_${Date.now()}`;
      const { error: softErr } = await _sb.from('users').update({
        deleted_at:     new Date().toISOString(),
        profile_active: false,
        is_banned:      true,
        username:       deletedUsername,   // 아이디 재사용 방지
      }).eq('id', userId);

      if (softErr) {
        throw new Error('삭제 실패: ' + softErr.message + '\n\nSupabase SQL Editor에서 아래를 실행하면 완전 삭제가 됩니다:\nCREATE POLICY "users_admin_delete" ON users FOR DELETE USING (EXISTS (SELECT 1 FROM users WHERE auth_id = auth.uid() AND role = \'admin\'));');
      }
      showToast('✅ 회원이 비활성화되었습니다 (모든 목록에서 제외됨)');
    } else {
      showToast('🗑️ 회원이 완전 삭제되었습니다');
    }

    await writeAdminLog('user_delete', 'users', userId);
    closeModal('modal-admin-user');
    switchAdminTab('users', null);

  } catch(err) {
    showToast('❌ ' + err.message, 6000);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🗑️ 회원 완전 삭제'; }
  }
}
window.adminDeleteUser = adminDeleteUser;
async function adminHideTeam(teamId) {
  try { assertAdmin(); } catch { return; }
  if (!confirm('이 팀을 숨김 처리하시겠습니까?')) return;

  try {
    await _sb.from('teams').update({ is_visible: false, status: 'hidden' }).eq('id', teamId);
    await writeAdminLog('team_hide','teams', teamId);
    showToast('팀이 숨김 처리되었습니다');
    switchAdminTab('teams', null);
  } catch(err) {
    showToast('❌ ' + err.message);
  }
}
window.adminHideTeam = adminHideTeam;

// 팀 모집 재개 (숨김 → 모집중 복원)
async function adminRestoreTeam(teamId) {
  try { assertAdmin(); } catch { return; }
  if (!confirm('이 팀을 모집중으로 복원하시겠습니까?')) return;

  try {
    await _sb.from('teams').update({ is_visible: true, status: 'recruiting' }).eq('id', teamId);
    await writeAdminLog('team_restore', 'teams', teamId);
    showToast('✅ 팀이 모집중으로 복원되었습니다');
    switchAdminTab('teams', null);
  } catch(err) {
    showToast('❌ ' + err.message);
  }
}
window.adminRestoreTeam = adminRestoreTeam;

// 팀 완전 삭제 (team_members 포함 cascade — DB FK ON DELETE CASCADE 권장)
async function adminDeleteTeam(teamId) {
  try { assertAdmin(); } catch { return; }
  if (!confirm('⚠️ 이 팀을 완전히 삭제하시겠습니까?\n팀원 데이터도 함께 삭제됩니다. 되돌릴 수 없습니다.')) return;

  try {
    // 팀원 먼저 삭제 (FK cascade가 없을 경우 대비)
    await _sb.from('team_members').delete().eq('team_id', teamId);
    const { error } = await _sb.from('teams').delete().eq('id', teamId);
    if (error) throw new Error('팀 삭제 실패: ' + error.message);

    await writeAdminLog('team_delete', 'teams', teamId);
    showToast('🗑️ 팀이 삭제되었습니다');
    switchAdminTab('teams', null);
  } catch(err) {
    showToast('❌ ' + err.message);
  }
}
window.adminDeleteTeam = adminDeleteTeam;

// 회원 활성화 (profile_active = true)
async function adminActivateUser(userId) {
  try { assertAdmin(); } catch { return; }
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return;
  if (!confirm('이 회원을 활성화하시겠습니까?')) return;

  try {
    await _sb.from('users').update({ profile_active: true }).eq('id', userId);
    await writeAdminLog('user_activate', 'users', userId);
    closeModal('modal-admin-user');
    showToast('✅ 회원이 활성화되었습니다');
    switchAdminTab('users', null);
  } catch(err) {
    showToast('❌ ' + err.message);
  }
}
window.adminActivateUser = adminActivateUser;

// 회원 비활성화 (profile_active = false)
async function adminDeactivateUser(userId) {
  try { assertAdmin(); } catch { return; }
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return;
  if (!confirm('이 회원을 비활성화하시겠습니까?\n서비스 이용이 제한됩니다.')) return;

  try {
    await _sb.from('users').update({ profile_active: false }).eq('id', userId);
    await writeAdminLog('user_deactivate', 'users', userId);
    closeModal('modal-admin-user');
    showToast('⏸️ 회원이 비활성화되었습니다');
    switchAdminTab('users', null);
  } catch(err) {
    showToast('❌ ' + err.message);
  }
}
window.adminDeactivateUser = adminDeactivateUser;

// 신고 기각
async function adminDismissReport(reportId) {
  try { assertAdmin(); } catch { return; }

  try {
    await _sb.from('reports').update({
      status: 'dismissed', resolved_by: state.profile.id, resolved_at: new Date().toISOString()
    }).eq('id', reportId);
    await writeAdminLog('report_dismiss','reports', reportId);
    showToast('신고가 기각되었습니다');
    switchAdminTab('reports', null);
  } catch(err) {
    showToast('❌ ' + err.message);
  }
}
window.adminDismissReport = adminDismissReport;

// ============================================================
// 29. 미리보기 팀 (예시 데이터)
// ============================================================
const PREVIEW_TEAMS = [
  { id:'p1', title:'🔒 예시 팀 A', university:'강원대학교', avgAge:23,
    members:[
      { nickname:'홍*동', age:23, dept:'컴퓨터공학', mbti:'ENFJ', smoking:false, intro:'실제 가입 후 이런 프로필이 표시돼요!' },
      { nickname:'김*수', age:22, dept:'기계공학',   mbti:'INTP', smoking:false, intro:'팀원 프로필 예시입니다 😊' },
      { nickname:'이*우', age:24, dept:'전기전자',   mbti:'ESTP', smoking:true,  intro:'지금 가입하면 바로 매칭!' }
    ]
  }
];

function renderPreviewTeamList() {
  const container = document.getElementById('preview-team-list');
  if (!container) return;
  container.innerHTML = PREVIEW_TEAMS.map(t => `
    <div class="team-card" style="opacity:0.92;margin-bottom:12px;" onclick="showScreen('screen-register')">
      <div style="background:linear-gradient(90deg,var(--pink),var(--purple));
        padding:5px;text-align:center;font-size:11px;font-weight:700;color:white;">🔒 예시 프로필</div>
      <div class="team-card-header">
        <div class="team-card-info">
          <div class="team-card-title">${esc(t.title)}</div>
          <div class="team-card-sub">${esc(t.university)} · 평균 ${esc(String(t.avgAge))}세</div>
        </div>
        <span class="chip chip-pink">모집중</span>
      </div>
      <div class="team-card-footer">
        <button class="btn btn-primary btn-sm" style="flex:1;"
          onclick="event.stopPropagation();showScreen('screen-register')">💌 가입하고 신청하기</button>
      </div>
    </div>`).join('');
}
window.renderPreviewTeamList = renderPreviewTeamList;

// ============================================================
// 30. 모달 / 공통 유틸
// ============================================================
function closeModal(id) {
  document.getElementById(id)?.classList.remove('show');
}
window.closeModal = closeModal;

// 모달 오버레이 클릭 닫기
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => {
    if (e.target === overlay) overlay.classList.remove('show');
  });
});

// 파일 업로드
function triggerUpload() { document.getElementById('file-input')?.click(); }
function handleFileSelect(input) {
  const file = input.files?.[0];
  if (!file) return;
  const ALLOWED = ['image/jpeg','image/png','image/webp'];
  if (!ALLOWED.includes(file.type)) { showToast('JPG, PNG 파일만 업로드 가능합니다'); return; }
  if (file.size > 10*1024*1024)     { showToast('10MB 이하 파일만 업로드 가능합니다'); return; }
  state.uploadedFile = file;
  // textContent로 XSS 방어
  setText('upload-icon',  '✅');
  setText('upload-title', file.name);
  setText('upload-sub',   (file.size/1024).toFixed(0)+'KB');
  const zone = document.getElementById('upload-zone');
  if (zone) zone.style.borderColor = 'var(--pink)';
}
window.triggerUpload    = triggerUpload;
window.handleFileSelect = handleFileSelect;

// 전체 동의
function toggleAll(el) {
  document.querySelectorAll('.required-agree, #screen-register input[type="checkbox"]')
    .forEach(c => { c.checked = el.checked; });
}
window.toggleAll = toggleAll;

// 출생연도 초기화
(function initBirthYear() {
  const sel = document.getElementById('birth-year');
  if (!sel) return;
  const cy = new Date().getFullYear();
  const fragment = document.createDocumentFragment();
  // 만 18세(cy-17) ~ 1980년생까지 표시 (07년생 포함)
  for (let y = cy - 17; y >= 1980; y--) {
    const opt = document.createElement('option');
    opt.value = y;
    opt.textContent = y + '년';
    fragment.appendChild(opt);
  }
  sel.appendChild(fragment);
})();

// 팀원 폼 초기화 — 팀원 1명 필수 / 2·3번 선택(접기/펼치기)
(function initTeamForms() {
  const container = document.getElementById('team-member-forms');
  if (!container) return;

  const MBTI_LIST = ['INTJ','INTP','ENTJ','ENTP','INFJ','INFP','ENFJ','ENFP',
                     'ISTJ','ISFJ','ESTJ','ESFJ','ISTP','ISFP','ESTP','ESFP'];
  const mbtiOpts = MBTI_LIST.map(m => {
    const opt = document.createElement('option');
    opt.value = opt.textContent = m;
    return opt.outerHTML;
  }).join('');

  // 팀원 카드 생성 함수
  function memberCard(i) {
    const isLeader   = i === 1;
    const isOptional = i > 1;
    return `
    <div class="card card-p" style="margin-bottom:12px;" id="member-card-${i}">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:${isOptional ? '0' : '12px'};">
        <div style="background:${isLeader ? 'var(--pink)' : 'var(--purple)'};color:white;
          width:24px;height:24px;border-radius:50%;
          display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;">${i}</div>
        <span style="font-size:14px;font-weight:700;flex:1;">
          팀원 ${i}${isLeader ? ' (나·팀장)' : ' (선택)'}
        </span>
        ${isLeader
          ? '<span class="chip chip-pink">팀장</span><span class="chip chip-green">✅ 인증완료</span>'
          : `<span class="chip chip-orange" id="verif-status-${i}">⚠️ 미확인</span>
             <button type="button" onclick="toggleMemberCard(${i})"
               id="toggle-btn-${i}"
               style="background:none;border:none;font-size:18px;cursor:pointer;padding:0 4px;color:var(--gray-400);">＋</button>`}
      </div>

      <!-- 2·3번: 기본 접힘, 버튼으로 펼침 -->
      <div id="member-fields-${i}" style="${isOptional ? 'display:none;' : ''}margin-top:${isOptional ? '12px' : '0'};">
        ${isOptional ? `
        <div style="background:#FFF8E1;border:1px solid #FFE082;border-radius:8px;
            padding:10px 12px;margin-bottom:10px;">
          <label class="checkbox-item" style="align-items:center;">
            <input type="checkbox" id="verif-confirm-${i}" onchange="handleVerifConfirm(${i},this)">
            <span class="checkbox-box"></span>
            <span style="font-size:12px;color:#795548;">
              팀원 ${i}이 앱 <strong>가입+학생증 인증 승인</strong> 완료 회원임을 확인했습니다
            </span>
          </label>
        </div>` : ''}
        <div class="form-group" style="margin-bottom:8px;">
          <label class="form-label">닉네임${isLeader ? ' <span class="required">*</span>' : ''}</label>
          <input class="form-input" type="text" id="m${i}-nickname" style="height:44px;"
            placeholder="${isLeader ? '본인 닉네임' : '팀원 닉네임'}" maxlength="50" autocomplete="off">
        </div>
        <div class="form-row" style="margin-bottom:8px;">
          <div class="form-group" style="margin-bottom:0;">
            <label class="form-label">나이${isLeader ? ' <span class="required">*</span>' : ''}</label>
            <input class="form-input" type="number" id="m${i}-age"
              style="height:44px;" placeholder="22" min="19" max="60">
          </div>
          <div class="form-group" style="margin-bottom:0;">
            <label class="form-label">MBTI</label>
            <select class="form-select" id="m${i}-mbti" style="height:44px;">
              <option value="">선택</option>${mbtiOpts}
            </select>
          </div>
        </div>
        <div class="form-group" style="margin-bottom:8px;">
          <label class="form-label">학과${isLeader ? ' <span class="required">*</span>' : ''}</label>
          <input class="form-input" type="text" id="m${i}-dept"
            style="height:44px;" placeholder="학과명" maxlength="100">
        </div>
        <div class="form-group" style="margin-bottom:8px;">
          <label class="form-label">흡연 여부</label>
          <div class="radio-group" style="gap:8px;">
            <div class="radio-item">
              <input type="radio" name="smoke${i}" id="ns${i}" checked>
              <label class="radio-label" for="ns${i}" style="font-size:13px;">🚭 비흡연</label>
            </div>
            <div class="radio-item">
              <input type="radio" name="smoke${i}" id="s${i}">
              <label class="radio-label" for="s${i}" style="font-size:13px;">🚬 흡연</label>
            </div>
          </div>
        </div>
        <div class="form-group" style="margin-bottom:8px;">
          <label class="form-label">역할 뱃지 <span style="font-size:11px;color:var(--gray-400);font-weight:400;">(선택)</span></label>
          <input class="form-input" type="text" id="m${i}-badge" style="height:44px;"
            placeholder="예: MC, 얼굴 담당, 분위기메이커" maxlength="20">
        </div>
        <div class="form-group" style="margin-bottom:0;">
          <label class="form-label">한줄 소개</label>
          <input class="form-input" type="text" id="m${i}-intro" style="height:44px;"
            placeholder="나를 표현하는 한 문장" maxlength="200">
        </div>
      </div>
    </div>`;
  }

  container.innerHTML = [1, 2, 3].map(memberCard).join('') + `
    <!-- 연락처 섹션 -->
    <div class="card card-p" style="margin-bottom:12px;">
      <div style="font-size:14px;font-weight:700;margin-bottom:4px;">📞 연락처</div>
      <div style="font-size:12px;color:var(--gray-500);margin-bottom:12px;">
        매칭 성사 시 상대팀에게만 공개됩니다. 하나 이상 입력해주세요.
      </div>
      <div class="form-group" style="margin-bottom:10px;">
        <label class="form-label">인스타그램 ID <span class="required">*</span></label>
        <input class="form-input" type="text" id="contact-phone" style="height:48px;"
          placeholder="인스타그램 아이디 (@제외)" maxlength="50" autocomplete="off" inputmode="text">
      </div>
      <div class="form-group" style="margin-bottom:0;">
        <label class="form-label">카카오톡 ID <span style="font-size:11px;color:var(--gray-400);font-weight:400;">(선택)</span></label>
        <input class="form-input" type="text" id="contact-kakao" style="height:48px;"
          placeholder="카카오톡 아이디 입력" maxlength="50" autocomplete="off">
      </div>
    </div>

    <!-- 인증 안내 배너 -->
    <div style="background:linear-gradient(135deg,#E8F5E9,#F1F8E9);
      border:1px solid #A5D6A7;border-radius:12px;padding:14px 16px;margin-bottom:4px;">
      <div style="font-size:13px;font-weight:700;color:#2E7D32;margin-bottom:6px;">
        ✅ 인증완료 팀 혜택
      </div>
      <div style="font-size:12px;color:#388E3C;line-height:1.7;">
        • 학생증 인증 + 입금이 완료된 회원의 팀은 홈 화면 <strong>상단에 우선 노출</strong>돼요<br>
        • 인증 없이도 팀 등록은 가능하지만, 노출 순위가 낮을 수 있어요
      </div>
    </div>`;
})();

// 팀원 2·3번 접기/펼치기 토글
function toggleMemberCard(i) {
  const fields = document.getElementById(`member-fields-${i}`);
  const btn    = document.getElementById(`toggle-btn-${i}`);
  if (!fields) return;
  const isOpen = fields.style.display !== 'none';
  fields.style.display = isOpen ? 'none' : 'block';
  if (btn) btn.textContent = isOpen ? '＋' : '－';
  // 접을 때 입력값 초기화 (없애면 서버에 안 보내짐)
  if (isOpen) {
    const idEl = document.getElementById(`m${i}-nickname`);
    if (idEl) idEl.value = '';
  }
}
window.toggleMemberCard = toggleMemberCard;

function handleVerifConfirm(i, el) {
  const status = document.getElementById(`verif-status-${i}`);
  if (!status) return;
  status.textContent = el.checked ? '✅ 인증 확인됨' : '⚠️ 인증 미확인';
  status.className   = el.checked ? 'chip chip-green' : 'chip chip-orange';
}
window.handleVerifConfirm = handleVerifConfirm;

// 약관 모달 (정적 데이터)
const TERMS_DATA = {
  terms: {
    title: '서비스 이용약관',
    body: '서비스 이용약관 내용입니다. 만 19세 이상 재학생만 이용 가능하며, 허위 정보 기재 시 이용이 제한될 수 있습니다.'
  },
  privacy: {
    title: '개인정보 처리방침',
    body: `수집 항목: 아이디, 닉네임, 성별, 대학교, 학과, 학번, 출생연도, MBTI, 흡연 여부, 자기소개\n학생증 이미지는 관리자 검수 후 30일 내 자동 삭제됩니다.`
  },
  refund: {
    title: '환불 정책',
    body: `환불 요청: ${cfg.ADMIN_EMAIL}\n처리 기간: 영업일 5일 이내\n서비스 이용 후에는 환불이 불가합니다.`
  },
  community: {
    title: '커뮤니티 운영정책',
    body: '욕설/성희롱은 즉시 제재, 허위 프로필은 계정 정지됩니다. 신고 내용은 관리자만 확인합니다.'
  }
};

function showTerms(type) {
  const d = TERMS_DATA[type];
  if (!d) return;
  // textContent로 XSS 방어
  setText('modal-terms-title', d.title);
  const body = document.getElementById('modal-terms-body');
  if (body) body.textContent = d.body;
  document.getElementById('modal-terms')?.classList.add('show');
}
window.showTerms = showTerms;

function confirmUnverifiedTeam() { closeModal('team-unverified-confirm'); }
window.confirmUnverifiedTeam = confirmUnverifiedTeam;

// ============================================================
// 32. 앱 이용 방법 모달
// ============================================================
function showHowToUse() {
  const modalId = 'modal-how-to-use';
  let el = document.getElementById(modalId);

  if (!el) {
    el = document.createElement('div');
    el.id        = modalId;
    el.className = 'modal-overlay';
    el.style.cssText = 'z-index:9999;overflow-y:auto;align-items:flex-start;padding:16px 0;';

    el.innerHTML = `
      <div class="modal-sheet" style="border-radius:20px;max-width:480px;width:calc(100% - 32px);
        margin:auto;padding:0;overflow:hidden;">

        <!-- 헤더 -->
        <div style="background:linear-gradient(135deg,var(--pink),var(--purple));
          padding:24px 20px 20px;color:white;text-align:center;position:relative;">
          <button onclick="closeModal('${modalId}')"
            style="position:absolute;right:16px;top:16px;background:rgba(255,255,255,0.2);
              border:none;color:white;width:30px;height:30px;border-radius:50%;
              font-size:16px;cursor:pointer;line-height:1;">✕</button>
          <div style="font-size:28px;margin-bottom:8px;">🌸</div>
          <div style="font-size:20px;font-weight:800;margin-bottom:4px;">춘천 과팅 이용 방법</div>
          <div style="font-size:13px;opacity:0.85;">5분이면 준비 완료!</div>
        </div>

        <!-- 스텝 목록 -->
        <div style="padding:20px 16px;background:white;">

          ${howToStep('1', '🙋', '회원 가입',
            '아이디·비밀번호·학과 등 기본 정보를 입력하고 학생증 사진을 업로드해요.',
            ['현재 재학 중인 학생만 가입 가능', '만 19세 이상만 이용 가능'])}

          ${howToStep('2', '💳', '이용료 입금',
            `남성 ${(cfg.FEE_MALE||3000).toLocaleString()}원 / 여성 ${(cfg.FEE_FEMALE||1000).toLocaleString()}원을 아래 계좌로 입금해요.`,
            [`${esc(cfg.BANK_NAME)} ${esc(cfg.BANK_ACCOUNT)} (${esc(cfg.BANK_HOLDER)})`,
             '입금자명을 앱에 정확히 기재해주세요'])}

          ${howToStep('3', '✅', '관리자 승인',
            '학생증 인증과 입금이 확인되면 관리자가 계정을 활성화해요.',
            ['보통 수 시간~1 영업일 이내 처리', '결과는 앱 내 알림으로 안내됩니다'])}

          ${howToStep('4', '👥', '팀 등록',
            '활성화 후 팀 탭에서 팀을 등록해요. 혼자도 가능하고 최대 3명까지 팀을 꾸릴 수 있어요.',
            ['인증·입금 여부와 관계없이 로그인하면 팀 등록 가능해요',
             '인증+입금 완료 팀은 홈 상단에 우선 노출돼요',
             '연락처 전화번호를 입력하면 매칭 성사 시 상대팀에게 공개돼요'])}

          ${howToStep('5', '💌', '과팅 신청',
            '홈에서 마음에 드는 남성 팀을 골라 신청해요. (여성 팀이 남성 팀에게 신청)',
            ['한 팀에 중복 신청은 안 돼요', '신청 내역은 신청 탭에서 확인 가능'])}

          ${howToStep('6', '🎉', '매칭 성사!',
            '관리자가 양팀을 매칭하면 연락처가 공개돼요. 즐거운 과팅 되세요!',
            ['매칭 후 취소·환불은 불가', '문의: ' + esc(cfg.ADMIN_EMAIL||'')])}

          <!-- 유의사항 -->
          <div style="background:#FFF8E1;border:1px solid #FFE082;border-radius:12px;
            padding:14px 16px;margin-top:4px;">
            <div style="font-size:13px;font-weight:700;color:#795548;margin-bottom:8px;">⚠️ 유의사항</div>
            <ul style="margin:0;padding-left:16px;font-size:12px;color:#795548;line-height:1.8;">
              <li>허위 정보 기재 시 즉시 이용 제한됩니다</li>
              <li>상대방을 배려하는 매너 있는 과팅 문화를 만들어요</li>
              <li>불건전한 언행·성희롱은 영구 제재 대상입니다</li>
              <li>환불은 서비스 이용 전에만 가능합니다</li>
            </ul>
          </div>

          <button class="btn btn-primary" style="width:100%;margin-top:16px;height:50px;font-size:16px;"
            onclick="closeModal('${modalId}')">이해했어요! 시작하기 🌸</button>
        </div>
      </div>`;

    el.addEventListener('click', e => {
      if (e.target === el) el.classList.remove('show');
    });
    document.body.appendChild(el);
  }

  el.scrollTop = 0;
  el.classList.add('show');
}
window.showHowToUse = showHowToUse;

// 이용 방법 스텝 카드 렌더 헬퍼
function howToStep(num, emoji, title, desc, bullets = []) {
  return `
  <div style="display:flex;gap:12px;margin-bottom:20px;align-items:flex-start;">
    <div style="min-width:36px;height:36px;border-radius:50%;
      background:linear-gradient(135deg,var(--pink),var(--purple));
      color:white;display:flex;align-items:center;justify-content:center;
      font-size:13px;font-weight:800;">${esc(num)}</div>
    <div style="flex:1;">
      <div style="font-size:15px;font-weight:700;margin-bottom:4px;">
        ${emoji} ${esc(title)}
      </div>
      <div style="font-size:13px;color:var(--gray-600);line-height:1.5;margin-bottom:${bullets.length?'6px':'0'};">
        ${esc(desc)}
      </div>
      ${bullets.length ? `
      <ul style="margin:0;padding-left:16px;font-size:12px;color:var(--gray-500);line-height:1.8;">
        ${bullets.map(b => `<li>${esc(b)}</li>`).join('')}
      </ul>` : ''}
    </div>
  </div>`;
}

// ============================================================
// 31. 앱 시작
// ============================================================
initApp();
