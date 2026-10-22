// Mock-only checks: MiMo balance source labelling. No network, no credentials, no real account.
import test from 'node:test';
import assert from 'node:assert/strict';
import {sanitizeUsage} from '../scripts/usage-metadata.mjs';

const now = Date.parse('2026-10-21T12:00:00Z');
const iso = ms => new Date(ms).toISOString();
const input = over => ({display_schema_version: 1, view_read_at: iso(now), cards: [{provider: 'mimo', status: 'available', account_alignment: 'verified',
  collected_at: iso(now), last_success_collected_at: iso(now), stale_after_seconds: 3600, balance: {amount: 12.34, currency: 'USD', observed_at: iso(now)}, last_known_balance: null, ...over}]});
const mimo = over => sanitizeUsage(input(over), now).cards[0];

test('official and manual sources are kept and labelled; unspecified source is "unconfirmed" but not hidden', () => {
  assert.equal(mimo({balance_source: 'official_api'}).balance_source, 'official_api');
  assert.equal(mimo({balance_source: 'console_manual'}).balance.amount, 12.34);
  assert.equal(mimo({balance_source: 'mock'}).balance_source, 'mock');
  assert.equal(mimo({}).balance_source, 'unconfirmed');
  assert.equal(mimo({balance_source: 'something_else'}).balance_source, 'unconfirmed');
});

test('a usage-based estimate is never shown as a balance', () => {
  const card = mimo({balance_source: 'estimate_from_usage', last_known_balance: {amount: 5, currency: 'USD', observed_at: iso(now - 1000)}});
  assert.equal(card.balance_source, 'estimate_rejected');
  assert.equal(card.balance, null);
  assert.equal(card.last_known_balance, null);
  assert.deepEqual(card.current_rows, []);
});

test('failure and missing data never become 0 or an invented balance', () => {
  for (const over of [{status: 'fetch_failed', balance: null}, {status: 'unconfirmed', balance: null}, {balance: {amount: null, currency: 'USD'}}, {balance: {amount: '0', currency: 'USD'}}]) {
    const card = mimo({balance_source: 'official_api', ...over});
    assert.equal(card.balance, null, JSON.stringify(over));
  }
  const stale = mimo({balance_source: 'official_api'});
  assert.equal(stale.balance.stale, false);
  const old = sanitizeUsage(input({balance_source: 'official_api'}), now + 2 * 3600 * 1000).cards[0];
  assert.equal(old.balance.stale, true, 'old data is flagged stale, not presented as current');
});

test('the sanitized card carries only an official documentation URL and no credential-like fields', () => {
  const card = mimo({balance_source: 'official_api', api_key: 'sk-SYNTHETIC', authorization: 'Bearer SYNTHETIC', token: 'SYNTHETIC'});
  assert.match(card.official_docs_url, /^https:\/\/mimo\.mi\.com\//);
  assert.doesNotMatch(JSON.stringify(card), /SYNTHETIC|api_key|authorization|token/i);
});
