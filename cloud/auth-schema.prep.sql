-- PREPARATION ONLY. NOT EXECUTED. NOT primary-source verified.
-- Better Auth 1.7.7 core tables for PostgreSQL (user, session, account, verification), written from general knowledge of the
-- library's core schema. The official docs page (concepts/database) names the four tables and the account identity pair
-- (providerId + accountId) but does NOT render the column lists in the text that was fetched, so every column below is UNVERIFIED.
-- FIELD COVERAGE CHECKED against the official docs core-schema field list (as retrieved by Codex; docs concepts/database#core-schema):
--   user(id,name,email,emailVerified,image,createdAt,updatedAt); session(id,userId,token,expiresAt,ipAddress,userAgent,createdAt,updatedAt);
--   account(id,userId,accountId,providerId,accessToken,refreshToken,accessTokenExpiresAt,refreshTokenExpiresAt,scope,idToken,password,createdAt,updatedAt);
--   verification(id,identifier,value,expiresAt,createdAt,updatedAt).  Every listed field is present below; no missing/extra column was found.
-- NOT verified: column TYPES/NULLability/UNIQUE/foreign-key constraints, the SQL that the exact 1.7.7 release would generate, and any runtime behaviour.
-- The three indexes at the bottom are additions of this draft, not part of the documented list. UNEXECUTED - do not apply.
-- Before applying anything, a human must generate the authoritative schema for the pinned version and diff it against this file:
--     npx auth@latest generate      (documented command; not run here)
-- or apply it with the library migrator (documented):  npx auth@latest migrate   (not run here)
-- Use a dedicated role/database for this dashboard (Neon Free). Do not put secrets or real data in this file.
-- Quoted camelCase identifiers follow the library's default field names (unverified).
begin;
create table if not exists "user" (
  "id" text not null primary key,
  "name" text not null,
  "email" text not null unique,
  "emailVerified" boolean not null,
  "image" text,
  "createdAt" timestamptz not null default current_timestamp,
  "updatedAt" timestamptz not null default current_timestamp
);
create table if not exists "session" (
  "id" text not null primary key,
  "expiresAt" timestamptz not null,
  "token" text not null unique,
  "createdAt" timestamptz not null default current_timestamp,
  "updatedAt" timestamptz not null,
  "ipAddress" text,
  "userAgent" text,
  "userId" text not null references "user" ("id") on delete cascade
);
create table if not exists "account" (
  "id" text not null primary key,
  "accountId" text not null,
  "providerId" text not null,
  "userId" text not null references "user" ("id") on delete cascade,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  "scope" text,
  "password" text,
  "createdAt" timestamptz not null default current_timestamp,
  "updatedAt" timestamptz not null
);
create table if not exists "verification" (
  "id" text not null primary key,
  "identifier" text not null,
  "value" text not null,
  "expiresAt" timestamptz not null,
  "createdAt" timestamptz not null default current_timestamp,
  "updatedAt" timestamptz not null default current_timestamp
);
create index if not exists "session_userId_idx" on "session" ("userId");
create index if not exists "account_userId_idx" on "account" ("userId");
create index if not exists "verification_identifier_idx" on "verification" ("identifier");
commit;
-- Note: the "account" table stores provider tokens (accessToken/refreshToken/idToken) for signed-in accounts. This dashboard
-- only needs the sign-in identity; restrict the Vercel App to the minimum scopes and to "Members of the team" (human-owned setting).
