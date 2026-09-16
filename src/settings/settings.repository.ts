export interface ClientSettingsView {
  minFitScore: number;
  gapMode: 'GUESS_AND_PROCEED' | 'ASK_FIRST';
  byokEnabled: boolean;
  whatsappEnabled: boolean;
}

/**
 * Phase 2 uses only `minFitScore`. The rest of the shape is here because
 * ClientSettings is one row and returning half of it would mean changing this
 * interface again in Phase 4 — the fields exist, they are just not editable yet.
 */
export interface ISettingsRepository {
  get(): Promise<ClientSettingsView>;
  update(changes: Partial<ClientSettingsView>): Promise<ClientSettingsView>;
}

export const SETTINGS_REPOSITORY = Symbol('SETTINGS_REPOSITORY');
