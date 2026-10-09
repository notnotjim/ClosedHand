// The bot's modules in lib/ reach token encryption as ./crypto-tokens, the
// same name the webapp's copies use, so vendored files (config.js,
// model-policy.js) stay byte-identical. The module itself lives at the repo
// root.
module.exports = require("../crypto-tokens");
