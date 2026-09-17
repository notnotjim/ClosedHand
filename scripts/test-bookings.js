const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sameBooking, sameFromEmail, findMatch, mergePlan, mergeInto } = require('../lib/booking-identity');

// Four rows that one Da Nang stay grew across three scanner passes and two emails.
const A = 'mailA', B = 'mailB';
const stay1 = { id: '1', kind: 'hotel', provider: 'Airbnb', reference: null, starts_at: '2026-09-15T17:00:00Z', ends_at: '2026-10-07T04:00:00Z', location: 'Ngũ Hành Sơn, Da Nang, Vietnam', source_email_id: A, updated_at: '2026-09-15T10:27:58Z', details: { room: 'Entire home/flat, hosted by Hoan' } };
const stay2 = { id: '2', kind: 'hotel', provider: 'Airbnb', reference: null, starts_at: '2026-09-15T17:00:00Z', ends_at: '2026-10-07T04:00:00Z', location: 'Ngũ Hành Sơn, Vietnam', source_email_id: A, updated_at: '2026-09-17T04:47:34Z', details: {} };
const stay3 = { id: '3', kind: 'hotel', provider: 'Airbnb', reference: '2657823122', starts_at: '2026-09-16T07:00:00Z', ends_at: '2026-10-07T04:00:00Z', location: 'Ngũ Hành Sơn, Da Nang, Vietnam', source_email_id: B, updated_at: '2026-09-16T15:42:29Z', details: { guests: 2 } };
const stay4 = { id: '4', kind: 'hotel', provider: 'Airbnb', reference: null, starts_at: '2026-09-16T08:00:00Z', ends_at: '2026-10-07T04:00:00Z', location: 'Ngũ Hành Sơn, Da Nang, Vietnam', source_email_id: A, updated_at: '2026-09-16T15:47:36Z', details: { guests: 2, check_in_url: 'https://airbnb.com/x' } };

test('the same stay is the same stay however the model words it', () => {
  assert.ok(sameFromEmail(stay1, stay2));
  assert.ok(sameFromEmail(stay1, stay4));
  assert.ok(sameBooking(stay1, stay3), 'a second email about the same nights');
  assert.ok(sameBooking(stay2, stay3), 'even with the city dropped from the place');
  assert.ok(sameBooking({ ...stay1, provider: 'Airbnb (host Hoan)', source_email_id: 'mailD' }, stay3), 'or the host added to the provider');
  assert.equal(sameBooking({ ...stay1, provider: 'Booking.com', source_email_id: 'mailD' }, stay3), false, 'another platform is another booking');
});

test('different bookings stay different', () => {
  const rideA = { kind: 'car', provider: 'Grab', reference: 'A-9RFHKKRGXX4EAV', starts_at: '2026-09-16T11:05:00Z', ends_at: '2026-09-16T11:30:00Z' };
  const rideB = { kind: 'other', provider: 'Grab', reference: 'A-9RGKXEQWX82IAV', starts_at: '2026-09-16T17:08:00Z', ends_at: '2026-09-16T17:11:00Z' };
  assert.equal(sameBooking(rideA, rideB), false, 'two references are two bookings');
  const out = { kind: 'train', provider: 'Avanti', starts_at: '2026-10-01T07:00:00Z', source_email_id: 'rt' };
  const back = { kind: 'train', provider: 'Avanti', starts_at: '2026-10-01T18:00:00Z', source_email_id: 'rt' };
  assert.equal(sameFromEmail(out, back), false, 'a return train is two bookings from one email');
  assert.equal(sameBooking(out, back), false);
  const nextStay = { kind: 'hotel', provider: 'Airbnb', starts_at: '2026-10-07T08:00:00Z', ends_at: '2026-10-14T04:00:00Z', location: 'Hoi An, Vietnam' };
  assert.equal(sameBooking(stay1, nextStay), false, 'the following week somewhere else');
  const dinner1 = { kind: 'restaurant', provider: 'MOI Restaurant', starts_at: '2026-06-18T17:30:00Z', location: '84 Wardour St, London W1F 0TQ' };
  const dinner2 = { kind: 'restaurant', provider: 'MOI Restaurant', starts_at: '2026-06-18T17:30:00Z', location: '84 Wardour Street, London W1F 0TQ' };
  const dinner3 = { kind: 'restaurant', provider: 'MOI Restaurant', starts_at: '2026-06-19T17:30:00Z' };
  assert.ok(sameBooking(dinner1, dinner2));
  assert.equal(sameBooking(dinner1, dinner3), false, 'the next night is another table');
});

test('a fresh extraction updates the row it already has', () => {
  const existing = [stay1, stay3];
  const again = { kind: 'hotel', provider: 'Airbnb', reference: null, starts_at: '2026-09-16T08:00:00Z', ends_at: '2026-10-07T04:00:00Z', location: 'Ngũ Hành Sơn, Vietnam', source_email_id: A, details: { guests: 2 } };
  const hit = findMatch(again, existing);
  assert.equal(hit.id, '1', 'the row from the same email wins');
  const viaB = { kind: 'hotel', provider: 'Airbnb', reference: null, starts_at: '2026-09-16T08:00:00Z', ends_at: '2026-10-07T04:00:00Z', source_email_id: 'mailC' };
  assert.ok(findMatch(viaB, existing), 'a third email about the stay still lands on it');
  const merged = mergeInto(again, stay1);
  assert.equal(merged.details.room, 'Entire home/flat, hosted by Hoan', 'details learned earlier are kept');
  assert.equal(merged.details.guests, 2);
  const withRef = mergeInto({ ...again, reference: null }, stay3);
  assert.equal(withRef.reference, '2657823122', 'a reference is never lost');
});

test('two bookings from one email claim two rows', () => {
  const out = { id: 'o', kind: 'train', provider: 'Avanti', starts_at: '2026-10-01T07:00:00Z', source_email_id: 'rt' };
  const back = { id: 'b', kind: 'train', provider: 'Avanti', starts_at: '2026-10-01T18:00:00Z', source_email_id: 'rt' };
  const claimed = new Set();
  const h1 = findMatch({ ...out, id: undefined, starts_at: '2026-10-01T07:05:00Z' }, [out, back], claimed);
  assert.equal(h1.id, 'o'); claimed.add(h1.id);
  const h2 = findMatch({ ...back, id: undefined, starts_at: '2026-10-01T18:05:00Z' }, [out, back], claimed);
  assert.equal(h2.id, 'b');
});

test('existing duplicates merge down to the row with the reference', () => {
  const plan = mergePlan([stay1, stay2, stay3, stay4]);
  assert.deepEqual(plan.drop.sort(), ['1', '2', '4']);
  assert.equal(plan.keep.length, 1);
  assert.equal(plan.keep[0].id, '3');
  assert.equal(plan.keep[0].patch.reference, '2657823122');
  assert.equal(plan.keep[0].patch.details.check_in_url, 'https://airbnb.com/x', 'details from the dropped rows survive');
  assert.equal(plan.keep[0].patch.details.room, 'Entire home/flat, hosted by Hoan');
  const none = mergePlan([stay3, { id: 'r', kind: 'car', provider: 'Grab', reference: 'X1', starts_at: '2026-09-16T11:05:00Z', ends_at: '2026-09-16T11:30:00Z' }]);
  assert.deepEqual(none, { keep: [], drop: [] });
});
