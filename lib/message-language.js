// The language of the person's latest message, when it can be told for sure,
// so the reply can be told to use it. One Vietnamese question once turned the
// rest of a conversation Vietnamese: English questions after it were answered
// in Vietnamese, because the model copied the conversation instead of the
// message. Only clear cases are named; anything unclear gets the plain rule.

const SCRIPTS = [
  [/[\u3040-\u30ff]/, "Japanese"],
  [/[\uac00-\ud7af]/, "Korean"],
  [/[\u4e00-\u9fff]/, "Chinese"],
  [/[\u0e00-\u0e7f]/, "Thai"],
  [/[\u0600-\u06ff]/, "Arabic"],
  [/[\u0400-\u04ff]/, "Russian"],
  [/[\u0590-\u05ff]/, "Hebrew"],
  [/[\u0900-\u097f]/, "Hindi"],
];
// Letters only Vietnamese uses among the common Latin-script languages.
const VIETNAMESE = /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i;
const ENGLISH_WORDS = new Set("the a an and or but is are was were be been my me i you your it its this that what when where who why how can could would should will do does did to of in on at for with from about please thanks thank hi hello yes no not just any some there here have has had our we they them u ur pls plz thx teh wat wats w tmrw tmr".split(" "));

function messageLanguage(text) {
  const t = String(text || "");
  for (const [re, name] of SCRIPTS) if (re.test(t)) return name;
  if (VIETNAMESE.test(t)) return "Vietnamese";
  const words = t.toLowerCase().match(/[a-z']+/g) || [];
  if (words.length >= 3 && !/[^\x00-\x7f]/.test(t.replace(/[\u2018\u2019\u201c\u201d\u2013\u2014\u2026\u00b0\u00a3\u20ac]/g, ""))) {
    const english = words.filter((w) => ENGLISH_WORDS.has(w)).length;
    if (english / words.length >= 0.2) return "English";
  }
  return null;
}

// The line a reply is given: the language by name when it is clear.
function languageRule(text) {
  const lang = messageLanguage(text);
  return lang
    ? `LANGUAGE: their latest message is in ${lang}. Reply in ${lang}, whatever language earlier messages used.`
    : "LANGUAGE: reply in the language of their latest message, whatever language earlier messages used.";
}

module.exports = { messageLanguage, languageRule };
