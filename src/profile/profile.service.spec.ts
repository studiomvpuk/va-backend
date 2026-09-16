import {
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ProfileService } from './profile.service';
import { AesGcmCipher } from '../core/crypto/aes-gcm.cipher';
import type { CipherEnvelope } from '../core/crypto/cipher.interface';
import type { IProfileRepository, ProfileFieldView } from './profile.repository';
import type {
  ISensitiveValueReader,
  ISensitiveValueWriter,
} from '../disclosure/sensitive-value.repository';
import { cipherConfig } from '../core/crypto/test-config';

/**
 * In-memory stand-ins that preserve the property under test: a sensitive field
 * never carries its value in the view, and the only way to get the plaintext
 * back is through the reader, which records the call.
 */
class FakeProfileRepo implements IProfileRepository {
  fields: ProfileFieldView[] = [];
  secrets = new Map<string, CipherEnvelope>();
  narrative: { body: string; updatedAt: Date } | null = null;
  private seq = 0;

  private view(f: ProfileFieldView) {
    return { ...f };
  }
  async listFields() {
    return this.fields.map((f) => this.view(f));
  }
  async findField(id: string) {
    const f = this.fields.find((x) => x.id === id);
    return f ? this.view(f) : null;
  }
  async findFieldByKey(key: string) {
    const f = this.fields.find((x) => x.key === key);
    return f ? this.view(f) : null;
  }
  async createGeneralField(i: { key: string; label: string; value: string | null }) {
    const f: ProfileFieldView = {
      id: `f${++this.seq}`,
      key: i.key,
      label: i.label,
      visibility: 'GENERAL',
      value: i.value,
      hasValue: i.value !== null,
      updatedAt: new Date(),
    };
    this.fields.push(f);
    return this.view(f);
  }
  async createSensitiveField(i: { key: string; label: string; envelope: CipherEnvelope }) {
    const f: ProfileFieldView = {
      id: `f${++this.seq}`,
      key: i.key,
      label: i.label,
      visibility: 'SENSITIVE',
      value: null,
      hasValue: true,
      updatedAt: new Date(),
    };
    this.fields.push(f);
    this.secrets.set(f.id, i.envelope);
    return this.view(f);
  }
  private mutate(id: string, fn: (f: ProfileFieldView) => void) {
    const f = this.fields.find((x) => x.id === id);
    if (!f) throw new Error('not found');
    fn(f);
    return this.view(f);
  }
  async updateGeneralValue(id: string, value: string | null) {
    return this.mutate(id, (f) => {
      f.value = value;
      f.hasValue = value !== null;
    });
  }
  async updateLabel(id: string, label: string) {
    return this.mutate(id, (f) => {
      f.label = label;
    });
  }
  async updateSensitiveValue(id: string, envelope: CipherEnvelope) {
    this.secrets.set(id, envelope);
    return this.mutate(id, (f) => {
      f.value = null;
      f.hasValue = true;
    });
  }
  async promoteToSensitive(id: string, envelope: CipherEnvelope) {
    this.secrets.set(id, envelope);
    return this.mutate(id, (f) => {
      f.visibility = 'SENSITIVE';
      f.value = null; // atomic in the real repository
      f.hasValue = true;
    });
  }
  async demoteToGeneral(id: string, plaintext: string) {
    this.secrets.delete(id);
    return this.mutate(id, (f) => {
      f.visibility = 'GENERAL';
      f.value = plaintext;
      f.hasValue = true;
    });
  }
  async deleteField(id: string) {
    this.fields = this.fields.filter((f) => f.id !== id);
    this.secrets.delete(id);
  }
  async getNarrative() {
    return this.narrative;
  }
  async upsertNarrative(body: string) {
    this.narrative = { body, updatedAt: new Date() };
    return this.narrative;
  }
}

const cipher = new AesGcmCipher(cipherConfig({ key: Buffer.alloc(32, 9) }));

class FakeSensitiveStore implements ISensitiveValueReader, ISensitiveValueWriter {
  reveals: { profileFieldId: string; reason: string }[] = [];
  constructor(private readonly repo: FakeProfileRepo) {}

  async reveal(input: { profileFieldId: string; reason: string }) {
    this.reveals.push({ profileFieldId: input.profileFieldId, reason: input.reason });
    const envelope = this.repo.secrets.get(input.profileFieldId);
    return envelope ? cipher.decrypt(envelope) : null;
  }
  async put(id: string, envelope: CipherEnvelope) {
    this.repo.secrets.set(id, envelope);
  }
  async remove(id: string) {
    this.repo.secrets.delete(id);
  }
  async exists(id: string) {
    return this.repo.secrets.has(id);
  }
}

const ACTOR = { actorType: 'CLIENT' as const, actorId: 'client_1' };

