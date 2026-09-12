// Models sometimes emit Markdown despite platform-specific instructions.
// Convert only ordinary prose; preserve code, URLs and already-native markup.
function formatWhatsApp(text) {
  return String(text).split(/(```[^]*?```|`[^`\n]*`)/g).map((part, i) => {
    if (i % 2) return part;
    return part
      .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
      .replace(/^ {0,3}#{1,6}\s+([^\n]+)$/gm, (_, heading) => {
        const label = heading.trim();
        return label.startsWith("*") && label.endsWith("*") ? label : `*${label}*`;
      })
      .replace(/(?<!!)\[([^\]\n]+)\]\((https?:\/\/[^\s()]+)\)/g,
        (_, label, url) => label === url ? url : `${label}: ${url}`);
  }).join("");
}

module.exports = { formatWhatsApp };
