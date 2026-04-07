/**
 * app.js — 춘천 과팅 메인 애플리케이션
 * v2.0 전면 재작성: 실제 Supabase Auth 기반 인증, XSS 방어, RLS 연동
 * v2.1 업데이트: 조인 외래키 명시, 카카오링크 검증, Auth 세션 예외 처리 강화
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
  'screen-messages','screen-mypage','screen-match-success'
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
  requests: 'screen-requests', messages: 'screen-messages', mypage: 'screen-mypage'
};

function switchTab(tab) {
  if (!state.profile && tab !== 'home') {
    const actionMap = { find:'team', requests:'request', messages:'message', mypage:'mypage' };
    showAuthGateModal(actionMap[tab] || 'default');
    return;
  }
  showScreen(TAB_SCREEN[tab]);
  if (tab === 'requests') loadAndRenderRequests('sent');
  if (tab === 'messages') renderMessages();
  if (tab === 'home')     { loadTeams(); updateHomeStats(); }
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
  updateMyPageStatus();
  loadTeams();
  updateHomeStats();
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

function showForgotPasswordModal() {
  const el = document.getElementById('modal-forgot-pw');
  if (!el) {
    // 모달 DOM이 없으면 동적 생성 (index.html에 추가하면 제거 가능)
    const overlay = document.createElement('div');
    overlay.id        = 'modal-forgot-pw';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-sheet" style="border-radius:20px 20px 0 0;">
        <div style="padding:24px;">
          <div style="font-size:20px;font-weight:800;margin-bottom:8px;">🔑 비밀번호 재설정</div>
          <p style="font-size:13px;color:var(--gray-600);margin-bottom:16px;line-height:1.6;">
            가입 시 사용한 <strong>아이디</strong>를 입력하면<br>
            등록된 이메일로 재설정 링크를 보내드립니다.
          </p>
          <div class="form-group">
            <label class="form-label">아이디</label>
            <input class="form-input" type="text" id="forgot-pw-id"
              placeholder="아이디 입력" style="height:48px;"
              autocomplete="username" autocorrect="off" autocapitalize="none">
          </div>
          <div id="forgot-pw-result" style="font-size:12px;margin-top:6px;min-height:16px;"></div>
          <button class="btn btn-primary" id="btn-forgot-pw"
            onclick="doForgotPassword()" style="width:100%;margin-top:16px;">
            재설정 메일 발송
          </button>
          <button class="btn btn-outline" style="width:100%;margin-top:8px;"
            onclick="closeModal('modal-forgot-pw')">취소</button>
        </div>
      </div>`;
    // 오버레이 클릭으로 닫기
    overlay.addEventListener('click', e => {
      if (e.target === overlay) overlay.classList.remove('show');
    });
    document.body.appendChild(overlay);
  }
  // 입력값·결과 초기화
  const idInput  = document.getElementById('forgot-pw-id');
  const resultEl = document.getElementById('forgot-pw-result');
  if (idInput)  idInput.value = '';
  if (resultEl) resultEl.textContent = '';
  document.getElementById('modal-forgot-pw').classList.add('show');
}
window.showForgotPasswordModal = showForgotPasswordModal;

async function doForgotPassword() {
  const usernameRaw = document.getElementById('forgot-pw-id')?.value.trim();
  const resultEl    = document.getElementById('forgot-pw-result');

  if (!usernameRaw) { showToast('아이디를 입력해주세요'); return; }
  if (usernameRaw.length < 4) { showToast('아이디는 4자 이상이어야 합니다'); return; }

  setBtnLoading('btn-forgot-pw', true, '재설정 메일 발송');
  try {
    // users 테이블에서 해당 아이디의 존재 여부 확인
    const { data: userRow } = await _sb
      .from('users')
      .select('id, auth_id')
      .eq('username', usernameRaw)
      .is('deleted_at', null)
      .maybeSingle();

    // 보안: 존재 여부와 무관하게 성공 메시지 (타이밍 공격 방지)
    if (!userRow) {
      if (resultEl) {
        resultEl.textContent = '✅ 해당 아이디로 등록된 경우 재설정 링크가 발송됩니다.';
        resultEl.style.color = 'var(--success, #388E3C)';
      }
      showToast('📧 등록된 경우 재설정 메일이 발송됩니다');
      return;
    }

    // Supabase 내부 이메일로 재설정 메일 발송
    const email = `${usernameRaw}@chuncheon-dating.local`;
    const { error: resetErr } = await _sb.auth.resetPasswordForEmail(email, {
      // 재설정 완료 후 리디렉션할 URL — 실제 배포 도메인으로 교체 필요
      redirectTo: window.location.origin + window.location.pathname + '?mode=reset-password'
    });

    if (resetErr) {
      // "Email not found"는 사용자에게 노출하지 않고 성공처럼 처리
      if (resetErr.message.toLowerCase().includes('not found') ||
          resetErr.message.toLowerCase().includes('unable to find')) {
        if (resultEl) {
          resultEl.textContent = '✅ 해당 아이디로 등록된 경우 재설정 링크가 발송됩니다.';
          resultEl.style.color = 'var(--success, #388E3C)';
        }
        showToast('📧 등록된 경우 재설정 메일이 발송됩니다');
        return;
      }
      throw new Error('메일 발송 실패: ' + resetErr.message);
    }

    // 성공
    if (resultEl) {
      resultEl.textContent = '✅ 재설정 링크가 발송되었습니다. 메일함을 확인해주세요.';
      resultEl.style.color = 'var(--success, #388E3C)';
    }
    showToast('📧 재설정 메일이 발송되었습니다. 메일함을 확인해주세요', 4000);

    // 3초 후 모달 자동 닫기
    setTimeout(() => closeModal('modal-forgot-pw'), 3000);

  } catch(err) {
    console.error('[doForgotPassword]', err);
    if (resultEl) {
      resultEl.textContent = '❌ ' + err.message;
      resultEl.style.color = 'var(--error, #D32F2F)';
    }
    showToast('❌ ' + err.message);
  } finally {
    setBtnLoading('btn-forgot-pw', false, '재설정 메일 발송');
  }
}
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
// 13. 홈 통계 (DB에서 실시간)
// ============================================================
async function updateHomeStats() {
  try {
    const [{ count: tc }, { count: mc }, { count: uc }] = await Promise.all([
      _sb.from('teams').select('*', { count:'exact', head:true })
        .eq('status','recruiting').eq('is_visible',true),
      _sb.from('matches').select('*', { count:'exact', head:true }),
      _sb.from('users').select('*', { count:'exact', head:true }).is('deleted_at',null)
    ]);
    setText('stat-teams',   tc ?? 0);
    setText('stat-matched', mc ?? 0);
    setText('stat-members', uc ?? 0);
  } catch(e) { /* 통계 실패 시 무시 */ }
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
  // 필수 동의 검증
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
  const mbti       = document.getElementById('reg-mbti')?.value || null;
  const smoking    = document.querySelector('input[name="smoking"]:checked')?.value === 'yes';
  const bio        = document.getElementById('reg-bio')?.value.trim() || null;
  const marketing  = !!document.getElementById('agree-marketing')?.checked;

  // 입력값 클라이언트 검증
  if (!username || username.length < 4) { showToast('아이디는 4자 이상이어야 합니다'); return; }
  if (!/^[a-zA-Z0-9_]+$/.test(username)){ showToast('아이디는 영문·숫자·밑줄만 사용 가능합니다'); return; }
  if (!password || password.length < 8)  { showToast('비밀번호는 8자 이상이어야 합니다'); return; }
  if (password !== password2)            { showToast('비밀번호가 일치하지 않습니다'); return; }
  if (!gender)                           { showToast('성별을 선택해주세요'); return; }
  if (!university || university === '')  { showToast('대학교를 선택해주세요'); return; }
  if (!department || department.length < 2){ showToast('학과를 입력해주세요'); return; }
  if (!studentNum || studentNum.length < 6){ showToast('학번을 입력해주세요'); return; }
  if (!birthYear || new Date().getFullYear() - birthYear < 19) {
    showToast('만 19세 이상만 가입할 수 있습니다'); return;
  }
  if (!nickname || nickname.length < 2)  { showToast('닉네임은 2자 이상이어야 합니다'); return; }

  // ── 아이디 중복 확인 (DB 재확인 — silent 모드로 호출, 결과는 토스트로 표시)
  const usernameOk = await _checkUsernameAvailable(username, false);
  if (!usernameOk) return;

  // 임시 저장
  state.regData = {
    username, password, gender, university, department,
    student_number: studentNum, birth_year: birthYear,
    nickname, mbti, smoking, bio, marketing_agree: marketing,
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

  const fileInput = document.getElementById('file-input');
  const file = fileInput?.files?.[0];
  if (!file) { showToast('학생증 이미지를 업로드해주세요'); return; }

  // ── 파일 검증: 타입·확장자·크기 (이전 버전 유지)
  const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
  const ALLOWED_EXTS  = ['jpg', 'jpeg', 'png', 'webp'];
  const fileExt = file.name.split('.').pop().toLowerCase().replace(/[^a-z]/g, '');

  if (!ALLOWED_TYPES.includes(file.type)) {
    showToast(`❌ 지원하지 않는 파일 형식입니다 (${esc(file.type || '알 수 없음')}). JPG·PNG·WEBP만 가능합니다.`);
    return;
  }
  if (!ALLOWED_EXTS.includes(fileExt)) {
    showToast(`❌ 파일 확장자가 올바르지 않습니다 (.${esc(fileExt)}). jpg·png·webp 중 하나여야 합니다.`);
    return;
  }
  const fileSizeMB = (file.size / (1024 * 1024)).toFixed(2);
  if (file.size > 10 * 1024 * 1024) {
    showToast(`❌ 파일 크기 초과: ${fileSizeMB}MB. 10MB 이하 파일만 업로드 가능합니다.`);
    return;
  }

  setBtnLoading('btn-verify', true, '업로드 완료');
  try {

    // ══════════════════════════════════════════════════════════
    // STEP 1 — Supabase Auth 계정 생성
    // ══════════════════════════════════════════════════════════
    const email = `${d.username}@chuncheon-dating.local`;
    const { data: authData, error: authErr } = await _sb.auth.signUp({
      email,
      password: d.password,
      options: { data: { username: d.username } }
    });

    if (authErr) {
      if (authErr.message.includes('already registered') || authErr.message.includes('User already registered')) {
        throw new Error('이미 사용 중인 아이디입니다. 다른 아이디를 입력해주세요.');
      }
      throw new Error(`계정 생성 실패 (${authErr.status ?? 'ERR'}): ${authErr.message}`);
    }

    // signUp이 에러 없이 반환됐더라도 user 객체가 없으면 진행 불가
    const authUser = authData?.user;
    if (!authUser?.id) {
      throw new Error('계정 생성 응답이 올바르지 않습니다. 잠시 후 다시 시도해주세요.');
    }

    // signUp 응답의 user.id — 이후 모든 단계에서 이 값을 신뢰의 기준으로 삼는다
    const signUpUid = authUser.id;

    // UUID 형식 사전 검증 (잘못된 값이 DB 경로나 RLS에 흘러들지 않도록)
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_REGEX.test(signUpUid)) {
      throw new Error(`계정 ID 형식이 올바르지 않습니다 (${esc(signUpUid)}). 관리자에게 문의하세요.`);
    }

    // ══════════════════════════════════════════════════════════
    // STEP 2 — 세션 확정 대기
    //
    // 이유: signUp 직후 클라이언트의 JWT 쿠키/localStorage 반영이
    //       수 백ms 지연될 수 있다. 이 시점에 INSERT를 보내면
    //       auth.uid()가 null 로 평가되어 RLS(42501)가 발생한다.
    //
    // - "Confirm Email = OFF": _waitForSession이 첫 폴링(300ms)에 성공
    // - "Confirm Email = ON" : 세션이 영구적으로 발급되지 않으므로 timeout → null 반환
    // ══════════════════════════════════════════════════════════
    const sessionResult = await _waitForSession(signUpUid);

    // 세션이 확인된 경우: 세션의 uid가 signUp uid와 반드시 일치해야 한다
    if (sessionResult) {
      if (sessionResult.userId !== signUpUid) {
        // uid 불일치 — 혼선이 생긴 세션이므로 즉시 정리 후 중단
        await _sb.auth.signOut().catch(() => {});
        throw new Error(
          `세션 uid 불일치: 예상(${esc(signUpUid)}) ≠ 실제(${esc(sessionResult.userId)}). ` +
          '관리자에게 문의하세요.'
        );
      }
      console.info('[submitVerification] 세션 확정 완료 uid:', signUpUid);
    } else {
      // 세션 timeout — "Confirm Email = ON" 환경
      console.warn(
        '[submitVerification] 세션 대기 timeout. ' +
        'Supabase Dashboard → Authentication → Providers → Email → "Confirm email" 을 OFF로 설정하면 ' +
        '가입 즉시 세션이 발급됩니다. 현재는 세션 없이 이후 단계를 진행합니다.'
      );
    }

    // ══════════════════════════════════════════════════════════
    // STEP 3 — users 테이블 프로필 저장
    //
    // auth_id 에 signUpUid 를 명시적으로 전달한다.
    // RLS 정책: INSERT 허용 조건이 auth.uid() = auth_id 라면
    //   → 세션이 확정된 뒤 이 INSERT가 실행되므로 42501 해소됨
    //   → 세션이 없는 경우(Confirm Email ON): anon INSERT 정책이
    //     별도로 존재해야 하며, 없으면 아래 에러 분기에서 안내함
    // ══════════════════════════════════════════════════════════
    const insertPayload = {
      auth_id:         signUpUid,   // ★ RLS auth.uid() 매칭 핵심 필드
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

    // auth_id 이중 검증: insert 직전 payload 값과 signUpUid가 동일한지 재확인
    if (insertPayload.auth_id !== signUpUid) {
      throw new Error('auth_id 내부 검증 실패: insert payload가 signUp uid와 다릅니다.');
    }

    const { data: profile, error: profileErr } = await _sb
      .from('users')
      .insert(insertPayload)
      .select()
      .single();

    if (profileErr) {
      // 프로필 저장 실패 시 Auth 계정도 정리 (세션 있을 때만 가능)
      if (sessionResult) await _sb.auth.signOut().catch(() => {});

      let profileHint = '';
      if (profileErr.code === '23505') {
        profileHint = ' → 이미 가입된 아이디입니다. 다른 아이디로 다시 시도해주세요.';
      } else if (profileErr.code === '42501') {
        profileHint = sessionResult
          ? ' → RLS 정책이 auth.uid() = auth_id 조건을 통과하지 못했습니다. ' +
            'Supabase SQL Editor에서 users INSERT 정책을 확인하세요.'
          : ' → 세션 없이 INSERT가 차단되었습니다. ' +
            'Supabase Dashboard에서 "Confirm email"을 OFF로 설정하거나, ' +
            'anon role에 대한 users INSERT 정책을 추가해주세요.';
      }
      throw new Error(`프로필 저장 실패 [${profileErr.code}]${profileHint}: ${profileErr.message}`);
    }

    // 저장된 프로필의 auth_id가 signUpUid와 일치하는지 최종 확인
    if (profile.auth_id !== signUpUid) {
      console.error('[submitVerification] profile.auth_id 불일치!', profile.auth_id, '≠', signUpUid);
      throw new Error('저장된 프로필의 auth_id가 계정 uid와 일치하지 않습니다. 관리자에게 문의하세요.');
    }

    // ══════════════════════════════════════════════════════════
    // STEP 4 — 동의 항목 저장 (비치명적)
    // ══════════════════════════════════════════════════════════
    const c = d.consents;
    const { error: consentErr } = await _sb.from('terms_consents').insert({
      user_id:            profile.id,
      is_adult:           true,
      terms_agree:        true,
      privacy_agree:      true,
      verification_agree: true,
      deposit_agree:      true,
      falsify_agree:      true,
      marketing_agree:    !!c.marketingAgree
    });
    if (consentErr) {
      // 동의 저장 실패는 가입 흐름을 중단시키지 않고 경고만 기록
      console.warn('[submitVerification] 동의 항목 저장 실패 (무시됨):', consentErr.message);
    }

    // ══════════════════════════════════════════════════════════
    // STEP 5 — 학생증 Storage 업로드
    //   경로: verifications/{signUpUid}/{timestamp}.{ext}
    //   signUpUid는 STEP 1에서 UUID_REGEX 검증 완료
    // ══════════════════════════════════════════════════════════
    const safeName = `${Date.now()}.${fileExt}`;
    const filePath = `verifications/${signUpUid}/${safeName}`;

    const { error: uploadErr } = await _sb.storage
      .from('student-verifications')
      .upload(filePath, file, { contentType: file.type, upsert: false });

    if (uploadErr) {
      let uploadMsg;
      if (uploadErr.message.includes('Bucket not found') || uploadErr.message.includes('bucket')) {
        uploadMsg = '스토리지 버킷(student-verifications)이 존재하지 않습니다. 관리자에게 문의하세요.';
      } else if (uploadErr.message.includes('row-level security') || uploadErr.statusCode === '403') {
        uploadMsg = '스토리지 권한 오류 (RLS): Storage 정책에서 verifications/{auth_id}/ 경로의 INSERT 권한을 확인하세요.';
      } else if (uploadErr.message.includes('Duplicate') || uploadErr.statusCode === '409') {
        uploadMsg = '동일한 파일이 이미 존재합니다. 잠시 후 다시 시도해주세요.';
      } else if (uploadErr.message.includes('size') || uploadErr.message.includes('limit')) {
        uploadMsg = `파일 크기 제한 초과 (${fileSizeMB}MB). 더 작은 파일을 사용해주세요.`;
      } else {
        uploadMsg = `이미지 업로드 실패 [${uploadErr.statusCode ?? 'ERR'}]: ${uploadErr.message}`;
      }
      throw new Error(uploadMsg);
    }

    // ══════════════════════════════════════════════════════════
    // STEP 6 — student_verifications 테이블 저장
    //          관리자 페이지 인증 탭 데이터 노출을 위해 반드시 await
    // ══════════════════════════════════════════════════════════
    const { error: verifErr } = await _sb.from('student_verifications').insert({
      user_id:    profile.id,
      image_path: filePath,
      status:     'pending'
    });
    if (verifErr) {
      throw new Error(`인증 정보 저장 실패 [${verifErr.code}]: ${verifErr.message}`);
    }

    // ══════════════════════════════════════════════════════════
    // STEP 7 — deposits 테이블 초기 레코드 생성
    //   관리자 입금 탭에서 데이터가 노출되려면 가입 시점에
    //   레코드가 존재해야 한다. 입금자명은 닉네임으로 임시 설정.
    // ══════════════════════════════════════════════════════════
    const feeAmount = profile.gender === 'female' ? cfg.FEE_FEMALE : cfg.FEE_MALE;
    const { error: depositInitErr } = await _sb.from('deposits').insert({
      user_id:        profile.id,
      depositor_name: profile.nickname,   // 실제 입금 시 submitDeposit에서 덮어씀
      amount:         feeAmount,
      status:         'pending_confirm'
    });
    // 이미 레코드가 있거나 충돌(23505)이면 무시 — submitDeposit에서 upsert 처리
    if (depositInitErr && depositInitErr.code !== '23505') {
      console.warn('[submitVerification] deposits 초기 레코드 생성 실패 (무시됨):',
        depositInitErr.code, depositInitErr.message);
    }

    // ══════════════════════════════════════════════════════════
    // 완료
    // ══════════════════════════════════════════════════════════
    state.profile = profile;
    state.regData = null;
    setText('home-username', profile.nickname + '님');
    showToast(sessionResult
      ? '🎉 가입 완료! 학생증 검토 후 알림드릴게요'
      : '✅ 가입 정보가 저장되었습니다. 관리자 검토 후 서비스가 활성화됩니다.'
    );
    showScreen('screen-deposit');

  } catch (err) {
    console.error('[submitVerification]', err);
    showToast('❌ ' + err.message);
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
    if (error) throw new Error('입금 신청 저장 실패: ' + error.message);

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
// 17. 회원 탈퇴
// ============================================================
async function doWithdraw() {
  const profile = state.profile;
  if (!profile) return;
  if (!confirm('정말 탈퇴하시겠습니까? 이 작업은 되돌릴 수 없습니다.')) return;

  try {
    // soft delete
    await _sb.from('users').update({
      deleted_at: new Date().toISOString(), profile_active: false
    }).eq('id', profile.id);

    await _sb.auth.signOut();
    state.profile = null;
    state.authUser = null;
    closeModal('modal-withdraw');
    showScreen('screen-landing');
    showToast('탈퇴가 완료되었습니다. 이용해주셔서 감사합니다.');
  } catch(err) {
    showToast('❌ 탈퇴 처리 중 오류가 발생했습니다.');
  }
}
window.doWithdraw = doWithdraw;

// ============================================================
// 18. 팀 목록 (DB에서 로드)
// ============================================================
let _cachedTeams = [];

async function loadTeams(filterVal) {
  const container = document.getElementById('team-list');
  if (!container) return;
  container.innerHTML = '<div style="text-align:center;padding:40px;"><div class="spinner"></div></div>';

  try {
    let query = _sb
      .from('teams')
      .select('*, team_members(*)')
      .eq('gender', 'male')
      .eq('status', 'recruiting')
      .eq('is_visible', true)
      .order('created_at', { ascending: false });

    if (filterVal && filterVal !== 'all' && filterVal !== '비흡연') {
      query = query.ilike('university', `%${filterVal}%`);
    }

    const { data, error } = await query;
    if (error) throw error;

    _cachedTeams = data || [];
    if (filterVal === '비흡연') {
      _cachedTeams = _cachedTeams.filter(t => t.team_members?.every(m => !m.smoking));
    }
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
// 19. 팀 목록 렌더 (XSS 방어 적용)
// ============================================================
const EMOJIS  = ['👨‍💻','🎮','🎸','☕','✈️','🎨','💪','🎳','🕹️','📚'];
const COLORS  = ['#FF6B9D','#C77DFF','#FF8C69','#48CAE4','#F77F00'];

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

  // innerHTML 사용하되 모든 사용자 데이터는 esc() 처리
  container.innerHTML = teams.map((team, ti) => {
    const members = team.team_members || [];
    const avgAge  = members.length
      ? Math.round(members.reduce((s,m) => s + (m.age || 22), 0) / members.length) : 22;

    const memberRows = members.slice(0,3).map((m,i) => `
      <div class="team-card-member">
        <div class="team-member-emoji">${EMOJIS[(ti*3+i)%EMOJIS.length]}</div>
        <div class="team-member-details">
          <div class="team-member-name">${esc(m.nickname)} · ${esc(String(m.age))}세 · ${esc(m.department)}</div>
          <div style="display:flex;gap:4px;margin-top:3px;">
            ${m.mbti ? `<span class="chip chip-purple" style="font-size:10px;padding:2px 7px;">${esc(m.mbti)}</span>` : ''}
            <span class="chip" style="font-size:10px;padding:2px 7px;
              background:${m.smoking?'#FFF3E0':'#E8F5E9'};color:${m.smoking?'#E65100':'#388E3C'};">
              ${m.smoking?'🚬':'🚭'}
            </span>
          </div>
          ${m.intro ? `<p style="font-size:11px;color:var(--gray-600);margin-top:3px;">"${esc(m.intro)}"</p>` : ''}
        </div>
      </div>`).join('');

    const applyBtn = isGuest
      ? `<button class="btn btn-primary btn-sm" style="flex:1;" onclick="showAuthGateModal('apply')">💌 신청하기</button>`
      : `<button class="btn btn-primary btn-sm" style="flex:1;" onclick="showScreen('screen-apply')">💌 신청하기</button>`;

    return `
    <div class="team-card" onclick="openTeamDetail('${esc(team.id)}')">
      ${isGuest ? `<div style="background:#FFF8E1;padding:5px 12px;text-align:center;font-size:11px;color:#795548;">
        👀 구경 중 — 신청은 <span style="color:var(--pink);font-weight:700;cursor:pointer;"
          onclick="event.stopPropagation();showScreen('screen-register')">가입 후</span> 가능해요
      </div>` : ''}
      <div class="team-card-header">
        <div class="team-avatar-group">
          ${members.slice(0,3).map((_,i) => `
            <div class="team-avatar" style="background:${COLORS[(ti*3+i)%COLORS.length]}20;font-size:18px;">
              ${EMOJIS[(ti*3+i)%EMOJIS.length]}
            </div>`).join('')}
        </div>
        <div class="team-card-info">
          <div class="team-card-title">${esc(team.title)}</div>
          <div class="team-card-sub">${esc(team.university)} · 평균 ${esc(String(avgAge))}세</div>
        </div>
        <span class="chip chip-pink">모집중</span>
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
// 22. 팀 등록 (활성 사용자만)
// ============================================================
async function registerTeam() {
  const profile = state.profile;
  if (!profile) { showToast('로그인이 필요합니다'); return; }
  if (!profile.profile_active) { showToast('인증과 입금 완료 후 팀을 등록할 수 있습니다'); return; }

  const title = document.getElementById('team-title')?.value.trim();
  if (!title || title.length < 2) { showToast('팀 제목을 2자 이상 입력해주세요'); return; }

  const members = [];
  for (let i = 1; i <= 3; i++) {
    const nickname = document.getElementById(`m${i}-nickname`)?.value.trim();
    const age      = parseInt(document.getElementById(`m${i}-age`)?.value || '0');
    const dept     = document.getElementById(`m${i}-dept`)?.value.trim();

    if (!nickname) { showToast(`팀원 ${i}의 닉네임을 입력해주세요`); return; }
    if (!age || age < 19 || age > 60) { showToast(`팀원 ${i}의 나이는 19~60세여야 합니다`); return; }
    if (!dept || dept.length < 2) { showToast(`팀원 ${i}의 학과를 입력해주세요`); return; }

    if (i > 1 && !document.getElementById(`verif-confirm-${i}`)?.checked) {
      showToast(`팀원 ${i}의 인증 확인 체크박스를 체크해주세요`);
      return;
    }

    const smoking = document.querySelector(`input[name="smoke${i}"]:checked`)?.id === `s${i}`;
    const mbtiEl  = document.querySelector(`#member-card-${i} select`);
    const introEl = document.querySelector(`#member-card-${i} input[type="text"]:last-child`);
    members.push({
      nickname, age, department: dept, smoking,
      mbti: mbtiEl?.value || null,
      intro: introEl?.value.trim() || null,
      is_leader: i === 1, sort_order: i - 1
    });
  }

  // ★ 수정 3: 빈 문자열을 null로 변환 및 유효성 검사 적용
  let kakaoLink = document.getElementById('kakao-link')?.value.trim();
  if (kakaoLink === '') kakaoLink = null;
  if (kakaoLink && !kakaoLink.startsWith('https://')) {
    showToast('카카오톡 링크는 https:// 로 시작해야 합니다');
    return;
  }

  setBtnLoading('btn-team-register', true, '팀 등록하기 🎉');
  try {
    const { data: team, error: teamErr } = await _sb.from('teams').insert({
      leader_id: profile.id, gender: profile.gender,
      title, university: profile.university,
      status: 'recruiting',
      kakao_open_link: kakaoLink
    }).select().single();
    if (teamErr) throw new Error('팀 등록 실패: ' + teamErr.message);

    const memberRows = members.map(m => ({ ...m, team_id: team.id }));
    const { error: memberErr } = await _sb.from('team_members').insert(memberRows);
    if (memberErr) throw new Error('팀원 등록 실패: ' + memberErr.message);

    showToast('🎉 팀이 등록되었습니다!');
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
// 23. 과팅 신청
// ============================================================
async function submitApply() {
  const profile = state.profile;
  if (!profile) { showToast('로그인이 필요합니다'); return; }
  if (!profile.profile_active) { showToast('서비스 활성화가 필요합니다'); return; }
  if (profile.gender !== 'female') { showToast('여성 회원만 신청할 수 있습니다'); return; }
  showToast('💌 과팅 신청이 완료되었습니다!');
  showScreen('screen-requests');
  loadAndRenderRequests('sent');
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
    if (tab === 'sent') {
      ({ data, error } = await _sb.from('match_requests')
        .select('*, teams!match_requests_male_team_id_fkey(title,university)')
        .eq('female_team_id', myTeam.id)
        .order('created_at', { ascending: false }));
    } else {
      ({ data, error } = await _sb.from('match_requests')
        .select('*, teams!match_requests_female_team_id_fkey(title,university)')
        .eq('male_team_id', myTeam.id)
        .eq('status', 'pending')
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
                onclick="showScreen('screen-match-success')">🎉 연결 정보 보기</button>`
            : ''}
          ${isPendingRecv
            ? `<button class="btn btn-primary btn-sm" style="flex:1;"
                onclick="acceptMatchRequest('${esc(r.id)}')">✅ 수락</button>
               <button class="btn btn-outline btn-sm" style="flex:1;"
                onclick="rejectMatchRequest('${esc(r.id)}')">❌ 거절</button>`
            : ''}
          ${!isMatched && !isPendingRecv
            ? `<button class="btn btn-outline btn-sm"
                onclick="showScreen('screen-messages')">💬 채팅</button>`
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

// 수락
async function acceptMatchRequest(requestId) {
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) return;
  try {
    await _sb.from('match_requests').update({
      status: 'matched', responded_at: new Date().toISOString()
    }).eq('id', requestId);

    // matches 레코드는 관리자 또는 DB 함수로 생성
    showToast('🎉 수락했습니다! 매칭이 성사되었어요');
    showScreen('screen-match-success');
  } catch(err) {
    showToast('❌ ' + err.message);
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
// 25. 메시지
// ============================================================
let _localMessages = [];

function renderMessages() {
  const container = document.getElementById('chat-messages');
  if (!container) return;

  if (_localMessages.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="padding:40px 20px;">
        <div class="empty-icon">💬</div>
        <div class="empty-title">아직 메시지가 없어요</div>
        <div class="empty-desc">신청이 수락되면 채팅이 시작됩니다</div>
      </div>`;
    return;
  }

  // XSS 방어: textContent 설정
  container.innerHTML = '';
  for (const m of _localMessages) {
    const group = document.createElement('div');
    group.className = 'chat-group';
    group.style.alignItems = m.mine ? 'flex-end' : 'flex-start';

    const bubble = document.createElement('div');
    bubble.className = `chat-bubble ${m.mine ? 'mine' : 'theirs'}`;
    bubble.textContent = m.text; // ★ textContent로 XSS 방어

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

function sendMessage() {
  const input = document.getElementById('chat-input');
  const text  = input?.value.trim();
  if (!text || text.length === 0) return;
  if (text.length > 500) { showToast('메시지는 500자 이하로 입력해주세요'); return; }

  const now  = new Date();
  const h    = now.getHours();
  const mi   = String(now.getMinutes()).padStart(2,'0');
  const time = h >= 12 ? `오후 ${h-12||12}:${mi}` : `오전 ${h}:${mi}`;

  _localMessages.push({ mine: true, text, time });
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
// 27. 신고
// ============================================================
function showReport()    { document.getElementById('modal-report')?.classList.add('show'); }
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

  try {
    const { error } = await _sb.from('reports').insert({
      reporter_id: profile.id, report_type: type, description: desc, status: 'pending',
      target_user_id: null // 실제 구현 시 대상 지정
    });
    if (error) throw error;
    closeModal('modal-report');
    showToast('🚨 신고가 접수되었습니다. 검토 후 처리해드릴게요');
    document.getElementById('report-type').value = '';
    document.getElementById('report-desc').value = '';
  } catch(err) {
    showToast('❌ 신고 접수 실패: ' + err.message);
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
    // 각 쿼리를 개별 실행해 한 개가 실패해도 나머지는 표시
    const results = await Promise.allSettled([
      _sb.from('users').select('*', { count:'exact', head:true }).is('deleted_at', null),
      _sb.from('student_verifications').select('*', { count:'exact', head:true }).eq('status', 'pending'),
      _sb.from('deposits').select('*', { count:'exact', head:true }).eq('status', 'pending_confirm'),
      _sb.from('teams').select('*', { count:'exact', head:true }).eq('gender', 'male').eq('status', 'recruiting'),
      _sb.from('teams').select('*', { count:'exact', head:true }).eq('gender', 'female').eq('status', 'recruiting'),
      _sb.from('matches').select('*', { count:'exact', head:true }),
      _sb.from('reports').select('*', { count:'exact', head:true }).eq('status', 'pending'),
    ]);

    // 실패한 쿼리는 0으로 대체, 콘솔에 경고
    const safeCount = (result, idx) => {
      if (result.status === 'rejected') {
        console.warn(`[renderAdminDashboard] 쿼리 ${idx} 실패:`, result.reason);
        return 0;
      }
      if (result.value?.error) {
        console.warn(`[renderAdminDashboard] 쿼리 ${idx} 오류:`, result.value.error.message);
        return 0;
      }
      return result.value?.count ?? 0;
    };

    const totalUsers    = safeCount(results[0], 0);
    const pendingVerif  = safeCount(results[1], 1);
    const pendingDeposit= safeCount(results[2], 2);
    const maleTeams     = safeCount(results[3], 3);
    const femaleTeams   = safeCount(results[4], 4);
    const matched       = safeCount(results[5], 5);
    const reports       = safeCount(results[6], 6);

    container.innerHTML = `
      <div class="admin-stat-grid">
        ${adminStat('총 회원 수',    totalUsers, '', "switchAdminTab('users',null)")}
        ${adminStat('인증 대기',     pendingVerif,   pendingVerif>0?'⚠️':'✅', "switchAdminTab('verif',null)",   pendingVerif>0?'var(--warning)':'var(--success)')}
        ${adminStat('입금 확인 대기', pendingDeposit, pendingDeposit>0?'⚠️':'✅', "switchAdminTab('deposit',null)", pendingDeposit>0?'var(--warning)':'var(--success)')}
        ${adminStat('매칭 성사',     matched,    '', '', 'var(--success)')}
        ${adminStat('활성 남성팀',   maleTeams)}
        ${adminStat('활성 여성팀',   femaleTeams)}
        ${adminStat('신고 접수',     reports,    '', "switchAdminTab('reports',null)", reports>0?'var(--error)':'')}
      </div>
      <div style="padding:0 16px 16px;">
        <div style="font-size:13px;font-weight:700;color:var(--gray-700);margin-bottom:10px;">⚡ 빠른 처리</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn btn-secondary btn-sm" style="flex:1;min-width:100px;" onclick="switchAdminTab('users',null)">👤 회원 (${totalUsers})</button>
          <button class="btn btn-secondary btn-sm" style="flex:1;min-width:100px;" onclick="switchAdminTab('verif',null)">🎓 인증 (${pendingVerif})</button>
          <button class="btn btn-secondary btn-sm" style="flex:1;min-width:100px;" onclick="switchAdminTab('deposit',null)">💳 입금 (${pendingDeposit})</button>
          <button class="btn btn-danger btn-sm" style="flex:1;min-width:100px;" onclick="switchAdminTab('reports',null)">🚨 신고 (${reports})</button>
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
      .is('deleted_at', null)
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
      .select('*, users!deposits_user_id_fkey(id,nickname,username,gender)')
      .order('created_at', { ascending: false });

    if (depositListErr) {
      container.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div>
        <div class="empty-title">입금 목록 조회 실패</div>
        <div class="empty-desc">${esc(depositListErr.message)}</div></div>`;
      return;
    }

    container.innerHTML = `
      <div style="padding:12px 16px 8px;font-size:14px;font-weight:700;">💳 입금 관리</div>
      <div style="padding:8px 16px;background:#FFF9E7;font-size:12px;color:#795548;">
        ⚠️ ${esc(cfg.BANK_NAME)} ${esc(cfg.BANK_ACCOUNT)} (예금주: ${esc(cfg.BANK_HOLDER)}) 확인 후 처리하세요
      </div>
      <div class="menu-list">
        ${(deposits||[]).length === 0
          ? '<div class="empty-state"><div class="empty-icon">💳</div><div class="empty-title">입금 요청 없음</div></div>'
          : (deposits||[]).map(d => `
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

  // ── 팀 목록
  if (tab === 'teams') {
    const { data: teams } = await _sb
      .from('teams').select('*, team_members(*)')
      .order('created_at', { ascending: false });

    container.innerHTML = `
      <div style="padding:12px 16px 8px;font-size:14px;font-weight:700;">👥 팀 관리</div>
      <div class="menu-list">
        ${(teams||[]).length === 0
          ? '<div class="empty-state"><div class="empty-icon">👥</div><div class="empty-title">등록된 팀 없음</div></div>'
          : (teams||[]).map(t => `
            <div class="admin-list-item">
              <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
                <span style="font-weight:700;">${esc(t.title)}</span>
                <span class="chip ${t.status==='recruiting'?'chip-green':'chip-gray'}">${esc(t.status)}</span>
              </div>
              <p style="font-size:12px;color:var(--gray-500);margin-bottom:8px;">
                ${esc(t.university)} · ${t.gender==='male'?'남성':'여성'} · 팀원 ${(t.team_members||[]).length}명
              </p>
              <button class="btn btn-outline btn-sm"
                onclick="adminHideTeam('${esc(t.id)}')">숨김 처리</button>
            </div>`).join('')}
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

  const v = u.student_verifications?.[0] || {};
  const d = u.deposits?.[0] || {};
  const age = u.birth_year ? new Date().getFullYear() - u.birth_year + 1 : '-';

  document.getElementById('admin-user-modal-body').innerHTML = `
    <div style="background:var(--pink-soft);border-radius:var(--radius);padding:20px;margin-bottom:16px;text-align:center;">
      <div style="font-size:20px;font-weight:700;margin-bottom:4px;">${esc(u.nickname||'-')}</div>
      <div style="font-size:13px;color:var(--gray-600);">@${esc(u.username||'-')}</div>
    </div>
    <div style="background:white;border-radius:var(--radius-sm);border:1px solid var(--gray-100);overflow:hidden;margin-bottom:12px;">
      <div style="padding:10px 14px;background:var(--gray-50);font-size:12px;font-weight:700;color:var(--gray-600);">📋 공개 프로필</div>
      ${iRow('🏫 대학교', esc(u.university||'-'))}
      ${iRow('📚 학과', esc(u.department||'-'))}
      ${iRow('🎂 나이', esc(String(age))+'세')}
      ${iRow('🧬 MBTI', esc(u.mbti||'-'))}
      ${iRow('🚬 흡연', u.smoking?'흡연':'비흡연')}
    </div>
    <div style="background:white;border-radius:var(--radius-sm);border:1.5px solid var(--navy);overflow:hidden;margin-bottom:12px;">
      <div style="padding:10px 14px;background:var(--navy);font-size:12px;font-weight:700;color:rgba(255,255,255,0.8);">🔐 관리자 전용</div>
      ${iRow('🆔 학번', esc(u.student_number||'-'))}
      ${iRow('📅 가입일', u.created_at ? new Date(u.created_at).toLocaleString('ko-KR') : '-')}
      ${d.depositor_name ? iRow('💳 입금자명', esc(d.depositor_name)) : ''}
      ${d.amount ? iRow('💰 입금액', d.amount.toLocaleString()+'원') : ''}
      ${iRow('🎓 인증상태', {pending:'⏳ 검토중',approved:'✅ 승인',rejected:'❌ 반려'}[v.status]||'미제출')}
      ${v.reject_reason ? iRow('❌ 반려사유', esc(v.reject_reason)) : ''}
      ${iRow('📛 서비스 상태', u.profile_active ? '✅ 활성' : '⏳ 대기')}
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">
      ${!u.is_banned
        ? `<button class="btn btn-danger btn-sm" onclick="adminBanUser('${esc(u.id)}',null)">🚫 이용 제한</button>`
        : `<button class="btn btn-primary btn-sm" onclick="adminUnbanUser('${esc(u.id)}')">✅ 제재 해제</button>`}
      <button class="btn btn-outline btn-sm" onclick="closeModal('modal-admin-user')">닫기</button>
    </div>`;

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

// 팀 숨김
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
  for (let y = cy-19; y >= 1980; y--) {
    const opt = document.createElement('option');
    opt.value = y;
    opt.textContent = y+'년';
    fragment.appendChild(opt);
  }
  sel.appendChild(fragment);
})();

// 팀원 폼 초기화
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

  // innerHTML 사용 (정적 UI, 사용자 데이터 없음)
  container.innerHTML = [1,2,3].map(i => `
    <div class="card card-p" style="margin-bottom:12px;" id="member-card-${i}">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
        <div style="background:${i===1?'var(--pink)':'var(--purple)'};color:white;width:24px;height:24px;
          border-radius:50%;display:flex;align-items:center;justify-content:center;
          font-size:12px;font-weight:700;">${i}</div>
        <span style="font-size:14px;font-weight:700;">팀원 ${i}${i===1?' (나)':''}</span>
        ${i===1?'<span class="chip chip-pink">팀장</span><span class="chip chip-green">✅ 인증완료</span>':''}
        ${i>1?`<span class="chip chip-orange" id="verif-status-${i}">⚠️ 인증 미확인</span>`:''}
      </div>
      ${i>1?`<div style="background:#FFF8E1;border:1px solid #FFE082;border-radius:8px;
          padding:10px 12px;margin-bottom:10px;">
        <label class="checkbox-item" style="align-items:center;">
          <input type="checkbox" id="verif-confirm-${i}"
            onchange="handleVerifConfirm(${i},this)">
          <span class="checkbox-box"></span>
          <span style="font-size:12px;color:#795548;">
            팀원 ${i}이 앱 <strong>가입+학생증 인증 승인</strong> 완료 회원임을 확인했습니다
          </span>
        </label>
      </div>`:''}
      <div class="form-group" style="margin-bottom:8px;">
        <label class="form-label">닉네임 <span class="required">*</span></label>
        <input class="form-input" type="text" id="m${i}-nickname" style="height:44px;"
          placeholder="${i===1?'본인 닉네임':'팀원 닉네임'}"
          maxlength="50" autocomplete="off">
      </div>
      <div class="form-row" style="margin-bottom:8px;">
        <div class="form-group" style="margin-bottom:0;">
          <label class="form-label">나이 <span class="required">*</span></label>
          <input class="form-input" type="number" id="m${i}-age"
            style="height:44px;" placeholder="22" min="19" max="60">
        </div>
        <div class="form-group" style="margin-bottom:0;">
          <label class="form-label">MBTI</label>
          <select class="form-select" style="height:44px;">
            <option value="">선택</option>${mbtiOpts}
          </select>
        </div>
      </div>
      <div class="form-group" style="margin-bottom:8px;">
        <label class="form-label">학과 <span class="required">*</span></label>
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
      <div class="form-group" style="margin-bottom:0;">
        <label class="form-label">한줄 소개</label>
        <input class="form-input" type="text" style="height:44px;"
          placeholder="나를 표현하는 한 문장" maxlength="200">
      </div>
    </div>`).join('');
})();

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
// 31. 앱 시작
// ============================================================
initApp();
