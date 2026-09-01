import mongoose, { Schema, model, models, deleteModel, type Types } from 'mongoose';

import { ROLES, KEY_MODES, type Role, type KeyMode } from './roles';

export { ROLES, KEY_MODES, RANK, ROLE_LABEL, homeFor } from './roles';
export type { Role, KeyMode } from './roles';

/* ------------------------------------------------------------------ */
/* Tenant                                                              */
/* ------------------------------------------------------------------ */
export interface ITenant {
  _id: Types.ObjectId;
  name: string;
  slug: string;
  status: 'active' | 'suspended' | 'trial';
  keyMode: KeyMode;

  /** Sealed API keys, one per provider. Only ever opened server-side. */
  apiKeys?: Partial<
    Record<'gemini' | 'openai', { ciphertext: string; iv: string; authTag: string; hint: string; verifiedAt?: Date }>
  >;

  /** Platform-key billing. Ignored entirely when keyMode is 'byok'. */
  credits: number;
  creditsUsed: number;

  branding: {
    logoUrl?: string;
    accent: string;
    idleTitle?: string;
    idleSubtitle?: string;
  };

  settings: {
    /** Which AI provider generates this tenant's photos. */
    provider: 'gemini' | 'openai';
    model: string;
    imageSize: string;
    autoCaptureSeconds: number;
    countdownSeconds: number;
    resultDisplaySeconds: number;
    /** DPDP retention. 0 disables auto-delete. */
    retentionDays: number;
    /** Second AI pass that corrects the face. Costs an extra credit per photo. */
    identityLock: boolean;
    /** Blend the visitor's actual face into the photo, in the booth. Free. */
    realFace: boolean;
    consentText: string;
  };

  createdAt: Date;
  updatedAt: Date;
}

const TenantSchema = new Schema<ITenant>(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    status: { type: String, enum: ['active', 'suspended', 'trial'], default: 'trial' },
    keyMode: { type: String, enum: KEY_MODES, default: 'platform' },

    apiKeys: {
      type: Schema.Types.Mixed,
      default: {},
    },

    credits: { type: Number, default: 0, min: 0 },
    creditsUsed: { type: Number, default: 0, min: 0 },

    branding: {
      logoUrl: String,
      accent: { type: String, default: '#e0a63c' },
      idleTitle: String,
      idleSubtitle: String,
    },

    settings: {
      provider: { type: String, enum: ['gemini', 'openai'], default: 'gemini' },
      model: { type: String, default: 'gemini-3.1-flash-lite-image' },
      imageSize: { type: String, default: '1K' },
      autoCaptureSeconds: { type: Number, default: 2 },
      countdownSeconds: { type: Number, default: 3 },
      resultDisplaySeconds: { type: Number, default: 25 },
      retentionDays: { type: Number, default: 30, min: 0, max: 365 },
      identityLock: { type: Boolean, default: false },
      realFace: { type: Boolean, default: true },
      consentText: {
        type: String,
        default:
          'Aapki photo li jayegi aur AI se ek nayi tasveer banayi jayegi. Photo 30 din baad apne aap delete ho jayegi.',
      },
    },
  },
  { timestamps: true },
);

/* ------------------------------------------------------------------ */
/* User                                                                */
/* ------------------------------------------------------------------ */
export interface IUser {
  _id: Types.ObjectId;
  /** null for superadmins - they belong to the platform, not a tenant. */
  tenantId: Types.ObjectId | null;
  email: string;
  name: string;
  passwordHash: string;
  role: Role;
  active: boolean;
  lastLoginAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const UserSchema = new Schema<IUser>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', default: null, index: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ROLES, required: true },
    active: { type: Boolean, default: true },
    lastLoginAt: Date,
  },
  { timestamps: true },
);
// Email is unique per tenant, so the same person can exist in two tenants.
UserSchema.index({ tenantId: 1, email: 1 }, { unique: true });

/* ------------------------------------------------------------------ */
/* Device - a paired booth. Authenticates with a token, not a password. */
/* ------------------------------------------------------------------ */
export interface IDevice {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  name: string;
  tokenHash?: string;
  pairingCode?: string;
  pairingExpiresAt?: Date;
  pairedAt?: Date;
  lastSeenAt?: Date;
  revoked: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const DeviceSchema = new Schema<IDevice>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    name: { type: String, required: true, trim: true },
    tokenHash: { type: String, index: true },
    pairingCode: { type: String, index: true },
    pairingExpiresAt: Date,
    pairedAt: Date,
    lastSeenAt: Date,
    revoked: { type: Boolean, default: false },
  },
  { timestamps: true },
);