describe('ProfileService', () => {
  let repo: FakeProfileRepo;
  let store: FakeSensitiveStore;
  let service: ProfileService;

  beforeEach(() => {
    repo = new FakeProfileRepo();
    store = new FakeSensitiveStore(repo);
    service = new ProfileService(repo, store, store, cipher);
  });

  const addSensitive = (value = '42 Rutherford Street, Manchester M1 4BT') =>
    service.createField({
      key: 'home_address',
      label: 'Home address',
      value,
      visibility: 'SENSITIVE',
    });

  /**
   * The Phase 2 acceptance criterion, asserted the way the PRD words it: walk
   * the serialised response for the seeded value rather than checking a field
   * we remembered to look at.
   */
  describe('GET /profile never includes a sensitive value', () => {
    it('omits it from the serialised payload entirely', async () => {
      const secret = 'Flat 3, 88 Alexandra Road, Manchester';
      await addSensitive(secret);
      await service.createField({
        key: 'current_role',
        label: 'Current role',
        value: 'Full-stack developer',
        visibility: 'GENERAL',
      });

      const payload = JSON.stringify(await service.getProfile());

      expect(payload).not.toContain(secret);
      expect(payload).not.toContain('Alexandra');
      // The general field is still there — this is not passing by returning
      // nothing at all.
      expect(payload).toContain('Full-stack developer');
    });

    it('still reports that a value is set', async () => {
      await addSensitive();
      const { fields } = await service.getProfile();
      const field = fields.find((f) => f.key === 'home_address')!;
      expect(field.hasValue).toBe(true);
      expect(field.value).toBeNull();
    });

    it('does not leak through the create response either', async () => {
      const secret = 'Flat 3, 88 Alexandra Road, Manchester';
      const created = await addSensitive(secret);
      expect(JSON.stringify(created)).not.toContain('Alexandra');
    });
  });

  describe('visibility flips', () => {
    it('GENERAL → SENSITIVE moves the value out of the plaintext column', async () => {
      const field = await service.createField({
        key: 'salary_history',
        label: 'Salary history',
        value: '48000 at MTN Group',
        visibility: 'GENERAL',
      });
      expect(field.value).toBe('48000 at MTN Group');

      const promoted = await service.updateField(
        field.id,
        { visibility: 'SENSITIVE' },
        ACTOR,
      );

      expect(promoted.visibility).toBe('SENSITIVE');
      expect(promoted.value).toBeNull();
      expect(promoted.hasValue).toBe(true);
      // And it is genuinely still retrievable — the flip preserved it.
      expect(await service.revealField(field.id, ACTOR)).toBe('48000 at MTN Group');
    });

    it('SENSITIVE → GENERAL reads the old value through the audited path', async () => {
      const field = await addSensitive('12 Oak Lane');
      const demoted = await service.updateField(
        field.id,
        { visibility: 'GENERAL' },
        ACTOR,
      );

      expect(demoted.value).toBe('12 Oak Lane');
      // Moving a value out of protected storage is a disclosure, and it was
      // recorded as one.
      expect(store.reveals).toHaveLength(1);
      expect(store.reveals[0].reason).toMatch(/sensitive to general/i);
    });

    it('demoting with a new value does not read the old one at all', async () => {
      const field = await addSensitive('12 Oak Lane');
      await service.updateField(
        field.id,
        { visibility: 'GENERAL', value: '99 New Road' },
        ACTOR,
      );
      expect(store.reveals).toHaveLength(0);
    });

    it('lets a field be flagged sensitive before it has a value', async () => {
      const field = await service.createField({
        key: 'passport_country',
        label: 'Country of issue',
        value: '',
        visibility: 'GENERAL',
      });
      const promoted = await service.updateField(
        field.id,
        { visibility: 'SENSITIVE' },
        ACTOR,
      );
      expect(promoted.visibility).toBe('SENSITIVE');
    });
  });

  describe('reveal', () => {
    it('records every read', async () => {
      const field = await addSensitive('12 Oak Lane');
      await service.revealField(field.id, ACTOR);
      await service.revealField(field.id, ACTOR);
      expect(store.reveals).toHaveLength(2);
    });

    it('does not go through the audited path for a general field', async () => {
      const field = await service.createField({
        key: 'current_role',
        label: 'Current role',
        value: 'Developer',
        visibility: 'GENERAL',
      });
      expect(await service.revealField(field.id, ACTOR)).toBe('Developer');
      expect(store.reveals).toHaveLength(0);
    });

    it('404s for a field that does not exist', async () => {
      await expect(service.revealField('nope', ACTOR)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('government ID rejection', () => {
    it('refuses a National Insurance number even marked sensitive', async () => {
      await expect(
        service.createField({
          key: 'ni',
          label: 'NI number',
          value: 'AB123456C',
          visibility: 'SENSITIVE',
        }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it('refuses one in the narrative too', async () => {
      await expect(
        service.setNarrative('Developer in Manchester. NI: AB123456C'),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it('uses the field label as context, so a labelled SSN is caught', async () => {
      await expect(
        service.createField({
          key: 'ssn',
          label: 'Social Security Number',
          value: '123456789',
          visibility: 'SENSITIVE',
        }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it('accepts an ordinary CV narrative', async () => {
      await expect(
        service.setNarrative(
          'Full-stack developer, 4+ years. Built 12 products at StudioMVP. ' +
            'Manchester. Reduced p95 latency from 1200ms to 180ms.',
        ),
      ).resolves.toBeTruthy();
    });

    it('checks the value on update, not only on create', async () => {
      const field = await service.createField({
        key: 'notes',
        label: 'Notes',
        value: 'fine',
        visibility: 'GENERAL',
      });
      await expect(
        service.updateField(field.id, { value: 'AB123456C' }, ACTOR),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });
  });

  describe('housekeeping', () => {
    it('rejects a duplicate key', async () => {
      await addSensitive();
      await expect(addSensitive()).rejects.toBeInstanceOf(ConflictException);
    });

    it('deleting a sensitive field removes the stored ciphertext', async () => {
      const field = await addSensitive();
      expect(repo.secrets.has(field.id)).toBe(true);
      await service.deleteField(field.id);
      expect(repo.secrets.has(field.id)).toBe(false);
    });
  });
});
