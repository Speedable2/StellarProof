import mongoose, { Document, Schema } from 'mongoose';

export interface IKMSBackupEntry {
  keyId: mongoose.Types.ObjectId;
  keyVersion: string;
  algorithm: string;
  ciphertext: string;
  iv: string;
  authTag: string;
  isActive: boolean;
  expiresAt?: Date;
}

export interface IKMSBackup extends Document {
  ownerId: mongoose.Types.ObjectId;
  createdBy: mongoose.Types.ObjectId;
  keys: IKMSBackupEntry[];
  createdAt: Date;
  updatedAt: Date;
}

const KMSBackupEntrySchema = new Schema<IKMSBackupEntry>(
  {
    keyId: { type: Schema.Types.ObjectId, required: true },
    keyVersion: { type: String, required: true },
    algorithm: { type: String, required: true },
    ciphertext: { type: String, required: true },
    iv: { type: String, required: true },
    authTag: { type: String, required: true },
    isActive: { type: Boolean, required: true },
    expiresAt: { type: Date },
  },
  { _id: false }
);

const KMSBackupSchema = new Schema<IKMSBackup>(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    keys: { type: [KMSBackupEntrySchema], required: true },
  },
  { timestamps: true }
);

export default mongoose.models.KMSBackup as mongoose.Model<IKMSBackup> ||
  mongoose.model<IKMSBackup>('KMSBackup', KMSBackupSchema);
