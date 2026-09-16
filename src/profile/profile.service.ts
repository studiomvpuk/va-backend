import {
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
  ConflictException,
} from '@nestjs/common';
import {
  PROFILE_REPOSITORY,
  type IProfileRepository,
  type ProfileFieldView,
  type Visibility,
} from './profile.repository';
import {
  SENSITIVE_VALUE_READER,
  SENSITIVE_VALUE_WRITER,
  type ISensitiveValueReader,
  type ISensitiveValueWriter,
} from '../disclosure/sensitive-value.repository';
import {
  CREDENTIAL_CIPHER,
  type ICredentialCipher,
} from '../core/crypto/cipher.interface';
import {
  detectGovernmentId,
  governmentIdRejectionMessage,
} from './validation/government-id';

export interface ProfileView {
  narrative: string;
  fields: ProfileFieldView[];
}

@Injectable()
export class ProfileService {
  constructor(
    @Inject(PROFILE_REPOSITORY) private readonly fields: IProfileRepository,
    @Inject(SENSITIVE_VALUE_WRITER) private readonly sensitiveWriter: ISensitiveValueWriter,
    @Inject(SENSITIVE_VALUE_READER) private readonly sensitiveReader: ISensitiveValueReader,
    @Inject(CREDENTIAL_CIPHER) private readonly cipher: ICredentialCipher,
  ) {}

  async getProfile(): Promise<ProfileView> {
    const [narrative, fields] = await Promise.all([
      this.fields.getNarrative(),
      this.fields.listFields(),
    ]);
    // ProfileFieldView carries no sensitive value by construction, so there is
    // no filtering step here to forget.
    return { narrative: narrative?.body ?? '', fields };
  }

  async setNarrative(body: string): Promise<{ body: string; updatedAt: Date }> {
    this.rejectGovernmentIds(body, 'experience narrative');
    return this.fields.upsertNarrative(body);
  }

  async createField(input: {
    key: string;
    label: string;
    value: string;
    visibility: Visibility;
  }): Promise<ProfileFieldView> {
    this.rejectGovernmentIds(input.value, input.label);

    if (await this.fields.findFieldByKey(input.key)) {
      throw new ConflictException(`A field with the key "${input.key}" already exists`);
    }

    if (input.visibility === 'SENSITIVE') {
      return this.fields.createSensitiveField({
        key: input.key,
        label: input.label,
        envelope: await this.cipher.encrypt(input.value),
      });
    }
    return this.fields.createGeneralField({
      key: input.key,
      label: input.label,
      value: input.value,
    });
  }

  /**
   * Updates a field's label, value and/or visibility.
   *
   * The visibility flip is the interesting case. Promoting encrypts the new (or
   * existing) value and nulls the plaintext column in one transaction; demoting
   * does the reverse. Demoting without supplying a new value requires reading
   * the old one back, which is a genuine disclosure — so it goes through the
   * audited reader like any other.
   */
  async updateField(
    id: string,
    changes: { label?: string; value?: string; visibility?: Visibility },
    actor: { actorType: 'CLIENT' | 'VA'; actorId: string },
  ): Promise<ProfileFieldView> {
    const field = await this.fields.findField(id);
    if (!field) throw new NotFoundException('Field not found');

    if (changes.value !== undefined) {
      this.rejectGovernmentIds(changes.value, changes.label ?? field.label);
    }

    let current = field;
    if (changes.label !== undefined && changes.label !== field.label) {
      current = await this.fields.updateLabel(id, changes.label);
    }

    const target = changes.visibility ?? current.visibility;
    const changingVisibility = target !== current.visibility;

    // ── Same visibility: just set the value ────────────────────────────────
    if (!changingVisibility) {
      if (changes.value === undefined) return current;
      return target === 'SENSITIVE'
        ? this.fields.updateSensitiveValue(id, await this.cipher.encrypt(changes.value))
        : this.fields.updateGeneralValue(id, changes.value);
    }

    // ── GENERAL → SENSITIVE ────────────────────────────────────────────────
    if (target === 'SENSITIVE') {
      const plaintext = changes.value ?? current.value;
      if (plaintext === null || plaintext === undefined) {
        // Nothing to protect yet — flag it and wait for a value.
        return this.fields.promoteToSensitive(id, await this.cipher.encrypt(''));
      }
      return this.fields.promoteToSensitive(id, await this.cipher.encrypt(plaintext));
    }

    // ── SENSITIVE → GENERAL ────────────────────────────────────────────────
    let plaintext = changes.value;
    if (plaintext === undefined) {
      // Moving a value out of protected storage is a disclosure even when the
      // Client is disclosing it to themselves, so it is read through the
      // audited path and appears in their own access log.
      plaintext =
        (await this.sensitiveReader.reveal({
          profileFieldId: id,
          reason: 'Client changed this field from sensitive to general',
          disclosedTo: actor,
        })) ?? '';
    }
    return this.fields.demoteToGeneral(id, plaintext);
  }

  /**
   * Shows a Client one of their own sensitive values.
   *
   * Not in the PRD, and worth saying why it exists: a Client who flags their
   * home address as sensitive still moves house. Without this they could only
   * overwrite blind. It is CLIENT-only, one field at a time, and audited — the
   * same shape as the credential vault, for the same reasons.
   */
  async revealField(
    id: string,
    actor: { actorType: 'CLIENT' | 'VA'; actorId: string },
  ): Promise<string> {
    const field = await this.fields.findField(id);
    if (!field) throw new NotFoundException('Field not found');
    if (field.visibility !== 'SENSITIVE') return field.value ?? '';

    const value = await this.sensitiveReader.reveal({
      profileFieldId: id,
      reason: 'Client viewed their own sensitive field',
      disclosedTo: actor,
    });
    return value ?? '';
  }

  async deleteField(id: string): Promise<void> {
    const field = await this.fields.findField(id);
    if (!field) throw new NotFoundException('Field not found');
    await this.sensitiveWriter.remove(id);
    await this.fields.deleteField(id);
  }

  private rejectGovernmentIds(value: string, context: string): void {
    const match = detectGovernmentId(value, context);
    if (match) throw new UnprocessableEntityException(governmentIdRejectionMessage(match));
  }
}
