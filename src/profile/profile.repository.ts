import type { CipherEnvelope } from '../core/crypto/cipher.interface';

export type Visibility = 'GENERAL' | 'SENSITIVE';

/**
 * A profile field as anything outside the disclosure path may see it.
 *
 * Note what is absent: when visibility is SENSITIVE there is no `value` and no
 * ciphertext — only `hasValue`, so the UI can say "set" without the value
 * travelling anywhere. This shape is the reason the serialisation-leak test
 * passes rather than a filter someone has to remember to apply.
 */
export interface ProfileFieldView {
  id: string;
  key: string;
  label: string;
  visibility: Visibility;
  /** Present only for GENERAL fields. */
  value: string | null;
  /** True when a SENSITIVE field has something stored. */
  hasValue: boolean;
  updatedAt: Date;
}

export interface IProfileRepository {
  listFields(): Promise<ProfileFieldView[]>;
  findField(id: string): Promise<ProfileFieldView | null>;
  findFieldByKey(key: string): Promise<ProfileFieldView | null>;

  createGeneralField(input: {
    key: string;
    label: string;
    value: string | null;
  }): Promise<ProfileFieldView>;

  createSensitiveField(input: {
    key: string;
    label: string;
    envelope: CipherEnvelope;
  }): Promise<ProfileFieldView>;

  updateGeneralValue(id: string, value: string | null): Promise<ProfileFieldView>;
  updateLabel(id: string, label: string): Promise<ProfileFieldView>;
  updateSensitiveValue(id: string, envelope: CipherEnvelope): Promise<ProfileFieldView>;

  /**
   * GENERAL → SENSITIVE, atomically: write the ciphertext and null the
   * plaintext column in one transaction.
   *
   * Doing these as two statements would leave a window where the value exists
   * in both places, and a crash in that window leaves plaintext in a column the
   * Client believes is protected.
   */
  promoteToSensitive(id: string, envelope: CipherEnvelope): Promise<ProfileFieldView>;

  /** SENSITIVE → GENERAL, atomically: write plaintext and delete the ciphertext. */
  demoteToGeneral(id: string, plaintext: string): Promise<ProfileFieldView>;

  deleteField(id: string): Promise<void>;

  getNarrative(): Promise<{ body: string; updatedAt: Date } | null>;
  upsertNarrative(body: string): Promise<{ body: string; updatedAt: Date }>;
}

export const PROFILE_REPOSITORY = Symbol('PROFILE_REPOSITORY');
