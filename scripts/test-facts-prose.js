const { test } = require('node:test');
const assert = require('node:assert/strict');
const { factsProse } = require('../lib/facts-prose');
test('facts read as grouped sentences with the key as a handle, never as JSON', () => {
  const out = factsProse({
    'person-sayako': { value: "Sayako is James's girlfriend; she is Japanese", category: 'person', subject: 'Sayako', source: 'chat' },
    'profile-name': { value: 'James', category: 'profile', subject: 'James', source: 'setup scan' },
    'profile-company': { value: 'No Strings (Shopify store operator)', category: 'profile', subject: 'James' },
    'boss-email': 'ann@acme.example',
    '_onboarded': { value: '2026-09-09' },
    'flight-VJ646-2026-09-16': { value: '{"airline":"VietJet"}' },
    'pulse_last': { value: 'x' },
  });
  assert.doesNotMatch(out, /[{}"]/, 'no JSON punctuation');
  assert.doesNotMatch(out, /_onboarded|flight-|pulse/, 'internal rows stay out');
  const about = out.indexOf('About the user:'), people = out.indexOf('People in their life:'), other = out.indexOf('Other:');
  assert.ok(about > 0 && people > about && other > people, 'groups in a fixed order');
  assert.match(out, /- Name: James\. \(read from mail by the setup scan\) \[profile-name\]/);
  assert.match(out, /- Company: No Strings \(Shopify store operator\)\. \[profile-company\]/, 'profile facts are labelled by what they are');
  assert.match(out, /- Sayako is James's girlfriend; she is Japanese\. \[person-sayako\]/, 'a value that starts with its subject is not prefixed');
  assert.match(out, /- ann@acme\.example\. \[boss-email\]/, 'a plain string fact still shows');
  assert.equal(factsProse({ _x: 'y' }), '', 'nothing to say gives an empty string');
});
