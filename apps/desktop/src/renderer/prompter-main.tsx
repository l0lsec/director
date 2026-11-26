import { createRoot } from 'react-dom/client';
import './shell/theme.css';
import { PrompterApp } from './features/record/prompter/PrompterApp';

const root = createRoot(document.getElementById('root')!);
root.render(<PrompterApp />);
