import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import '@fontsource-variable/inter';
import '@fontsource-variable/vazirmatn';
import './styles/global.css';
import './styles/layers.css';
import './styles/text.css';
import './styles/views.css';

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
