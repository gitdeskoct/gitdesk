import { nativeTheme } from 'electron';
import {
  mergeSettings,
  type Settings,
  type SettingsPatch,
} from '../../shared/settings';
import { readState, writeState, type AppDatabase } from '../db/database';

const KEY = 'settings';

export class SettingsService {
  private current: Settings;

  constructor(
    private readonly db: AppDatabase,
    private readonly onApplied: (patch: SettingsPatch) => void,
  ) {
    this.current = mergeSettings(readState(db, KEY));
    nativeTheme.themeSource = this.current.theme;
  }

  get(): Settings {
    return this.current;
  }

  update(patch: SettingsPatch): Settings {
    this.current = { ...this.current, ...patch };
    writeState(this.db, KEY, this.current);
    if (patch.theme) nativeTheme.themeSource = patch.theme;
    this.onApplied(patch);
    return this.current;
  }
}
