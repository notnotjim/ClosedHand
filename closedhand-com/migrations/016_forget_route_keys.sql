-- Route keys are kept only until the computer proves it is connected (lib/addresses.js).
UPDATE addresses SET tunnel_token = NULL WHERE state = 'active' AND tunnel_token IS NOT NULL;
