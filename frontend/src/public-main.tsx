import './instrument-public'; // MUST be first: initializes error reporting before anything renders.

import React from 'react';
import ReactDOM from 'react-dom/client';
import PublicApp from './PublicApp';
import './index.css';

// The entry for public.html (mobile slice 47). Unlike main.tsx it registers no service worker,
// arms no upload-record sweep and loads no phone-service script: none of that belongs on a
// customer's phone. See PublicApp.tsx for what else is kept out.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PublicApp />
  </React.StrictMode>,
);
