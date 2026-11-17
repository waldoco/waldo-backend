import { createRoot } from 'react-dom/client';
import { App } from './App';
import { startTheme } from './theme';

const root = document.getElementById('root');
if (!root) throw new Error('Dashboard mount is missing');
startTheme();
createRoot(root).render(<App />);
