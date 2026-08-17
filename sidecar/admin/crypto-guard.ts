import { HttpError } from "../../worker/http";

import { PUBLIC_ENCRYPTION_DEFAULT } from "./types";

export function requireStoreEncryptionKey(): string {
  const key = process.env.ENCRYPTION_KEY?.trim() || "";
  if (!key || key === PUBLIC_ENCRYPTION_DEFAULT || key.length < 16) {
    throw new HttpError(
      "ENCRYPTION_KEY must be overridden with a unique secret (16+ characters) before storing Cursor API keys. The built-in default is a public constant and cannot be used.",
      503,
      "encryption_key_required"
    );
  }
  return key;
}

export function encryptionKeyIsConfigured(): boolean {
  try {
    requireStoreEncryptionKey();
    return true;
  } catch {
    return false;
  }
}
