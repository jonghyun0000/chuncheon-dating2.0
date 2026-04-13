-- 관리자 회원 목록 조회 RLS 수정
-- Supabase SQL Editor에서 실행하세요

-- 기존 users SELECT 정책 제거
DROP POLICY IF EXISTS "u_select_own"   ON users;
DROP POLICY IF EXISTS "u_select_admin" ON users;
DROP POLICY IF EXISTS "users_select_self"  ON users;
DROP POLICY IF EXISTS "users_select_admin" ON users;

-- 본인 + 관리자 조회 (재귀 없이)
CREATE POLICY "u_select_own" ON users
  FOR SELECT USING (auth_id = auth.uid());

-- 관리자 전체 조회 — 재귀 없는 단순 패턴
CREATE POLICY "u_select_admin" ON users
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM users u2
      WHERE u2.auth_id = auth.uid()
        AND u2.role = 'admin'
      LIMIT 1
    )
  );

SELECT 'users RLS 수정 완료' AS result;
