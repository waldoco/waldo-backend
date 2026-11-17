import { Icon } from './icons';
import { setThemeChoice, useTheme, type ThemeChoice } from './theme';

const choices: { key: ThemeChoice; label: string }[] = [{ key: 'system', label: 'System' }, { key: 'light', label: 'Light' }, { key: 'dark', label: 'Dark' }];

export function AppearancePanel() {
  const { choice } = useTheme();
  return <section className="panel appearance" aria-labelledby="appearance-title">
    <h2 id="appearance-title">Appearance</h2>
    <p>System follows your device. Light and Dark stay as you set them, in this browser only.</p>
    <fieldset className="theme-choice"><legend className="visually-hidden">Appearance</legend>
      {choices.map(item => <label key={item.key}>
        <input type="radio" name="theme" value={item.key} checked={choice === item.key} onChange={() => setThemeChoice(item.key)}/>
        {item.key !== 'system' && <Icon name={item.key === 'light' ? 'sun' : 'moon'}/>}{item.label}
      </label>)}
    </fieldset>
  </section>;
}

// The quick switch in the top bar flips what is showing now; System stays one tap away in Settings.
export function ThemeToggle() {
  const { theme } = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  return <button type="button" className="theme-toggle" aria-label={`Switch to ${next} appearance`} title={`Switch to ${next} appearance`} onClick={() => setThemeChoice(next)}>
    <Icon name={theme === 'dark' ? 'sun' : 'moon'}/>
  </button>;
}
