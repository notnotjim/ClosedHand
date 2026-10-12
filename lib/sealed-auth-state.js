// The linked WhatsApp session, kept sealed. Baileys keeps the keys of a
// WhatsApp linked as a device as JSON files in one folder; this keeps the same
// files, each sealed with AES-256-GCM under the encryption key
// (crypto-tokens.js), so a copy of the folder reads as nothing without it.
// Every read goes through decryptString and leaves the same audit line as any
// stored secret, as "linked WhatsApp session".
//
// The layout, file names and locking follow Baileys' useMultiFileAuthState,
// so a session saved before this keeps working: its plain files are sealed
// in place when the session starts, and any one read plain is sealed then.

const fs = require("fs");
const path = require("path");
const { encryptString, decryptString } = require("../crypto-tokens");

const WHAT = "linked WhatsApp session";
const fixFileName = (file) => file?.replace(/\//g, "__")?.replace(/:/g, "-");

// One file is read or written by one task at a time, as in Baileys.
const locks = new Map();
function locked(filePath, task) {
  const before = locks.get(filePath) || Promise.resolve();
  const run = before.then(task, task);
  const done = run.then(() => {}, () => {});
  locks.set(filePath, done);
  done.then(() => { if (locks.get(filePath) === done) locks.delete(filePath); });
  return run;
}

// Written whole to a temporary file first, so a crash mid-write never leaves
// half a key behind.
async function writeSealed(filePath, text) {
  const sealed = encryptString(text);
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, sealed, { mode: 0o600 });
  await fs.promises.rename(tmp, filePath);
}

// Plain files from before are sealed in place. Returns how many were.
async function sealFolder(folder) {
  let sealed = 0;
  for (const name of await fs.promises.readdir(folder).catch(() => [])) {
    if (!name.endsWith(".json")) continue;
    const filePath = path.join(folder, name);
    await locked(filePath, async () => {
      const text = await fs.promises.readFile(filePath, "utf8").catch(() => null);
      if (text == null || text.startsWith("enc:v1:")) return;
      try { JSON.parse(text); } catch (_) { return; } // not Baileys' JSON: left as found
      await writeSealed(filePath, text);
      sealed++;
    });
  }
  return sealed;
}

// Same contract as Baileys' useMultiFileAuthState(folder). `baileys` is the
// library itself, for BufferJSON, initAuthCreds and proto.
async function useSealedAuthState(folder, baileys) {
  const { BufferJSON, initAuthCreds, proto } = baileys;
  await fs.promises.mkdir(folder, { recursive: true, mode: 0o700 });
  const n = await sealFolder(folder);
  if (n) console.log(`[WA-Linked] Sealed ${n} session file(s) that were kept in plain text.`);

  const readData = async (file) => {
    const filePath = path.join(folder, fixFileName(file));
    try {
      return await locked(filePath, async () => {
        const text = await fs.promises.readFile(filePath, "utf8");
        const plain = decryptString(text, WHAT); // a plain file from before passes through, audited all the same
        if (plain == null) return null;
        if (!text.startsWith("enc:v1:")) await writeSealed(filePath, plain);
        return JSON.parse(plain, BufferJSON.reviver);
      });
    } catch (_) {
      return null;
    }
  };
  const writeData = (data, file) => {
    const filePath = path.join(folder, fixFileName(file));
    return locked(filePath, () => writeSealed(filePath, JSON.stringify(data, BufferJSON.replacer)));
  };
  const removeData = (file) => {
    const filePath = path.join(folder, fixFileName(file));
    return locked(filePath, () => fs.promises.unlink(filePath).catch(() => {}));
  };

  const creds = (await readData("creds.json")) || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(ids.map(async (id) => {
            let value = await readData(`${type}-${id}.json`);
            if (type === "app-state-sync-key" && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
            data[id] = value;
          }));
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const file = `${category}-${id}.json`;
              tasks.push(value ? writeData(value, file) : removeData(file));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData(creds, "creds.json"),
  };
}

module.exports = { useSealedAuthState, sealFolder };
