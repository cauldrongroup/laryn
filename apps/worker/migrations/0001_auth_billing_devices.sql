CREATE TABLE IF NOT EXISTS "user" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL UNIQUE,
  "emailVerified" INTEGER NOT NULL DEFAULT 0,
  "image" TEXT,
  "createdAt" INTEGER NOT NULL,
  "updatedAt" INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS "session" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "expiresAt" INTEGER NOT NULL,
  "token" TEXT NOT NULL UNIQUE,
  "createdAt" INTEGER NOT NULL,
  "updatedAt" INTEGER NOT NULL,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "account" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "accountId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "accessToken" TEXT,
  "refreshToken" TEXT,
  "idToken" TEXT,
  "accessTokenExpiresAt" INTEGER,
  "refreshTokenExpiresAt" INTEGER,
  "scope" TEXT,
  "password" TEXT,
  "createdAt" INTEGER NOT NULL,
  "updatedAt" INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS "verification" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "identifier" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "expiresAt" INTEGER NOT NULL,
  "createdAt" INTEGER,
  "updatedAt" INTEGER
);

CREATE TABLE IF NOT EXISTS "billing_profiles" (
  "user_id" TEXT PRIMARY KEY NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "polar_customer_id" TEXT,
  "polar_external_id" TEXT,
  "subscription_status" TEXT NOT NULL DEFAULT 'unknown',
  "current_period_end" TEXT,
  "pro_active" INTEGER NOT NULL DEFAULT 0,
  "last_polar_event_id" TEXT,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "desktop_devices" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "user_id" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "device_name" TEXT NOT NULL,
  "token_hash" TEXT NOT NULL UNIQUE,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TEXT,
  "revoked_at" TEXT
);

CREATE TABLE IF NOT EXISTS "device_authorization_codes" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "user_code" TEXT NOT NULL UNIQUE,
  "device_code_hash" TEXT NOT NULL UNIQUE,
  "expires_at" TEXT NOT NULL,
  "approved_user_id" TEXT REFERENCES "user"("id") ON DELETE CASCADE,
  "consumed_at" TEXT,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "usage_events" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "user_id" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "device_id" TEXT REFERENCES "desktop_devices"("id") ON DELETE SET NULL,
  "event_type" TEXT NOT NULL,
  "audio_bytes" INTEGER NOT NULL DEFAULT 0,
  "duration_ms" INTEGER NOT NULL DEFAULT 0,
  "cleanup_tier" TEXT,
  "transcription_provider" TEXT,
  "transcription_model" TEXT,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "idx_desktop_devices_user_id" ON "desktop_devices" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_desktop_devices_token_hash" ON "desktop_devices" ("token_hash");
CREATE INDEX IF NOT EXISTS "idx_device_authorization_codes_user_code" ON "device_authorization_codes" ("user_code");
CREATE INDEX IF NOT EXISTS "idx_device_authorization_codes_hash" ON "device_authorization_codes" ("device_code_hash");
CREATE INDEX IF NOT EXISTS "idx_usage_events_user_id" ON "usage_events" ("user_id");
