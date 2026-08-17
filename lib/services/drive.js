// lib/services/drive.js — Google Drive upload/download/cleanup helpers

const https = require("https");
const { getGoogleToken, isGoogleConnected, googleApiRequest } = require("./google");

const DRIVE_FOLDER_NAME = "ClosedHand Attachments";

// Multipart upload to Drive (needed because googleApiRequest doesn't handle multipart)
function googleDriveUpload(metadata, buffer, mimeType) {
  return new Promise(async (resolve, reject) => {
    const token = await getGoogleToken();
    if (!token) return reject(new Error("Google not connected"));

    const boundary = "----ClosedHand" + Date.now().toString(16);
    const metaJson = JSON.stringify(metadata);

    const parts = [];
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metaJson}\r\n`
    ));
    parts.push(Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`));
    parts.push(buffer);
    parts.push(Buffer.from(`\r\n--${boundary}--`));
    const body = Buffer.concat(parts);

    const req = https.request({
      hostname: "www.googleapis.com",
      path: "/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink",
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
        "Content-Length": body.length,
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        if (res.statusCode >= 400) reject(new Error(`Drive upload ${res.statusCode}: ${text.substring(0, 200)}`));
        else resolve(JSON.parse(text));
      });
    });
    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("Drive upload timeout")); });
    req.write(body);
    req.end();
  });
}

async function getOrCreateDriveFolder() {
  // Search for existing folder
  const q = encodeURIComponent(`name='${DRIVE_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const search = await googleApiRequest("GET",
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`
  );
  if (search.files && search.files.length > 0) {
    return search.files[0].id;
  }
  // Create it
  const folder = await googleApiRequest("POST",
    `https://www.googleapis.com/drive/v3/files`,
    { name: DRIVE_FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" }
  );
  console.log(`Created Drive folder: ${DRIVE_FOLDER_NAME} (${folder.id})`);
  return folder.id;
}

async function uploadToDrive(buffer, filename, mimeType) {
  const folderId = await getOrCreateDriveFolder();
  const metadata = { name: filename, parents: [folderId] };
  const file = await googleDriveUpload(metadata, buffer, mimeType);
  console.log(`Uploaded to Drive: ${filename} (${file.id})`);
  return file;
}

async function deleteFromDrive(fileId) {
  await googleApiRequest("DELETE", `https://www.googleapis.com/drive/v3/files/${fileId}`);
  console.log(`Deleted from Drive: ${fileId}`);
}

// Clean up orphaned files in ClosedHand Attachments folder
// (files no longer attached to any calendar event)
async function cleanupDriveAttachments() {
  if (!isGoogleConnected()) return;
  try {
    // Find the folder
    const q = encodeURIComponent(`name='${DRIVE_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
    const folderSearch = await googleApiRequest("GET",
      `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`
    );
    const folderId = folderSearch.files?.[0]?.id;
    if (!folderId) return; // No folder = nothing to clean

    // List all files in the folder
    const filesQ = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
    const filesResult = await googleApiRequest("GET",
      `https://www.googleapis.com/drive/v3/files?q=${filesQ}&fields=files(id,name,createdTime)&pageSize=100`
    );
    const driveFiles = filesResult.files || [];
    if (driveFiles.length === 0) return;

    // Get all calendar events from past month to 1 year ahead (covers most use cases)
    const now = new Date();
    const timeMin = new Date(now.getTime() - 180 * 86400000).toISOString();
    const timeMax = new Date(now.getTime() + 365 * 86400000).toISOString();
    const eventsResult = await googleApiRequest("GET",
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&maxResults=250&singleEvents=true`
    );

    // Collect all attachment file IDs from calendar events, tracking event end dates
    const attachedFiles = {}; // fileId → latest event end date
    for (const event of eventsResult.items || []) {
      const eventEnd = new Date(event.end?.dateTime || event.end?.date || 0);
      for (const att of event.attachments || []) {
        if (att.fileId) {
          // Keep the latest end date if file is on multiple events
          if (!attachedFiles[att.fileId] || eventEnd > attachedFiles[att.fileId]) {
            attachedFiles[att.fileId] = eventEnd;
          }
        }
      }
    }

    // Delete orphans + attachments for events older than 2 months
    const twoMonthsAgo = new Date(now.getTime() - 60 * 86400000);
    let deleted = 0;
    for (const file of driveFiles) {
      const isOrphaned = !attachedFiles[file.id];
      const isExpired = attachedFiles[file.id] && attachedFiles[file.id] < twoMonthsAgo;
      if (isOrphaned || isExpired) {
        try {
          await deleteFromDrive(file.id);
          deleted++;
        } catch (e) {
          console.error(`Failed to clean up Drive file ${file.id}:`, e.message);
        }
      }
    }

    if (deleted > 0) {
      console.log(`Drive cleanup: deleted ${deleted} orphaned file(s) from ${DRIVE_FOLDER_NAME}`);
    }
  } catch (e) {
    console.error("Drive cleanup error:", e.message);
  }
}

module.exports = {
  DRIVE_FOLDER_NAME, googleDriveUpload, getOrCreateDriveFolder,
  uploadToDrive, deleteFromDrive, cleanupDriveAttachments,
};
