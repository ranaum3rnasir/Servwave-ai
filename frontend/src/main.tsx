import './instrument'; // MUST be first — initializes Sentry before the app renders
// Second, and before the phone service loads: keeps the phone vendor's script from printing
// its name to the browser console. After Sentry, so dropped lines skip its breadcrumbs too.
import '@/lib/communication/vendorConsoleFilter';

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
// Side effect only: arms the logout sweep for in-flight upload records.
//
// It has to be HERE rather than in the transport that writes them. Those records live in
// localStorage, so one survives the page load that wrote it, while the module that would
// clear it sits in a lazy route chunk loaded only by the job / lead / invoice detail pages.
// Sign in, work on the dashboard, sign out, and a signed write credential stays in browser
// storage for the next person on the device. This module is tiny and pulls no transport with
// it, which is the only reason it is safe in the entry bundle.
import '@/lib/attachments/resumeRecordStore';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
