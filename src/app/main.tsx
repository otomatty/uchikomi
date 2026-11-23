import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppProvider } from './shared';
import App from './App';
import './styles.css';
import './daily-training.css';
import './capture.css';
import './insights.css';

createRoot(document.getElementById('root')!).render(<StrictMode><AppProvider><App/></AppProvider></StrictMode>);
