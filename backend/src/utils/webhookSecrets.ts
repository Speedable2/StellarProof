import crypto from "crypto";
import { AppError } from "../errors/AppError";

const ENCRYPTION_DOMAIN = "stellarproof:webhook-secret:v1\0";

function encryptionKey(): Buffer {
  const value = process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;
  if (!value || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new AppError(
      "WEBHOOK_SECRET_ENCRYPTION_KEY must be configured as a 64-character hex key",
      500,
      "WEBHOOK_SECRET_CONFIG_INVALID"
    );
  }
  return crypto.createHash("sha256").update(ENCRYPTION_DOMAIN).update(Buffer.from(value, "hex")).digest();
}

function associatedData(ownerId: string, registrationId: string): Buffer {
  return Buffer.from(`${ownerId}:${registrationId}`, "utf8");
}

export function encryptWebhookSecret(secret: string, ownerId: string, registrationId: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(associatedData(ownerId, registrationId));
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return `v1:${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${ciphertext.toString("base64")}`;
}

export function decryptWebhookSecret(value: string, ownerId: string, registrationId: string): string {
  const [version, ivHex, tagHex, ciphertextBase64, ...extra] = value.split(":");
  const iv = Buffer.from(ivHex ?? "", "hex");
  const tag = Buffer.from(tagHex ?? "", "hex");
  const ciphertext = Buffer.from(ciphertextBase64 ?? "", "base64");
  if (version !== "v1" || extra.length > 0 || iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
    throw new AppError("Stored webhook secret has an unsupported format", 500, "WEBHOOK_SECRET_INVALID");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAAD(associatedData(ownerId, registrationId));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
