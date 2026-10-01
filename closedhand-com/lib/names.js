// Personal URL names. A new address gets two ordinary words and a number,
// like amber-fox-42: nothing from the owner's name or account, so the
// address says nothing about who they are. They can change it in Settings.
const crypto = require('node:crypto');

// Short, neutral words that read well in any pairing. No colours or animals
// that pair into an insult, and nothing with a second meaning.
const FIRST = ['amber', 'azure', 'brisk', 'bright', 'calm', 'clear', 'coral', 'crisp', 'fresh', 'gentle',
  'golden', 'hazel', 'ivory', 'jade', 'keen', 'lively', 'lunar', 'mellow', 'merry', 'misty',
  'noble', 'polar', 'quiet', 'rapid', 'silver', 'snowy', 'solar', 'steady', 'sunny', 'swift',
  'tidy', 'velvet', 'vivid', 'warm'];
const SECOND = ['birch', 'brook', 'cedar', 'cloud', 'comet', 'crane', 'dune', 'falcon', 'fern', 'finch',
  'fox', 'glade', 'grove', 'harbor', 'hare', 'heron', 'isle', 'kestrel', 'lark', 'lynx',
  'maple', 'meadow', 'otter', 'owl', 'pebble', 'reef', 'ridge', 'river', 'robin', 'sparrow',
  'summit', 'swan', 'tide', 'willow', 'wren'];

// Two words and a number from 2 to 99.
function randomName(pick = crypto.randomInt) {
  return FIRST[pick(FIRST.length)] + '-' + SECOND[pick(SECOND.length)] + '-' + (2 + pick(98));
}

// Whatever someone types as a new name, tidied into one an address can use:
// lower case, accents dropped, spaces and dots turned into hyphens, anything
// else removed. It starts with a letter and is at most 32 characters. The
// result still needs checking, since it can be too short or reserved.
function cleanName(value) {
  return String(value || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[\s._]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-')
    .replace(/^[^a-z]+/, '').slice(0, 32).replace(/-+$/, '');
}

module.exports = { randomName, cleanName, FIRST, SECOND };