/* ------------------------------------------------------------------ */
/* Scene - tenantId null means it is in the global Elloindia library.   */
/* ------------------------------------------------------------------ */
export interface IScene {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId | null;
  name: string;
  subtitle?: string;
  referenceKey: string;
  aspectRatio: string;
  scene: string;
  pose: string;
  mood: string;
  active: boolean;
  order: number;
  createdAt: Date;
  updatedAt: Date;
}

const SceneSchema = new Schema<IScene>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', default: null, index: true },
    name: { type: String, required: true, trim: true },
    subtitle: String,
    referenceKey: { type: String, required: true },
    aspectRatio: { type: String, default: '3:4' },
    scene: { type: String, required: true },
    pose: { type: String, required: true },
    mood: { type: String, default: '' },
    active: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
  },
  { timestamps: true },
);

/* ------------------------------------------------------------------ */
/* Generation - one row per attempt, success or failure.                */
/* ------------------------------------------------------------------ */
export interface IGeneration {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  deviceId?: Types.ObjectId;
  sceneId: Types.ObjectId;
  model: string;
  keyMode: KeyMode;
  status: 'ok' | 'refused' | 'error';
  ms: number;
  costUsd: number;
  imageKey?: string;
  /** Pass 1 output, kept only when identity lock ran, so the two can be compared. */
  imageKeyRaw?: string;
  identityLock?: boolean;
  /** Set when identity lock was attempted but did not succeed. */
  refineError?: string;
  /** True once the booth blended the visitor's real face into the photo. */
  realFace?: boolean;
  realFaceMs?: number;
  /** Unguessable id used in the QR link, so photos cannot be enumerated. */
  shareToken?: string;
  error?: string;
  /** Set from tenant.settings.retentionDays; a TTL index deletes the row. */
  expiresAt?: Date;
  createdAt: Date;
}

const GenerationSchema = new Schema<IGeneration>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    deviceId: { type: Schema.Types.ObjectId, ref: 'Device' },
    sceneId: { type: Schema.Types.ObjectId, ref: 'Scene', required: true },
    model: { type: String, required: true },
    keyMode: { type: String, enum: KEY_MODES, required: true },
    status: { type: String, enum: ['ok', 'refused', 'error'], required: true },
    ms: { type: Number, default: 0 },
    costUsd: { type: Number, default: 0 },
    imageKey: String,
    imageKeyRaw: String,
    identityLock: Boolean,
    refineError: String,
    realFace: Boolean,
    realFaceMs: Number,
    shareToken: { type: String, index: true, sparse: true },
    error: String,
    expiresAt: Date,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
GenerationSchema.index({ tenantId: 1, createdAt: -1 });
// Deliberately NOT a TTL index. A TTL would drop the row while leaving the
// stored image file behind forever, which would quietly break the retention
// promise made to visitors. `npm run cleanup` deletes the file first, then the
// row - schedule it daily.
GenerationSchema.index({ expiresAt: 1 });

/* ------------------------------------------------------------------ */
/* Audit log                                                            */
/* ------------------------------------------------------------------ */
export interface IAuditLog {
  _id: Types.ObjectId;
  actorId?: Types.ObjectId;
  actorEmail: string;
  action: string;
  tenantId?: Types.ObjectId | null;
  meta?: Record<string, unknown>;
  ip?: string;
  createdAt: Date;
}

const AuditLogSchema = new Schema<IAuditLog>(
  {
    actorId: { type: Schema.Types.ObjectId, ref: 'User' },
    actorEmail: { type: String, required: true },
    action: { type: String, required: true, index: true },
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', index: true },
    meta: Schema.Types.Mixed,
    ip: String,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

/**
 * Registering a model twice throws, so the usual trick is `models.X ?? model(X)`.
 * That silently keeps the OLD schema across a hot reload, though: add a field,
 * save the file, and the running dev server never sees it - which looks exactly
 * like the feature not working. In development, drop the cached model first so
 * schema edits actually take effect. Production registers once and is untouched.
 */
function register<T>(name: string, schema: Schema<T>): mongoose.Model<T> {
  if (models[name]) {
    if (process.env.NODE_ENV === 'production') return models[name] as mongoose.Model<T>;
    deleteModel(name);
  }
  return model<T>(name, schema);
}

export const Tenant = register<ITenant>('Tenant', TenantSchema);
export const User = register<IUser>('User', UserSchema);
export const Device = register<IDevice>('Device', DeviceSchema);
export const Scene = register<IScene>('Scene', SceneSchema);
export const Generation = register<IGeneration>('Generation', GenerationSchema);
export const AuditLog = register<IAuditLog>('AuditLog', AuditLogSchema);
