-- ====================================================================
-- 춘천 과팅 — Schema v2.2 (1번 기반 / 완전 재실행용)
-- 목적:
-- 1) 기존 충돌 테이블/정책 제거
-- 2) relation "users" does not exist 오류 방지
-- 3) column "is_visible" does not exist 오류 방지
-- 4) 원본 1번의 보안 구조 최대한 유지
-- ====================================================================

-- ====================================================================
-- STEP -2. 기존 RLS 정책 삭제
-- ====================================================================
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname IN ('public', 'storage')
  LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON %I.%I',
      r.policyname,
      r.schemaname,
      r.tablename
    );
  END LOOP;
END $$;

-- ====================================================================
-- STEP -1. 기존 테이블 완전 삭제 (개발 단계용)
-- 운영 중이면 데이터 백업 후 사용
-- ====================================================================
DROP TABLE IF EXISTS admin_logs CASCADE;
DROP TABLE IF EXISTS reports CASCADE;
DROP TABLE IF EXISTS messages CASCADE;
DROP TABLE IF EXISTS matches CASCADE;
DROP TABLE IF EXISTS match_requests CASCADE;
DROP TABLE IF EXISTS team_members CASCADE;
DROP TABLE IF EXISTS teams CASCADE;
DROP TABLE IF EXISTS deposits CASCADE;
DROP TABLE IF EXISTS student_verifications CASCADE;
DROP TABLE IF EXISTS terms_consents CASCADE;
DROP TABLE IF EXISTS users CASCADE;

-- 함수도 정리
DROP FUNCTION IF EXISTS update_updated_at() CASCADE;
DROP FUNCTION IF EXISTS get_my_user_id() CASCADE;
DROP FUNCTION IF EXISTS is_admin() CASCADE;
DROP FUNCTION IF EXISTS log_admin_action(TEXT, TEXT, UUID, JSONB) CASCADE;
DROP FUNCTION IF EXISTS enforce_team_member_limit() CASCADE;
DROP FUNCTION IF EXISTS auto_activate_profile() CASCADE;
DROP FUNCTION IF EXISTS schedule_image_deletion() CASCADE;

-- ====================================================================
-- STEP 0. 확장
-- ====================================================================
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ====================================================================
-- STEP 1. 테이블 생성
-- ====================================================================

-- 1-1. users
CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_id         UUID UNIQUE,
  username        VARCHAR(50) UNIQUE NOT NULL
                    CHECK (username ~ '^[a-zA-Z0-9_]{4,20}$'),
  nickname        VARCHAR(50) NOT NULL
                    CHECK (char_length(nickname) BETWEEN 2 AND 20),
  gender          VARCHAR(10) NOT NULL
                    CHECK (gender IN ('male','female')),
  role            VARCHAR(10) NOT NULL DEFAULT 'user'
                    CHECK (role IN ('user','admin')),
  university      VARCHAR(20) NOT NULL
                    CHECK (university IN ('강원대학교','한림대학교','성심대학교')),
  department      VARCHAR(100) NOT NULL
                    CHECK (char_length(department) >= 2),
  student_number  VARCHAR(20) NOT NULL
                    CHECK (char_length(student_number) >= 6),
  birth_year      SMALLINT NOT NULL
                    CHECK (birth_year BETWEEN 1970 AND 2006),
  smoking         BOOLEAN NOT NULL DEFAULT FALSE,
  mbti            VARCHAR(4)
                    CHECK (
                      mbti IS NULL OR mbti IN (
                        'INTJ','INTP','ENTJ','ENTP','INFJ','INFP','ENFJ','ENFP',
                        'ISTJ','ISFJ','ESTJ','ESFJ','ISTP','ISFP','ESTP','ESFP'
                      )
                    ),
  bio             TEXT
                    CHECK (bio IS NULL OR char_length(bio) <= 500),
  kakao_id        VARCHAR(200),
  profile_active  BOOLEAN NOT NULL DEFAULT FALSE,
  is_banned       BOOLEAN NOT NULL DEFAULT FALSE,
  marketing_agree BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ
);

CREATE INDEX idx_users_auth_id
  ON users(auth_id);
