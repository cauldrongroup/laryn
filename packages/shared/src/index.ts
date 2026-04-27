export type CleanupTier = "off" | "cheap" | "standard" | "premium";

export type DictionaryEntryKind = "vocabulary" | "replacement";

export type DictionaryEntry = {
  id: string;
  kind: DictionaryEntryKind;
  phrase: string;
  replacement?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  useCount?: number;
};

export type DictionaryPayload = {
  version: 1;
  entries: DictionaryEntry[];
};

export type AccountBillingStatus = {
  proActive: boolean;
  subscriptionStatus: "active" | "trialing" | "past_due" | "canceled" | "revoked" | "inactive" | "unknown";
  currentPeriodEnd?: string;
  polarCustomerId?: string;
  usageCredits?: {
    includedUnits: number;
    includedCents: number;
    consumedUnits?: number;
    creditedUnits?: number;
    balanceUnits?: number;
    consumedCents?: number;
    remainingCents?: number;
    overageCents?: number;
  };
};

export type DesktopDevice = {
  id: string;
  deviceName: string;
  createdAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
};

export type AccountProfile = {
  id: string;
  name: string;
  email: string;
  image?: string | null;
};

export type AccountStatus = {
  authenticated: boolean;
  user?: AccountProfile;
  billing?: AccountBillingStatus;
  devices?: DesktopDevice[];
  usage?: {
    transcriptionCount: number;
    audioDurationMs: number;
  };
};

export type DeviceStartResponse = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
};

export type DeviceTokenResponse =
  | {
      status: "pending";
    }
  | {
      status: "approved";
      token: string;
      account: AccountProfile;
      billing: AccountBillingStatus;
    };

export type TranscriptionRequestMeta = {
  mimeType: string;
  durationMs?: number;
  cleanupTier?: CleanupTier;
  dictionary?: DictionaryPayload;
};

export type TranscriptionResponse = {
  text: string;
  id: string;
  rawText: string;
  cleanedText: string;
  pastedVariant: "cleaned" | "raw";
  cleanupApplied: boolean;
  cleanupTier: CleanupTier;
  cleanupWarning?: string;
  fallbackUsed?: boolean;
  dictionaryApplied?: boolean;
  dictionaryEntryCount?: number;
  dictionaryWarning?: string;
  wordCount: number;
  durationMs: number;
  transcriptionProvider?: string;
  transcriptionModel: string;
  cleanupModel?: string;
  usageEventId?: string;
  accountId?: string;
  deviceId?: string;
};

export type TranscriptionError = {
  error: string;
  detail?: string;
};

export type SubscriptionRequiredError = TranscriptionError & {
  error: "Subscription required";
  billing: AccountBillingStatus;
};

export type HistoryEntry = {
  id: string;
  createdAt: string;
  text: string;
  rawText?: string;
  cleanedText?: string;
  pastedVariant: "cleaned" | "raw";
  cleanupApplied: boolean;
  cleanupTier: CleanupTier;
  cleanupModel?: string;
  cleanupWarning?: string;
  fallbackUsed?: boolean;
  dictionaryApplied?: boolean;
  dictionaryEntryCount?: number;
  dictionaryWarning?: string;
  wordCount: number;
  durationMs: number;
  transcriptionModel?: string;
  transcriptionProvider?: string;
};
