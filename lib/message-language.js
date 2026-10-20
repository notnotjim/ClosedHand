// The language of the person's latest message, when it can be told for sure,
// so the reply can be told to use it. One Vietnamese question once turned the
// rest of a conversation Vietnamese: English questions after it were answered
// in Vietnamese, because the model copied the conversation instead of the
// message. Only clear cases are named; anything unclear gets the plain rule.
//
// A language counts when the message is written in it, not when it only names
// something in it. "It's called サクラジム 梅田店. Did you search that?" is an
// English question about a Japanese name, and naming Japanese for it got a
// whole reply in Japanese. So each language is read by what holds a sentence
// together: English's small words, Japanese's hiragana (particles and
// endings), Chinese's grammar characters, and for the other scripts more than
// one word, or more of the message than its Latin letters. One language doing
// that is named; none, or two, get the plain rule.
const SCRIPTS = [
  [/[\uac00-\ud7af]/g, "Korean"],
  [/[\u0e00-\u0e7f]/g, "Thai"],
  [/[\u0600-\u06ff]/g, "Arabic"],
  [/[\u0400-\u04ff]/g, "Russian"],
  [/[\u0590-\u05ff]/g, "Hebrew"],
  [/[\u0900-\u097f]/g, "Hindi"],
];
const KANA = /[\u3040-\u30ff]/;
const HIRAGANA = /[\u3040-\u309f]/g;
const HAN = /[\u4e00-\u9fff]/g;
const JAPANESE_CHARS = /[\u3040-\u30ff\u4e00-\u9fff]/g;
// Characters a Chinese sentence is hard to write without, and a name rarely has.
const CHINESE_GRAMMAR = /[的了是吗呢吧么我你他她们这那不没就都也很要会能说]/;
// Letters only Vietnamese uses among the common Latin-script languages.
const VIETNAMESE = /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i;
const ENGLISH_WORDS = new Set("the a an and or but is are was were be been my me i you your it its this that what when where who why how can could would should will do does did to of in on at for with from about please thanks thank hi hello yes no not just any some there here have has had our we they them u ur pls plz thx teh wat wats w tmrw tmr".split(" "));

function messageLanguage(text) {
  const t = String(text || "");
  const count = (re) => (t.match(re) || []).length;
  const latin = count(/[a-z]/gi);
  const written = [];
  if (KANA.test(t)) {
    if (count(HIRAGANA) >= 2 || count(JAPANESE_CHARS) > latin) written.push("Japanese");
  } else if (count(HAN) && (CHINESE_GRAMMAR.test(t) || count(HAN) > latin)) {
    written.push("Chinese");
  }
  for (const [re, name] of SCRIPTS) {
    const runs = t.match(new RegExp(`${re.source}+`, "g")) || [];
    if (runs.length >= 2 || (runs.length && count(re) > latin)) written.push(name);
  }
  // The Latin-script words, read apart from any other script in the message.
  const words = t.toLowerCase().match(/[a-z\u00c0-\u024f\u1e00-\u1eff']+/g) || [];
  const vietnamese = words.filter((w) => VIETNAMESE.test(w)).length;
  if (vietnamese >= 2 && vietnamese / words.length >= 0.3) written.push("Vietnamese");
  else {
    // Accented words are names ("Phở Hùng") or another language ("mañana"):
    // English is read from the rest, while they stay a small share.
    const plain = words.filter((w) => !/[^a-z']/.test(w));
    const english = plain.filter((w) => ENGLISH_WORDS.has(w)).length;
    if (plain.length >= 3 && plain.length * 3 >= words.length * 2 && english >= 2 && english / plain.length >= 0.2) written.push("English");
  }
  return written.length === 1 ? written[0] : null;
}

// The line a reply is given: the language by name when it is clear.
function languageRule(text) {
  const lang = messageLanguage(text);
  return lang
    ? `LANGUAGE: their latest message is in ${lang}. Reply in ${lang}, whatever language earlier messages, names in it or what you find are in.`
    : "LANGUAGE: reply in the language their latest message is written in, whatever language earlier messages, names in it or what you find are in.";
}

module.exports = { messageLanguage, languageRule };