CREATE INDEX idx_users_username
  ON users(username);
CREATE INDEX idx_users_gender
  ON users(gender);
CREATE INDEX idx_users_active
  ON users(profile_active) WHERE deleted_at IS NULL;

-- 1-2. terms_consents
CREATE TABLE terms_consents (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  terms_version      VARCHAR(20) NOT NULL DEFAULT '1.0',
  is_adult           BOOLEAN NOT NULL CHECK (is_adult = TRUE),
  terms_agree        BOOLEAN NOT NULL CHECK (terms_agree = TRUE),
  privacy_agree      BOOLEAN NOT NULL CHECK (privacy_agree = TRUE),
  verification_agree BOOLEAN NOT NULL CHECK (verification_agree = TRUE),
  deposit_agree      BOOLEAN NOT NULL CHECK (deposit_agree = TRUE),
  falsify_agree      BOOLEAN NOT NULL CHECK (falsify_agree = TRUE),
  marketing_agree    BOOLEAN NOT NULL DEFAULT FALSE,
  ip_address         TEXT,
  consented_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_consents_user
  ON terms_consents(user_id);

-- 1-3. student_verifications
CREATE TABLE student_verifications (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  image_path     TEXT NOT NULL CHECK (char_length(image_path) > 5),
  status         VARCHAR(20) NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','approved','rejected')),
  reject_reason  TEXT,
  reviewed_by    UUID REFERENCES users(id),
  reviewed_at    TIMESTAMPTZ,
  auto_delete_at TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_verif_status
  ON student_verifications(status);

-- 1-4. deposits
CREATE TABLE deposits (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  depositor_name VARCHAR(50) NOT NULL CHECK (char_length(depositor_name) >= 2),
  amount         INTEGER NOT NULL CHECK (amount IN (1000, 3000)),
  status         VARCHAR(30) NOT NULL DEFAULT 'pending_confirm'
                   CHECK (status IN ('pending_deposit','pending_confirm','confirmed','rejected')),
  reject_reason  TEXT,
  confirmed_by   UUID REFERENCES users(id),
  confirmed_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_deposits_status
  ON deposits(status);

-- 1-5. teams
CREATE TABLE teams (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  leader_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  gender          VARCHAR(10) NOT NULL CHECK (gender IN ('male','female')),
  title           VARCHAR(100) NOT NULL CHECK (char_length(title) >= 2),
  university      VARCHAR(20) NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'recruiting'
                    CHECK (status IN ('recruiting','matched','closed','hidden')),
  kakao_open_link TEXT
                    CHECK (kakao_open_link IS NULL OR kakao_open_link ~ '^https://'),
  is_visible      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_teams_gender
  ON teams(gender, status) WHERE is_visible = TRUE;
CREATE INDEX idx_teams_leader_id
  ON teams(leader_id);

-- 1-6. team_members
CREATE TABLE team_members (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id    UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id    UUID REFERENCES users(id),
  nickname   VARCHAR(50) NOT NULL CHECK (char_length(nickname) >= 1),
  age        SMALLINT NOT NULL CHECK (age BETWEEN 19 AND 60),
  department VARCHAR(100) NOT NULL,
  smoking    BOOLEAN NOT NULL DEFAULT FALSE,
  mbti       VARCHAR(4)
               CHECK (
                 mbti IS NULL OR mbti IN (
                   'INTJ','INTP','ENTJ','ENTP','INFJ','INFP','ENFJ','ENFP',
                   'ISTJ','ISFJ','ESTJ','ESFJ','ISTP','ISFP','ESTP','ESFP'
                 )
               ),
  intro      TEXT CHECK (intro IS NULL OR char_length(intro) <= 200),
  is_leader  BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order SMALLINT NOT NULL DEFAULT 0 CHECK (sort_order IN (0,1,2)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_team_members_team
  ON team_members(team_id);

-- 1-7. match_requests
CREATE TABLE match_requests (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  female_team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  male_team_id   UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  status         VARCHAR(20) NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','reviewing','accepted','rejected','matched','expired')),
  message        TEXT CHECK (message IS NULL OR char_length(message) <= 500),
  reject_reason  TEXT,
  responded_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(female_team_id, male_team_id),
  CHECK (female_team_id <> male_team_id)
);

CREATE INDEX idx_match_req_female
  ON match_requests(female_team_id);
CREATE INDEX idx_match_req_male
  ON match_requests(male_team_id);
CREATE INDEX idx_match_req_status
  ON match_requests(status);

-- 1-8. matches
CREATE TABLE matches (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_request_id UUID NOT NULL REFERENCES match_requests(id),
  female_team_id   UUID NOT NULL REFERENCES teams(id),
  male_team_id     UUID NOT NULL REFERENCES teams(id),
  status           VARCHAR(20) NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','ended','reported')),
  kakao_shared_at  TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_matches_female
  ON matches(female_team_id);
CREATE INDEX idx_matches_male
  ON matches(male_team_id);

-- 1-9. messages
CREATE TABLE messages (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_request_id UUID NOT NULL REFERENCES match_requests(id) ON DELETE CASCADE,
  sender_team_id   UUID NOT NULL REFERENCES teams(id),
  sender_user_id   UUID NOT NULL REFERENCES users(id),
  content          TEXT NOT NULL CHECK (char_length(content) BETWEEN 1 AND 500),
  is_deleted       BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_messages_req
  ON messages(match_request_id, created_at);

-- 1-10. reports
CREATE TABLE reports (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id       UUID NOT NULL REFERENCES users(id),
  target_user_id    UUID REFERENCES users(id),
  target_team_id    UUID REFERENCES teams(id),
  target_message_id UUID REFERENCES messages(id),
  report_type       VARCHAR(30) NOT NULL
                      CHECK (report_type IN ('fake_profile','abuse','harassment','spam','other')),
  description       TEXT NOT NULL CHECK (char_length(description) >= 5),
  status            VARCHAR(20) NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','reviewing','resolved','dismissed')),
  admin_note        TEXT,
  resolved_by       UUID REFERENCES users(id),
  resolved_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    target_user_id IS NOT NULL
    OR target_team_id IS NOT NULL
    OR target_message_id IS NOT NULL
  )
);

CREATE INDEX idx_reports_reporter
  ON reports(reporter_id);
CREATE INDEX idx_reports_target
  ON reports(target_user_id);
CREATE INDEX idx_reports_status
  ON reports(status);

-- 1-11. admin_logs
CREATE TABLE admin_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id    UUID NOT NULL REFERENCES users(id),
  action      VARCHAR(100) NOT NULL,
  target_type VARCHAR(50),
  target_id   UUID,
  detail      JSONB,
  ip_address  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_admin_logs_admin
  ON admin_logs(admin_id);
CREATE INDEX idx_admin_logs_created
  ON admin_logs(created_at DESC);

-- ====================================================================
-- STEP 2. 함수 생성
-- ====================================================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION get_my_user_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT id
  FROM users
  WHERE auth_id = auth.uid()
    AND deleted_at IS NULL
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION is_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM users
    WHERE auth_id = auth.uid()
      AND role = 'admin'
      AND is_banned = FALSE
      AND deleted_at IS NULL
  );
$$;

CREATE OR REPLACE FUNCTION log_admin_action(
  p_action      TEXT,
  p_target_type TEXT,
  p_target_id   UUID,
  p_detail      JSONB DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_admin_id UUID;
BEGIN
  SELECT id INTO v_admin_id
  FROM users
  WHERE auth_id = auth.uid()
    AND role = 'admin'
    AND deleted_at IS NULL
  LIMIT 1;

  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION '관리자 권한이 없습니다.';
  END IF;

  INSERT INTO admin_logs(admin_id, action, target_type, target_id, detail)
  VALUES (v_admin_id, p_action, p_target_type, p_target_id, p_detail);
END;
$$;

CREATE OR REPLACE FUNCTION enforce_team_member_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (SELECT COUNT(*) FROM team_members WHERE team_id = NEW.team_id) >= 3 THEN
    RAISE EXCEPTION '팀원은 최대 3명까지 등록 가능합니다.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION auto_activate_profile()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_uid UUID := NEW.user_id;
  v_verif TEXT;
  v_deposit TEXT;
BEGIN
  SELECT status INTO v_verif
  FROM student_verifications
  WHERE user_id = v_uid;

  SELECT status INTO v_deposit
  FROM deposits
  WHERE user_id = v_uid;

  IF v_verif = 'approved' AND v_deposit = 'confirmed' THEN
    UPDATE users
    SET profile_active = TRUE
    WHERE id = v_uid
      AND deleted_at IS NULL;
  ELSIF v_verif = 'rejected' OR v_deposit = 'rejected' THEN
    UPDATE users
    SET profile_active = FALSE
    WHERE id = v_uid
      AND deleted_at IS NULL;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION schedule_image_deletion()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'approved' AND (OLD.status IS DISTINCT FROM 'approved') THEN
    UPDATE student_verifications
    SET auto_delete_at = NOW() + INTERVAL '30 days'
    WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

-- ====================================================================
-- STEP 3. 트리거 생성
-- ====================================================================

CREATE TRIGGER trg_users_upd
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_verif_upd
BEFORE UPDATE ON student_verifications
FOR EACH ROW
EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_deposits_upd
BEFORE UPDATE ON deposits
FOR EACH ROW
EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_teams_upd
BEFORE UPDATE ON teams
FOR EACH ROW
EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_match_req_upd
BEFORE UPDATE ON match_requests
FOR EACH ROW
EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_team_member_limit
BEFORE INSERT ON team_members
FOR EACH ROW
EXECUTE FUNCTION enforce_team_member_limit();

CREATE TRIGGER trg_activate_on_verif
AFTER UPDATE OF status ON student_verifications
FOR EACH ROW
EXECUTE FUNCTION auto_activate_profile();

CREATE TRIGGER trg_activate_on_deposit
AFTER UPDATE OF status ON deposits
FOR EACH ROW
EXECUTE FUNCTION auto_activate_profile();

CREATE TRIGGER trg_schedule_deletion
AFTER UPDATE OF status ON student_verifications
FOR EACH ROW
EXECUTE FUNCTION schedule_image_deletion();

-- ====================================================================
-- STEP 4. RLS 활성화
-- ====================================================================

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;

ALTER TABLE terms_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE terms_consents FORCE ROW LEVEL SECURITY;

ALTER TABLE student_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_verifications FORCE ROW LEVEL SECURITY;

ALTER TABLE deposits ENABLE ROW LEVEL SECURITY;
ALTER TABLE deposits FORCE ROW LEVEL SECURITY;

ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams FORCE ROW LEVEL SECURITY;

ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_members FORCE ROW LEVEL SECURITY;

ALTER TABLE match_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE match_requests FORCE ROW LEVEL SECURITY;

ALTER TABLE matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE matches FORCE ROW LEVEL SECURITY;

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages FORCE ROW LEVEL SECURITY;

ALTER TABLE reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports FORCE ROW LEVEL SECURITY;

ALTER TABLE admin_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_logs FORCE ROW LEVEL SECURITY;

-- ====================================================================
-- STEP 5. RLS 정책
-- ====================================================================

-- users
CREATE POLICY "u_select_own"
  ON users FOR SELECT
  USING (auth_id = auth.uid());

CREATE POLICY "u_select_admin"
  ON users FOR SELECT
  USING (is_admin());

CREATE POLICY "u_insert_self"
  ON users FOR INSERT
  WITH CHECK (auth_id = auth.uid());

CREATE POLICY "u_update_own"
  ON users FOR UPDATE
  USING (auth_id = auth.uid())
  WITH CHECK (
    role = (SELECT u.role FROM users u WHERE u.auth_id = auth.uid() LIMIT 1)
    AND is_banned = (SELECT u.is_banned FROM users u WHERE u.auth_id = auth.uid() LIMIT 1)
  );

CREATE POLICY "u_update_admin"
  ON users FOR UPDATE
  USING (is_admin());

CREATE POLICY "u_delete_own"
  ON users FOR DELETE
  USING (auth_id = auth.uid());

-- terms_consents
CREATE POLICY "tc_select_own"
  ON terms_consents FOR SELECT
  USING (user_id = get_my_user_id());

CREATE POLICY "tc_select_admin"
  ON terms_consents FOR SELECT
  USING (is_admin());

CREATE POLICY "tc_insert_own"
  ON terms_consents FOR INSERT
  WITH CHECK (user_id = get_my_user_id());

-- student_verifications
CREATE POLICY "sv_select_own"
  ON student_verifications FOR SELECT
  USING (user_id = get_my_user_id());

CREATE POLICY "sv_select_admin"
  ON student_verifications FOR SELECT
  USING (is_admin());

CREATE POLICY "sv_insert_own"
  ON student_verifications FOR INSERT
  WITH CHECK (user_id = get_my_user_id());

CREATE POLICY "sv_update_admin"
  ON student_verifications FOR UPDATE
  USING (is_admin());

-- deposits
CREATE POLICY "dep_select_own"
  ON deposits FOR SELECT
  USING (user_id = get_my_user_id());

CREATE POLICY "dep_select_admin"
  ON deposits FOR SELECT
  USING (is_admin());

CREATE POLICY "dep_insert_own"
  ON deposits FOR INSERT
  WITH CHECK (
    user_id = get_my_user_id()
    AND (
      (amount = 3000 AND (SELECT gender FROM users WHERE id = user_id) = 'male')
      OR
      (amount = 1000 AND (SELECT gender FROM users WHERE id = user_id) = 'female')
    )
  );

CREATE POLICY "dep_update_admin"
  ON deposits FOR UPDATE
  USING (is_admin());

-- teams
CREATE POLICY "t_select_public"
  ON teams FOR SELECT
  USING (
    (is_visible = TRUE AND status = 'recruiting')
    OR leader_id = get_my_user_id()
    OR is_admin()
  );

CREATE POLICY "t_insert_active"
  ON teams FOR INSERT
  WITH CHECK (
    leader_id = get_my_user_id()
    AND (SELECT profile_active FROM users WHERE id = leader_id) = TRUE
  );

CREATE POLICY "t_update_leader_admin"
  ON teams FOR UPDATE
  USING (leader_id = get_my_user_id() OR is_admin());

CREATE POLICY "t_delete_leader_admin"
  ON teams FOR DELETE
  USING (leader_id = get_my_user_id() OR is_admin());

-- team_members
CREATE POLICY "tm_select_relevant"
  ON team_members FOR SELECT
  USING (
    team_id IN (
      SELECT id FROM teams
      WHERE is_visible = TRUE
        AND status = 'recruiting'
    )
    OR team_id IN (
      SELECT id FROM teams
      WHERE leader_id = get_my_user_id()
    )
    OR is_admin()
  );

CREATE POLICY "tm_insert_leader"
  ON team_members FOR INSERT
  WITH CHECK (
    team_id IN (
      SELECT id FROM teams
      WHERE leader_id = get_my_user_id()
    )
  );

CREATE POLICY "tm_update_leader_admin"
  ON team_members FOR UPDATE
  USING (
    team_id IN (
      SELECT id FROM teams
      WHERE leader_id = get_my_user_id()
    )
    OR is_admin()
  );

CREATE POLICY "tm_delete_leader_admin"
  ON team_members FOR DELETE
  USING (
    team_id IN (
      SELECT id FROM teams
      WHERE leader_id = get_my_user_id()
    )
    OR is_admin()
  );

-- match_requests
CREATE POLICY "mr_select_involved"
  ON match_requests FOR SELECT
  USING (
    female_team_id IN (SELECT id FROM teams WHERE leader_id = get_my_user_id())
    OR male_team_id IN (SELECT id FROM teams WHERE leader_id = get_my_user_id())
    OR is_admin()
  );

CREATE POLICY "mr_insert_female_active"
  ON match_requests FOR INSERT
  WITH CHECK (
    female_team_id IN (
      SELECT t.id
      FROM teams t
      JOIN users u ON u.id = t.leader_id
      WHERE u.auth_id = auth.uid()
        AND u.gender = 'female'
        AND u.profile_active = TRUE
    )
  );

CREATE POLICY "mr_update_male_admin"
  ON match_requests FOR UPDATE
  USING (
    male_team_id IN (SELECT id FROM teams WHERE leader_id = get_my_user_id())
    OR is_admin()
  );

-- matches
CREATE POLICY "m_select_involved"
  ON matches FOR SELECT
  USING (
    female_team_id IN (SELECT id FROM teams WHERE leader_id = get_my_user_id())
    OR male_team_id IN (SELECT id FROM teams WHERE leader_id = get_my_user_id())
    OR is_admin()
  );

CREATE POLICY "m_insert_admin"
  ON matches FOR INSERT
  WITH CHECK (is_admin());

CREATE POLICY "m_update_admin"
  ON matches FOR UPDATE
  USING (is_admin());

-- messages
CREATE POLICY "msg_select_involved"
  ON messages FOR SELECT
  USING (
    match_request_id IN (
      SELECT id
      FROM match_requests
      WHERE female_team_id IN (SELECT id FROM teams WHERE leader_id = get_my_user_id())
         OR male_team_id   IN (SELECT id FROM teams WHERE leader_id = get_my_user_id())
    )
    OR is_admin()
  );

CREATE POLICY "msg_insert_involved"
  ON messages FOR INSERT
  WITH CHECK (
    match_request_id IN (
      SELECT id
      FROM match_requests
      WHERE female_team_id IN (SELECT id FROM teams WHERE leader_id = get_my_user_id())
         OR male_team_id   IN (SELECT id FROM teams WHERE leader_id = get_my_user_id())
    )
    AND sender_user_id = get_my_user_id()
  );

CREATE POLICY "msg_update_sender_admin"
  ON messages FOR UPDATE
  USING (sender_user_id = get_my_user_id() OR is_admin());

-- reports
CREATE POLICY "r_select_own"
  ON reports FOR SELECT
  USING (reporter_id = get_my_user_id());

CREATE POLICY "r_select_admin"
  ON reports FOR SELECT
  USING (is_admin());

CREATE POLICY "r_insert_auth"
  ON reports FOR INSERT
  WITH CHECK (
    reporter_id = get_my_user_id()
    AND get_my_user_id() IS NOT NULL
  );

CREATE POLICY "r_update_admin"
  ON reports FOR UPDATE
  USING (is_admin());

-- admin_logs
CREATE POLICY "al_select_admin"
  ON admin_logs FOR SELECT
  USING (is_admin());

CREATE POLICY "al_insert_admin"
  ON admin_logs FOR INSERT
  WITH CHECK (is_admin());

-- ====================================================================
-- STEP 6. Storage 버킷 + 정책
-- ====================================================================

INSERT INTO storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
VALUES (
  'student-verifications',
  'student-verifications',
  false,
  10485760,
  ARRAY['image/jpeg','image/png','image/webp']
)
ON CONFLICT (id) DO NOTHING;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
  LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON storage.objects',
      r.policyname
    );
  END LOOP;
END $$;

CREATE POLICY "sto_upload_own_folder"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'student-verifications'
    AND auth.uid() IS NOT NULL
    AND (string_to_array(name, '/'))[1] = 'verifications'
    AND (string_to_array(name, '/'))[2] = auth.uid()::text
  );

CREATE POLICY "sto_select_own"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'student-verifications'
    AND (string_to_array(name, '/'))[2] = auth.uid()::text
  );

CREATE POLICY "sto_select_admin"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'student-verifications'
    AND is_admin()
  );

CREATE POLICY "sto_delete_own"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'student-verifications'
    AND (string_to_array(name, '/'))[2] = auth.uid()::text
  );

CREATE POLICY "sto_delete_admin"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'student-verifications'
    AND is_admin()
  );

-- ====================================================================
-- STEP 7. 관리자 계정 생성 가이드
-- ====================================================================
/*
1. Supabase Dashboard -> Authentication -> Users -> Add user
2. 생성된 auth user UUID 확인
3. 아래 INSERT 실행

INSERT INTO users(
  auth_id,
  username,
  nickname,
  gender,
  role,
  university,
  department,
  student_number,
  birth_year,
  profile_active
) VALUES (
  'AUTH_UUID_HERE',
  'john1217',
  '관리자',
  'male',
  'admin',
  '강원대학교',
  '운영팀',
  '00000000',
  1990,
  TRUE
);
*/